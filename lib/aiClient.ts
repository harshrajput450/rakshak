import type {
  ConversationTurnInput,
  ImageAttachmentPayload,
  Language,
  StructuredFirstAidAiResponse,
} from '../src/types/emergency';
import {updateRuntimeDiagnostics} from './diagnosticsStore';

const AI_REQUEST_TIMEOUT_MS = 32_000;
const AI_DEBOUNCE_MS = 3000; // max 1 AI request per 3s
let lastRemoteAiCallAt = 0;

export type AiClientErrorCode =
  | 'offline'
  | 'missing_key'
  | 'invalid_input'
  | 'invalid_image'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'timeout'
  | 'provider_error';

export class ClientAiError extends Error {
  code: AiClientErrorCode;
  statusCode: number;
  retryAfterSec?: number;

  constructor(
    message: string,
    code: AiClientErrorCode,
    statusCode = 500,
    retryAfterSec?: number
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.retryAfterSec = retryAfterSec;
  }
}

export interface AiServiceStatusSnapshot {
  provider: string;
  model: string;
  fallbackModel?: string;
  configured: boolean;
  ragEnabled: boolean;
}

export function resetAiDebounceForTests(): void {
  lastRemoteAiCallAt = 0;
}

export async function fetchAiServiceStatus(): Promise<AiServiceStatusSnapshot | null> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch('/api/ai/status', {
      method: 'GET',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as AiServiceStatusSnapshot;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface HybridResolutionResult {
  response: StructuredFirstAidAiResponse;
  source: 'gemini';
  classification: null;
}

/**
 * Every conversational request is sent to the server-side AI. Offline classifier
 * results and old cached responses must not replace a context-aware answer.
 */
export async function resolveFirstAidQuery(params: {
  message: string;
  language: Language;
  history: ConversationTurnInput[];
  image?: ImageAttachmentPayload | null;
}): Promise<HybridResolutionResult> {
  const cleaned = params.message.trim();

  // Enforce a short client debounce before sending each conversational request.
  const now = Date.now();
  if (now - lastRemoteAiCallAt < AI_DEBOUNCE_MS) {
    throw new ClientAiError(
      params.language === 'hi'
        ? 'स्मार्ट सहायता के लिए कृपया 3 सेकंड बाद फिर प्रयास करें। यदि कोई तत्काल खतरे में है, तो 112 पर कॉल करें।'
        : 'Please wait 3 seconds before trying smart assistance again. If anyone is in immediate danger, call 112.',
      'rate_limited',
      429,
      Math.ceil((AI_DEBOUNCE_MS - (now - lastRemoteAiCallAt)) / 1000)
    );
  }
  lastRemoteAiCallAt = now;

  // Conversation content and history are always handled by the integrated AI.
  const aiRes = await requestFirstAidAi({
    message: cleaned,
    language: params.language,
    history: params.history,
    image: params.image,
  });

  updateRuntimeDiagnostics({lastAiStatus: 'gemini', lastError: ''});
  return {
    response: {
      ...aiRes,
      resolutionSource: 'gemini',
    },
    source: 'gemini',
    classification: null,
  };
}

export async function requestFirstAidAi(params: {
  message: string;
  language: Language;
  history: ConversationTurnInput[];
  image?: ImageAttachmentPayload | null;
}): Promise<StructuredFirstAidAiResponse> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new ClientAiError(
      params.language === 'hi'
        ? 'आप अभी ऑफ़लाइन हैं, इसलिए लाइव स्मार्ट सहायता उपलब्ध नहीं है। यदि कोई तत्काल खतरे में है, तो 112 पर कॉल करें।'
        : 'You are offline, so live smart assistance is unavailable. If anyone is in immediate danger, call 112.',
      'offline',
      0
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    AI_REQUEST_TIMEOUT_MS
  );

  try {
    const res = await fetch('/api/ai/assist', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      signal: controller.signal,
      body: JSON.stringify({
        message: params.message,
        language: params.language,
        history: params.history.slice(-8),
        image: params.image
          ? {
              mimeType: params.image.mimeType,
              data: params.image.data,
            }
          : null,
      }),
    });

    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: AiClientErrorCode;
      retryAfterSec?: number;
    } & Partial<StructuredFirstAidAiResponse>;

    if (!res.ok) {
      throw new ClientAiError(
        data.error ||
          (params.language === 'hi'
            ? 'लाइव स्मार्ट सहायता अभी अस्थायी रूप से उपलब्ध नहीं है। कृपया थोड़ी देर बाद फिर प्रयास करें। यदि कोई तत्काल खतरे में है, तो 112 पर कॉल करें।'
            : 'Live smart assistance is temporarily unavailable. Please try again shortly. If anyone is in immediate danger, call 112.'),
        data.code || (res.status === 429 ? 'quota_exceeded' : 'provider_error'),
        res.status,
        data.retryAfterSec
      );
    }

    return data as StructuredFirstAidAiResponse;
  } catch (err) {
    if (err instanceof ClientAiError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ClientAiError(
        params.language === 'hi'
          ? 'लाइव स्मार्ट सहायता का जवाब आने में समय लगा। कृपया फिर प्रयास करें। यदि कोई तत्काल खतरे में है, तो 112 पर कॉल करें।'
          : 'Live smart assistance timed out. Please try again. If anyone is in immediate danger, call 112.',
        'timeout',
        504
      );
    }
    throw new ClientAiError(
      params.language === 'hi'
        ? 'लाइव स्मार्ट सहायता अभी अस्थायी रूप से उपलब्ध नहीं है। कृपया थोड़ी देर बाद फिर प्रयास करें। यदि कोई तत्काल खतरे में है, तो 112 पर कॉल करें।'
        : 'Live smart assistance is temporarily unavailable. Please try again shortly. If anyone is in immediate danger, call 112.',
      'offline',
      0
    );
  } finally {
    clearTimeout(timer);
  }
}
