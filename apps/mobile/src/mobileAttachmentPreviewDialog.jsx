import { createPortal } from "react-dom";

export default function AttachmentPreviewDialog({ attachment, sizeLabel = "", onClose }) {
  if (!attachment || typeof document === "undefined") {
    return null;
  }

  const imageSource = attachment.preview_url || attachment.download_url || null;
  const isImage = attachment.kind === "image" && imageSource;
  const hasTextPreview = !isImage && attachment.text_content;

  return createPortal(
    <div className="fixed inset-0 z-[90] bg-slate-950/92 backdrop-blur-sm">
      <button
        type="button"
        aria-label="첨부 미리보기 닫기"
        className="absolute right-4 top-4 z-[1] flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-black/30 text-white"
        onClick={onClose}
      >
        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
        </svg>
      </button>

      <div
        role="button"
        tabIndex={0}
        className="flex h-full w-full items-center justify-center px-4 pb-8 pt-16"
        onClick={onClose}
        onKeyDown={(event) => {
          if (event.key === "Escape" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <div
          className="max-h-full w-full max-w-4xl overflow-hidden rounded-[1.75rem] border border-white/10 bg-slate-950 shadow-[0_24px_72px_rgba(2,6,23,0.55)]"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="border-b border-white/10 px-5 py-4">
            <p className="truncate text-sm font-semibold text-white">{attachment.name}</p>
            <p className="mt-1 text-[11px] text-slate-400">
              {sizeLabel}
              {attachment.mime_type ? ` · ${attachment.mime_type}` : ""}
            </p>
          </div>

          {isImage ? (
            <div className="flex max-h-[calc(100vh-10rem)] items-center justify-center bg-black px-3 py-3">
              <img
                src={imageSource}
                alt={attachment.name}
                className="max-h-[calc(100vh-12rem)] w-auto max-w-full rounded-2xl object-contain"
              />
            </div>
          ) : hasTextPreview ? (
            <div className="max-h-[calc(100vh-12rem)] overflow-auto px-5 py-4">
              <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-6 text-slate-100">
                {attachment.text_content}
              </pre>
              {attachment.text_truncated ? (
                <p className="mt-3 text-xs text-amber-200">본문이 일부만 포함되어 있습니다.</p>
              ) : null}
            </div>
          ) : (
            <div className="px-5 py-6 text-sm text-slate-200">
              미리보기를 표시할 수 없는 첨부입니다.
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
