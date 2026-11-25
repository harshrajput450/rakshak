import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  AlertCircle,
  Camera,
  ExternalLink,
  ImagePlus,
  Loader2,
  Mic,
  MicOff,
  RotateCcw,
  Send,
  Square,
  Trash2,
  Video,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {LiveCameraPanel} from './LiveCameraPanel';
import {updateRuntimeDiagnostics} from '../lib/diagnosticsStore';
import {
  SpeechRecognitionController,
  type SpeechControllerSnapshot,
} from '../lib/speechController';
import {revokeImagePreviewUrl, validateAndCompressImage} from '../lib/imageUtils';
import {
  getAvailableVoicesForLanguage,
  getPreferredVoiceURI,
  getRecognitionLanguage,
  getVoiceSelectionNotice,
  isSpeechRecognitionSupported,
  isVoiceOutputEnabled,
  primeSpeechSynthesis,
  setPreferredVoiceURI,
  setVoiceOutputEnabled,
  speakText,
  stopSpeaking,
  subscribeToVoicesChanged,
} from '../lib/voice';
import {useOnlineStatus} from '../src/hooks/useOnlineStatus';
import {UI_COPY, t} from '../src/i18n/translations';
import type {
  ImageAttachmentPayload,
  InputVoiceLanguage,
  Language,
  VoiceOptionInfo,
} from '../src/types/emergency';

interface Props {
  lang: Language;
  isSubmitting: boolean;
  onSubmitPrompt: (
    text: string,
    image: ImageAttachmentPayload | null
  ) => Promise<boolean>;
  showVoiceSettings?: boolean;
  externalDraftPrompt?: {id: number; text: string} | null;
}

