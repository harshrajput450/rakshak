import type {
  AiResolutionSource,
  InputVoiceLanguage,
} from '../src/types/emergency';

export interface RuntimeDiagnosticsState {
  inputVoiceLang: InputVoiceLanguage;
  activeRecLang: 'hi-IN' | 'en-IN';
  lastAiStatus: AiResolutionSource | 'idle';
  lastError: string;
}

const state: RuntimeDiagnosticsState = {
  inputVoiceLang: 'hi',
  activeRecLang: 'hi-IN',
  lastAiStatus: 'idle',
  lastError: '',
};

const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {
      // Ignore subscriber errors
    }
  });
}

export function getRuntimeDiagnostics(): RuntimeDiagnosticsState {
  return {...state};
}

export function updateRuntimeDiagnostics(
  patch: Partial<RuntimeDiagnosticsState>
): void {
  Object.assign(state, patch);
  notify();
}

export function subscribeRuntimeDiagnostics(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function formatInputLanguageLabel(
  voiceLang: InputVoiceLanguage,
  recLang: 'hi-IN' | 'en-IN'
): string {
  if (voiceLang === 'hinglish') return `Hinglish (${recLang})`;
  if (voiceLang === 'en') return `English (${recLang})`;
  return `Hindi (${recLang})`;
}
