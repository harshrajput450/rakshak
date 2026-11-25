import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SpeechRecognitionController,
  type SpeechControllerSnapshot,
} from '../lib/speechController.ts';
import {
  type BrowserSpeechRecognition,
  type SpeechRecognitionResultEventLike,
  extractSpeechResultSegments,
  formatSpeechRecognitionError,
  getRecognitionLanguage,
} from '../lib/voice.ts';

class MockSpeechRecognition implements BrowserSpeechRecognition {
  static instances: MockSpeechRecognition[] = [];

  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;

  onstart: (() => void) | null = null;
  onspeechstart: (() => void) | null = null;
  onspeechend: (() => void) | null = null;
  onresult: ((e: SpeechRecognitionResultEventLike) => void) | null = null;
  onerror: ((e: {error?: string; message?: string}) => void) | null = null;
  onnomatch: (() => void) | null = null;
  onend: (() => void) | null = null;

  startCount = 0;
  stopCount = 0;
  abortCount = 0;
  active = false;
  langHistory: string[] = [];
  failLanguageCodes = new Set<string>();

  constructor() {
    MockSpeechRecognition.instances.push(this);
  }

  start(): void {
    if (this.active) {
      const err = new Error('recognition has already started');
      err.name = 'InvalidStateError';
      throw err;
    }
    this.startCount += 1;
    this.langHistory.push(this.lang);
    if (this.failLanguageCodes.has(this.lang)) {
      this.active = false;
      this.onerror?.({error: 'language-not-supported'});
      this.onend?.();
      return;
    }
    this.active = true;
    this.onstart?.();
  }

  stop(): void {
    this.stopCount += 1;
    if (!this.active) return;
    this.active = false;
    this.onend?.();
  }

  abort(): void {
    this.abortCount += 1;
    if (!this.active) return;
    this.active = false;
    this.onerror?.({error: 'aborted'});
    this.onend?.();
  }

  emitResult(segments: Array<{transcript: string; isFinal: boolean}>): void {
    const list = segments.map((seg) =>
      Object.assign([{transcript: seg.transcript}], {
        isFinal: seg.isFinal,
      })
    );
    this.onresult?.({
      resultIndex: 0,
      results: list,
    });
  }

  emitNaturalEnd(): void {
    this.active = false;
    this.onend?.();
  }

