import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

export function normalizeEmergencyText(rawText) {
  if (!rawText || typeof rawText !== 'string') return '';
  let text = rawText.normalize('NFC').toLowerCase();
  // Preserve Unicode letters, combining marks (\p{M} for Devanagari matras), numbers, and spaces
  text = text
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Preserve critical medical/safety negations before feature extraction
  const negationRules = [
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

export function extractFeatures(rawText, synonymsData) {
  const norm = normalizeEmergencyText(rawText);
  if (!norm) return [];
  const words = norm.split(' ').filter(Boolean);
  const features = [];

  // Word unigrams (skip ultra-common function words so generic grammar never leaks into bleeding/fracture)
  for (const w of words) {
    if (FUNCTION_STOPWORDS.has(w)) continue;
    features.push(`w:${w}`);
    features.push(`w:${w}`);
  }

  // Word bigrams (kept across all tokens to preserve phrase context)
  for (let i = 0; i < words.length - 1; i += 1) {
    features.push(`b:${words[i]}_${words[i + 1]}`);
    features.push(`b:${words[i]}_${words[i + 1]}`);
  }

  // Character n-grams (3 to 4) on content words for typo/Hinglish/Devanagari morphological robustness
  for (const w of words) {
    if (w.length < 3 || FUNCTION_STOPWORDS.has(w)) continue;
    const padded = `^${w}$`;
    for (let n = 3; n <= 4; n += 1) {
      for (let i = 0; i <= padded.length - n; i += 1) {
        features.push(`c:${padded.slice(i, i + n)}`);
      }
    }
  }

  // Synonym dictionary expansion features (strictly intent matching, zero medical guidance)
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

export function predictFromModel(model, text, synonymsData) {
  const features = extractFeatures(text, synonymsData || model.synonyms);
  const vocabIndex = new Map();
  model.vocab.forEach((tok, idx) => vocabIndex.set(tok, idx));

  const tfCounts = new Map();
  for (const feat of features) {
    const idx = vocabIndex.get(feat);
    if (idx !== undefined) {
      tfCounts.set(idx, (tfCounts.get(idx) || 0) + 1);
    }
  }

  let normSq = 0;
  const docWeights = new Map();
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

  // Out-of-distribution guard: either virtually zero cosine overlap OR Naive Bayes strongly prefers unknown alongside low emergency cosine
  if (
    model.centroids &&
    !hasSynMatch &&
    (maxEmergencyCos < 0.06 || (maxEmergencyCos < 0.145 && nbPicksUnknown))
  ) {
    const unknownConfidence = 0.42;
    const topEmergencies = labels
      .map((label, cIdx) => ({
        intent: label,
        score: cosScores[cIdx],
      }))
      .filter((item) => item.intent !== 'unknown')
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map((item) => ({
        intent: item.intent,
        confidence: Number(Math.max(0.08, Math.min(0.4, item.score * 3)).toFixed(4)),
      }));
    return {
      intent: 'unknown',
      confidence: unknownConfidence,
      top3: [{intent: 'unknown', confidence: unknownConfidence}, ...topEmergencies],
    };
  }

  // Calibrated temperature softmax
  const maxScore = Math.max(...combined.map((s) => s.rawScore));
  const temperature = 0.2;
  const exps = combined.map((s) =>
    Math.exp(Math.max(-50, (s.rawScore - maxScore) / temperature))
  );
  const sumExps = exps.reduce((acc, v) => acc + v, 0) || 1;

  const ranked = combined
    .map((s, idx) => ({
      intent: s.intent,
      confidence: Number((exps[idx] / sumExps).toFixed(4)),
    }))
    .sort((a, b) => b.confidence - a.confidence);

  return {
    intent: ranked[0]?.intent || 'unknown',
    confidence: ranked[0]?.confidence || 0,
    top3: ranked.slice(0, 3),
  };
}

export function requiresBreathingSafetyCheck(text) {
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

export function verifyModelIntegrity(model) {
  if (!model || !model.integrity || !model.integrity.sha256) {
    return {valid: false, reason: 'Missing model integrity metadata.'};
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
  const computedSha256 = crypto
    .createHash('sha256')
    .update(corePayload)
    .digest('hex');

  if (computedSha256 !== model.integrity.sha256) {
    return {
      valid: false,
      reason: `SHA-256 mismatch (expected ${model.integrity.sha256}, got ${computedSha256}).`,
    };
  }
  return {valid: true, sha256: computedSha256};
}

export function runSafetyEvaluation(model, validationMetrics) {
  const safetySpec = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'safety-eval.json'), 'utf8')
  );
  const synonymsData = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'synonyms.json'), 'utf8')
  );

  const failures = [];

  // 1. Ensure model artifact contains NO medical treatment advice or steps
  const modelKeys = Object.keys(model);
  const forbiddenKeys = ['steps', 'protocols', 'treatment', 'medications', 'dosage'];
  for (const k of forbiddenKeys) {
    if (modelKeys.includes(k)) {
      failures.push(`Safety violation: model contains medical guidance key "${k}".`);
    }
  }

  // 2. Integrity hash check
  const integrity = verifyModelIntegrity(model);
  if (!integrity.valid) {
    failures.push(`Integrity check failed: ${integrity.reason}`);
  }

  // 3. Validation accuracy & Macro F1 gates
  if (validationMetrics) {
    if (validationMetrics.accuracy < safetySpec.minimumAccuracy) {
      failures.push(
        `Validation accuracy ${validationMetrics.accuracy.toFixed(4)} below threshold ${safetySpec.minimumAccuracy}`
      );
    }
    if (validationMetrics.macroF1 < safetySpec.minimumMacroF1) {
      failures.push(
        `Macro F1 ${validationMetrics.macroF1.toFixed(4)} below threshold ${safetySpec.minimumMacroF1}`
      );
    }
    for (const criticalIntent of safetySpec.criticalIntents) {
      const m = validationMetrics.perClass?.[criticalIntent];
      if (!m || m.recall < safetySpec.minimumCriticalRecall) {
        failures.push(
          `Critical intent "${criticalIntent}" recall ${m ? m.recall.toFixed(4) : 'N/A'} below ${safetySpec.minimumCriticalRecall}`
        );
      }
    }
  }

  // 4. Red-flag non-suppression checks
  for (const probe of safetySpec.mustNotBeUnknown) {
    const pred = predictFromModel(model, probe.text, synonymsData);
    if (!probe.allowed.includes(pred.intent)) {
      failures.push(
        `Safety probe "${probe.text}" predicted "${pred.intent}" (conf=${pred.confidence}), expected one of [${probe.allowed.join(', ')}].`
      );
    }
  }

  // 5. CPR breathing safety rule checks
  for (const phrase of safetySpec.mustTriggerBreathingSafetyRule) {
    if (!requiresBreathingSafetyCheck(phrase)) {
      failures.push(
        `Breathing safety rule did not trigger for "${phrase}".`
      );
    }
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}

// CLI execution when run directly: npm run safety-eval
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const modelPath = path.join(ROOT, 'public', 'model.json');
  if (!fs.existsSync(modelPath)) {
    console.error('No /public/model.json found. Run npm run train first.');
    process.exit(1);
  }
  const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
  const result = runSafetyEvaluation(model, model.metrics);
  if (result.passed) {
    console.log(
      `[Safety Eval PASSED] Model v${model.version} | Accuracy: ${(
        (model.metrics?.accuracy || 0) * 100
      ).toFixed(2)}% | Macro F1: ${((model.metrics?.macroF1 || 0) * 100).toFixed(
        2
      )}% | SHA-256 verified.`
    );
    process.exit(0);
  } else {
    console.error('[Safety Eval FAILED]');
    result.failures.forEach((f) => console.error(' -', f));
    process.exit(1);
  }
}
