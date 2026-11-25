import type {IncomingMessage, ServerResponse} from 'node:http';
import {
  getReviewerQueue,
  isAuthorizedReviewer,
} from '../../server/learningPipeline';

type Req = IncomingMessage & {headers: Record<string, string | undefined>};
type Res = ServerResponse & {
  status: (code: number) => Res;
  json: (payload: unknown) => void;
};

export default function handler(req: Req, res: Res) {
  if (req.method !== 'GET') {
    res.status(405).json({error: 'Method not allowed'});
    return;
  }
  if (!isAuthorizedReviewer(req.headers.authorization)) {
    res.status(401).json({error: 'Reviewer authorization token required.'});
    return;
  }
  try {
    res.status(200).json({items: getReviewerQueue()});
  } catch (err) {
    console.error('[Rakshak /api/learning/queue] error:', err);
    res.status(503).json({
      error:
        err instanceof Error
          ? err.message
          : 'Learning queue is unavailable.',
    });
  }
}
