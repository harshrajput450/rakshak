import React, {useCallback, useEffect, useRef, useState} from 'react';
import L from 'leaflet';
import {
  AlertTriangle,
  ExternalLink,
  LocateFixed,
  Navigation,
  PhoneCall,
  RefreshCw,
  Search,
} from 'lucide-react';
import {saveGrantedLocationForTelemetry} from '../../lib/supabaseClient';
import {UI_COPY, t} from '../i18n/translations';
import type {
  HospitalDataSource,
  HospitalItem,
  HospitalSearchResponse,
  Language,
} from '../types/emergency';
import {DiagnosticsPanel} from './DiagnosticsPanel';

interface Props {
  lang: Language;
  isOnline: boolean;
  onHospitalsCountChange?: (count: number) => void;
}

interface Coordinates {
  lat: number;
  lng: number;
  accuracy?: number | null;
}

const CACHE_KEY = 'goldenhour_cached_hospitals_v2';
const MOVE_THRESHOLD_METERS = 300;
const RADII_METERS = [5000, 10000, 20000, 40000];
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function haversineKm(
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

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: {lat: number; lon: number};
  tags?: Record<string, string | undefined>;
}

function buildOverpassHospitalQuery(
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

function parseOverpassHospitals(
  elements: OverpassElement[],
  originLat: number,
  originLng: number
): HospitalItem[] {
  const byName: Record<string, HospitalItem> = {};

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
        address: addrParts || el.tags?.['addr:full'] || undefined,
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

async function fetchOverpassDirect(
  lat: number,
  lng: number
): Promise<{hospitals: HospitalItem[]; radiusUsed: number}> {
  let bestResults: HospitalItem[] = [];
  let usedRadius = RADII_METERS[0];

  for (const radius of RADII_METERS) {
    usedRadius = radius;
    const query = buildOverpassHospitalQuery(radius, lat, lng);
    let elements: OverpassElement[] | null = null;
    let lastError: unknown = null;

    for (const endpoint of OVERPASS_ENDPOINTS) {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 14000);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {'Content-Type': 'application/x-www-form-urlencoded'},
          body: `data=${encodeURIComponent(query)}`,
          signal: controller.signal,
        });
        window.clearTimeout(timer);
        if (!res.ok) {
          lastError = new Error(`Overpass returned HTTP ${res.status}`);
          continue;
        }
        const data = (await res.json()) as {elements?: OverpassElement[]};
        if (Array.isArray(data.elements)) {
          elements = data.elements;
          break;
        }
      } catch (err) {
        window.clearTimeout(timer);
        lastError = err;
      }
    }

    if (!elements) {
      throw lastError || new Error('All Overpass endpoints failed');
    }

    bestResults = parseOverpassHospitals(elements, lat, lng);
    if (bestResults.length >= 5) {
      break;
    }
  }

  return {
    hospitals: bestResults.slice(0, 12),
    radiusUsed: usedRadius,
  };
}

interface LeafletCanvasProps {
  lang: Language;
  origin: Coordinates | null;
  originLabel: string;
  hospitals: HospitalItem[];
  fitVersion: number;
  selectedHospitalId: string | null;
  panRequest: {id: string; seq: number} | null;
  onSelectHospital: (id: string | null) => void;
}

