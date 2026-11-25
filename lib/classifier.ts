import type {
  EmergencyId,
  OfflineClassificationResult,
  RankedIntentPrediction,
} from '../src/types/emergency';

export interface OfflineModelPayload {
  format: string;
  version: string;
  labels: Array<EmergencyId | 'unknown'>;
  vocab: string[];
  idf: number[];
  classPriors: number[];
  logProbs: number[][];
  centroids?: number[][];
  synonyms?: {
    version?: string;
    intents: Record<string, string[]>;
  };
  trainedAt?: string;
  metrics?: {
    accuracy?: number;
    macroF1?: number;
    heldOutAccuracy?: number;
  };
  integrity?: {
    algorithm?: string;
    sha256?: string;
    signature?: string;
  };
}

export interface LowConfidenceLogEntry {
  timestamp: string;
  sanitizedText: string;
  predictedIntent: EmergencyId | 'unknown';
  confidence: number;
  top3: RankedIntentPrediction[];
}

export const CONFIDENCE_THRESHOLD = 0.55;
const LOW_CONF_LOG_KEY = 'rakshak_low_confidence_logs';

const FUNCTION_STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'am', 'was', 'were', 'be', 'been', 'being',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as', 'and', 'or',
  'it', 'its', 'my', 'me', 'i', 'you', 'your', 'he', 'his', 'she', 'her', 'we',
  'they', 'their', 'this', 'that', 'these', 'those', 'what', 'which', 'who',
  'how', 'when', 'where', 'why', 'if', 'do', 'does', 'did', 'can', 'could',
  'should', 'would', 'will', 'has', 'have', 'had',
  'hai', 'hain', 'ho', 'hota', 'hoti', 'hote', 'tha', 'thi', 'the',
  'ka', 'ki', 'ke', 'ko', 'se', 'mein', 'me', 'par', 'pe', 'aur', 'ya', 'toh',
  'kya', 'kaise', 'kab', 'kahan', 'kyu', 'kyun', 'ab', 'abhi',
  'raha', 'rahi', 'rahe', 'gaya', 'gayi', 'gaye', 'kar', 'kare', 'karein', 'karna',
  'liye', 'wala', 'wali', 'wale', 'ye', 'yeh', 'woh', 'wo', 'mera', 'meri',
  'mere', 'uska', 'uski', 'unke', 'apna', 'apne', 'bhi', 'hi',
  'है', 'हैं', 'हूं', 'हो', 'होता', 'होती', 'होते', 'था', 'थी', 'थे',
  'का', 'की', 'के', 'को', 'से', 'में', 'पर', 'और', 'या', 'तो', 'भी', 'ही',
  'क्या', 'कैसे', 'कब', 'कहां', 'क्यों', 'अब', 'अभी',
  'रहा', 'रही', 'रहे', 'गया', 'गई', 'गए', 'कर', 'करें', 'करना', 'करने',
  'लिए', 'वाला', 'वाली', 'वाले', 'यह', 'वह', 'मेरा', 'मेरी', 'मेरे',
  'उसका', 'उसकी', 'उनके', 'अपना', 'अपने', 'यदि', 'अगर', 'जब', 'तब',
]);

let cachedModel: OfflineModelPayload | null = null;
let cachedModelVerified = false;
let cachedVocabIndex: Map<string, number> | null = null;

