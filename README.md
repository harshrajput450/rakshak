# रक्षक (Rakshak) — Offline Voice-Guided Emergency First-Aid Assistant

**रक्षक (Rakshak)** is a bilingual (**Hindi / English / Hinglish**) offline-first Progressive Web App designed to help bystanders take calm, safe, immediate first-aid action until medical responders arrive.

> **Guidance until help arrives. Not a replacement for doctors.**  
> **मदद आने तक के लिए मार्गदर्शन। यह डॉक्टर का विकल्प नहीं है।**

---

## Key Capabilities & Offline Architecture

- **Zero External AI APIs**: No Gemini, OpenAI, Groq, Claude, or cloud inference/TTS APIs anywhere. Classification, guided triage, voice playback, CPR coaching, and first-aid protocols run 100% locally on the user's device.
- **Locally Trained Offline ML Classifier (`public/model.json`)**:
  - TF-IDF L2 Centroids + Balanced Multinomial Naive Bayes ensemble trained locally in pure Node.js (`npm run train`) across **21 labels** (20 emergency intents + `unknown`).
  - Verified on-device with Web Crypto **SHA-256** integrity checks before loading or updating.
  - **CPR Breathing Safety Rule**: Phrases such as `"not breathing"` or `"saans nahi"` without explicit unconsciousness confirmation prompt an urgent `Call 112` + breathing & responsiveness check before jumping directly to CPR.
  - **Low-Confidence Fallback (`< 0.55`)**: Displays top-3 suggested emergencies, all 20 direct emergency tiles, and Guided Triage.
- **Observed Classifier Metrics (`v1.0.0`)**:
  - Dataset: **1,511** deduplicated EN / Hinglish / Devanagari Hindi examples (1,198 train / 313 stratified validation).
  - Validation Accuracy: **88.18%** | Validation Macro F1: **89.45%**
  - Independent Held-Out Test Set (`ml/test-phrases.json`): **63/63 (100.00%)**
  - Critical Safety Evaluation (`npm run safety-eval`): **PASSED**
- **20 Bilingual First-Aid Protocols (`/data/firstaid.json`)**:
  - Fixed, curated bystander guides (5–8 steps, `doNot`, `whenToGetHelp`, `call112First`, clinical source links, `review_status: "pending_medical_review"`)—never generated dynamically or modified by ML training.
- **10-Question Guided Triage (`/triage`)**:
  - Structured Yes / No / Not-Sure flow with voice readout, red-flag immediate escalation, and an **on-device-only camera photo reference** (`<input type="file" accept="image/*" capture="environment">`) with zero upload, AI, or collection.
- **Calm Female-Preferred Voice & Speech Input (`/lib/voice.ts`)**:
  - Prioritizes female-sounding `hi-IN` and `en-IN` voices where available on the user's OS/browser (`voiceschanged`), with a voice selector, enable/disable toggle, and honest browser voice availability notices.
  - Click-to-speak `SpeechRecognition` (`hi-IN` / `en-IN`), live **editable** transcript box, permanent text fallback, and voice commands (`Next` / `Repeat` / `Back` / `अगला` / `दोबारा` / `पिछला`).
  - *Honest browser note*: Some browsers (such as Android Chrome) rely on OS/Google speech services for `SpeechRecognition`, so when offline, users can always type directly in the text box, use Guided Check (`/triage`), or tap any of the 20 emergency tiles.
- **Live 110 BPM CPR Coach & SOS Sharing**:
  - Web Audio metronome + `DeviceMotion` accelerometer feedback + manual tap fallback.
  - Explicit confirmation step and offline cellular warning before opening `wa.me` or `sms:` links, plus `tel:112`.
- **Preserved Google Maps & Nearby Hospital Finder**:
  - Google Maps JS API (`@vis.gl/react-google-maps`) + Places API (New) `/api/hospitals` + `/api/geocode`, live `watchPosition`, 5-minute cache, Overpass API (OSM) fallback, and offline `localStorage` cached timestamp display.

---

## Privacy-Preserving Continuous Learning & Signed Model Updates

Rakshak improves **only via controlled offline retraining**, never by silently retraining on user devices or falsely claiming federated learning:

1. **Explicit Opt-In Consent (Off by Default)**: No feedback is recorded or uploaded unless the user enables learning consent.
2. **Zero-PII Sanitization**: Client (`lib/feedback.ts`) and server (`server/learningPipeline.ts`) strip emails, URLs, phone/ID numbers, GPS coordinates, and common name intros; camera photos are never collected.
3. **Encrypted Storage & 90-Day Retention**: Consented signals are encrypted at rest with **AES-256-GCM** (`server_data/learning_signals.enc`), isolated behind `RAKSHAK_ADMIN_TOKEN`, and pruned after 90 days.
4. **Consent Withdrawal & Deletion**: Users can withdraw consent and delete local + server signals anytime via `POST /api/learning/delete` or `/admin`.
5. **Human-Reviewed Retraining (`npm run retrain`)**: Deduplicates approved signals, backs up `/ml/dataset.json` and `/public/model.json`, compares candidate accuracy/F1 against the active model, enforces `ml/safety-eval.js`, and publishes versioned signed artifacts (`/public/models/manifest.json`, `/public/models/model-vX.Y.Z.json`, `/public/model.json`).
6. **Client Rollback & Network Awareness**: `/lib/modelUpdater.ts` verifies SHA-256 before activating updates, preserves the previous working model for instant rollback, and respects Wi-Fi/Data-Saver/battery preferences where supported by the browser.

---

## Google Maps Platform Setup (Maps JavaScript API & Places API (New))

1. **Create a Google Cloud Project & Enable Billing** in the [Google Cloud Console](https://console.cloud.google.com/).
2. **Enable Required APIs**: **Maps JavaScript API** and **Places API (New)**.
3. **Create & Restrict Two Separate Keys**:
   - `NEXT_PUBLIC_GOOGLE_MAPS_KEY` (browser): Restrict by **HTTP referrers** (`http://localhost:3000/*`, production domain) and API **Maps JavaScript API**.
   - `GOOGLE_PLACES_KEY` (server only): Restrict to **Places API (New)** for `/api/hospitals` and `/api/geocode`.
4. **Set Daily Quota Limits & Budget Alerts** in Google Cloud Quotas and Billing Budgets.

---

## Local Setup, Training & Verification

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure `.env.local`** (copy from `.env.example`):
   ```env
   NEXT_PUBLIC_GOOGLE_MAPS_KEY="your_referrer_restricted_maps_js_key"
   GOOGLE_PLACES_KEY="your_server_only_places_api_key"
   RAKSHAK_LEARNING_ENCRYPTION_KEY="your_32_byte_or_passphrase_secret"
   RAKSHAK_MODEL_SIGNING_SECRET="your_hmac_signing_secret"
   RAKSHAK_ADMIN_TOKEN="your_reviewer_admin_token"
   ```

3. **Train & evaluate offline classifier**
   ```bash
   npm run train
   npm run safety-eval
   ```

4. **Controlled retraining from approved signals / exported `feedback.json`**
   ```bash
   npm run retrain
   # or from an exported feedback JSON file:
   node ml/retrain.js --from-file=feedback.json
   ```

5. **Run development server & verify build**
   ```bash
   npm run dev
   npm run lint
   npm run build
   ```
# rakshak
