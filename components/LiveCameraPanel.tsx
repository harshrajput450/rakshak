import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  AlertCircle,
  Camera,
  Check,
  Eye,
  Loader2,
  RotateCcw,
  Send,
  SwitchCamera,
  Video,
  X,
} from 'lucide-react';
import {
  type CameraFacingMode,
  captureVideoFrameToImagePayload,
  checkCameraEnvironmentSupport,
  classifyCameraError,
  formatCameraError,
  openCameraStreamWithFallback,
  stopMediaStream,
} from '../lib/cameraUtils';
import {revokeImagePreviewUrl} from '../lib/imageUtils';
import type {ImageAttachmentPayload, Language} from '../src/types/emergency';

interface Props {
  lang: Language;
  isSubmitting: boolean;
  onAttachCapturedImage: (image: ImageAttachmentPayload) => void;
  onSendCapturedImage: (image: ImageAttachmentPayload) => Promise<boolean>;
  onClose: () => void;
}

export const LiveCameraPanel: React.FC<Props> = ({
  lang,
  isSubmitting,
  onAttachCapturedImage,
  onSendCapturedImage,
  onClose,
}) => {
  const [facingMode, setFacingMode] = useState<CameraFacingMode>('environment');
  const [liveAssistance, setLiveAssistance] = useState(false);
  const [isStarting, setIsStarting] = useState(true);
  const [isVideoReady, setIsVideoReady] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [streamActive, setStreamActive] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [canRetry, setCanRetry] = useState(true);
  const [capturedFrame, setCapturedFrame] =
    useState<ImageAttachmentPayload | null>(null);
  const [lastAnalyzedNote, setLastAnalyzedNote] = useState('');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mountedRef = useRef(true);
  const requestSeqRef = useRef(0);
  const capturedFrameRef = useRef<ImageAttachmentPayload | null>(null);
  capturedFrameRef.current = capturedFrame;

  const stopActiveStream = useCallback(() => {
    stopMediaStream(streamRef.current, videoRef.current);
    streamRef.current = null;
    if (mountedRef.current) {
      setStreamActive(false);
      setIsVideoReady(false);
    }
  }, []);

  const startCamera = useCallback(
    async (targetFacing: CameraFacingMode, preferExact = false) => {
      const seq = ++requestSeqRef.current;
      stopActiveStream();

      if (!mountedRef.current) return;
      setCameraError('');
      setCanRetry(true);
      setIsStarting(true);

      const envCheck = checkCameraEnvironmentSupport();
      if (!envCheck.supported && envCheck.errorCode) {
        setIsStarting(false);
        setCameraError(formatCameraError(envCheck.errorCode, lang));
        setCanRetry(false);
        return;
      }

      try {
        const result = await openCameraStreamWithFallback(targetFacing, {
          preferExact,
        });

        // If user closed panel or switched lens while permission dialog was open, immediately release stream
        if (!mountedRef.current || seq !== requestSeqRef.current) {
          stopMediaStream(result.stream, null);
          return;
        }

        streamRef.current = result.stream;
        setFacingMode(result.activeFacingMode);
        setStreamActive(true);
        setIsStarting(false);

        const videoEl = videoRef.current;
        if (videoEl) {
          videoEl.srcObject = result.stream;
          try {
            await videoEl.play();
          } catch {
            // AutoPlay muted playsInline may resolve on loadedmetadata
          }
        }
      } catch (err) {
        if (!mountedRef.current || seq !== requestSeqRef.current) return;
        const code = classifyCameraError(err);
        setIsStarting(false);
        setStreamActive(false);
        setCameraError(formatCameraError(code, lang));
        setCanRetry(
          code !== 'unsupported' &&
            code !== 'insecure_context' &&
            code !== 'not_found'
        );
      }
    },
    [lang, stopActiveStream]
  );

  useEffect(() => {
    mountedRef.current = true;
    void startCamera('environment', false);

    return () => {
      mountedRef.current = false;
      requestSeqRef.current += 1;
      stopMediaStream(streamRef.current, videoRef.current);
      streamRef.current = null;
      if (capturedFrameRef.current?.previewUrl) {
        revokeImagePreviewUrl(capturedFrameRef.current.previewUrl);
      }
    };
  }, [startCamera]);

  const handleClose = () => {
    requestSeqRef.current += 1;
    stopActiveStream();
    if (capturedFrame?.previewUrl) {
      revokeImagePreviewUrl(capturedFrame.previewUrl);
    }
    setCapturedFrame(null);
    onClose();
  };

  const handleSwitchCamera = () => {
    const nextFacing: CameraFacingMode =
      facingMode === 'environment' ? 'user' : 'environment';
    setLastAnalyzedNote('');
    void startCamera(nextFacing, true);
  };

  const handleCaptureFrame = async () => {
    const videoEl = videoRef.current;
    if (!videoEl || !streamActive || isCapturing) return;

    setIsCapturing(true);
    setCameraError('');
    setLastAnalyzedNote('');

    try {
      const payload = await captureVideoFrameToImagePayload(videoEl, lang);
      if (capturedFrame?.previewUrl) {
        revokeImagePreviewUrl(capturedFrame.previewUrl);
      }
      setCapturedFrame(payload);
    } catch (err) {
      setCameraError(
        err instanceof Error
          ? err.message
          : formatCameraError('capture_failed', lang)
      );
    } finally {
      setIsCapturing(false);
    }
  };

  const handleRetake = () => {
    if (capturedFrame?.previewUrl) {
      revokeImagePreviewUrl(capturedFrame.previewUrl);
    }
    setCapturedFrame(null);
    setCameraError('');
    setLastAnalyzedNote('');
    if (!streamActive && !isStarting) {
      void startCamera(facingMode, false);
    }
  };

  const handleAttachOnly = () => {
    if (!capturedFrame) return;
    const frameToAttach = capturedFrame;
    // Clear local ref without revoking previewUrl since VoiceControls now owns it
    capturedFrameRef.current = null;
    setCapturedFrame(null);
    stopActiveStream();
    onAttachCapturedImage(frameToAttach);
    onClose();
  };

  const handleConfirmSend = async () => {
    if (!capturedFrame || isSubmitting) return;
    const frameToSend = capturedFrame;
    const succeeded = await onSendCapturedImage(frameToSend);
    if (!mountedRef.current) return;

    if (succeeded) {
      if (frameToSend.previewUrl) {
        revokeImagePreviewUrl(frameToSend.previewUrl);
      }
      capturedFrameRef.current = null;
      setCapturedFrame(null);

      if (liveAssistance) {
        setLastAnalyzedNote(
          lang === 'hi'
            ? 'फ़ोटो विश्लेषण नीचे जुड़ गया है। जरूरत पड़ने पर नया फ़्रेम कैप्चर करें या कैमरा बंद करें।'
            : 'Frame analysis added below. Capture another frame anytime or close camera.'
        );
      } else {
        stopActiveStream();
        onClose();
      }
    }
  };

  const showLiveVideo =
    liveAssistance || (!capturedFrame && !cameraError);

  return (
    <div
      role="region"
      aria-label={lang === 'hi' ? 'लाइव कैमरा' : 'Live Camera'}
      className="rounded-2xl border-2 border-[#0F1E36] bg-[#0F1E36] text-white overflow-hidden shadow-md"
    >
      {/* Header Bar: Active Indicator + Live Assistance Toggle + Close */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-white/15">
        <div className="flex items-center gap-2.5">
          {streamActive ? (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-[#DC2626] px-2.5 py-1 text-xs font-extrabold text-white">
              <span className="h-2 w-2 rounded-full bg-white animate-ping" />
              <span>
                {lang === 'hi' ? 'कैमरा चालू' : 'Camera Active'}
              </span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-white/15 px-2.5 py-1 text-xs font-bold text-white">
              <Video className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{lang === 'hi' ? 'लाइव कैमरा' : 'Live Camera'}</span>
            </span>
          )}

          <span className="text-xs font-semibold text-slate-200">
            {facingMode === 'environment'
              ? lang === 'hi'
                ? 'पीछे का कैमरा'
                : 'Rear Camera'
              : lang === 'hi'
              ? 'सामने का कैमरा'
              : 'Front Camera'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setLiveAssistance((v) => !v)}
            aria-pressed={liveAssistance}
            className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${
              liveAssistance
                ? 'bg-[#15803D] text-white'
                : 'bg-white/10 text-slate-100 hover:bg-white/20'
            }`}
          >
            <Eye className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              {lang === 'hi'
                ? liveAssistance
                  ? 'लाइव सहायता: चालू'
                  : 'लाइव सहायता'
                : liveAssistance
                ? 'Live Assistance: On'
                : 'Live Assistance'}
            </span>
          </button>

          <button
            type="button"
            onClick={handleClose}
            aria-label={lang === 'hi' ? 'कैमरा बंद करें' : 'Close camera'}
            className="inline-flex min-h-[36px] items-center gap-1 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-bold text-white hover:bg-red-600 transition-colors"
          >
            <X className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{lang === 'hi' ? 'बंद करें' : 'Close'}</span>
          </button>
        </div>
      </div>

      {/* Live Assistance Explainer Note */}
      {liveAssistance && (
        <div className="bg-emerald-950/80 border-b border-emerald-700/50 px-4 py-2 text-xs font-medium text-emerald-100">
          {lang === 'hi'
            ? 'लाइव सहायता चालू है: कैमरा खुला रहेगा। जब चाहें फ़्रेम कैप्चर करें और पुष्टि करके सहायता के लिए भेजें (कोई ऑटो-अपलोड नहीं)।'
            : 'Live Assistance keeps the camera preview open. Capture a frame whenever needed and confirm to analyze — nothing uploads automatically.'}
        </div>
      )}

      {/* Main Viewport: Live Stream &/or Captured Preview */}
      <div className="p-3 sm:p-4 space-y-3 bg-slate-950">
        {cameraError && (
          <div
            role="alert"
            className="rounded-xl border border-amber-400/50 bg-amber-950/80 p-4 text-sm text-amber-100 space-y-3"
          >
            <div className="flex items-start gap-2.5">
              <AlertCircle
                className="h-5 w-5 text-amber-300 shrink-0 mt-0.5"
                aria-hidden="true"
              />
              <p className="font-semibold">{cameraError}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {canRetry && (
                <button
                  type="button"
                  onClick={() => void startCamera(facingMode, false)}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-white px-3.5 py-1.5 text-xs font-extrabold text-[#0F1E36] hover:bg-slate-100"
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{lang === 'hi' ? 'फिर कोशिश करें' : 'Retry'}</span>
                </button>
              )}
              <button
                type="button"
                onClick={handleClose}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-white/30 px-3.5 py-1.5 text-xs font-bold text-white hover:bg-white/10"
              >
                <span>{lang === 'hi' ? 'बंद करें' : 'Close'}</span>
              </button>
            </div>
          </div>
        )}

        <div
          className={`grid gap-3 ${
            liveAssistance && capturedFrame ? 'md:grid-cols-2' : 'grid-cols-1'
          }`}
        >
          {/* Live Camera Video Feed */}
          <div
            className={`relative rounded-xl overflow-hidden bg-black border border-white/15 flex items-center justify-center min-h-[220px] max-h-[380px] ${
              showLiveVideo ? '' : 'hidden'
            }`}
          >
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              onLoadedMetadata={() => setIsVideoReady(true)}
              onCanPlay={() => setIsVideoReady(true)}
              className={`w-full h-full max-h-[380px] object-contain ${
                facingMode === 'user' ? 'scale-x-[-1]' : ''
              }`}
            />

            {(isStarting || (streamActive && !isVideoReady)) && !cameraError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/75 text-xs font-semibold text-slate-200">
                <Loader2 className="h-6 w-6 animate-spin text-white" />
                <span>
                  {lang === 'hi'
                    ? 'कैमरा शुरू हो रहा है...'
                    : 'Opening camera...'}
                </span>
              </div>
            )}
          </div>

          {/* Captured Frame Preview (Before Confirmation / Send) */}
          {capturedFrame && (
            <div className="rounded-xl overflow-hidden bg-slate-900 border border-white/20 flex flex-col">
              <div className="relative flex-1 flex items-center justify-center bg-black min-h-[200px] max-h-[340px]">
                {capturedFrame.previewUrl && (
                  <img
                    src={capturedFrame.previewUrl}
                    alt={
                      lang === 'hi'
                        ? 'कैप्चर की गई फोटो पूर्वावलोकन'
                        : 'Captured photo preview'
                    }
                    className="w-full h-full max-h-[340px] object-contain"
                  />
                )}
                <span className="absolute top-2 left-2 rounded-md bg-black/75 px-2.5 py-1 text-xs font-bold text-white border border-white/20">
                  {lang === 'hi'
                    ? 'कैप्चर की गई फोटो — भेजने से पहले जांचें'
                    : 'Captured Preview — Confirm Before Sending'}
                </span>
              </div>
              <div className="px-3 py-2 bg-slate-900 border-t border-white/10 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
                <span className="font-mono-nums">
                  {capturedFrame.width}×{capturedFrame.height} ·{' '}
                  {capturedFrame.sizeBytes
                    ? `${Math.max(1, Math.round(capturedFrame.sizeBytes / 1024))} KB`
                    : 'JPEG'}
                </span>
                <span>
                  {lang === 'hi'
                    ? 'नीचे लिखा/बोला गया टेक्स्ट साथ भेजा जाएगा'
                    : 'Any typed/spoken text below will be sent together'}
                </span>
              </div>
            </div>
          )}
        </div>

        {lastAnalyzedNote && (
          <div className="rounded-xl border border-emerald-500/40 bg-emerald-950/70 px-3.5 py-2 text-xs font-semibold text-emerald-100">
            {lastAnalyzedNote}
          </div>
        )}

        {/* Action Controls Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2.5 pt-1">
          <div className="flex flex-wrap items-center gap-2">
            {!cameraError && (
              <button
                type="button"
                onClick={handleSwitchCamera}
                disabled={isStarting || isCapturing}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-white/25 bg-white/10 px-3.5 py-2 text-xs sm:text-sm font-bold text-white hover:bg-white/20 disabled:opacity-50"
              >
                <SwitchCamera className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>
                  {facingMode === 'environment'
                    ? lang === 'hi'
                      ? 'फ्रंट कैमरा'
                      : 'Switch to Front'
                    : lang === 'hi'
                    ? 'बैक कैमरा'
                    : 'Switch to Rear'}
                </span>
              </button>
            )}

            {capturedFrame && (
              <button
                type="button"
                onClick={handleRetake}
                disabled={isSubmitting}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-white/25 bg-white/10 px-3.5 py-2 text-xs sm:text-sm font-bold text-white hover:bg-white/20 disabled:opacity-50"
              >
                <RotateCcw className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{lang === 'hi' ? 'दोबारा लें' : 'Retake'}</span>
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {(!capturedFrame || liveAssistance) && !cameraError && (
              <button
                type="button"
                onClick={() => void handleCaptureFrame()}
                disabled={!streamActive || !isVideoReady || isCapturing || isStarting}
                className="inline-flex min-h-[46px] items-center gap-2 rounded-xl bg-white px-4 py-2 text-sm font-extrabold text-[#0F1E36] hover:bg-slate-100 disabled:opacity-50"
              >
                {isCapturing ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Camera className="h-4 w-4 shrink-0" aria-hidden="true" />
                )}
                <span>
                  {liveAssistance
                    ? lang === 'hi'
                      ? 'फ़्रेम कैप्चर करें'
                      : 'Capture Frame'
                    : lang === 'hi'
                    ? 'फोटो खींचें'
                    : 'Capture Photo'}
                </span>
              </button>
            )}

            {capturedFrame && !liveAssistance && (
              <button
                type="button"
                onClick={handleAttachOnly}
                disabled={isSubmitting}
                className="inline-flex min-h-[46px] items-center gap-2 rounded-xl border border-white/30 bg-white/15 px-3.5 py-2 text-xs sm:text-sm font-bold text-white hover:bg-white/25 disabled:opacity-50"
              >
                <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{lang === 'hi' ? 'फोटो जोड़ें' : 'Use Photo'}</span>
              </button>
            )}

            {capturedFrame && (
              <button
                type="button"
                onClick={() => void handleConfirmSend()}
                disabled={isSubmitting}
                className="inline-flex min-h-[46px] items-center gap-2 rounded-xl bg-[#DC2626] px-4 py-2 text-sm font-extrabold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {isSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Send className="h-4 w-4 shrink-0" aria-hidden="true" />
                )}
                <span>
                  {isSubmitting
                    ? lang === 'hi'
                      ? 'विश्लेषण हो रहा है...'
                      : 'Analyzing...'
                    : liveAssistance
                    ? lang === 'hi'
                      ? 'फ़्रेम का विश्लेषण करें'
                      : 'Analyze Captured Frame'
                    : lang === 'hi'
                    ? 'पुष्टि करें व सहायता के लिए भेजें'
                    : 'Confirm & Send for Assistance'}
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