const LeafletHospitalMap: React.FC<LeafletCanvasProps> = ({
  lang,
  origin,
  originLabel,
  hospitals,
  fitVersion,
  selectedHospitalId: _selectedHospitalId,
  panRequest,
  onSelectHospital,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);
  const markersByIdRef = useRef<Record<string, L.Marker>>({});

  // Initialize Leaflet map once
  useEffect(() => {
    const el = containerRef.current;
    if (!el || mapRef.current) return;

    const map = L.map(el, {
      center: origin ? [origin.lat, origin.lng] : [20.5937, 78.9629],
      zoom: origin ? 13 : 5,
      zoomControl: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);

    const group = L.layerGroup().addTo(map);
    mapRef.current = map;
    layerGroupRef.current = group;

    return () => {
      map.remove();
      mapRef.current = null;
      layerGroupRef.current = null;
      markersByIdRef.current = {};
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Render user & hospital markers
  useEffect(() => {
    const map = mapRef.current;
    const group = layerGroupRef.current;
    if (!map || !group) return;

    group.clearLayers();
    markersByIdRef.current = {};

    const boundsPoints: L.LatLngExpression[] = [];

    if (origin) {
      boundsPoints.push([origin.lat, origin.lng]);
      const userIcon = L.divIcon({
        className: 'rakshak-user-marker',
        html: `<div style="position:relative;display:flex;align-items:center;justify-content:center;width:24px;height:24px;">
          <span style="position:absolute;width:24px;height:24px;border-radius:9999px;background:rgba(37,99,235,0.28);"></span>
          <span style="position:relative;width:14px;height:14px;border-radius:9999px;background:#2563EB;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);"></span>
        </div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });
      const userMarker = L.marker([origin.lat, origin.lng], {
        icon: userIcon,
        zIndexOffset: 500,
      }).addTo(group);
      userMarker.bindPopup(
        `<div style="font-weight:700;font-size:12px;color:#0F1E36;">${escapeHtml(
          originLabel || (lang === 'hi' ? 'आप यहाँ हैं' : 'You are here')
        )}</div>`
      );
    }

    hospitals.forEach((h, idx) => {
      boundsPoints.push([h.lat, h.lng]);
      const isNearest = idx === 0;
      const badgeText = isNearest ? '★' : String(idx + 1);
      const border = isNearest ? '#FACC15' : '#FFFFFF';

      const icon = L.divIcon({
        className: 'rakshak-hospital-pin',
        html: `<div style="display:flex;align-items:center;justify-content:center;width:${
          isNearest ? 34 : 28
        }px;height:${
          isNearest ? 34 : 28
        }px;border-radius:9999px;background:#DC2626;color:#FFFFFF;font-weight:800;font-size:${
          isNearest ? 15 : 12
        }px;border:2.5px solid ${border};box-shadow:0 2px 6px rgba(0,0,0,0.35);">${badgeText}</div>`,
        iconSize: [isNearest ? 34 : 28, isNearest ? 34 : 28],
        iconAnchor: [isNearest ? 17 : 14, isNearest ? 17 : 14],
      });

      const marker = L.marker([h.lat, h.lng], {
        icon,
        zIndexOffset: isNearest ? 300 : 100,
      }).addTo(group);

      const safeName = escapeHtml(h.name);
      const safeAddr = h.address ? `<p style="margin:4px 0 0;font-size:11px;color:#475569;">${escapeHtml(h.address)}</p>` : '';
      const navLabel = lang === 'hi' ? 'Google Maps में रास्ता देखें' : 'Navigate in Google Maps';
      const navHref = `https://www.google.com/maps/dir/?api=1&destination=${h.lat},${h.lng}`;

      marker.bindPopup(
        `<div style="min-width:170px;color:#0F1E36;">
          <div style="font-weight:800;font-size:13px;">${safeName}</div>
          <div style="font-weight:700;font-size:12px;color:#DC2626;margin-top:2px;">${h.distanceKm.toFixed(
            2
          )} km</div>
          ${safeAddr}
          <a href="${navHref}" target="_blank" rel="noopener noreferrer" style="display:inline-block;margin-top:6px;font-weight:800;font-size:12px;color:#2563EB;text-decoration:underline;">${navLabel}</a>
        </div>`
      );

      marker.on('click', () => {
        onSelectHospital(h.id);
      });

      markersByIdRef.current[h.id] = marker;
    });

    if (boundsPoints.length === 1) {
      map.setView(boundsPoints[0], 14);
    } else if (boundsPoints.length > 1) {
      map.fitBounds(L.latLngBounds(boundsPoints), {padding: [42, 42]});
    }
  }, [origin, originLabel, hospitals, fitVersion, lang, onSelectHospital]);

  // Pan & open popup when a list card is tapped
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !panRequest) return;
    const target = hospitals.find((h) => h.id === panRequest.id);
    if (!target) return;
    map.setView([target.lat, target.lng], Math.max(map.getZoom(), 15), {
      animate: true,
    });
    markersByIdRef.current[target.id]?.openPopup();
  }, [panRequest, hospitals]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      aria-label={lang === 'hi' ? 'अस्पताल मानचित्र' : 'Nearby Hospitals Map'}
    />
  );
};

