import {evaluateSpeechForAutoSend, SILENCE_AUTO_SEND_MS} from './autoSend';
import {
  type BrowserSpeechRecognition,
  type SpeechRecognitionCtor,
  extractSpeechResultSegments,
  formatSpeechRecognitionError,
  getRecognitionLanguage,
  getSpeechRecognitionConstructor,
  isSpeechRecognitionSupported,
  isSpeechSynthesisSpeaking,
  joinTranscriptParts,
  logVoiceLifecycle,
  stopSpeaking,
} from './voice';
import type {InputVoiceLanguage, Language} from '../src/types/emergency';

export type SpeechUiState = 'idle' | 'listening' | 'processing' | 'error';

type EngineState = 'idle' | 'starting' | 'listening' | 'stopping';
type StopIntent = 'none' | 'manual' | 'restart_after_stop' | 'unmount' | 'fatal_error';

const MAX_RETRIES_ABORTS = 1;
const MAX_RETRIES_NO_SPEECH = 1;
const RETRY_DELAY_MS = 400;
const DOUBLE_TAP_GUARD_MS = 450;
const TTS_YIELD_DELAY_MS = 150;
const STOP_FLUSH_TIMEOUT_MS = 800;

const FATAL_ERRORS = new Set([
  'not-allowed',
  'service-not-allowed',
  'audio-capture',
  'network',
]);

export interface SpeechControllerSnapshot {
  speechState: SpeechUiState;
  transcript: string;
  interimPreview: string;
  micError: string;
  lastErrorCode: string | null;
  inputVoiceLang: InputVoiceLanguage;
  activeRecLang: 'hi-IN' | 'en-IN';
  autoSendRemainingMs: number | null;
  speechSupported: boolean;
}

export interface SpeechControllerOptions {
  initialLang: Language;
  initialInputLang?: InputVoiceLanguage;
  autoSendEnabled?: boolean;
  silenceAutoSendMs?: number;
  getConstructor?: () => SpeechRecognitionCtor | null;
  isTtsSpeaking?: () => boolean;
  stopTts?: () => void;
  isPageHidden?: () => boolean;
  onStateChange: (snapshot: SpeechControllerSnapshot) => void;
  onSubmitFinalized: (text: string) => Promise<boolean>;
  onSubmissionSucceeded?: () => void;
  onFocusTextBox?: () => void;
}

export class SpeechRecognitionController {
  private uiLang: Language;
  private inputVoiceLang: InputVoiceLanguage;
  private recLangOverride: 'hi-IN' | 'en-IN' | null = null;
  private autoSendEnabled: boolean;
  private readonly silenceMs: number;
  private readonly getCtor: () => SpeechRecognitionCtor | null;
  private readonly isTtsSpeaking: () => boolean;
  private readonly stopTts: () => void;
  private readonly isPageHidden: () => boolean;
  private readonly onStateChange: (s: SpeechControllerSnapshot) => void;
  private readonly onSubmitFinalized: (text: string) => Promise<boolean>;
  private readonly onSubmissionSucceeded?: () => void;
  private readonly onFocusTextBox?: () => void;

  // Single controlled recognition instance kept for the controller lifetime
  private recognition: BrowserSpeechRecognition | null = null;
  private engineState: EngineState = 'idle';
  private uiState: SpeechUiState = 'idle';
  private stopIntent: StopIntent = 'none';
  private wantsListening = false;
  private pendingStartAfterStop = false;
  private disposed = false;
  private lastUserTapAt = 0;

  private baseTranscript = '';
  private sessionFinal = '';
  private sessionInterim = '';
  private interimPreview = '';
  private transcript = '';
  private micError = '';
  private lastErrorCode: string | null = null;
  private autoSendRemainingMs: number | null = null;

  private sessionHadSpeech = false;
  private hadErrorInCurrentRun: string | null = null;
  private consecutiveAborts = 0;
  private consecutiveNoSpeech = 0;
  private triedEnFallback = false;

