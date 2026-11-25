import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  Activity,
  CheckCircle2,
  Gauge,
  Hand,
  PhoneCall,
  Play,
  RotateCcw,
  Square,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {UI_COPY, t} from '../i18n/translations';
import type {Language} from '../types/emergency';
import {primeSpeechSynthesis, speakText, stopSpeaking} from '../utils/speech';

interface Props {
  lang: Language;
  voiceOnly: boolean;
}

type RhythmState = 'idle' | 'faster' | 'good' | 'slower';

const TARGET_BPM = 110;
const BEAT_INTERVAL_SEC = 60 / TARGET_BPM;
const MIN_COMPRESSION_GAP_MS = 320;

export const CPRCoach: React.FC<Props> = ({lang, voiceOnly}) => {
  const [isRunning, setIsRunning] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [compressions, setCompressions] = useState(0);
  const [cpm, setCpm] = useState<number>(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [rhythm, setRhythm] = useState<RhythmState>('idle');
  const [sensorStatus, setSensorStatus] = useState<
    'ready' | 'active' | 'tap_fallback'
  >('ready');
  const [breathPromptActive, setBreathPromptActive] = useState(false);
  const [beatFlash, setBeatFlash] = useState(false);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const nextNoteTimeRef = useRef(0);
  const schedulerTimerRef = useRef<number | null>(null);
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;

  const timestampsRef = useRef<number[]>([]);
  const lastCompressionMsRef = useRef(0);
  const lastVoiceFeedbackMsRef = useRef(0);
  const avgMagRef = useRef(9.81);
  const compressionsRef = useRef(0);
  const lastSpokenBreathCountRef = useRef(0);

  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60)
      .toString()
      .padStart(2, '0');
    const s = (sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  const scheduleClick = useCallback((time: number) => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;

    if (soundEnabledRef.current) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(880, time);
      osc.frequency.exponentialRampToValueAtTime(440, time + 0.045);

      gain.gain.setValueAtTime(0.4, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.06);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(time);
      osc.stop(time + 0.065);
    }

    const delayMs = Math.max(0, (time - ctx.currentTime) * 1000);
    window.setTimeout(() => {
      setBeatFlash(true);
      window.setTimeout(() => setBeatFlash(false), 140);
    }, delayMs);
  }, []);

  const registerCompression = useCallback(
    (source: 'sensor' | 'tap') => {
      const now = performance.now();
      if (now - lastCompressionMsRef.current < MIN_COMPRESSION_GAP_MS) {
        return;
      }
      lastCompressionMsRef.current = now;

      if (source === 'sensor') {
        setSensorStatus('active');
      }

      const history = [...timestampsRef.current, now].filter(
        (ts) => now - ts <= 5500
      );
      timestampsRef.current = history;

      let computedCpm = 0;
      if (history.length >= 3) {
        const spanMin = (history[history.length - 1] - history[0]) / 60000;
        if (spanMin > 0) {
          computedCpm = Math.round((history.length - 1) / spanMin);
        }
      }
      setCpm(computedCpm);

      let nextRhythm: RhythmState = 'idle';
      if (computedCpm > 0) {
        if (computedCpm < 100) nextRhythm = 'faster';
        else if (computedCpm > 120) nextRhythm = 'slower';
        else nextRhythm = 'good';
      }
      setRhythm(nextRhythm);

      const nextCount = compressionsRef.current + 1;
      compressionsRef.current = nextCount;
      setCompressions(nextCount);

      if (nextCount > 0 && nextCount % 30 === 0) {
        setBreathPromptActive(true);
        if (lastSpokenBreathCountRef.current !== nextCount) {
          lastSpokenBreathCountRef.current = nextCount;
          speakText(
            lang === 'hi'
              ? '30 बार पूरा! 2 बार मुंह से सांस दें, या लगातार सीना दबाते रहें।'
              : '30 compressions! Give 2 rescue breaths, or continue hands-only.',
            lang
          );
        }
      } else if (nextCount % 30 === 3) {
        setBreathPromptActive(false);
      } else if (
        nextRhythm !== 'idle' &&
        now - lastVoiceFeedbackMsRef.current > 4500
      ) {
        lastVoiceFeedbackMsRef.current = now;
        const phrase =
          nextRhythm === 'faster'
            ? lang === 'hi'
              ? 'तेज़ दबाएं'
              : 'Push faster'
            : nextRhythm === 'slower'
            ? lang === 'hi'
              ? 'थोड़ा धीरे दबाएं'
              : 'Slow down slightly'
            : lang === 'hi'
            ? 'अच्छी गति'
            : 'Good rhythm';
        speakText(phrase, lang);
      }
    },
    [lang]
  );

  useEffect(() => {
    if (!isRunning) {
      if (schedulerTimerRef.current) {
        window.clearInterval(schedulerTimerRef.current);
        schedulerTimerRef.current = null;
      }
      return;
    }

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as {webkitAudioContext: typeof AudioContext})
        .webkitAudioContext;

    if (!audioCtxRef.current && AudioCtx) {
      audioCtxRef.current = new AudioCtx();
    }
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    if (ctx) {
      nextNoteTimeRef.current = ctx.currentTime + 0.05;
      schedulerTimerRef.current = window.setInterval(() => {
        if (!audioCtxRef.current) return;
        while (
          nextNoteTimeRef.current <
          audioCtxRef.current.currentTime + 0.12
        ) {
          scheduleClick(nextNoteTimeRef.current);
          nextNoteTimeRef.current += BEAT_INTERVAL_SEC;
        }
      }, 25);
    }

    const secTimer = window.setInterval(() => {
      setElapsedSec((s) => s + 1);
    }, 1000);

    return () => {
      if (schedulerTimerRef.current) {
        window.clearInterval(schedulerTimerRef.current);
        schedulerTimerRef.current = null;
      }
      window.clearInterval(secTimer);
    };
  }, [isRunning, scheduleClick]);

  useEffect(() => {
    if (!isRunning) return;

    let sawMotion = false;
    const fallbackTimeout = window.setTimeout(() => {
      if (!sawMotion) {
        setSensorStatus('tap_fallback');
      }
    }, 1600);

    const handleMotion = (event: DeviceMotionEvent) => {
      const acc = event.accelerationIncludingGravity || event.acceleration;
      if (!acc) return;
      const x = acc.x ?? 0;
      const y = acc.y ?? 0;
      const z = acc.z ?? 0;
      if (x === 0 && y === 0 && z === 0) return;

      sawMotion = true;
      const mag = Math.sqrt(x * x + y * y + z * z);
      avgMagRef.current = avgMagRef.current * 0.85 + mag * 0.15;
      const delta = mag - avgMagRef.current;

      if (delta > 2.6) {
        registerCompression('sensor');
      }
    };

    window.addEventListener('devicemotion', handleMotion);
    return () => {
      window.clearTimeout(fallbackTimeout);
      window.removeEventListener('devicemotion', handleMotion);
    };
  }, [isRunning, registerCompression]);

  useEffect(() => {
    return () => {
      stopSpeaking();
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
    };
  }, []);

  const handleStartStop = async () => {
    if (isRunning) {
      setIsRunning(false);
      stopSpeaking();
      return;
    }

    primeSpeechSynthesis();

    const DM = window.DeviceMotionEvent as unknown as {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };
    if (DM && typeof DM.requestPermission === 'function') {
      try {
        const perm = await DM.requestPermission();
        if (perm !== 'granted') {
          setSensorStatus('tap_fallback');
        }
      } catch {
        setSensorStatus('tap_fallback');
      }
    } else if (!('DeviceMotionEvent' in window)) {
      setSensorStatus('tap_fallback');
    }

    setIsRunning(true);
    speakText(
      lang === 'hi'
        ? 'सीपीआर कोच शुरू। आवाज़ की गति के साथ सीना दबाएं।'
        : 'CPR Coach started. Push hard and fast with the beat.',
      lang
    );
  };

  const handleReset = () => {
    setIsRunning(false);
    stopSpeaking();
    compressionsRef.current = 0;
    setCompressions(0);
    setCpm(0);
    setElapsedSec(0);
    setRhythm('idle');
    setBreathPromptActive(false);
    timestampsRef.current = [];
    lastCompressionMsRef.current = 0;
    lastSpokenBreathCountRef.current = 0;
  };

  const rhythmDisplay = {
    idle: {
      label:
        lang === 'hi'
          ? 'बीट के साथ दबाएं या सर्कल टैप करें'
          : 'Push to the beat or tap circle',
      badgeClass: 'bg-slate-100 text-[#0F1E36] border-slate-300',
    },
    faster: {
      label: lang === 'hi' ? 'तेज़ दबाएं (Push Faster)' : 'Push Faster (<100 CPM)',
      badgeClass: 'bg-amber-100 text-amber-950 border-amber-400',
    },
    good: {
      label: lang === 'hi' ? 'अच्छी गति (Good Rhythm)' : 'Good Rhythm (100–120 CPM)',
      badgeClass: 'bg-emerald-100 text-emerald-950 border-emerald-500',
    },
    slower: {
      label: lang === 'hi' ? 'थोड़ा धीरे दबाएं (Slow Down)' : 'Slow Down (>120 CPM)',
      badgeClass: 'bg-red-100 text-red-950 border-red-400',
    },
  }[rhythm];

  return (
    <section className="mx-auto max-w-4xl px-4 py-5 pb-24 sm:px-6 md:pb-12">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-[#0F1E36]">
            {lang === 'hi' ? 'लाइव सीपीआर कोच' : 'Live CPR Coach'}
          </h1>
          <p className="text-base text-slate-600">
            {lang === 'hi'
              ? '110 बीट प्रति मिनट · गहराई ~5 सेमी'
              : '110 BPM Metronome · Push hard & fast (~5 cm)'}
          </p>
        </div>

        <button
          type="button"
          onClick={() => setSoundEnabled((s) => !s)}
          className="inline-flex min-h-[48px] items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-[#0F1E36] hover:bg-slate-50"
        >
          {soundEnabled ? (
            <Volume2 className="h-5 w-5 text-[#DC2626]" aria-hidden="true" />
          ) : (
            <VolumeX className="h-5 w-5 text-slate-500" aria-hidden="true" />
          )}
          <span>
            {soundEnabled
              ? lang === 'hi'
                ? 'बीप चालू'
                : 'Beat Sound On'
              : lang === 'hi'
              ? 'बीप बंद'
              : 'Beat Muted'}
          </span>
        </button>
      </div>

      {breathPromptActive && (
        <div
          role="alert"
          className="mt-4 rounded-2xl border-2 border-[#DC2626] bg-red-50 p-4 text-center"
        >
          <p className="text-xl font-extrabold text-[#DC2626]">
            {lang === 'hi'
              ? '30 बार पूरा! 2 बार मुंह से सांस दें, या लगातार हाथ से दबाते रहें।'
              : '30 Compressions! Give 2 rescue breaths, or continue hands-only.'}
          </p>
        </div>
      )}

      <div className="mt-5 rounded-3xl border border-slate-200 bg-white p-6 sm:p-8 shadow-sm">
        <div className="flex flex-col items-center">
          <div
            role="status"
            className={`inline-flex items-center gap-2 rounded-2xl border px-4 py-2 text-base sm:text-lg font-extrabold ${rhythmDisplay.badgeClass}`}
          >
            {rhythm === 'good' ? (
              <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
            ) : (
              <Gauge className="h-5 w-5 shrink-0" aria-hidden="true" />
            )}
            <span>{rhythmDisplay.label}</span>
          </div>

          <div className="my-7 flex items-center justify-center">
            <button
              type="button"
              onClick={() => {
                if (!isRunning) {
                  handleStartStop();
                }
                registerCompression('tap');
              }}
              aria-label={
                lang === 'hi'
                  ? 'हर दबाव के साथ यहाँ टैप करें'
                  : 'Tap here with each chest compression'
              }
              className={`relative flex h-56 w-56 sm:h-64 sm:w-64 flex-col items-center justify-center rounded-full border-8 transition-transform duration-100 select-none active:scale-95 ${
                isRunning
                  ? beatFlash
                    ? 'scale-105 border-[#DC2626] bg-[#DC2626] text-white shadow-xl'
                    : 'border-[#DC2626] bg-[#0F1E36] text-white shadow-lg'
                  : 'border-slate-300 bg-[#0F1E36] text-white hover:bg-[#162947]'
              }`}
            >
              <span className="font-mono-nums text-5xl sm:text-6xl font-extrabold tracking-tight">
                {compressions}
              </span>
              <span className="mt-1 text-sm font-bold tracking-wide text-red-200">
                {lang === 'hi' ? 'दबाव (Compressions)' : 'COMPRESSIONS'}
              </span>
              <span className="mt-3 inline-flex items-center gap-1.5 rounded-xl bg-white/15 px-3 py-1 text-xs font-bold text-white">
                <Hand className="h-4 w-4" aria-hidden="true" />
                <span>
                  {lang === 'hi' ? 'टैप करके जांचें' : 'Tap to Count'}
                </span>
              </span>
            </button>
          </div>

          <div className="grid w-full max-w-lg grid-cols-3 gap-3 text-center">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-bold text-slate-500">
                {lang === 'hi' ? 'आपकी गति' : 'YOUR PACE'}
              </p>
              <p className="font-mono-nums mt-1 text-2xl font-extrabold text-[#0F1E36]">
                {cpm > 0 ? cpm : '--'}
              </p>
              <p className="text-xs font-semibold text-slate-500">CPM</p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-bold text-slate-500">
                {lang === 'hi' ? 'लक्ष्य गति' : 'TARGET'}
              </p>
              <p className="font-mono-nums mt-1 text-2xl font-extrabold text-[#DC2626]">
                110
              </p>
              <p className="text-xs font-semibold text-slate-500">BPM</p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-bold text-slate-500">
                {lang === 'hi' ? 'समय' : 'TIMER'}
              </p>
              <p className="font-mono-nums mt-1 text-2xl font-extrabold text-[#0F1E36]">
                {formatTime(elapsedSec)}
              </p>
              <p className="text-xs font-semibold text-slate-500">MM:SS</p>
            </div>
          </div>

          <div className="mt-6 flex w-full max-w-lg flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={handleStartStop}
              className={`flex min-h-[60px] flex-1 items-center justify-center gap-2.5 rounded-2xl px-6 text-lg font-extrabold text-white transition-colors ${
                isRunning
                  ? 'bg-[#0F1E36] hover:bg-[#162947]'
                  : 'bg-[#DC2626] hover:bg-red-700'
              }`}
            >
              {isRunning ? (
                <>
                  <Square className="h-5 w-5 shrink-0" aria-hidden="true" />
                  <span>{lang === 'hi' ? 'रोकें' : 'Stop Coach'}</span>
                </>
              ) : (
                <>
                  <Play className="h-5 w-5 shrink-0" aria-hidden="true" />
                  <span>
                    {lang === 'hi' ? 'सीपीआर कोच शुरू करें' : 'Start CPR Coach'}
                  </span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={handleReset}
              className="flex min-h-[60px] items-center justify-center gap-2 rounded-2xl border border-slate-300 bg-white px-5 text-base font-bold text-[#0F1E36] hover:bg-slate-50"
            >
              <RotateCcw className="h-5 w-5 shrink-0" aria-hidden="true" />
              <span>{lang === 'hi' ? 'रीसेट' : 'Reset'}</span>
            </button>
          </div>
        </div>
      </div>

      {!voiceOnly && (
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex items-center gap-2 text-base font-bold text-[#0F1E36]">
              <Activity className="h-5 w-5 text-[#DC2626]" aria-hidden="true" />
              <span>
                {sensorStatus === 'active'
                  ? lang === 'hi'
                    ? 'मोशन सेंसर सक्रिय है'
                    : 'Motion Sensor Active'
                  : sensorStatus === 'tap_fallback'
                  ? lang === 'hi'
                    ? 'टैप मोड सक्रिय (सेंसर उपलब्ध नहीं)'
                    : 'Tap Mode Active (No Motion Sensor)'
                  : lang === 'hi'
                  ? 'सेंसर और टैप दोनों तैयार'
                  : 'Motion Sensor & Tap Ready'}
              </span>
            </div>
            <p className="mt-1.5 text-sm text-slate-600">
              {lang === 'hi'
                ? 'फोन को सीने के पास समतल रखें या लैपटॉप/डेस्कटॉप पर बड़े सर्कल को बीट के साथ टैप करें।'
                : 'Keep phone flat near the chest for automatic compression detection, or tap the pulse circle directly on laptop/desktop.'}
            </p>
            <p className="mt-1.5 text-xs font-semibold text-amber-900">
              {lang === 'hi'
                ? 'नोट: एक्सेलेरोमीटर रीडिंग केवल गति का अनुमान देती हैं; ये चिकित्सकीय रूप से सटीक गहराई या बल मापन नहीं हैं।'
                : 'Note: Accelerometer readings provide approximate rhythm guidance only and are not clinically accurate compression measurements.'}
            </p>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 p-4">
            <p className="text-sm font-bold text-[#0F1E36]">
              {lang === 'hi'
                ? 'किसी से 112 पर कॉल करवाएं और फोन स्पीकर पर रखें।'
                : 'Have someone call 112 and keep phone on speaker.'}
            </p>
            <a
              href="tel:112"
              className="inline-flex min-h-[48px] shrink-0 items-center gap-1.5 rounded-xl bg-[#DC2626] px-4 py-2 text-sm font-extrabold text-white hover:bg-red-700"
            >
              <PhoneCall className="h-4 w-4" aria-hidden="true" />
              <span>112</span>
            </a>
          </div>
        </div>
      )}

      <footer className="mt-6 border-t border-slate-200 pt-4 text-center text-sm font-semibold text-slate-600">
        {t(UI_COPY.safetyFooter, lang)}
      </footer>
    </section>
  );
};
