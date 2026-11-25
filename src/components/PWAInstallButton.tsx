import React, {useState} from 'react';
import {Download, X} from 'lucide-react';
import {usePWAInstall} from '../hooks/usePWAInstall';
import type {Language} from '../types/emergency';

interface Props {
  lang: Language;
}

export const PWAInstallButton: React.FC<Props> = ({lang}) => {
  const {isInstallable, isInstalled, isIOS, install} = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[#0F1E36] px-4 py-2 text-sm font-semibold text-white transition-transform active:scale-[0.98] hover:bg-[#162947] whitespace-nowrap shrink-0"
      >
        <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{lang === 'hi' ? 'ऐप इंस्टॉल करें' : 'Install App'}</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-sm font-semibold text-[#0F1E36] hover:bg-slate-50 whitespace-nowrap shrink-0"
        >
          <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{lang === 'hi' ? 'iPhone पर सेव करें' : 'Install on iOS'}</span>
        </button>

        {showIOSGuide && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ios-install-title"
          >
            <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl border border-slate-200">
              <div className="flex items-start justify-between gap-4">
                <h3
                  id="ios-install-title"
                  className="text-xl font-bold text-[#0F1E36]"
                >
                  {lang === 'hi'
                    ? 'iPhone / iPad पर इंस्टॉल करें'
                    : 'Install on iPhone / iPad'}
                </h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  aria-label="Close"
                  className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-slate-600 hover:bg-slate-100"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <ol className="mt-4 space-y-3 text-base text-slate-700 list-decimal pl-5">
                <li>
                  {lang === 'hi'
                    ? 'Safari में नीचे Share (शेयर) आइकन पर टैप करें।'
                    : 'Tap the Share button in the Safari toolbar.'}
                </li>
                <li>
                  {lang === 'hi'
                    ? 'नीचे स्क्रॉल करें और "Add to Home Screen" चुनें।'
                    : 'Scroll down and tap "Add to Home Screen".'}
                </li>
              </ol>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="mt-6 w-full min-h-[56px] rounded-xl bg-[#0F1E36] text-base font-semibold text-white hover:bg-[#162947]"
              >
                {lang === 'hi' ? 'बंद करें' : 'Close'}
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
