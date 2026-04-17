import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { MessageAttachmentBadge } from "./mobileMessageAttachmentUi.jsx";
import { createThreadTitleFromPrompt } from "./mobileOverlayUtils.js";
import { useMobileFeedback } from "./mobileSharedUi.jsx";

export default function InlineIssueComposer({
  busy,
  bridgeId = "",
  selectedProject,
  onSubmit,
  onOpenVoiceMode = null,
  voiceSessionEnabled = true,
  label,
  disabled = false,
  draftKey = "",
  draftValue = undefined,
  onDraftPersist = null,
  onStop = null,
  stopBusy = false,
  stopLabel = "중단",
  onInputFocus = null,
  onInputBlur = null,
  onPromptChange = null,
  onManualPromptChange = null,
  speechInputEnabled = false,
  speechInputSupported = true,
  speechInputListening = false,
  speechInputBusy = false,
  speechInputHint = "",
  onToggleSpeechInput = null,
  externalPromptInsertText = "",
  externalPromptInsertToken = "",
  externalPromptInsertMode = "append",
  autoFocusOnExternalPromptInsert = true,
  helpers
}) {
  const {
    CHAT_COMPOSER_MAX_HEIGHT_PX,
    MAX_MESSAGE_ATTACHMENTS,
    MESSAGE_ATTACHMENT_ACCEPT,
    appendMessageAttachments,
    cleanupMessageAttachmentUpload,
    cleanupMessageAttachmentUploads,
    formatMessageAttachmentSize,
    getViewportOrientation,
    hasCoarsePointerDevice,
    normalizeComposerDraftValue,
    normalizeMessageAttachments,
    resolveMessageAttachmentBadge
  } = helpers;
  const SOFTWARE_KEYBOARD_HEIGHT_THRESHOLD_PX = 160;
  const SOFTWARE_KEYBOARD_HEIGHT_THRESHOLD_RATIO = 0.14;
  const SEND_BUTTON_LONG_PRESS_MS = 380;
  const SEND_BUTTON_LONG_PRESS_MOVE_TOLERANCE_PX = 10;
  const normalizedDraftKey = String(draftKey ?? "").trim();
  const normalizedDraftValue = normalizeComposerDraftValue(draftValue);
  const [internalPrompt, setInternalPrompt] = useState(() => normalizedDraftValue);
  const [attachments, setAttachments] = useState([]);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const submitInFlightRef = useRef(false);
  const isPromptComposingRef = useRef(false);
  const promptFocusPointerTypeRef = useRef("");
  const sendButtonLongPressTimerRef = useRef(null);
  const sendButtonLongPressTriggeredRef = useRef(false);
  const sendButtonLongPressPointerRef = useRef(null);
  const viewportBaselineHeightsRef = useRef({
    portrait: 0,
    landscape: 0
  });
  const { alert: showAlert } = useMobileFeedback();
  const prompt = internalPrompt;
  const promptRef = useRef(prompt);
  const attachmentsRef = useRef([]);
  const lastHydratedDraftRef = useRef({
    key: normalizedDraftKey,
    value: normalizedDraftValue
  });
  const lastExternalPromptInsertTokenRef = useRef("");
  const syncPromptHeight = useCallback((element) => {
    const textarea = element ?? textareaRef.current;

    if (!textarea) {
      return;
    }

    const viewportHeight =
      typeof window !== "undefined"
        ? window.visualViewport?.height ?? window.innerHeight ?? 0
        : 0;
    const computedLimit = viewportHeight > 0 ? viewportHeight * 0.45 : CHAT_COMPOSER_MAX_HEIGHT_PX;
    const maxHeight =
      computedLimit > 0 ? Math.min(CHAT_COMPOSER_MAX_HEIGHT_PX, computedLimit) : CHAT_COMPOSER_MAX_HEIGHT_PX;

    textarea.style.height = "auto";
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";

    if (textarea.scrollHeight <= maxHeight) {
      textarea.scrollTop = textarea.scrollHeight;
    }
  }, []);

  useEffect(() => {
    promptRef.current = prompt;
    onPromptChange?.(prompt);
  }, [onPromptChange, prompt]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    const lastHydratedDraft = lastHydratedDraftRef.current;
    const keyChanged = lastHydratedDraft.key !== normalizedDraftKey;
    const canHydrateSameKey =
      !keyChanged &&
      promptRef.current === lastHydratedDraft.value &&
      normalizedDraftValue !== lastHydratedDraft.value;

    if (!keyChanged && !canHydrateSameKey) {
      return;
    }

    if (keyChanged) {
      attachmentsRef.current = [];
      setAttachments([]);
    }

    setInternalPrompt(normalizedDraftValue);
    promptRef.current = normalizedDraftValue;
    lastHydratedDraftRef.current = {
      key: normalizedDraftKey,
      value: normalizedDraftValue
    };
  }, [normalizedDraftKey, normalizedDraftValue]);

  useEffect(() => {
    const normalizedInsertToken = String(externalPromptInsertToken ?? "").trim();
    const normalizedInsertText = String(externalPromptInsertText ?? "").trim();
    const shouldReplacePrompt = String(externalPromptInsertMode ?? "").trim() === "replace";

    if (!normalizedInsertToken || normalizedInsertToken === lastExternalPromptInsertTokenRef.current || !normalizedInsertText) {
      return;
    }

    lastExternalPromptInsertTokenRef.current = normalizedInsertToken;

    setInternalPrompt((currentPrompt) => {
      const normalizedCurrentPrompt = String(currentPrompt ?? "");
      const nextPrompt = shouldReplacePrompt
        ? normalizedInsertText
        : normalizedCurrentPrompt.trim()
          ? `${normalizedCurrentPrompt.trimEnd()} ${normalizedInsertText}`.trim()
          : normalizedInsertText;

      promptRef.current = nextPrompt;
      lastHydratedDraftRef.current = {
        key: normalizedDraftKey,
        value: nextPrompt
      };

      if (typeof onDraftPersist === "function" && normalizedDraftKey) {
        onDraftPersist(normalizedDraftKey, nextPrompt);
      }

      return nextPrompt;
    });

    window.requestAnimationFrame(() => {
      syncPromptHeight();

      if (autoFocusOnExternalPromptInsert) {
        textareaRef.current?.focus?.({ preventScroll: true });
      }
    });
  }, [
    autoFocusOnExternalPromptInsert,
    externalPromptInsertMode,
    externalPromptInsertText,
    externalPromptInsertToken,
    normalizedDraftKey,
    onDraftPersist,
    syncPromptHeight
  ]);

  useEffect(
    () => () => {
      if (sendButtonLongPressTimerRef.current) {
        window.clearTimeout(sendButtonLongPressTimerRef.current);
        sendButtonLongPressTimerRef.current = null;
      }

      if (typeof onDraftPersist === "function" && normalizedDraftKey) {
        onDraftPersist(normalizedDraftKey, promptRef.current);
      }

      void cleanupMessageAttachmentUploads(attachmentsRef.current);
    },
    [normalizedDraftKey, onDraftPersist]
  );

  const readCurrentViewportMetrics = useCallback(() => {
    if (typeof window === "undefined") {
      return {
        width: 0,
        height: 0,
        orientation: "portrait"
      };
    }

    const viewport = window.visualViewport;
    const width = Math.max(0, Math.round(viewport?.width || window.innerWidth || 0));
    const height = Math.max(0, Math.round(viewport?.height || window.innerHeight || 0));

    return {
      width,
      height,
      orientation: getViewportOrientation(width, height)
    };
  }, []);

  const syncViewportBaseline = useCallback(() => {
    const { height, orientation } = readCurrentViewportMetrics();

    if (height <= 0) {
      return;
    }

    const currentBaseline = Number(viewportBaselineHeightsRef.current[orientation] ?? 0);

    if (height > currentBaseline) {
      viewportBaselineHeightsRef.current = {
        ...viewportBaselineHeightsRef.current,
        [orientation]: height
      };
    }
  }, [readCurrentViewportMetrics]);

  const isViewportReducedForSoftwareKeyboard = useCallback(() => {
    const { height, orientation } = readCurrentViewportMetrics();
    const baselineHeight = Number(viewportBaselineHeightsRef.current[orientation] ?? 0);

    if (height <= 0 || baselineHeight <= 0 || height >= baselineHeight) {
      return false;
    }

    const deltaHeight = baselineHeight - height;
    const threshold = Math.max(
      SOFTWARE_KEYBOARD_HEIGHT_THRESHOLD_PX,
      Math.round(baselineHeight * SOFTWARE_KEYBOARD_HEIGHT_THRESHOLD_RATIO)
    );

    return deltaHeight >= threshold;
  }, [readCurrentViewportMetrics]);

  const shouldPreserveEnterForSoftKeyboard = useCallback(() => {
    const pointerType = promptFocusPointerTypeRef.current;

    if (pointerType !== "touch" && pointerType !== "pen") {
      return false;
    }

    if (!hasCoarsePointerDevice()) {
      return false;
    }

    return isViewportReducedForSoftwareKeyboard();
  }, [isViewportReducedForSoftwareKeyboard]);

  useLayoutEffect(() => {
    syncPromptHeight();
  }, [prompt, selectedProject, syncPromptHeight]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const viewport = window.visualViewport;
    const handleViewportChange = () => {
      syncViewportBaseline();
    };

    syncViewportBaseline();

    if (!viewport) {
      window.addEventListener("resize", handleViewportChange);
      window.addEventListener("orientationchange", handleViewportChange);

      return () => {
        window.removeEventListener("resize", handleViewportChange);
        window.removeEventListener("orientationchange", handleViewportChange);
      };
    }

    viewport.addEventListener("resize", handleViewportChange);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("orientationchange", handleViewportChange);

    return () => {
      viewport.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("orientationchange", handleViewportChange);
    };
  }, [syncViewportBaseline]);

  const handlePromptChange = useCallback(
    (event) => {
      const nextValue = String(event.target.value ?? "");
      setInternalPrompt(nextValue);
      onManualPromptChange?.(nextValue);
      syncPromptHeight(event.target);
    },
    [onManualPromptChange, syncPromptHeight]
  );

  const focusPromptTextareaFromSurface = useCallback(
    (event) => {
      if (busy || disabled || !selectedProject) {
        return;
      }

      const pointerType = typeof event?.pointerType === "string" ? event.pointerType.toLowerCase() : "";

      if (pointerType === "touch" || pointerType === "pen" || pointerType === "mouse") {
        promptFocusPointerTypeRef.current = pointerType;
      }

      const textarea = textareaRef.current;

      if (!textarea) {
        return;
      }

      const eventTarget = event?.target;

      if (eventTarget instanceof Node && textarea.contains(eventTarget)) {
        return;
      }

      textarea.focus({ preventScroll: true });

      try {
        const caretPosition = textarea.value.length;
        textarea.setSelectionRange(caretPosition, caretPosition);
      } catch {
        // ignore browsers that restrict selection APIs during focus transitions
      }
    },
    [busy, disabled, selectedProject]
  );

  const handlePromptFocus = useCallback(
    (event) => {
      onInputFocus?.(event);
    },
    [onInputFocus]
  );

  const handlePromptBlur = useCallback(
    (event) => {
      promptFocusPointerTypeRef.current = "";
      onInputBlur?.(event);
    },
    [onInputBlur]
  );

  const handleRemoveAttachment = useCallback((attachmentId) => {
    setAttachments((current) => {
      const target = current.find((attachment) => attachment.id === attachmentId) ?? null;
      const next = current.filter((attachment) => attachment.id !== attachmentId);

      if (target) {
        void cleanupMessageAttachmentUpload(target);
      }

      attachmentsRef.current = next;
      return next;
    });
  }, []);

  const handleAttachmentFiles = useCallback(
    async (files) => {
      if (!selectedProject || busy || disabled || attachmentBusy) {
        return;
      }

      setAttachmentBusy(true);

      try {
        const result = await appendMessageAttachments(attachmentsRef.current, files, bridgeId);
        attachmentsRef.current = result.attachments;
        setAttachments(result.attachments);

        if (result.rejectedCount > 0) {
          showAlert(`지원하지 않거나 너무 큰 파일 ${result.rejectedCount}개는 제외되었습니다.`, {
            title: "첨부 파일",
            tone: "error"
          });
        }
      } finally {
        setAttachmentBusy(false);
      }
    },
    [attachmentBusy, bridgeId, busy, disabled, selectedProject, showAlert]
  );

  const handleAttachmentChange = useCallback(
    async (event) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";

      if (files.length === 0) {
        return;
      }

      await handleAttachmentFiles(files);
    },
    [handleAttachmentFiles]
  );

  const handlePromptSubmit = useCallback(async () => {
    const normalizedPrompt = prompt.trim();
    const normalizedTitle = createThreadTitleFromPrompt(normalizedPrompt);
    const normalizedAttachments = normalizeMessageAttachments(attachmentsRef.current);

    if (
      (!normalizedPrompt && normalizedAttachments.length === 0) ||
      !selectedProject?.id ||
      disabled ||
      submitInFlightRef.current ||
      attachmentBusy
    ) {
      return;
    }

    submitInFlightRef.current = true;

    setInternalPrompt("");
    attachmentsRef.current = [];
    setAttachments([]);
    promptRef.current = "";
    lastHydratedDraftRef.current = {
      key: normalizedDraftKey,
      value: ""
    };

    if (typeof onDraftPersist === "function" && normalizedDraftKey) {
      onDraftPersist(normalizedDraftKey, "");
    }

    const restorePrompt = () => {
      setInternalPrompt(normalizedPrompt);
      attachmentsRef.current = normalizedAttachments;
      setAttachments(normalizedAttachments);
      promptRef.current = normalizedPrompt;
      lastHydratedDraftRef.current = {
        key: normalizedDraftKey,
        value: normalizedPrompt
      };

      if (typeof onDraftPersist === "function" && normalizedDraftKey) {
        onDraftPersist(normalizedDraftKey, normalizedPrompt);
      }
    };

    try {
      const accepted = await onSubmit({
        title: normalizedTitle,
        prompt: normalizedPrompt,
        project_id: selectedProject.id,
        attachments: normalizedAttachments
      });

      if (accepted === false) {
        restorePrompt();
      }
    } catch (error) {
      restorePrompt();
      throw error;
    } finally {
      submitInFlightRef.current = false;
    }
  }, [attachmentBusy, disabled, normalizedDraftKey, onDraftPersist, onSubmit, prompt, selectedProject?.id]);

  const handleFormSubmit = useCallback(
    (event) => {
      event.preventDefault();
      void handlePromptSubmit();
    },
    [handlePromptSubmit]
  );

  const handlePromptKeyDown = useCallback(
    (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }

      if (event.nativeEvent?.isComposing || isPromptComposingRef.current) {
        return;
      }

      if (shouldPreserveEnterForSoftKeyboard()) {
        return;
      }

      event.preventDefault();

      if (busy || disabled || !selectedProject || attachmentBusy) {
        return;
      }

      void handlePromptSubmit();
    },
    [attachmentBusy, busy, disabled, handlePromptSubmit, selectedProject, shouldPreserveEnterForSoftKeyboard]
  );

  const handleSendClick = useCallback(
    (event) => {
      if (busy || disabled || !selectedProject || attachmentBusy) {
        return;
      }

      void handlePromptSubmit();
    },
    [attachmentBusy, busy, disabled, handlePromptSubmit, selectedProject]
  );

  const attachmentCount = attachments.length;
  const actionBusy = busy || attachmentBusy;
  const canSubmit = Boolean(selectedProject) && !disabled && !actionBusy && (prompt.trim() || attachmentCount > 0);
  const canOpenVoiceMode = voiceSessionEnabled && Boolean(selectedProject) && typeof onOpenVoiceMode === "function";
  const showSpeechInputButton = typeof onToggleSpeechInput === "function";
  const canToggleSpeechInput =
    showSpeechInputButton &&
    Boolean(selectedProject) &&
    !disabled &&
    speechInputSupported;
  const speechInputActive = speechInputEnabled || speechInputListening || speechInputBusy;
  const speechInputStatusLabel = speechInputActive ? "음성 입력중" : "STT 입력";
  const canPressSendButton = Boolean(selectedProject) && !disabled && !actionBusy && (canSubmit || canOpenVoiceMode);
  const clearSendButtonLongPress = useCallback(() => {
    if (sendButtonLongPressTimerRef.current) {
      window.clearTimeout(sendButtonLongPressTimerRef.current);
      sendButtonLongPressTimerRef.current = null;
    }
  }, []);
  const resetSendButtonLongPress = useCallback(() => {
    clearSendButtonLongPress();
    sendButtonLongPressPointerRef.current = null;
  }, [clearSendButtonLongPress]);
  const handleSendButtonPointerDown = useCallback(
    (event) => {
      if (!canOpenVoiceMode) {
        return;
      }

      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }

      sendButtonLongPressTriggeredRef.current = false;
      resetSendButtonLongPress();
      sendButtonLongPressPointerRef.current = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY
      };
      if (event?.currentTarget && typeof event.currentTarget.setPointerCapture === "function") {
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // ignore pointer capture failures for synthetic events
        }
      }
      sendButtonLongPressTimerRef.current = window.setTimeout(() => {
        sendButtonLongPressTimerRef.current = null;
        sendButtonLongPressTriggeredRef.current = true;
        onOpenVoiceMode?.();
      }, SEND_BUTTON_LONG_PRESS_MS);
    },
    [SEND_BUTTON_LONG_PRESS_MS, canOpenVoiceMode, onOpenVoiceMode, resetSendButtonLongPress]
  );
  const handleSendButtonPointerMove = useCallback(
    (event) => {
      if (!sendButtonLongPressPointerRef.current) {
        return;
      }

      if (sendButtonLongPressPointerRef.current.pointerId !== event.pointerId) {
        return;
      }

      const deltaX = event.clientX - sendButtonLongPressPointerRef.current.clientX;
      const deltaY = event.clientY - sendButtonLongPressPointerRef.current.clientY;

      if (Math.hypot(deltaX, deltaY) > SEND_BUTTON_LONG_PRESS_MOVE_TOLERANCE_PX) {
        resetSendButtonLongPress();
      }
    },
    [SEND_BUTTON_LONG_PRESS_MOVE_TOLERANCE_PX, resetSendButtonLongPress]
  );
  const handleSendButtonPointerUp = useCallback(
    (event) => {
      const longPressTriggered = sendButtonLongPressTriggeredRef.current;
      resetSendButtonLongPress();

      if (event?.currentTarget && typeof event.currentTarget.releasePointerCapture === "function") {
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          // ignore pointer capture release failures
        }
      }

      if (!longPressTriggered) {
        return;
      }

      if (event.cancelable) {
        event.preventDefault();
      }
    },
    [resetSendButtonLongPress]
  );
  const handleSendButtonPointerCancel = useCallback(
    (event) => {
      resetSendButtonLongPress();

      if (event?.currentTarget && typeof event.currentTarget.releasePointerCapture === "function") {
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          // ignore pointer capture release failures
        }
      }
    },
    [resetSendButtonLongPress]
  );
  const handleSendButtonClickCapture = useCallback((event) => {
    if (!sendButtonLongPressTriggeredRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    sendButtonLongPressTriggeredRef.current = false;
  }, []);

  return (
    <form className="pointer-events-auto w-full" onSubmit={handleFormSubmit}>
        <div className="space-y-2.5">
          {attachmentCount > 0 ? (
            <div className="overflow-x-auto pb-1">
              <div className="flex min-w-max gap-2">
                {attachments.map((attachment) => {
                  const hasImagePreview = attachment.kind === "image" && attachment.preview_url;

                  return (
                    <div
                      key={attachment.id}
                      className="flex min-w-[11rem] max-w-[14rem] items-center gap-2 rounded-2xl border border-white/10 bg-slate-900/85 px-2.5 py-2.5 text-white"
                    >
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-black/20">
                        {hasImagePreview ? (
                          <img src={attachment.preview_url} alt={attachment.name} className="h-full w-full object-cover" />
                        ) : (
                          <MessageAttachmentBadge
                            attachment={attachment}
                            compact
                            resolveBadge={resolveMessageAttachmentBadge}
                          />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{attachment.name}</p>
                        <p className="mt-0.5 text-[11px] text-slate-400">
                          {formatMessageAttachmentSize(attachment.size_bytes)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveAttachment(attachment.id)}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/10 text-sm text-white/80"
                        aria-label={`${attachment.name} 제거`}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={MESSAGE_ATTACHMENT_ACCEPT}
            className="hidden"
            onChange={handleAttachmentChange}
          />

          <div className="flex items-end gap-3">
            <div
              data-testid="thread-prompt-surface"
              onPointerDown={focusPromptTextareaFromSurface}
              onClick={focusPromptTextareaFromSurface}
              className="min-w-0 flex-1 cursor-text rounded-[1.35rem] border border-white/10 bg-slate-900 px-3 py-2"
            >
              <div className="mb-1 flex min-h-6 items-center justify-between gap-2">
                <div className="min-w-0 flex-1 text-[11px] text-slate-500">
                  <p className="truncate">
                    {selectedProject ? `${selectedProject.name} · ${label ?? "프롬프트"}` : "프로젝트를 선택해 주세요"}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  {showSpeechInputButton ? (
                    <button
                      type="button"
                      data-testid="thread-prompt-speech-button"
                      onPointerDown={(event) => {
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onToggleSpeechInput?.();
                      }}
                      disabled={!canToggleSpeechInput}
                      className={`flex h-6 min-w-[7.75rem] shrink-0 items-center justify-center gap-1 rounded-md border px-2 transition ${
                        speechInputActive
                          ? "border-rose-300/45 bg-rose-500/20 text-rose-100"
                          : "border-sky-300/35 bg-sky-500/10 text-sky-100"
                      } disabled:cursor-not-allowed disabled:opacity-45`}
                      aria-label={speechInputActive ? "음성 입력 끄기" : "STT 입력 켜기"}
                      title={
                        !speechInputSupported
                          ? "이 브라우저는 음성 입력(STT)을 지원하지 않습니다."
                          : speechInputActive
                            ? speechInputHint || "음성 입력 끄기"
                            : "STT 입력 켜기"
                      }
                    >
                      <span
                        className={`inline-block h-1.5 w-1.5 rounded-full ${
                          speechInputActive ? "animate-pulse bg-current" : "bg-current/80"
                        }`}
                      />
                      <span className="text-[10px] font-semibold tracking-[0.02em]">
                        {speechInputStatusLabel}
                      </span>
                    </button>
                  ) : null}

                  <button
                    type="button"
                    data-testid="thread-prompt-attach-button"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      fileInputRef.current?.click();
                    }}
                    disabled={actionBusy || !selectedProject || disabled || attachmentCount >= MAX_MESSAGE_ATTACHMENTS}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.04] text-slate-300 transition hover:bg-white/[0.09] hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
                    aria-label="첨부 파일 추가"
                    title={
                      attachmentCount > 0
                        ? `이미지 또는 텍스트 파일 첨부 · ${attachmentCount}/${MAX_MESSAGE_ATTACHMENTS}`
                        : "이미지 또는 텍스트 파일 첨부"
                    }
                  >
                    {attachmentBusy ? (
                      <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    ) : (
                      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path d="M21.44 11.05l-8.49 8.49a5.5 5.5 0 01-7.78-7.78l9.19-9.19a3.5 3.5 0 014.95 4.95l-9.2 9.19a1.5 1.5 0 01-2.12-2.12l8.49-8.48" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
              <textarea
                rows="1"
                ref={textareaRef}
                data-testid="thread-prompt-input"
                value={prompt}
                onChange={handlePromptChange}
                onKeyDown={handlePromptKeyDown}
                onCompositionStart={() => {
                  isPromptComposingRef.current = true;
                }}
                onCompositionEnd={() => {
                  isPromptComposingRef.current = false;
                }}
                onFocus={handlePromptFocus}
                onBlur={handlePromptBlur}
                placeholder=""
                disabled={!selectedProject || actionBusy || disabled}
                enterKeyHint="enter"
                className="min-h-[24px] w-full resize-none overflow-y-auto border-none bg-transparent p-0 text-sm leading-5 text-white outline-none ring-0 focus:ring-0"
              />
            </div>
            {onStop ? (
              <button
                type="button"
                onClick={() => void onStop()}
                disabled={stopBusy}
                className="flex h-16 min-w-[5.25rem] shrink-0 items-center justify-center rounded-full bg-rose-500 px-4 text-sm font-semibold text-white transition hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {stopBusy ? (
                  <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                ) : (
                  stopLabel
                )}
              </button>
            ) : (
              <div className="flex shrink-0 items-end gap-2">
                <button
                  type="button"
                  onClick={handleSendClick}
                  onPointerDown={canOpenVoiceMode ? handleSendButtonPointerDown : undefined}
                  onPointerMove={canOpenVoiceMode ? handleSendButtonPointerMove : undefined}
                  onPointerUp={canOpenVoiceMode ? handleSendButtonPointerUp : undefined}
                  onPointerLeave={canOpenVoiceMode ? handleSendButtonPointerCancel : undefined}
                  onPointerCancel={canOpenVoiceMode ? handleSendButtonPointerCancel : undefined}
                  onClickCapture={canOpenVoiceMode ? handleSendButtonClickCapture : undefined}
                  disabled={!canPressSendButton}
                  aria-label="메시지 전송"
                  title={canOpenVoiceMode ? "메시지 전송 · 길게 눌러 음성 모드" : "메시지 전송"}
                  data-testid="thread-prompt-send-button"
                  className={`relative flex h-14 w-14 items-center justify-center rounded-full border-2 text-lg transition ${
                    canPressSendButton
                      ? "border-telegram-400/80 bg-telegram-500 text-white hover:bg-telegram-400"
                      : "border-white/15 bg-white/[0.05] text-slate-200 hover:bg-white/[0.09]"
                  } disabled:cursor-not-allowed disabled:opacity-45`}
                >
                  {actionBusy ? (
                    <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  ) : (
                    <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path d="M20 4L4 12l6 2 2 6 8-16z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                    </svg>
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
      </form>
  );
}
