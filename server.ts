import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {
  AiApiError,
  checkAiRateLimit,
  getAiServiceConfig,
  handleFirstAidAiRequest,
} from './server/aiProvider.ts';
import {
  findNearbyHospitals,
  geocodeAreaQuery,
  type HospitalsApiError,
} from './server/hospitalsHandler.ts';
import {
  deleteSignalsForDevice,
  getReviewerQueue,
  ingestLearningSignal,
  isAuthorizedReviewer,
  reviewLearningSignal,
} from './server/learningPipeline.ts';
import type {EmergencyId} from './src/types/emergency.ts';

dotenv.config({path: '.env.local'});
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === 'production';

async function fetchSupabaseAdminRows(): Promise<{
  configured: boolean;
  events: unknown[];
  feedback: unknown[];
  note?: string;
}> {
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const anonKey = (process.env.SUPABASE_ANON_KEY || '').trim();

  if (!url || (!serviceKey && !anonKey)) {
    return {
      configured: false,
      events: [],
      feedback: [],
      note: 'Supabase credentials are not configured on the server.',
    };
  }

  if (!serviceKey) {
    return {
      configured: true,
      events: [],
      feedback: [],
      note: 'Anon RLS correctly blocks reading events; set SUPABASE_SERVICE_ROLE_KEY on server (or read directly in Supabase Dashboard) to query remote rows from /admin.',
    };
  }

  try {
    const headers = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    };
    const [evRes, fbRes] = await Promise.all([
      fetch(
        `${url}/rest/v1/emergency_events?select=*&order=created_at.desc&limit=100`,
        {headers}
      ),
      fetch(`${url}/rest/v1/feedback?select=*&order=created_at.desc&limit=100`, {
        headers,
      }),
    ]);

    const events = evRes.ok ? ((await evRes.json()) as unknown[]) : [];
    const feedback = fbRes.ok ? ((await fbRes.json()) as unknown[]) : [];
    return {
      configured: true,
      events: Array.isArray(events) ? events : [],
      feedback: Array.isArray(feedback) ? feedback : [],
    };
  } catch (err) {
    return {
      configured: true,
      events: [],
      feedback: [],
      note: err instanceof Error ? err.message : 'Unable to query Supabase.',
    };
  }
}