  private isSubmitting = false;
  private attachmentKey = '';
  private lastSubmittedKey = '';
  private silencePendingKey = '';

  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private countdownInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options: SpeechControllerOptions) {
    this.uiLang = options.initialLang;
    this.inputVoiceLang = options.initialInputLang ?? options.initialLang;
    this.autoSendEnabled = options.autoSendEnabled ?? true;
    this.silenceMs = options.silenceAutoSendMs ?? SILENCE_AUTO_SEND_MS;
    this.getCtor = options.getConstructor ?? getSpeechRecognitionConstructor;
    this.isTtsSpeaking = options.isTtsSpeaking ?? isSpeechSynthesisSpeaking;
    this.stopTts = options.stopTts ?? stopSpeaking;
    this.isPageHidden =
      options.isPageHidden ??
      (() =>
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden');
    this.onStateChange = options.onStateChange;
    this.onSubmitFinalized = options.onSubmitFinalized;
    this.onSubmissionSucceeded = options.onSubmissionSucceeded;
    this.onFocusTextBox = options.onFocusTextBox;
  }

  private getEffectiveRecLang(): 'hi-IN' | 'en-IN' {
    if (this.recLangOverride) return this.recLangOverride;
    return getRecognitionLanguage(this.inputVoiceLang);
  }

  getSnapshot(): SpeechControllerSnapshot {
    return {
      speechState: this.uiState,
      transcript: this.transcript,
      interimPreview: this.interimPreview,
      micError: this.micError,
      lastErrorCode: this.lastErrorCode,
      inputVoiceLang: this.inputVoiceLang,
      activeRecLang: this.getEffectiveRecLang(),
      autoSendRemainingMs: this.autoSendRemainingMs,
      speechSupported:
        this.getCtor !== getSpeechRecognitionConstructor
          ? this.getCtor() !== null
          : isSpeechRecognitionSupported(),
    };
  }

  private emit(): void {
    if (this.disposed) return;
    this.onStateChange(this.getSnapshot());
  }

  setExternalSubmitting(submitting: boolean): void {
    this.isSubmitting = submitting;
  }

  setAttachmentKey(key: string): void {
    if (this.attachmentKey !== key) {
      this.attachmentKey = key;
      this.lastSubmittedKey = '';
      this.clearSilenceTimer();
    }
  }

  setTranscriptFromUser(val: string): void {
    this.clearSilenceTimer();
    this.baseTranscript = val;
    this.sessionFinal = '';
    this.sessionInterim = '';
    this.interimPreview = '';
    this.transcript = val;
    this.lastSubmittedKey = '';
    this.emit();
  }

  clearTranscript(): void {
    this.clearSilenceTimer();
    this.baseTranscript = '';
    this.sessionFinal = '';
    this.sessionInterim = '';
    this.interimPreview = '';
    this.transcript = '';
    this.lastSubmittedKey = '';
    this.emit();
  }

  clearSilenceTimer(): void {
    let changed = false;
    if (this.silenceTimer !== null) {
      globalThis.clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (this.countdownInterval !== null) {
      globalThis.clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
    this.silencePendingKey = '';
    if (this.autoSendRemainingMs !== null) {
      this.autoSendRemainingMs = null;
      changed = true;
    }
    if (changed) {
      this.emit();
    }
  }

  private clearLifecycleTimers(): void {
    if (this.restartTimer !== null) {
      globalThis.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.stopFlushTimer !== null) {
      globalThis.clearTimeout(this.stopFlushTimer);
      this.stopFlushTimer = null;
    }
  }

  private commitSessionTranscript(): string {
    const activePart = joinTranscriptParts(
      this.sessionFinal,
      this.sessionInterim
    );
    const merged = joinTranscriptParts(this.baseTranscript, activePart);
    this.baseTranscript = merged;
    this.sessionFinal = '';
    this.sessionInterim = '';
    this.interimPreview = '';
    this.transcript = merged;
    return merged;
  }

  private ensureRecognitionInstance(): BrowserSpeechRecognition | null {
    if (this.recognition) {
      return this.recognition;
    }
    const SR = this.getCtor();
    if (!SR) {
      return null;
    }
    const rec = new SR();
    rec.onstart = () => this.handleOnStart(rec);
    rec.onspeechstart = () => this.handleOnSpeechStart(rec);
    rec.onspeechend = () => this.handleOnSpeechEnd(rec);
    rec.onresult = (ev) => this.handleOnResult(rec, ev);
    rec.onerror = (ev) => this.handleOnError(rec, ev);
    rec.onend = () => this.handleOnEnd(rec);
    this.recognition = rec;
    logVoiceLifecycle('instance_created', {
      lang: this.getEffectiveRecLang(),
    });
    return rec;
  }

  private configureInstanceForLanguage(rec: BrowserSpeechRecognition): void {
    rec.lang = this.getEffectiveRecLang();
    try {
      rec.continuous = false;
    } catch {
      // Ignore if browser treats continuous as readonly
    }
    rec.interimResults = true;
    try {
      rec.maxAlternatives = 3;
    } catch {
      // Ignore if unsupported
    }
  }

  /**
   * Direct user button click handler.
   * Ignores rapid double taps while listening/starting so an accidental second tap
   * never aborts a newly started session.
   */
  toggle(): void {
    const now = Date.now();
    if (
      (this.engineState === 'starting' || this.engineState === 'listening') &&
      now - this.lastUserTapAt < DOUBLE_TAP_GUARD_MS
    ) {
      // Ignore double tap while listening
      return;
    }

    if (
      this.uiState === 'listening' ||
      this.uiState === 'processing' ||
      this.engineState === 'starting' ||
      this.engineState === 'listening'
    ) {
      this.stopManual();
      return;
    }

    this.lastUserTapAt = now;
    this.startUserSession();
  }

  startUserSession(): void {
    // Ignore duplicate start calls while already starting or listening
    if (
      this.engineState === 'starting' ||
      this.engineState === 'listening'
    ) {
      return;
    }
    this.lastUserTapAt = Date.now();
    this.consecutiveAborts = 0;
    this.consecutiveNoSpeech = 0;
    this.triedEnFallback = false;
    this.recLangOverride = null;
    this.lastSubmittedKey = '';
    this.micError = '';
    this.lastErrorCode = null;
    this.startInternal(false);
  }

  retry(): void {
    if (
      this.engineState === 'starting' ||
      this.engineState === 'listening'
    ) {
      return;
    }
    this.lastUserTapAt = Date.now();
    this.consecutiveAborts = 0;
    this.consecutiveNoSpeech = 0;
    this.triedEnFallback = false;
    this.recLangOverride = null;
    this.lastSubmittedKey = '';
    this.micError = '';
    this.lastErrorCode = null;
    this.startInternal(false);
  }

  private startInternal(isAutoRetry: boolean): void {
    if (this.disposed) return;

    const rec = this.ensureRecognitionInstance();
    if (!rec) {
      this.wantsListening = false;
      this.pendingStartAfterStop = false;
      this.stopIntent = 'none';
      this.engineState = 'idle';
      this.uiState = 'error';
      this.lastErrorCode = 'unsupported';
      this.micError = formatSpeechRecognitionError('unsupported', this.uiLang);
      logVoiceLifecycle('unsupported', {lang: this.getEffectiveRecLang()});
      this.emit();
      this.onFocusTextBox?.();
      return;
    }

    if (this.restartTimer !== null) {
      globalThis.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    this.wantsListening = true;
    this.stopIntent = 'none';

    // If an existing session is active, call stop() and wait for onend before calling start()
    if (this.engineState === 'starting' || this.engineState === 'listening') {
      this.pendingStartAfterStop = true;
      this.stopIntent = 'restart_after_stop';
      this.engineState = 'stopping';
      try {
        rec.stop();
      } catch {
        this.engineState = 'idle';
        this.stopIntent = 'none';
        this.pendingStartAfterStop = false;
      }
      this.emit();
      return;
    }

    if (this.engineState === 'stopping') {
      this.pendingStartAfterStop = true;
      this.stopIntent = 'restart_after_stop';
      this.uiState = 'listening';
      this.emit();
      return;
    }

    if (!isAutoRetry && this.isTtsSpeaking()) {
      this.stopTts();
      this.uiState = 'listening';
      this.emit();
      this.restartTimer = globalThis.setTimeout(() => {
        this.restartTimer = null;
        if (this.wantsListening && !this.disposed) {
          this.startInternal(false);
        }
      }, TTS_YIELD_DELAY_MS);
      return;
    }

    this.pendingStartAfterStop = false;
    this.hadErrorInCurrentRun = null;
    this.sessionFinal = '';
    this.sessionInterim = '';
    this.sessionHadSpeech = false;
    this.interimPreview = '';
    this.micError = '';
    this.lastErrorCode = null;
    this.uiState = 'listening';
    this.engineState = 'starting';
    this.configureInstanceForLanguage(rec);
    this.emit();

    try {
      logVoiceLifecycle('start_call', {
        lang: rec.lang,
        isAutoRetry,
      });
      rec.start();
    } catch (err) {
      const errName = err instanceof Error ? err.name : '';
      const errMsg = err instanceof Error ? err.message : String(err);
      logVoiceLifecycle('start_exception', {
        errName,
        lang: rec.lang,
        isAutoRetry,
      });

      // If browser reports InvalidStateError (already started), call stop() and wait for onend once
      if (
        (errName === 'InvalidStateError' || /already started/i.test(errMsg)) &&
        this.consecutiveAborts < MAX_RETRIES_ABORTS
      ) {
        this.consecutiveAborts += 1;
        this.pendingStartAfterStop = true;
        this.stopIntent = 'restart_after_stop';
        this.engineState = 'stopping';
        try {
          rec.stop();
        } catch {
          this.engineState = 'idle';
          this.stopIntent = 'none';
          this.pendingStartAfterStop = false;
          this.restartTimer = globalThis.setTimeout(() => {
            this.restartTimer = null;
            if (this.wantsListening && !this.disposed) {
              this.startInternal(true);
            }
          }, RETRY_DELAY_MS);
        }
        return;
      }

      this.wantsListening = false;
      this.pendingStartAfterStop = false;
      this.engineState = 'idle';
      this.uiState = 'error';
      const startErrorCode =
        errName === 'NotAllowedError'
          ? 'not-allowed'
          : errName === 'SecurityError'
          ? 'insecure-context'
          : errName === 'NotFoundError' || errName === 'NotReadableError'
          ? 'audio-capture'
          : 'start-failed';
      this.lastErrorCode = startErrorCode;
      this.micError = formatSpeechRecognitionError(
        startErrorCode,
        this.uiLang
      );
      this.emit();
      this.onFocusTextBox?.();
    }
  }

  stopManual(): void {
    this.wantsListening = false;
    this.pendingStartAfterStop = false;
    this.clearLifecycleTimers();
    this.clearSilenceTimer();

    if (this.engineState === 'idle') {
      this.stopIntent = 'none';
      this.commitSessionTranscript();
      this.uiState = 'idle';
      this.emit();
      return;
    }

    this.stopIntent = 'manual';
    this.engineState = 'stopping';
    this.uiState = 'processing';
    this.emit();

    const rec = this.recognition;
    if (!rec) {
      this.engineState = 'idle';
      this.stopIntent = 'none';
      this.commitSessionTranscript();
      this.uiState = 'idle';
      this.emit();
      return;
    }

    try {
      logVoiceLifecycle('stop_manual', {lang: this.getEffectiveRecLang()});
      rec.stop();
    } catch {
      this.engineState = 'idle';
      this.stopIntent = 'none';
      this.commitSessionTranscript();
      this.uiState = 'idle';
      this.emit();
      return;
    }

    // Never call abort() on stop; wait cleanly and fall back to idle state if browser onend never arrives
    this.stopFlushTimer = globalThis.setTimeout(() => {
      this.stopFlushTimer = null;
      if (this.engineState === 'stopping' && !this.disposed) {
        this.engineState = 'idle';
        this.stopIntent = 'none';
        this.commitSessionTranscript();
        this.uiState = 'idle';
        this.emit();
      }
    }, STOP_FLUSH_TIMEOUT_MS);
  }

  /**
   * Updates UI / recognition language WITHOUT calling abort() or interrupting active state.
   * Language takes effect immediately on state display and on the next user-initiated start().
   */
  setLanguage(nextUiLang: Language, nextInputLang?: InputVoiceLanguage): void {
    const targetInputLang = nextInputLang ?? this.inputVoiceLang;
    const changed =
      this.uiLang !== nextUiLang || this.inputVoiceLang !== targetInputLang;
    this.uiLang = nextUiLang;
    this.inputVoiceLang = targetInputLang;
    this.recLangOverride = null;
    if (!changed) return;

    logVoiceLifecycle('language_change', {
      uiLang: nextUiLang,
      inputVoiceLang: targetInputLang,
      effectiveRecLang: this.getEffectiveRecLang(),
    });
    this.emit();
  }

  setInputVoiceLanguage(nextInputLang: InputVoiceLanguage): void {
    this.inputVoiceLang = nextInputLang;
    this.recLangOverride = null;
    this.triedEnFallback = false;
    logVoiceLifecycle('input_voice_language_change', {
      inputVoiceLang: nextInputLang,
      effectiveRecLang: this.getEffectiveRecLang(),
    });
    this.emit();
  }

  async submitCurrentOrProvided(rawText?: string): Promise<boolean> {
    const textToSend = (
      rawText ??
      joinTranscriptParts(
        this.baseTranscript,
        this.sessionFinal,
        this.sessionInterim,
        this.transcript
      )
    ).trim();
    return this.executeSubmission(textToSend, {clearSilence: true});
  }

  private async executeSubmission(
    rawText: string,
    options?: {clearSilence?: boolean}
  ): Promise<boolean> {
    const cleaned = rawText.replace(/\s+/g, ' ').trim();
    if (!cleaned && !this.attachmentKey) return false;
    if (this.isSubmitting) return false;

    const payloadKey = `${cleaned}::${this.attachmentKey}`;
    if (payloadKey === this.lastSubmittedKey) {
      return false;
    }

    if (options?.clearSilence !== false) {
      this.clearSilenceTimer();
    }

    this.lastSubmittedKey = payloadKey;
    this.isSubmitting = true;

    let succeeded = false;
    try {
      succeeded = await this.onSubmitFinalized(cleaned);
    } catch {
      succeeded = false;
    } finally {
      this.isSubmitting = false;
    }

    if (succeeded) {
      this.baseTranscript = '';
      this.sessionFinal = '';
      this.sessionInterim = '';
      this.interimPreview = '';
      this.transcript = '';
      this.onSubmissionSucceeded?.();
      this.emit();
    } else {
      this.lastSubmittedKey = '';
      this.emit();
    }
    return succeeded;
  }

  private scheduleSilenceAutoSend(finalCandidateText: string): void {
    const trimmed = finalCandidateText.replace(/\s+/g, ' ').trim();
    if (!this.autoSendEnabled || this.isSubmitting || !trimmed) {
      return;
    }

    const payloadKey = `${trimmed}::${this.attachmentKey}`;
    if (payloadKey === this.lastSubmittedKey) {
      return;
    }

    if (this.silenceTimer !== null && this.silencePendingKey === payloadKey) {
      return;
    }

    this.clearSilenceTimer();
    this.silencePendingKey = payloadKey;
    const startedAt = Date.now();
    this.autoSendRemainingMs = this.silenceMs;
    this.emit();

    this.countdownInterval = globalThis.setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const left = Math.max(0, this.silenceMs - elapsed);
      this.autoSendRemainingMs = left;
      this.emit();
      if (left <= 0 && this.countdownInterval !== null) {
        globalThis.clearInterval(this.countdownInterval);
        this.countdownInterval = null;
      }
    }, 150);

    this.silenceTimer = globalThis.setTimeout(() => {
      this.clearSilenceTimer();
      if (this.sessionInterim.trim().length > 0) return;

      const finalTextToSubmit = joinTranscriptParts(
        this.baseTranscript,
        this.sessionFinal
      );
      if (!finalTextToSubmit) return;

      this.baseTranscript = finalTextToSubmit;
      this.sessionFinal = '';
      void this.executeSubmission(finalTextToSubmit, {clearSilence: false});
    }, this.silenceMs);
  }

  private handleOnStart(rec: BrowserSpeechRecognition): void {
    if (this.disposed || rec !== this.recognition) return;
    this.engineState = 'listening';
    if (this.stopIntent === 'none') {
      this.uiState = 'listening';
      this.micError = '';
      this.lastErrorCode = null;
    }
    logVoiceLifecycle('onstart', {lang: rec.lang});
    this.emit();
  }

  private handleOnSpeechStart(rec: BrowserSpeechRecognition): void {
    if (this.disposed || rec !== this.recognition) return;
    this.consecutiveAborts = 0;
    this.consecutiveNoSpeech = 0;
    this.clearSilenceTimer();
    if (this.stopIntent === 'none') {
      this.uiState = 'listening';
      this.emit();
    }
  }

  private handleOnSpeechEnd(rec: BrowserSpeechRecognition): void {
    if (this.disposed || rec !== this.recognition) return;
    if (
      this.stopIntent === 'none' &&
      this.wantsListening &&
      this.sessionInterim.trim().length > 0
    ) {
      this.uiState = 'processing';
      this.emit();
    }
  }

  private handleOnResult(
    rec: BrowserSpeechRecognition,
    event: Parameters<NonNullable<BrowserSpeechRecognition['onresult']>>[0]
  ): void {
    if (this.disposed || rec !== this.recognition || this.stopIntent === 'unmount') {
      return;
    }
    if (this.isTtsSpeaking()) {
      return;
    }

    const {finalText, interimText} = extractSpeechResultSegments(
      event.results,
      3
    );

    if (event.results.length === 0 || (!finalText && !interimText)) {
      return;
    }

    this.sessionFinal = finalText;
    this.sessionInterim = interimText;
    this.sessionHadSpeech = true;
    this.consecutiveAborts = 0;
    this.consecutiveNoSpeech = 0;
    this.lastSubmittedKey = '';

    const decision = evaluateSpeechForAutoSend({
      baseTranscript: this.baseTranscript,
      sessionFinal: finalText,
      sessionInterim: interimText,
      autoSendEnabled: this.autoSendEnabled,
      isSubmitting: this.isSubmitting,
      lastSubmittedKey: this.lastSubmittedKey,
      attachmentKey: this.attachmentKey,
    });

    this.clearSilenceTimer();

    this.interimPreview = interimText;
    this.transcript = decision.displayTranscript;
    if (this.wantsListening && this.stopIntent === 'none') {
      this.uiState = 'listening';
    }
    this.emit();

    if (decision.shouldScheduleSilenceTimer && this.stopIntent === 'none') {
      this.scheduleSilenceAutoSend(decision.committedFinal);
    }
  }

  private handleOnError(
    rec: BrowserSpeechRecognition,
    ev: {error?: string; message?: string}
  ): void {
    if (this.disposed || rec !== this.recognition) return;
    const code = ev.error || 'unknown';
    logVoiceLifecycle('onerror', {
      code,
      stopIntent: this.stopIntent,
      engineState: this.engineState,
      lang: this.getEffectiveRecLang(),
    });

    this.commitSessionTranscript();

    if (
      this.stopIntent === 'manual' ||
      this.stopIntent === 'restart_after_stop' ||
      this.stopIntent === 'unmount'
    ) {
      return;
    }

    // Try hi-IN first; if it fails with language-not-supported, retry once with en-IN
    if (
      (code === 'language-not-supported' || code === 'language-unavailable') &&
      this.getEffectiveRecLang() === 'hi-IN' &&
      !this.triedEnFallback &&
      this.wantsListening
    ) {
      this.triedEnFallback = true;
      this.recLangOverride = 'en-IN';
      this.hadErrorInCurrentRun = 'lang-fallback-retryable';
      this.emit();
      return;
    }

    if (
      FATAL_ERRORS.has(code) ||
      code === 'language-not-supported' ||
      code === 'language-unavailable'
    ) {
      this.hadErrorInCurrentRun = code;
      this.wantsListening = false;
      this.stopIntent = 'fatal_error';
      this.clearLifecycleTimers();
      this.clearSilenceTimer();
      this.uiState = 'error';
      this.lastErrorCode = code;
      this.micError = formatSpeechRecognitionError(code, this.uiLang);
      this.emit();
      this.onFocusTextBox?.();
      return;
    }

    if (code === 'no-speech') {
      const hasCapturedText =
        this.sessionHadSpeech || this.baseTranscript.trim().length > 0;
      if (hasCapturedText) {
        this.hadErrorInCurrentRun = 'no-speech-after-capture';
        this.wantsListening = false;
        this.stopIntent = 'manual';
        this.uiState = 'idle';
        this.emit();
        return;
      }

      this.consecutiveNoSpeech += 1;
      if (
        this.consecutiveNoSpeech <= MAX_RETRIES_NO_SPEECH &&
        this.wantsListening
      ) {
        this.hadErrorInCurrentRun = 'no-speech-retryable';
        return;
      }

      this.hadErrorInCurrentRun = 'no-speech';
      this.wantsListening = false;
      this.stopIntent = 'fatal_error';
      this.clearLifecycleTimers();
      this.clearSilenceTimer();
      this.uiState = 'error';
      this.lastErrorCode = 'no-speech';
      this.micError = formatSpeechRecognitionError('no-speech', this.uiLang);
      this.emit();
      this.onFocusTextBox?.();
      return;
    }

    if (code === 'aborted') {
      if (this.isPageHidden() || this.isTtsSpeaking()) {
        this.hadErrorInCurrentRun = 'aborted-paused';
        this.wantsListening = false;
        this.stopIntent = 'manual';
        this.uiState = 'idle';
        this.emit();
        return;
      }

      this.consecutiveAborts += 1;
      if (this.consecutiveAborts <= MAX_RETRIES_ABORTS && this.wantsListening) {
        this.hadErrorInCurrentRun = 'aborted-retryable';
        return;
      }

      this.hadErrorInCurrentRun = 'aborted';
      this.wantsListening = false;
      this.stopIntent = 'fatal_error';
      this.clearLifecycleTimers();
      this.clearSilenceTimer();
      this.uiState = 'error';
      this.lastErrorCode = 'aborted';
      this.micError = formatSpeechRecognitionError('aborted', this.uiLang);
      this.emit();
      this.onFocusTextBox?.();
      return;
    }

    this.hadErrorInCurrentRun = code;
    this.wantsListening = false;
    this.stopIntent = 'fatal_error';
    this.clearLifecycleTimers();
    this.clearSilenceTimer();
    this.uiState = 'error';
    this.lastErrorCode = code;
    this.micError = formatSpeechRecognitionError(code, this.uiLang);
    this.emit();
    this.onFocusTextBox?.();
  }

  private handleOnEnd(rec: BrowserSpeechRecognition): void {
    if (this.disposed || rec !== this.recognition) return;
    if (this.stopFlushTimer !== null) {
      globalThis.clearTimeout(this.stopFlushTimer);
      this.stopFlushTimer = null;
    }

    this.engineState = 'idle';
    const capturedThisRun =
      this.sessionHadSpeech ||
      this.sessionFinal.length > 0 ||
      this.sessionInterim.length > 0;
    const mergedCommitted = this.commitSessionTranscript();
    this.sessionHadSpeech = false;

    const intent = this.stopIntent;
    const runErr = this.hadErrorInCurrentRun;
    this.hadErrorInCurrentRun = null;

    logVoiceLifecycle('onend', {
      intent,
      wantsListening: this.wantsListening,
      runErr,
      capturedThisRun,
      lang: this.getEffectiveRecLang(),
    });

    if (intent === 'unmount') {
      return;
    }

    if (intent === 'restart_after_stop' || this.pendingStartAfterStop) {
      this.stopIntent = 'none';
      this.pendingStartAfterStop = false;
      if (this.wantsListening) {
        this.startInternal(false);
      } else {
        this.uiState = 'idle';
        this.emit();
      }
      return;
    }

    if (intent === 'manual') {
      this.stopIntent = 'none';
      this.uiState = 'idle';
      this.emit();
      return;
    }

    if (intent === 'fatal_error') {
      this.stopIntent = 'none';
      this.emit();
      return;
    }

    if (
      runErr === 'aborted-retryable' ||
      runErr === 'no-speech-retryable' ||
      runErr === 'lang-fallback-retryable'
    ) {
      if (this.wantsListening) {
        this.restartTimer = globalThis.setTimeout(() => {
          this.restartTimer = null;
          if (this.wantsListening && !this.disposed) {
            this.startInternal(true);
          }
        }, RETRY_DELAY_MS);
      } else {
        this.uiState = 'idle';
        this.emit();
      }
      return;
    }

    if (
      runErr &&
      runErr !== 'no-speech-after-capture' &&
      runErr !== 'aborted-paused'
    ) {
      return;
    }

    // Normal single-utterance completion (continuous = false): commit cleanly without restarting in a loop
    this.wantsListening = false;
    if (
      capturedThisRun &&
      mergedCommitted &&
      this.autoSendEnabled &&
      !this.isSubmitting
    ) {
      this.scheduleSilenceAutoSend(mergedCommitted);
    }
    this.uiState = 'idle';
    this.emit();
  }

  dispose(): void {
    this.disposed = true;
    this.wantsListening = false;
    this.pendingStartAfterStop = false;
    this.stopIntent = 'unmount';
    this.clearLifecycleTimers();
    this.clearSilenceTimer();

    const rec = this.recognition;
    this.recognition = null;
    if (rec) {
      rec.onstart = null;
      rec.onspeechstart = null;
      rec.onspeechend = null;
      rec.onresult = null;
      rec.onerror = null;
      rec.onnomatch = null;
      rec.onend = null;
      if (this.engineState !== 'idle') {
        try {
          rec.stop();
        } catch {
          try {
            rec.abort();
          } catch {
            // Ignore teardown errors
          }
        }
      }
    }
    this.engineState = 'idle';
  }
}
