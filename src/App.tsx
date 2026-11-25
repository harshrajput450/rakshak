import {useEffect, useState} from 'react';
import firstAidJson from '../data/firstaid.json';
import {AdminReviewerPage} from '../app/admin/page';
import {GuidedTriagePage} from '../app/triage/page';
import {initSpeechVoices, speakText, stopSpeaking} from '../lib/voice';
import {CPRCoach} from './components/CPRCoach';
import {DisclaimerModal} from './components/DisclaimerModal';
import {EmergencyHeader} from './components/EmergencyHeader';
import {FirstAidGuide} from './components/FirstAidGuide';
import {HomeScreen} from './components/HomeScreen';
import {NearestHospitals} from './components/NearestHospitals';
import {SOSScreen} from './components/SOSScreen';
import {useOnlineStatus} from './hooks/useOnlineStatus';
import type {
  AppView,
  EmergencyId,
  EmergencyProtocol,
  FirstAidKnowledgeBase,
  Language,
} from './types/emergency';

const DISCLAIMER_KEY = 'goldenhour_disclaimer_accepted';
const LANG_KEY = 'goldenhour_lang';

const BUNDLED_KB = firstAidJson as FirstAidKnowledgeBase;

function viewFromPathname(pathname: string): AppView {
  if (pathname === '/triage') return 'triage';
  if (pathname === '/admin') return 'admin';
  return 'home';
}

