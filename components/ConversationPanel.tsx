import React, {useState} from 'react';
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Hospital,
  MessageSquarePlus,
  PhoneCall,
  RefreshCw,
  RotateCcw,
  Square,
  ThumbsDown,
  ThumbsUp,
  Volume2,
} from 'lucide-react';
import type {
  ChatMessageItem,
  EmergencyId,
  EmergencyProtocol,
  Language,
  StructuredFirstAidAiResponse,
} from '../src/types/emergency';

interface Props {
  lang: Language;
  messages: ChatMessageItem[];
  protocols?: EmergencyProtocol[];
  isLoading: boolean;
  isSpeaking: boolean;
  onRepeatMessage: (msg: ChatMessageItem) => void;
  onStopAudio: () => void;
  onNewConversation: () => void;
  onOpenProtocol: (id: EmergencyId) => void;
  onOpenHospitals: () => void;
  onUseFollowUp: (question: string) => void;
  onSubmitAnswerFeedback?: (params: {
    messageId: string;
    eventId?: string | null;
    phrase: string;
    matchedIntent: EmergencyId | 'unknown';
    isCorrect: boolean;
    correctedIntent?: EmergencyId | 'unknown';
  }) => Promise<void>;
}

export function formatAssistantSpeechText(
  res: StructuredFirstAidAiResponse,
  lang: Language
): string {
  const parts: string[] = [];
  if (res.adviseCall112) {
    parts.push(
      lang === 'hi' ? 'तुरंत 112 पर कॉल करें।' : 'Call 112 immediately.'
    );
  }
  if (res.acknowledgment) {
    parts.push(res.acknowledgment);
  }
  if (res.immediateSteps.length > 0) {
    res.immediateSteps.slice(0, 4).forEach((step, idx) => {
      parts.push(
        lang === 'hi' ? `कदम ${idx + 1}: ${step}` : `Step ${idx + 1}: ${step}`
      );
    });
  }
  if (res.followUpQuestion) {
    parts.push(res.followUpQuestion);
  }
  return parts.join(' ');
}

