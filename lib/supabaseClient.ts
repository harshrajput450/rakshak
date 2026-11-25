import {createClient, type SupabaseClient} from '@supabase/supabase-js';
import {
  getLearningConsentState,
  sanitizeLearningText,
  setLearningConsent,
} from './feedback';
import type {EmergencyEventSource, EmergencyId} from '../src/types/emergency';

const DEVICE_ID_KEY = 'rakshak_device_id';
const CONSENT_ASKED_KEY = 'rakshak_supabase_consent_asked_v1';
const OFFLINE_QUEUE_KEY = 'rakshak_supabase_offline_queue_v1';

export interface EmergencyEventInsertRow {
  id: string;
  device_id: string;
  phrase: string;
  language: string;
  matched_intent: EmergencyId | 'unknown';
  source: EmergencyEventSource;
  confidence: number | null;
  approx_lat: number | null;
  approx_lng: number | null;
  created_at: string;
}

export interface FeedbackInsertRow {
  id: string;
  device_id: string;
  event_id: string | null;
  phrase: string;
  matched_intent: EmergencyId | 'unknown';
  is_correct: boolean;
  corrected_intent: string | null;
  created_at: string;
}

export type QueuedSupabaseWrite =
  | {
      table: 'emergency_events';
      row: EmergencyEventInsertRow;
    }
  | {
      table: 'feedback';
      row: FeedbackInsertRow;
    };

export interface SupabaseDiagnosticsSnapshot {
  configured: boolean;
  connected: boolean;
  queuedRows: number;
  lastError: string;
  deviceId: string;
}

let cachedConfig: {url: string; anonKey: string} | null = null;
let configPromise: Promise<{url: string; anonKey: string}> | null = null;
let supabaseInstance: SupabaseClient | null = null;
let onlineListenerBound = false;
let flushingInFlight = false;
let lastSupabaseError = '';
let lastSupabaseConnected = false;

const diagnosticsSubscribers = new Set<() => void>();

function notifyDiagnostics(): void {
  diagnosticsSubscribers.forEach((cb) => {
    try {
      cb();
    } catch {
      // Ignore
    }
  });
}

export function subscribeSupabaseDiagnostics(cb: () => void): () => void {
  diagnosticsSubscribers.add(cb);
  return () => {
    diagnosticsSubscribers.delete(cb);
  };
}

export function generateUuid(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Fallback
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function getAnonymousDeviceId(): string {
  try {
    if (typeof localStorage !== 'undefined') {
      const existing = localStorage.getItem(DEVICE_ID_KEY);
      if (existing && existing.trim()) {
        return existing;
      }
      const created = generateUuid();
      localStorage.setItem(DEVICE_ID_KEY, created);
      return created;
    }
  } catch {
    // Ignore storage error
  }
  return generateUuid();
}

export function hasPromptedSupabaseConsent(): boolean {
  try {
    if (typeof localStorage === 'undefined') return true;
    return localStorage.getItem(CONSENT_ASKED_KEY) === 'true';
  } catch {
    return true;
  }
}

export function respondToConsentPrompt(allow: boolean): void {
  setLearningConsent(allow);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(CONSENT_ASKED_KEY, 'true');
    }
  } catch {
    // Ignore
  }
  if (allow) {
    void flushSupabaseOfflineQueue();
  }
  notifyDiagnostics();
}

export function readOfflineQueue(): QueuedSupabaseWrite[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(OFFLINE_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as QueuedSupabaseWrite[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeOfflineQueue(items: QueuedSupabaseWrite[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(items.slice(-200)));
  } catch {
    // Ignore
  }
  notifyDiagnostics();
}

export function clearSupabaseOfflineQueue(): void {
  writeOfflineQueue([]);
}

export function enqueueSupabaseWrite(item: QueuedSupabaseWrite): void {
  const existing = readOfflineQueue();
  existing.push(item);
  writeOfflineQueue(existing);
}

export function stripTrustedContactNames(
  text: string,
  contactNames: string[] = []
): string {
  let sanitized = sanitizeLearningText(text);
  for (const name of contactNames) {
    const cleanName = name.trim();
    if (cleanName.length >= 2) {
      const escaped = cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      sanitized = sanitized.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), '[name]');
    }
  }
  return sanitized;
}

