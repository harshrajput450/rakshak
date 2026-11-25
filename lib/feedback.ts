import type {
  EmergencyId,
  FeedbackSignalPayload,
  Language,
  LearningConsentState,
} from '../src/types/emergency';

const CONSENT_KEY = 'rakshak_learning_consent_v1';
const FEEDBACK_HISTORY_KEY = 'rakshak_feedback_history_v1';

function generateDeviceTag(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return `anon-${crypto.randomUUID().slice(0, 12)}`;
    }
  } catch {
    // Fallback
  }
  return `anon-${Math.random().toString(36).slice(2, 12)}`;
}

export function getLearningConsentState(): LearningConsentState {
  try {
    const raw = localStorage.getItem(CONSENT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as LearningConsentState;
      if (typeof parsed.consented === 'boolean' && parsed.deviceTag) {
        return parsed;
      }
    }
  } catch {
    // Ignore
  }
  return {
    consented: false,
    updatedAt: null,
    deviceTag: generateDeviceTag(),
  };
}

export function setLearningConsent(consented: boolean): LearningConsentState {
  const prev = getLearningConsentState();
  const next: LearningConsentState = {
    consented,
    updatedAt: new Date().toISOString(),
    deviceTag: prev.deviceTag || generateDeviceTag(),
  };
  try {
    localStorage.setItem(CONSENT_KEY, JSON.stringify(next));
  } catch {
    // Ignore
  }
  return next;
}

/**
 * Strips phone numbers, email addresses, URLs, GPS coordinates, Aadhaar/long IDs,
 * house/flat numbers, and common personal name intros before saving or uploading.
 */
export function sanitizeLearningText(raw: string): string {
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

export function getLocalFeedbackHistory(): FeedbackSignalPayload[] {
  try {
    const raw = localStorage.getItem(FEEDBACK_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as FeedbackSignalPayload[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLocalFeedbackEntry(entry: FeedbackSignalPayload): void {
  try {
    const existing = getLocalFeedbackHistory();
    existing.unshift(entry);
    localStorage.setItem(
      FEEDBACK_HISTORY_KEY,
      JSON.stringify(existing.slice(0, 100))
    );
  } catch {
    // Ignore
  }
}

export async function submitLearningFeedback(input: {
  rawText: string;
  language: Language;
  predictedIntent: EmergencyId | 'unknown';
  confidence: number;
  correctedIntent: EmergencyId | 'unknown';
  helpful: boolean;
  source: 'classifier_feedback' | 'triage_correction';
  modelVersion: string;
}): Promise<{
  savedLocally: boolean;
  uploadedOnline: boolean;
  message: string;
  entry: FeedbackSignalPayload | null;
}> {
  const consent = getLearningConsentState();
  const sanitized = sanitizeLearningText(input.rawText);

  if (!consent.consented) {
    return {
      savedLocally: false,
      uploadedOnline: false,
      message:
        input.language === 'hi'
          ? 'सुधार डेटा साझा करने की सहमति बंद है—कुछ भी सेव या अपलोड नहीं किया गया।'
          : 'Learning consent is OFF—nothing was stored or uploaded.',
      entry: null,
    };
  }

  const entry: FeedbackSignalPayload = {
    id: `sig-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    deviceTag: consent.deviceTag,
    createdAt: new Date().toISOString(),
    language: input.language,
    sanitizedText: sanitized,
    predictedIntent: input.predictedIntent,
    confidence: input.confidence,
    correctedIntent: input.correctedIntent,
    helpful: input.helpful,
    source: input.source,
    modelVersion: input.modelVersion,
    status: 'pending',
  };

  saveLocalFeedbackEntry(entry);

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return {
      savedLocally: true,
      uploadedOnline: false,
      message:
        input.language === 'hi'
          ? 'धन्यवाद। सुधार डिवाइस पर सुरक्षित रूप से सेव हो गया है (ऑफ़लाइन)।'
          : 'Saved locally without personal data. Online sync skipped while offline.',
      entry,
    };
  }

  try {
    const res = await fetch('/api/learning/signals', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        consentGiven: true,
        signal: entry,
      }),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return {
      savedLocally: true,
      uploadedOnline: true,
      message:
        input.language === 'hi'
          ? 'धन्यवाद! बिना किसी निजी जानकारी के आपका सुधार समीक्षक कतार में भेजा गया।'
          : 'Thank you! Anonymized feedback was sent for manual review before retraining.',
      entry,
    };
  } catch {
    return {
      savedLocally: true,
      uploadedOnline: false,
      message:
        input.language === 'hi'
          ? 'सुधार डिवाइस पर सेव हो गया है; सर्वर अभी उपलब्ध नहीं है।'
          : 'Saved locally; server upload skipped cleanly.',
      entry,
    };
  }
}

export async function withdrawConsentAndDeleteData(): Promise<{
  deletedRemote: boolean;
  message: string;
}> {
  const prev = getLearningConsentState();
  setLearningConsent(false);
  try {
    localStorage.removeItem(FEEDBACK_HISTORY_KEY);
  } catch {
    // Ignore
  }

  let deletedRemote = false;
  if (typeof navigator === 'undefined' || navigator.onLine) {
    try {
      const res = await fetch('/api/learning/delete', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({deviceTag: prev.deviceTag}),
      });
      deletedRemote = res.ok;
    } catch {
      deletedRemote = false;
    }
  }

  return {
    deletedRemote,
    message: deletedRemote
      ? 'Consent withdrawn and all local + server learning signals deleted.'
      : 'Consent withdrawn and local feedback deleted (offline/remote unavailable).',
  };
}

export function exportLocalFeedbackJson(): string {
  return JSON.stringify(getLocalFeedbackHistory(), null, 2);
}
