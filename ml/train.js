import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {
  extractFeatures,
  normalizeEmergencyText,
  predictFromModel,
  runSafetyEvaluation,
} from './safety-eval.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function bumpPatchVersion(versionStr) {
  const parts = String(versionStr || '1.0.0')
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  parts[2] += 1;
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

function computeMetrics(labels, yTrue, yPred) {
  const perClass = {};
  let totalCorrect = 0;

  for (const label of labels) {
    perClass[label] = {tp: 0, fp: 0, fn: 0, support: 0, precision: 0, recall: 0, f1: 0};
  }

  for (let i = 0; i < yTrue.length; i += 1) {
    const actual = yTrue[i];
    const pred = yPred[i];
    perClass[actual].support += 1;
    if (actual === pred) {
      totalCorrect += 1;
      perClass[actual].tp += 1;
    } else {
      perClass[pred].fp += 1;
      perClass[actual].fn += 1;
    }
  }

  let f1Sum = 0;
  for (const label of labels) {
    const c = perClass[label];
    c.precision = c.tp + c.fp > 0 ? c.tp / (c.tp + c.fp) : 0;
    c.recall = c.tp + c.fn > 0 ? c.tp / (c.tp + c.fn) : 0;
    c.f1 =
      c.precision + c.recall > 0
        ? (2 * c.precision * c.recall) / (c.precision + c.recall)
        : 0;
    f1Sum += c.f1;
  }

  return {
    totalSamples: yTrue.length,
    correct: totalCorrect,
    accuracy: yTrue.length > 0 ? totalCorrect / yTrue.length : 0,
    macroF1: labels.length > 0 ? f1Sum / labels.length : 0,
    perClass,
  };
}

