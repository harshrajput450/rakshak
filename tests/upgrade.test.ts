import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyEmergencyOffline} from '../lib/classifier.ts';
import {
  resetAiDebounceForTests,
  resolveFirstAidQuery,
} from '../lib/aiClient.ts';
import {
  clearHospitalsServerCache,
  findNearbyHospitals,
  parseOverpassElements,
  RADII_LADDER,
} from '../server/hospitalsHandler.ts';
import {stripTrustedContactNames} from '../lib/supabaseClient.ts';

test('1. Offline classifier still recognizes supported emergency phrases', async () => {
  const hiMatch = await classifyEmergencyOffline('सांप ने काट लिया है');
  assert.equal(hiMatch.intent, 'snakebite');
  assert.equal(hiMatch.isLowConfidence, false);
  assert.ok(hiMatch.confidence >= 0.55);

  const hinglishMatch = await classifyEmergencyOffline('seene me dard hai aur paseena');
  assert.equal(hinglishMatch.intent, 'heart_attack');
  assert.equal(hinglishMatch.isLowConfidence, false);

  const enMatch = await classifyEmergencyOffline('severe bleeding from leg cut');
  assert.equal(enMatch.intent, 'severe_bleeding');
  assert.equal(enMatch.isLowConfidence, false);
});

test('2. Live conversation requests are sent to AI even when the offline classifier is confident', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{message: string; history: unknown}> = [];
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      message: string;
      history: unknown;
    };
    requests.push(body);
    return new Response(
      JSON.stringify({
        urgency: 'urgent',
        adviseCall112: false,
        acknowledgment: 'AI response for the query',
        immediateSteps: ['Stay with the person and assess symptoms.'],
        doNot: [],
        whenToSeekHelp: '',
        followUpQuestion: '',
        requiresBreathingSafetyCheck: false,
        matchedProtocolId: 'snakebite',
        confidenceLevel: 'moderate',
        imageObservationNote: '',
        sources: [],
        provider: 'gemini',
        model: 'test-model',
        disclaimer: 'General safety information.',
      }),
      {status: 200, headers: {'Content-Type': 'application/json'}}
    );
  }) as typeof fetch;

  try {
    resetAiDebounceForTests();
    const resolved = await resolveFirstAidQuery({
      message: 'सांप ने काट लिया है',
      language: 'hi',
      history: [],
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].message, 'सांप ने काट लिया है');
    assert.equal(resolved.source, 'gemini');
    assert.equal(resolved.response.acknowledgment, 'AI response for the query');
    assert.equal(resolved.response.matchedProtocolId, 'snakebite');
    assert.equal(resolved.classification, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('3. Overpass hospital finder expands radius ladder [5000,10000,20000,40000] and parses OSM elements', async () => {
  assert.deepEqual(RADII_LADDER, [5000, 10000, 20000, 40000]);
  clearHospitalsServerCache();

  const seenRadii: number[] = [];
  const fakeFetch: typeof fetch = async (_url, init) => {
    const body = String(init?.body || '');
    const decoded = decodeURIComponent(body.replace(/^data=/, ''));
    const radiusMatch = decoded.match(/around:(\d+),/);
    const radius = radiusMatch ? Number(radiusMatch[1]) : 0;
    seenRadii.push(radius);

    // Return >=5 hospitals only at 20000m so it tries 5000, 10000, 20000 and stops
    const elements =
      radius < 20000
        ? [
            {
              type: 'node' as const,
              id: 1,
              lat: 28.615,
              lon: 77.21,
              tags: {name: 'City Clinic', amenity: 'hospital'},
            },
          ]
        : [1, 2, 3, 4, 5].map((i) => ({
            type: 'node' as const,
            id: i,
            lat: 28.6139 + i * 0.01,
            lon: 77.209 + i * 0.01,
            tags: {
              name: `Hospital ${i}`,
              amenity: 'hospital',
              emergency: i === 1 ? 'yes' : 'no',
            },
          }));

    return new Response(JSON.stringify({elements}), {
      status: 200,
      headers: {'Content-Type': 'application/json'},
    });
  };

  const res = await findNearbyHospitals({
    lat: 28.6139,
    lng: 77.209,
    bypassCache: true,
    fetchFn: fakeFetch,
  });

  assert.deepEqual(Array.from(new Set(seenRadii)), [5000, 10000, 20000]);
  assert.equal(res.radiusUsed, 20000);
  assert.equal(res.hospitals.length, 5);
  assert.equal(res.source, 'osm');

  // Verify distance sorting & deduplication
  const parsed = parseOverpassElements(
    [
      {
        type: 'way',
        id: 10,
        center: {lat: 28.65, lon: 77.25},
        tags: {name: 'Apollo Hospital'},
      },
      {
        type: 'node',
        id: 11,
        lat: 28.615,
        lon: 77.21,
        tags: {name: 'Apollo Hospital'},
      },
    ],
    28.6139,
    77.209
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, 'osm-node-11');
});

test('4. Supabase telemetry strips trusted contact names and PII', () => {
  const cleaned = stripTrustedContactNames(
    'Call Ramesh at 9876543210 or email ramesh@example.com for burn help',
    ['Ramesh', 'Anita']
  );
  assert.ok(!cleaned.includes('Ramesh'));
  assert.ok(!cleaned.includes('9876543210'));
  assert.ok(!cleaned.includes('ramesh@example.com'));
});
