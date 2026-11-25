import React, {useEffect, useState} from 'react';
import {
  ArrowLeft,
  Camera,
  CheckCircle2,
  HelpCircle,
  PhoneCall,
  RotateCcw,
  ShieldAlert,
  Volume2,
  XCircle,
} from 'lucide-react';
import {EmergencyTiles} from '../../components/EmergencyTiles';
import {primeSpeechSynthesis, speakText, stopSpeaking} from '../../lib/voice';
import {UI_COPY, t} from '../../src/i18n/translations';
import type {
  EmergencyId,
  EmergencyProtocol,
  Language,
} from '../../src/types/emergency';

interface TriageQuestion {
  id: string;
  text: {en: string; hi: string};
  yesIntent?: EmergencyId;
  yesRedFlag?: {en: string; hi: string};
}

const TRIAGE_QUESTIONS: TriageQuestion[] = [
  {
    id: 'q1_breathing',
    text: {
      en: 'Is the person unresponsive AND not breathing normally (or only gasping)?',
      hi: 'क्या व्यक्ति बेहोश है और सामान्य सांस नहीं ले रहा (या केवल हांफ रहा है)?',
    },
    yesIntent: 'cardiac_arrest_cpr',
    yesRedFlag: {
      en: 'RED FLAG: Call 112 immediately and begin Hands-Only CPR on a firm surface.',
      hi: 'गंभीर चेतावनी: तुरंत 112 कॉल करें और सख्त जमीन पर सीपीआर शुरू करें।',
    },
  },
  {
    id: 'q2_choking',
    text: {
      en: 'Is something stuck in the throat so they cannot cough, speak, or breathe?',
      hi: 'क्या गले में कुछ फंसने से वे खांस, बोल या सांस नहीं ले पा रहे हैं?',
    },
    yesIntent: 'choking',
    yesRedFlag: {
      en: 'RED FLAG: Give 5 back blows and 5 abdominal thrusts (chest thrusts for infants) immediately.',
      hi: 'गंभीर चेतावनी: तुरंत पीठ पर 5 थपथपाहट और 5 पेट के दबाव दें।',
    },
  },
  {
    id: 'q3_bleeding',
    text: {
      en: 'Is there heavy, spurting, or nonstop bleeding from a deep cut or wound?',
      hi: 'क्या किसी गहरे घाव से बहुत तेज़ या लगातार खून बह रहा है?',
    },
    yesIntent: 'severe_bleeding',
    yesRedFlag: {
      en: 'RED FLAG: Press firmly with a clean cloth and call 112.',
      hi: 'गंभीर चेतावनी: साफ कपड़े से कसकर सीधा दबाव बनाए रखें और 112 बुलाएं।',
    },
  },
  {
    id: 'q4_heart_stroke',
    text: {
      en: 'Is there crushing chest pain/cold sweat OR face drooping, one-arm weakness, or slurred speech?',
      hi: 'क्या सीने में दबाव व ठंडा पसीना है, या चेहरा टेढ़ा, एक हाथ में कमजोरी या बोली लड़खड़ा रही है?',
    },
    yesIntent: 'heart_attack',
  },
  {
    id: 'q5_allergy_asthma',
    text: {
      en: 'Are lips/tongue/throat swelling after food/medicine/sting, OR severe wheezing?',
      hi: 'क्या खाने/दवा/डंक के बाद होंठ-जीभ-गला सूज रहा है, या सांस में सीटी की आवाज आ रही है?',
    },
    yesIntent: 'allergic_reaction',
  },
  {
    id: 'q6_seizure_faint',
    text: {
      en: 'Are they having body jerks/fits (seizure), OR fainted while still breathing normally?',
      hi: 'क्या शरीर में झटके/मिर्गी का दौरा आ रहा है, या सामान्य सांस के साथ बेहोशी आई है?',
    },
    yesIntent: 'seizure',
  },
  {
    id: 'q7_burns_shock',
    text: {
      en: 'Did they get burned by fire/hot liquid/chemical, OR suffer an electric shock or near-drowning?',
      hi: 'क्या आग/गर्म पानी/तेजाब से जल गए हैं, बिजली का करंट लगा है, या पानी में डूबे थे?',
    },
    yesIntent: 'burns',
  },
  {
    id: 'q8_bite_poison',
    text: {
      en: 'Were they bitten by a snake or dog/animal, OR did they swallow poison/chemical?',
      hi: 'क्या सांप या कुत्ते/जानवर ने काटा है, या जहर/फिनाइल/दवा अधिक खा ली है?',
    },
    yesIntent: 'snakebite',
  },
  {
    id: 'q9_injury_nose',
    text: {
      en: 'Did they hit their head, break/sprain a bone, or have a nonstop nosebleed?',
      hi: 'क्या सिर में चोट लगी है, हड्डी टूटी/मोच आई है, या नाक से लगातार खून बह रहा है?',
    },
    yesIntent: 'head_injury',
  },
  {
    id: 'q10_heat_sugar',
    text: {
      en: 'Are they overheating from sun/heatstroke, OR shaky & sweaty from low diabetic blood sugar?',
      hi: 'क्या तेज धूप से लू लग गई है, या डायबिटीज में शुगर कम होने से पसीना व कंपकंपी है?',
    },
    yesIntent: 'heatstroke',
  },
];

