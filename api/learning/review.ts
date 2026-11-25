import type {IncomingMessage, ServerResponse} from 'node:http';
import type {EmergencyId} from '../../src/types/emergency';
import {
  isAuthorizedReviewer,
  reviewLearningSignal,
} from '../../server/learningPipeline';

type Req = IncomingMessage & {
  headers: Record<string, string | undefined>;
  body?: Record<string, unknown>;
};
type Res = ServerResponse & {
  status: (code: number) => Res;
  json: (payload: unknown) => void;
};

export default function handler(req: Req, res: Res) {
  if (req.method !== 'POST') {
    res.status(405).json({error: 'Method not allowed'});
    return;
  }
  if (!isAuthorizedReviewer(req.headers.authorization)) {
    res.status(401).json({error: 'Reviewer authorization token required.'});
    return;
  }
  const id = typeof req.body?.id === 'string' ? req.body.id : '';
  const decision = req.body?.decision === 'approved' ? 'approved' : 'rejected';
  const correctedIntent =
    typeof req.body?.correctedIntent === 'string'
      ? (req.body.correctedIntent as EmergencyId | 'unknown')
      : undefined;
  const updated = reviewLearningSignal(id, decision, correctedIntent);
  if (!updated) {
    res.status(404).json({error: 'Signal not found.'});
    return;
  }
  res.status(200).json({item: updated});
}
