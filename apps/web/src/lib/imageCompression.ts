import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_SIZE_BYTES,
  type AllowedAttachmentMimeType,
} from '@agent-kanban/shared';

export const MAX_IMAGE_EDGE_PX = 1920;
export const DEFAULT_IMAGE_QUALITY = 0.82;
const REENCODE_BYTES_THRESHOLD = 500 * 1024;

const ALLOWLISTED_MIME_SET = new Set<string>(ALLOWED_ATTACHMENT_MIME_TYPES);

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface DecodedImage {
  width: number;
  height: number;
  source: CanvasImageSource;
  close?: () => void;
}

export interface ImageCompressionDeps {
  maxEdgePx?: number;
  quality?: number;
  maxBytes?: number;
  decodeImage?: (file: File) => Promise<DecodedImage>;
  encodeImage?: (
    decoded: DecodedImage,
    targetWidth: number,
    targetHeight: number,
    outputMime: 'image/jpeg' | 'image/webp',
    quality: number,
  ) => Promise<Blob>;
}

export interface CompressedAttachmentResult {
  file: File;
  contentType: AllowedAttachmentMimeType;
  fileName: string;
  size: number;
  compressed: boolean;
  originalSize: number;
  width?: number;
  height?: number;
}

export function computeScaledDimensions(
  width: number,
  height: number,
  maxEdgePx = MAX_IMAGE_EDGE_PX,
): { width: number; height: number; resized: boolean } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Invalid image dimensions');
  }
  const longest = Math.max(width, height);
  if (longest <= maxEdgePx) {
    return {
      width: Math.round(width),
      height: Math.round(height),
      resized: false,
    };
  }
  const scale = maxEdgePx / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    resized: true,
  };
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${Math.max(0, Math.round(bytes))} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  }
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

function replaceExtension(fileName: string, newExt: string): string {
  const trimmed = fileName.trim() || 'upload';
  const dot = trimmed.lastIndexOf('.');
  if (dot <= 0) {
    return `${trimmed}.${newExt}`;
  }
  return `${trimmed.slice(0, dot)}.${newExt}`;
}

async function defaultDecodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    return {
      width: bitmap.width,
      height: bitmap.height,
      source: bitmap,
      close: () => bitmap.close(),
    };
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Unable to decode image file'));
      el.src = objectUrl;
    });
    return {
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      source: img,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function defaultEncodeImage(
  decoded: DecodedImage,
  targetWidth: number,
  targetHeight: number,
  outputMime: 'image/jpeg' | 'image/webp',
  quality: number,
): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Unable to initialize canvas context for image compression');
    }
    ctx.drawImage(decoded.source, 0, 0, targetWidth, targetHeight);
    return canvas.convertToBlob({ type: outputMime, quality });
  }

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Unable to initialize 2D canvas context for image compression');
  }
  ctx.drawImage(decoded.source, 0, 0, targetWidth, targetHeight);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Failed to encode compressed image'));
          return;
        }
        resolve(blob);
      },
      outputMime,
      quality,
    );
  });
}

function resolveFileMime(file: File): string {
  const rawMime = (file.type || '').trim().toLowerCase();
  const mime = rawMime === 'image/heif' ? 'image/heic' : rawMime;
  if (mime) {
    return mime;
  }
  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith('.pdf')) {
    return 'application/pdf';
  }
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (lowerName.endsWith('.png')) {
    return 'image/png';
  }
  if (lowerName.endsWith('.webp')) {
    return 'image/webp';
  }
  if (lowerName.endsWith('.heic') || lowerName.endsWith('.heif')) {
    return 'image/heic';
  }
  return '';
}

/**
 * Compresses image attachments exceeding `1920px` on the longest edge or re-encodes
 * large/non-allowlisted images to JPEG (`quality: 0.82`). Passes PDFs through untouched
 * and rejects unsupported types or files exceeding 10 MB with a clear message.
 */
