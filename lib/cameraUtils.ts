import type {ImageAttachmentPayload, Language} from '../src/types/emergency';
import {compressCanvasToImagePayload} from './imageUtils';

export type CameraFacingMode = 'environment' | 'user';

export type CameraErrorCode =
  | 'insecure_context'
  | 'unsupported'
  | 'not_allowed'
  | 'not_found'
  | 'in_use'
  | 'overconstrained'
  | 'capture_failed'
  | 'unknown';

export interface MediaDevicesLike {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  enumerateDevices?: () => Promise<MediaDeviceInfo[]>;
}

export interface CameraStreamTrackLike {
  stop: () => void;
  getSettings?: () => {facingMode?: string};
}

export interface CameraStreamLike {
  getTracks: () => CameraStreamTrackLike[];
  getVideoTracks?: () => CameraStreamTrackLike[];
}

export function isCameraSecureContext(env?: {
  isSecureContext?: boolean;
  hostname?: string;
}): boolean {
  if (env) {
    if (env.isSecureContext) return true;
    return (
      env.hostname === 'localhost' ||
      env.hostname === '127.0.0.1' ||
      env.hostname === '::1'
    );
  }
  if (typeof window === 'undefined') return true;
  if (window.isSecureContext) return true;
  const host = window.location?.hostname || '';
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function isGetUserMediaSupported(
  mediaDevices?: Partial<MediaDevicesLike> | null
): boolean {
  if (mediaDevices !== undefined) {
    return Boolean(mediaDevices && typeof mediaDevices.getUserMedia === 'function');
  }
  return Boolean(
    typeof navigator !== 'undefined' &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function'
  );
}

export function checkCameraEnvironmentSupport(options?: {
  isSecureContext?: boolean;
  hostname?: string;
  mediaDevices?: Partial<MediaDevicesLike> | null;
}): {supported: boolean; errorCode?: CameraErrorCode} {
  if (
    !isCameraSecureContext(
      options
        ? {
            isSecureContext: options.isSecureContext,
            hostname: options.hostname,
          }
        : undefined
    )
  ) {
    return {supported: false, errorCode: 'insecure_context'};
  }
  if (!isGetUserMediaSupported(options?.mediaDevices)) {
    return {supported: false, errorCode: 'unsupported'};
  }
  return {supported: true};
}

export function buildCameraConstraints(
  facingMode: CameraFacingMode,
  exact = false
): MediaStreamConstraints {
  return {
    video: {
      facingMode: exact ? {exact: facingMode} : {ideal: facingMode},
      width: {ideal: 1280},
      height: {ideal: 720},
    },
    audio: false,
  };
}

export function stopMediaStream(
  stream: CameraStreamLike | null | undefined,
  videoEl?: {srcObject: MediaProvider | null} | null
): void {
  if (stream) {
    try {
      const tracks = stream.getTracks();
      for (const track of tracks) {
        try {
          track.stop();
        } catch {
          // Ignore individual track stop error
        }
      }
    } catch {
      // Ignore stream iteration error
    }
  }
  if (videoEl) {
    try {
      videoEl.srcObject = null;
    } catch {
      // Ignore DOM teardown error
    }
  }
}

export function classifyCameraError(err: unknown): CameraErrorCode {
  if (!err || typeof err !== 'object') return 'unknown';
  const name =
    'name' in err && typeof (err as {name?: unknown}).name === 'string'
      ? (err as {name: string}).name
      : '';
  const msg =
    'message' in err && typeof (err as {message?: unknown}).message === 'string'
      ? (err as {message: string}).message.toLowerCase()
      : '';

  if (
    name === 'NotAllowedError' ||
    name === 'PermissionDeniedError' ||
    msg.includes('permission denied')
  ) {
    return 'not_allowed';
  }
  if (name === 'SecurityError') {
    return 'insecure_context';
  }
  if (
    name === 'NotFoundError' ||
    name === 'DevicesNotFoundError' ||
    msg.includes('requested device not found')
  ) {
    return 'not_found';
  }
  if (
    name === 'NotReadableError' ||
    name === 'TrackStartError' ||
    name === 'AbortError' ||
    msg.includes('could not start video source') ||
    msg.includes('in use')
  ) {
    return 'in_use';
  }
  if (
    name === 'OverconstrainedError' ||
    name === 'ConstraintNotSatisfiedError'
  ) {
    return 'overconstrained';
  }
  return 'unknown';
}

export function formatCameraError(
  code: CameraErrorCode,
  lang: Language
): string {
  switch (code) {
    case 'insecure_context':
      return lang === 'hi'
        ? 'लाइव कैमरा केवल सुरक्षित HTTPS या localhost पर चलता है। कृपया सुरक्षित लिंक से खोलें या नीचे से फोटो अपलोड करें।'
        : 'Live camera access requires HTTPS or localhost. Open via a secure URL or use Upload Photo below.';
    case 'unsupported':
      return lang === 'hi'
        ? 'इस ब्राउज़र या डिवाइस में लाइव कैमरा (getUserMedia) समर्थित नहीं है। आप "गैलरी से चुनें" से फोटो भेज सकते हैं।'
        : 'Live camera streaming is not supported in this browser. You can still attach an image via Upload Photo.';
    case 'not_allowed':
      return lang === 'hi'
        ? 'कैमरा अनुमति अस्वीकृत है। ब्राउज़र के लॉक (🔒) आइकन से कैमरा Allow करें और पुनः प्रयास करें।'
        : 'Camera permission was denied. Allow camera access in your browser settings and tap Retry.';
    case 'not_found':
      return lang === 'hi'
        ? 'इस डिवाइस में कोई कैमरा नहीं मिला। आप गैलरी से फोटो चुन सकते हैं।'
        : 'No camera device was found on this device. You can still upload a photo.';
    case 'in_use':
      return lang === 'hi'
        ? 'कैमरा किसी अन्य ऐप में उपयोग हो रहा है या शुरू नहीं हो सका। अन्य कैमरा ऐप बंद करके फिर कोशिश करें।'
        : 'Camera is currently in use by another app or unavailable. Close other camera apps and retry.';
    case 'overconstrained':
      return lang === 'hi'
        ? 'चयनित कैमरा लेंस उपलब्ध नहीं है। दूसरा कैमरा या फोटो अपलोड उपयोग करें।'
        : 'The requested camera lens is unavailable on this device.';
    case 'capture_failed':
      return lang === 'hi'
        ? 'कैमरे से फोटो कैप्चर नहीं हो सकी। कृपया वीडियो तैयार होने पर फिर प्रयास करें।'
        : 'Could not capture a frame from the camera yet. Wait a moment and try again.';
    default:
      return lang === 'hi'
        ? 'लाइव कैमरा शुरू नहीं हो सका। कृपया पुनः प्रयास करें या फोटो अपलोड करें।'
        : 'Could not start live camera. Please retry or upload a photo instead.';
  }
}

export async function openCameraStreamWithFallback(
  facingMode: CameraFacingMode,
  options?: {
    preferExact?: boolean;
    mediaDevices?: MediaDevicesLike | null;
  }
): Promise<{
  stream: MediaStream;
  activeFacingMode: CameraFacingMode;
  hasMultipleVideoInputs: boolean;
}> {
  const md =
    options?.mediaDevices ??
    (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined);
  if (!md || typeof md.getUserMedia !== 'function') {
    throw {name: 'UnsupportedError'};
  }

  let stream: MediaStream | null = null;
  let resolvedFacing = facingMode;

  try {
    if (options?.preferExact) {
      try {
        stream = await md.getUserMedia(buildCameraConstraints(facingMode, true));
      } catch (exactErr) {
        const code = classifyCameraError(exactErr);
        if (code !== 'overconstrained') throw exactErr;
      }
    }

    if (!stream) {
      try {
        stream = await md.getUserMedia(
          buildCameraConstraints(facingMode, false)
        );
      } catch (idealErr) {
        const code = classifyCameraError(idealErr);
        if (code !== 'overconstrained') throw idealErr;
        stream = await md.getUserMedia({video: true, audio: false});
      }
    }
  } catch (err) {
    throw err;
  }

  try {
    const videoTrack = stream.getVideoTracks?.()[0];
    const settingsFacing = videoTrack?.getSettings?.()?.facingMode;
    if (settingsFacing === 'user' || settingsFacing === 'environment') {
      resolvedFacing = settingsFacing;
    }
  } catch {
    // Ignore track settings errors
  }

  let hasMultipleVideoInputs = false;
  if (typeof md.enumerateDevices === 'function') {
    try {
      const devices = await md.enumerateDevices();
      const videoInputs = devices.filter((d) => d.kind === 'videoinput');
      hasMultipleVideoInputs = videoInputs.length > 1;
    } catch {
      // Ignore enumerateDevices error
    }
  }

  return {
    stream,
    activeFacingMode: resolvedFacing,
    hasMultipleVideoInputs,
  };
}

export async function captureVideoFrameToImagePayload(
  videoEl: HTMLVideoElement,
  lang: Language
): Promise<ImageAttachmentPayload> {
  const srcW = videoEl.videoWidth;
  const srcH = videoEl.videoHeight;
  if (!srcW || !srcH || videoEl.readyState < 2) {
    throw new Error(formatCameraError('capture_failed', lang));
  }

  const MAX_DIM = 1024;
  const scale = Math.min(1, MAX_DIM / Math.max(srcW, srcH));
  const width = Math.max(1, Math.round(srcW * scale));
  const height = Math.max(1, Math.round(srcH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error(formatCameraError('capture_failed', lang));
  }

  ctx.drawImage(videoEl, 0, 0, width, height);
  return compressCanvasToImagePayload(canvas, lang);
}