export function getGrantedApproxLocation(): {
  approx_lat: number | null;
  approx_lng: number | null;
} {
  try {
    if (typeof localStorage === 'undefined') {
      return {approx_lat: null, approx_lng: null};
    }
    const raw = localStorage.getItem('rakshak_last_granted_coords');
    if (!raw) return {approx_lat: null, approx_lng: null};
    const parsed = JSON.parse(raw) as {lat?: number; lng?: number};
    if (
      typeof parsed.lat === 'number' &&
      Number.isFinite(parsed.lat) &&
      typeof parsed.lng === 'number' &&
      Number.isFinite(parsed.lng)
    ) {
      return {
        approx_lat: Number(parsed.lat.toFixed(2)),
        approx_lng: Number(parsed.lng.toFixed(2)),
      };
    }
  } catch {
    // Ignore
  }
  return {approx_lat: null, approx_lng: null};
}

export function saveGrantedLocationForTelemetry(lat: number, lng: number): void {
  if (!getLearningConsentState().consented) return;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(
        'rakshak_last_granted_coords',
        JSON.stringify({
          lat: Number(lat.toFixed(2)),
          lng: Number(lng.toFixed(2)),
        })
      );
    }
  } catch {
    // Ignore
  }
}

async function resolveSupabaseConfig(): Promise<{url: string; anonKey: string}> {
  if (cachedConfig) return cachedConfig;

  const viteUrl =
    (typeof import.meta !== 'undefined' &&
      ((import.meta as {env?: Record<string, string | undefined>}).env
        ?.VITE_SUPABASE_URL ||
        '')) ||
    '';
  const viteKey =
    (typeof import.meta !== 'undefined' &&
      ((import.meta as {env?: Record<string, string | undefined>}).env
        ?.VITE_SUPABASE_ANON_KEY ||
        '')) ||
    '';

  if (viteUrl && viteKey) {
    cachedConfig = {url: viteUrl.trim(), anonKey: viteKey.trim()};
    return cachedConfig;
  }

  if (typeof fetch === 'undefined') {
    return {url: '', anonKey: ''};
  }

  if (!configPromise) {
    configPromise = fetch('/api/supabase-config')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: {url?: string; anonKey?: string} | null) => {
        const cfg = {
          url: typeof data?.url === 'string' ? data.url.trim() : '',
          anonKey: typeof data?.anonKey === 'string' ? data.anonKey.trim() : '',
        };
        cachedConfig = cfg;
        return cfg;
      })
      .catch(() => ({url: '', anonKey: ''}))
      .finally(() => {
        configPromise = null;
      });
  }

  return configPromise;
}

