import { useId, useRef, useState, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Attachment } from '@agent-kanban/shared';
import {
  confirmAttachmentUpload,
  deleteCardAttachment,
  fetchAttachmentDownloadUrl,
  fetchCardAttachments,
  isApiError,
  requestAttachmentUploadUrl,
  uploadFileToSignedUrl,
} from '../lib/api.js';
import { useAppAuth } from '../lib/auth.js';
import { compressAttachmentFile, formatFileSize } from '../lib/imageCompression.js';

type UploadStage = 'idle' | 'compressing' | 'uploading' | 'done';

function AttachmentImageTile({
  cardId,
  attachment,
  onDelete,
  deleting,
}: {
  cardId: string;
  attachment: Attachment;
  onDelete: (id: string) => void;
  deleting: boolean;
}) {
  const { getAccessToken } = useAppAuth();
  const urlQuery = useQuery({
    queryKey: ['attachment-download-url', cardId, attachment.id],
    queryFn: ({ signal }) =>
      fetchAttachmentDownloadUrl(getAccessToken, cardId, attachment.id, signal),
    staleTime: 10 * 60_000,
  });

  const downloadUrl = urlQuery.data?.downloadUrl;

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
      {downloadUrl ? (
        <a
          href={downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open full image ${attachment.fileName}`}
          className="block aspect-square w-full overflow-hidden bg-slate-100"
        >
          <img
            src={downloadUrl}
            alt={attachment.fileName}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
          />
        </a>
      ) : (
        <div className="flex aspect-square w-full items-center justify-center bg-slate-100 text-xs text-slate-500">
          {urlQuery.isError ? 'Preview unavailable' : 'Loading preview…'}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 p-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-slate-900">{attachment.fileName}</p>
          <p className="text-[11px] text-slate-500">{formatFileSize(attachment.size)}</p>
        </div>
        <button
          type="button"
          aria-label={`Delete ${attachment.fileName}`}
          disabled={deleting}
          onClick={() => onDelete(attachment.id)}
          className="min-h-10 shrink-0 rounded-lg px-2.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-60"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function AttachmentPdfRow({
  cardId,
  attachment,
  onDelete,
  deleting,
}: {
  cardId: string;
  attachment: Attachment;
  onDelete: (id: string) => void;
  deleting: boolean;
}) {
  const { getAccessToken } = useAppAuth();
  const [opening, setOpening] = useState(false);

  const handleOpen = async () => {
    setOpening(true);
    try {
      const { downloadUrl } = await fetchAttachmentDownloadUrl(
        getAccessToken,
        cardId,
        attachment.id,
      );
      window.open(downloadUrl, '_blank', 'noopener,noreferrer');
    } finally {
      setOpening(false);
    }
  };

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-900">{attachment.fileName}</p>
        <p className="text-xs text-slate-500">PDF · {formatFileSize(attachment.size)}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          disabled={opening}
          onClick={() => {
            void handleOpen();
          }}
          className="min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-sky-700 hover:bg-slate-100 disabled:opacity-60"
        >
          {opening ? 'Opening…' : 'Open PDF'}
        </button>
        <button
          type="button"
          aria-label={`Delete ${attachment.fileName}`}
          disabled={deleting}
          onClick={() => onDelete(attachment.id)}
          className="min-h-11 rounded-lg px-3 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-60"
        >
          Delete
        </button>
      </div>
    </li>
  );
}

export function AttachmentSection({ cardId }: { cardId: string }) {
  const { getAccessToken } = useAppAuth();
  const queryClient = useQueryClient();
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [uploadStage, setUploadStage] = useState<UploadStage>('idle');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const attachmentsQuery = useQuery({
    queryKey: ['card-attachments', cardId],
    queryFn: ({ signal }) => fetchCardAttachments(getAccessToken, cardId, signal),
  });

  const deleteMutation = useMutation({
    mutationFn: (attachmentId: string) =>
      deleteCardAttachment(getAccessToken, cardId, attachmentId),
    onSuccess: () => {
      setErrorMessage(null);
      void queryClient.invalidateQueries({ queryKey: ['card-attachments', cardId] });
      void queryClient.invalidateQueries({ queryKey: ['card-activity', cardId] });
      void queryClient.invalidateQueries({ queryKey: ['card', cardId] });
    },
    onError: (err) => {
      setErrorMessage(isApiError(err) ? err.message : 'Unable to delete attachment.');
    },
  });

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0];
    event.target.value = '';
    if (!selected) {
      return;
    }

    setErrorMessage(null);
    setStatusMessage('Compressing...');
    setUploadStage('compressing');

    try {
      const prepared = await compressAttachmentFile(selected);
      setStatusMessage('Uploading...');
      setUploadStage('uploading');

      const { attachmentId, uploadUrl } = await requestAttachmentUploadUrl(getAccessToken, cardId, {
        fileName: prepared.fileName,
        contentType: prepared.contentType,
        size: prepared.size,
      });

      await uploadFileToSignedUrl(uploadUrl, prepared.file, prepared.contentType);
      await confirmAttachmentUpload(getAccessToken, cardId, attachmentId);

      setUploadStage('done');
      setStatusMessage(
        prepared.compressed
          ? `Done (${formatFileSize(prepared.originalSize)} -> ${formatFileSize(prepared.size)})`
          : 'Done',
      );
      await queryClient.invalidateQueries({ queryKey: ['card-attachments', cardId] });
      await queryClient.invalidateQueries({ queryKey: ['card-activity', cardId] });
      await queryClient.invalidateQueries({ queryKey: ['card', cardId] });
    } catch (err) {
      setUploadStage('idle');
      setStatusMessage(null);
      if (isApiError(err)) {
        setErrorMessage(err.message);
      } else if (err instanceof Error) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to upload attachment.');
      }
    }
  };

  const attachments = attachmentsQuery.data ?? [];
  const imageAttachments = attachments.filter((att) => att.contentType.startsWith('image/'));
  const pdfAttachments = attachments.filter((att) => att.contentType === 'application/pdf');
  const isBusy = uploadStage === 'compressing' || uploadStage === 'uploading';

  return (
    <section
      aria-labelledby="attachments-heading"
      className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id="attachments-heading"
          className="text-sm font-semibold tracking-wide text-slate-600 uppercase"
        >
          Attachments ({attachments.length})
        </h2>

        <div>
          <input
            ref={fileInputRef}
            id={fileInputId}
            type="file"
            accept="image/*,application/pdf"
            disabled={isBusy}
            onChange={(event) => {
              void handleFileChange(event);
            }}
            className="visually-hidden"
          />
          <button
            type="button"
            disabled={isBusy}
            onClick={() => fileInputRef.current?.click()}
            className="min-h-11 rounded-xl border border-slate-300 bg-white px-3.5 text-xs font-semibold text-slate-800 hover:bg-slate-100 disabled:opacity-60"
          >
            {isBusy ? statusMessage : 'Add photo or PDF'}
          </button>
        </div>
      </div>

      {statusMessage && !isBusy ? (
        <p role="status" className="rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
          {statusMessage}
        </p>
      ) : null}

      {errorMessage ? (
        <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800">
          {errorMessage}
        </p>
      ) : null}

      {attachmentsQuery.isPending ? (
        <p className="text-xs text-slate-500">Loading attachments…</p>
      ) : attachments.length === 0 ? (
        <p className="text-xs text-slate-500">
          No attachments yet. Photos are automatically resized to save space; PDFs up to 10 MB are
          supported.
        </p>
      ) : null}

      {imageAttachments.length > 0 ? (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {imageAttachments.map((att) => (
            <AttachmentImageTile
              key={att.id}
              cardId={cardId}
              attachment={att}
              deleting={deleteMutation.isPending}
              onDelete={(id) => deleteMutation.mutate(id)}
            />
          ))}
        </div>
      ) : null}

      {pdfAttachments.length > 0 ? (
        <ul className="space-y-2">
          {pdfAttachments.map((att) => (
            <AttachmentPdfRow
              key={att.id}
              cardId={cardId}
              attachment={att}
              deleting={deleteMutation.isPending}
              onDelete={(id) => deleteMutation.mutate(id)}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