  emitErrorAndEnd(code: string): void {
    this.onerror?.({error: code});
    this.active = false;
    this.onend?.();
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createHarness(options?: {
  initialLang?: 'hi' | 'en';
  initialInputLang?: 'hi' | 'hinglish' | 'en';
  silenceMs?: number;
  supported?: boolean;
  onSubmit?: (text: string) => Promise<boolean>;
}) {
  MockSpeechRecognition.instances = [];
  const submitted: string[] = [];
  let focusCalls = 0;
  let latestSnapshot: SpeechControllerSnapshot | null = null;

  const controller = new SpeechRecognitionController({
    initialLang: options?.initialLang ?? 'hi',
    initialInputLang: options?.initialInputLang ?? options?.initialLang ?? 'hi',
    silenceAutoSendMs: options?.silenceMs ?? 80,
    getConstructor: () =>
      options?.supported === false
        ? null
        : (MockSpeechRecognition as unknown as new () => BrowserSpeechRecognition),
    isTtsSpeaking: () => false,
    stopTts: () => {},
    isPageHidden: () => false,
    onStateChange: (snap) => {
      latestSnapshot = snap;
    },
    onFocusTextBox: () => {
      focusCalls += 1;
    },
    onSubmitFinalized: async (text) => {
      submitted.push(text);
      if (options?.onSubmit) {
        return options.onSubmit(text);
      }
      return true;
    },
  });

  latestSnapshot = controller.getSnapshot();

  return {
    controller,
    submitted,
    getFocusCalls: () => focusCalls,
    getSnapshot: () => latestSnapshot!,
    getInstance: () => MockSpeechRecognition.instances[0] ?? null,
    getInstanceCount: () => MockSpeechRecognition.instances.length,
  };
}

test('1. Single SpeechRecognition instance with continuous=false, interimResults=true, maxAlternatives=3, and double-tap guard', () => {
  const h = createHarness({initialLang: 'hi'});
  h.controller.toggle();

  assert.equal(h.getInstanceCount(), 1);
  const rec = h.getInstance()!;
  assert.equal(rec.lang, 'hi-IN');
  assert.equal(rec.continuous, false);
  assert.equal(rec.interimResults, true);
  assert.equal(rec.maxAlternatives, 3);
  assert.equal(rec.startCount, 1);
  assert.equal(h.getSnapshot().speechState, 'listening');
  assert.equal(h.getSnapshot().micError, '');

  // Immediate double-tap while listening must be ignored without stopping/aborting
  h.controller.toggle();
  assert.equal(h.getInstanceCount(), 1);
  assert.equal(rec.stopCount, 0);
  assert.equal(rec.abortCount, 0);
  assert.equal(h.getSnapshot().speechState, 'listening');

  h.controller.dispose();
});

test('2. Short Hindi words (ले, हाँ, नहीं) and phrases are captured and auto-submitted cleanly', async () => {
  const phrases = [
    'ले',
    'हाँ',
    'नहीं',
    'मुझे मदद चाहिए',
    'सांस लेने में दिक्कत है',
  ];

  for (const phrase of phrases) {
    const h = createHarness({initialLang: 'hi', silenceMs: 40});
    h.controller.startUserSession();
    const rec = h.getInstance()!;

    rec.emitResult([{transcript: phrase, isFinal: false}]);
    assert.equal(h.getSnapshot().transcript, phrase);

    rec.emitNaturalEnd();
    assert.equal(h.getSnapshot().speechState, 'idle');
    assert.equal(h.getSnapshot().micError, '');
    assert.equal(h.getSnapshot().transcript, phrase);

    await wait(70);
    assert.deepEqual(h.submitted, [phrase]);
    h.controller.dispose();
  }
});

test('3. Auto-retries once after 400ms on aborted and no-speech, then focuses fallback text box on second failure', async () => {
  const hAbort = createHarness({initialLang: 'hi'});
  hAbort.controller.startUserSession();
  const recAbort = hAbort.getInstance()!;

  recAbort.emitErrorAndEnd('aborted'); // failure #1 -> should retry after 400ms
  assert.equal(hAbort.getSnapshot().micError, '');
  await wait(300);
  assert.equal(recAbort.startCount, 1);
  await wait(160); // > 400ms total
  assert.equal(recAbort.startCount, 2);

  recAbort.emitErrorAndEnd('aborted'); // failure #2 -> friendly error + focus fallback textarea
  assert.equal(hAbort.getSnapshot().speechState, 'error');
  assert.equal(hAbort.getSnapshot().lastErrorCode, 'aborted');
  assert.ok(hAbort.getSnapshot().micError.length > 0);
  assert.equal(hAbort.getFocusCalls(), 1);
  await wait(450);
  assert.equal(recAbort.startCount, 2);
  hAbort.controller.dispose();

  const hNoSpeech = createHarness({initialLang: 'hi'});
  hNoSpeech.controller.startUserSession();
  const recNoSpeech = hNoSpeech.getInstance()!;

  recNoSpeech.emitErrorAndEnd('no-speech'); // #1
  await wait(450);
  assert.equal(recNoSpeech.startCount, 2);

  recNoSpeech.emitErrorAndEnd('no-speech'); // #2
  assert.equal(hNoSpeech.getSnapshot().speechState, 'error');
  assert.equal(hNoSpeech.getSnapshot().lastErrorCode, 'no-speech');
  assert.equal(hNoSpeech.getFocusCalls(), 1);
  hNoSpeech.controller.dispose();
});

test('4. Language-not-supported on hi-IN falls back cleanly to en-IN', async () => {
  const h = createHarness({initialLang: 'hi'});
  // Prime instance so we can configure it to reject hi-IN
  h.controller.startUserSession();
  const rec = h.getInstance()!;
  rec.stop();

  rec.failLanguageCodes.add('hi-IN');
  h.controller.retry();

  assert.deepEqual(rec.langHistory.slice(-1), ['hi-IN']);
  assert.equal(h.getSnapshot().activeRecLang, 'en-IN');

  await wait(450);
  assert.deepEqual(rec.langHistory.slice(-1), ['en-IN']);
  assert.equal(h.getSnapshot().speechState, 'listening');
  h.controller.dispose();
});

test('5. Language toggle maps Hindi/Hinglish->hi-IN and English->en-IN without calling abort()', () => {
  assert.equal(getRecognitionLanguage('hi'), 'hi-IN');
  assert.equal(getRecognitionLanguage('hinglish'), 'hi-IN');
  assert.equal(getRecognitionLanguage('en'), 'en-IN');

  const h = createHarness({initialLang: 'hi'});
  h.controller.startUserSession();
  const rec = h.getInstance()!;

  rec.emitResult([{transcript: 'ले', isFinal: true}]);
  h.controller.setInputVoiceLanguage('en');

  assert.equal(rec.abortCount, 0);
  assert.equal(h.getSnapshot().activeRecLang, 'en-IN');
  assert.equal(h.getSnapshot().transcript, 'ले');

  h.controller.dispose();
});

test('6. Specific errors (not-allowed, audio-capture, network, unsupported) show actionable guidance', () => {
  const msgUnsupported = formatSpeechRecognitionError('unsupported', 'en');
  assert.ok(msgUnsupported.includes('Use Chrome'));

  const msgNotAllowed = formatSpeechRecognitionError('not-allowed', 'en');
  assert.ok(msgNotAllowed.toLowerCase().includes('microphone'));
  const onlineNetworkError = formatSpeechRecognitionError('network', 'hi', {
    isOnline: true,
  });
  assert.ok(onlineNetworkError.includes('इंटरनेट चलने पर भी'));
  assert.ok(onlineNetworkError.includes('Chrome या Safari'));
  assert.ok(!onlineNetworkError.includes('इंटरनेट जांचें'));
  const offlineNetworkError = formatSpeechRecognitionError('network', 'en', {
    isOnline: false,
  });
  assert.ok(offlineNetworkError.includes('locally installed speech engine'));

  const insecureContextError = formatSpeechRecognitionError(
    'insecure-context',
    'en'
  );
  assert.ok(insecureContextError.includes('HTTPS or localhost'));

  const hUnsupported = createHarness({initialLang: 'en', supported: false});
  hUnsupported.controller.startUserSession();
  assert.equal(hUnsupported.getSnapshot().speechState, 'error');
  assert.ok(hUnsupported.getSnapshot().micError.includes('Use Chrome'));
  assert.equal(hUnsupported.getFocusCalls(), 1);
  hUnsupported.controller.dispose();

  const hPerm = createHarness({initialLang: 'hi'});
  hPerm.controller.startUserSession();
  const rec = hPerm.getInstance()!;
  rec.emitErrorAndEnd('not-allowed');
  assert.equal(hPerm.getSnapshot().speechState, 'error');
  assert.equal(hPerm.getSnapshot().lastErrorCode, 'not-allowed');
  assert.equal(hPerm.getFocusCalls(), 1);
  hPerm.controller.dispose();

  const hNetwork = createHarness({initialLang: 'hi'});
  hNetwork.controller.startUserSession();
  hNetwork.getInstance()!.emitErrorAndEnd('network');
  assert.equal(hNetwork.getSnapshot().lastErrorCode, 'network');
  assert.ok(hNetwork.getSnapshot().micError.includes('इंटरनेट चलने पर भी'));
  hNetwork.controller.dispose();

  // Overlapping Chrome Android segments deduplicate properly
  const extracted = extractSpeechResultSegments(
    [
      Object.assign([{transcript: 'मुझे मदद'}], {isFinal: true}),
      Object.assign([{transcript: 'मुझे मदद चाहिए'}], {isFinal: true}),
    ],
    3
  );
  assert.equal(extracted.finalText, 'मुझे मदद चाहिए');
});