export async function getSupabaseClient(): Promise<SupabaseClient | null> {
  bindOnlineFlushListener();
  if (supabaseInstance) return supabaseInstance;
  const cfg = await resolveSupabaseConfig();
  if (!cfg.url || !cfg.anonKey) {
    lastSupabaseConnected = false;
    notifyDiagnostics();
    return null;
  }
  try {
    supabaseInstance = createClient(cfg.url, cfg.anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
    lastSupabaseConnected = true;
    notifyDiagnostics();
    return supabaseInstance;
  } catch (err) {
    lastSupabaseConnected = false;
    lastSupabaseError = err instanceof Error ? err.message : 'Supabase init error';
    notifyDiagnostics();
    return null;
  }
}

export function bindOnlineFlushListener(): void {
  if (onlineListenerBound || typeof window === 'undefined') return;
  onlineListenerBound = true;
  window.addEventListener('online', () => {
    void flushSupabaseOfflineQueue();
  });
}

export async function initializeSupabaseTelemetry(): Promise<void> {
  bindOnlineFlushListener();
  await getSupabaseClient();
  if (typeof navigator === 'undefined' || navigator.onLine) {
    void flushSupabaseOfflineQueue();
  }
}

export function getSupabaseDiagnostics(): SupabaseDiagnosticsSnapshot {
  const configured = Boolean(cachedConfig?.url && cachedConfig?.anonKey);
  return {
    configured,
    connected: configured && lastSupabaseConnected,
    queuedRows: readOfflineQueue().length,
    lastError: lastSupabaseError,
    deviceId: getAnonymousDeviceId(),
  };
}

export async function flushSupabaseOfflineQueue(): Promise<number> {
  if (flushingInFlight) return 0;
  if (!getLearningConsentState().consented) return 0;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return 0;

  const queue = readOfflineQueue();
  if (queue.length === 0) return 0;

  const client = await getSupabaseClient();
  if (!client) return 0;

  flushingInFlight = true;
  let flushed = 0;
  const remaining: QueuedSupabaseWrite[] = [];

  try {
    for (let i = 0; i < queue.length; i += 1) {
      const item = queue[i];
      try {
        const {error} =
          item.table === 'emergency_events'
            ? await client.from('emergency_events').insert(item.row)
            : await client.from('feedback').insert(item.row);
        if (error) {
          lastSupabaseError = error.message;
          remaining.push(item, ...queue.slice(i + 1));
          break;
        }
        flushed += 1;
        lastSupabaseConnected = true;
        lastSupabaseError = '';
      } catch (err) {
        lastSupabaseError =
          err instanceof Error ? err.message : 'Network error flushing queue';
        remaining.push(item, ...queue.slice(i + 1));
        break;
      }
    }
    writeOfflineQueue(remaining);
    notifyDiagnostics();
  } finally {
    flushingInFlight = false;
  }

  return flushed;
}

export async function trackEmergencyEvent(params: {
  phrase: string;
  language: string;
  matchedIntent: EmergencyId | 'unknown';
  source: EmergencyEventSource;
  confidence?: number;
  trustedContactNames?: string[];
}): Promise<string | null> {
  if (!getLearningConsentState().consented) {
    return null;
  }

  const sanitizedPhrase = stripTrustedContactNames(
    params.phrase,
    params.trustedContactNames
  );
  if (!sanitizedPhrase) return null;

  const eventId = generateUuid();
  const coords = getGrantedApproxLocation();

  const row: EmergencyEventInsertRow = {
    id: eventId,
    device_id: getAnonymousDeviceId(),
    phrase: sanitizedPhrase,
    language: params.language,
    matched_intent: params.matchedIntent,
    source: params.source,
    confidence:
      typeof params.confidence === 'number'
        ? Number(params.confidence.toFixed(4))
        : null,
    approx_lat: coords.approx_lat,
    approx_lng: coords.approx_lng,
    created_at: new Date().toISOString(),
  };

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    enqueueSupabaseWrite({table: 'emergency_events', row});
    return eventId;
  }

  const client = await getSupabaseClient();
  if (!client) {
    enqueueSupabaseWrite({table: 'emergency_events', row});
    return eventId;
  }

  try {
    const {error} = await client.from('emergency_events').insert(row);
    if (error) {
      lastSupabaseError = error.message;
      enqueueSupabaseWrite({table: 'emergency_events', row});
      return eventId;
    }
    lastSupabaseConnected = true;
    lastSupabaseError = '';
    notifyDiagnostics();
    void flushSupabaseOfflineQueue();
  } catch (err) {
    lastSupabaseError = err instanceof Error ? err.message : 'Insert failed';
    enqueueSupabaseWrite({table: 'emergency_events', row});
  }
  return eventId;
}

export async function trackFeedbackEvent(params: {
  eventId?: string | null;
  phrase: string;
  matchedIntent: EmergencyId | 'unknown';
  isCorrect: boolean;
  correctedIntent?: EmergencyId | 'unknown' | null;
  trustedContactNames?: string[];
}): Promise<{saved: boolean; queued: boolean}> {
  if (!getLearningConsentState().consented) {
    return {saved: false, queued: false};
  }

  const sanitizedPhrase =
    stripTrustedContactNames(params.phrase, params.trustedContactNames) ||
    params.matchedIntent;

  const row: FeedbackInsertRow = {
    id: generateUuid(),
    device_id: getAnonymousDeviceId(),
    event_id: params.eventId || null,
    phrase: sanitizedPhrase,
    matched_intent: params.matchedIntent,
    is_correct: params.isCorrect,
    corrected_intent: params.correctedIntent || null,
    created_at: new Date().toISOString(),
  };

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    enqueueSupabaseWrite({table: 'feedback', row});
    return {saved: true, queued: true};
  }

  const client = await getSupabaseClient();
  if (!client) {
    enqueueSupabaseWrite({table: 'feedback', row});
    return {saved: true, queued: true};
  }

  try {
    const {error} = await client.from('feedback').insert(row);
    if (error) {
      lastSupabaseError = error.message;
      enqueueSupabaseWrite({table: 'feedback', row});
      return {saved: true, queued: true};
    }
    lastSupabaseConnected = true;
    lastSupabaseError = '';
    notifyDiagnostics();
    void flushSupabaseOfflineQueue();
    return {saved: true, queued: false};
  } catch (err) {
    lastSupabaseError = err instanceof Error ? err.message : 'Feedback insert failed';
    enqueueSupabaseWrite({table: 'feedback', row});
    return {saved: true, queued: true};
  }
}