export function normalizeEmergencyText(rawText: string): string {
  if (!rawText || typeof rawText !== 'string') return '';
  let text = rawText
    .normalize('NFC')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const negationRules: Array<[RegExp, string]> = [
    [/\bnot\s+breathing\b/g, 'not_breathing'],
    [/\bno\s+breath(?:ing)?\b/g, 'not_breathing'],
    [/\bstopped\s+breathing\b/g, 'not_breathing'],
    [/\bnot\s+waking\b/g, 'not_waking'],
    [/\bno\s+pulse\b/g, 'no_pulse'],
    [/\bno\s+heartbeat\b/g, 'no_heartbeat'],
    [/\bnot\s+responding\b/g, 'not_responding'],
    [/\bcant\s+breathe\b/g, 'cannot_breathe'],
    [/\bcannot\s+breathe\b/g, 'cannot_breathe'],
    [/\bcant\s+speak\b/g, 'cannot_speak'],
    [/\bcannot\s+speak\b/g, 'cannot_speak'],
    [/\bcant\s+cough\b/g, 'cannot_cough'],
    [/\bcannot\s+cough\b/g, 'cannot_cough'],
    [/\bwont\s+stop\b/g, 'wont_stop'],
    [/\bsaans\s+nahi\b/g, 'saans_nahi'],
    [/\bsaans\s+nhi\b/g, 'saans_nahi'],
    [/\bsaans\s+ruk\b/g, 'saans_ruk'],
    [/\bsaans\s+band\b/g, 'saans_band'],
    [/\bdhadkan\s+ruk\b/g, 'dhadkan_ruk'],
    [/\bdhadkan\s+band\b/g, 'dhadkan_band'],
    [/\bpulse\s+nahi\b/g, 'pulse_nahi'],
    [/\bnabz\s+nahi\b/g, 'nabz_nahi'],
    [/\bkhoon\s+nahi\s+ruk\b/g, 'khoon_nahi_ruk'],
    [/\bbol\s+nahi\b/g, 'bol_nahi'],
    [/\bhath\s+nahi\s+uth\b/g, 'hath_nahi_uth'],
    [/सांस\s+नहीं/g, 'सांस_नहीं'],
    [/सांस\s+रुक/g, 'सांस_रुक'],
    [/सांस\s+बंद/g, 'सांस_बंद'],
    [/धड़कन\s+रुक/g, 'धड़कन_रुक'],
    [/धड़कन\s+बंद/g, 'धड़कन_बंद'],
    [/नब्ज\s+नहीं/g, 'नब्ज_नहीं'],
    [/खून\s+नहीं\s+रुक/g, 'खून_नहीं_रुक'],
  ];

  for (const [pattern, replacement] of negationRules) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

export function extractFeatures(
  rawText: string,
  synonymsData?: OfflineModelPayload['synonyms']
): string[] {
  const norm = normalizeEmergencyText(rawText);
  if (!norm) return [];
  const words = norm.split(' ').filter(Boolean);
  const features: string[] = [];

  for (const w of words) {
    if (FUNCTION_STOPWORDS.has(w)) continue;
    features.push(`w:${w}`, `w:${w}`);
  }

  for (let i = 0; i < words.length - 1; i += 1) {
    const bg = `b:${words[i]}_${words[i + 1]}`;
    features.push(bg, bg);
  }

  for (const w of words) {
    if (w.length < 3 || FUNCTION_STOPWORDS.has(w)) continue;
    const padded = `^${w}$`;
    for (let n = 3; n <= 4; n += 1) {
      for (let i = 0; i <= padded.length - n; i += 1) {
        features.push(`c:${padded.slice(i, i + n)}`);
      }
    }
  }

  if (synonymsData && synonymsData.intents) {
    const spaced = ` ${norm} `;
    for (const [intentId, phrases] of Object.entries(synonymsData.intents)) {
      let matches = 0;
      for (const phrase of phrases) {
        const pNorm = normalizeEmergencyText(phrase);
        if (!pNorm) continue;
        if (pNorm.includes(' ') || pNorm.includes('_')) {
          if (spaced.includes(` ${pNorm} `) || norm.includes(pNorm)) {
            matches += 2;
          }
        } else if (words.includes(pNorm)) {
          matches += 1;
        }
      }
      if (matches > 0) {
        const capped = Math.min(3, matches);
        for (let k = 0; k < capped; k += 1) {
          features.push(`syn:${intentId}`);
        }
      }
    }
  }

  return features;
}

export function requiresBreathingSafetyCheck(text: string): boolean {
  const norm = normalizeEmergencyText(text);
  const mentionsNoBreathing =
    norm.includes('not_breathing') ||
    norm.includes('saans_nahi') ||
    norm.includes('saans_ruk') ||
    norm.includes('saans_band') ||
    norm.includes('सांस_नहीं') ||
    norm.includes('सांस_रुक') ||
    norm.includes('सांस_बंद') ||
    norm.includes('not breathing') ||
    norm.includes('stopped breathing') ||
    norm.includes('saans nahi') ||
    norm.includes('सांस नहीं');

  const confirmsUnconscious =
    /\b(unconscious|unresponsive|behosh|no_pulse|pulse_nahi|nabz_nahi|no_heartbeat|dhadkan_ruk|dhadkan_band)\b/.test(
      norm
    ) ||
    norm.includes('बेहोश') ||
    norm.includes('नब्ज_नहीं') ||
    norm.includes('धड़कन_रुक') ||
    norm.includes('धड़कन_बंद');

  return mentionsNoBreathing && !confirmsUnconscious;
}

export async function computeModelSha256(
  model: OfflineModelPayload
): Promise<string | null> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    return null;
  }
  const corePayload = JSON.stringify({
    format: model.format,
    version: model.version,
    labels: model.labels,
    vocab: model.vocab,
    idf: model.idf,
    classPriors: model.classPriors,
    logProbs: model.logProbs,
    centroids: model.centroids,
    synonyms: model.synonyms,
  });
  const encoded = new TextEncoder().encode(corePayload);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function verifyOfflineModelPayload(
  model: OfflineModelPayload
): Promise<{valid: boolean; reason?: string}> {
  if (
    !model ||
    model.format !== 'rakshak-tfidf-nb-v1' ||
    !Array.isArray(model.labels) ||
    !Array.isArray(model.vocab) ||
    !Array.isArray(model.idf) ||
    !Array.isArray(model.logProbs)
  ) {
    return {valid: false, reason: 'Invalid offline model structure.'};
  }
  const expectedSha = model.integrity?.sha256;
  if (!expectedSha) {
    return {valid: false, reason: 'Missing SHA-256 digest.'};
  }
  const computed = await computeModelSha256(model);
  if (computed && computed !== expectedSha) {
    return {valid: false, reason: 'Model SHA-256 integrity verification failed.'};
  }
  return {valid: true};
}

