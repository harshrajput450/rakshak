export interface HospitalPlaceResult {
  id: string;
  name: string;
  address?: string;
  phone?: string;
  lat: number;
  lng: number;
  emergency?: boolean;
  distanceKm: number;
  source: 'osm';
}

export interface HospitalsApiSuccess {
  hospitals: HospitalPlaceResult[];
  radiusUsed: number;
  cached: boolean;
  source: 'osm';
}

export interface HospitalsApiError extends Error {
  statusCode?: number;
}

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: {lat: number; lon: number};
  tags?: Record<string, string | undefined>;
}

interface CacheEntry {
  lat: number;
  lng: number;
  radiusUsed: number;
  savedAt: number;
  places: Omit<HospitalPlaceResult, 'distanceKm'>[];
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_MATCH_DISTANCE_METERS = 300;
export const RADII_LADDER = [5000, 10000, 20000, 40000];
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const serverCache: CacheEntry[] = [];

export function clearHospitalsServerCache(): void {
  serverCache.length = 0;
}

export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function makeApiError(message: string, statusCode = 500): HospitalsApiError {
  const err = new Error(message) as HospitalsApiError;
  err.statusCode = statusCode;
  return err;
}

function pruneExpiredCache(now: number) {
  for (let i = serverCache.length - 1; i >= 0; i--) {
    if (now - serverCache[i].savedAt > CACHE_TTL_MS) {
      serverCache.splice(i, 1);
    }
  }
}

export function buildOverpassHospitalQuery(
  radius: number,
  lat: number,
  lng: number
): string {
  return `[out:json][timeout:20];
(
  node["amenity"="hospital"](around:${radius},${lat},${lng});
  way["amenity"="hospital"](around:${radius},${lat},${lng});
  relation["amenity"="hospital"](around:${radius},${lat},${lng});
  node["amenity"="clinic"]["emergency"="yes"](around:${radius},${lat},${lng});
);
out center tags;`;
}

export function parseOverpassElements(
  elements: OverpassElement[],
  originLat: number,
  originLng: number
): HospitalPlaceResult[] {
  const byName: Record<string, HospitalPlaceResult> = {};

  for (const el of elements) {
    const name = el.tags?.name?.trim();
    if (!name) continue;

    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;

    const phone =
      el.tags?.phone?.trim() ||
      el.tags?.['contact:phone']?.trim() ||
      el.tags?.['phone:mobile']?.trim() ||
      undefined;

    const addrParts = [
      el.tags?.['addr:housenumber'],
      el.tags?.['addr:street'],
      el.tags?.['addr:suburb'],
      el.tags?.['addr:city'],
    ]
      .filter(Boolean)
      .join(', ');

    const distanceKm = haversineKm(originLat, originLng, lat, lng);
    const key = name.toLowerCase().replace(/\s+/g, ' ');
    const existing = byName[key];

    if (!existing || distanceKm < existing.distanceKm) {
      byName[key] = {
        id: `osm-${el.type}-${el.id}`,
        name,
        address: addrParts || el.tags?.['addr:full']?.trim() || undefined,
        phone,
        lat,
        lng,
        emergency: el.tags?.emergency === 'yes',
        distanceKm,
        source: 'osm',
      };
    }
  }

  return Object.values(byName).sort((a, b) => a.distanceKm - b.distanceKm);
}

async function querySingleOverpassMirror(
  endpoint: string,
  query: string,
  fetchFn: typeof fetch,
  signal: AbortSignal
): Promise<OverpassElement[]> {
  const res = await fetchFn(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'RakshakFirstAidPWA/1.0',
    },
    body: `data=${encodeURIComponent(query)}`,
    signal,
  });
  if (!res.ok) {
    throw makeApiError(`Overpass returned HTTP ${res.status}`, res.status);
  }
  const data = (await res.json()) as {elements?: OverpassElement[]};
  if (!Array.isArray(data.elements)) {
    throw makeApiError('Invalid Overpass response payload.', 502);
  }
  return data.elements;
}

