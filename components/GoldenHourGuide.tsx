import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  AlertOctagon,
  ArrowLeft,
  BookOpenCheck,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  HeartPulse,
  Mic,
  MicOff,
  PhoneCall,
  RotateCcw,
  ShieldAlert,
  Square,
  ThumbsDown,
  ThumbsUp,
  Volume2,
} from 'lucide-react';
import {
  getLearningConsentState,
  setLearningConsent,
  submitLearningFeedback,
} from '../lib/feedback';
import {
  type BrowserSpeechRecognition,
  formatSpeechRecognitionError,
  getRecognitionLanguage,
  getSpeechRecognitionConstructor,
  getVoiceSelectionNotice,
  isSpeechRecognitionSupported,
  pickBestRecognitionAlternative,
  primeSpeechSynthesis,
  speakText,
  stopSpeaking,
  subscribeToVoicesChanged,
} from '../lib/voice';
import {UI_COPY, t} from '../src/i18n/translations';
import type {
  EmergencyId,
  EmergencyProtocol,
  Language,
} from '../src/types/emergency';

interface Props {
  protocol: EmergencyProtocol;
  allProtocols?: EmergencyProtocol[];
  lang: Language;
  voiceOnly: boolean;
  isOnline: boolean;
  helperNote?: string;
  queryText?: string;
  predictedConfidence?: number;
  modelVersion?: string;
  skipInitialAutoSpeak?: boolean;
  onBackHome: () => void;
  onOpenCprCoach: () => void;
  onSwitchProtocol?: (id: EmergencyId) => void;
}

