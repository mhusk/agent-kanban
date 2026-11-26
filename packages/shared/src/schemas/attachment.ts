import { z } from 'zod';
import { EntityIdSchema, IsoDateTimeSchema } from './common.js';

export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
] as const;

export const AllowedAttachmentMimeTypeSchema = z.enum(ALLOWED_ATTACHMENT_MIME_TYPES);
export type AllowedAttachmentMimeType = z.infer<typeof AllowedAttachmentMimeTypeSchema>;

export const AttachmentSchema = z.object({
  id: EntityIdSchema,
  cardId: EntityIdSchema,
  storagePath: z.string().trim().min(1).max(1024),
  fileName: z.string().trim().min(1).max(255),
  contentType: AllowedAttachmentMimeTypeSchema,
  size: z.number().int().min(1).max(MAX_ATTACHMENT_SIZE_BYTES),
  uploadedBy: EntityIdSchema,
  createdAt: IsoDateTimeSchema,
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const UploadUrlRequestSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentType: AllowedAttachmentMimeTypeSchema,
  size: z.number().int().min(1).max(MAX_ATTACHMENT_SIZE_BYTES),
});
export type UploadUrlRequest = z.infer<typeof UploadUrlRequestSchema>;

export const UpdateAttachmentInputSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
});
export type UpdateAttachmentInput = z.infer<typeof UpdateAttachmentInputSchema>;
