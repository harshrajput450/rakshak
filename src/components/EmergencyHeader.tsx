import React from 'react';
import {
  ClipboardCheck,
  HeartPulse,
  Hospital,
  PhoneCall,
  Share2,
  ShieldPlus,
  Volume2,
  VolumeX,
  WifiOff,
} from 'lucide-react';
import {UI_COPY, t} from '../i18n/translations';
import type {AppView, Language} from '../types/emergency';
import {PWAInstallButton} from './PWAInstallButton';

interface Props {
  activeView: AppView;
  onNavigate: (view: AppView) => void;
  lang: Language;
  onToggleLanguage: () => void;
  voiceOnly: boolean;
  onToggleVoiceOnly: () => void;
  isOnline: boolean;
}

export const EmergencyHeader: React.FC<Props> = ({
  activeView,
  onNavigate,
  lang,
  onToggleLanguage,
  voiceOnly,
  onToggleVoiceOnly,
  isOnline,
}) => {
  const navItems: {id: AppView; label: string; icon: React.ReactNode}[] = [
    {
      id: 'home',
      label: t(UI_COPY.navHome, lang),
      icon: <ShieldPlus className="h-5 w-5" aria-hidden="true" />,
    },
    {
      id: 'triage',
      label: t(UI_COPY.navTriage, lang),
      icon: <ClipboardCheck className="h-5 w-5" aria-hidden="true" />,
    },
    {
      id: 'cpr',
      label: t(UI_COPY.navCpr, lang),
      icon: <HeartPulse className="h-5 w-5" aria-hidden="true" />,
    },
    {
      id: 'sos',
      label: t(UI_COPY.navSos, lang),
      icon: <Share2 className="h-5 w-5" aria-hidden="true" />,
    },
    {
      id: 'hospitals',
      label: t(UI_COPY.navHospitals, lang),
      icon: <Hospital className="h-5 w-5" aria-hidden="true" />,
    },
  ];

  const effectiveActive = activeView === 'guide' ? 'home' : activeView;

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <button
            type="button"
            onClick={() => onNavigate('home')}
            aria-label="रक्षक होम"
            className="inline-flex items-center gap-2.5 text-left text-xl sm:text-2xl font-extrabold tracking-tight text-[#0F1E36] whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0F1E36]"
          >
            <svg
              viewBox="0 0 36 36"
              className="h-8 w-8 shrink-0"
              aria-hidden="true"
            >
              <path
                d="M18 2L4 7.8v9.8c0 8.8 5.9 16.2 14 18.4 8.1-2.2 14-9.6 14-18.4V7.8L18 2z"
                fill="#0F1E36"
              />
              <path
                d="M18 4.8L6.8 9.5v8.1c0 7.3 4.8 13.5 11.2 15.5 6.4-2 11.2-8.2 11.2-15.5V9.5L18 4.8z"
                fill="#FFFFFF"
              />
              <path
                d="M18 6.8L8.8 10.7v6.9c0 6.2 4 11.5 9.2 13.3 5.2-1.8 9.2-7.1 9.2-13.3v-6.9L18 6.8z"
                fill="#0F1E36"
              />
              <rect x="16" y="12" width="4" height="12" rx="1" fill="#DC2626" />
              <rect x="12" y="16" width="12" height="4" rx="1" fill="#DC2626" />
            </svg>
            <span className="leading-none">रक्षक</span>
          </button>

          <nav
            className="hidden md:flex items-center gap-6 text-sm lg:text-base font-semibold text-slate-600"
            aria-label="Primary Navigation"
          >
            {navItems.map((item) => {
              const isActive = effectiveActive === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onNavigate(item.id)}
                  className={`py-1.5 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
                    isActive
                      ? 'border-[#DC2626] text-[#0F1E36]'
                      : 'border-transparent hover:text-[#0F1E36]'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>

          <div className="shrink-0">
            <a
              href="tel:112"
              className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-[#DC2626] px-4 py-2 text-sm sm:text-base font-extrabold text-white hover:bg-red-700 active:scale-[0.98] transition-colors whitespace-nowrap shrink-0"
            >
              <PhoneCall className="h-4 w-4 sm:h-5 sm:w-5 shrink-0" aria-hidden="true" />
              <span>{t(UI_COPY.call112, lang)}</span>
            </a>
          </div>
        </div>
      </header>

      <div className="border-b border-slate-200 bg-white">
        {!isOnline && (
          <div
            role="status"
            className="bg-amber-600 px-4 py-2 text-sm font-semibold text-white"
          >
            <div className="mx-auto flex max-w-6xl items-center gap-2">
              <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{t(UI_COPY.offlineBanner, lang)}</span>
            </div>
          </div>
        )}

        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-2 sm:px-6">
          <div className="flex flex-wrap items-center gap-2.5">
            <div
              className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5"
              role="group"
              aria-label="Language selection"
            >
              <button
                type="button"
                onClick={() => lang !== 'hi' && onToggleLanguage()}
                className={`min-h-[38px] rounded-md px-3 py-1 text-sm font-bold transition-colors whitespace-nowrap shrink-0 ${
                  lang === 'hi'
                    ? 'bg-[#0F1E36] text-white'
                    : 'text-slate-700 hover:text-[#0F1E36]'
                }`}
              >
                हिंदी
              </button>
              <button
                type="button"
                onClick={() => lang !== 'en' && onToggleLanguage()}
                className={`min-h-[38px] rounded-md px-3 py-1 text-sm font-bold transition-colors whitespace-nowrap shrink-0 ${
                  lang === 'en'
                    ? 'bg-[#0F1E36] text-white'
                    : 'text-slate-700 hover:text-[#0F1E36]'
                }`}
              >
                English
              </button>
            </div>

            <button
              type="button"
              onClick={onToggleVoiceOnly}
              aria-pressed={voiceOnly}
              className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs sm:text-sm font-bold transition-colors whitespace-nowrap shrink-0 ${
                voiceOnly
                  ? 'border-[#0F1E36] bg-[#0F1E36] text-white'
                  : 'border-slate-300 bg-white text-[#0F1E36] hover:bg-slate-50'
              }`}
            >
              {voiceOnly ? (
                <Volume2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              ) : (
                <VolumeX className="h-4 w-4 shrink-0" aria-hidden="true" />
              )}
              <span>{t(UI_COPY.voiceOnlyLabel, lang)}</span>
            </button>
          </div>

          <PWAInstallButton lang={lang} />
        </div>
      </div>

      <nav
        className="fixed bottom-0 left-0 right-0 z-40 border-t border-slate-200 bg-white md:hidden"
        aria-label="Mobile Navigation"
      >
        <div className="grid grid-cols-5 h-15">
          {navItems.map((item) => {
            const isActive = effectiveActive === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                className={`flex flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-bold transition-colors ${
                  isActive
                    ? 'text-[#DC2626]'
                    : 'text-slate-600 hover:text-[#0F1E36]'
                }`}
              >
                {item.icon}
                <span className="truncate max-w-full">{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </>
  );
};
