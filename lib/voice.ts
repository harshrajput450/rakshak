import type {InputVoiceLanguage, Language, VoiceOptionInfo} from '../src/types/emergency';

export interface BrowserSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives?: number;
  onstart: (() => void) | null;
  onspeechstart?: (() => void) | null;
  onspeechend?: (() => void) | null;
  onresult: ((e: SpeechRecognitionResultEventLike) => void) | null;
  onerror: ((e: {error?: string; message?: string}) => void) | null;
  onnomatch?: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

export interface SpeechRecognitionResultEventLike {
  resultIndex: number;
  results: ArrayLike<
    ArrayLike<{transcript: string}> & {isFinal?: boolean}
  >;
}

export type SpeechRecognitionCtor = new () => BrowserSpeechRecognition;

const VOICE_PREF_HI_KEY = 'rakshak_voice_pref_hi';
const VOICE_PREF_EN_KEY = 'rakshak_voice_pref_en';
const VOICE_ENABLED_KEY = 'rakshak_voice_output_enabled';

const FEMALE_HINT_NAMES = [
  'swara',
  'lekha',
  'kalpana',
  'heera',
  'neerja',
  'raveena',
  'veena',
  'aditi',
  'kajal',
  'priya',
  'ananya',
  'kiara',
  'kiyara',
  'neha',
  'sangeeta',
  'shruti',
  'meera',
  'vani',
  'hi-in-x-hia',
  'hi-in-x-hie',
  'samantha',
  'karen',
  'serena',
  'susan',
  'zira',
  'aria',
  'jenny',
  'female',
  'woman',
  'google हिन्दी',
];

const MALE_HINT_NAMES = [
  'rishi',
  'prabhat',
  'ravi',
  'hemant',
  'madhur',
  'aryan',
  'niraj',
  'hi-in-x-hic',
  'hi-in-x-hid',
  'daniel',
  'david',
  'mark',
  'george',
  'male',
  'man',
];

let cachedVoices: SpeechSynthesisVoice[] = [];
let voicesListenerAttached = false;
let activeUtteranceId = 0;
let lastSpokenSignature = '';
let lastSpokenTimestamp = 0;
let activeFallbackTimer: number | null = null;
const voiceSubscribers = new Set<() => void>();

export function getSpeechRecognitionConstructor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function isSpeechRecognitionSupported(): boolean {
  return getSpeechRecognitionConstructor() !== null;
}

export function getRecognitionLanguage(
  lang: Language | InputVoiceLanguage
): 'hi-IN' | 'en-IN' {
  return lang === 'hi' || lang === 'hinglish' ? 'hi-IN' : 'en-IN';
}

export function pickBestRecognitionAlternative(
  result: ArrayLike<{transcript: string}> | undefined,
  maxAlts = 5
): string {
  if (!result || result.length === 0) return '';
  const limit = Math.min(result.length, maxAlts);
  for (let i = 0; i < limit; i += 1) {
    const candidate = (result[i]?.transcript || '').replace(/\s+/g, ' ').trim();
    if (candidate.length > 0) {
      return candidate;
    }
  }
  return '';
}

export function joinTranscriptParts(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractSpeechResultSegments(
  results: SpeechRecognitionResultEventLike['results'],
  maxAlts = 5
): {finalText: string; interimText: string} {
  const finals: string[] = [];
  const interims: string[] = [];

  for (let i = 0; i < results.length; i += 1) {
    const res = results[i];
    const best = pickBestRecognitionAlternative(res, maxAlts);
    if (!best) continue;
    if (res?.isFinal) {
      const prev = finals[finals.length - 1];
      if (prev && best.length > prev.length && best.startsWith(prev + ' ')) {
        finals[finals.length - 1] = best;
      } else {
        finals.push(best);
      }
    } else {
      interims.push(best);
    }
  }

  return {
    finalText: joinTranscriptParts(...finals),
    interimText: joinTranscriptParts(...interims),
  };
}

export function isSpeechSynthesisSpeaking(): boolean {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return false;
  }
  try {
    return Boolean(window.speechSynthesis.speaking);
  } catch {
    return false;
  }
}

