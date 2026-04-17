import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AttachmentPreviewDialog from "./mobileAttachmentPreviewDialog.jsx";
import MobileInlineIssueComposer from "./mobileInlineIssueComposer.jsx";
import { MessageAttachmentPreview } from "./mobileMessageAttachmentUi.jsx";
import { useMobileFeedback } from "./mobileSharedUi.jsx";

const TODO_SCOPE_ID = "todo";
const InlineIssueComposer = MobileInlineIssueComposer;

export default function MobileTodoChatDetail({
  chat,
  bridgeId = "",
  messages,
  loading,
  error,
  submitBusy,
  composerDraftKey = "",
  composerDraft = "",
  onPersistComposerDraft = null,
  onBack,
  onRefresh,
  onRename,
  onDelete,
  onSelectMessage,
  onSubmitMessage,
  showBackButton = true,
  standalone = true,
  inlineIssueComposerHelpers,
  uiComponents,
  utils,
  onRegisterBackHandler = null
}) {
  const { MessageBubbleComponent, RichMessageContentComponent } = uiComponents;
  const {
    formatMessageAttachmentSize,
    formatRelativeTime,
    normalizeMessageAttachment,
    normalizeMessageAttachments,
    resolveMessageAttachmentBadge,
    useTouchScrollBoundaryLock
  } = utils;
  const fakeProject = useMemo(() => ({ id: TODO_SCOPE_ID, name: "ToDo" }), []);
  const safeMessages = Array.isArray(messages) ? messages : [];
  const scrollRef = useRef(null);
  const [previewAttachment, setPreviewAttachment] = useState(null);
  const { alert: showAlert } = useMobileFeedback();
  useTouchScrollBoundaryLock(scrollRef);
  const rootStyle = standalone ? { height: "calc(var(--app-stable-viewport-height) - var(--app-safe-area-top))" } : undefined;
  const rootClassName = standalone
    ? "telegram-screen flex min-h-0 flex-col overflow-hidden"
    : "telegram-screen flex h-full min-h-0 flex-col overflow-hidden";
  const contentWidthClassName = standalone ? "max-w-3xl" : "max-w-none";
  const handleOpenAttachment = useCallback((attachment) => {
    const normalizedAttachment = normalizeMessageAttachment(attachment);

    if (!normalizedAttachment) {
      return;
    }

    if ((normalizedAttachment.kind === "image" && normalizedAttachment.preview_url) || normalizedAttachment.text_content) {
      setPreviewAttachment(normalizedAttachment);
      return;
    }

    if (normalizedAttachment.download_url && typeof window !== "undefined") {
      const opened = window.open(normalizedAttachment.download_url, "_blank", "noopener,noreferrer");

      if (!opened) {
        window.location.href = normalizedAttachment.download_url;
      }

      return;
    }

    showAlert("이 첨부는 현재 열 수 없습니다.", {
      tone: "error",
      title: "첨부 미리보기"
    });
  }, [showAlert]);

  useEffect(() => {
    if (typeof onRegisterBackHandler !== "function") {
      return undefined;
    }

    onRegisterBackHandler(() => {
      if (previewAttachment) {
        setPreviewAttachment(null);
        return true;
      }

      if (showBackButton && typeof onBack === "function") {
        onBack();
        return true;
      }

      return false;
    });

    return () => {
      onRegisterBackHandler(null);
    };
  }, [onBack, onRegisterBackHandler, previewAttachment, showBackButton]);

  return (
    <div className={rootClassName} style={rootStyle}>
      <header className="sticky top-0 z-20 border-b border-white/10 bg-slate-950 px-4 py-3">
        <div className={`flex items-center ${showBackButton ? "gap-3" : "gap-0"}`}>
          {showBackButton ? (
            <button
              type="button"
              onClick={onBack}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-white/5 text-white transition hover:bg-white/10"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
              </svg>
            </button>
          ) : null}

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-white">{chat?.title ?? "새 ToDo 채팅"}</p>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-400">
              <span>ToDo</span>
              <span className="h-1.5 w-1.5 rounded-full bg-slate-500" />
              <span>Preparation</span>
            </div>
          </div>

          <button
            type="button"
            onClick={onRename}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white transition hover:bg-white/10"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M11 5H6a2 2 0 00-2 2v11a1 1 0 001 1h11a2 2 0 002-2v-5" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
              <path d="M18.5 2.5a2.12 2.12 0 113 3L12 15l-4 1 1-4 9.5-9.5z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white transition hover:bg-rose-500/20"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M6 7h12M9 7V4h6v3m-7 4v6m4-6v6m4-6v6M5 7l1 12a2 2 0 002 2h8a2 2 0 002-2l1-12" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onRefresh}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white transition hover:bg-white/10"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                d="M4 4v5h.582m15.418 11v-5h-.581M5.007 9a7 7 0 0111.995-3m2.998 9a7 7 0 01-11.995 3"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
              />
            </svg>
          </button>
        </div>
      </header>

      <div
        ref={scrollRef}
        className="telegram-grid touch-scroll-boundary-lock min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-5"
      >
        <div className={`mx-auto flex w-full ${contentWidthClassName} flex-col gap-4 pb-4`}>
          {error ? (
            <div className="rounded-2xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
              {error}
            </div>
          ) : null}

          {safeMessages.map((message) => (
            <button
              key={message.id}
              type="button"
              onClick={() => onSelectMessage(message)}
              className="text-left"
            >
              <MessageBubbleComponent align="right" tone="brand" title="메모" meta={formatRelativeTime(message.updated_at)}>
                <RichMessageContentComponent content={message.content} tone="brand" />
                <MessageAttachmentPreview
                  attachments={message.attachments}
                  bubbleTone="brand"
                  onOpenAttachment={handleOpenAttachment}
                  normalizeAttachments={normalizeMessageAttachments}
                  resolveBadge={resolveMessageAttachmentBadge}
                  formatSize={formatMessageAttachmentSize}
                />
              </MessageBubbleComponent>
            </button>
          ))}

          {loading ? (
            <div className="flex justify-center py-4">
              <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-white" />
            </div>
          ) : null}

          {!loading && safeMessages.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/15 px-4 py-4 text-center text-sm text-slate-300">
              아직 저장된 메모가 없습니다. 아래 입력창에서 아이디어를 남겨 주세요.
            </div>
          ) : null}
        </div>
      </div>

      <div className="telegram-safe-bottom-panel shrink-0 border-t border-white/10 bg-slate-950/92 px-4 pt-2 backdrop-blur">
        <div className={`mx-auto w-full ${contentWidthClassName}`}>
          <InlineIssueComposer
            helpers={inlineIssueComposerHelpers}
            busy={submitBusy}
            bridgeId={bridgeId}
            selectedProject={fakeProject}
            onSubmit={onSubmitMessage}
            label="메모"
            draftKey={composerDraftKey}
            draftValue={composerDraft}
            onDraftPersist={onPersistComposerDraft}
          />
        </div>
      </div>

      <AttachmentPreviewDialog
        attachment={previewAttachment}
        sizeLabel={previewAttachment ? formatMessageAttachmentSize(previewAttachment.size_bytes) : ""}
        onClose={() => setPreviewAttachment(null)}
      />
    </div>
  );
}