export async function compressAttachmentFile(
  file: File,
  deps: ImageCompressionDeps = {},
): Promise<CompressedAttachmentResult> {
  const maxBytes = deps.maxBytes ?? MAX_ATTACHMENT_SIZE_BYTES;
  const maxEdgePx = deps.maxEdgePx ?? MAX_IMAGE_EDGE_PX;
  const quality = deps.quality ?? DEFAULT_IMAGE_QUALITY;
  const mime = resolveFileMime(file);

  if (file.size <= 0) {
    throw new Error('Selected file is empty (0 bytes).');
  }

  if (mime === 'application/pdf') {
    if (file.size > maxBytes) {
      throw new Error(
        `PDF "${file.name}" is ${formatFileSize(file.size)}, which exceeds the 10 MB upload limit.`,
      );
    }
    return {
      file,
      contentType: 'application/pdf',
      fileName: file.name,
      size: file.size,
      compressed: false,
      originalSize: file.size,
    };
  }

  if (!mime.startsWith('image/')) {
    throw new Error(
      `Unsupported file type "${mime || 'unknown'}". Only images (JPEG, PNG, WebP, HEIC) and PDF files are supported.`,
    );
  }

  const decodeFn = deps.decodeImage ?? defaultDecodeImage;
  const encodeFn = deps.encodeImage ?? defaultEncodeImage;
  let decoded: DecodedImage;
  try {
    decoded = await decodeFn(file);
  } catch {
    if (ALLOWLISTED_MIME_SET.has(mime)) {
      if (file.size <= maxBytes) {
        return {
          file,
          contentType: mime as AllowedAttachmentMimeType,
          fileName: file.name,
          size: file.size,
          compressed: false,
          originalSize: file.size,
        };
      }
      throw new Error(
        `Your browser cannot compress "${file.name}" (${formatFileSize(file.size)}), which exceeds the 10 MB upload limit. Convert it to JPEG or upload from Safari/iOS.`,
      );
    }
    throw new Error(
      `Your browser cannot decode "${file.name}" (${mime}). Please convert it to JPEG, PNG, or WebP.`,
    );
  }

  try {
    const scaled = computeScaledDimensions(decoded.width, decoded.height, maxEdgePx);
    const isAllowlistedOriginal = ALLOWLISTED_MIME_SET.has(mime);

    const shouldAttemptEncode =
      scaled.resized || file.size > REENCODE_BYTES_THRESHOLD || !isAllowlistedOriginal;

    if (!shouldAttemptEncode && file.size <= maxBytes) {
      return {
        file,
        contentType: mime as AllowedAttachmentMimeType,
        fileName: file.name,
        size: file.size,
        compressed: false,
        originalSize: file.size,
        width: scaled.width,
        height: scaled.height,
      };
    }

    const outputMime: 'image/jpeg' | 'image/webp' =
      mime === 'image/webp' ? 'image/webp' : 'image/jpeg';
    const compressedBlob = await encodeFn(
      decoded,
      scaled.width,
      scaled.height,
      outputMime,
      quality,
    );

    const useOriginal =
      !scaled.resized &&
      isAllowlistedOriginal &&
      compressedBlob.size >= file.size &&
      file.size <= maxBytes;

    if (useOriginal) {
      return {
        file,
        contentType: mime as AllowedAttachmentMimeType,
        fileName: file.name,
        size: file.size,
        compressed: false,
        originalSize: file.size,
        width: scaled.width,
        height: scaled.height,
      };
    }

    if (compressedBlob.size > maxBytes) {
      throw new Error(
        `Compressed image is still ${formatFileSize(compressedBlob.size)}, exceeding the 10 MB upload limit.`,
      );
    }

    const ext = outputMime === 'image/webp' ? 'webp' : 'jpg';
    const nextFileName = outputMime === mime ? file.name : replaceExtension(file.name, ext);
    const compressedFile = new File([compressedBlob], nextFileName, {
      type: outputMime,
      lastModified: file.lastModified,
    });

    return {
      file: compressedFile,
      contentType: outputMime,
      fileName: compressedFile.name,
      size: compressedFile.size,
      compressed: true,
      originalSize: file.size,
      width: scaled.width,
      height: scaled.height,
    };
  } finally {
    decoded.close?.();
  }
}