export const GoldenHourGuide: React.FC<Props> = ({
  protocol,
  allProtocols = [],
  lang,
  voiceOnly,
  isOnline,
  helperNote,
  queryText = '',
  predictedConfidence = 1,
  modelVersion = '1.0.0',
  skipInitialAutoSpeak = false,
  onBackHome,
  onOpenCprCoach,
  onSwitchProtocol,
}) => {
  const totalSteps = protocol.steps.length;
  const [stepIndex, setStepIndex] = useState<number>(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [speechError, setSpeechError] = useState('');
  const [voiceCmdEnabled, setVoiceCmdEnabled] = useState(false);
  const [voiceCmdError, setVoiceCmdError] = useState('');
  const [lastCommandText, setLastCommandText] = useState('');
  const [voiceNotice, setVoiceNotice] = useState<string | null>(() =>
    getVoiceSelectionNotice(lang)
  );

  // Privacy-preserving feedback state
  const [feedbackChoice, setFeedbackChoice] = useState<'yes' | 'no' | null>(
    null
  );
  const [correctedId, setCorrectedId] = useState<EmergencyId>(protocol.id);
  const [consentChecked, setConsentChecked] = useState<boolean>(
    () => getLearningConsentState().consented
  );
  const [feedbackStatus, setFeedbackStatus] = useState('');
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);

  const stepIndexRef = useRef<number>(0);
  stepIndexRef.current = stepIndex;
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const cmdEngineStateRef = useRef<'idle' | 'starting' | 'listening' | 'stopping'>('idle');
  const cmdRestartTimerRef = useRef<number | null>(null);
  const isSpeakingRef = useRef(false);
  const voiceCmdEnabledRef = useRef(false);
  voiceCmdEnabledRef.current = voiceCmdEnabled;
  const lastCmdAtRef = useRef<number>(0);
  const langRef = useRef<Language>(lang);
  langRef.current = lang;

  const currentStepText = protocol.steps[stepIndex]?.[lang] ?? '';

  useEffect(() => {
    const syncNotice = () => setVoiceNotice(getVoiceSelectionNotice(lang));
    syncNotice();
    return subscribeToVoicesChanged(syncNotice);
  }, [lang]);

  useEffect(() => {
    setCorrectedId(protocol.id);
    setFeedbackChoice(null);
    setFeedbackStatus('');
    setFeedbackSubmitted(false);
  }, [protocol.id]);

  const readCurrentStep = useCallback(
    (idx: number, allowDuplicate = false) => {
      const text =
        idx === 0
          ? `${protocol.call112First[lang]} ${protocol.steps[0]?.[lang] ?? ''}`
          : protocol.steps[idx]?.[lang] ?? '';

      if (!text) return;
      setSpeechError('');
      isSpeakingRef.current = true;
      setIsSpeaking(true);

      if (cmdRestartTimerRef.current !== null) {
        window.clearTimeout(cmdRestartTimerRef.current);
        cmdRestartTimerRef.current = null;
      }

      if (
        recognitionRef.current &&
        (cmdEngineStateRef.current === 'starting' ||
          cmdEngineStateRef.current === 'listening')
      ) {
        cmdEngineStateRef.current = 'stopping';
        try {
          recognitionRef.current.stop();
        } catch {
          cmdEngineStateRef.current = 'idle';
        }
      }

      speakText(text, lang, {
        allowDuplicate,
        onStart: () => {
          isSpeakingRef.current = true;
          setIsSpeaking(true);
        },
        onEnd: () => {
          isSpeakingRef.current = false;
          setIsSpeaking(false);
          if (voiceCmdEnabledRef.current && recognitionRef.current) {
            if (cmdRestartTimerRef.current !== null) {
              window.clearTimeout(cmdRestartTimerRef.current);
            }
            cmdRestartTimerRef.current = window.setTimeout(() => {
              cmdRestartTimerRef.current = null;
              if (
                voiceCmdEnabledRef.current &&
                !isSpeakingRef.current &&
                recognitionRef.current &&
                cmdEngineStateRef.current === 'idle'
              ) {
                try {
                  cmdEngineStateRef.current = 'starting';
                  recognitionRef.current.start();
                } catch {
                  cmdEngineStateRef.current = 'idle';
                }
              }
            }, 350);
          }
        },
        onError: (msg) => {
          isSpeakingRef.current = false;
          setIsSpeaking(false);
          setSpeechError(msg);
        },
      });
    },
    [lang, protocol]
  );

  useEffect(() => {
    stepIndexRef.current = 0;
    setStepIndex(0);
    if (!skipInitialAutoSpeak) {
      readCurrentStep(0);
    }
    return () => {
      stopSpeaking();
    };
  }, [protocol.id, lang, skipInitialAutoSpeak, readCurrentStep]);

  const handleNext = useCallback(() => {
    primeSpeechSynthesis();
    const next = Math.min(stepIndexRef.current + 1, totalSteps - 1);
    if (next === stepIndexRef.current) return;
    stepIndexRef.current = next;
    setStepIndex(next);
    readCurrentStep(next);
  }, [readCurrentStep, totalSteps]);

  const handlePrev = useCallback(() => {
    primeSpeechSynthesis();
    const prevIdx = Math.max(stepIndexRef.current - 1, 0);
    if (prevIdx === stepIndexRef.current) return;
    stepIndexRef.current = prevIdx;
    setStepIndex(prevIdx);
    readCurrentStep(prevIdx);
  }, [readCurrentStep]);

  const handleRepeat = useCallback(() => {
    primeSpeechSynthesis();
    readCurrentStep(stepIndexRef.current, true);
  }, [readCurrentStep]);

  const handlersRef = useRef({handleNext, handlePrev, handleRepeat});
  handlersRef.current = {handleNext, handlePrev, handleRepeat};

  useEffect(() => {
    const SR = getSpeechRecognitionConstructor();
    if (!voiceCmdEnabled) {
      if (cmdRestartTimerRef.current !== null) {
        window.clearTimeout(cmdRestartTimerRef.current);
        cmdRestartTimerRef.current = null;
      }
      const existing = recognitionRef.current;
      if (existing) {
        recognitionRef.current = null;
        cmdEngineStateRef.current = 'idle';
        existing.onstart = null;
        existing.onresult = null;
        existing.onerror = null;
        existing.onend = null;
        try {
          existing.abort();
        } catch {
          // Ignore
        }
      }
      return;
    }

    if (!SR) {
      setVoiceCmdEnabled(false);
      setVoiceCmdError(formatSpeechRecognitionError('unsupported', lang));
      return;
    }

    let active = true;
    let emptyRestarts = 0;
    let abortRetries = 0;
    let hadResultThisCycle = false;
    let fatalErrorHandled = false;
    setVoiceCmdError('');

    const rec = recognitionRef.current || new SR();
    rec.lang = getRecognitionLanguage(lang);
    try {
      rec.continuous = true;
    } catch {
      // Ignore
    }
    rec.interimResults = true;
    try {
      rec.maxAlternatives = 5;
    } catch {
      // Ignore
    }

    rec.onstart = () => {
      if (!active) return;
      cmdEngineStateRef.current = 'listening';
    };

    rec.onresult = (event) => {
      if (!active || isSpeakingRef.current) return;
      const last = event.results[event.results.length - 1];
      const transcript = pickBestRecognitionAlternative(last, 5).toLowerCase();
      if (!transcript) return;
      hadResultThisCycle = true;
      emptyRestarts = 0;
      abortRetries = 0;

      const now = Date.now();
      if (now - lastCmdAtRef.current < 1100) return;

      setLastCommandText(transcript);

      if (
        /\b(next|agla|aage)\b/.test(transcript) ||
        transcript.includes('अगला') ||
        transcript.includes('आगे')
      ) {
        lastCmdAtRef.current = now;
        handlersRef.current.handleNext();
      } else if (
        /\b(repeat|dobara|phir)\b/.test(transcript) ||
        transcript.includes('दोबारा') ||
        transcript.includes('फिर')
      ) {
        lastCmdAtRef.current = now;
        handlersRef.current.handleRepeat();
      } else if (
        /\b(back|pichhla|pichla|peeche|pichhe)\b/.test(transcript) ||
        transcript.includes('पिछला') ||
        transcript.includes('पीछे')
      ) {
        lastCmdAtRef.current = now;
        handlersRef.current.handlePrev();
      }
    };

    rec.onerror = (ev) => {
      if (!active) return;
      const code = ev.error || 'unknown';
      if (
        code === 'not-allowed' ||
        code === 'service-not-allowed' ||
        code === 'audio-capture' ||
        code === 'language-not-supported' ||
        code === 'language-unavailable' ||
        code === 'network'
      ) {
        fatalErrorHandled = true;
        active = false;
        setVoiceCmdEnabled(false);
        setVoiceCmdError(formatSpeechRecognitionError(code, langRef.current));
        return;
      }
      if (code === 'aborted') {
        if (isSpeakingRef.current) return;
        abortRetries += 1;
        if (abortRetries > 1) {
          fatalErrorHandled = true;
          active = false;
          setVoiceCmdEnabled(false);
          setVoiceCmdError(formatSpeechRecognitionError('aborted', langRef.current));
        }
        return;
      }
      if (code === 'no-speech') {
        if (emptyRestarts >= 2) {
          fatalErrorHandled = true;
          active = false;
          setVoiceCmdEnabled(false);
          setVoiceCmdError(formatSpeechRecognitionError('no-speech', langRef.current));
        }
      }
    };

    rec.onend = () => {
      cmdEngineStateRef.current = 'idle';
      if (!active || fatalErrorHandled || isSpeakingRef.current) return;
      if (hadResultThisCycle) {
        emptyRestarts = 0;
      } else {
        emptyRestarts += 1;
      }
      hadResultThisCycle = false;
      if (emptyRestarts > 3) {
        active = false;
        setVoiceCmdEnabled(false);
        return;
      }
      if (cmdRestartTimerRef.current !== null) {
        window.clearTimeout(cmdRestartTimerRef.current);
      }
      cmdRestartTimerRef.current = window.setTimeout(() => {
        cmdRestartTimerRef.current = null;
        if (
          active &&
          !isSpeakingRef.current &&
          recognitionRef.current === rec &&
          cmdEngineStateRef.current === 'idle'
        ) {
          try {
            cmdEngineStateRef.current = 'starting';
            rec.start();
          } catch {
            cmdEngineStateRef.current = 'idle';
          }
        }
      }, 350);
    };

    recognitionRef.current = rec;
    if (!isSpeakingRef.current && cmdEngineStateRef.current === 'idle') {
      try {
        cmdEngineStateRef.current = 'starting';
        rec.start();
      } catch {
        cmdEngineStateRef.current = 'idle';
        setVoiceCmdEnabled(false);
        setVoiceCmdError(formatSpeechRecognitionError('start-failed', lang));
      }
    }

    return () => {
      active = false;
      if (cmdRestartTimerRef.current !== null) {
        window.clearTimeout(cmdRestartTimerRef.current);
        cmdRestartTimerRef.current = null;
      }
      if (recognitionRef.current === rec) {
        recognitionRef.current = null;
      }
      rec.onstart = null;
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      if (cmdEngineStateRef.current !== 'idle') {
        try {
          rec.abort();
        } catch {
          // Ignore
        }
      }
      cmdEngineStateRef.current = 'idle';
    };
  }, [voiceCmdEnabled, lang]);

  const handleSubmitFeedback = async (
    helpful: boolean,
    chosenIntent: EmergencyId
  ) => {
    if (consentChecked && !getLearningConsentState().consented) {
      setLearningConsent(true);
    }
    const textForSignal = queryText.trim() || protocol.title[lang];
    const res = await submitLearningFeedback({
      rawText: textForSignal,
      language: lang,
      predictedIntent: protocol.id,
      confidence: predictedConfidence,
      correctedIntent: chosenIntent,
      helpful,
      source: 'classifier_feedback',
      modelVersion,
    });
    setFeedbackStatus(res.message);
    setFeedbackSubmitted(true);
    if (!helpful && chosenIntent !== protocol.id && onSwitchProtocol) {
      onSwitchProtocol(chosenIntent);
    }
  };

  return (
    <section className="mx-auto max-w-4xl px-4 py-5 pb-24 sm:px-6 md:pb-12">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => {
            stopSpeaking();
            onBackHome();
          }}
          className="inline-flex min-h-[48px] items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 text-base font-bold text-[#0F1E36] hover:bg-slate-50"
        >
          <ArrowLeft className="h-5 w-5 shrink-0" aria-hidden="true" />
          <span>{t(UI_COPY.backHome, lang)}</span>
        </button>

        {isSpeechRecognitionSupported() && (
          <button
            type="button"
            onClick={() => {
              setVoiceCmdEnabled((v) => !v);
            }}
            className={`inline-flex min-h-[48px] items-center gap-2 rounded-xl border px-4 py-2 text-sm font-bold transition-colors ${
              voiceCmdEnabled
                ? 'border-[#DC2626] bg-red-50 text-[#DC2626]'
                : 'border-slate-300 bg-white text-[#0F1E36] hover:bg-slate-50'
            }`}
          >
            {voiceCmdEnabled ? (
              <Mic className="h-5 w-5 shrink-0" aria-hidden="true" />
            ) : (
              <MicOff className="h-5 w-5 shrink-0" aria-hidden="true" />
            )}
            <span>
              {voiceCmdEnabled
                ? lang === 'hi'
                  ? 'आवाज़ कमांड चालू ("अगला" / "दोबारा" / "पिछला")'
                  : 'Voice Commands On ("Next" / "Repeat" / "Back")'
                : lang === 'hi'
                ? 'आवाज़ से चलाएं'
                : 'Voice Commands'}
            </span>
          </button>
        )}
      </div>

      {!isOnline && voiceCmdEnabled && (
        <p className="mt-2 text-xs font-semibold text-amber-800">
          {lang === 'hi'
            ? 'नोट: कुछ डिवाइस पर ऑफ़लाइन रहने पर वॉइस कमांड काम नहीं करतीं; आप नीचे बड़े बटन दबा सकते हैं।'
            : 'Note: Some devices require internet for speech recognition; tap the large buttons below anytime.'}
        </p>
      )}

      {voiceCmdError && (
        <p className="mt-2 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2 text-xs font-semibold text-amber-950">
          {voiceCmdError}
        </p>
      )}

      {helperNote && (
        <div className="mt-4 rounded-2xl border border-amber-300 bg-amber-50 px-5 py-3.5 text-base font-semibold text-amber-950">
          <p>{helperNote}</p>
        </div>
      )}

      {!voiceOnly && (
        <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-base font-bold text-[#0F1E36]">
            {protocol.call112First[lang]}
          </div>
          <a
            href="tel:112"
            className="inline-flex min-h-[56px] shrink-0 items-center justify-center gap-2 rounded-xl bg-[#DC2626] px-5 py-3 text-base font-extrabold text-white hover:bg-red-700"
          >
            <PhoneCall className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span>{t(UI_COPY.call112, lang)}</span>
          </a>
        </div>
      )}

      <div className="mt-5 rounded-3xl border border-slate-200 bg-white p-6 sm:p-8 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
          <div>
            <p className="text-sm font-bold text-[#DC2626]">
              {protocol.title[lang]}
            </p>
            <p className="font-mono-nums mt-0.5 text-sm font-semibold text-slate-500">
              {lang === 'hi'
                ? `कदम ${stepIndex + 1} / ${totalSteps}`
                : `Step ${stepIndex + 1} of ${totalSteps}`}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRepeat}
              className={`inline-flex min-h-[48px] items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold transition-colors ${
                isSpeaking
                  ? 'bg-[#0F1E36] text-white'
                  : 'bg-slate-100 text-[#0F1E36] hover:bg-slate-200'
              }`}
            >
              <Volume2
                className={`h-5 w-5 shrink-0 ${
                  isSpeaking ? 'animate-pulse' : ''
                }`}
                aria-hidden="true"
              />
              <span>
                {isSpeaking
                  ? lang === 'hi'
                    ? 'दोहराएं'
                    : 'Repeat'
                  : lang === 'hi'
                  ? 'सुनें'
                  : 'Read Aloud'}
              </span>
            </button>

            {isSpeaking && (
              <button
                type="button"
                onClick={() => {
                  stopSpeaking();
                  isSpeakingRef.current = false;
                  setIsSpeaking(false);
                }}
                className="inline-flex min-h-[48px] items-center gap-1.5 rounded-xl border border-red-300 bg-red-50 px-3.5 py-2 text-sm font-bold text-[#DC2626] hover:bg-red-100 transition-colors"
              >
                <Square className="h-4 w-4 fill-current shrink-0" aria-hidden="true" />
                <span>{lang === 'hi' ? 'रोकें' : 'Stop'}</span>
              </button>
            )}
          </div>
        </div>

        {voiceNotice && (
          <p className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700">
            {voiceNotice}
          </p>
        )}

        {speechError && (
          <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900">
            {speechError}
          </p>
        )}

        <div className="mt-4 flex gap-1.5" aria-hidden="true">
          {protocol.steps.map((_, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => {
                primeSpeechSynthesis();
                stepIndexRef.current = idx;
                setStepIndex(idx);
                readCurrentStep(idx, true);
              }}
              aria-label={`Step ${idx + 1}`}
              className={`h-2.5 flex-1 rounded-full transition-colors ${
                idx === stepIndex
                  ? 'bg-[#DC2626]'
                  : idx < stepIndex
                  ? 'bg-[#0F1E36]'
                  : 'bg-slate-200'
              }`}
            />
          ))}
        </div>

        <div className="py-8 sm:py-10">
          <p className="text-2xl sm:text-3xl font-extrabold leading-snug text-[#0F1E36]">
            {currentStepText}
          </p>
          {lastCommandText && voiceCmdEnabled && (
            <p className="mt-4 text-sm font-medium text-slate-500">
              {lang === 'hi' ? 'सुना गया: ' : 'Heard: '}"{lastCommandText}"
            </p>
          )}
        </div>

        <div className="grid grid-cols-3 gap-3">
          <button
            type="button"
            onClick={handlePrev}
            disabled={stepIndex === 0}
            className="flex min-h-[60px] items-center justify-center gap-1.5 rounded-2xl border border-slate-300 bg-white px-3 text-base sm:text-lg font-bold text-[#0F1E36] hover:bg-slate-50 disabled:opacity-40"
          >
            <ChevronLeft className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span>{t(UI_COPY.prevStep, lang)}</span>
          </button>

          <button
            type="button"
            onClick={handleRepeat}
            className="flex min-h-[60px] items-center justify-center gap-1.5 rounded-2xl bg-[#0F1E36] px-3 text-base sm:text-lg font-bold text-white hover:bg-[#162947]"
          >
            <RotateCcw className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span>{t(UI_COPY.repeatStep, lang)}</span>
          </button>

          <button
            type="button"
            onClick={handleNext}
            disabled={stepIndex === totalSteps - 1}
            className="flex min-h-[60px] items-center justify-center gap-1.5 rounded-2xl bg-[#DC2626] px-3 text-base sm:text-lg font-bold text-white hover:bg-red-700 disabled:opacity-40"
          >
            <span>{t(UI_COPY.nextStep, lang)}</span>
            <ChevronRight className="h-5 w-5 shrink-0" aria-hidden="true" />
          </button>
        </div>

        {protocol.supportsCprCoach && (
          <div className="mt-5">
            <button
              type="button"
              onClick={() => {
                stopSpeaking();
                onOpenCprCoach();
              }}
              className="flex min-h-[60px] w-full items-center justify-center gap-3 rounded-2xl bg-[#0F1E36] px-5 py-3 text-lg font-extrabold text-white shadow-sm hover:bg-[#162947]"
            >
              <HeartPulse
                className="h-6 w-6 text-[#DC2626] shrink-0"
                aria-hidden="true"
              />
              <span>{t(UI_COPY.openCprCoach, lang)}</span>
            </button>
          </div>
        )}
      </div>

      {!voiceOnly && (
        <>
          <div className="mt-6 rounded-3xl border border-amber-300 bg-amber-50/70 p-6">
            <div className="flex items-center gap-2.5 text-lg font-extrabold text-amber-950">
              <AlertOctagon
                className="h-6 w-6 text-[#D97706] shrink-0"
                aria-hidden="true"
              />
              <h3>{t(UI_COPY.doNotTitle, lang)}</h3>
            </div>
            <ul className="mt-4 space-y-3 text-base sm:text-lg font-semibold text-[#0F1E36]">
              {protocol.doNot.map((item, idx) => (
                <li key={idx} className="flex items-start gap-2.5">
                  <span
                    className="mt-1 text-[#DC2626] font-extrabold"
                    aria-hidden="true"
                  >
                    ✕
                  </span>
                  <span>{item[lang]}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-5 rounded-3xl border border-red-200 bg-white p-5 space-y-3">
            <div className="flex items-center gap-2 text-base font-extrabold text-[#DC2626]">
              <ShieldAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
              <h3>{t(UI_COPY.whenToGetHelpTitle, lang)}</h3>
            </div>
            <p className="text-base font-semibold text-[#0F1E36]">
              {protocol.whenToGetHelp[lang]}
            </p>
            <div className="border-t border-slate-100 pt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
              <div className="inline-flex items-center gap-1.5">
                <BookOpenCheck
                  className="h-4 w-4 text-slate-500"
                  aria-hidden="true"
                />
                <span>
                  Sources: {protocol.sources.map((s) => s.name).join(' · ')}
                </span>
              </div>
              <span className="font-semibold text-amber-800">
                {protocol.review_status === 'clinically_reviewed'
                  ? 'Clinically reviewed'
                  : 'Pending clinical review'}{' '}
                ({protocol.last_reviewed})
              </span>
            </div>
          </div>

          {/* Optional Privacy-Preserving Feedback Bar */}
          {queryText && (
            <div className="mt-5 rounded-3xl border border-slate-200 bg-white p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-sm font-bold text-[#0F1E36]">
                  {lang === 'hi'
                    ? 'क्या यह सही आपातकालीन गाइड थी?'
                    : 'Was this the right emergency guide?'}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={feedbackSubmitted}
                    onClick={() => {
                      setFeedbackChoice('yes');
                      handleSubmitFeedback(true, protocol.id);
                    }}
                    className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border px-3.5 py-1.5 text-sm font-bold ${
                      feedbackChoice === 'yes'
                        ? 'border-emerald-600 bg-emerald-50 text-emerald-800'
                        : 'border-slate-300 bg-white text-[#0F1E36] hover:bg-slate-50'
                    }`}
                  >
                    <ThumbsUp className="h-4 w-4" aria-hidden="true" />
                    <span>{lang === 'hi' ? 'हाँ' : 'Yes'}</span>
                  </button>
                  <button
                    type="button"
                    disabled={feedbackSubmitted}
                    onClick={() => setFeedbackChoice('no')}
                    className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border px-3.5 py-1.5 text-sm font-bold ${
                      feedbackChoice === 'no'
                        ? 'border-amber-600 bg-amber-50 text-amber-900'
                        : 'border-slate-300 bg-white text-[#0F1E36] hover:bg-slate-50'
                    }`}
                  >
                    <ThumbsDown className="h-4 w-4" aria-hidden="true" />
                    <span>{lang === 'hi' ? 'नहीं' : 'No'}</span>
                  </button>
                </div>
              </div>

              <label className="flex items-start gap-2.5 text-xs text-slate-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={consentChecked}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setConsentChecked(checked);
                    setLearningConsent(checked);
                  }}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300"
                />
                <span>
                  {lang === 'hi'
                    ? 'मैं वैकल्पिक रूप से सहमत हूँ कि बिना किसी निजी जानकारी (फोन, नाम, लोकेशन या फोटो के बिना) केवल यह सुधार ऑफ़लाइन मॉडल को बेहतर बनाने के लिए साझा किया जाए।'
                    : 'Optional consent: allow sharing anonymized text + category correction (zero phone, name, GPS, or photo data) to improve future Rakshak releases.'}
                </span>
              </label>

              {feedbackChoice === 'no' && !feedbackSubmitted && (
                <div className="flex flex-col sm:flex-row gap-2 pt-1">
                  <select
                    value={correctedId}
                    onChange={(e) =>
                      setCorrectedId(e.target.value as EmergencyId)
                    }
                    className="min-h-[44px] flex-1 rounded-xl border border-slate-300 bg-white px-3 text-sm font-semibold text-[#0F1E36]"
                  >
                    {allProtocols.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title[lang]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => handleSubmitFeedback(false, correctedId)}
                    className="min-h-[44px] rounded-xl bg-[#0F1E36] px-4 py-2 text-sm font-bold text-white hover:bg-[#162947]"
                  >
                    {lang === 'hi' ? 'सही स्थिति चुनें' : 'Switch & Submit'}
                  </button>
                </div>
              )}

              {feedbackStatus && (
                <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-800">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>{feedbackStatus}</span>
                </p>
              )}
            </div>
          )}
        </>
      )}

      <footer className="mt-6 border-t border-slate-200 pt-4 text-center text-sm font-semibold text-slate-600">
        {t(UI_COPY.safetyFooter, lang)}
      </footer>
    </section>
  );
};
