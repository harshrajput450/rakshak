import type {Language} from '../types/emergency';

export const UI_COPY = {
  appName: {
    en: 'रक्षक',
    hi: 'रक्षक',
  },
  appTagline: {
    en: 'Emergency Assistance',
    hi: 'आपातकालीन सहायता',
  },
  call112: {
    en: 'Call 112',
    hi: '112 कॉल करें',
  },
  navHome: {
    en: 'Assistant',
    hi: 'सहायक',
  },
  navTriage: {
    en: 'Guided Check',
    hi: 'सवाल-जवाब',
  },
  navCpr: {
    en: 'CPR Coach',
    hi: 'सीपीआर कोच',
  },
  navSos: {
    en: 'SOS',
    hi: 'एसओएस',
  },
  navHospitals: {
    en: 'Hospitals',
    hi: 'अस्पताल',
  },
  heroHeadline: {
    en: 'Stay calm. Speak, type, or show what happened.',
    hi: 'शांत रहें। जो हुआ वह बोलें, लिखें या फोटो दिखाएं।',
  },
  heroSub: {
    en: 'Live smart first-aid guidance in Hindi, Hinglish, and English — with 20 offline emergency guides always ready.',
    hi: 'हिंदी, हिंग्लिश और अंग्रेज़ी में तुरंत प्राथमिक सहायता मार्गदर्शन — बिना इंटरनेट 20 ऑफ़लाइन गाइड भी तैयार हैं।',
  },
  speakButton: {
    en: 'Speak / बोलिए',
    hi: 'बोलिए / Speak',
  },
  quickSelectTitle: {
    en: 'Offline First-Aid Guides (20 Medically Reviewed Protocols)',
    hi: 'ऑफ़लाइन प्राथमिक सहायता गाइड (20 समीक्षित प्रोटोकॉल)',
  },
  voiceOnlyLabel: {
    en: 'Voice-Only',
    hi: 'केवल आवाज़',
  },
  offlineBanner: {
    en: 'Offline Mode — Live assistance is unavailable. Offline first-aid guides, voice playback, triage, and CPR coach remain active.',
    hi: 'ऑफ़लाइन मोड — लाइव सहायता उपलब्ध नहीं है। ऑफ़लाइन गाइड, आवाज़ प्लेबैक, सवाल-जवाब और सीपीआर कोच सक्रिय हैं।',
  },
  safetyFooter: {
    en: 'Guidance until help arrives. Not a replacement for doctors.',
    hi: 'मदद आने तक के लिए मार्गदर्शन। यह डॉक्टर का विकल्प नहीं है।',
  },
  cameraHelperNote: {
    en: 'Local photo check only — no upload or medical diagnosis. Call 112 in any emergency.',
    hi: 'केवल स्थानीय फोटो सहायता — कोई अपलोड या चिकित्सीय जांच नहीं। किसी भी आपात स्थिति में 112 पर कॉल करें।',
  },
  doNotTitle: {
    en: 'What NOT To Do',
    hi: 'क्या बिल्कुल न करें',
  },
  whenToGetHelpTitle: {
    en: 'When to Get Emergency Help Immediately',
    hi: 'तुरंत अस्पताल या एम्बुलेंस मदद कब लें',
  },
  nextStep: {
    en: 'Next',
    hi: 'अगला',
  },
  repeatStep: {
    en: 'Repeat',
    hi: 'दोहराएं',
  },
  prevStep: {
    en: 'Back',
    hi: 'पिछला',
  },
  backHome: {
    en: 'All Emergencies',
    hi: 'सभी आपात स्थितियाँ',
  },
  openCprCoach: {
    en: 'Start Live CPR Coach (110 BPM)',
    hi: 'लाइव सीपीआर कोच शुरू करें (110 BPM)',
  },
  tapToSpeak: {
    en: 'Tap to Speak',
    hi: 'बोलने के लिए दबाएं',
  },
  stopListening: {
    en: 'Listening... Tap to Stop',
    hi: 'सुन रहा हूँ... रोकने के लिए दबाएं',
  },
  shareLocationSos: {
    en: 'Share Location / SOS',
    hi: 'लोकेशन / SOS भेजें',
  },
  typePlaceholder: {
    en: 'Describe what happened in English, Hinglish, or Hindi...',
    hi: 'हिंदी, हिंग्लिश या अंग्रेज़ी में बताएं कि क्या हुआ है...',
  },
  sendText: {
    en: 'Send',
    hi: 'भेजें',
  },
} as const;

export function t(entry: {en: string; hi: string}, lang: Language): string {
  return entry[lang];
}