export function logVoiceLifecycle(
  event: string,
  detail?: Record<string, unknown>
): void {
  const isDev =
    (typeof import.meta !== 'undefined' &&
      Boolean((import.meta as {env?: {DEV?: boolean}}).env?.DEV)) ||
    (typeof process !== 'undefined' &&
      process.env?.NODE_ENV === 'development');
  if (!isDev) return;
  try {
    console.debug('[Rakshak Voice]', event, detail || {});
  } catch {
    // Ignore logging errors
  }
}

export function isSpeechSynthesisSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export function isVoiceOutputEnabled(): boolean {
  try {
    const val = localStorage.getItem(VOICE_ENABLED_KEY);
    return val === null ? true : val === 'true';
  } catch {
    return true;
  }
}

export function setVoiceOutputEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(VOICE_ENABLED_KEY, enabled ? 'true' : 'false');
  } catch {
    // Ignore
  }
  if (!enabled) {
    stopSpeaking();
  }
}

export function getPreferredVoiceURI(lang: Language): string {
  try {
    return (
      localStorage.getItem(lang === 'hi' ? VOICE_PREF_HI_KEY : VOICE_PREF_EN_KEY) ||
      ''
    );
  } catch {
    return '';
  }
}

export function setPreferredVoiceURI(lang: Language, voiceURI: string): void {
  try {
    const key = lang === 'hi' ? VOICE_PREF_HI_KEY : VOICE_PREF_EN_KEY;
    if (!voiceURI) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, voiceURI);
    }
  } catch {
    // Ignore
  }
}

function refreshVoiceCache(): SpeechSynthesisVoice[] {
  if (!isSpeechSynthesisSupported()) return [];
  try {
    const list = window.speechSynthesis.getVoices();
    if (list.length > 0) {
      cachedVoices = list;
    }
    return cachedVoices;
  } catch {
    return cachedVoices;
  }
}

export function subscribeToVoicesChanged(cb: () => void): () => void {
  voiceSubscribers.add(cb);
  initSpeechVoices();
  return () => {
    voiceSubscribers.delete(cb);
  };
}

export function initSpeechVoices(): void {
  if (!isSpeechSynthesisSupported()) return;
  refreshVoiceCache();
  if (!voicesListenerAttached) {
    voicesListenerAttached = true;
    const handleVoicesChanged = () => {
      refreshVoiceCache();
      voiceSubscribers.forEach((cb) => {
        try {
          cb();
        } catch {
          // Ignore subscriber errors
        }
      });
    };
    if (typeof window.speechSynthesis.addEventListener === 'function') {
      window.speechSynthesis.addEventListener('voiceschanged', handleVoicesChanged);
    } else {
      window.speechSynthesis.onvoiceschanged = handleVoicesChanged;
    }
  }
}

function scoreVoiceForLanguage(
  voice: SpeechSynthesisVoice,
  lang: Language
): VoiceOptionInfo {
  const nameLower = voice.name.toLowerCase();
  const langLower = voice.lang.toLowerCase().replace(/_/g, '-');
  const isFemaleLikely = FEMALE_HINT_NAMES.some((k) => nameLower.includes(k));
  const isMaleLikely =
    !isFemaleLikely && MALE_HINT_NAMES.some((k) => nameLower.includes(k));

  let score = 0;

  if (lang === 'hi') {
    if (langLower === 'hi-in') score += 60;
    else if (langLower.startsWith('hi')) score += 45;
    else if (nameLower.includes('hindi') || nameLower.includes('हिन्दी')) score += 35;
    else score -= 100;
  } else {
    if (langLower === 'en-in') score += 60;
    else if (langLower.startsWith('en-gb')) score += 45;
    else if (langLower.startsWith('en-us')) score += 40;
    else if (langLower.startsWith('en')) score += 30;
    else score -= 100;
  }

  if (isFemaleLikely) score += 40;
  if (isMaleLikely) score -= 35;
  if (nameLower.includes('natural') || nameLower.includes('neural')) score += 12;
  if (voice.localService) score += 8;

  return {
    voiceURI: voice.voiceURI,
    name: voice.name,
    lang: voice.lang,
    isFemaleLikely,
    isMaleLikely,
    score,
  };
}

