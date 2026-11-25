import type {
  ModelManifest,
  ModelStatusSnapshot,
} from '../src/types/emergency';
import {
  type OfflineModelPayload,
  ensureOfflineModelLoaded,
  getActiveOfflineModelSnapshot,
  setActiveOfflineModel,
  verifyOfflineModelPayload,
} from './classifier';

const DB_NAME = 'rakshak_offline_models_db';
const STORE_NAME = 'models';
const META_KEY = 'rakshak_model_updater_meta_v1';
const WIFI_CHARGING_PREF_KEY = 'rakshak_model_wifi_charging_only';

interface StoredModelRecord {
  key: 'active' | 'previous';
  model: OfflineModelPayload;
  savedAt: string;
}

interface UpdaterMeta {
  lastCheckedAt: string | null;
  updateAvailableVersion: string | null;
  lastError: string | null;
  source: 'indexeddb' | 'network' | 'bundled_cache';
  previousVersion: string | null;
}

function readMeta(): UpdaterMeta {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (raw) return JSON.parse(raw) as UpdaterMeta;
  } catch {
    // Ignore
  }
  return {
    lastCheckedAt: null,
    updateAvailableVersion: null,
    lastError: null,
    source: 'bundled_cache',
    previousVersion: null,
  };
}

function writeMeta(meta: Partial<UpdaterMeta>): UpdaterMeta {
  const merged = {...readMeta(), ...meta};
  try {
    localStorage.setItem(META_KEY, JSON.stringify(merged));
  } catch {
    // Ignore
  }
  return merged;
}

export function getWifiAndChargingOnlyPreference(): boolean {
  try {
    const raw = localStorage.getItem(WIFI_CHARGING_PREF_KEY);
    return raw === null ? true : raw === 'true';
  } catch {
    return true;
  }
}

export function setWifiAndChargingOnlyPreference(enabled: boolean): void {
  try {
    localStorage.setItem(WIFI_CHARGING_PREF_KEY, enabled ? 'true' : 'false');
  } catch {
    // Ignore
  }
}

function openModelDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, {keyPath: 'key'});
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open error'));
  });
}

