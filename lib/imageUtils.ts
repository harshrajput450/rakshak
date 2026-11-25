import type {ImageAttachmentPayload, Language} from '../src/types/emergency';

const MAX_RAW_FILE_BYTES = 20 * 1024 * 1024; // 20 MB before resize
const MAX_DIMENSION_PX = 1024;
const TARGET_ENCODED_BYTES = 1.5 * 1024 * 1024;

const ALLOWED_INPUT_MIMES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

export function revokeImagePreviewUrl(url?: string | null): void {
  if (!url || !url.startsWith('blob:')) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // Ignore revoke errors
  }
}

function loadFileAsImage(file: File): Promise<{
  image: HTMLImageElement;
  objectUrl: string;
}> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({image: img, objectUrl});
    img.onerror = () => {
      revokeImagePreviewUrl(objectUrl);
      reject(new Error('decode_failed'));
    };
    img.src = objectUrl;
  });
}

function estimateDecodedBytes(base64: string): number {
  return Math.floor((base64.length * 3) / 4);
}

export function compressCanvasToImagePayload(
  canvas: HTMLCanvasElement,
  lang: Language,
  existingPreviewUrl?: string
): Promise<ImageAttachmentPayload> {
  return new Promise((resolve, reject) => {
    let dataUrl = canvas.toDataURL('image/jpeg', 0.82);
    let base64 = dataUrl.split(',')[1] || '';
    let sizeBytes = estimateDecodedBytes(base64);
    let quality = 0.82;

    if (sizeBytes > TARGET_ENCODED_BYTES) {
      quality = 0.65;
      dataUrl = canvas.toDataURL('image/jpeg', quality);
      base64 = dataUrl.split(',')[1] || '';
      sizeBytes = estimateDecodedBytes(base64);
    }

    if (sizeBytes > 3.5 * 1024 * 1024 || !base64) {
      reject(
        new Error(
          lang === 'hi'
            ? 'फोटो संपीड़न के बाद भी बहुत बड़ी है। कृपया कम रिज़ॉल्यूशन फोटो चुनें।'
            : 'Photo remains too large after compression. Please pick a smaller image.'
        )
      );
      return;
    }

    const buildPayload = (previewUrl: string): ImageAttachmentPayload => ({
      mimeType: 'image/jpeg',
      data: base64,
      previewUrl,
      width: canvas.width,
      height: canvas.height,
      sizeBytes,
    });

    if (existingPreviewUrl) {
      resolve(buildPayload(existingPreviewUrl));
      return;
    }

    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(buildPayload(URL.createObjectURL(blob)));
          } else {
            resolve(buildPayload(dataUrl));
          }
        },
        'image/jpeg',
        quality
      );
      return;
    }

    resolve(buildPayload(dataUrl));
  });
}

export async function validateAndCompressImage(
  file: File,
  lang: Language
): Promise<ImageAttachmentPayload> {
  if (!file) {
    throw new Error(
      lang === 'hi' ? 'कोई फोटो चयनित नहीं है।' : 'No image file selected.'
    );
  }

  const mime = (file.type || '').toLowerCase();
  if (
    !mime.startsWith('image/') ||
    mime === 'image/svg+xml' ||
    (mime && !ALLOWED_INPUT_MIMES.has(mime) && !mime.startsWith('image/'))
  ) {
    throw new Error(
      lang === 'hi'
        ? 'असमर्थित फ़ाइल प्रकार। कृपया JPEG, PNG या WebP फोटो चुनें।'
        : 'Unsupported file type. Please choose a JPEG, PNG, or WebP photo.'
    );
  }

  if (file.size > MAX_RAW_FILE_BYTES) {
    throw new Error(
      lang === 'hi'
        ? 'फोटो बहुत बड़ी है (20 MB से अधिक)। कृपया छोटी फोटो चुनें।'
        : 'Photo is too large (over 20 MB). Please choose a smaller image.'
    );
  }

  let objectUrl = '';
  let img: HTMLImageElement;
  try {
    const loaded = await loadFileAsImage(file);
    img = loaded.image;
    objectUrl = loaded.objectUrl;
  } catch {
    throw new Error(
      lang === 'hi'
        ? 'यह इमेज फ़ाइल पढ़ी नहीं जा सकी। कृपया JPEG या PNG फोटो उपयोग करें।'
        : 'Could not read this image format in your browser. Please use a JPEG or PNG photo.'
    );
  }

  try {
    const srcW = img.naturalWidth || img.width;
    const srcH = img.naturalHeight || img.height;
    if (!srcW || !srcH) {
      throw new Error(
        lang === 'hi' ? 'अमान्य फोटो आकार।' : 'Invalid image dimensions.'
      );
    }

    const scale = Math.min(1, MAX_DIMENSION_PX / Math.max(srcW, srcH));
    const width = Math.max(1, Math.round(srcW * scale));
    const height = Math.max(1, Math.round(srcH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error(
        lang === 'hi'
          ? 'फोटो प्रोसेसिंग समर्थित नहीं है।'
          : 'Image compression canvas is unavailable.'
      );
    }

    // White background ensures transparent PNGs convert cleanly to JPEG
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    return await compressCanvasToImagePayload(canvas, lang, objectUrl);
  } catch (err) {
    revokeImagePreviewUrl(objectUrl);
    throw err;
  }
}
