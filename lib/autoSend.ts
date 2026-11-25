import {joinTranscriptParts} from './voice';

export const SILENCE_AUTO_SEND_MS = 1800;

export interface SpeechAutoSendDecision {
  committedFinal: string;
  displayTranscript: string;
  hasInterim: boolean;
  shouldCancelPendingTimer: boolean;
  shouldScheduleSilenceTimer: boolean;
}

/**
 * Pure decision helper for 1.8s silence auto-send:
 * - Strictly separates interim speech from final confirmed speech.
 * - Never permits auto-submission while non-empty interim speech is active.
 * - Resets/cancels any prior silence timer whenever new speech arrives.
 * - Prevents duplicate submissions of the exact same payload key.
 */
export function evaluateSpeechForAutoSend(params: {
  baseTranscript: string;
  sessionFinal: string;
  sessionInterim: string;
  autoSendEnabled: boolean;
  isSubmitting: boolean;
  lastSubmittedKey: string;
  attachmentKey?: string;
}): SpeechAutoSendDecision {
  const committedFinal = joinTranscriptParts(
    params.baseTranscript,
    params.sessionFinal
  );
  const cleanInterim = params.sessionInterim.replace(/\s+/g, ' ').trim();
  const displayTranscript = joinTranscriptParts(committedFinal, cleanInterim);
  const hasInterim = cleanInterim.length > 0;
  const payloadKey = `${committedFinal}::${params.attachmentKey || ''}`;

  const shouldScheduleSilenceTimer =
    params.autoSendEnabled &&
    !hasInterim &&
    !params.isSubmitting &&
    committedFinal.length > 0 &&
    payloadKey !== params.lastSubmittedKey;

  return {
    committedFinal,
    displayTranscript,
    hasInterim,
    shouldCancelPendingTimer: true,
    shouldScheduleSilenceTimer,
  };
}