interface Props {
  lang: Language;
  protocols: EmergencyProtocol[];
  onSelectProtocol: (id: EmergencyId, helperNote?: string) => void;
  onBackHome: () => void;
}

export const GuidedTriagePage: React.FC<Props> = ({
  lang,
  protocols,
  onSelectProtocol,
  onBackHome,
}) => {
  const [idx, setIdx] = useState(0);
  const [showAllFallback, setShowAllFallback] = useState(false);
  const [localPhotoUrl, setLocalPhotoUrl] = useState<string | null>(null);
  const [photoSelectionId, setPhotoSelectionId] = useState<EmergencyId | ''>('');

  const currentQ = TRIAGE_QUESTIONS[idx];
  const progressPct = Math.round(((idx + 1) / TRIAGE_QUESTIONS.length) * 100);

  useEffect(() => {
    if (!showAllFallback && currentQ) {
      speakText(currentQ.text[lang], lang, {allowDuplicate: false});
    }
    return () => {
      stopSpeaking();
    };
  }, [idx, lang, showAllFallback, currentQ]);

  useEffect(() => {
    return () => {
      if (localPhotoUrl) {
        URL.revokeObjectURL(localPhotoUrl);
      }
    };
  }, [localPhotoUrl]);

  const handleAnswer = (answer: 'yes' | 'no' | 'unsure') => {
    primeSpeechSynthesis();
    if (answer === 'yes' && currentQ.yesIntent) {
      const note = currentQ.yesRedFlag ? currentQ.yesRedFlag[lang] : '';
      onSelectProtocol(currentQ.yesIntent, note);
      return;
    }
    if (answer === 'unsure') {
      setShowAllFallback(true);
      return;
    }
    if (idx < TRIAGE_QUESTIONS.length - 1) {
      setIdx((v) => v + 1);
    } else {
      setShowAllFallback(true);
    }
  };

  const handleRestart = () => {
    primeSpeechSynthesis();
    setShowAllFallback(false);
    setIdx(0);
  };

  const handleLocalPhotoPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (localPhotoUrl) {
      URL.revokeObjectURL(localPhotoUrl);
    }
    const url = URL.createObjectURL(file);
    setLocalPhotoUrl(url);
  };

  return (
    <section className="mx-auto max-w-4xl px-4 py-5 pb-24 sm:px-6 md:pb-12 space-y-5">
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

        <button
          type="button"
          onClick={handleRestart}
          className="inline-flex min-h-[48px] items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-[#0F1E36] hover:bg-slate-50"
        >
          <RotateCcw className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{lang === 'hi' ? 'शुरू से करें' : 'Restart Check'}</span>
        </button>
      </div>

      {!showAllFallback && currentQ ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-6 sm:p-8 shadow-sm space-y-6">
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs sm:text-sm font-bold text-slate-600">
              <span>
                {lang === 'hi'
                  ? `सवाल ${idx + 1} / ${TRIAGE_QUESTIONS.length}`
                  : `Triage Question ${idx + 1} of ${TRIAGE_QUESTIONS.length}`}
              </span>
              <span className="font-mono-nums">{progressPct}%</span>
            </div>
            <div className="h-2.5 w-full rounded-full bg-slate-100 overflow-hidden">
              <div
                className="h-full bg-[#DC2626] transition-all"
                style={{width: `${progressPct}%`}}
              />
            </div>
          </div>

          <div className="flex items-start justify-between gap-3">
            <h1 className="text-2xl sm:text-3xl font-extrabold leading-snug text-[#0F1E36]">
              {currentQ.text[lang]}
            </h1>
            <button
              type="button"
              onClick={() => {
                primeSpeechSynthesis();
                speakText(currentQ.text[lang], lang, {allowDuplicate: true});
              }}
              aria-label="Read question aloud"
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-[#0F1E36] hover:bg-slate-200"
            >
              <Volume2 className="h-6 w-6" aria-hidden="true" />
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <button
              type="button"
              onClick={() => handleAnswer('yes')}
              className="flex min-h-[68px] items-center justify-center gap-2 rounded-2xl bg-[#DC2626] px-5 py-4 text-xl font-extrabold text-white shadow-sm hover:bg-red-700"
            >
              <CheckCircle2 className="h-6 w-6 shrink-0" aria-hidden="true" />
              <span>{lang === 'hi' ? 'हाँ (Yes)' : 'Yes'}</span>
            </button>

            <button
              type="button"
              onClick={() => handleAnswer('no')}
              className="flex min-h-[68px] items-center justify-center gap-2 rounded-2xl bg-[#0F1E36] px-5 py-4 text-xl font-extrabold text-white shadow-sm hover:bg-[#162947]"
            >
              <XCircle className="h-6 w-6 shrink-0" aria-hidden="true" />
              <span>{lang === 'hi' ? 'नहीं (No)' : 'No'}</span>
            </button>

            <button
              type="button"
              onClick={() => handleAnswer('unsure')}
              className="flex min-h-[68px] items-center justify-center gap-2 rounded-2xl border-2 border-slate-300 bg-white px-5 py-4 text-lg font-extrabold text-[#0F1E36] hover:bg-slate-50"
            >
              <HelpCircle className="h-6 w-6 shrink-0" aria-hidden="true" />
              <span>{lang === 'hi' ? 'पता नहीं' : 'Not Sure'}</span>
            </button>
          </div>

          {idx > 0 && (
            <button
              type="button"
              onClick={() => setIdx((v) => Math.max(0, v - 1))}
              className="text-sm font-bold text-slate-600 hover:text-[#0F1E36] underline"
            >
              {lang === 'hi' ? 'पिछला सवाल देखें' : 'Go back one question'}
            </button>
          )}
        </div>
      ) : (
        <div className="rounded-3xl border border-amber-300 bg-amber-50 p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 text-lg font-extrabold text-amber-950">
              <ShieldAlert
                className="h-6 w-6 text-[#DC2626] shrink-0"
                aria-hidden="true"
              />
              <span>
                {lang === 'hi'
                  ? 'स्थिति स्पष्ट न हो तो तुरंत 112 पर कॉल करें या नीचे से गाइड चुनें।'
                  : 'If unsure, call 112 right away or choose the closest guide below.'}
              </span>
            </div>
            <a
              href="tel:112"
              className="inline-flex min-h-[48px] items-center gap-2 rounded-xl bg-[#DC2626] px-4 py-2 text-base font-extrabold text-white hover:bg-red-700"
            >
              <PhoneCall className="h-5 w-5" aria-hidden="true" />
              <span>{t(UI_COPY.call112, lang)}</span>
            </a>
          </div>
          <EmergencyTiles
            lang={lang}
            protocols={protocols}
            onSelectProtocol={(id) => onSelectProtocol(id)}
          />
        </div>
      )}

      {/* Local-only visual reference helper; no upload or learning */}
      <div className="rounded-3xl border border-slate-200 bg-white p-5 sm:p-6 shadow-xs space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base sm:text-lg font-extrabold text-[#0F1E36]">
              {lang === 'hi'
                ? 'स्थानीय फोटो संदर्भ (केवल आपके फोन पर)'
                : 'Local Photo Reference (On-Device Only)'}
            </h2>
            <p className="text-xs sm:text-sm text-slate-600">
              {t(UI_COPY.cameraHelperNote, lang)}
            </p>
          </div>
          <label className="inline-flex min-h-[48px] cursor-pointer items-center gap-2 rounded-xl border border-slate-300 bg-slate-50 px-4 py-2 text-sm font-bold text-[#0F1E36] hover:bg-slate-100">
            <Camera className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span>
              {lang === 'hi' ? 'फोटो देखें (अपनें फोन में)' : 'Take / View Photo'}
            </span>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleLocalPhotoPick}
              className="sr-only"
            />
          </label>
        </div>

        {localPhotoUrl && (
          <div className="grid gap-4 sm:grid-cols-2 items-center border-t border-slate-100 pt-4">
            <img
              src={localPhotoUrl}
              alt={
                lang === 'hi'
                  ? 'स्थानीय संदर्भ फोटो'
                  : 'Local emergency reference preview'
              }
              className="max-h-56 w-full rounded-2xl object-cover border border-slate-200"
            />
            <div className="space-y-3">
              <p className="text-sm font-bold text-[#0F1E36]">
                {lang === 'hi'
                  ? 'यह फोटो कहीं अपलोड नहीं होती। इसके अनुसार गाइड चुनें:'
                  : 'This photo stays strictly on your device. Pick the matching guide:'}
              </p>
              <select
                value={photoSelectionId}
                onChange={(e) =>
                  setPhotoSelectionId(e.target.value as EmergencyId)
                }
                className="min-h-[48px] w-full rounded-xl border border-slate-300 bg-white px-3 text-sm font-semibold text-[#0F1E36]"
              >
                <option value="">
                  {lang === 'hi' ? '-- स्थिति चुनें --' : '-- Choose guide --'}
                </option>
                <option value="severe_bleeding">
                  {lang === 'hi' ? 'तेज़ खून बहना / गहरा घाव' : 'Severe Bleeding / Deep Wound'}
                </option>
                <option value="burns">
                  {lang === 'hi' ? 'जलना / फफोले' : 'Burns / Scalds'}
                </option>
                <option value="snakebite">
                  {lang === 'hi' ? 'सांप का काटना' : 'Snakebite'}
                </option>
                <option value="dog_bite">
                  {lang === 'hi' ? 'कुत्ते या जानवर का काटना' : 'Dog / Animal Bite'}
                </option>
                <option value="fracture_injury">
                  {lang === 'hi' ? 'हड्डी टूटना / सूजन' : 'Fracture / Sprain'}
                </option>
                <option value="allergic_reaction">
                  {lang === 'hi' ? 'एलर्जी सूजन / चकत्ते' : 'Allergic Swelling / Hives'}
                </option>
              </select>
              {photoSelectionId && (
                <button
                  type="button"
                  onClick={() => onSelectProtocol(photoSelectionId)}
                  className="min-h-[48px] w-full rounded-xl bg-[#0F1E36] px-4 py-2 text-sm font-extrabold text-white hover:bg-[#162947]"
                >
                  {lang === 'hi' ? 'गाइड खोलें' : 'Open Selected First-Aid Guide'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <footer className="border-t border-slate-200 pt-4 text-center text-sm font-semibold text-slate-600">
        {t(UI_COPY.safetyFooter, lang)}
      </footer>
    </section>
  );
};