async function queryOverpass(
  lat: number,
  lng: number,
  radius: number,
  fetchFn: typeof fetch = fetch
): Promise<OverpassElement[]> {
  const query = buildOverpassHospitalQuery(radius, lat, lng);
  const controllers = OVERPASS_ENDPOINTS.map(() => new AbortController());
  const timeout = setTimeout(() => {
    controllers.forEach((c) => c.abort());
  }, 8500);

  try {
    const result = await Promise.any(
      OVERPASS_ENDPOINTS.map((endpoint, idx) =>
        querySingleOverpassMirror(
          endpoint,
          query,
          fetchFn,
          controllers[idx].signal
        )
      )
    );
    return result;
  } catch (err) {
    const aggErr =
      err instanceof AggregateError && err.errors.length > 0
        ? err.errors[0]
        : err;
    throw aggErr instanceof Error
      ? aggErr
      : makeApiError('Overpass hospital search endpoints unavailable.', 503);
  } finally {
    clearTimeout(timeout);
    controllers.forEach((c) => c.abort());
  }
}

export async function findNearbyHospitals(params: {
  lat: number;
  lng: number;
  initialRadius?: number;
  bypassCache?: boolean;
  fetchFn?: typeof fetch;
}): Promise<HospitalsApiSuccess> {
  const {lat, lng, initialRadius, bypassCache = false, fetchFn = fetch} = params;
  const now = Date.now();
  pruneExpiredCache(now);

  if (!bypassCache) {
    const cached = serverCache.find((entry) => {
      const distMeters = haversineKm(lat, lng, entry.lat, entry.lng) * 1000;
      return distMeters <= CACHE_MATCH_DISTANCE_METERS;
    });

    if (cached) {
      const hospitals = cached.places
        .map((p) => ({
          ...p,
          distanceKm: haversineKm(lat, lng, p.lat, p.lng),
        }))
        .sort((a, b) => a.distanceKm - b.distanceKm);

      return {
        hospitals,
        radiusUsed: cached.radiusUsed,
        cached: true,
        source: 'osm',
      };
    }
  }

  const startRadius =
    typeof initialRadius === 'number' &&
    Number.isFinite(initialRadius) &&
    initialRadius > 0
      ? Math.min(Math.round(initialRadius), 40000)
      : RADII_LADDER[0];

  const radiiToTry = Array.from(
    new Set([startRadius, ...RADII_LADDER.filter((r) => r >= startRadius)])
  ).sort((a, b) => a - b);

  let bestHospitals: HospitalPlaceResult[] = [];
  let radiusUsed = radiiToTry[0];

  for (const radius of radiiToTry) {
    radiusUsed = radius;
    const elements = await queryOverpass(lat, lng, radius, fetchFn);
    bestHospitals = parseOverpassElements(elements, lat, lng);
    if (bestHospitals.length >= 5) {
      break;
    }
  }

  const topResults = bestHospitals.slice(0, 12);

  if (topResults.length > 0) {
    serverCache.push({
      lat,
      lng,
      radiusUsed,
      savedAt: now,
      places: topResults.map(({distanceKm: _d, ...rest}) => rest),
    });
  }

  return {
    hospitals: topResults,
    radiusUsed,
    cached: false,
    source: 'osm',
  };
}

export async function geocodeAreaQuery(query: string): Promise<{
  lat: number;
  lng: number;
  label: string;
  source: 'osm';
}> {
  const trimmed = query.trim();
  const nomRes = await fetch(
    `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
      trimmed
    )}&limit=1`,
    {
      headers: {
        'User-Agent': 'RakshakFirstAidPWA/1.0',
      },
    }
  );
  if (!nomRes.ok) {
    throw makeApiError('Area search service unavailable.', nomRes.status);
  }
  const nomData = (await nomRes.json()) as Array<{
    lat: string;
    lon: string;
    display_name: string;
  }>;
  if (!Array.isArray(nomData) || !nomData[0]) {
    throw makeApiError(`Could not find location "${trimmed}".`, 404);
  }
  return {
    lat: Number(nomData[0].lat),
    lng: Number(nomData[0].lon),
    label: nomData[0].display_name.split(',')[0] || trimmed,
    source: 'osm',
  };
}
