import React, {useCallback, useEffect, useState} from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  HelpCircle,
  RefreshCw,
  Wrench,
  XCircle,
} from 'lucide-react';
import {
  formatInputLanguageLabel,
  getRuntimeDiagnostics,
  subscribeRuntimeDiagnostics,
} from '../../lib/diagnosticsStore';
import {getModelStatusSnapshot} from '../../lib/modelUpdater';
import {
  flushSupabaseOfflineQueue,
  getSupabaseDiagnostics,
  initializeSupabaseTelemetry,
  subscribeSupabaseDiagnostics,
} from '../../lib/supabaseClient';
import {
  isSpeechRecognitionSupported,
  isSpeechSynthesisSupported,
} from '../../lib/voice';
import type {HospitalDataSource, Language} from '../types/emergency';

export interface HospitalDebugInfo {
  coords?: {lat: number; lng: number} | null;
  accuracyMeters?: number | null;
  radiusUsedMeters?: number | null;
  dataSource?: HospitalDataSource | 'idle';
  apiError?: string;
}

interface Props {
  lang: Language;
  hospitalsCount: number;
  defaultOpen?: boolean;
  hospitalDebug?: HospitalDebugInfo;
  refreshTrigger?: number;
}

type PermState = 'checking' | 'granted' | 'prompt' | 'denied' | 'unsupported';
type ApiReachableState = 'checking' | 'reachable' | 'unreachable';

