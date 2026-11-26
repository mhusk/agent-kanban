import { MAX_ATTACHMENT_SIZE_BYTES } from '@agent-kanban/shared';
import { describe, expect, it } from 'vitest';
import {
  compressAttachmentFile,
  computeScaledDimensions,
  formatFileSize,
  type DecodedImage,
} from '../lib/imageCompression.js';

describe('computeScaledDimensions', () => {
  it('scales oversized landscape and portrait dimensions proportionally to 1920px max edge', () => {
    expect(computeScaledDimensions(3840, 2160)).toEqual({
      width: 1920,
      height: 1080,
      resized: true,
    });

    expect(computeScaledDimensions(2000, 4000)).toEqual({
      width: 960,
      height: 1920,
      resized: true,
    });

    expect(computeScaledDimensions(1200, 900)).toEqual({
      width: 1200,
      height: 900,
      resized: false,
    });
  });
});

describe('formatFileSize', () => {
  it('formats byte, KB, and MB values legibly', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2.0 KB');
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });
});

describe('compressAttachmentFile', () => {
  it('resizes and compresses oversized photos to <= 1920px JPEG under 10 MB', async () => {
    const hugePhotoBytes = new Uint8Array(MAX_ATTACHMENT_SIZE_BYTES + 2048);
    const inputFile = new File([hugePhotoBytes], 'receipt.png', { type: 'image/png' });

    let capturedWidth = 0;
    let capturedHeight = 0;
    let capturedQuality = 0;
    let closed = false;

    const result = await compressAttachmentFile(inputFile, {
      decodeImage: async (): Promise<DecodedImage> => ({
        width: 4000,
        height: 3000,
        source: {} as CanvasImageSource,
        close: () => {
          closed = true;
        },
      }),
      encodeImage: async (_decoded, width, height, outputMime, quality) => {
        capturedWidth = width;
        capturedHeight = height;
        capturedQuality = quality;
        return new Blob([new Uint8Array(120_000)], { type: outputMime });
      },
    });

    expect(closed).toBe(true);
    expect(capturedWidth).toBe(1920);
    expect(capturedHeight).toBe(1440);
    expect(capturedQuality).toBe(0.82);
    expect(result.compressed).toBe(true);
    expect(result.contentType).toBe('image/jpeg');
    expect(result.fileName).toBe('receipt.jpg');
    expect(result.size).toBe(120_000);
    expect(result.originalSize).toBe(hugePhotoBytes.byteLength);
  });

  it('passes valid PDFs through untouched and enforces 10 MB limit and MIME rules', async () => {
    const pdfBytes = new Uint8Array(2048);
    const pdfFile = new File([pdfBytes], 'invoice.pdf', { type: 'application/pdf' });
    const pdfResult = await compressAttachmentFile(pdfFile);
    expect(pdfResult.compressed).toBe(false);
    expect(pdfResult.file).toBe(pdfFile);
    expect(pdfResult.contentType).toBe('application/pdf');
    expect(pdfResult.size).toBe(2048);

    const hugePdf = new File([new Uint8Array(MAX_ATTACHMENT_SIZE_BYTES + 1)], 'huge.pdf', {
      type: 'application/pdf',
    });
    await expect(compressAttachmentFile(hugePdf)).rejects.toThrow(/10 MB/);

    const htmlFile = new File(['<html></html>'], 'page.html', { type: 'text/html' });
    await expect(compressAttachmentFile(htmlFile)).rejects.toThrow(/Unsupported file type/);

    const emptyFile = new File([], 'empty.png', { type: 'image/png' });
    await expect(compressAttachmentFile(emptyFile)).rejects.toThrow(/empty/i);
  });

  it('converts HEIC to JPEG when native browser decode fails, and falls back to raw HEIC if conversion also fails', async () => {
    const heicFile = new File([new Uint8Array(256_000)], 'photo.heic', { type: 'image/heic' });
    let convertCalled = false;
    const convertedResult = await compressAttachmentFile(heicFile, {
      convertHeic: async (_file, quality) => {
        convertCalled = true;
        expect(quality).toBe(0.82);
        return new Blob([new Uint8Array(90_000)], { type: 'image/jpeg' });
      },
      decodeImage: async (candidate): Promise<DecodedImage> => {
        if (candidate.type === 'image/heic') {
          throw new Error('The source image could not be decoded.');
        }
        return {
          width: 4000,
          height: 3000,
          source: {} as CanvasImageSource,
        };
      },
      encodeImage: async (_decoded, width, height, outputMime) => {
        expect(width).toBe(1920);
        expect(height).toBe(1440);
        return new Blob([new Uint8Array(80_000)], { type: outputMime });
      },
    });
    expect(convertCalled).toBe(true);
    expect(convertedResult.compressed).toBe(true);
    expect(convertedResult.contentType).toBe('image/jpeg');
    expect(convertedResult.fileName).toBe('photo.jpg');
    expect(convertedResult.originalSize).toBe(256_000);

    const heicResult = await compressAttachmentFile(heicFile, {
      decodeImage: async () => {
        throw new Error('The source image could not be decoded.');
      },
      convertHeic: async () => {
        throw new Error('Decoder unavailable');
      },
    });
    expect(heicResult.compressed).toBe(false);
    expect(heicResult.file).toBe(heicFile);
    expect(heicResult.contentType).toBe('image/heic');

    const hugeHeic = new File([new Uint8Array(MAX_ATTACHMENT_SIZE_BYTES + 1)], 'huge.heic', {
      type: 'image/heic',
    });
    await expect(
      compressAttachmentFile(hugeHeic, {
        decodeImage: async () => {
          throw new Error('The source image could not be decoded.');
        },
        convertHeic: async () => {
          throw new Error('Decoder unavailable');
        },
      }),
    ).rejects.toThrow(/10 MB upload limit/);

    const tiffFile = new File([new Uint8Array(1024)], 'scan.tiff', { type: 'image/tiff' });
    await expect(
      compressAttachmentFile(tiffFile, {
        decodeImage: async () => {
          throw new Error('Unsupported');
        },
      }),
    ).rejects.toThrow(/convert it to JPEG, PNG, or WebP/i);
  });
});