export function getAvailableVoicesForLanguage(lang: Language): VoiceOptionInfo[] {
  initSpeechVoices();
  const voices = refreshVoiceCache();
  return voices
    .map((v) => ({raw: v, info: scoreVoiceForLanguage(v, lang)}))
    .filter((entry) => entry.info.score > -50)
    .sort((a, b) => b.info.score - a.info.score)
    .map((entry) => entry.info);
}

export function pickCalmVoice(lang: Language): {
  voice: SpeechSynthesisVoice | null;
  info: VoiceOptionInfo | null;
} {
  if (!isSpeechSynthesisSupported()) return {voice: null, info: null};
  initSpeechVoices();
  const voices = refreshVoiceCache();
  if (!voices.length) return {voice: null, info: null};

  const preferredURI = getPreferredVoiceURI(lang);
  if (preferredURI) {
    const manual = voices.find((v) => v.voiceURI === preferredURI);
    if (manual) {
      return {voice: manual, info: scoreVoiceForLanguage(manual, lang)};
    }
  }

  const scored = voices
    .map((v) => ({voice: v, info: scoreVoiceForLanguage(v, lang)}))
    .filter((item) => item.info.score > -50)
    .sort((a, b) => b.info.score - a.info.score);

  if (scored.length === 0) return {voice: null, info: null};
  return scored[0];
}

export function getVoiceSelectionNotice(lang: Language): string | null {
  if (!isSpeechSynthesisSupported()) {
    return lang === 'hi'
      ? 'इस ब्राउज़र में स्पीच आउटपुट उपलब्ध नहीं है। आप लिखित कदम पढ़ सकते हैं।'
      : 'Speech synthesis is unavailable in this browser. Read the steps on screen.';
  }
  const {voice, info} = pickCalmVoice(lang);
  if (!voice || !info) {
    return lang === 'hi'
      ? 'इस डिवाइस में उपयुक्त हिंदी (hi-IN) महिला आवाज़ नहीं मिली—ब्राउज़र की डिफ़ॉल्ट आवाज़ या लिखित गाइड उपयोग होगी।'
      : 'No suitable voice found for this language on this device; browser default voice or on-screen text will be used.';
  }
  if (!info.isFemaleLikely) {
    return lang === 'hi'
      ? `डिवाइस में महिला हिंदी आवाज़ पैक उपलब्ध नहीं होने पर सिस्टम की उपलब्ध आवाज़ (${voice.name}) चल रही है।`
      : `Your browser/OS only provides "${voice.name}"; female voices depend on installed system voice packs.`;
  }
  return null;
}

export function primeSpeechSynthesis(): void {
  if (!isSpeechSynthesisSupported()) return;
  initSpeechVoices();
  try {
    window.speechSynthesis.resume();
    if (!window.speechSynthesis.speaking) {
      const unlockUtterance = new SpeechSynthesisUtterance(' ');
      unlockUtterance.volume = 0;
      unlockUtterance.rate = 2;
      window.speechSynthesis.speak(unlockUtterance);
    }
  } catch {
    // Ignore browser speechSynthesis unlock errors
  }
}

export function stopSpeaking(): void {
  activeUtteranceId += 1;
  lastSpokenSignature = '';
  lastSpokenTimestamp = 0;
  if (activeFallbackTimer !== null) {
    window.clearTimeout(activeFallbackTimer);
    activeFallbackTimer = null;
  }
  if (!isSpeechSynthesisSupported()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    // Ignore
  }
}