export function setActiveOfflineModel(
  model: OfflineModelPayload,
  verified: boolean
): void {
  cachedModel = model;
  cachedModelVerified = verified;
  const map = new Map<string, number>();
  model.vocab.forEach((tok, idx) => map.set(tok, idx));
  cachedVocabIndex = map;
}

export function getActiveOfflineModelSnapshot(): {
  model: OfflineModelPayload | null;
  verified: boolean;
} {
  return {model: cachedModel, verified: cachedModelVerified};
}

export async function ensureOfflineModelLoaded(): Promise<{
  model: OfflineModelPayload;
  verified: boolean;
}> {
  if (cachedModel && cachedVocabIndex) {
    return {model: cachedModel, verified: cachedModelVerified};
  }

  // Try fetching /model.json (served locally or precached offline by Workbox SW)
  const response = await fetch('/model.json', {cache: 'no-cache'});
  if (!response.ok) {
    throw new Error(`Failed to load offline model (${response.status})`);
  }
  const model = (await response.json()) as OfflineModelPayload;
  const integrity = await verifyOfflineModelPayload(model);
  if (!integrity.valid) {
    throw new Error(integrity.reason || 'Offline model integrity check failed.');
  }
  setActiveOfflineModel(model, true);
  return {model, verified: true};
}

function recordLowConfidenceLocalLog(entry: LowConfidenceLogEntry): void {
  try {
    const raw = localStorage.getItem(LOW_CONF_LOG_KEY);
    const list: LowConfidenceLogEntry[] = raw ? JSON.parse(raw) : [];
    const safeList = Array.isArray(list) ? list : [];
    safeList.unshift(entry);
    localStorage.setItem(LOW_CONF_LOG_KEY, JSON.stringify(safeList.slice(0, 50)));
  } catch {
    // Ignore storage failures
  }
}