function detectInsideIframe(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export const VoiceControls: React.FC<Props> = ({
  lang,
  isSubmitting,
  onSubmitPrompt,
  showVoiceSettings = false,
  externalDraftPrompt = null,
}) => {
  const isOnline = useOnlineStatus();
  const [isInIframe] = useState<boolean>(detectInsideIframe);
  const [inputVoiceLang, setInputVoiceLang] = useState<InputVoiceLanguage>(() =>
    lang === 'en' ? 'en' : 'hi'
  );
  const [speechSnapshot, setSpeechSnapshot] =
    useState<SpeechControllerSnapshot>(() => ({
      speechState: 'idle',
      transcript: '',
      interimPreview: '',
      micError: '',
      lastErrorCode: null,
      inputVoiceLang: lang === 'en' ? 'en' : 'hi',
      activeRecLang: getRecognitionLanguage(lang),
      autoSendRemainingMs: null,
      speechSupported: isSpeechRecognitionSupported(),
    }));

  // Camera / Photo attachment state
  const [liveCameraOpen, setLiveCameraOpen] = useState(false);
  const [attachedImage, setAttachedImage] =
    useState<ImageAttachmentPayload | null>(null);
  const [isCompressingImage, setIsCompressingImage] = useState(false);
  const [imageError, setImageError] = useState('');

  // Voice output & picker state
  const [voiceEnabled, setVoiceEnabled] = useState(isVoiceOutputEnabled);
  const [isSpeakingTest, setIsSpeakingTest] = useState(false);
  const [voiceOptions, setVoiceOptions] = useState<VoiceOptionInfo[]>(() =>
    getAvailableVoicesForLanguage(lang)
  );
  const [selectedVoiceURI, setSelectedVoiceURI] = useState(() =>
    getPreferredVoiceURI(lang)
  );
  const [voiceNotice, setVoiceNotice] = useState<string | null>(() =>
    getVoiceSelectionNotice(lang)
  );

  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const controllerRef = useRef<SpeechRecognitionController | null>(null);
  const onSubmitPromptRef = useRef(onSubmitPrompt);
  onSubmitPromptRef.current = onSubmitPrompt;
  const attachedImageRef = useRef<ImageAttachmentPayload | null>(attachedImage);
  attachedImageRef.current = attachedImage;
  const initialLangRef = useRef<Language>(lang);
  const initialInputLangRef = useRef<InputVoiceLanguage>(inputVoiceLang);

  const {
    speechState,
    transcript,
    interimPreview,
    micError,
    lastErrorCode,
    activeRecLang,
    autoSendRemainingMs,
    speechSupported,
  } = speechSnapshot;

  const listening = speechState === 'listening';
  const processingSpeech = speechState === 'processing';

  // Single controlled SpeechRecognitionController lifecycle (never recreated on render)
  useEffect(() => {
    const controller = new SpeechRecognitionController({
      initialLang: initialLangRef.current,
      initialInputLang: initialInputLangRef.current,
      onStateChange: (snapshot) => {
        setSpeechSnapshot(snapshot);
        updateRuntimeDiagnostics({
          inputVoiceLang: snapshot.inputVoiceLang,
          activeRecLang: snapshot.activeRecLang,
          ...(snapshot.micError ? {lastError: snapshot.micError} : {}),
        });
      },
      onSubmitFinalized: async (text) => {
        return onSubmitPromptRef.current(text, attachedImageRef.current);
      },
      onSubmissionSucceeded: () => {
        const img = attachedImageRef.current;
        if (img) {
          revokeImagePreviewUrl(img.previewUrl);
          attachedImageRef.current = null;
          setAttachedImage(null);
        }
        setImageError('');
      },
      onFocusTextBox: () => {
        textareaRef.current?.focus();
      },
    });

    controllerRef.current = controller;
    const initialSnap = controller.getSnapshot();
    setSpeechSnapshot(initialSnap);
    updateRuntimeDiagnostics({
      inputVoiceLang: initialSnap.inputVoiceLang,
      activeRecLang: initialSnap.activeRecLang,
    });

    return () => {
      controller.dispose();
      controllerRef.current = null;
      revokeImagePreviewUrl(attachedImageRef.current?.previewUrl);
    };
  }, []);

  useEffect(() => {
    const syncedInput: InputVoiceLanguage =
      lang === 'en'
        ? 'en'
        : inputVoiceLang === 'hinglish'
        ? 'hinglish'
        : 'hi';
    setInputVoiceLang(syncedInput);
    controllerRef.current?.setLanguage(lang, syncedInput);
  }, [lang]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    controllerRef.current?.setExternalSubmitting(isSubmitting);
  }, [isSubmitting]);

  useEffect(() => {
    const key = attachedImage
      ? `${attachedImage.sizeBytes || attachedImage.data.length}`
      : '';
    controllerRef.current?.setAttachmentKey(key);
  }, [attachedImage]);

  useEffect(() => {
    if (externalDraftPrompt && externalDraftPrompt.text) {
      controllerRef.current?.setTranscriptFromUser(externalDraftPrompt.text);
      textareaRef.current?.focus();
    }
  }, [externalDraftPrompt]);

  useEffect(() => {
    const syncVoices = () => {
      setVoiceOptions(getAvailableVoicesForLanguage(lang));
      setSelectedVoiceURI(getPreferredVoiceURI(lang));
      setVoiceNotice(getVoiceSelectionNotice(lang));
    };
    syncVoices();
    return subscribeToVoicesChanged(syncVoices);
  }, [lang]);

  const handleSelectInputVoiceLang = (next: InputVoiceLanguage) => {
    setInputVoiceLang(next);
    controllerRef.current?.setInputVoiceLanguage(next);
    updateRuntimeDiagnostics({
      inputVoiceLang: next,
      activeRecLang: getRecognitionLanguage(next),
    });
  };

  const clearSilenceTimer = useCallback(() => {
    controllerRef.current?.clearSilenceTimer();
  }, []);

  const stopListening = useCallback(() => {
    controllerRef.current?.stopManual();
  }, []);

  const handleToggleListening = () => {
    setIsSpeakingTest(false);
    controllerRef.current?.toggle();
  };

  const handleRetryListening = () => {
    setIsSpeakingTest(false);
    controllerRef.current?.retry();
  };

  const handleClearTranscript = () => {
    controllerRef.current?.clearTranscript();
  };

  const handleImageFileSelected = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setImageError('');
    setIsCompressingImage(true);
    clearSilenceTimer();

    try {
      const compressed = await validateAndCompressImage(file, lang);
      if (attachedImageRef.current?.previewUrl) {
        revokeImagePreviewUrl(attachedImageRef.current.previewUrl);
      }
      setAttachedImage(compressed);
    } catch (err) {
      setImageError(
        err instanceof Error
          ? err.message
          : lang === 'hi'
          ? 'फोटो संसाधित नहीं हो सकी।'
          : 'Could not process selected photo.'
      );
    } finally {
      setIsCompressingImage(false);
    }
  };

  const handleRemoveImage = () => {
    clearSilenceTimer();
    if (attachedImage?.previewUrl) {
      revokeImagePreviewUrl(attachedImage.previewUrl);
    }
    setAttachedImage(null);
    setImageError('');
  };

  const handleAttachCapturedImage = useCallback(
    (image: ImageAttachmentPayload) => {
      clearSilenceTimer();
      if (attachedImageRef.current?.previewUrl) {
        revokeImagePreviewUrl(attachedImageRef.current.previewUrl);
      }
      setAttachedImage(image);
      setImageError('');
    },
    [clearSilenceTimer]
  );

  const handleSendCapturedImage = useCallback(
    async (image: ImageAttachmentPayload): Promise<boolean> => {
      clearSilenceTimer();
      const textToSend = transcript.trim();
      const ok = await onSubmitPromptRef.current(textToSend, image);
      if (ok && textToSend) {
        controllerRef.current?.clearTranscript();
      }
      return ok;
    },
    [clearSilenceTimer, transcript]
  );

  const triggerTextSubmit = () => {
    primeSpeechSynthesis();
    clearSilenceTimer();
    if (isSubmitting || isCompressingImage) return;
    if (!transcript.trim() && !attachedImage) return;
    void controllerRef.current?.submitCurrentOrProvided(transcript);
  };

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    triggerTextSubmit();
  };

  const handleVoiceToggle = () => {
    const next = !voiceEnabled;
    setVoiceOutputEnabled(next);
    setVoiceEnabled(next);
    if (next) {
      primeSpeechSynthesis();
      speakText(
        lang === 'hi' ? 'आवाज़ सहायता चालू है।' : 'Voice guidance enabled.',
        lang,
        {
          bypassMuteCheck: true,
          onStart: () => setIsSpeakingTest(true),
          onEnd: () => setIsSpeakingTest(false),
          onError: () => setIsSpeakingTest(false),
        }
      );
    } else {
      setIsSpeakingTest(false);
    }
  };

  const handleVoiceSelectChange = (uri: string) => {
    setPreferredVoiceURI(lang, uri);
    setSelectedVoiceURI(uri);
    setVoiceNotice(getVoiceSelectionNotice(lang));
    if (voiceEnabled) {
      primeSpeechSynthesis();
      speakText(
        lang === 'hi'
          ? 'नमस्ते, यह रक्षक आवाज़ परीक्षण है।'
          : 'Hello, this is the Rakshak voice sample.',
        lang,
        {
          allowDuplicate: true,
          onStart: () => setIsSpeakingTest(true),
          onEnd: () => setIsSpeakingTest(false),
          onError: () => setIsSpeakingTest(false),
        }
      );
    }
  };

  const currentPageHref =
    typeof window !== 'undefined' ? window.location.href : '/';

  return (
    <div className="space-y-4">
      {/* Iframe / Preview Voice Blocking Detection Banner */}
      {isInIframe && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-xs sm:text-sm font-semibold text-amber-950"
        >
          <span>
            {lang === 'hi'
              ? 'प्रीव्यू (iframe) में वॉइस ब्लॉक हो सकती है। बेहतर वॉइस पहचान के लिए ऐप को नए टैब में खोलें। (Voice may be blocked in preview. Open the app in a new tab.)'
              : 'Voice may be blocked in preview. Open the app in a new tab.'}
          </span>
          <a
            href={currentPageHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg bg-[#0F1E36] px-3.5 py-1.5 text-xs font-extrabold text-white hover:bg-[#162947] shrink-0"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{lang === 'hi' ? 'नए टैब में खोलें' : 'Open in new tab'}</span>
          </a>
        </div>
      )}

      {/* Manual Hindi / English / Hinglish Input Language Toggle */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-bold text-slate-600">
          {lang === 'hi' ? 'बोलने की भाषा (Mic):' : 'Voice Input Language:'}
        </span>
        <div
          role="group"
          aria-label="Voice input language"
          className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5"
        >
          {(
            [
              {id: 'hi', label: 'हिंदी (hi-IN)'},
              {id: 'hinglish', label: 'Hinglish'},
              {id: 'en', label: 'English (en-IN)'},
            ] as const
          ).map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => handleSelectInputVoiceLang(opt.id)}
              aria-pressed={inputVoiceLang === opt.id}
              className={`min-h-[34px] rounded-md px-3 py-1 text-xs font-bold transition-colors ${
                inputVoiceLang === opt.id
                  ? 'bg-[#0F1E36] text-white'
                  : 'text-slate-700 hover:text-[#0F1E36]'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Primary Voice Control Row */}
      <div className="flex flex-col sm:flex-row gap-3">
        <button
          type="button"
          onClick={handleToggleListening}
          aria-pressed={listening || processingSpeech}
          className={`flex min-h-[60px] flex-1 items-center justify-center gap-3 rounded-xl px-5 py-3.5 text-lg font-extrabold transition-colors ${
            listening || processingSpeech
              ? 'bg-[#DC2626] text-white'
              : 'bg-[#0F1E36] text-white hover:bg-[#162947]'
          }`}
        >
          {listening || processingSpeech ? (
            <span className="relative flex h-6 w-6 items-center justify-center shrink-0">
              <span className="absolute inline-flex h-full w-full rounded-full bg-white/50 animate-ping" />
              <MicOff className="relative h-6 w-6 shrink-0" aria-hidden="true" />
            </span>
          ) : (
            <Mic className="h-6 w-6 shrink-0" aria-hidden="true" />
          )}
          <span>
            {processingSpeech
              ? lang === 'hi'
                ? 'आवाज़ समझ रहा हूँ...'
                : 'Processing speech...'
              : listening
              ? t(UI_COPY.stopListening, lang)
              : speechSupported
              ? t(UI_COPY.speakButton, lang)
              : lang === 'hi'
              ? 'वॉइस असमर्थित (Chrome उपयोग करें / लिखें)'
              : 'Mic Unsupported — Use Chrome or Type'}
          </span>
        </button>

        {(listening || processingSpeech) && (
          <button
            type="button"
            onClick={() => stopListening()}
            className="inline-flex min-h-[52px] sm:min-h-[60px] items-center justify-center gap-2 rounded-xl border-2 border-[#DC2626] bg-white px-5 py-2.5 text-sm sm:text-base font-extrabold text-[#DC2626] hover:bg-red-50 transition-colors"
          >
            <Square className="h-4 w-4 fill-current shrink-0" aria-hidden="true" />
            <span>{lang === 'hi' ? 'रोकें' : 'Stop'}</span>
          </button>
        )}

        <button
          type="button"
          onClick={() => setLiveCameraOpen((open) => !open)}
          aria-expanded={liveCameraOpen}
          disabled={isSubmitting}
          className={`inline-flex min-h-[56px] sm:min-h-[60px] items-center justify-center gap-2.5 rounded-xl border-2 px-5 py-3 text-base sm:text-lg font-extrabold transition-colors disabled:opacity-50 ${
            liveCameraOpen
              ? 'border-[#DC2626] bg-red-50 text-[#DC2626]'
              : 'border-[#0F1E36] bg-white text-[#0F1E36] hover:bg-slate-50'
          }`}
        >
          <Video className="h-5 w-5 shrink-0" aria-hidden="true" />
          <span>{lang === 'hi' ? 'लाइव कैमरा' : 'Live Camera'}</span>
        </button>
      </div>

      {/* Direct In-App Live Camera & Optional Live Assistance Panel */}
      {liveCameraOpen && (
        <LiveCameraPanel
          lang={lang}
          isSubmitting={isSubmitting}
          onAttachCapturedImage={handleAttachCapturedImage}
          onSendCapturedImage={handleSendCapturedImage}
          onClose={() => setLiveCameraOpen(false)}
        />
      )}

      {/* Live Microphone / Silence Countdown Status */}
      {(listening || processingSpeech || autoSendRemainingMs !== null) && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-semibold text-[#0F1E36]"
        >
          <div className="flex items-center gap-2.5">
            {(listening || processingSpeech) && (
              <span className="h-3 w-3 rounded-full bg-[#DC2626] animate-pulse shrink-0" />
            )}
            <span>
              {autoSendRemainingMs !== null
                ? lang === 'hi'
                  ? `चुप रहने पर ${(autoSendRemainingMs / 1000).toFixed(1)}s में अपने आप भेजा जाएगा...`
                  : `Sending automatically in ${(autoSendRemainingMs / 1000).toFixed(1)}s...`
                : processingSpeech
                ? lang === 'hi'
                  ? `आवाज़ समझ रहा हूँ... (${activeRecLang})`
                  : `Processing speech... (${activeRecLang})`
                : lang === 'hi'
                ? `सुन रहा हूँ (${activeRecLang}) — बोलें, तुरंत नीचे दिखेगा।`
                : `Listening (${activeRecLang}) — speak clearly, text appears live below.`}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {interimPreview && (
              <span className="text-xs font-bold text-slate-600">
                “{interimPreview}”
              </span>
            )}
            {autoSendRemainingMs !== null && (
              <button
                type="button"
                onClick={clearSilenceTimer}
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-bold text-[#0F1E36] hover:bg-slate-100"
              >
                {lang === 'hi' ? 'रद्द करें (एडिट)' : 'Cancel / Edit'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Browser Compatibility & Honest Offline Speech Notice */}
      {!speechSupported && (
        <div
          role="status"
          className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-xs sm:text-sm font-semibold text-amber-950"
        >
          {lang === 'hi'
            ? 'इस ब्राउज़र में वॉइस पहचान समर्थित नहीं है। कृपया Chrome उपयोग करें (Use Chrome) — नीचे हिंदी/हिंग्लिश में लिखकर सभी गाइड चलाएं।'
            : 'Speech recognition is not supported in this browser. Use Chrome, or type your emergency below.'}
        </div>
      )}

      {speechSupported && !isOnline && (
        <div
          role="status"
          className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-700"
        >
          {lang === 'hi'
            ? 'नोट: कई ब्राउज़र (जैसे Chrome) में वॉइस पहचान के लिए इंटरनेट आवश्यक होता है। ऑफ़लाइन होने पर नीचे लिखकर या 20 गाइड चुनकर उपयोग करें।'
            : 'Note: Browser speech recognition may require an internet connection; typed input and all 20 emergency guides work offline.'}
        </div>
      )}

      {/* Microphone Error Banner */}
      {!listening && !processingSpeech && micError && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-950"
        >
          <div className="flex items-start gap-2.5 flex-1 min-w-[200px]">
            <AlertCircle className="h-5 w-5 text-amber-700 shrink-0 mt-0.5" />
            <span>{micError}</span>
          </div>
          {speechSupported && lastErrorCode !== 'unsupported' && (
            <button
              type="button"
              onClick={handleRetryListening}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-[#0F1E36] px-3.5 py-1.5 text-xs sm:text-sm font-bold text-white hover:bg-[#162947] shrink-0"
            >
              <RotateCcw className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{lang === 'hi' ? 'फिर कोशिश करें' : 'Retry'}</span>
            </button>
          )}
        </div>
      )}

      {/* Persistent Text + Camera + Upload Composer */}
      <form onSubmit={handleManualSubmit} className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label
            htmlFor="rakshak-emergency-input"
            className="text-xs sm:text-sm font-bold text-slate-700"
          >
            {lang === 'hi'
              ? `आपात स्थिति बोलें (${activeRecLang}), लिखें (Enter से भेजें) या फोटो जोड़ें`
              : `Speak (${activeRecLang}), type and press Enter, or attach a photo`}
          </label>
          {transcript && (
            <button
              type="button"
              onClick={handleClearTranscript}
              className="inline-flex items-center gap-1 text-xs font-bold text-slate-500 hover:text-[#DC2626]"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{lang === 'hi' ? 'साफ़ करें' : 'Clear'}</span>
            </button>
          )}
        </div>

        <textarea
          ref={textareaRef}
          id="rakshak-emergency-input"
          rows={2}
          value={transcript}
          onChange={(e) => {
            controllerRef.current?.setTranscriptFromUser(e.target.value);
          }}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              triggerTextSubmit();
            }
          }}
          placeholder={t(UI_COPY.typePlaceholder, lang)}
          className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-base font-medium text-[#0F1E36] focus:border-[#0F1E36] focus:outline-none"
        />

        {/* Hidden Camera & Gallery File Inputs */}
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleImageFileSelected}
          className="sr-only"
          aria-label={lang === 'hi' ? 'कैमरा से फोटो लें' : 'Take photo with camera'}
        />
        <input
          ref={galleryInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/*"
          onChange={handleImageFileSelected}
          className="sr-only"
          aria-label={lang === 'hi' ? 'गैलरी से फोटो चुनें' : 'Upload photo from device'}
        />

        {/* Photo Preview or Compressing Indicator */}
        {isCompressingImage && (
          <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs font-semibold text-slate-700">
            <Loader2 className="h-4 w-4 animate-spin shrink-0" />
            <span>
              {lang === 'hi'
                ? 'फोटो तैयार की जा रही है...'
                : 'Preparing compressed photo...'}
            </span>
          </div>
        )}

        {imageError && (
          <div
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs sm:text-sm font-semibold text-red-900"
          >
            {imageError}
          </div>
        )}

        {attachedImage && (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 p-2.5">
            <div className="flex items-center gap-3 min-w-0">
              {attachedImage.previewUrl && (
                <img
                  src={attachedImage.previewUrl}
                  alt={lang === 'hi' ? 'चयनित फोटो पूर्वावलोकन' : 'Attached photo preview'}
                  className="h-14 w-14 rounded-lg object-cover border border-slate-200 shrink-0"
                />
              )}
              <div className="min-w-0 text-xs text-slate-700">
                <p className="font-bold text-[#0F1E36] truncate">
                  {lang === 'hi' ? 'फोटो संलग्न है' : 'Photo attached'}
                </p>
                <p className="font-mono-nums text-slate-500">
                  {attachedImage.width && attachedImage.height
                    ? `${attachedImage.width}×${attachedImage.height} · `
                    : ''}
                  {attachedImage.sizeBytes
                    ? `${Math.max(1, Math.round(attachedImage.sizeBytes / 1024))} KB`
                    : 'JPEG'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => cameraInputRef.current?.click()}
                className="min-h-[36px] rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-bold text-[#0F1E36] hover:bg-slate-100"
              >
                {lang === 'hi' ? 'दोबारा लें' : 'Retake'}
              </button>
              <button
                type="button"
                onClick={handleRemoveImage}
                aria-label={lang === 'hi' ? 'फोटो हटाएं' : 'Remove photo'}
                className="inline-flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 hover:text-[#DC2626]"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        )}

        {/* Composer Action Toolbar: Camera + Upload + Voice Output + Send */}
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => cameraInputRef.current?.click()}
              disabled={isCompressingImage || isSubmitting}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs sm:text-sm font-bold text-[#0F1E36] hover:bg-slate-50 disabled:opacity-50"
            >
              <Camera className="h-4 w-4 text-[#0F1E36]" aria-hidden="true" />
              <span>{lang === 'hi' ? 'कैमरा फोटो' : 'Take Photo'}</span>
            </button>

            <button
              type="button"
              onClick={() => galleryInputRef.current?.click()}
              disabled={isCompressingImage || isSubmitting}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs sm:text-sm font-bold text-[#0F1E36] hover:bg-slate-50 disabled:opacity-50"
            >
              <ImagePlus className="h-4 w-4 text-[#0F1E36]" aria-hidden="true" />
              <span>{lang === 'hi' ? 'गैलरी से चुनें' : 'Upload Photo'}</span>
            </button>

            <button
              type="button"
              onClick={handleVoiceToggle}
              aria-pressed={voiceEnabled}
              className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border px-3 py-2 text-xs sm:text-sm font-bold transition-colors ${
                voiceEnabled
                  ? 'border-emerald-300 bg-emerald-50 text-[#15803D]'
                  : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {voiceEnabled ? (
                <Volume2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              ) : (
                <VolumeX className="h-4 w-4 shrink-0" aria-hidden="true" />
              )}
              <span>
                {voiceEnabled
                  ? lang === 'hi'
                    ? 'बोलकर उत्तर: चालू'
                    : 'Voice Reply: On'
                  : lang === 'hi'
                  ? 'बोलकर उत्तर: बंद'
                  : 'Voice Reply: Off'}
              </span>
            </button>
          </div>

          <button
            type="submit"
            disabled={
              isSubmitting ||
              isCompressingImage ||
              (!transcript.trim() && !attachedImage)
            }
            className="inline-flex min-h-[48px] min-w-[144px] items-center justify-center gap-2 rounded-xl bg-[#DC2626] px-5 py-2.5 text-sm sm:text-base font-extrabold text-white hover:bg-red-700 disabled:opacity-45 transition-colors"
          >
            {isSubmitting ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Send className="h-4 w-4 shrink-0" aria-hidden="true" />
            )}
            <span>
              {isSubmitting
                ? lang === 'hi'
                  ? 'जाँच हो रही है...'
                  : 'Checking...'
                : t(UI_COPY.sendText, lang)}
            </span>
          </button>
        </div>
      </form>

      {voiceEnabled && voiceNotice && !showVoiceSettings && (
        <p className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2 text-xs text-slate-600">
          {voiceNotice}
        </p>
      )}

      {showVoiceSettings && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label
              htmlFor="rakshak-voice-picker"
              className="text-sm font-bold text-[#0F1E36]"
            >
              {lang === 'hi'
                ? 'आवाज़ चुनें (शांत महिला आवाज़ प्राथमिकता)'
                : 'Voice Selector (Calm Female Priority)'}
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  primeSpeechSynthesis();
                  speakText(
                    lang === 'hi'
                      ? 'नमस्ते, मैं रक्षक हूँ। शांत रहें, हम मदद करेंगे।'
                      : 'Hello, this is Rakshak. Stay calm, we will guide you.',
                    lang,
                    {
                      allowDuplicate: true,
                      bypassMuteCheck: true,
                      onStart: () => setIsSpeakingTest(true),
                      onEnd: () => setIsSpeakingTest(false),
                      onError: () => setIsSpeakingTest(false),
                    }
                  );
                }}
                className="min-h-[36px] rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-bold text-[#0F1E36] hover:bg-slate-100"
              >
                {lang === 'hi' ? 'आवाज़ सुनें' : 'Test Voice'}
              </button>
              {isSpeakingTest && (
                <button
                  type="button"
                  onClick={() => {
                    stopSpeaking();
                    setIsSpeakingTest(false);
                  }}
                  className="min-h-[36px] rounded-lg border border-red-300 bg-red-50 px-3 py-1 text-xs font-bold text-[#DC2626] hover:bg-red-100"
                >
                  {lang === 'hi' ? 'रोकें' : 'Stop'}
                </button>
              )}
            </div>
          </div>

          <select
            id="rakshak-voice-picker"
            value={selectedVoiceURI}
            onChange={(e) => handleVoiceSelectChange(e.target.value)}
            className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 text-sm font-medium text-[#0F1E36]"
          >
            <option value="">
              {lang === 'hi'
                ? 'स्वचालित (सर्वोत्तम शांत महिला आवाज़)'
                : 'Automatic (Best Calm Female Voice Available)'}
            </option>
            {voiceOptions.map((v) => (
              <option key={v.voiceURI} value={v.voiceURI}>
                {v.name} ({v.lang})
                {v.isFemaleLikely ? ' · Female-preferred' : ''}
              </option>
            ))}
          </select>

          {voiceNotice && (
            <p className="text-xs text-slate-600">{voiceNotice}</p>
          )}
        </div>
      )}
    </div>
  );
};
