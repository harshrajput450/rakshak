import React, {useEffect, useRef, useState} from 'react';
import {
  AlertTriangle,
  ClipboardCheck,
  HeartPulse,
  Hospital,
  PhoneCall,
  Share2,
  SlidersHorizontal,
} from 'lucide-react';
import {
  ConversationPanel,
  formatAssistantSpeechText,
} from '../../components/ConversationPanel';
import {EmergencyTiles} from '../../components/EmergencyTiles';
import {VoiceControls} from '../../components/VoiceControls';
import {
  ClientAiError,
  resolveFirstAidQuery,
} from '../../lib/aiClient';
import {updateRuntimeDiagnostics} from '../../lib/diagnosticsStore';
import {
  getLearningConsentState,
  setLearningConsent,
  submitLearningFeedback,
} from '../../lib/feedback';
import {
  checkAndUpdateOfflineModel,
  getModelStatusSnapshot,
  initializeOfflineModel,
} from '../../lib/modelUpdater';
import {
  hasPromptedSupabaseConsent,
  initializeSupabaseTelemetry,
  respondToConsentPrompt,
  trackEmergencyEvent,
  trackFeedbackEvent,
} from '../../lib/supabaseClient';
import {primeSpeechSynthesis, speakText, stopSpeaking} from '../../lib/voice';
import {UI_COPY, t} from '../i18n/translations';
import type {
  ChatMessageItem,
  ConversationTurnInput,
  EmergencyId,
  EmergencyProtocol,
  ImageAttachmentPayload,
  Language,
  ModelStatusSnapshot,
  TrustedContact,
} from '../types/emergency';
import {DiagnosticsPanel} from './DiagnosticsPanel';

interface Props {
  lang: Language;
  isOnline: boolean;
  protocols: EmergencyProtocol[];
  hospitalsCount: number;
  onSelectProtocol: (
    id: EmergencyId,
    helperNote?: string,
    skipAutoSpeak?: boolean,
    meta?: {queryText?: string; confidence?: number; modelVersion?: string}
  ) => void;
  onOpenTriage: () => void;
  onOpenCprCoach: () => void;
  onOpenSos: () => void;
  onOpenHospitals: () => void;
}

function makeMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function loadTrustedContactNames(): string[] {
  try {
    const raw = localStorage.getItem('goldenhour_trusted_contacts_v1');
    if (!raw) return [];
    const list = JSON.parse(raw) as TrustedContact[];
    if (!Array.isArray(list)) return [];
    return list.map((c) => c?.name || '').filter(Boolean);
  } catch {
    return [];
  }
}