export const NearestHospitals: React.FC<Props> = ({
  lang,
  isOnline,
  onHospitalsCountChange,
}) => {
  const [livePos, setLivePos] = useState<Coordinates | null>(null);
  const [manualOrigin, setManualOrigin] = useState<{
    lat: number;
    lng: number;
    label: string;
  } | null>(null);
  const [locationDenied, setLocationDenied] = useState(false);
  const [locationErrorMsg, setLocationErrorMsg] = useState('');

  const [areaQuery, setAreaQuery] = useState('');
  const [searchingArea, setSearchingArea] = useState(false);

  const [hospitals, setHospitals] = useState<HospitalItem[]>([]);
  const [dataSourceMode, setDataSourceMode] = useState<
    HospitalDataSource | 'idle'
  >('idle');
  const [radiusUsedMeters, setRadiusUsedMeters] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');

  const [selectedHospitalId, setSelectedHospitalId] = useState<string | null>(
    null
  );
  const [fitVersion, setFitVersion] = useState(0);
  const [panRequest, setPanRequest] = useState<{id: string; seq: number} | null>(
    null
  );

  const mapSectionRef = useRef<HTMLDivElement | null>(null);
  const lastFetchedPosRef = useRef<{lat: number; lng: number} | null>(null);
  const fetchInFlightRef = useRef(false);
  const watchIdRef = useRef<number | null>(null);
  const manualOriginRef = useRef(manualOrigin);
  manualOriginRef.current = manualOrigin;

  useEffect(() => {
    onHospitalsCountChange?.(hospitals.length);
  }, [hospitals.length, onHospitalsCountChange]);

  const loadCachedFallback = useCallback(
    (originLat?: number, originLng?: number) => {
      try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as {
            items?: HospitalItem[];
            radiusUsedMeters?: number;
          };
          if (Array.isArray(parsed.items) && parsed.items.length > 0) {
            const list = parsed.items
              .map((h) => ({
                ...h,
                distanceKm:
                  typeof originLat === 'number' && typeof originLng === 'number'
                    ? haversineKm(originLat, originLng, h.lat, h.lng)
                    : h.distanceKm,
                source: 'cache' as const,
              }))
              .sort((a, b) => a.distanceKm - b.distanceKm)
              .slice(0, 12);

            setHospitals(list);
            setDataSourceMode('cache');
            if (typeof parsed.radiusUsedMeters === 'number') {
              setRadiusUsedMeters(parsed.radiusUsedMeters);
            }
            setFitVersion((v) => v + 1);
            return true;
          }
        }
      } catch {
        // Ignore storage errors
      }
      setHospitals([]);
      setDataSourceMode('cache');
      return false;
    },
    []
  );

  const searchHospitals = useCallback(
    async (lat: number, lng: number, bypassCache = false) => {
      if (fetchInFlightRef.current) return;
      fetchInFlightRef.current = true;
      lastFetchedPosRef.current = {lat, lng};

      setLoading(true);
      setApiError('');
      setSelectedHospitalId(null);

      if (!isOnline) {
        loadCachedFallback(lat, lng);
        setStatusMessage(
          lang === 'hi'
            ? 'आप ऑफ़लाइन हैं — पिछला सहेजा गया डेटा दिखाया जा रहा है।'
            : 'Offline — showing last saved results.'
        );
        setLoading(false);
        fetchInFlightRef.current = false;
        return;
      }

      let serverErrorMsg = '';

      // 1. Primary: Server Overpass API (/api/hospitals with 5/10/20/40 km retry & cache)
      try {
        const res = await fetch('/api/hospitals', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            lat,
            lng,
            radius: 5000,
            refresh: bypassCache,
          }),
        });

        const payload = (await res.json().catch(() => ({}))) as Partial<
          HospitalSearchResponse
        >;

        if (!res.ok) {
          throw new Error(payload.error || `HTTP ${res.status}`);
        }

        const list = Array.isArray(payload.hospitals)
          ? payload.hospitals.slice(0, 12)
          : [];

        if (list.length > 0) {
          const usedRadius =
            typeof payload.radiusUsed === 'number' ? payload.radiusUsed : 5000;
          setHospitals(list);
          setRadiusUsedMeters(usedRadius);
          setDataSourceMode('osm');
          setStatusMessage(
            lang === 'hi'
              ? `${(usedRadius / 1000).toFixed(0)} किमी में ${list.length} अस्पताल मिले।`
              : `Found ${list.length} hospitals within ${(usedRadius / 1000).toFixed(0)} km.`
          );
          setFitVersion((v) => v + 1);
          try {
            localStorage.setItem(
              CACHE_KEY,
              JSON.stringify({
                lat,
                lng,
                radiusUsedMeters: usedRadius,
                savedAt: new Date().toISOString(),
                items: list,
              })
            );
          } catch {
            // Ignore storage quota error
          }
          setLoading(false);
          fetchInFlightRef.current = false;
          return;
        }

        serverErrorMsg = 'Overpass returned 0 hospitals within 40 km.';
      } catch (err) {
        serverErrorMsg =
          err instanceof Error ? err.message : 'Server Overpass query failed.';
      }

      // 2. Fallback 1: Direct browser Overpass API endpoints (5/10/20/40 km)
      try {
        const osm = await fetchOverpassDirect(lat, lng);
        if (osm.hospitals.length > 0) {
          setHospitals(osm.hospitals);
          setRadiusUsedMeters(osm.radiusUsed);
          setDataSourceMode('osm');
          setApiError('');
          setStatusMessage(
            lang === 'hi'
              ? `${(osm.radiusUsed / 1000).toFixed(0)} किमी में ${osm.hospitals.length} अस्पताल मिले।`
              : `Found ${osm.hospitals.length} hospitals within ${(osm.radiusUsed / 1000).toFixed(0)} km.`
          );
          setFitVersion((v) => v + 1);
          try {
            localStorage.setItem(
              CACHE_KEY,
              JSON.stringify({
                lat,
                lng,
                radiusUsedMeters: osm.radiusUsed,
                savedAt: new Date().toISOString(),
                items: osm.hospitals,
              })
            );
          } catch {
            // Ignore storage error
          }
          setLoading(false);
          fetchInFlightRef.current = false;
          return;
        }
      } catch (osmErr) {
        const osmMsg =
          osmErr instanceof Error ? osmErr.message : 'Overpass API failed.';
        serverErrorMsg = `${serverErrorMsg} | Direct OSM: ${osmMsg}`;
      }

      // 3. Fallback 2: Last saved results from localStorage
      setApiError(serverErrorMsg);
      const hadCache = loadCachedFallback(lat, lng);
      setStatusMessage(
        hadCache
          ? lang === 'hi'
            ? 'लाइव खोज उपलब्ध नहीं — पिछली सहेजी गई सूची दिखाई जा रही है।'
            : 'Live search unavailable — showing last saved results.'
          : lang === 'hi'
          ? 'अस्पताल सूची लोड नहीं हो सकी। आपातकाल में तुरंत 112 पर कॉल करें या Google Maps बटन दबाएं।'
          : 'Could not load hospital results right now. Call 112 or tap Open in Google Maps.'
      );
      setLoading(false);
      fetchInFlightRef.current = false;
    },
    [isOnline, lang, loadCachedFallback]
  );

  // Start live geolocation watchPosition
  const startLocationWatch = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setLocationDenied(true);
      setLocationErrorMsg(
        lang === 'hi'
          ? 'इस डिवाइस में GPS लोकेशन समर्थित नहीं है। कृपया नीचे अपना इलाका लिखें।'
          : 'Geolocation is not supported on this device. Enter your area manually below.'
      );
      loadCachedFallback();
      return;
    }

    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }

    setLocationDenied(false);
    setLocationErrorMsg('');
    setStatusMessage(
      lang === 'hi'
        ? 'आपकी लाइव GPS लोकेशन ली जा रही है...'
        : 'Tracking your live GPS location...'
    );

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const nextPos: Coordinates = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        };
        setLivePos(nextPos);
        setLocationDenied(false);
        setLocationErrorMsg('');
        saveGrantedLocationForTelemetry(nextPos.lat, nextPos.lng);

        if (manualOriginRef.current) return;

        const prevFetch = lastFetchedPosRef.current;
        const movedMeters = prevFetch
          ? haversineKm(prevFetch.lat, prevFetch.lng, nextPos.lat, nextPos.lng) *
            1000
          : Infinity;

        if (!prevFetch || movedMeters > MOVE_THRESHOLD_METERS) {
          searchHospitals(nextPos.lat, nextPos.lng, false);
        } else {
          setHospitals((prev) =>
            prev
              .map((h) => ({
                ...h,
                distanceKm: haversineKm(nextPos.lat, nextPos.lng, h.lat, h.lng),
              }))
              .sort((a, b) => a.distanceKm - b.distanceKm)
          );
        }
      },
      (err) => {
        setLocationDenied(true);
        const msg =
          err.code === err.PERMISSION_DENIED
            ? lang === 'hi'
              ? 'लोकेशन अनुमति अस्वीकार की गई। कृपया नीचे अपना इलाका या शहर लिखें।'
              : 'Location permission was denied. Please type your area manually below.'
            : lang === 'hi'
            ? 'लाइव GPS लोकेशन समय पर नहीं मिली। कृपया नीचे अपना इलाका लिखें।'
            : 'Could not get live GPS location in time. Please type your area manually below.';
        setLocationErrorMsg(msg);
        if (!lastFetchedPosRef.current && !manualOriginRef.current) {
          loadCachedFallback();
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 10000,
      }
    );
  }, [lang, loadCachedFallback, searchHospitals]);

  useEffect(() => {
    startLocationWatch();
    return () => {
      if (watchIdRef.current !== null && 'geolocation' in navigator) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, [startLocationWatch]);

  const handleManualAreaSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = areaQuery.trim();
    if (!q) return;

    setSearchingArea(true);
    setApiError('');

    try {
      const res = await fetch('/api/geocode', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({query: q}),
      });
      const data = (await res.json().catch(() => ({}))) as {
        lat?: number;
        lng?: number;
        label?: string;
        error?: string;
      };

      if (
        !res.ok ||
        typeof data.lat !== 'number' ||
        typeof data.lng !== 'number'
      ) {
        throw new Error(data.error || `Could not find "${q}".`);
      }

      const chosen = {
        lat: data.lat,
        lng: data.lng,
        label: data.label || q,
      };
      setManualOrigin(chosen);
      await searchHospitals(chosen.lat, chosen.lng, false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Area lookup failed.';
      setApiError(msg);
      setStatusMessage(
        lang === 'hi'
          ? `"${q}" इलाका नहीं मिला। कृपया पूरा क्षेत्र या शहर लिखें।`
          : msg
      );
    } finally {
      setSearchingArea(false);
    }
  };

  const handleRefresh = () => {
    if (manualOrigin) {
      searchHospitals(manualOrigin.lat, manualOrigin.lng, true);
    } else if (livePos) {
      searchHospitals(livePos.lat, livePos.lng, true);
    } else {
      startLocationWatch();
    }
  };

  const handleBackToLiveGps = () => {
    setManualOrigin(null);
    lastFetchedPosRef.current = null;
    if (livePos) {
      searchHospitals(livePos.lat, livePos.lng, false);
    } else {
      startLocationWatch();
    }
  };

  const handlePanToHospital = (h: HospitalItem) => {
    setSelectedHospitalId(h.id);
    setPanRequest((prev) => ({id: h.id, seq: (prev?.seq ?? 0) + 1}));
    mapSectionRef.current?.scrollIntoView({behavior: 'smooth', block: 'nearest'});
  };

  const activeOrigin: Coordinates | null = manualOrigin
    ? {lat: manualOrigin.lat, lng: manualOrigin.lng, accuracy: null}
    : livePos;

  const originLabel = manualOrigin
    ? manualOrigin.label
    : lang === 'hi'
    ? 'आप यहाँ हैं (लाइव GPS)'
    : 'You are here (Live GPS)';

  const openGoogleMapsHospitalsUrl = activeOrigin
    ? `https://www.google.com/maps/search/hospitals/@${activeOrigin.lat},${activeOrigin.lng},14z`
    : 'https://www.google.com/maps/search/hospitals/';

  return (
    <section className="mx-auto max-w-5xl px-4 py-5 pb-24 sm:px-6 md:pb-12">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-[#0F1E36]">
            {lang === 'hi' ? 'नजदीकी अस्पताल' : 'Nearest Hospitals'}
          </h1>
          <p className="text-base font-medium text-slate-600">
            {activeOrigin
              ? `${originLabel}${
                  radiusUsedMeters
                    ? ` · ${(radiusUsedMeters / 1000).toFixed(0)} km`
                    : ''
                }`
              : lang === 'hi'
              ? 'OpenStreetMap व Overpass द्वारा निःशुल्क अस्पताल खोज'
              : 'Free hospital finder powered by OpenStreetMap & Overpass'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <a
            href={openGoogleMapsHospitalsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-[48px] items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-[#0F1E36] hover:bg-slate-50"
          >
            <ExternalLink className="h-4 w-4 text-[#2563EB]" aria-hidden="true" />
            <span>
              {lang === 'hi'
                ? 'Google Maps में अस्पताल खोलें'
                : 'Open hospitals in Google Maps'}
            </span>
          </a>

          <button
            type="button"
            onClick={handleRefresh}
            disabled={loading}
            className="inline-flex min-h-[48px] items-center gap-2 rounded-xl bg-[#0F1E36] px-4 py-2 text-sm font-bold text-white hover:bg-[#162947] disabled:opacity-60"
          >
            <RefreshCw
              className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <span>{lang === 'hi' ? 'रिफ्रेश' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      {/* Prominent Emergency Call 112 Reminder */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border-2 border-[#DC2626] bg-red-50 px-4 py-3">
        <p className="text-base font-extrabold text-[#991B1B]">
          {lang === 'hi'
            ? 'आपातकाल में पहले 112 पर कॉल करें।'
            : 'Call 112 first in an emergency.'}
        </p>
        <a
          href="tel:112"
          className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-[#DC2626] px-5 py-2 text-base font-extrabold text-white shadow-sm hover:bg-red-700"
        >
          <PhoneCall className="h-5 w-5 shrink-0" aria-hidden="true" />
          <span>{t(UI_COPY.call112, lang)}</span>
        </a>
      </div>

      {/* Location Error & Manual Area Search Box */}
      <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        {locationDenied && (
          <div
            role="alert"
            className="mb-3 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm font-bold text-amber-950"
          >
            <AlertTriangle
              className="mt-0.5 h-5 w-5 shrink-0 text-amber-700"
              aria-hidden="true"
            />
            <span>
              {locationErrorMsg ||
                (lang === 'hi'
                  ? 'लोकेशन अनुमति अस्वीकार या विफल रही। नीचे अपना इलाका टाइप करें।'
                  : 'Location permission denied or unavailable. Type an area manually below.')}
            </span>
          </div>
        )}

        <form
          onSubmit={handleManualAreaSearch}
          className="flex flex-col gap-2.5 sm:flex-row"
        >
          <input
            type="text"
            value={areaQuery}
            onChange={(e) => setAreaQuery(e.target.value)}
            placeholder={
              lang === 'hi'
                ? 'इलाका, पता या शहर टाइप करें...'
                : 'Type an area, landmark, or city manually...'
            }
            className="min-h-[48px] flex-1 rounded-xl border border-slate-300 bg-slate-50 px-4 text-base font-semibold text-[#0F1E36]"
          />
          <button
            type="submit"
            disabled={searchingArea || !areaQuery.trim() || !isOnline}
            className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-[#DC2626] px-5 text-sm font-extrabold text-white hover:bg-red-700 disabled:opacity-50"
          >
            <Search className="h-4 w-4" aria-hidden="true" />
            <span>
              {searchingArea
                ? lang === 'hi'
                  ? 'खोज रहे हैं...'
                  : 'Searching...'
                : lang === 'hi'
                ? 'इलाका खोजें'
                : 'Search Area'}
            </span>
          </button>

          {manualOrigin && (
            <button
              type="button"
              onClick={handleBackToLiveGps}
              className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 text-sm font-bold text-[#0F1E36] hover:bg-slate-50"
            >
              <LocateFixed className="h-4 w-4" aria-hidden="true" />
              <span>{lang === 'hi' ? 'लाइव GPS' : 'Use Live GPS'}</span>
            </button>
          )}
        </form>
      </div>

      {dataSourceMode === 'cache' && (
        <div
          role="alert"
          className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-950"
        >
          <span>
            {lang === 'hi'
              ? 'पिछले सहेजे गए परिणाम दिखाए जा रहे हैं (Showing last saved results)'
              : 'Showing last saved results'}
          </span>
          <a
            href="tel:112"
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[#DC2626] px-4 py-2 text-sm font-extrabold text-white hover:bg-red-700"
          >
            <PhoneCall className="h-4 w-4" aria-hidden="true" />
            <span>{t(UI_COPY.call112, lang)}</span>
          </a>
        </div>
      )}

      {statusMessage && (
        <p className="mt-3 text-sm font-semibold text-slate-700">
          {statusMessage}
        </p>
      )}

      {/* Leaflet OpenStreetMap + Hospital Cards */}
      <div className="mt-4 space-y-5">
        <div
          ref={mapSectionRef}
          className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm"
        >
          <div className="h-72 sm:h-[420px] w-full bg-slate-100">
            {!isOnline ? (
              <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
                <p className="text-base font-bold text-[#0F1E36]">
                  {lang === 'hi'
                    ? 'ऑफ़लाइन मोड: मानचित्र के लिए इंटरनेट आवश्यक है। नीचे सहेजे गए अस्पताल देखें।'
                    : 'Offline: Map tiles require internet. Check cached hospital results below.'}
                </p>
                <a
                  href="tel:112"
                  className="inline-flex min-h-[52px] items-center gap-2 rounded-xl bg-[#DC2626] px-6 py-3 text-base font-extrabold text-white hover:bg-red-700"
                >
                  <PhoneCall className="h-5 w-5" aria-hidden="true" />
                  <span>{t(UI_COPY.call112, lang)}</span>
                </a>
              </div>
            ) : (
              <LeafletHospitalMap
                lang={lang}
                origin={activeOrigin}
                originLabel={originLabel}
                hospitals={hospitals}
                fitVersion={fitVersion}
                selectedHospitalId={selectedHospitalId}
                panRequest={panRequest}
                onSelectHospital={setSelectedHospitalId}
              />
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-4 py-2.5 text-xs font-semibold text-slate-600">
            <span>
              {lang === 'hi'
                ? 'OpenStreetMap & Overpass द्वारा संचालित (निःशुल्क, बिना किसी API कुंजी के) · आपातकाल में पहले 112 पर कॉल करें।'
                : 'Powered by OpenStreetMap & Overpass (free, zero API keys) · Call 112 first in an emergency.'}
            </span>
            {activeOrigin && (
              <span className="font-mono-nums text-slate-500">
                {activeOrigin.lat.toFixed(4)}, {activeOrigin.lng.toFixed(4)}
              </span>
            )}
          </div>
        </div>

        {/* Hospital Cards List */}
        <div className="space-y-3">
          {loading ? (
            <div className="grid gap-3 md:grid-cols-2">
              {[1, 2, 3, 4].map((n) => (
                <div
                  key={n}
                  className="animate-pulse rounded-2xl border border-slate-200 bg-white p-4"
                >
                  <div className="h-5 w-3/4 rounded bg-slate-200" />
                  <div className="mt-2 h-4 w-1/2 rounded bg-slate-200" />
                  <div className="mt-2 h-4 w-2/3 rounded bg-slate-200" />
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <div className="h-11 rounded-xl bg-slate-200" />
                    <div className="h-11 rounded-xl bg-slate-200" />
                  </div>
                </div>
              ))}
            </div>
          ) : hospitals.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center space-y-4">
              <p className="text-base font-bold text-[#0F1E36]">
                {lang === 'hi'
                  ? 'अभी कोई अस्पताल परिणाम उपलब्ध नहीं है। ऊपर अपना इलाका खोजें, Google Maps खोलें या 112 पर कॉल करें।'
                  : 'No hospital results available yet. Allow location, search an area above, open Google Maps, or call 112.'}
              </p>
              <div className="flex flex-wrap items-center justify-center gap-3">
                <a
                  href="tel:112"
                  className="inline-flex min-h-[52px] items-center justify-center gap-2 rounded-2xl bg-[#DC2626] px-6 py-3 text-base font-extrabold text-white hover:bg-red-700"
                >
                  <PhoneCall className="h-5 w-5" aria-hidden="true" />
                  <span>{t(UI_COPY.call112, lang)}</span>
                </a>
                <a
                  href={openGoogleMapsHospitalsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-[52px] items-center justify-center gap-2 rounded-2xl border border-slate-300 bg-white px-5 py-3 text-base font-extrabold text-[#0F1E36] hover:bg-slate-50"
                >
                  <ExternalLink className="h-5 w-5" aria-hidden="true" />
                  <span>
                    {lang === 'hi'
                      ? 'Google Maps में अस्पताल खोलें'
                      : 'Open hospitals in Google Maps'}
                  </span>
                </a>
              </div>
            </div>
          ) : (
            <div className="grid gap-3.5 md:grid-cols-2">
              {hospitals.map((h, idx) => {
                const isNearest = idx === 0;
                const isSelected = selectedHospitalId === h.id;
                const navigateUrl = `https://www.google.com/maps/dir/?api=1&destination=${h.lat},${h.lng}`;
                const osmUrl = `https://www.openstreetmap.org/?mlat=${h.lat}&mlon=${h.lng}#map=16/${h.lat}/${h.lng}`;

                return (
                  <div
                    key={h.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => handlePanToHospital(h)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handlePanToHospital(h);
                      }
                    }}
                    className={`cursor-pointer rounded-2xl border p-4 shadow-sm transition-colors ${
                      isSelected
                        ? 'border-2 border-[#0F1E36] bg-slate-50'
                        : isNearest
                        ? 'border-2 border-[#DC2626] bg-red-50/40 hover:bg-red-50/60'
                        : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          {isNearest && (
                            <span className="text-xs font-extrabold text-[#DC2626]">
                              {lang === 'hi' ? '★ सबसे नजदीकी' : '★ Nearest'}
                            </span>
                          )}
                          {h.emergency && (
                            <span className="text-xs font-bold text-emerald-800">
                              24x7 Emergency
                            </span>
                          )}
                        </div>
                        <h2 className="text-lg font-extrabold text-[#0F1E36]">
                          {idx + 1}. {h.name}
                        </h2>
                        {h.address && (
                          <p className="mt-1 text-sm font-medium text-slate-600">
                            {h.address}
                          </p>
                        )}
                      </div>
                      <span className="font-mono-nums shrink-0 text-base font-extrabold text-[#DC2626]">
                        {h.distanceKm.toFixed(2)} km
                      </span>
                    </div>

                    {h.phone && (
                      <p className="font-mono-nums mt-1.5 text-xs font-semibold text-slate-600">
                        {h.phone}
                      </p>
                    )}

                    <div
                      className="mt-3 flex flex-wrap gap-2"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {h.phone && (
                        <a
                          href={`tel:${h.phone}`}
                          className="flex min-h-[48px] flex-1 min-w-[110px] items-center justify-center gap-1.5 rounded-xl bg-[#0F1E36] px-3 py-2 text-sm font-bold text-white hover:bg-[#162947]"
                        >
                          <PhoneCall className="h-4 w-4 shrink-0" aria-hidden="true" />
                          <span>{lang === 'hi' ? 'कॉल' : 'Call'}</span>
                        </a>
                      )}

                      <a
                        href={navigateUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex min-h-[48px] flex-1 min-w-[130px] items-center justify-center gap-1.5 rounded-xl bg-[#DC2626] px-3 py-2 text-sm font-extrabold text-white hover:bg-red-700"
                      >
                        <Navigation className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span>{lang === 'hi' ? 'रास्ता देखें' : 'Navigate'}</span>
                      </a>

                      <a
                        href={osmUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex min-h-[48px] flex-1 min-w-[130px] items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-[#0F1E36] hover:bg-slate-50"
                      >
                        <ExternalLink className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span>{lang === 'hi' ? 'OSM में देखें' : 'View on OSM'}</span>
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Collapsible Diagnostics Panel */}
      <div className="mt-6">
        <DiagnosticsPanel
          lang={lang}
          hospitalsCount={hospitals.length}
          refreshTrigger={fitVersion}
          hospitalDebug={{
            coords: activeOrigin
              ? {lat: activeOrigin.lat, lng: activeOrigin.lng}
              : null,
            accuracyMeters: activeOrigin?.accuracy ?? null,
            radiusUsedMeters,
            dataSource: dataSourceMode,
            apiError,
          }}
        />
      </div>
    </section>
  );
};