function detectIframe(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export const DiagnosticsPanel: React.FC<Props> = ({
  lang,
  hospitalsCount,
  defaultOpen = false,
  hospitalDebug,
  refreshTrigger = 0,
}) => {
  const [open, setOpen] = useState(defaultOpen);
  const [micPermission, setMicPermission] = useState<PermState>('checking');
  const [locationPermission, setLocationPermission] =
    useState<PermState>('checking');
  const [apiStatus, setApiStatus] = useState<ApiReachableState>('checking');
  const [apiDetail, setApiDetail] = useState('');
  const [runtimeDiag, setRuntimeDiag] = useState(getRuntimeDiagnostics);
  const [supabaseDiag, setSupabaseDiag] = useState(getSupabaseDiagnostics);
  const [runningInsideIframe] = useState(detectIframe);

  const modelStatus = getModelStatusSnapshot();
  const speechRecSupported = isSpeechRecognitionSupported();
  const speechSynthSupported = isSpeechSynthesisSupported();
  const isHttps =
    typeof window !== 'undefined'
      ? window.isSecureContext || window.location.hostname === 'localhost'
      : true;

  useEffect(() => {
    void initializeSupabaseTelemetry();
    const unsubRuntime = subscribeRuntimeDiagnostics(() => {
      setRuntimeDiag(getRuntimeDiagnostics());
    });
    const unsubSupa = subscribeSupabaseDiagnostics(() => {
      setSupabaseDiag(getSupabaseDiagnostics());
    });
    return () => {
      unsubRuntime();
      unsubSupa();
    };
  }, []);

  const checkPermissions = useCallback(async () => {
    if (typeof navigator === 'undefined') {
      setMicPermission('unsupported');
      setLocationPermission('unsupported');
      return;
    }

    if (!navigator.permissions || !navigator.permissions.query) {
      setMicPermission('prompt');
      setLocationPermission(
        'geolocation' in navigator ? 'prompt' : 'unsupported'
      );
      return;
    }

    try {
      const mic = await navigator.permissions.query({
        name: 'microphone' as PermissionName,
      });
      setMicPermission(mic.state as PermState);
      mic.onchange = () => setMicPermission(mic.state as PermState);
    } catch {
      setMicPermission('prompt');
    }

    try {
      const geo = await navigator.permissions.query({
        name: 'geolocation' as PermissionName,
      });
      setLocationPermission(geo.state as PermState);
      geo.onchange = () => setLocationPermission(geo.state as PermState);
    } catch {
      setLocationPermission(
        'geolocation' in navigator ? 'prompt' : 'unsupported'
      );
    }
  }, []);

  const requestMicCheck = async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setMicPermission('unsupported');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio: true});
      stream.getTracks().forEach((tr) => tr.stop());
      setMicPermission('granted');
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setMicPermission('denied');
      } else {
        setMicPermission('unsupported');
      }
    }
  };

  const checkApiHealth = useCallback(async () => {
    setApiStatus('checking');
    setApiDetail('');
    try {
      const healthRes = await fetch('/api/health', {cache: 'no-store'});
      if (!healthRes.ok) {
        setApiStatus('unreachable');
        setApiDetail(`HTTP ${healthRes.status}`);
      } else {
        const data = (await healthRes.json()) as {status?: string};
        setApiStatus(data.status === 'ok' ? 'reachable' : 'unreachable');
      }
    } catch (err) {
      setApiStatus('unreachable');
      setApiDetail(err instanceof Error ? err.message : 'Offline');
    }
    setSupabaseDiag(getSupabaseDiagnostics());
  }, []);

  useEffect(() => {
    checkPermissions();
    checkApiHealth();
  }, [checkPermissions, checkApiHealth, refreshTrigger]);

  const renderBadge = (ok: boolean | null, text: string) => {
    if (ok === null) {
      return (
        <span className="inline-flex items-center gap-1.5 text-sm font-bold text-slate-700">
          <HelpCircle
            className="h-4 w-4 text-amber-600 shrink-0"
            aria-hidden="true"
          />
          <span>{text}</span>
        </span>
      );
    }
    return ok ? (
      <span className="inline-flex items-center gap-1.5 text-sm font-bold text-emerald-800">
        <CheckCircle2
          className="h-4 w-4 text-emerald-700 shrink-0"
          aria-hidden="true"
        />
        <span>{text}</span>
      </span>
    ) : (
      <span className="inline-flex items-center gap-1.5 text-sm font-bold text-red-700">
        <XCircle
          className="h-4 w-4 text-[#DC2626] shrink-0"
          aria-hidden="true"
        />
        <span>{text}</span>
      </span>
    );
  };

  const formatPerm = (p: PermState) => {
    if (p === 'granted')
      return lang === 'hi' ? 'अनुमति मिली (granted)' : 'granted';
    if (p === 'denied')
      return lang === 'hi' ? 'अस्वीकृत (denied)' : 'denied';
    if (p === 'prompt') return lang === 'hi' ? 'पूछेगा (prompt)' : 'prompt';
    if (p === 'checking') return 'checking...';
    return 'unsupported';
  };

  const formatSource = (src?: HospitalDataSource | 'idle') => {
    if (src === 'osm') return 'OSM / Overpass';
    if (src === 'cache') return 'Cache';
    return '—';
  };

  const languageInUse = formatInputLanguageLabel(
    runtimeDiag.inputVoiceLang,
    runtimeDiag.activeRecLang
  );
  const combinedLastError =
    hospitalDebug?.apiError ||
    runtimeDiag.lastError ||
    supabaseDiag.lastError ||
    '';

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-[48px] w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-bold text-[#0F1E36] hover:bg-slate-50 rounded-2xl"
      >
        <span className="inline-flex items-center gap-2">
          <Wrench
            className="h-4 w-4 text-slate-500 shrink-0"
            aria-hidden="true"
          />
          <span>
            {lang === 'hi'
              ? 'डिबग व सिस्टम डायग्नोस्टिक्स (Debug Panel)'
              : 'System Debug & Diagnostics Panel'}
          </span>
        </span>

        <span className="inline-flex items-center gap-2 text-xs font-semibold text-slate-500">
          <span>
            {hospitalDebug
              ? `OSM · Found: ${hospitalsCount}`
              : `Assistance: ${runtimeDiag.lastAiStatus} · Queue: ${supabaseDiag.queuedRows}`}
          </span>
          {open ? (
            <ChevronUp className="h-4 w-4 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
          )}
        </span>
      </button>

      {open && (
        <div className="border-t border-slate-100 px-4 py-3.5 space-y-3 text-sm">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-extrabold uppercase tracking-wide text-slate-600">
                Voice, Assistance &amp; Storage Telemetry
              </span>
              <div className="flex items-center gap-2">
                {supabaseDiag.queuedRows > 0 && (
                  <button
                    type="button"
                    onClick={() => void flushSupabaseOfflineQueue()}
                    className="min-h-[34px] rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-bold text-[#0F1E36] hover:bg-slate-100"
                  >
                    Flush Queue ({supabaseDiag.queuedRows})
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    checkPermissions();
                    checkApiHealth();
                  }}
                  aria-label="Refresh diagnostics"
                  className="min-h-[34px] rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-bold text-[#0F1E36] hover:bg-slate-100 inline-flex items-center gap-1 whitespace-nowrap"
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{lang === 'hi' ? 'रीफ्रेश' : 'Refresh'}</span>
                </button>
              </div>
            </div>

            <div className="grid gap-1.5 sm:grid-cols-2 text-xs sm:text-sm">
              <div className="flex items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-1.5 border border-slate-200">
                <span className="font-semibold text-slate-600">
                  Running inside iframe:
                </span>
                <span className="font-mono-nums font-bold text-[#0F1E36]">
                  {runningInsideIframe ? 'yes' : 'no'}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-1.5 border border-slate-200">
                <span className="font-semibold text-slate-600">
                  Language in use:
                </span>
                <span className="font-mono-nums font-bold text-[#0F1E36]">
                  {languageInUse}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-1.5 border border-slate-200">
                <span className="font-semibold text-slate-600">
                  Last assistance status:
                </span>
                <span className="font-mono-nums font-bold text-[#0F1E36]">
                  {runtimeDiag.lastAiStatus}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-1.5 border border-slate-200">
                <span className="font-semibold text-slate-600">
                  Offline Model:
                </span>
                <span className="font-mono-nums font-bold text-[#0F1E36]">
                  v{modelStatus.activeVersion} (
                  {modelStatus.verified ? 'SHA-256 OK' : 'Local'})
                </span>
              </div>

              <div className="flex items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-1.5 border border-slate-200">
                <span className="font-semibold text-slate-600">
                  Supabase connected:
                </span>
                <span className="font-mono-nums font-bold text-[#0F1E36]">
                  {supabaseDiag.connected ? 'yes' : 'no'}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-1.5 border border-slate-200">
                <span className="font-semibold text-slate-600">
                  Queued rows:
                </span>
                <span className="font-mono-nums font-bold text-[#0F1E36]">
                  {supabaseDiag.queuedRows}
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-slate-600">
              {lang === 'hi' ? 'स्पीच सपोर्ट:' : 'Speech Support:'}
            </span>
            {renderBadge(
              speechRecSupported,
              speechRecSupported
                ? `Yes (TTS: ${speechSynthSupported ? 'Yes' : 'No'}, HTTPS: ${
                    isHttps ? 'Yes' : 'No'
                  })`
                : `No (Use Chrome · TTS: ${
                    speechSynthSupported ? 'Yes' : 'No'
                  })`
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-slate-600">
              {lang === 'hi' ? 'माइक्रोफोन अनुमति:' : 'Mic Permission:'}
            </span>
            <div className="flex items-center gap-2">
              {renderBadge(
                micPermission === 'granted'
                  ? true
                  : micPermission === 'denied'
                  ? false
                  : null,
                formatPerm(micPermission)
              )}
              <button
                type="button"
                onClick={requestMicCheck}
                className="min-h-[34px] rounded-lg border border-slate-300 bg-slate-50 px-2.5 py-1 text-xs font-bold text-[#0F1E36] hover:bg-slate-100"
              >
                {lang === 'hi' ? 'माइक जांचें' : 'Test Mic'}
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-slate-600">
              {lang === 'hi' ? 'लोकेशन अनुमति:' : 'Location Permission:'}
            </span>
            {renderBadge(
              locationPermission === 'granted'
                ? true
                : locationPermission === 'denied'
                ? false
                : null,
              formatPerm(locationPermission)
            )}
          </div>

          {hospitalDebug && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-slate-600">
                  {lang === 'hi'
                    ? 'निर्देशांक व सटीकता:'
                    : 'Coordinates & Accuracy:'}
                </span>
                <span className="font-mono-nums text-xs sm:text-sm font-bold text-[#0F1E36]">
                  {hospitalDebug.coords
                    ? `${hospitalDebug.coords.lat.toFixed(5)}, ${hospitalDebug.coords.lng.toFixed(5)}${
                        typeof hospitalDebug.accuracyMeters === 'number'
                          ? ` (±${Math.round(hospitalDebug.accuracyMeters)} m)`
                          : ''
                      }`
                    : '—'}
                </span>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-slate-600">
                  {lang === 'hi' ? 'खोज दायरा (Radius):' : 'Radius Used:'}
                </span>
                <span className="font-mono-nums text-sm font-bold text-[#0F1E36]">
                  {hospitalDebug.radiusUsedMeters
                    ? `${hospitalDebug.radiusUsedMeters} m (${(
                        hospitalDebug.radiusUsedMeters / 1000
                      ).toFixed(0)} km)`
                    : '—'}
                </span>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-slate-600">
                  {lang === 'hi' ? 'डेटा स्रोत:' : 'Hospital Data Source:'}
                </span>
                <span className="font-bold text-[#0F1E36]">
                  {formatSource(hospitalDebug.dataSource)} ({hospitalsCount})
                </span>
              </div>
            </>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-slate-600">
              {lang === 'hi' ? 'सर्वर स्थिति:' : 'Backend Reachable:'}
            </span>
            {renderBadge(
              apiStatus === 'reachable'
                ? true
                : apiStatus === 'unreachable'
                ? false
                : null,
              apiStatus === 'reachable'
                ? 'Yes'
                : apiStatus === 'checking'
                ? 'Checking...'
                : `Offline/Unreachable ${apiDetail ? `(${apiDetail})` : ''}`
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700">
            <span className="font-extrabold text-[#0F1E36]">Last error: </span>
            <span className="break-words">
              {combinedLastError || 'None'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
