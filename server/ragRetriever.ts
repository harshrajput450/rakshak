import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {
  EmergencyId,
  EmergencyProtocol,
  EmergencySourceRef,
  FirstAidKnowledgeBase,
  Language,
} from '../src/types/emergency.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let cachedKb: FirstAidKnowledgeBase | null = null;
let cachedSynonyms: Record<string, string[]> = {};

function loadKnowledgeBase(): FirstAidKnowledgeBase {
  if (cachedKb) return cachedKb;
  const candidatePaths = [
    path.resolve(__dirname, '../data/firstaid.json'),
    path.resolve(process.cwd(), 'data/firstaid.json'),
    path.resolve(process.cwd(), 'public/data/firstaid.json'),
  ];
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      cachedKb = JSON.parse(fs.readFileSync(p, 'utf8')) as FirstAidKnowledgeBase;
      return cachedKb;
    }
  }
  return {
    version: '2.0.0',
    disclaimer: {
      en: 'Informational guidance until help arrives. Not a substitute for doctors.',
      hi: 'मदद आने तक के लिए सूचनात्मक मार्गदर्शन। यह डॉक्टर का विकल्प नहीं है।',
    },
    sources: ['IFRC First Aid Reference Centre', 'WHO Basic Emergency Care'],
    protocols: [],
  };
}

function loadSynonyms(): Record<string, string[]> {
  if (Object.keys(cachedSynonyms).length > 0) return cachedSynonyms;
  const candidatePaths = [
    path.resolve(__dirname, '../ml/synonyms.json'),
    path.resolve(process.cwd(), 'ml/synonyms.json'),
  ];
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as {
          intents?: Record<string, string[]>;
        };
        cachedSynonyms = parsed.intents || {};
        return cachedSynonyms;
      } catch {
        // Ignore
      }
    }
  }
  return {};
}

export interface RetrievedFirstAidContext {
  protocols: EmergencyProtocol[];
  contextText: string;
  sources: EmergencySourceRef[];
  validProtocolIds: EmergencyId[];
}

function normalizeForRag(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function retrieveRelevantFirstAidContext(
  query: string,
  lang: Language,
  limit = 3
): RetrievedFirstAidContext {
  const kb = loadKnowledgeBase();
  const synonyms = loadSynonyms();
  const normQuery = normalizeForRag(query);
  const queryTokens = new Set(
    normQuery.split(' ').filter((t) => t.length >= 2)
  );

  const scored = kb.protocols.map((protocol) => {
    let score = 0;

    // 1. Direct match against synonyms (Hindi Devanagari + Hinglish + English)
    const syns = synonyms[protocol.id] || [];
    for (const phrase of syns) {
      const pNorm = normalizeForRag(phrase);
      if (!pNorm) continue;
      if (pNorm.includes(' ')) {
        if (normQuery.includes(pNorm)) {
          score += 8;
        }
      } else if (queryTokens.has(pNorm)) {
        score += 4;
      } else if (pNorm.length >= 4 && normQuery.includes(pNorm)) {
        score += 2;
      }
    }

    // 2. Match against protocol titles, subtitles, and steps in both languages
    const haystack = normalizeForRag(
      [
        protocol.title.en,
        protocol.title.hi,
        protocol.subtitle.en,
        protocol.subtitle.hi,
        protocol.shortLabel.en,
        protocol.shortLabel.hi,
        ...protocol.steps.map((s) => `${s.en} ${s.hi}`),
      ].join(' ')
    );

    for (const tok of queryTokens) {
      if (tok.length >= 3 && haystack.includes(tok)) {
        score += 1.5;
      }
    }

    if (protocol.urgency === 'critical' && score > 0) {
      score += 0.5;
    }

    return {protocol, score};
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored
    .filter((entry) => entry.score > 0)
    .slice(0, limit)
    .map((entry) => entry.protocol);

  const selected = top;

  const sourceMap = new Map<string, EmergencySourceRef>();
  for (const proto of selected) {
    for (const src of proto.sources || []) {
      if (!sourceMap.has(src.name)) {
        sourceMap.set(src.name, src);
      }
    }
  }

  const contextText = selected
    .map((proto) => {
      const preferredSteps = proto.steps
        .map((s, idx) => `${idx + 1}. ${s[lang]} (${s.en})`)
        .join('\n');
      const doNotList = proto.doNot.map((d) => `- ${d[lang]}`).join('\n');
      return [
        `[Protocol ID: ${proto.id}] Title: ${proto.title.en} / ${proto.title.hi} | Urgency: ${proto.urgency}`,
        `Call 112 Guidance: ${proto.call112First[lang]}`,
        `Reviewed Steps:\n${preferredSteps}`,
        `Do NOT:\n${doNotList}`,
        `When to get emergency help: ${proto.whenToGetHelp[lang]}`,
        `Sources: ${proto.sources.map((s) => s.name).join(', ')}`,
      ].join('\n');
    })
    .join('\n\n---\n\n');

  return {
    protocols: selected,
    contextText,
    sources: Array.from(sourceMap.values()).slice(0, 5),
    validProtocolIds: kb.protocols.map((p) => p.id),
  };
}

export function getAllProtocolIds(): EmergencyId[] {
  return loadKnowledgeBase().protocols.map((p) => p.id);
}

export function getSourcesForProtocol(
  protocolId: EmergencyId | null
): EmergencySourceRef[] {
  if (!protocolId) return [];
  const found = loadKnowledgeBase().protocols.find((p) => p.id === protocolId);
  return found?.sources || [];
}

export function getProtocolById(
  protocolId: EmergencyId | null
): EmergencyProtocol | null {
  if (!protocolId) return null;
  return loadKnowledgeBase().protocols.find((p) => p.id === protocolId) || null;
}
