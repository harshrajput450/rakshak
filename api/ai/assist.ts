import type {IncomingMessage, ServerResponse} from 'node:http';
import {
  AiApiError,
  checkAiRateLimit,
  handleFirstAidAiRequest,
} from '../../server/aiProvider.ts';
import type {ImageAttachmentPayload, Language} from '../../src/types/emergency.ts';

type Req = IncomingMessage & {
  body?: {
    message?: string;
    language?: Language;
    history?: unknown;
    image?: ImageAttachmentPayload | null;
  };
};

type Res = ServerResponse & {
  status: (code: number) => Res;
  json: (payload: unknown) => void;
};

export default async function handler(req: Req, res: Res) {
  if (req.method !== 'POST') {
    res.status(405).json({error: 'Method not allowed'});
    return;
  }

  const forwarded = req.headers['x-forwarded-for'];
  const ip =
    (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '') ||
    req.socket?.remoteAddress ||
    'unknown';

  const rl = checkAiRateLimit(ip);
  if (!rl.allowed) {
    res.status(429).json({
      error: `Too many requests. Please retry in ${rl.retryAfterSec}s.`,
      code: 'rate_limited',
      retryAfterSec: rl.retryAfterSec,
    });
    return;
  }

  try {
    const result = await handleFirstAidAiRequest(req.body || {});
    res.status(200).json(result);
  } catch (err) {
    if (err instanceof AiApiError) {
      res.status(err.statusCode).json({
        error: err.message,
        code: err.code,
        retryAfterSec: err.retryAfterSec,
      });
      return;
    }
    console.error('[GoldenHour /api/ai/assist] unexpected error:', err);
    res.status(500).json({
      error:
        'Live smart assistance is temporarily unavailable. Please try again shortly. If anyone is in immediate danger, call 112.',
      code: 'provider_error',
    });
  }
}