async function startServer() {
  const app = express();
  app.use(express.json({limit: '6mb'}));
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (
        err &&
        typeof err === 'object' &&
        'type' in err &&
        (err as {type?: string}).type === 'entity.too.large'
      ) {
        res.status(413).json({
          error: 'Uploaded image is too large. Please choose a smaller photo.',
          code: 'invalid_image',
        });
        return;
      }
      if (err instanceof SyntaxError && 'body' in err) {
        res.status(400).json({error: 'Invalid JSON request body.'});
        return;
      }
      next(err);
    }
  );

  app.get('/api/health', (_req, res) => {
    try {
      const manifestPath = path.join(
        __dirname,
        'public',
        'models',
        'manifest.json'
      );
      let latestModelVersion = '1.0.0';
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          latestModelVersion = manifest.latestVersion || latestModelVersion;
        } catch {
          // Ignore
        }
      }
      const aiConfig = getAiServiceConfig();
      res.json({
        status: 'ok',
        service: 'rakshak',
        offlineGuidesAvailable: true,
        aiConfigured: aiConfig.configured,
        aiProvider: aiConfig.provider,
        aiModel: aiConfig.model,
        aiFallbackModel: aiConfig.fallbackModel,
        latestModelVersion,
        supabaseConfigured: Boolean(
          process.env.SUPABASE_URL?.trim() &&
            process.env.SUPABASE_ANON_KEY?.trim()
        ),
        hospitalProvider: 'openstreetmap-overpass',
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[Rakshak /api/health] error:', err);
      res.status(500).json({status: 'error', error: 'Health check failed'});
    }
  });

  app.get('/api/ai/status', (_req, res) => {
    const aiConfig = getAiServiceConfig();
    res.json({
      provider: aiConfig.provider,
      model: aiConfig.model,
      fallbackModel: aiConfig.fallbackModel,
      configured: aiConfig.configured,
      ragEnabled: false,
    });
  });

  app.post('/api/ai/assist', async (req, res) => {
    const forwarded = req.headers['x-forwarded-for'];
    const ip =
      (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '') ||
      req.socket?.remoteAddress ||
      'unknown';

    const rl = checkAiRateLimit(ip);
    if (!rl.allowed) {
      res.status(429).json({
        error: `Please wait ${rl.retryAfterSec}s before requesting live smart assistance again. If anyone is in immediate danger, call 112.`,
        code: 'rate_limited',
        retryAfterSec: rl.retryAfterSec,
      });
      return;
    }

    try {
      const result = await handleFirstAidAiRequest(req.body || {});
      res.json(result);
    } catch (err) {
      if (err instanceof AiApiError) {
        res.status(err.statusCode).json({
          error: err.message,
          code: err.code,
          retryAfterSec: err.retryAfterSec,
        });
        return;
      }
      console.error('[Rakshak /api/ai/assist] unexpected error:', err);
      res.status(500).json({
        error:
          'Live smart assistance is temporarily unavailable. Please try again shortly. If anyone is in immediate danger, call 112.',
        code: 'provider_error',
      });
    }
  });

  // Safe public Supabase client config (anon key is insert-only via RLS)
  app.get('/api/supabase-config', (_req, res) => {
    res.json({
      url: (process.env.SUPABASE_URL || '').trim(),
      anonKey: (process.env.SUPABASE_ANON_KEY || '').trim(),
    });
  });

  app.get('/api/models/manifest', (_req, res) => {
    try {
      const manifestPath = path.join(
        __dirname,
        'public',
        'models',
        'manifest.json'
      );
      if (!fs.existsSync(manifestPath)) {
        res.status(404).json({error: 'Model manifest not found.'});
        return;
      }
      res.json(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    } catch (err) {
      console.error('[Rakshak /api/models/manifest] error:', err);
      res.status(500).json({error: 'Unable to read model manifest.'});
    }
  });

  // --- Free Overpass + Nominatim Nearby Hospital Endpoints (Zero API Keys) ---
  const handleHospitalsRequest = async (
    req: express.Request,
    res: express.Response
  ) => {
    try {
      const rawLat = req.method === 'GET' ? req.query.lat : req.body?.lat;
      const rawLng = req.method === 'GET' ? req.query.lng : req.body?.lng;
      const rawRadius =
        req.method === 'GET' ? req.query.radius : req.body?.radius;
      const rawRefresh =
        req.method === 'GET' ? req.query.refresh : req.body?.refresh;

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
        res.status(400).json({
          error: 'Valid lat and lng coordinates are required.',
        });
        return;
      }

      const result = await findNearbyHospitals({
        lat,
        lng,
        initialRadius: radius,
        bypassCache,
      });
      res.json(result);
    } catch (err) {
      console.error('[Rakshak /api/hospitals] Error:', err);
      const apiErr = err as HospitalsApiError;
      res.status(apiErr.statusCode || 500).json({
        error: apiErr.message || 'Failed to search nearby hospitals.',
      });
    }
  };

  app.get('/api/hospitals', handleHospitalsRequest);
  app.post('/api/hospitals', handleHospitalsRequest);

  const handleGeocodeRequest = async (
    req: express.Request,
    res: express.Response
  ) => {
    try {
      const rawQuery = req.method === 'GET' ? req.query.q : req.body?.query;
      const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
      if (!query) {
        res.status(400).json({error: 'Please enter an area or city name.'});
        return;
      }
      const location = await geocodeAreaQuery(query);
      res.json(location);
    } catch (err) {
      console.error('[Rakshak /api/geocode] Error:', err);
      const apiErr = err as HospitalsApiError;
      res.status(apiErr.statusCode || 500).json({
        error: apiErr.message || 'Failed to find the entered area.',
      });
    }
  };

  app.get('/api/geocode', handleGeocodeRequest);
  app.post('/api/geocode', handleGeocodeRequest);

  // --- Hidden /admin & Privacy-Preserving Continuous Learning Endpoints ---
  app.get('/api/admin/events', async (req, res) => {
    if (!isAuthorizedReviewer(req.headers.authorization)) {
      res.status(401).json({error: 'RAKSHAK_ADMIN_TOKEN required.'});
      return;
    }
    const [remote, localSignals] = await Promise.all([
      fetchSupabaseAdminRows(),
      Promise.resolve(getReviewerQueue()),
    ]);
    res.json({
      supabaseConfigured: remote.configured,
      supabaseNote: remote.note || null,
      emergencyEvents: remote.events,
      feedback: remote.feedback,
      localQueue: localSignals,
      exportedAt: new Date().toISOString(),
    });
  });

  app.post('/api/learning/signals', (req, res) => {
    try {
      const result = ingestLearningSignal(req.body || {});
      res.status(result.accepted ? 200 : 400).json(result);
    } catch (err) {
      console.error('[Rakshak /api/learning/signals] error:', err);
      res.status(500).json({accepted: false, error: 'Failed to store signal.'});
    }
  });

  app.post('/api/learning/delete', (req, res) => {
    try {
      const deviceTag =
        typeof req.body?.deviceTag === 'string' ? req.body.deviceTag : '';
      const deleted = deleteSignalsForDevice(deviceTag);
      res.json({deleted});
    } catch (err) {
      console.error('[Rakshak /api/learning/delete] error:', err);
      res.status(500).json({error: 'Failed to delete learning signals.'});
    }
  });

  app.get('/api/learning/queue', (req, res) => {
    if (!isAuthorizedReviewer(req.headers.authorization)) {
      res.status(401).json({error: 'Reviewer authorization token required.'});
      return;
    }
    res.json({items: getReviewerQueue()});
  });

  app.post('/api/learning/review', (req, res) => {
    if (!isAuthorizedReviewer(req.headers.authorization)) {
      res.status(401).json({error: 'Reviewer authorization token required.'});
      return;
    }
    const id = typeof req.body?.id === 'string' ? req.body.id : '';
    const decision =
      req.body?.decision === 'approved' ? 'approved' : 'rejected';
    const correctedIntent =
      typeof req.body?.correctedIntent === 'string'
        ? (req.body.correctedIntent as EmergencyId | 'unknown')
        : undefined;
    const updated = reviewLearningSignal(id, decision, correctedIntent);
    if (!updated) {
      res.status(404).json({error: 'Signal not found.'});
      return;
    }
    res.json({item: updated});
  });

  if (!isProd) {
    const {createServer: createViteServer} = await import('vite');
    const vite = await createViteServer({
      server: {middlewareMode: true},
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Rakshak server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
