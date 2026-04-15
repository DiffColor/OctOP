function MessageAttachmentBadge({ attachment, compact = false, resolveBadge }) {
  const badge = resolveBadge(attachment?.name, attachment?.mime_type);

  return (
    <span
      className={`inline-flex items-center justify-center border font-semibold tracking-[0.18em] ${
        compact ? "h-7 min-w-[2.6rem] rounded-lg px-2 text-[10px]" : "h-8 min-w-[3rem] rounded-xl px-2 text-[11px]"
      } ${badge.className}`}
    >
      {badge.label}
    </span>
  );
}

function MessageAttachmentPreview({
  attachments,
  bubbleTone = "light",
  onOpenAttachment,
  normalizeAttachments,
  resolveBadge,
  formatSize
}) {
  const normalizedAttachments = normalizeAttachments(attachments);

  if (normalizedAttachments.length === 0) {
    return null;
  }

  const imageAttachments = normalizedAttachments.filter((attachment) => attachment.kind === "image" && attachment.preview_url);
  const fileAttachments = normalizedAttachments.filter((attachment) => attachment.kind !== "image" || !attachment.preview_url);
  const fileCardClassName =
    bubbleTone === "brand"
      ? "border-white/15 bg-slate-950/15 text-white"
      : "border-slate-900/10 bg-slate-950/5 text-slate-900";

  return (
    <div className="mt-3 space-y-2.5">
      {imageAttachments.length > 0 ? (
        <div className={`grid gap-2 ${imageAttachments.length === 1 ? "grid-cols-1" : "grid-cols-2"}`}>
          {imageAttachments.slice(0, 4).map((attachment, index) => {
            const remainingCount = imageAttachments.length - 4;
            const showOverflow = index === 3 && remainingCount > 0;

            return (
              <button
                key={attachment.id}
                type="button"
                data-message-attachment-interactive="true"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenAttachment?.(attachment);
                }}
                className="group relative overflow-hidden rounded-2xl border border-black/10 bg-black/10 text-left"
              >
                <div className="aspect-[4/3] w-full overflow-hidden bg-black/20">
                  <img
                    src={attachment.preview_url}
                    alt={attachment.name}
                    className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]"
                    loading="lazy"
                  />
                </div>
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent px-3 pb-2 pt-6">
                  <p className="truncate text-[11px] font-medium text-white">{attachment.name}</p>
                </div>
                {showOverflow ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-slate-950/55 text-lg font-semibold text-white">
                    +{remainingCount}
                  </div>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      {fileAttachments.length > 0 ? (
        <div className="space-y-2">
          {fileAttachments.map((attachment) => (
            <button
              key={attachment.id}
              type="button"
              data-message-attachment-interactive="true"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpenAttachment?.(attachment);
              }}
              className={`flex w-full min-w-0 items-center gap-3 rounded-2xl border px-3 py-3 text-left ${fileCardClassName}`}
            >
              <div className="shrink-0">
                <MessageAttachmentBadge attachment={attachment} compact resolveBadge={resolveBadge} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{attachment.name}</p>
                <div className="mt-1 flex items-center gap-1.5 text-[11px] opacity-70">
                  <span>{formatSize(attachment.size_bytes)}</span>
                  {attachment.text_content ? (
                    <>
                      <span>·</span>
                      <span>{attachment.text_truncated ? "본문 일부 포함" : "본문 포함"}</span>
                    </>
                  ) : null}
                </div>
              </div>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export { MessageAttachmentBadge, MessageAttachmentPreview };