export const ConversationPanel: React.FC<Props> = ({
  lang,
  messages,
  protocols = [],
  isLoading,
  isSpeaking,
  onRepeatMessage,
  onStopAudio,
  onNewConversation,
  onOpenProtocol,
  onOpenHospitals,
  onUseFollowUp,
  onSubmitAnswerFeedback,
}) => {
  const [feedbackGiven, setFeedbackGiven] = useState<
    Record<string, 'yes' | 'no' | 'picking'>
  >({});
  const [correctionChoice, setCorrectionChoice] = useState<
    Record<string, EmergencyId | ''>
  >({});

  if (messages.length === 0 && !isLoading) {
    return null;
  }

  const renderFeedbackRow = (
    msg: ChatMessageItem,
    matchedIntent: EmergencyId | 'unknown'
  ) => {
    if (!onSubmitAnswerFeedback) return null;
    const status = feedbackGiven[msg.id];
    const phrase = msg.queryText || msg.text;

    if (status === 'yes' || status === 'no') {
      return (
        <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-800 pt-1">
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
          <span>
            {lang === 'hi'
              ? 'प्रतिक्रिया सहेजी गई — धन्यवाद!'
              : 'Feedback saved — thank you!'}
          </span>
        </div>
      );
    }

    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-bold text-[#0F1E36]">
            {lang === 'hi'
              ? 'क्या यह गाइड सही था? (Was this correct?)'
              : 'Was this correct?'}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setFeedbackGiven((prev) => ({...prev, [msg.id]: 'yes'}));
                void onSubmitAnswerFeedback({
                  messageId: msg.id,
                  eventId: msg.supabaseEventId,
                  phrase,
                  matchedIntent,
                  isCorrect: true,
                });
              }}
              className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-emerald-300 bg-white px-3 py-1 text-xs font-bold text-emerald-800 hover:bg-emerald-50"
            >
              <ThumbsUp className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{lang === 'hi' ? 'हाँ (Yes)' : 'Yes'}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                if (protocols.length > 0) {
                  setFeedbackGiven((prev) => ({...prev, [msg.id]: 'picking'}));
                } else {
                  setFeedbackGiven((prev) => ({...prev, [msg.id]: 'no'}));
                  void onSubmitAnswerFeedback({
                    messageId: msg.id,
                    eventId: msg.supabaseEventId,
                    phrase,
                    matchedIntent,
                    isCorrect: false,
                  });
                }
              }}
              className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-red-200 bg-white px-3 py-1 text-xs font-bold text-[#DC2626] hover:bg-red-50"
            >
              <ThumbsDown className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{lang === 'hi' ? 'नहीं (No)' : 'No'}</span>
            </button>
          </div>
        </div>

        {status === 'picking' && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <select
              value={correctionChoice[msg.id] || ''}
              onChange={(e) =>
                setCorrectionChoice((prev) => ({
                  ...prev,
                  [msg.id]: e.target.value as EmergencyId | '',
                }))
              }
              aria-label={
                lang === 'hi' ? 'सही आपात स्थिति चुनें' : 'Select correct emergency'
              }
              className="min-h-[36px] flex-1 min-w-[180px] rounded-lg border border-slate-300 bg-white px-2.5 text-xs font-semibold text-[#0F1E36]"
            >
              <option value="">
                {lang === 'hi'
                  ? 'सही गाइड चुनें (वैकल्पिक)...'
                  : 'Select the right guide (optional)...'}
              </option>
              {protocols.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title[lang]}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                const chosen = correctionChoice[msg.id] || undefined;
                setFeedbackGiven((prev) => ({...prev, [msg.id]: 'no'}));
                void onSubmitAnswerFeedback({
                  messageId: msg.id,
                  eventId: msg.supabaseEventId,
                  phrase,
                  matchedIntent,
                  isCorrect: false,
                  correctedIntent: chosen,
                });
                if (chosen) {
                  onOpenProtocol(chosen);
                }
              }}
              className="min-h-[36px] rounded-lg bg-[#0F1E36] px-3 py-1 text-xs font-bold text-white hover:bg-[#162947]"
            >
              {lang === 'hi' ? 'सेव करें' : 'Save Feedback'}
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <section
      aria-label={lang === 'hi' ? 'सहायता बातचीत' : 'Emergency Conversation'}
      className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-6 space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
        <h2 className="text-base sm:text-lg font-extrabold text-[#0F1E36]">
          {lang === 'hi' ? 'सहायता मार्गदर्शन' : 'Live First-Aid Guidance'}
        </h2>

        <div className="flex flex-wrap items-center gap-2">
          {isSpeaking && (
            <button
              type="button"
              onClick={onStopAudio}
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-bold text-[#DC2626] hover:bg-red-100"
            >
              <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
              <span>{lang === 'hi' ? 'आवाज़ रोकें' : 'Stop Audio'}</span>
            </button>
          )}
          <button
            type="button"
            onClick={onNewConversation}
            className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-[#0F1E36] hover:bg-slate-50"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{lang === 'hi' ? 'नई बातचीत' : 'New Conversation'}</span>
          </button>
        </div>
      </div>

      <div className="space-y-4">
        {messages.map((msg) => {
          if (msg.role === 'user') {
            return (
              <div key={msg.id} className="flex justify-end">
                <div className="max-w-xl rounded-2xl border border-slate-200 bg-slate-100 px-4 py-3 text-sm sm:text-base font-semibold text-[#0F1E36] space-y-2">
                  {msg.imagePreviewUrl && (
                    <img
                      src={msg.imagePreviewUrl}
                      alt={
                        lang === 'hi'
                          ? 'भेजी गई फोटो'
                          : 'Attached situation photo'
                      }
                      className="max-h-40 rounded-lg border border-slate-200 object-cover"
                    />
                  )}
                  <p className="whitespace-pre-wrap">{msg.text}</p>
                </div>
              </div>
            );
          }

          if (msg.aiResponse) {
            const ai = msg.aiResponse;
            const isCritical = ai.adviseCall112 || ai.urgency === 'critical';

            return (
              <article
                key={msg.id}
                className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 space-y-4"
              >
                {isCritical && (
                  <div
                    role="alert"
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3"
                  >
                    <div className="flex items-center gap-2.5 text-sm sm:text-base font-extrabold text-[#DC2626]">
                      <AlertTriangle
                        className="h-5 w-5 shrink-0"
                        aria-hidden="true"
                      />
                      <span>
                        {lang === 'hi'
                          ? 'गंभीर स्थिति हो सकती है — तुरंत 112 पर कॉल करें'
                          : 'Urgent situation — Call 112 immediately'}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <a
                        href="tel:112"
                        className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-[#DC2626] px-3.5 py-1.5 text-xs sm:text-sm font-extrabold text-white hover:bg-red-700"
                      >
                        <PhoneCall className="h-4 w-4" aria-hidden="true" />
                        <span>{lang === 'hi' ? '112 कॉल करें' : 'Call 112'}</span>
                      </a>
                      <button
                        type="button"
                        onClick={onOpenHospitals}
                        className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs sm:text-sm font-bold text-[#0F1E36] hover:bg-slate-50"
                      >
                        <Hospital
                          className="h-4 w-4 text-[#DC2626]"
                          aria-hidden="true"
                        />
                        <span>
                          {lang === 'hi' ? 'नज़दीकी अस्पताल' : 'Nearby Hospitals'}
                        </span>
                      </button>
                    </div>
                  </div>
                )}

                {ai.imageObservationNote && (
                  <p className="rounded-xl bg-slate-50 px-3.5 py-2.5 text-xs sm:text-sm font-medium text-slate-700">
                    <span className="font-bold text-[#0F1E36]">
                      {lang === 'hi' ? 'फोटो नोट: ' : 'Photo note: '}
                    </span>
                    {ai.imageObservationNote}
                  </p>
                )}

                {ai.acknowledgment && (
                  <p className="text-base sm:text-lg font-bold text-[#0F1E36] leading-snug">
                    {ai.acknowledgment}
                  </p>
                )}

                {ai.immediateSteps.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-xs font-extrabold uppercase tracking-wide text-slate-500">
                      {lang === 'hi' ? 'तुरंत करने योग्य कदम' : 'Immediate Safe Steps'}
                    </h3>
                    <ol className="space-y-2">
                      {ai.immediateSteps.map((step, index) => (
                        <li
                          key={index}
                          className="flex items-start gap-3 text-sm sm:text-base font-medium text-[#0F1E36]"
                        >
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#0F1E36] text-xs font-extrabold text-white mt-0.5">
                            {index + 1}
                          </span>
                          <span className="leading-relaxed">{step}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                {ai.doNot.length > 0 && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 space-y-1.5">
                    <h3 className="text-xs font-extrabold uppercase tracking-wide text-amber-900">
                      {lang === 'hi' ? 'क्या न करें' : 'What NOT to do'}
                    </h3>
                    <ul className="list-disc pl-5 space-y-1 text-sm font-medium text-amber-950">
                      {ai.doNot.map((item, idx) => (
                        <li key={idx}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {ai.whenToSeekHelp && (
                  <p className="text-sm font-semibold text-slate-700">
                    <span className="font-extrabold text-[#0F1E36]">
                      {lang === 'hi'
                        ? 'अस्पताल/112 कब लें: '
                        : 'When to get urgent care: '}
                    </span>
                    {ai.whenToSeekHelp}
                  </p>
                )}

                {ai.followUpQuestion && (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5">
                    <p className="text-sm font-semibold text-[#0F1E36]">
                      {ai.followUpQuestion}
                    </p>
                    <button
                      type="button"
                      onClick={() => onUseFollowUp('')}
                      className="min-h-[36px] rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-bold text-[#0F1E36] hover:bg-slate-100"
                    >
                      {lang === 'hi' ? 'जवाब लिखें/बोलें' : 'Reply'}
                    </button>
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onRepeatMessage(msg)}
                      className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-[#0F1E36] hover:bg-slate-50"
                    >
                      <Volume2 className="h-4 w-4" aria-hidden="true" />
                      <span>
                        {lang === 'hi' ? 'सुनें / दोहराएं' : 'Read Aloud / Repeat'}
                      </span>
                    </button>

                    {ai.matchedProtocolId && (
                      <button
                        type="button"
                        onClick={() => onOpenProtocol(ai.matchedProtocolId!)}
                        className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-[#0F1E36] px-3.5 py-1.5 text-xs font-bold text-white hover:bg-[#162947]"
                      >
                        <span>
                          {lang === 'hi'
                            ? 'पूरा स्टेप-बाय-स्टेप गाइड खोलें'
                            : 'Open Full Offline Guide'}
                        </span>
                      </button>
                    )}

                    {!isCritical && (
                      <button
                        type="button"
                        onClick={onOpenHospitals}
                        className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-[#0F1E36] hover:bg-slate-50"
                      >
                        <Hospital
                          className="h-4 w-4 text-[#DC2626]"
                          aria-hidden="true"
                        />
                        <span>
                          {lang === 'hi' ? 'नज़दीकी अस्पताल' : 'Nearby Hospitals'}
                        </span>
                      </button>
                    )}
                  </div>

                  {ai.sources.length > 0 && (
                    <div className="text-xs text-slate-500">
                      <span>{lang === 'hi' ? 'स्रोत: ' : 'Sources: '}</span>
                      {ai.sources.map((src, i) => (
                        <React.Fragment key={src.name}>
                          {i > 0 && ' · '}
                          <a
                            href={src.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-0.5 font-semibold text-slate-700 hover:underline"
                          >
                            {src.name}
                            <ExternalLink className="h-3 w-3" aria-hidden="true" />
                          </a>
                        </React.Fragment>
                      ))}
                    </div>
                  )}
                </div>

                {renderFeedbackRow(msg, ai.matchedProtocolId || 'unknown')}

                <p className="text-[11px] text-slate-500">{ai.disclaimer}</p>
              </article>
            );
          }

          return (
            <div
              key={msg.id}
              className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-[#0F1E36]"
            >
              {msg.text}
            </div>
          );
        })}

        {isLoading && (
          <div className="flex items-center gap-2.5 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-[#0F1E36]">
            <RefreshCw className="h-4 w-4 animate-spin text-[#DC2626]" />
            <span>
              {lang === 'hi'
                ? 'सुरक्षा सहायता तैयार की जा रही है...'
                : 'Preparing your safety response...'}
            </span>
          </div>
        )}
      </div>
    </section>
  );
};
