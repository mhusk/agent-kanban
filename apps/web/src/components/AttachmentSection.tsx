import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Attachment } from '@agent-kanban/shared';
import { Download, FileImage, Pencil, X } from 'lucide-react';
import {
  confirmAttachmentUpload,
  deleteCardAttachment,
  fetchAttachmentDownloadUrl,
  fetchCardAttachments,
  isApiError,
  renameCardAttachment,
  requestAttachmentUploadUrl,
  uploadFileToSignedUrl,
} from '../lib/api.js';
import { useAppAuth } from '../lib/auth.js';
import { compressAttachmentFile, formatFileSize } from '../lib/imageCompression.js';

type UploadStage = 'idle' | 'compressing' | 'uploading' | 'done';

interface PreviewTarget {
  attachment: Attachment;
  downloadUrl: string;
}

function InlineRenameForm({
  initialName,
  saving,
  onSave,
  onCancel,
}: {
  initialName: string;
  saving: boolean;
  onSave: (nextName: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [draftName, setDraftName] = useState(initialName);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = draftName.trim();
    if (!trimmed) {
      return;
    }
    if (trimmed === initialName) {
      onCancel();
      return;
    }
    void onSave(trimmed);
  };

  return (
    <form onSubmit={handleSubmit} className="flex w-full flex-col gap-1.5">
      <input
        type="text"
        aria-label="Attachment name"
        autoFocus
        maxLength={255}
        disabled={saving}
        value={draftName}
        onChange={(event) => setDraftName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        className="min-h-10 w-full rounded-lg border border-slate-300 bg-white px-2.5 text-xs text-slate-900"
      />
      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          disabled={saving}
          onClick={onCancel}
          className="min-h-9 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving || draftName.trim().length === 0}
          className="min-h-9 rounded-lg bg-slate-900 px-2.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

function LightboxBody({ target }: { target: PreviewTarget }) {
  const [previewFailed, setPreviewFailed] = useState(false);

  if (target.attachment.contentType === 'application/pdf') {
    return (
      <iframe
        src={target.downloadUrl}
        title={target.attachment.fileName}
        className="h-[75dvh] w-full rounded-lg bg-white"
      />
    );
  }

  if (previewFailed) {
    return (
      <div className="flex min-h-56 flex-col items-center justify-center gap-3 p-6 text-center text-slate-600">
        <FileImage className="h-10 w-10 text-slate-400" aria-hidden="true" />
        <p className="max-w-sm text-sm">
          This image format cannot be rendered inline by this browser. Use Download to open it
          locally.
        </p>
        <a
          href={target.downloadUrl}
          download={target.attachment.fileName}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-slate-900 px-4 text-xs font-semibold text-white hover:bg-slate-800"
        >
          <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
          Download {target.attachment.fileName}
        </a>
      </div>
    );
  }

  return (
    <img
      src={target.downloadUrl}
      alt={target.attachment.fileName}
      onError={() => setPreviewFailed(true)}
      className="max-h-[75dvh] max-w-full rounded-lg object-contain"
    />
  );
}

function AttachmentPreviewModal({
  target,
  onClose,
}: {
  target: PreviewTarget | null;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const isPdf = target?.attachment.contentType === 'application/pdf';

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (target) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [target]);

  // Fallback light-dismiss for browsers without native `closedby="any"` (e.g., Safari)
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || 'closedBy' in HTMLDialogElement.prototype) {
      return;
    }

    const isOutside = (event: PointerEvent) => {
      const rect = dialog.getBoundingClientRect();
      return (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      );
    };

    let pressedOutside = false;
    const onPointerDown = (event: PointerEvent) => {
      pressedOutside = isOutside(event);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (pressedOutside && isOutside(event)) {
        dialog.close();
      }
      pressedOutside = false;
    };

    dialog.addEventListener('pointerdown', onPointerDown);
    dialog.addEventListener('pointerup', onPointerUp);
    return () => {
      dialog.removeEventListener('pointerdown', onPointerDown);
      dialog.removeEventListener('pointerup', onPointerUp);
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      {...({ closedby: 'any' } as Record<string, string>)}
      aria-labelledby={titleId}
      onClose={onClose}
      className={[
        'm-auto rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl',
        isPdf ? 'w-[min(95vw,56rem)]' : 'w-[min(94vw,48rem)]',
      ].join(' ')}
    >
      {target ? (
        <div className="flex flex-col">
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
            <div className="min-w-0 flex-1">
              <h3 id={titleId} className="truncate text-sm font-semibold text-slate-900">
                {target.attachment.fileName}
              </h3>
              <p className="text-xs text-slate-500">{formatFileSize(target.attachment.size)}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <a
                href={target.downloadUrl}
                download={target.attachment.fileName}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-800 hover:bg-slate-100"
              >
                <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
                Download
              </a>
              <button
                type="button"
                aria-label="Close preview"
                onClick={() => dialogRef.current?.close()}
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 hover:bg-slate-100"
              >
                <X className="h-5 w-5 shrink-0" aria-hidden="true" />
              </button>
            </div>
          </div>

          <div
            className={[
              'flex items-center justify-center',
              isPdf ? 'bg-slate-100 p-2 sm:p-3' : 'bg-slate-950/95 p-3 sm:p-4',
            ].join(' ')}
          >
            <LightboxBody key={target.attachment.id} target={target} />
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

function AttachmentImageTile({
  cardId,
  attachment,
  onPreview,
  onRename,
  onDelete,
  renaming,
  deleting,
}: {
  cardId: string;
  attachment: Attachment;
  onPreview: (attachment: Attachment, downloadUrl: string) => void;
  onRename: (attachmentId: string, fileName: string) => Promise<void>;
  onDelete: (id: string) => void;
  renaming: boolean;
  deleting: boolean;
}) {
  const { getAccessToken } = useAppAuth();
  const [previewFailed, setPreviewFailed] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
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
        <button
          type="button"
          aria-label={`Preview ${attachment.fileName}`}
          onClick={() => onPreview(attachment, downloadUrl)}
          className="block aspect-square w-full cursor-zoom-in overflow-hidden bg-slate-100 text-left"
        >
          {previewFailed ? (
            <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 bg-slate-100 p-3 text-center text-slate-600">
              <FileImage className="h-7 w-7 shrink-0 text-slate-400" aria-hidden="true" />
              <span className="text-xs font-medium text-slate-700">Preview unavailable</span>
              <span className="text-[11px] text-sky-700 underline">Open options</span>
            </div>
          ) : (
            <img
              src={downloadUrl}
              alt={attachment.fileName}
              loading="lazy"
              decoding="async"
              onError={() => setPreviewFailed(true)}
              className="h-full w-full object-cover"
            />
          )}
        </button>
      ) : (
        <div className="flex aspect-square w-full items-center justify-center bg-slate-100 text-xs text-slate-500">
          {urlQuery.isError ? 'Preview unavailable' : 'Loading preview…'}
        </div>
      )}

      <div className="flex flex-col gap-1.5 p-2">
        {isEditingName ? (
          <InlineRenameForm
            initialName={attachment.fileName}
            saving={renaming}
            onCancel={() => setIsEditingName(false)}
            onSave={async (nextName) => {
              await onRename(attachment.id, nextName);
              setIsEditingName(false);
            }}
          />
        ) : (
          <>
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-slate-900">{attachment.fileName}</p>
              <p className="text-[11px] text-slate-500">{formatFileSize(attachment.size)}</p>
            </div>
            <div className="flex items-center justify-end gap-1">
              <button
                type="button"
                aria-label={`Rename ${attachment.fileName}`}
                disabled={renaming || deleting}
                onClick={() => setIsEditingName(true)}
                className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-medium text-slate-600 hover:bg-slate-200/70 hover:text-slate-900 disabled:opacity-60"
              >
                <Pencil className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                Rename
              </button>
              <button
                type="button"
                aria-label={`Delete ${attachment.fileName}`}
                disabled={deleting || renaming}
                onClick={() => onDelete(attachment.id)}
                className="min-h-9 rounded-lg px-2 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-60"
              >
                Delete
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function AttachmentPdfRow({
  cardId,
  attachment,
  onPreview,
  onRename,
  onDelete,
  renaming,
  deleting,
}: {
  cardId: string;
  attachment: Attachment;
  onPreview: (attachment: Attachment, downloadUrl: string) => void;
  onRename: (attachmentId: string, fileName: string) => Promise<void>;
  onDelete: (id: string) => void;
  renaming: boolean;
  deleting: boolean;
}) {
  const { getAccessToken } = useAppAuth();
  const [opening, setOpening] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);

  const handlePreview = async () => {
    setOpening(true);
    try {
      const { downloadUrl } = await fetchAttachmentDownloadUrl(
        getAccessToken,
        cardId,
        attachment.id,
      );
      onPreview(attachment, downloadUrl);
    } finally {
      setOpening(false);
    }
  };

  return (
    <li className="rounded-xl border border-slate-200 px-3 py-2">
      {isEditingName ? (
        <InlineRenameForm
          initialName={attachment.fileName}
          saving={renaming}
          onCancel={() => setIsEditingName(false)}
          onSave={async (nextName) => {
            await onRename(attachment.id, nextName);
            setIsEditingName(false);
          }}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-slate-900">{attachment.fileName}</p>
            <p className="text-xs text-slate-500">PDF · {formatFileSize(attachment.size)}</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <button
              type="button"
              aria-label={`Preview ${attachment.fileName}`}
              disabled={opening}
              onClick={() => {
                void handlePreview();
              }}
              className="min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-sky-700 hover:bg-slate-100 disabled:opacity-60"
            >
              {opening ? 'Loading…' : 'Preview PDF'}
            </button>
            <button
              type="button"
              aria-label={`Rename ${attachment.fileName}`}
              disabled={renaming || deleting}
              onClick={() => setIsEditingName(true)}
              className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-60"
            >
              <Pencil className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              Rename
            </button>
            <button
              type="button"
              aria-label={`Delete ${attachment.fileName}`}
              disabled={deleting || renaming}
              onClick={() => onDelete(attachment.id)}
              className="min-h-11 rounded-lg px-3 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-60"
            >
              Delete
            </button>
          </div>
        </div>
      )}
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
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null);

  const attachmentsQuery = useQuery({
    queryKey: ['card-attachments', cardId],
    queryFn: ({ signal }) => fetchCardAttachments(getAccessToken, cardId, signal),
  });

  const renameMutation = useMutation({
    mutationFn: ({ attachmentId, fileName }: { attachmentId: string; fileName: string }) =>
      renameCardAttachment(getAccessToken, cardId, attachmentId, fileName),
    onSuccess: async (_updated, vars) => {
      setErrorMessage(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['card-attachments', cardId] }),
        queryClient.invalidateQueries({ queryKey: ['card-activity', cardId] }),
        queryClient.invalidateQueries({ queryKey: ['card', cardId] }),
        queryClient.invalidateQueries({
          queryKey: ['attachment-download-url', cardId, vars.attachmentId],
        }),
      ]);
    },
    onError: (err) => {
      setErrorMessage(isApiError(err) ? err.message : 'Unable to rename attachment.');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (attachmentId: string) =>
      deleteCardAttachment(getAccessToken, cardId, attachmentId),
    onSuccess: (_result, attachmentId) => {
      setErrorMessage(null);
      setPreviewTarget((prev) => (prev?.attachment.id === attachmentId ? null : prev));
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
      } else if (err instanceof TypeError && /fetch/i.test(err.message)) {
        setErrorMessage(
          'Upload blocked by storage CORS or network error. Verify Cloud Storage bucket CORS configuration and your connection.',
        );
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

  const activePreview = previewTarget
    ? {
        downloadUrl: previewTarget.downloadUrl,
        attachment:
          attachments.find((att) => att.id === previewTarget.attachment.id) ??
          previewTarget.attachment,
      }
    : null;

  const handleRename = async (attachmentId: string, fileName: string) => {
    await renameMutation.mutateAsync({ attachmentId, fileName });
  };

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
              renaming={renameMutation.isPending}
              deleting={deleteMutation.isPending}
              onPreview={(attachment, downloadUrl) => setPreviewTarget({ attachment, downloadUrl })}
              onRename={handleRename}
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
              renaming={renameMutation.isPending}
              deleting={deleteMutation.isPending}
              onPreview={(attachment, downloadUrl) => setPreviewTarget({ attachment, downloadUrl })}
              onRename={handleRename}
              onDelete={(id) => deleteMutation.mutate(id)}
            />
          ))}
        </ul>
      ) : null}

      <AttachmentPreviewModal target={activePreview} onClose={() => setPreviewTarget(null)} />
    </section>
  );
}