export function speakText(
  text: string,
  lang: Language,
  options?: {
    rate?: number;
    pitch?: number;
    allowDuplicate?: boolean;
    bypassMuteCheck?: boolean;
    onStart?: () => void;
    onEnd?: () => void;
    onError?: (reason: string) => void;
  }
): void {
  const cleanText = text.replace(/\s+/g, ' ').trim();
  if (!cleanText) {
    options?.onEnd?.();
    return;
  }

  if (!options?.bypassMuteCheck && !isVoiceOutputEnabled()) {
    options?.onEnd?.();
    return;
  }

  if (!isSpeechSynthesisSupported()) {
    options?.onError?.('Speech synthesis is not supported in this browser.');
    options?.onEnd?.();
    return;
  }

  const now = Date.now();
  const signature = `${lang}:${cleanText}`;
  if (
    !options?.allowDuplicate &&
    signature === lastSpokenSignature &&
    now - lastSpokenTimestamp < 900 &&
    window.speechSynthesis.speaking
  ) {
    return;
  }

  lastSpokenSignature = signature;
  lastSpokenTimestamp = now;
  const utteranceId = ++activeUtteranceId;

  if (activeFallbackTimer !== null) {
    window.clearTimeout(activeFallbackTimer);
    activeFallbackTimer = null;
  }

  let finished = false;
  const finishOnce = (errMsg?: string) => {
    if (finished || utteranceId !== activeUtteranceId) return;
    finished = true;
    if (activeFallbackTimer !== null) {
      window.clearTimeout(activeFallbackTimer);
      activeFallbackTimer = null;
    }
    if (errMsg) {
      options?.onError?.(errMsg);
    }
    options?.onEnd?.();
  };

  const startUtterance = () => {
    if (utteranceId !== activeUtteranceId) return;
    try {
      window.speechSynthesis.cancel();
      window.speechSynthesis.resume();

      const utterance = new SpeechSynthesisUtterance(cleanText);
      utterance.lang = lang === 'hi' ? 'hi-IN' : 'en-IN';
      // Calm, steady emergency pacing and slightly softer pitch
      utterance.rate = options?.rate ?? 0.93;
      utterance.pitch = options?.pitch ?? 1.04;

      const {voice} = pickCalmVoice(lang);
      if (voice) {
        utterance.voice = voice;
      }

      let started = false;
      utterance.onstart = () => {
        if (utteranceId !== activeUtteranceId) return;
        started = true;
        options?.onStart?.();
      };

      utterance.onend = () => {
        finishOnce();
      };

      utterance.onerror = (ev) => {
        const errCode = (ev as SpeechSynthesisErrorEvent | undefined)?.error;
        if (errCode === 'interrupted' || errCode === 'canceled') {
          finishOnce();
          return;
        }
        finishOnce(
          errCode ? `Speech output error (${errCode})` : 'Speech output error'
        );
      };

      const estDurationMs = Math.min(26000, Math.max(4500, cleanText.length * 100));
      activeFallbackTimer = window.setTimeout(() => {
        if (!started || window.speechSynthesis.speaking === false) {
          finishOnce();
        }
      }, estDurationMs);

      window.speechSynthesis.speak(utterance);
    } catch (err) {
      finishOnce(
        err instanceof Error ? err.message : 'Speech synthesis failed'
      );
    }
  };

  initSpeechVoices();
  const available = refreshVoiceCache();
  if (available.length === 0) {
    window.setTimeout(startUtterance, 140);
  } else {
    startUtterance();
  }
}