export default function App() {
  const isOnline = useOnlineStatus();

  const [lang, setLang] = useState<Language>(() => {
    try {
      const saved = localStorage.getItem(LANG_KEY);
      return saved === 'en' ? 'en' : 'hi';
    } catch {
      return 'hi';
    }
  });

  const [disclaimerAccepted, setDisclaimerAccepted] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DISCLAIMER_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const [protocols, setProtocols] = useState<EmergencyProtocol[]>(
    BUNDLED_KB.protocols
  );
  const [activeView, setActiveView] = useState<AppView>(() =>
    typeof window !== 'undefined'
      ? viewFromPathname(window.location.pathname)
      : 'home'
  );
  const [selectedId, setSelectedId] = useState<EmergencyId | null>(null);
  const [helperNote, setHelperNote] = useState<string>('');
  const [queryText, setQueryText] = useState<string>('');
  const [predictedConfidence, setPredictedConfidence] = useState<number>(1);
  const [modelVersion, setModelVersion] = useState<string>('1.0.0');
  const [voiceOnly, setVoiceOnly] = useState(false);
  const [skipInitialAutoSpeak, setSkipInitialAutoSpeak] = useState(false);
  const [cachedHospitalTimestamp, setCachedHospitalTimestamp] = useState<
    string | null
  >(null);
  const [hospitalsCount, setHospitalsCount] = useState<number>(() => {
    try {
      const raw = localStorage.getItem('goldenhour_cached_hospitals_v2');
      if (raw) {
        const parsed = JSON.parse(raw) as {items?: unknown[]; savedAt?: string};
        if (Array.isArray(parsed.items)) return parsed.items.length;
      }
    } catch {
      // Ignore
    }
    return 0;
  });

  useEffect(() => {
    initSpeechVoices();
    const onPopState = () => {
      stopSpeaking();
      setActiveView(viewFromPathname(window.location.pathname));
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
    };
  }, []);

  // Read cached hospital timestamp cleanly without modifying NearestHospitals.tsx
  useEffect(() => {
    if (activeView === 'hospitals') {
      try {
        const raw = localStorage.getItem('goldenhour_cached_hospitals_v2');
        if (raw) {
          const parsed = JSON.parse(raw) as {savedAt?: string; timestamp?: string};
          setCachedHospitalTimestamp(parsed.savedAt || parsed.timestamp || null);
        } else {
          setCachedHospitalTimestamp(null);
        }
      } catch {
        setCachedHospitalTimestamp(null);
      }
    }
  }, [activeView, hospitalsCount]);

  // Sync /data/firstaid.json (served & precached by Service Worker)
  useEffect(() => {
    fetch('/data/firstaid.json')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: FirstAidKnowledgeBase | null) => {
        if (data && Array.isArray(data.protocols) && data.protocols.length) {
          setProtocols(data.protocols);
        }
      })
      .catch(() => {
        // Bundled knowledge base stays active offline
      });
  }, []);

  const handleAcceptDisclaimer = () => {
    setDisclaimerAccepted(true);
    try {
      localStorage.setItem(DISCLAIMER_KEY, 'true');
    } catch {
      // Ignore
    }
  };

  const handleToggleLanguage = () => {
    setLang((prev) => {
      const next = prev === 'hi' ? 'en' : 'hi';
      try {
        localStorage.setItem(LANG_KEY, next);
      } catch {
        // Ignore
      }
      return next;
    });
  };

  const handleToggleVoiceOnly = () => {
    setVoiceOnly((prev) => {
      const next = !prev;
      if (next) {
        speakText(
          lang === 'hi'
            ? 'केवल आवाज़ मोड चालू है। स्थिति चुनें या बोलें।'
            : 'Voice-only mode enabled. Tap an emergency or tap Speak.',
          lang
        );
      } else {
        stopSpeaking();
      }
      return next;
    });
  };

  const handleNavigate = (view: AppView) => {
    stopSpeaking();
    setSkipInitialAutoSpeak(false);
    setActiveView(view);
    if (typeof window !== 'undefined') {
      const targetPath =
        view === 'triage' ? '/triage' : view === 'admin' ? '/admin' : '/';
      if (window.location.pathname !== targetPath) {
        window.history.pushState({}, '', targetPath);
      }
    }
  };

  const handleSelectProtocol = (
    id: EmergencyId,
    note = '',
    skipAutoSpeak = false,
    meta?: {queryText?: string; confidence?: number; modelVersion?: string}
  ) => {
    setSelectedId(id);
    setHelperNote(note);
    setSkipInitialAutoSpeak(skipAutoSpeak);
    setQueryText(meta?.queryText || '');
    setPredictedConfidence(meta?.confidence ?? 1);
    setModelVersion(meta?.modelVersion || '1.0.0');
    setActiveView('guide');
    if (typeof window !== 'undefined' && window.location.pathname !== '/') {
      window.history.pushState({}, '', '/');
    }
  };

  const activeProtocol =
    protocols.find((p) => p.id === selectedId) ?? protocols[0];

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#0F1E36]">
      {!disclaimerAccepted && (
        <DisclaimerModal
          lang={lang}
          onAccept={handleAcceptDisclaimer}
          onToggleLanguage={handleToggleLanguage}
        />
      )}

      <EmergencyHeader
        activeView={activeView}
        onNavigate={handleNavigate}
        lang={lang}
        onToggleLanguage={handleToggleLanguage}
        voiceOnly={voiceOnly}
        onToggleVoiceOnly={handleToggleVoiceOnly}
        isOnline={isOnline}
      />

      {activeView === 'home' && (
        <HomeScreen
          lang={lang}
          isOnline={isOnline}
          protocols={protocols}
          hospitalsCount={hospitalsCount}
          onSelectProtocol={handleSelectProtocol}
          onOpenTriage={() => handleNavigate('triage')}
          onOpenCprCoach={() => handleNavigate('cpr')}
          onOpenSos={() => handleNavigate('sos')}
          onOpenHospitals={() => handleNavigate('hospitals')}
        />
      )}

      {activeView === 'triage' && (
        <GuidedTriagePage
          lang={lang}
          protocols={protocols}
          onSelectProtocol={(id, note = '') =>
            handleSelectProtocol(id, note, false)
          }
          onBackHome={() => handleNavigate('home')}
        />
      )}

      {activeView === 'admin' && (
        <AdminReviewerPage
          lang={lang}
          protocols={protocols}
          onBackHome={() => handleNavigate('home')}
        />
      )}

      {activeView === 'guide' && activeProtocol && (
        <FirstAidGuide
          protocol={activeProtocol}
          allProtocols={protocols}
          lang={lang}
          voiceOnly={voiceOnly}
          isOnline={isOnline}
          helperNote={helperNote}
          queryText={queryText}
          predictedConfidence={predictedConfidence}
          modelVersion={modelVersion}
          skipInitialAutoSpeak={skipInitialAutoSpeak}
          onBackHome={() => handleNavigate('home')}
          onOpenCprCoach={() => handleNavigate('cpr')}
          onSwitchProtocol={(newId) => handleSelectProtocol(newId)}
        />
      )}

      {activeView === 'cpr' && (
        <CPRCoach lang={lang} voiceOnly={voiceOnly} />
      )}

      {activeView === 'sos' && (
        <SOSScreen
          lang={lang}
          protocols={protocols}
          selectedEmergencyId={selectedId ?? undefined}
        />
      )}

      {activeView === 'hospitals' && (
        <>
          {!isOnline && cachedHospitalTimestamp && (
            <div className="mx-auto max-w-4xl px-4 pt-4 sm:px-6">
              <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-xs sm:text-sm font-semibold text-amber-950">
                {lang === 'hi'
                  ? `ऑफ़लाइन कैश्ड अस्पताल सूची (आख़िरी अपडेट: ${new Date(
                      cachedHospitalTimestamp
                    ).toLocaleString()})`
                  : `Showing offline cached hospital list (last synced: ${new Date(
                      cachedHospitalTimestamp
                    ).toLocaleString()})`}
              </div>
            </div>
          )}
          <NearestHospitals
            lang={lang}
            isOnline={isOnline}
            onHospitalsCountChange={setHospitalsCount}
          />
        </>
      )}
    </div>
  );
}
