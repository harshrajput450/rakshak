import type {IncomingMessage, ServerResponse} from 'node:http';
import {deleteSignalsForDevice} from '../../server/learningPipeline';

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
  const deviceTag =
    typeof req.body?.deviceTag === 'string' ? req.body.deviceTag : '';
  const deleted = deleteSignalsForDevice(deviceTag);
  res.status(200).json({deleted});
}