export function getLowConfidenceLocalLogs(): LowConfidenceLogEntry[] {
  try {
    const raw = localStorage.getItem(LOW_CONF_LOG_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function clearLowConfidenceLocalLogs(): void {
  try {
    localStorage.removeItem(LOW_CONF_LOG_KEY);
  } catch {
    // Ignore
  }
}

const FAST_KEYWORD_BANK: Record<EmergencyId, string[]> = {
  cardiac_arrest_cpr: [
    'cpr', 'cardiac arrest', 'not_breathing', 'saans_nahi', 'saans_ruk', 'saans_band',
    'सांस_नहीं', 'सांस_रुक', 'सांस_बंद', 'no_pulse', 'pulse_nahi', 'nabz_nahi', 'नब्ज_नहीं',
    'no_heartbeat', 'dhadkan_ruk', 'dhadkan_band', 'धड़कन_रुक', 'धड़कन_बंद', 'नब्ज नहीं', 'सीपीआर',
  ],
  choking: [
    'choking', 'choke', 'gala fas', 'gale me', 'khana atak', 'cannot_cough', 'cannot_speak',
    'गला', 'अटक', 'दम घुट', 'फंस गया', 'खाना अटक',
  ],
  severe_bleeding: [
    'bleeding', 'blood', 'cut', 'wound', 'khoon', 'khoon_nahi_ruk', 'लहू', 'खून', 'खून_नहीं_रुक',
    'कट गया', 'चोट से खून', 'गहरा घाव',
  ],
  seizure: [
    'seizure', 'fits', 'epilepsy', 'convulsion', 'daura', 'mirgi', 'झटके', 'मिर्गी', 'दौरा',
  ],
  burns: [
    'burn', 'burns', 'burned', 'scald', 'fire', 'acid', 'jal gaya', 'jalna', 'aag', 'गर्म पानी', 'जल गया', 'जलन', 'आग',
  ],
  snakebite: [
    'snakebite', 'snake', 'saanp', 'saap', 'सांप', 'साँप', 'काटा सांप', 'सर्प',
  ],
  heart_attack: [
    'heart attack', 'chest pain', 'angina', 'seene mein dard', 'seene me dard', 'dil ka daura',
    'छाती में दर्द', 'सीने में दर्द', 'दिल का दौरा', 'हार्ट अटैक',
  ],
  stroke: [
    'stroke', 'paralysis', 'face droop', 'slurred speech', 'lakwa', 'falij', 'bol_nahi', 'hath_nahi_uth',
    'लकवा', 'पक्षाघात', 'चेहरा टेढ़ा', 'बोल नहीं',
  ],
  fainting: [
    'faint', 'fainted', 'fainting', 'dizzy', 'dizziness', 'chakkar', 'behosh', 'बेहोश', 'चक्कर',
  ],
  fracture_injury: [
    'fracture', 'broken bone', 'sprain', 'haddi', 'toot', 'moch', 'हड्डी', 'टूट', 'मोच',
  ],
  head_injury: [
    'head injury', 'concussion', 'hit head', 'sar par', 'sir me chot', 'सिर में चोट', 'सर में चोट',
  ],
  drowning: [
    'drowning', 'drown', 'submerged', 'doob', 'dub', 'pani mein', 'डूब', 'पानी में डूब',
  ],
  electric_shock: [
    'electric shock', 'electrocution', 'current', 'bijli', 'karant', 'करंट', 'बिजली', 'झटका बिजली',
  ],
  poisoning: [
    'poison', 'poisoning', 'overdose', 'chemical', 'pesticide', 'zahar', 'jahar', 'ज़हर', 'जहर', 'कीटनाशक',
  ],
  heatstroke: [
    'heatstroke', 'heat stroke', 'sunstroke', 'loo', 'garmi', 'लू', 'गर्मी से बेहोश', 'हीटस्ट्रोक',
  ],
  asthma_attack: [
    'asthma', 'inhaler', 'wheezing', 'cannot_breathe', 'saans phool', 'dama', 'दमा', 'अस्थमा', 'सांस फूल', 'इन्हेलर',
  ],
  allergic_reaction: [
    'allergy', 'allergic', 'anaphylaxis', 'hives', 'swelling throat', 'sujan', 'एलर्जी', 'सूजन', 'दाने',
  ],
  dog_bite: [
    'dog bite', 'dog', 'rabies', 'animal bite', 'kutta', 'kutte', 'कुत्ता', 'कुत्ते ने काटा',
  ],
  nosebleed: [
    'nosebleed', 'nose bleed', 'nakseer', 'naak se khoon', 'नाक से खून', 'नकसीर',
  ],
  low_blood_sugar: [
    'low blood sugar', 'hypoglycemia', 'diabetes', 'sugar down', 'sugar kam', 'शुगर कम', 'लो शुगर', 'मधुमेह',
  ],
};

export function classifyByKeywordRules(rawText: string): {
  intent: EmergencyId | 'unknown';
  confidence: number;
  top3: RankedIntentPrediction[];
} {
  const norm = normalizeEmergencyText(rawText);
  if (!norm) {
    return {intent: 'unknown', confidence: 0, top3: []};
  }
  const spaced = ` ${norm} `;
  const scores: Array<{intent: EmergencyId; score: number}> = [];

  for (const [intent, keywords] of Object.entries(FAST_KEYWORD_BANK) as Array<
    [EmergencyId, string[]]
  >) {
    let score = 0;
    for (const kw of keywords) {
      const kNorm = normalizeEmergencyText(kw);
      if (!kNorm) continue;
      if (spaced.includes(` ${kNorm} `)) {
        score += kNorm.includes(' ') || kNorm.includes('_') ? 4 : 3;
      } else if (norm.includes(kNorm) && kNorm.length >= 4) {
        score += 1.5;
      }
    }
    if (score > 0) {
      scores.push({intent, score});
    }
  }

  scores.sort((a, b) => b.score - a.score);
  if (scores.length === 0) {
    return {intent: 'unknown', confidence: 0, top3: []};
  }

  const best = scores[0];
  const second = scores[1]?.score ?? 0;
  const margin = best.score - second;
  const conf = Math.min(
    0.92,
    Math.max(0.56, 0.56 + best.score * 0.08 + margin * 0.04)
  );
  const top3 = scores.slice(0, 3).map((s, idx) => ({
    intent: s.intent,
    confidence:
      idx === 0
        ? Number(conf.toFixed(4))
        : Number(Math.max(0.15, Math.min(0.5, s.score * 0.12)).toFixed(4)),
  }));

  return {
    intent: best.intent,
    confidence: Number(conf.toFixed(4)),
    top3,
  };
}

export async function classifyEmergencyOffline(
  rawText: string
): Promise<OfflineClassificationResult> {
  const start = performance.now();
  const normalizedText = normalizeEmergencyText(rawText);
  const breathingCheck = requiresBreathingSafetyCheck(rawText);
  const keywordResult = classifyByKeywordRules(rawText);

  let model: OfflineModelPayload | null = null;
  let verified = false;
  try {
    const loaded = await ensureOfflineModelLoaded();
    model = loaded.model;
    verified = loaded.verified;
  } catch {
    model = null;
    verified = false;
  }

  if (!model) {
    const isLow =
      keywordResult.intent === 'unknown' ||
      keywordResult.confidence < CONFIDENCE_THRESHOLD;
    return {
      intent: keywordResult.intent,
      confidence: keywordResult.confidence,
      isLowConfidence: isLow,
      requiresBreathingSafetyCheck: breathingCheck,
      top3: keywordResult.top3,
      normalizedText,
      modelVersion: 'keyword-fallback',
      modelVerified: false,
      latencyMs: Math.round(performance.now() - start),
    };
  }

  const vocabIndex =
    cachedVocabIndex ||
    (() => {
      const m = new Map<string, number>();
      model.vocab.forEach((tok, idx) => m.set(tok, idx));
      cachedVocabIndex = m;
      return m;
    })();

  const features = extractFeatures(rawText, model.synonyms);

  const tfCounts = new Map<number, number>();
  for (const feat of features) {
    const idx = vocabIndex.get(feat);
    if (idx !== undefined) {
      tfCounts.set(idx, (tfCounts.get(idx) || 0) + 1);
    }
  }

  let normSq = 0;
  const docWeights = new Map<number, number>();
  for (const [featIdx, count] of tfCounts.entries()) {
    const tok = model.vocab[featIdx];
    const typeScale = tok.startsWith('syn:')
      ? 2.4
      : tok.startsWith('b:')
      ? 1.8
      : tok.startsWith('w:')
      ? 1.6
      : 0.22;
    const w = (1 + Math.log(count)) * model.idf[featIdx] * typeScale;
    docWeights.set(featIdx, w);
    normSq += w * w;
  }
  const docNorm = Math.sqrt(normSq) || 1;

  const labels = model.labels;
  const cosScores = labels.map((_, cIdx) => {
    const centroid = model.centroids?.[cIdx];
    if (!centroid) return 0;
    let score = 0;
    for (const [featIdx, w] of docWeights.entries()) {
      score += (w / docNorm) * centroid[featIdx];
    }
    return score;
  });

  const nbScores = labels.map((_, cIdx) => {
    let score = model.classPriors[cIdx] * 0.15;
    const condLogProbs = model.logProbs[cIdx];
    for (const [featIdx, w] of docWeights.entries()) {
      score += (w / docNorm) * condLogProbs[featIdx];
    }
    return score;
  });

  const maxNb = Math.max(...nbScores);
  const minNb = Math.min(...nbScores);
  const spanNb = maxNb - minNb || 1;

  const combined = labels.map((label, cIdx) => {
    const cosVal = model.centroids ? cosScores[cIdx] : 0;
    const normNb = (nbScores[cIdx] - minNb) / spanNb;
    const rawScore = model.centroids ? 4.4 * cosVal + 0.55 * normNb : normNb;
    return {intent: label, rawScore, cosScore: cosVal};
  });

  const hasSynMatch = features.some((f) => f.startsWith('syn:'));
  const unknownIdx = labels.indexOf('unknown');
  const maxEmergencyCos = Math.max(
    0,
    ...labels.map((label, idx) => (label === 'unknown' ? 0 : cosScores[idx]))
  );
  const nbPicksUnknown =
    unknownIdx !== -1 && nbScores[unknownIdx] >= maxNb - 0.02;

  let ranked: RankedIntentPrediction[];

  if (
    model.centroids &&
    !hasSynMatch &&
    (maxEmergencyCos < 0.06 || (maxEmergencyCos < 0.145 && nbPicksUnknown))
  ) {
    const unknownConfidence = 0.42;
    const topEmergencies: RankedIntentPrediction[] = labels
      .map((label, cIdx) => ({
        intent: label,
        score: cosScores[cIdx],
      }))
      .filter((item) => item.intent !== 'unknown')
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((item) => ({
        intent: item.intent,
        confidence: Number(
          Math.max(0.08, Math.min(0.4, item.score * 3)).toFixed(4)
        ),
      }));
    ranked = [{intent: 'unknown', confidence: unknownConfidence}, ...topEmergencies];
  } else {
    const maxScore = Math.max(...combined.map((s) => s.rawScore));
    const temperature = 0.2;
    const exps = combined.map((s) =>
      Math.exp(Math.max(-50, (s.rawScore - maxScore) / temperature))
    );
    const sumExps = exps.reduce((acc, v) => acc + v, 0) || 1;

    ranked = combined
      .map((s, idx) => ({
        intent: s.intent,
        confidence: Number((exps[idx] / sumExps).toFixed(4)),
      }))
      .sort((a, b) => b.confidence - a.confidence);
  }

  let best = ranked[0] || {intent: 'unknown' as const, confidence: 0};
  let top3EmergencySuggestions = ranked
    .filter((item) => item.intent !== 'unknown')
    .slice(0, 3);

  // Keyword booster: if TF-IDF scored low/unknown but fast keywords had a clear match, trust keywords
  if (
    (best.intent === 'unknown' || best.confidence < CONFIDENCE_THRESHOLD) &&
    keywordResult.intent !== 'unknown' &&
    keywordResult.confidence >= CONFIDENCE_THRESHOLD
  ) {
    best = {
      intent: keywordResult.intent,
      confidence: keywordResult.confidence,
    };
    top3EmergencySuggestions = keywordResult.top3;
  }

  const isLowConfidence =
    best.intent === 'unknown' || best.confidence < CONFIDENCE_THRESHOLD;

  if (isLowConfidence && normalizedText.length >= 3) {
    recordLowConfidenceLocalLog({
      timestamp: new Date().toISOString(),
      sanitizedText: normalizedText.slice(0, 120),
      predictedIntent: best.intent,
      confidence: best.confidence,
      top3: top3EmergencySuggestions,
    });
  }

  return {
    intent: best.intent,
    confidence: best.confidence,
    isLowConfidence,
    requiresBreathingSafetyCheck: breathingCheck,
    top3: top3EmergencySuggestions,
    normalizedText,
    modelVersion: model.version,
    modelVerified: verified,
    latencyMs: Math.round(performance.now() - start),
  };
}

