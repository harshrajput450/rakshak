# रक्षक (Rakshak) — Bilingual Voice-First Emergency First-Aid Assistant

**रक्षक (Rakshak)** is a bilingual (**Hindi / Hinglish / English**) offline-capable Progressive Web App designed to help bystanders take calm, safe, immediate first-aid action until medical responders arrive.

> **Guidance until help arrives. Not a replacement for doctors.**  
> **मदद आने तक के लिए मार्गदर्शन। यह डॉक्टर का विकल्प नहीं है।**

---

## Core Architecture (Free Tier & Privacy First)

1. **Smart Conversation (`/server/aiProvider.ts`)**:
   - Every chat message, attached image, and recent conversation turns are sent to Gemini for contextual understanding and direct response generation.
   - Responses match the user's language and style, including Hindi, Hinglish, English, and regional-language text. Health guidance avoids definitive diagnoses and prescriptions, asks focused follow-up questions, and prioritizes calling India's 112 for immediate danger.
   - A first-aid guide is linked only when the model identifies a directly relevant protocol. The 20 curated offline guides remain available as manual supplementary resources.
   - **3-second client & server debounce**, `1s / 2s / 4s` retry backoff with jitter on `429`/`503`, and fallback model retry are retained. If the model is unavailable, the app says so rather than substituting a cached or keyword-classified response.

2. **Offline Model and Learning Tools (`/lib/classifier.ts`)**:
   - The verified TF-IDF / Naive Bayes model (`public/model.json`) and keyword/synonym matching remain available for offline model evaluation and reviewer feedback; they do not generate or replace live chat responses.
   - Next/Back/Repeat step buttons, emergency tile taps, Guided Triage (`/triage`), and Live 110 BPM CPR Coach never trigger model calls.

3. **Reliable Hindi Voice Recognition (`/lib/speechController.ts`)**:
   - Single `SpeechRecognition` instance managed via `useRef`, `continuous = false`, `interimResults = true`, `maxAlternatives = 3`.
   - User-gesture start only, stop-before-start waiting for `onend`, double-tap guard, single `400 ms` auto-retry on `aborted` / `no-speech`, automatic `hi-IN` → `en-IN` retry on `language-not-supported`, manual **हिंदी / Hinglish / English** toggle, iframe preview detection banner (`Open in new tab`), and auto-focused Enter-to-submit fallback box.
   - Voice input and output use browser-native APIs; there is no separate voice backend or speech API key. A browser `network` recognition error means its speech service could not connect and does not prove that the device internet is down. Offline dictation additionally requires an installed on-device speech engine. Voice replies use local `SpeechSynthesis` device voices.

4. **Free Nearby Hospital Finder (Leaflet + OpenStreetMap + Overpass API)**:
   - Zero Google Maps or Places API keys required.
   - Uses **Leaflet** with **OpenStreetMap** tiles, **Overpass API** queries across expanding `5 / 10 / 20 / 40 km` radii, **Nominatim** area search, live `watchPosition`, offline cached hospital list, and a key-free `"Open hospitals in Google Maps"` search link.

5. **Anonymous Supabase Storage (No Login Required)**:
   - Uses a random persistent `device_id` (`crypto.randomUUID()`), consent off by default (`"Help improve Rakshak by saving anonymous emergency phrases?"`), PII/phone/trusted-contact-name stripping, 2-decimal rounded optional `approx_lat`/`approx_lng`, and an offline `localStorage` queue that flushes automatically when online.

---

## Supabase Database Setup

Run the SQL in [`/supabase/schema.sql`](./supabase/schema.sql) inside your **Supabase SQL Editor**:

```sql
create extension if not exists pgcrypto;

create table if not exists public.emergency_events (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  phrase text not null,
  language text not null,
  matched_intent text not null,
  source text not null check (source in ('local', 'gemini', 'cache', 'tile')),
  confidence numeric,
  approx_lat numeric(5, 2),
  approx_lng numeric(5, 2),
  created_at timestamptz not null default now()
);

create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  event_id uuid references public.emergency_events(id) on delete set null,
  phrase text not null,
  matched_intent text not null,
  is_correct boolean not null,
  corrected_intent text,
  created_at timestamptz not null default now()
);

alter table public.emergency_events enable row level security;
alter table public.feedback enable row level security;

drop policy if exists "anon can insert events" on public.emergency_events;
create policy "anon can insert events"
  on public.emergency_events
  for insert
  to anon
  with check (true);

drop policy if exists "anon can insert feedback" on public.feedback;
create policy "anon can insert feedback"
  on public.feedback
  for insert
  to anon
  with check (true);
```

---

## Server Configuration (`.env.local`)

Enter private API keys and server secrets in the ignored `.env.local` file in the project root. The file is not sent to the browser or committed. `.env.example` lists the supported variable names:

```env
GEMINI_API_KEY=""
AI_PROVIDER="gemini"
AI_MODEL="gemini-4-hydrogen"
AI_MODEL_FALLBACK="gemini-3.1-flash-lite"
SUPABASE_URL=""
SUPABASE_ANON_KEY=""
RAKSHAK_ADMIN_TOKEN=""
RAKSHAK_MODEL_SIGNING_SECRET=""
RAKSHAK_LEARNING_ENCRYPTION_KEY=""
SUPABASE_SERVICE_ROLE_KEY=""
```

Never put private keys in browser code or variables with a `VITE_` / `NEXT_PUBLIC_` prefix. `SUPABASE_ANON_KEY` is a public client key governed by Supabase RLS; keep `SUPABASE_SERVICE_ROLE_KEY` server-only.

---

## Hidden `/admin` Dashboard

Navigate directly to `/admin` (not linked in main navigation) and authenticate with `RAKSHAK_ADMIN_TOKEN` to inspect:
- Recent anonymized `emergency_events` phrases and `feedback` submissions (when configured)
- Encrypted local reviewer queue approvals (`npm run retrain`)
- One-click **Export Training JSON** bundle

---

## Local Development, Training & Verification

```bash
npm install
npm run train
npm run safety-eval
npm run dev
npm run lint
npm run build
npx tsx --test tests/aiConversation.test.ts tests/upgrade.test.ts
```