export const HomeScreen: React.FC<Props> = ({
  lang,
  isOnline,
  protocols,
  hospitalsCount,
  onSelectProtocol,
  onOpenTriage,
  onOpenCprCoach,
  onOpenSos,
  onOpenHospitals,
}) => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [isSpeakingReply, setIsSpeakingReply] = useState(false);
  const [lastQuery, setLastQuery] = useState('');
  const [breathingCheckPrompt, setBreathingCheckPrompt] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [modelStatus, setModelStatus] = useState<ModelStatusSnapshot>(() =>
    getModelStatusSnapshot()
  );
  const [consentOn, setConsentOn] = useState(
    () => getLearningConsentState().consented
  );
  const [showConsentAskOnce, setShowConsentAskOnce] = useState(
    () => !hasPromptedSupabaseConsent() && !getLearningConsentState().consented
  );
  const [externalDraftPrompt, setExternalDraftPrompt] = useState<{
    id: number;
    text: string;
  } | null>(null);

  const composerSectionRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    void initializeSupabaseTelemetry();
    initializeOfflineModel()
      .then((snap) => {
        setModelStatus(snap);
        if (isOnline) {
          checkAndUpdateOfflineModel(false)
            .then((res) => setModelStatus(res.status))
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, [isOnline]);

  const speakAssistantReply = (speechText: string, replyLang: Language) => {
    if (!speechText.trim()) return;
    speakText(speechText, replyLang, {
      allowDuplicate: true,
      onStart: () => setIsSpeakingReply(true),
      onEnd: () => setIsSpeakingReply(false),
      onError: () => setIsSpeakingReply(false),
    });
  };

  const handleTileSelect = (
    id: EmergencyId,
    helperNote?: string,
    skipAutoSpeak?: boolean,
    meta?: {queryText?: string; confidence?: number; modelVersion?: string}
  ) => {
    const proto = protocols.find((p) => p.id === id);
    const phrase = meta?.queryText || proto?.title[lang] || id;
    void trackEmergencyEvent({
      phrase,
      language: lang,
      matchedIntent: id,
      source: 'tile',
      confidence: meta?.confidence ?? 1,
      trustedContactNames: loadTrustedContactNames(),
    });
    onSelectProtocol(id, helperNote, skipAutoSpeak, meta);
  };

  const handleSubmitPrompt = async (
    rawText: string,
    image: ImageAttachmentPayload | null
  ): Promise<boolean> => {
    const cleaned = rawText.trim();
    if (!cleaned && !image) return false;

    setIsSubmitting(true);
    setSubmitError('');
    setLastQuery(cleaned);
    setBreathingCheckPrompt(false);

    const historyTurns: ConversationTurnInput[] = messages
      .slice(-8)
      .map((m) => ({
        role: m.role,
        text: m.aiResponse
          ? [
              m.aiResponse.acknowledgment,
              ...m.aiResponse.immediateSteps,
              ...m.aiResponse.doNot,
              m.aiResponse.whenToSeekHelp,
              m.aiResponse.followUpQuestion,
            ]
              .filter(Boolean)
              .join(' ')
          : m.text,
      }));

    const bubbleImageUrl = image
      ? `data:${image.mimeType};base64,${image.data}`
      : undefined;

    const userMsg: ChatMessageItem = {
      id: makeMessageId(),
      role: 'user',
      createdAt: new Date().toISOString(),
      language: lang,
      text:
        cleaned ||
        (lang === 'hi'
          ? 'फोटो भेजी गई — कृपया प्राथमिक सहायता बताएं।'
          : 'Photo attached — please provide safe first-aid guidance.'),
      imagePreviewUrl: bubbleImageUrl,
    };

    setMessages((prev) => [...prev, userMsg]);

    try {
      const resolved = await resolveFirstAidQuery({
        message: cleaned,
        language: lang,
        history: historyTurns,
        image,
      });

      const aiResponse = resolved.response;
      setBreathingCheckPrompt(aiResponse.requiresBreathingSafetyCheck);

      const assistantMsgId = makeMessageId();
      const assistantMsg: ChatMessageItem = {
        id: assistantMsgId,
        role: 'assistant',
        createdAt: new Date().toISOString(),
        language: lang,
        text: aiResponse.acknowledgment,
        queryText: cleaned || 'image_query',
        aiResponse,
      };

      setMessages((prev) => [...prev, assistantMsg]);
      speakAssistantReply(formatAssistantSpeechText(aiResponse, lang), lang);

      // Fire-and-forget anonymous event log (never blocks emergency guidance)
      void trackEmergencyEvent({
        phrase: cleaned || 'photo_emergency',
        language: lang,
        matchedIntent: aiResponse.matchedProtocolId || 'unknown',
        source: 'gemini',
        confidence: aiResponse.confidence,
        trustedContactNames: loadTrustedContactNames(),
      }).then((eventId) => {
        if (!eventId) return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId ? {...m, supabaseEventId: eventId} : m
          )
        );
      });

      return true;
    } catch (err) {
      if (
        err instanceof ClientAiError &&
        (err.code === 'invalid_input' || err.code === 'invalid_image')
      ) {
        setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
        setSubmitError(err.message);
        updateRuntimeDiagnostics({lastError: err.message});
        return false;
      }

      const friendlyReason =
        err instanceof Error
          ? err.message
          : lang === 'hi'
          ? 'लाइव स्मार्ट सहायता अभी अस्थायी रूप से उपलब्ध नहीं है। कृपया थोड़ी देर बाद फिर प्रयास करें। यदि कोई तत्काल खतरे में है, तो 112 पर कॉल करें।'
          : 'Live smart assistance is temporarily unavailable. Please try again shortly. If anyone is in immediate danger, call 112.';

      updateRuntimeDiagnostics({
        lastAiStatus:
          err instanceof ClientAiError &&
          (err.code === 'quota_exceeded' || err.code === 'rate_limited')
            ? 'quota'
            : 'unavailable',
        lastError: friendlyReason,
      });

      const fallbackMsgId = makeMessageId();
      const fallbackMsg: ChatMessageItem = {
        id: fallbackMsgId,
        role: 'assistant',
        createdAt: new Date().toISOString(),
        language: lang,
        text: friendlyReason,
        queryText: cleaned || 'image_query',
      };

      setMessages((prev) => [...prev, fallbackMsg]);
      speakAssistantReply(friendlyReason, lang);

      return true;
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAnswerFeedback = async (params: {
    messageId: string;
    eventId?: string | null;
    phrase: string;
    matchedIntent: EmergencyId | 'unknown';
    isCorrect: boolean;
    correctedIntent?: EmergencyId | 'unknown';
  }) => {
    await Promise.allSettled([
      trackFeedbackEvent({
        eventId: params.eventId,
        phrase: params.phrase,
        matchedIntent: params.matchedIntent,
        isCorrect: params.isCorrect,
        correctedIntent: params.correctedIntent || null,
        trustedContactNames: loadTrustedContactNames(),
      }),
      submitLearningFeedback({
        rawText: params.phrase,
        language: lang,
        predictedIntent: params.matchedIntent,
        confidence: 1,
        correctedIntent: params.correctedIntent || params.matchedIntent,
        helpful: params.isCorrect,
        source: 'classifier_feedback',
        modelVersion: modelStatus.activeVersion,
      }),
    ]);
  };

  const handleRepeatMessage = (msg: ChatMessageItem) => {
    primeSpeechSynthesis();
    if (msg.aiResponse) {
      speakAssistantReply(
        formatAssistantSpeechText(msg.aiResponse, msg.language),
        msg.language
      );
      return;
    }
    speakAssistantReply(msg.text, msg.language);
  };

  const handleNewConversation = () => {
    stopSpeaking();
    setIsSpeakingReply(false);
    setMessages([]);
    setBreathingCheckPrompt(false);
    setSubmitError('');
  };

  const handleReplyFromFollowUp = () => {
    setExternalDraftPrompt({id: Date.now(), text: ''});
    const inputEl = document.getElementById('rakshak-emergency-input');
    inputEl?.focus();
    composerSectionRef.current?.scrollIntoView({behavior: 'smooth', block: 'center'});
  };

  return (
    <main className="mx-auto max-w-6xl px-4 py-5 pb-24 sm:px-6 md:pb-12 space-y-6">
      {/* Main Clean Voice & Multimodal Emergency Composer */}
      <section
        ref={composerSectionRef}
        className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-7 space-y-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-[#0F1E36]">
              {t(UI_COPY.heroHeadline, lang)}
            </h1>
            <p className="text-sm sm:text-base font-medium text-slate-600 max-w-2xl">
              {t(UI_COPY.heroSub, lang)}
            </p>
          </div>

          <button
            type="button"
            onClick={() => setShowSettings((v) => !v)}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs sm:text-sm font-bold text-[#0F1E36] hover:bg-slate-50 shrink-0"
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
            <span>
              {lang === 'hi' ? 'आवाज़ व गोपनीयता' : 'Voice & Privacy'}
            </span>
          </button>
        </div>

        <VoiceControls
          lang={lang}
          isSubmitting={isSubmitting}
          onSubmitPrompt={handleSubmitPrompt}
          showVoiceSettings={showSettings}
          externalDraftPrompt={externalDraftPrompt}
        />

        {/* Ask-Once Anonymous Phrase Consent Prompt (off by default, no login) */}
        {showConsentAskOnce && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs sm:text-sm">
            <span className="font-semibold text-[#0F1E36]">
              {lang === 'hi'
                ? 'क्या आप गुमनाम आपातकालीन वाक्य सहेजकर रक्षक को बेहतर बनाने में मदद करना चाहते हैं? (कोई नाम या नंबर सेव नहीं होगा)'
                : 'Help improve Rakshak by saving anonymous emergency phrases? (No names or phone numbers are ever saved.)'}
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => {
                  respondToConsentPrompt(true);
                  setConsentOn(true);
                  setShowConsentAskOnce(false);
                }}
                className="min-h-[36px] rounded-lg bg-[#0F1E36] px-3 py-1 text-xs font-bold text-white hover:bg-[#162947]"
              >
                {lang === 'hi' ? 'अनुमति दें' : 'Allow Anonymous Saving'}
              </button>
              <button
                type="button"
                onClick={() => {
                  respondToConsentPrompt(false);
                  setConsentOn(false);
                  setShowConsentAskOnce(false);
                }}
                className="min-h-[36px] rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-bold text-slate-700 hover:bg-slate-100"
              >
                {lang === 'hi' ? 'नहीं, धन्यवाद' : 'No thanks'}
              </button>
            </div>
          </div>
        )}

        {showSettings && (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2 text-xs sm:text-sm">
            <label className="flex items-start gap-2.5 cursor-pointer font-semibold text-[#0F1E36]">
              <input
                type="checkbox"
                checked={consentOn}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setLearningConsent(checked);
                  respondToConsentPrompt(checked);
                  setConsentOn(checked);
                  setShowConsentAskOnce(false);
                }}
                className="mt-0.5 h-4 w-4 rounded border-slate-300"
              />
              <span>
                {lang === 'hi'
                  ? 'गुमनाम आपातकालीन वाक्य सहेजने की अनुमति दें (कोई नाम, फोन नंबर या संपर्क सेव नहीं होता — डिफ़ॉल्ट बंद)।'
                  : 'Help improve Rakshak by saving anonymous emergency phrases (off by default; strips names & phone numbers).'}
              </span>
            </label>
          </div>
        )}

        {submitError && (
          <div
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-900"
          >
            {submitError}
          </div>
        )}

        {breathingCheckPrompt && (
          <div
            role="alert"
            className="rounded-2xl border-2 border-[#DC2626] bg-red-50 p-5 space-y-4"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle
                className="h-6 w-6 text-[#DC2626] shrink-0 mt-0.5"
                aria-hidden="true"
              />
              <div className="space-y-1">
                <h2 className="text-lg font-extrabold text-[#DC2626]">
                  {lang === 'hi'
                    ? 'क्या व्यक्ति जवाब दे रहा है और सामान्य रूप से सांस ले रहा है?'
                    : 'Is the person responsive and breathing normally?'}
                </h2>
                <p className="text-sm font-semibold text-[#0F1E36]">
                  {lang === 'hi'
                    ? 'यदि नहीं, तो तुरंत 112 पर कॉल करें। मदद आने में देरी न करें।'
                    : 'If not, call 112 now. Do not delay getting emergency help.'}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <a
                href="tel:112"
                className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-[#DC2626] px-5 py-2.5 text-sm sm:text-base font-extrabold text-white hover:bg-red-700"
              >
                <PhoneCall className="h-4 w-4" aria-hidden="true" />
                <span>{t(UI_COPY.call112, lang)}</span>
              </a>
              <button
                type="button"
                onClick={onOpenCprCoach}
                className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-[#0F1E36] px-5 py-2.5 text-sm sm:text-base font-extrabold text-white hover:bg-[#162947]"
              >
                <HeartPulse className="h-4 w-4 text-[#DC2626]" aria-hidden="true" />
                <span>
                  {lang === 'hi'
                    ? 'व्यक्ति जवाब नहीं दे रहा और सामान्य रूप से सांस नहीं ले रहा'
                    : 'Person is unresponsive and not breathing normally'}
                </span>
              </button>
            </div>
          </div>
        )}

      </section>

      {/* Active Conversation Panel */}
      <ConversationPanel
        lang={lang}
        messages={messages}
        protocols={protocols}
        isLoading={isSubmitting}
        isSpeaking={isSpeakingReply}
        onRepeatMessage={handleRepeatMessage}
        onStopAudio={() => {
          stopSpeaking();
          setIsSpeakingReply(false);
        }}
        onNewConversation={handleNewConversation}
        onOpenProtocol={(id) =>
          handleTileSelect(id, '', false, {
            queryText: lastQuery,
            confidence: 0.9,
            modelVersion: modelStatus.activeVersion,
          })
        }
        onOpenHospitals={onOpenHospitals}
        onUseFollowUp={handleReplyFromFollowUp}
        onSubmitAnswerFeedback={handleAnswerFeedback}
      />

      {/* Quick Action Entry Points */}
      <section aria-label={lang === 'hi' ? 'त्वरित सहायता विकल्प' : 'Quick Emergency Tools'}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <button
            type="button"
            onClick={onOpenHospitals}
            className="flex min-h-[56px] items-center justify-center gap-2.5 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm sm:text-base font-extrabold text-[#0F1E36] hover:bg-slate-50"
          >
            <Hospital className="h-5 w-5 text-[#DC2626] shrink-0" aria-hidden="true" />
            <span>
              {t(UI_COPY.navHospitals, lang)}
              {hospitalsCount > 0 ? ` (${hospitalsCount})` : ''}
            </span>
          </button>

          <button
            type="button"
            onClick={onOpenCprCoach}
            className="flex min-h-[56px] items-center justify-center gap-2.5 rounded-xl bg-[#0F1E36] px-4 py-3 text-sm sm:text-base font-extrabold text-white hover:bg-[#162947]"
          >
            <HeartPulse
              className="h-5 w-5 text-[#DC2626] shrink-0"
              aria-hidden="true"
            />
            <span>{t(UI_COPY.navCpr, lang)}</span>
          </button>

          <button
            type="button"
            onClick={onOpenTriage}
            className="flex min-h-[56px] items-center justify-center gap-2.5 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm sm:text-base font-extrabold text-[#0F1E36] hover:bg-slate-50"
          >
            <ClipboardCheck className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span>
              {lang === 'hi' ? 'सवाल-जवाब जांच' : 'Guided Check (10 Qs)'}
            </span>
          </button>

          <button
            type="button"
            onClick={onOpenSos}
            className="flex min-h-[56px] items-center justify-center gap-2.5 rounded-xl bg-[#15803D] px-4 py-3 text-sm sm:text-base font-extrabold text-white hover:bg-green-800"
          >
            <Share2 className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span>{t(UI_COPY.shareLocationSos, lang)}</span>
          </button>
        </div>
      </section>

      {/* 20 Offline Emergency Protocol Guides */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg sm:text-xl font-extrabold text-[#0F1E36]">
            {t(UI_COPY.quickSelectTitle, lang)}
          </h2>
          <button
            type="button"
            onClick={onOpenTriage}
            className="text-sm font-bold text-[#DC2626] hover:underline"
          >
            {lang === 'hi'
              ? 'समझ नहीं आ रहा? सवाल-जवाब से पूछें →'
              : 'Not sure which one? Use Guided Check →'}
          </button>
        </div>

        <EmergencyTiles
          lang={lang}
          protocols={protocols}
          onSelectProtocol={(id) =>
            handleTileSelect(id, '', false, {
              queryText: lastQuery,
              confidence: 1,
              modelVersion: modelStatus.activeVersion,
            })
          }
        />
      </section>

      {/* Collapsible Debug Panel */}
      <DiagnosticsPanel lang={lang} hospitalsCount={hospitalsCount} />

      <footer className="border-t border-slate-200 pt-4 text-center text-xs sm:text-sm font-medium text-slate-600">
        {t(UI_COPY.safetyFooter, lang)}
      </footer>
    </main>
  );
};
