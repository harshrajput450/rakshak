import React from 'react';
import {PhoneCall, ShieldAlert} from 'lucide-react';
import type {Language} from '../types/emergency';

interface Props {
  lang: Language;
  onAccept: () => void;
  onToggleLanguage: () => void;
}

export const DisclaimerModal: React.FC<Props> = ({
  lang,
  onAccept,
  onToggleLanguage,
}) => {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#0A1628]/85 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="disclaimer-title"
    >
      <div className="w-full max-w-lg rounded-3xl bg-white p-6 sm:p-8 shadow-2xl border border-slate-200">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-red-50 text-[#DC2626]">
              <ShieldAlert className="h-7 w-7" aria-hidden="true" />
            </div>
            <div>
              <h2
                id="disclaimer-title"
                className="text-xl font-extrabold text-[#0F1E36]"
              >
                {lang === 'hi'
                  ? 'रक्षक (Rakshak) सुरक्षा सूचना'
                  : 'रक्षक (Rakshak) Safety Notice'}
              </h2>
            </div>
          </div>

          <button
            type="button"
            onClick={onToggleLanguage}
            className="min-h-[44px] rounded-xl border border-slate-300 bg-slate-50 px-3.5 py-2 text-sm font-bold text-[#0F1E36] hover:bg-slate-100 whitespace-nowrap shrink-0"
          >
            {lang === 'hi' ? 'English' : 'हिंदी'}
          </button>
        </div>

        <div className="mt-5 space-y-3 text-base sm:text-lg text-slate-700 leading-relaxed">
          <p className="font-semibold text-[#0F1E36]">
            {lang === 'hi'
              ? 'यह ऐप केवल डॉक्टर या एम्बुलेंस आने तक प्राथमिक सहायता के मार्गदर्शन के लिए है—और बिना इंटरनेट भी काम करता है।'
              : 'Guidance until help arrives. Not a replacement for doctors—and all first-aid guides work 100% offline.'}
          </p>
          <ul className="space-y-2 list-disc pl-5 text-base text-slate-700">
            <li>
              {lang === 'hi'
                ? 'किसी भी गंभीर आपात स्थिति में हमेशा सबसे पहले 112 पर कॉल करें।'
                : 'Always call 112 first in any life-threatening emergency.'}
            </li>
            <li>
              {lang === 'hi'
                ? 'यह किसी डॉक्टर, चिकित्सा जांच या अस्पताल के इलाज का विकल्प नहीं है।'
                : 'It is not a medical diagnosis and not a replacement for doctors.'}
            </li>
            <li>
              {lang === 'hi'
                ? 'यह ऐप कभी भी किसी दवा की खुराक नहीं बताता।'
                : 'This app never prescribes medications or doses.'}
            </li>
          </ul>
        </div>

        <div className="mt-6 flex flex-col gap-3">
          <a
            href="tel:112"
            className="flex min-h-[56px] w-full items-center justify-center gap-3 rounded-2xl bg-[#DC2626] px-6 py-3.5 text-lg font-extrabold text-white shadow-sm hover:bg-red-700 transition-colors"
          >
            <PhoneCall className="h-6 w-6 shrink-0" aria-hidden="true" />
            <span>
              {lang === 'hi' ? 'अभी 112 पर कॉल करें' : 'Call 112 Right Now'}
            </span>
          </a>

          <button
            type="button"
            onClick={onAccept}
            className="flex min-h-[56px] w-full items-center justify-center rounded-2xl bg-[#0F1E36] px-6 py-3.5 text-lg font-bold text-white hover:bg-[#162947] transition-colors"
          >
            {lang === 'hi'
              ? 'मैं समझ गया / आगे बढ़ें'
              : 'I Understand — Continue'}
          </button>
        </div>
      </div>
    </div>
  );
};
