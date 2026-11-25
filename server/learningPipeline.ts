import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {EmergencyId, FeedbackSignalPayload} from '../src/types/emergency';

const DATA_DIR = path.resolve(process.cwd(), 'server_data');
const VAULT_FILE = path.join(DATA_DIR, 'learning_signals.enc');
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const VALID_INTENTS = new Set<string>([
  'cardiac_arrest_cpr',
  'choking',
  'severe_bleeding',
  'seizure',
  'burns',
  'snakebite',
  'heart_attack',
  'stroke',
  'fainting',
  'fracture_injury',
  'head_injury',
  'drowning',
  'electric_shock',
  'poisoning',
  'heatstroke',
  'asthma_attack',
  'allergic_reaction',
  'dog_bite',
  'nosebleed',
  'low_blood_sugar',
  'unknown',
]);

interface StoredVaultRecord extends FeedbackSignalPayload {
  status: 'pending' | 'approved' | 'rejected';
  reviewedAt?: string;
}

function getEncryptionKey(): Buffer {
  const raw = process.env.RAKSHAK_LEARNING_ENCRYPTION_KEY?.trim();
  if (!raw || raw.length < 32) {
    throw new Error(
      'Configure RAKSHAK_LEARNING_ENCRYPTION_KEY with at least 32 characters before using the learning vault.'
    );
  }
  return crypto.createHash('sha256').update(raw).digest();
}

export function isAuthorizedReviewer(authHeader?: string): boolean {
  const expected = process.env.RAKSHAK_ADMIN_TOKEN;
  if (!expected) {
    // When no admin token is configured in local dev, allow localhost/dev testing
    // only when explicitly presenting the local dev reviewer header
    return authHeader === 'Bearer local-dev-reviewer';
  }
  return authHeader === `Bearer ${expected}`;
}

export function sanitizeServerText(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/(?:\+?\d[\d\s\-()]{6,}\d)/g, '[number]')
    .replace(/-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/g, '[coords]')
    .replace(
      /\b(my name is|i am|call me|mera naam|main)\s+[A-Z\p{L}]{2,20}/giu,
      '$1 [name]'
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

function readVault(): StoredVaultRecord[] {
  if (!fs.existsSync(VAULT_FILE)) return [];
  try {
    const blob = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8')) as {
      iv: string;
      tag: string;
      data: string;
    };
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      getEncryptionKey(),
      Buffer.from(blob.iv, 'hex')
    );
    decipher.setAuthTag(Buffer.from(blob.tag, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(blob.data, 'hex')),
      decipher.final(),
    ]).toString('utf8');
    const list = JSON.parse(decrypted) as StoredVaultRecord[];
    const cutoff = Date.now() - RETENTION_MS;
    return Array.isArray(list)
      ? list.filter((item) => Date.parse(item.createdAt) >= cutoff)
      : [];
  } catch (err) {
    console.error('[Rakshak Learning Vault] Read error:', err);
    throw new Error(
      'The learning vault could not be read. Verify its encryption key and integrity.'
    );
  }
}

function writeVault(records: StoredVaultRecord[]): void {
  fs.mkdirSync(DATA_DIR, {recursive: true});
  const cutoff = Date.now() - RETENTION_MS;
  const pruned = records
    .filter((item) => Date.parse(item.createdAt) >= cutoff)
    .slice(0, 2000);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    getEncryptionKey(),
    iv
  );
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(pruned), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  fs.writeFileSync(
    VAULT_FILE,
    JSON.stringify({
      alg: 'aes-256-gcm',
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      data: encrypted.toString('hex'),
    })
  );
}

export function ingestLearningSignal(payload: {
  consentGiven?: boolean;
  signal?: Partial<FeedbackSignalPayload>;
}): {accepted: boolean; duplicate?: boolean; reason?: string; id?: string} {
  if (!payload.consentGiven || !payload.signal) {
    return {accepted: false, reason: 'Explicit user consent is required.'};
  }
  const s = payload.signal;
  const sanitized = sanitizeServerText(s.sanitizedText || '');
  if (sanitized.length < 4) {
    return {accepted: false, reason: 'Signal text is too short or empty.'};
  }
  if (
    !VALID_INTENTS.has(String(s.correctedIntent)) ||
    !VALID_INTENTS.has(String(s.predictedIntent))
  ) {
    return {accepted: false, reason: 'Invalid emergency intent category.'};
  }

  const vault = readVault();
  const normalizedKey = sanitized.toLowerCase();
  const isDuplicate = vault.some(
    (item) =>
      item.sanitizedText.toLowerCase() === normalizedKey &&
      item.correctedIntent === s.correctedIntent
  );
  if (isDuplicate) {
    return {accepted: true, duplicate: true, reason: 'Duplicate already queued.'};
  }

  const record: StoredVaultRecord = {
    id:
      typeof s.id === 'string' && s.id.length <= 64
        ? s.id
        : `sig-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    deviceTag:
      typeof s.deviceTag === 'string'
        ? crypto
            .createHash('sha256')
            .update(s.deviceTag)
            .digest('hex')
            .slice(0, 16)
        : 'anonymous',
    createdAt: new Date().toISOString(),
    language: s.language === 'en' ? 'en' : 'hi',
    sanitizedText: sanitized,
    predictedIntent: s.predictedIntent as EmergencyId | 'unknown',
    confidence: Number(s.confidence) || 0,
    correctedIntent: s.correctedIntent as EmergencyId | 'unknown',
    helpful: Boolean(s.helpful),
    source:
      s.source === 'triage_correction'
        ? 'triage_correction'
        : 'classifier_feedback',
    modelVersion:
      typeof s.modelVersion === 'string' ? s.modelVersion.slice(0, 20) : '1.0.0',
    status: 'pending',
  };

  vault.unshift(record);
  writeVault(vault);
  return {accepted: true, id: record.id};
}

export function deleteSignalsForDevice(deviceTag: string): number {
  if (!deviceTag || typeof deviceTag !== 'string') return 0;
  const hashedTag = crypto
    .createHash('sha256')
    .update(deviceTag)
    .digest('hex')
    .slice(0, 16);
  const vault = readVault();
  const remaining = vault.filter(
    (item) => item.deviceTag !== hashedTag && item.deviceTag !== deviceTag
  );
  const removedCount = vault.length - remaining.length;
  writeVault(remaining);
  return removedCount;
}

export function getReviewerQueue(): StoredVaultRecord[] {
  return readVault();
}

export function reviewLearningSignal(
  id: string,
  decision: 'approved' | 'rejected',
  correctedIntent?: EmergencyId | 'unknown'
): StoredVaultRecord | null {
  const vault = readVault();
  let updated: StoredVaultRecord | null = null;
  const next = vault.map((item) => {
    if (item.id !== id) return item;
    updated = {
      ...item,
      status: decision,
      correctedIntent:
        correctedIntent && VALID_INTENTS.has(correctedIntent)
          ? correctedIntent
          : item.correctedIntent,
      reviewedAt: new Date().toISOString(),
    };
    return updated;
  });
  if (updated) {
    writeVault(next);
  }
  return updated;
}
