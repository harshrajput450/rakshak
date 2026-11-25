export type Language = 'hi' | 'en';
export type InputVoiceLanguage = 'hi' | 'hinglish' | 'en';
export type AiResolutionSource = 'gemini' | 'quota' | 'unavailable';
export type EmergencyEventSource = 'local' | 'gemini' | 'cache' | 'tile';

export type EmergencyId =
  | 'cardiac_arrest_cpr'
  | 'choking'
  | 'severe_bleeding'
  | 'seizure'
  | 'burns'
  | 'snakebite'
  | 'heart_attack'
  | 'stroke'
  | 'fainting'
  | 'fracture_injury'
  | 'head_injury'
  | 'drowning'
  | 'electric_shock'
  | 'poisoning'
  | 'heatstroke'
  | 'asthma_attack'
  | 'allergic_reaction'
  | 'dog_bite'
  | 'nosebleed'
  | 'low_blood_sugar';

export interface BilingualText {
  en: string;
  hi: string;
}

export interface EmergencySourceRef {
  name: string;
  url: string;
}

export interface EmergencyProtocol {
  id: EmergencyId;
  urgency: 'critical' | 'urgent';
  icon: string;
  title: BilingualText;
  shortLabel: BilingualText;
  subtitle: BilingualText;
  call112First: BilingualText;
  steps: BilingualText[];
  doNot: BilingualText[];
  whenToGetHelp: BilingualText;
  sources: EmergencySourceRef[];
  review_status: 'pending_medical_review' | 'clinically_reviewed';
  last_reviewed: string;
  supportsCprCoach?: boolean;
}

export interface FirstAidKnowledgeBase {
  version: string;
  disclaimer: BilingualText;
  sources: string[];
  protocols: EmergencyProtocol[];
}

export interface RankedIntentPrediction {
  intent: EmergencyId | 'unknown';
  confidence: number;
}

export interface OfflineClassificationResult {
  intent: EmergencyId | 'unknown';
  confidence: number;
  isLowConfidence: boolean;
  requiresBreathingSafetyCheck: boolean;
  top3: RankedIntentPrediction[];
  normalizedText: string;
  modelVersion: string;
  modelVerified: boolean;
  latencyMs: number;
}

export interface ModelVersionEntry {
  version: string;
  url: string;
  sha256: string;
  signature: string;
  trainedAt: string;
  accuracy: number;
  macroF1: number;
  heldOutAccuracy: number;
  safetyPassed: boolean;
  sizeBytes?: number;
}

export interface ModelManifest {
  latestVersion: string;
  updatedAt: string;
  minAppVersion: string;
  versions: ModelVersionEntry[];
}

export interface ModelStatusSnapshot {
  activeVersion: string;
  previousVersion: string | null;
  verified: boolean;
  source: 'indexeddb' | 'network' | 'bundled_cache';
  lastCheckedAt: string | null;
  updateAvailableVersion: string | null;
  lastError: string | null;
  accuracy: number | null;
  macroF1: number | null;
  sha256: string | null;
}

export interface LearningConsentState {
  consented: boolean;
  updatedAt: string | null;
  deviceTag: string;
}

export interface FeedbackSignalPayload {
  id: string;
  deviceTag: string;
  createdAt: string;
  language: Language;
  sanitizedText: string;
  predictedIntent: EmergencyId | 'unknown';
  confidence: number;
  correctedIntent: EmergencyId | 'unknown';
  helpful: boolean;
  source: 'classifier_feedback' | 'triage_correction';
  modelVersion: string;
  status?: 'pending' | 'approved' | 'rejected';
}

export interface VoiceOptionInfo {
  voiceURI: string;
  name: string;
  lang: string;
  isFemaleLikely: boolean;
  isMaleLikely: boolean;
  score: number;
}

export interface TrustedContact {
  id: string;
  name: string;
  phone: string;
}

export type HospitalDataSource = 'osm' | 'cache';

export interface HospitalItem {
  id: string;
  name: string;
  address?: string;
  phone?: string;
  lat: number;
  lng: number;
  emergency?: boolean;
  distanceKm: number;
  source: HospitalDataSource;
}

export interface HospitalSearchResponse {
  hospitals: HospitalItem[];
  radiusUsed: number;
  cached?: boolean;
  source: 'osm';
  error?: string;
}

export type AppView =
  | 'home'
  | 'guide'
  | 'cpr'
  | 'sos'
  | 'hospitals'
  | 'triage'
  | 'admin';

export interface ImageAttachmentPayload {
  mimeType: string;
  data: string; // raw base64 without data URL prefix
  previewUrl?: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
}

export interface ConversationTurnInput {
  role: 'user' | 'assistant';
  text: string;
}

export interface StructuredFirstAidAiResponse {
  urgency: 'critical' | 'urgent' | 'general';
  adviseCall112: boolean;
  acknowledgment: string;
  immediateSteps: string[];
  doNot: string[];
  whenToSeekHelp: string;
  followUpQuestion: string;
  requiresBreathingSafetyCheck: boolean;
  matchedProtocolId: EmergencyId | null;
  confidenceLevel: 'high' | 'moderate' | 'low';
  imageObservationNote: string;
  sources: EmergencySourceRef[];
  provider: string;
  model: string;
  disclaimer: string;
  resolutionSource?: AiResolutionSource;
  confidence?: number;
}

export interface ChatMessageItem {
  id: string;
  role: 'user' | 'assistant';
  createdAt: string;
  language: Language;
  text: string;
  queryText?: string;
  supabaseEventId?: string | null;
  imagePreviewUrl?: string;
  aiResponse?: StructuredFirstAidAiResponse;
}