export function formatSpeechRecognitionError(
  errorCode: string | undefined,
  lang: Language,
  context: {isOnline?: boolean} = {}
): string {
  const isOnline =
    context.isOnline ??
    (typeof navigator === 'undefined' ? undefined : navigator.onLine);

  switch (errorCode) {
    case 'not-allowed':
      return lang === 'hi'
        ? 'माइक्रोफोन की अनुमति बंद है (not-allowed)। चालू करने के कदम: 1) ब्राउज़र में लॉक/सेटिंग आइकन दबाएं, 2) Microphone को Allow करें, 3) पेज रीलोड करके फिर बोलें या नीचे लिखें।'
        : 'Microphone permission denied (not-allowed). To enable mic: 1) Click the lock/site-settings icon in the address bar, 2) Set Microphone to Allow, 3) Reload and tap Speak — or type below.';
    case 'service-not-allowed':
      return lang === 'hi'
        ? 'इस डिवाइस या प्रीव्यू में वॉइस सेवा की अनुमति नहीं है (service-not-allowed)। कृपया ऐप को नए टैब में खोलें या नीचे लिखें।'
        : 'Speech recognition is blocked in this preview/browser (service-not-allowed). Open in a new tab or type below.';
    case 'no-speech':
      return lang === 'hi'
        ? 'आवाज़ सुनाई नहीं दी (no-speech)। कृपया फिर बोलें या नीचे हिंदी/हिंग्लिश में लिखें।'
        : 'No speech detected (no-speech). Tap Retry and speak closer to the mic, or type below.';
    case 'audio-capture':
      return lang === 'hi'
        ? 'माइक्रोफोन नहीं मिला या किसी दूसरे ऐप में व्यस्त है (audio-capture)। कृपया माइक जांचें या नीचे लिखें।'
        : 'No microphone available (audio-capture). Check that your mic is connected and not used by another app, or type below.';
    case 'network':
      if (isOnline === false) {
        return lang === 'hi'
          ? 'आप ऑफ़लाइन हैं और इस डिवाइस पर हिंदी वॉइस पहचान इंजन उपलब्ध नहीं है। ऑफ़लाइन बोलकर लिखने के लिए डिवाइस में हिंदी स्पीच इंजन इंस्टॉल होना चाहिए। इंटरनेट जुड़ने पर फिर कोशिश करें या नीचे टाइप करें।'
          : 'You are offline and this device has no available speech-recognition engine. Offline dictation requires a locally installed speech engine. Reconnect and retry, or type below.';
      }
      return lang === 'hi'
        ? 'ब्राउज़र की वॉइस पहचान सेवा से संपर्क नहीं हो पाया (network)। इंटरनेट चलने पर भी एम्बेडेड ब्राउज़र या स्पीच सेवा के कारण ऐसा हो सकता है। ऐप को Chrome या Safari में खोलकर फिर कोशिश करें, या नीचे टाइप करें। ऑफ़लाइन बोलकर लिखने के लिए डिवाइस में स्थानीय स्पीच इंजन चाहिए।'
        : 'The browser speech-recognition service could not connect (network). This can happen even when your internet works, for example when an embedded browser or its speech service blocks recognition. Try opening Rakshak in Chrome or Safari, or type below. Offline dictation requires a speech engine installed on the device.';
    case 'insecure-context':
      return lang === 'hi'
        ? 'इस पेज को माइक्रोफोन उपयोग करने के लिए सुरक्षित कनेक्शन (HTTPS या localhost) चाहिए। सुरक्षित पते से खोलें या नीचे टाइप करें।'
        : 'Microphone access requires a secure page (HTTPS or localhost). Open the secure address or type below.';
    case 'language-not-supported':
    case 'language-unavailable':
      return lang === 'hi'
        ? 'इस ब्राउज़र में यह वॉइस भाषा समर्थित नहीं है (language-not-supported)। कृपया नीचे लिखकर बताएं।'
        : 'Selected speech language is unavailable in this browser (language-not-supported). Please type below.';
    case 'unsupported':
      return lang === 'hi'
        ? 'इस ब्राउज़र में वॉइस पहचान समर्थित नहीं है। कृपया Chrome उपयोग करें (Use Chrome) या नीचे लिखें।'
        : 'Voice recognition is not supported in this browser. Use Chrome, or type below.';
    case 'unexpected-end':
      return lang === 'hi'
        ? 'माइक्रोफोन सत्र बंद हो गया। फिर बोलने के लिए Retry दबाएं या नीचे लिखें।'
        : 'Voice session ended before speech was captured. Tap Retry or type below.';
    case 'aborted':
      return lang === 'hi'
        ? 'ब्राउज़र ने वॉइस सुनना रोक दिया (aborted)। कृपया Retry दबाएं या नीचे लिखें।'
        : 'Voice listening was interrupted (aborted). Tap Retry or type what happened below.';
    default:
      return lang === 'hi'
        ? 'वॉइस इनपुट शुरू नहीं हो सका। कृपया Retry दबाएं या नीचे लिखें।'
        : 'Could not start voice input. Tap Retry or type below.';
  }
}
