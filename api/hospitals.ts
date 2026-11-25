import {
  findNearbyHospitals,
  type HospitalsApiError,
} from '../server/hospitalsHandler.ts';

interface Req {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  body?: {
    lat?: unknown;
    lng?: unknown;
    radius?: unknown;
    refresh?: unknown;
  };
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
    const rawLat = req.method === 'GET' ? req.query?.lat : req.body?.lat;
    const rawLng = req.method === 'GET' ? req.query?.lng : req.body?.lng;
    const rawRadius =
      req.method === 'GET' ? req.query?.radius : req.body?.radius;
    const rawRefresh =
      req.method === 'GET' ? req.query?.refresh : req.body?.refresh;

    const lat = Number(rawLat);
    const lng = Number(rawLng);
    const radius = rawRadius !== undefined ? Number(rawRadius) : undefined;
    const bypassCache = rawRefresh === true || rawRefresh === 'true';

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      res.status(400).json({error: 'Valid lat and lng coordinates are required.'});
      return;
    }

    const result = await findNearbyHospitals({
      lat,
      lng,
      initialRadius: radius,
      bypassCache,
    });
    res.status(200).json(result);
  } catch (err) {
    console.error('[GoldenHour Vercel /api/hospitals] Error:', err);
    const apiErr = err as HospitalsApiError;
    res.status(apiErr.statusCode || 500).json({
      error: apiErr.message || 'Failed to fetch nearby hospitals.',
    });
  }
}
