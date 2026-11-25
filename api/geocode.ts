import {
  geocodeAreaQuery,
  type HospitalsApiError,
} from '../server/hospitalsHandler.ts';

interface Req {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  body?: {query?: unknown};
}

interface Res {
  status: (code: number) => Res;
  json: (payload: unknown) => void;
}

export default async function handler(req: Req, res: Res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({error: 'Method not allowed'});
    return;
  }

  try {
    const rawQuery = req.method === 'GET' ? req.query?.q : req.body?.query;
    const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
    if (!query) {
      res.status(400).json({error: 'Please enter an area or city name.'});
      return;
    }

    const location = await geocodeAreaQuery(query);
    res.status(200).json(location);
  } catch (err) {
    console.error('[GoldenHour Vercel /api/geocode] Error:', err);
    const apiErr = err as HospitalsApiError;
    res.status(apiErr.statusCode || 500).json({
      error: apiErr.message || 'Area lookup failed.',
    });
  }
}
