import { BottomSheet } from "./mobileSharedUi.jsx";

export default function ThreadMessageActionSheet({ open, message, busy, onClose, onCopy, onRetry, onDelete }) {
  if (!open || !message) {
    return null;
  }

  return (
    <BottomSheet
      open={open}
      title="메시지 작업"
      onClose={busy ? () => {} : onClose}
      variant="center"
      panelTestId="thread-message-action-dialog"
      headerActionsLayout="stacked"
      headerActions={
        <>
          {onCopy ? (
            <button
              type="button"
              onClick={onCopy}
              disabled={busy}
              className="shrink-0 rounded-full border border-white/10 bg-white/[0.03] px-3 py-2 text-xs font-medium text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
            >
              텍스트 복사
            </button>
          ) : null}
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              disabled={busy}
              className="shrink-0 rounded-full bg-telegram-500 px-3 py-2 text-xs font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              다시 진행
            </button>
          ) : null}
          {onDelete ? (
            <button
              type="button"
              onClick={onDelete}
              disabled={busy}
              className="shrink-0 rounded-full bg-rose-500/90 px-3 py-2 text-xs font-semibold text-white transition hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              이슈 제거
            </button>
          ) : null}
        </>
      }
    >
      <div className="px-5 py-5">
        <div className="rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3">
          <div className="flex items-center justify-between gap-3 text-[11px] text-slate-400">
            <span>{message.title ?? "메시지"}</span>
            {message.meta ? <span>{message.meta}</span> : null}
          </div>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-200">
            {message.content || "내용이 없습니다."}
          </p>
        </div>
      </div>
    </BottomSheet>
  );
}