export function trainOfflineModel(options = {}) {
  const datasetPath = path.join(__dirname, 'dataset.json');
  const synonymsPath = path.join(__dirname, 'synonyms.json');
  const testPhrasesPath = path.join(__dirname, 'test-phrases.json');

  const rawDataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  const synonymsData = JSON.parse(fs.readFileSync(synonymsPath, 'utf8'));
  const testPhrases = fs.existsSync(testPhrasesPath)
    ? JSON.parse(fs.readFileSync(testPhrasesPath, 'utf8'))
    : [];

  // Deduplicate exact normalized phrases before splitting so train & validation never leak
  const seenNormalized = new Set();
  const cleanDataset = [];
  let duplicatesSkipped = 0;
  for (const row of rawDataset) {
    if (!row || typeof row.text !== 'string' || typeof row.intent !== 'string') continue;
    const norm = normalizeEmergencyText(row.text);
    if (!norm || norm.length < 2) continue;
    const dedupKey = `${row.intent}::${norm}`;
    if (seenNormalized.has(dedupKey)) {
      duplicatesSkipped += 1;
      continue;
    }
    seenNormalized.add(dedupKey);
    cleanDataset.push({text: row.text.trim(), intent: row.intent.trim()});
  }

  // Deterministic stratified 80/20 split
  const byIntent = new Map();
  for (const item of cleanDataset) {
    if (!byIntent.has(item.intent)) byIntent.set(item.intent, []);
    byIntent.get(item.intent).push(item);
  }

  const labels = Array.from(byIntent.keys()).sort();
  const rand = seededRandom(20261123);
  const trainSet = [];
  const valSet = [];

  for (const label of labels) {
    const items = [...byIntent.get(label)];
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    const splitIdx = Math.max(1, Math.floor(items.length * 0.8));
    trainSet.push(...items.slice(0, splitIdx));
    valSet.push(...items.slice(splitIdx));
  }

  // Build vocabulary from training split ONLY (zero data leakage)
  const docFreq = new Map();
  const trainTokensList = trainSet.map((row) => {
    const feats = extractFeatures(row.text, synonymsData);
    const unique = new Set(feats);
    for (const tok of unique) {
      docFreq.set(tok, (docFreq.get(tok) || 0) + 1);
    }
    return {intent: row.intent, feats};
  });

  // Keep informative features (words & synonyms df>=1, bigrams/char n-grams df>=2)
  const vocab = [];
  for (const [tok, df] of docFreq.entries()) {
    if (tok.startsWith('w:') || tok.startsWith('syn:') || df >= 2) {
      vocab.push(tok);
    }
  }
  vocab.sort();
  const vocabIndex = new Map();
  vocab.forEach((tok, idx) => vocabIndex.set(tok, idx));

  const N = trainSet.length;
  const V = vocab.length;
  const K = labels.length;
  const idf = vocab.map((tok) => {
    const df = docFreq.get(tok) || 0;
    return Number((Math.log((1 + N) / (1 + df)) + 1).toFixed(4));
  });

  // Train TF-IDF Centroids + Multinomial Naive Bayes on trainSet
  const classDocCounts = new Array(K).fill(0);
  const classCentroidSums = Array.from(
    {length: K},
    () => new Float64Array(V)
  );
  const classNbSums = Array.from(
    {length: K},
    () => new Float64Array(V)
  );
  const classNbTotals = new Array(K).fill(0);
  const labelToIdx = new Map(labels.map((l, i) => [l, i]));

  for (const row of trainTokensList) {
    const cIdx = labelToIdx.get(row.intent);
    classDocCounts[cIdx] += 1;

    const counts = new Map();
    for (const tok of row.feats) {
      const fIdx = vocabIndex.get(tok);
      if (fIdx !== undefined) {
        counts.set(fIdx, (counts.get(fIdx) || 0) + 1);
      }
    }

    let normSq = 0;
    const rawWeights = new Map();
    for (const [fIdx, count] of counts.entries()) {
      const tok = vocab[fIdx];
      const typeScale = tok.startsWith('syn:')
        ? 2.4
        : tok.startsWith('b:')
        ? 1.8
        : tok.startsWith('w:')
        ? 1.6
        : 0.22;
      const w = (1 + Math.log(count)) * idf[fIdx] * typeScale;
      rawWeights.set(fIdx, w);
      normSq += w * w;
    }
    const docNorm = Math.sqrt(normSq) || 1;

    for (const [fIdx, w] of rawWeights.entries()) {
      const wn = w / docNorm;
      classCentroidSums[cIdx][fIdx] += wn;
      classNbSums[cIdx][fIdx] += w;
      classNbTotals[cIdx] += w;
    }
  }

  const classPriors = classDocCounts.map((cnt) =>
    Number(Math.log(cnt / N).toFixed(5))
  );

  // L2-normalized TF-IDF class centroids
  const centroids = classCentroidSums.map((arr) => {
    let n2 = 0;
    for (let fIdx = 0; fIdx < V; fIdx += 1) n2 += arr[fIdx] * arr[fIdx];
    const norm = Math.sqrt(n2) || 1;
    const out = new Array(V);
    for (let fIdx = 0; fIdx < V; fIdx += 1) {
      out[fIdx] = Number((arr[fIdx] / norm).toFixed(4));
    }
    return out;
  });

  // Smoothed Multinomial Naive Bayes log-probabilities with balanced class-volume normalization
  const alpha = 0.75;
  const avgNbTotal =
    classNbTotals.reduce((a, b) => a + b, 0) / (labels.length || 1) || 1;
  const denom = avgNbTotal + alpha * V;
  const logProbs = labels.map((_, cIdx) => {
    const scale = avgNbTotal / (classNbTotals[cIdx] || 1);
    const weights = classNbSums[cIdx];
    const rowArr = new Array(V);
    for (let fIdx = 0; fIdx < V; fIdx += 1) {
      rowArr[fIdx] = Number(
        Math.log((weights[fIdx] * scale + alpha) / denom).toFixed(4)
      );
    }
    return rowArr;
  });

  // Determine version
  const existingModelPath = path.join(ROOT, 'public', 'model.json');
  let nextVersion = options.version || '1.0.0';
  if (!options.version && fs.existsSync(existingModelPath) && options.bumpVersion) {
    try {
      const prev = JSON.parse(fs.readFileSync(existingModelPath, 'utf8'));
      nextVersion = bumpPatchVersion(prev.version);
    } catch {
      nextVersion = '1.0.1';
    }
  }

  const candidateCore = {
    format: 'rakshak-tfidf-nb-v1',
    version: nextVersion,
    labels,
    vocab,
    idf,
    classPriors,
    logProbs,
    centroids,
    synonyms: synonymsData,
  };

  // Validate candidate on held-out 20% split
  const valTrue = [];
  const valPred = [];
  const confusions = new Map();
  for (const item of valSet) {
    const res = predictFromModel(candidateCore, item.text, synonymsData);
    valTrue.push(item.intent);
    valPred.push(res.intent);
    if (res.intent !== item.intent) {
      const key = `${item.intent} -> ${res.intent}`;
      confusions.set(key, (confusions.get(key) || 0) + 1);
    }
  }
  const valMetrics = computeMetrics(labels, valTrue, valPred);

  // Evaluate independent /ml/test-phrases.json
  const heldOutResults = testPhrases.map((p) => {
    const res = predictFromModel(candidateCore, p.text, synonymsData);
    return {
      text: p.text,
      expected: p.expected,
      predicted: res.intent,
      confidence: res.confidence,
      correct: res.intent === p.expected,
    };
  });
  const heldOutCorrect = heldOutResults.filter((r) => r.correct).length;
  const heldOutAccuracy =
    heldOutResults.length > 0 ? heldOutCorrect / heldOutResults.length : 0;

  // Build integrity SHA-256 + HMAC-SHA256 signature
  const coreJson = JSON.stringify(candidateCore);
  const sha256 = crypto.createHash('sha256').update(coreJson).digest('hex');
  const signingSecret =
    process.env.RAKSHAK_MODEL_SIGNING_SECRET ||
    'rakshak-offline-model-integrity-v1';
  const signature = crypto
    .createHmac('sha256', signingSecret)
    .update(sha256)
    .digest('hex');

  const fullModel = {
    ...candidateCore,
    trainedAt: new Date().toISOString(),
    datasetStats: {
      totalRaw: rawDataset.length,
      deduplicatedTotal: cleanDataset.length,
      duplicatesSkipped,
      trainCount: trainSet.length,
      validationCount: valSet.length,
      vocabularySize: vocab.length,
      intentCount: labels.length,
    },
    metrics: {
      accuracy: Number(valMetrics.accuracy.toFixed(4)),
      macroF1: Number(valMetrics.macroF1.toFixed(4)),
      heldOutAccuracy: Number(heldOutAccuracy.toFixed(4)),
      heldOutTotal: heldOutResults.length,
      heldOutCorrect,
      perClass: Object.fromEntries(
        labels.map((l) => [
          l,
          {
            support: valMetrics.perClass[l].support,
            precision: Number(valMetrics.perClass[l].precision.toFixed(4)),
            recall: Number(valMetrics.perClass[l].recall.toFixed(4)),
            f1: Number(valMetrics.perClass[l].f1.toFixed(4)),
          },
        ])
      ),
    },
    integrity: {
      algorithm: 'sha256+hmac-sha256',
      sha256,
      signature,
    },
  };

  // Run emergency safety gate BEFORE writing production model artifacts
  const safety = runSafetyEvaluation(fullModel, fullModel.metrics);
  if (!safety.passed && !options.allowUnsafeDryRun) {
    console.error('\n[TRAIN ABORTED] Emergency Safety Evaluation Failed:');
    safety.failures.forEach((f) => console.error('  -', f));
    process.exit(1);
  }

  // Write artifacts if approved (or not dryRun)
  if (!options.dryRun) {
    const modelsDir = path.join(ROOT, 'public', 'models');
    fs.mkdirSync(modelsDir, {recursive: true});

    fs.writeFileSync(
      path.join(ROOT, 'public', 'model.json'),
      JSON.stringify(fullModel)
    );
    fs.writeFileSync(
      path.join(modelsDir, `model-v${nextVersion}.json`),
      JSON.stringify(fullModel)
    );

    const manifestPath = path.join(modelsDir, 'manifest.json');
    let prevManifest = {versions: []};
    if (fs.existsSync(manifestPath)) {
      try {
        prevManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch {
        prevManifest = {versions: []};
      }
    }

    const versionEntry = {
      version: nextVersion,
      url: `/models/model-v${nextVersion}.json`,
      sha256,
      signature,
      trainedAt: fullModel.trainedAt,
      accuracy: fullModel.metrics.accuracy,
      macroF1: fullModel.metrics.macroF1,
      heldOutAccuracy: fullModel.metrics.heldOutAccuracy,
      safetyPassed: safety.passed,
      sizeBytes: Buffer.byteLength(JSON.stringify(fullModel), 'utf8'),
    };

    const filteredPrev = (prevManifest.versions || []).filter(
      (v) => v.version !== nextVersion
    );

    const manifest = {
      latestVersion: nextVersion,
      updatedAt: new Date().toISOString(),
      minAppVersion: '1.0.0',
      versions: [versionEntry, ...filteredPrev].slice(0, 10),
    };

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  return {
    model: fullModel,
    valMetrics,
    heldOutResults,
    heldOutAccuracy,
    confusions: Array.from(confusions.entries()).sort((a, b) => b[1] - a[1]),
    safety,
  };
}

// CLI execution
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const bump = process.argv.includes('--bump');
  const dryRun = process.argv.includes('--dry-run');
  const result = trainOfflineModel({bumpVersion: bump, dryRun});
  const {model, heldOutResults, confusions, safety} = result;

  console.log('=== Rakshak Offline Classifier Training Report ===');
  console.log(`Model Version      : v${model.version}`);
  console.log(`Dataset Raw/Dedup  : ${model.datasetStats.totalRaw} / ${model.datasetStats.deduplicatedTotal}`);
  console.log(`Train / Val Split  : ${model.datasetStats.trainCount} / ${model.datasetStats.validationCount}`);
  console.log(`Vocabulary Size    : ${model.datasetStats.vocabularySize}`);
  console.log(`Validation Accuracy: ${(model.metrics.accuracy * 100).toFixed(2)}%`);
  console.log(`Validation Macro F1: ${(model.metrics.macroF1 * 100).toFixed(2)}%`);
  console.log(
    `Held-Out Test Set  : ${model.metrics.heldOutCorrect}/${model.metrics.heldOutTotal} (${(
      model.metrics.heldOutAccuracy * 100
    ).toFixed(2)}%)`
  );
  console.log(`Safety Gate Passed : ${safety.passed ? 'YES' : 'NO'}`);
  console.log(`SHA-256 Digest     : ${model.integrity.sha256}`);

  console.log('\nPer-Class Validation Metrics:');
  for (const label of model.labels) {
    const m = model.metrics.perClass[label];
    console.log(
      `  ${label.padEnd(20)} | n=${String(m.support).padStart(2)} | P=${(
        m.precision * 100
      )
        .toFixed(1)
        .padStart(5)}% | R=${(m.recall * 100)
        .toFixed(1)
        .padStart(5)}% | F1=${(m.f1 * 100).toFixed(1).padStart(5)}%`
    );
  }

  if (confusions.length > 0) {
    console.log('\nValidation Confusions:');
    confusions.slice(0, 10).forEach(([pair, count]) => {
      console.log(`  ${pair} (${count})`);
    });
  }

  const missedHeldOut = heldOutResults.filter((r) => !r.correct);
  if (missedHeldOut.length > 0) {
    console.log('\nHeld-Out Misclassifications:');
    missedHeldOut.forEach((m) => {
      console.log(`  "${m.text}" => ${m.predicted} (expected ${m.expected}, conf=${m.confidence})`);
    });
  }
}
