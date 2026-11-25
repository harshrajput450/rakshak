import type {IncomingMessage, ServerResponse} from 'node:http';
import {ingestLearningSignal} from '../../server/learningPipeline';

type Req = IncomingMessage & {body?: Record<string, unknown>};
type Res = ServerResponse & {
  status: (code: number) => Res;
  json: (payload: unknown) => void;
};

export default function handler(req: Req, res: Res) {
  if (req.method !== 'POST') {
    res.status(405).json({error: 'Method not allowed'});
    return;
  }
  const body = (req.body || {}) as {
    consentGiven?: boolean;
    signal?: Record<string, unknown>;
  };
  try {
    const result = ingestLearningSignal(body);
    res.status(result.accepted ? 200 : 400).json(result);
  } catch (err) {
    console.error('[Rakshak /api/learning/signals] error:', err);
    res.status(503).json({
      accepted: false,
      error:
        err instanceof Error
          ? err.message
          : 'Learning signal storage is unavailable.',
    });
  }
}
