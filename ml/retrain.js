import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {normalizeEmergencyText} from './safety-eval.js';
import {trainOfflineModel} from './train.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function askYesNo(rl, question) {
  return new Promise((resolve) => {
    rl.question(`${question} [y/N]: `, (ans) => {
      resolve(ans.trim().toLowerCase() === 'y' || ans.trim().toLowerCase() === 'yes');
    });
  });
}

function decryptVaultIfPresent() {
  const vaultFile = path.join(ROOT, 'server_data', 'learning_signals.enc');
  if (!fs.existsSync(vaultFile)) return [];
  const rawKey =
    process.env.RAKSHAK_LEARNING_ENCRYPTION_KEY ||
    'rakshak-dev-local-learning-key-change-in-prod';
  const key = crypto.createHash('sha256').update(rawKey).digest();
  try {
    const blob = JSON.parse(fs.readFileSync(vaultFile, 'utf8'));
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(blob.iv, 'hex')
    );
    decipher.setAuthTag(Buffer.from(blob.tag, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(blob.data, 'hex')),
      decipher.final(),
    ]).toString('utf8');
    const list = JSON.parse(decrypted);
    return Array.isArray(list) ? list : [];
  } catch (err) {
    console.warn('[retrain] Could not decrypt server vault:', err.message);
    return [];
  }
}

async function runRetrain() {
  const args = process.argv.slice(2);
  const fromArg = args.find((a) => a.startsWith('--from-file='));
  const autoApprove = args.includes('--auto-approved-only');
  const datasetPath = path.join(__dirname, 'dataset.json');
  const currentModelPath = path.join(ROOT, 'public', 'model.json');

  const existingDataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  const seenKeys = new Set(
    existingDataset.map(
      (r) => `${r.intent}::${normalizeEmergencyText(r.text)}`
    )
  );

  let candidates = [];
  if (fromArg) {
    const filePath = path.resolve(ROOT, fromArg.slice('--from-file='.length));
    if (!fs.existsSync(filePath)) {
      console.error(`Feedback file not found: ${filePath}`);
      process.exit(1);
    }
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    candidates = Array.isArray(raw) ? raw : [];
  } else {
    candidates = decryptVaultIfPresent().filter(
      (item) => item.status === 'approved' || !autoApprove
    );
  }

  const validLabels = new Set(existingDataset.map((r) => r.intent));
  const uniqueAdditions = [];
  const rl =
    !autoApprove && process.stdin.isTTY
      ? readline.createInterface({input: process.stdin, output: process.stdout})
      : null;

  for (const item of candidates) {
    const text = (item.sanitizedText || item.text || '').trim();
    const intent = (item.correctedIntent || item.intent || '').trim();
    if (!text || text.length < 4 || !validLabels.has(intent)) continue;
    const norm = normalizeEmergencyText(text);
    const key = `${intent}::${norm}`;
    if (seenKeys.has(key)) continue;

    if (item.status === 'rejected') continue;
    if (item.status === 'approved' || autoApprove) {
      if (item.status === 'approved') {
        seenKeys.add(key);
        uniqueAdditions.push({text, intent});
      }
      continue;
    }

    if (rl) {
      const ok = await askYesNo(
        rl,
        `Approve new training sample -> [${intent}] "${text}"?`
      );
      if (ok) {
        seenKeys.add(key);
        uniqueAdditions.push({text, intent});
      }
    }
  }
  if (rl) rl.close();

  if (uniqueAdditions.length === 0) {
    console.log(
      '[retrain] No new approved deduplicated samples to add. Running verification on current dataset...'
    );
    const check = trainOfflineModel({dryRun: true});
    console.log(
      `[retrain] Current model v${check.model.version} verified: ${(
        check.model.metrics.accuracy * 100
      ).toFixed(2)}% Acc | Safety=${check.safety.passed ? 'PASS' : 'FAIL'}`
    );
    return;
  }

  // Backup existing dataset + model before modifying
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(__dirname, 'backups', stamp);
  fs.mkdirSync(backupDir, {recursive: true});
  fs.copyFileSync(datasetPath, path.join(backupDir, 'dataset.json'));
  if (fs.existsSync(currentModelPath)) {
    fs.copyFileSync(currentModelPath, path.join(backupDir, 'model.json'));
  }

  const prevMetrics = fs.existsSync(currentModelPath)
    ? JSON.parse(fs.readFileSync(currentModelPath, 'utf8')).metrics
    : null;

  const updatedDataset = [...existingDataset, ...uniqueAdditions];
  fs.writeFileSync(datasetPath, JSON.stringify(updatedDataset, null, 2));

  try {
    const candidate = trainOfflineModel({bumpVersion: true, dryRun: true});
    const accDelta = prevMetrics
      ? candidate.model.metrics.accuracy - (prevMetrics.accuracy || 0)
      : 0;
    const f1Delta = prevMetrics
      ? candidate.model.metrics.macroF1 - (prevMetrics.macroF1 || 0)
      : 0;

    console.log('\n=== Candidate Model Comparison ===');
    console.log(
      `Accuracy : ${(candidate.model.metrics.accuracy * 100).toFixed(2)}% (${
        accDelta >= 0 ? '+' : ''
      }${(accDelta * 100).toFixed(2)}%)`
    );
    console.log(
      `Macro F1 : ${(candidate.model.metrics.macroF1 * 100).toFixed(2)}% (${
        f1Delta >= 0 ? '+' : ''
      }${(f1Delta * 100).toFixed(2)}%)`
    );
    console.log(`Safety   : ${candidate.safety.passed ? 'PASS' : 'FAIL'}`);

    if (!candidate.safety.passed || accDelta < -0.02 || f1Delta < -0.02) {
      console.error(
        '[retrain] Candidate rejected (failed safety gate or regressed >2%). Restoring backup.'
      );
      fs.copyFileSync(path.join(backupDir, 'dataset.json'), datasetPath);
      process.exit(1);
    }

    // Publish versioned signed model + manifest
    const published = trainOfflineModel({bumpVersion: true, dryRun: false});
    console.log(
      `[retrain] Published v${published.model.version} with ${uniqueAdditions.length} approved examples.`
    );
  } catch (err) {
    console.error('[retrain] Error during retraining, restoring backup:', err);
    fs.copyFileSync(path.join(backupDir, 'dataset.json'), datasetPath);
    process.exit(1);
  }
}

runRetrain();