async function idbGet(key: 'active' | 'previous'): Promise<StoredModelRecord | null> {
  try {
    const db = await openModelDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve((req.result as StoredModelRecord) || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function idbPut(record: StoredModelRecord): Promise<void> {
  try {
    const db = await openModelDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error || new Error('IndexedDB write error'));
    });
  } catch {
    // Gracefully fall back if IndexedDB is blocked in private mode
  }
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function checkEnvironmentSuitability(): Promise<{
  suitable: boolean;
  reason?: string;
}> {
  if (!getWifiAndChargingOnlyPreference()) {
    return {suitable: true};
  }
  if (typeof navigator === 'undefined') return {suitable: true};

  const nav = navigator as Navigator & {
    connection?: {type?: string; effectiveType?: string; saveData?: boolean};
    getBattery?: () => Promise<{charging: boolean; level: number}>;
  };

  if (nav.connection) {
    if (nav.connection.saveData) {
      return {
        suitable: false,
        reason: 'Deferred model download because Data Saver mode is active.',
      };
    }
    if (nav.connection.type && nav.connection.type === 'cellular') {
      return {
        suitable: false,
        reason: 'Deferred model download until Wi-Fi is available (Wi-Fi/charging preference enabled).',
      };
    }
  }

  if (typeof nav.getBattery === 'function') {
    try {
      const battery = await nav.getBattery();
      if (!battery.charging && battery.level < 0.25) {
        return {
          suitable: false,
          reason: 'Deferred model download until battery is charging or above 25%.',
        };
      }
    } catch {
      // Browser denied/unsupported battery check — proceed without failing
    }
  }

  return {suitable: true};
}

export async function initializeOfflineModel(): Promise<ModelStatusSnapshot> {
  // Prefer verified IndexedDB cached model if newer than bundled /model.json
  const storedActive = await idbGet('active');
  if (storedActive?.model) {
    const check = await verifyOfflineModelPayload(storedActive.model);
    if (check.valid) {
      setActiveOfflineModel(storedActive.model, true);
      writeMeta({source: 'indexeddb', lastError: null});
      return getModelStatusSnapshot();
    }
  }

  try {
    const {model, verified} = await ensureOfflineModelLoaded();
    if (verified) {
      await idbPut({
        key: 'active',
        model,
        savedAt: new Date().toISOString(),
      });
    }
    writeMeta({source: 'bundled_cache', lastError: null});
  } catch (err) {
    writeMeta({
      lastError:
        err instanceof Error ? err.message : 'Unable to load offline model.',
    });
  }
  return getModelStatusSnapshot();
}

export async function checkAndUpdateOfflineModel(
  forceDownload = false
): Promise<{
  updated: boolean;
  message: string;
  status: ModelStatusSnapshot;
}> {
  await initializeOfflineModel();
  const {model: current} = getActiveOfflineModelSnapshot();

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    const msg = 'Device is offline. Using local verified offline model.';
    return {updated: false, message: msg, status: getModelStatusSnapshot()};
  }

  try {
    const res = await fetch('/models/manifest.json', {cache: 'no-store'});
    if (!res.ok) {
      throw new Error(`Manifest check failed (${res.status})`);
    }
    const manifest = (await res.json()) as ModelManifest;
    const latestEntry =
      manifest.versions.find((v) => v.version === manifest.latestVersion) ||
      manifest.versions[0];

    if (!latestEntry) {
      writeMeta({
        lastCheckedAt: new Date().toISOString(),
        updateAvailableVersion: null,
        lastError: null,
      });
      return {
        updated: false,
        message: 'No model releases listed in manifest.',
        status: getModelStatusSnapshot(),
      };
    }

    const currentVer = current?.version || '0.0.0';
    const isNewer = compareSemver(latestEntry.version, currentVer) > 0;
    if (!isNewer) {
      writeMeta({
        lastCheckedAt: new Date().toISOString(),
        updateAvailableVersion: null,
        lastError: null,
      });
      return {
        updated: false,
        message: `Offline model v${currentVer} is already up to date.`,
        status: getModelStatusSnapshot(),
      };
    }

    if (!forceDownload) {
      const env = await checkEnvironmentSuitability();
      if (!env.suitable) {
        writeMeta({
          lastCheckedAt: new Date().toISOString(),
          updateAvailableVersion: latestEntry.version,
          lastError: env.reason || null,
        });
        return {
          updated: false,
          message: env.reason || 'Update deferred for Wi-Fi/charging.',
          status: getModelStatusSnapshot(),
        };
      }
    }

    const modelRes = await fetch(latestEntry.url, {cache: 'no-store'});
    if (!modelRes.ok) {
      throw new Error(`Model download failed (${modelRes.status})`);
    }
    const candidate = (await modelRes.json()) as OfflineModelPayload;
    const integrity = await verifyOfflineModelPayload(candidate);
    if (!integrity.valid) {
      throw new Error(integrity.reason || 'Downloaded model failed SHA-256 check.');
    }
    if (
      latestEntry.sha256 &&
      candidate.integrity?.sha256 !== latestEntry.sha256
    ) {
      throw new Error('Downloaded model digest does not match signed manifest.');
    }

    // Preserve previous working model for instant rollback
    if (current) {
      await idbPut({
        key: 'previous',
        model: current,
        savedAt: new Date().toISOString(),
      });
    }
    await idbPut({
      key: 'active',
      model: candidate,
      savedAt: new Date().toISOString(),
    });
    setActiveOfflineModel(candidate, true);
    writeMeta({
      lastCheckedAt: new Date().toISOString(),
      updateAvailableVersion: null,
      lastError: null,
      source: 'network',
      previousVersion: current?.version || null,
    });

    return {
      updated: true,
      message: `Updated offline classifier to v${candidate.version} (SHA-256 verified).`,
      status: getModelStatusSnapshot(),
    };
  } catch (err) {
    const errMsg =
      err instanceof Error ? err.message : 'Model update check failed.';
    writeMeta({
      lastCheckedAt: new Date().toISOString(),
      lastError: errMsg,
    });
    return {
      updated: false,
      message: errMsg,
      status: getModelStatusSnapshot(),
    };
  }
}

export async function rollbackOfflineModel(): Promise<{
  rolledBack: boolean;
  message: string;
  status: ModelStatusSnapshot;
}> {
  const prevRecord = await idbGet('previous');
  if (!prevRecord?.model) {
    return {
      rolledBack: false,
      message: 'No previous local model version available for rollback.',
      status: getModelStatusSnapshot(),
    };
  }

  const check = await verifyOfflineModelPayload(prevRecord.model);
  if (!check.valid) {
    return {
      rolledBack: false,
      message: check.reason || 'Previous model failed integrity check.',
      status: getModelStatusSnapshot(),
    };
  }

  const {model: current} = getActiveOfflineModelSnapshot();
  if (current) {
    await idbPut({
      key: 'previous',
      model: current,
      savedAt: new Date().toISOString(),
    });
  }
  await idbPut({
    key: 'active',
    model: prevRecord.model,
    savedAt: new Date().toISOString(),
  });
  setActiveOfflineModel(prevRecord.model, true);
  writeMeta({
    source: 'indexeddb',
    previousVersion: current?.version || null,
    lastError: null,
  });

  return {
    rolledBack: true,
    message: `Rolled back to verified offline model v${prevRecord.model.version}.`,
    status: getModelStatusSnapshot(),
  };
}

export function getModelStatusSnapshot(): ModelStatusSnapshot {
  const {model, verified} = getActiveOfflineModelSnapshot();
  const meta = readMeta();
  return {
    activeVersion: model?.version || '1.0.0',
    previousVersion: meta.previousVersion,
    verified,
    source: meta.source,
    lastCheckedAt: meta.lastCheckedAt,
    updateAvailableVersion: meta.updateAvailableVersion,
    lastError: meta.lastError,
    accuracy: model?.metrics?.accuracy ?? null,
    macroF1: model?.metrics?.macroF1 ?? null,
    sha256: model?.integrity?.sha256 ?? null,
  };
}
