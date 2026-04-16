import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import AttachmentPreviewDialog from "./mobileAttachmentPreviewDialog.jsx";
import MobileInlineIssueComposer from "./mobileInlineIssueComposer.jsx";
import { MessageAttachmentPreview } from "./mobileMessageAttachmentUi.jsx";
import ThreadMessageActionSheet from "./mobileThreadMessageActionSheet.jsx";
import VoiceModePanel from "./VoiceModePanel.jsx";
import { useMobileFeedback } from "./mobileSharedUi.jsx";
import useFallbackVoiceSession from "./voice/useFallbackVoiceSession.js";
import useRealtimeVoiceSession from "./voice/useRealtimeVoiceSession.js";
import {
  getVoiceCapabilityDateKey,
  readStoredVoiceCapabilitySnapshot,
  updateStoredVoiceCapabilitySnapshot,
  VOICE_CAPABILITY_STATUS_AVAILABLE,
  VOICE_CAPABILITY_STATUS_BLOCKED,
  VOICE_CAPABILITY_STATUS_UNKNOWN
} from "./voice/voiceCapabilityCache.js";
import {
  formatAssistantResponseForVoice,
  formatFileContextSummaryForVoice,
  formatProjectProgramSummaryForVoice,
  formatVoiceExecutionReportForVoice
} from "./voice/voiceResponseFormatter.js";
import { MessageBubble, RichMessageContent, summarizeMessageContent } from "./mobileRichMessageUi.jsx";

const InlineIssueComposer = MobileInlineIssueComposer;
const THREAD_CONTENT_FILTERS = [
  { id: "all", label: "all" },
  { id: "prompts", label: "prompts" },
  { id: "responses", label: "responses" },
  { id: "runs", label: "runs" }
];
const CHAT_AUTO_SCROLL_THRESHOLD_PX = 96;
const CHAT_MANUAL_SCROLL_UNPIN_DELTA_PX = 2;
const CHAT_JUMP_TO_LATEST_BUTTON_THRESHOLD_PX = 240;
const HEADER_MENU_SCROLL_DELTA_PX = 12;
const HEADER_MENU_VIEWPORT_SETTLE_MS = 320;
const VOICE_MODE_VALUES = new Set(["off", "realtime", "tts", "stt_only"]);
const SYSTEM_MESSAGE_TITLE_BY_KIND = {
  handoff_summary: "핸드오프 요약",
  tool_call: "도구 호출",
  tool_result: "도구 응답",
  mcp_call: "MCP 호출",
  mcp_result: "MCP 응답",
  skill_call: "스킬 호출",
  skill_result: "스킬 응답",
  function_call: "함수 호출",
  function_result: "함수 응답"
};
const HIDDEN_CHAT_MESSAGE_KINDS = new Set([
  "tool_call",
  "mcp_call",
  "skill_call",
  "function_call",
  "function_result"
]);

function normalizeVoiceMode(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return VOICE_MODE_VALUES.has(normalized) ? normalized : "off";
}

function normalizeVoiceCapabilityStatus(value) {
  const normalized = String(value ?? "").trim().toLowerCase();

  if (
    normalized === VOICE_CAPABILITY_STATUS_AVAILABLE ||
    normalized === VOICE_CAPABILITY_STATUS_BLOCKED ||
    normalized === VOICE_CAPABILITY_STATUS_UNKNOWN
  ) {
    return normalized;
  }

  return VOICE_CAPABILITY_STATUS_UNKNOWN;
}

function normalizeResolvedVoiceState(voiceState, createInitialThreadVoiceState) {
  const baseState = createInitialThreadVoiceState();

  if (!voiceState || typeof voiceState !== "object") {
    return baseState;
  }

  return {
    enabled: voiceState.enabled === true,
    mode: normalizeVoiceMode(voiceState.mode),
    promptSubmittedAt: String(voiceState.promptSubmittedAt ?? "").trim(),
    lastSubmittedPrompt: String(voiceState.lastSubmittedPrompt ?? "").trim(),
    delegatedThreadId: String(voiceState.delegatedThreadId ?? "").trim(),
    capabilityDateKey: String(voiceState.capabilityDateKey ?? "").trim(),
    realtimeStatus: normalizeVoiceCapabilityStatus(voiceState.realtimeStatus),
    ttsStatus: normalizeVoiceCapabilityStatus(voiceState.ttsStatus),
    lastError: String(voiceState.lastError ?? "").trim()
  };
}

function describeTtsAvailabilityError(error) {
  const message = String(error?.message ?? "").trim();
  const code = String(error?.code ?? error?.payload?.code ?? "").trim();

  if (code === "voice_narration_disabled" || code === "voice_session_api_key_missing") {
    return "음성 TTS를 사용할 수 없습니다.";
  }

  return message || "음성 TTS를 사용할 수 없습니다.";
}

function isSystemLikeMessage(message) {
  return message?.role === "system" || message?.kind === "handoff_summary";
}

function shouldHideMessageFromChatWindow(message) {
  const normalizedKind = String(message?.kind ?? "").trim();
  return HIDDEN_CHAT_MESSAGE_KINDS.has(normalizedKind);
}

function getSystemMessageTitle(message, fallback = "시스템") {
  const normalizedKind = String(message?.kind ?? "").trim();
  return SYSTEM_MESSAGE_TITLE_BY_KIND[normalizedKind] ?? fallback;
}

function getAssistantMessageTitle(message, fallback = "응답") {
  const normalizedKind = String(message?.kind ?? "").trim();
  return SYSTEM_MESSAGE_TITLE_BY_KIND[normalizedKind] ?? fallback;
}

function ConversationTimeline({ entries, formatDateTime, formatRelativeTime }) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }

  return (
    <ul className="mt-4 space-y-6 border-l border-white/10 pl-4">
      {entries.map((entry, index) => (
        <li key={entry.id ?? index} data-scroll-anchor-id={`conversation:${entry.id ?? index}`} className="relative pl-6">
          <span
            aria-hidden="true"
            className="absolute left-[-13px] top-3 flex h-6 w-6 items-center justify-center rounded-full border border-telegram-400 bg-slate-950 text-[10px] font-semibold text-white"
          >
            {index + 1}
          </span>
          <article className="rounded-[1.5rem] border border-white/10 bg-white/5 px-4 py-4 text-sm leading-6 text-slate-200">
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span>{formatDateTime(entry.promptAt)}</span>
              <span>{entry.responses.length ? `${entry.responses.length}개의 응답` : "응답 없음"}</span>
            </div>
            <p className="mt-3 break-words [overflow-wrap:anywhere] text-base font-semibold text-white">
              {entry.prompt?.trim() ? entry.prompt : "프롬프트가 비어 있습니다."}
            </p>

            {entry.responses.length ? (
              <div className="mt-3 space-y-3">
                {entry.responses.map((response) => (
                  <div
                    key={response.id}
                    className="rounded-[1rem] border border-white/5 bg-slate-950/70 px-3 py-2 text-sm leading-6 text-slate-200"
                  >
                    <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                      {response.content || "응답이 비어 있습니다."}
                    </p>
                    <p className="mt-1 text-right text-[11px] text-slate-500">{formatRelativeTime(response.timestamp)}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 rounded-full bg-amber-400/15 px-3 py-1.5 text-[12px] text-amber-200">아직 응답이 없습니다.</p>
            )}
          </article>
        </li>
      ))}
    </ul>
  );
}

function RunTimeline({ entries, formatRelativeTime }) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }

  return (
    <ul className="space-y-3">
      {entries.map((entry) => (
        <li key={entry.id} data-scroll-anchor-id={`run:${entry.id}`} className="border-b border-white/8 px-1 pb-3">
          <div className="flex items-center justify-between gap-3 text-[11px] text-slate-500">
            <span>{entry.title}</span>
            <span>{formatRelativeTime(entry.timestamp)}</span>
          </div>
          <p className="mt-1 text-sm leading-6 text-slate-200">{entry.description}</p>
        </li>
      ))}
    </ul>
  );
}

export default function ThreadDetail({
  thread,
  project,
  bridgeId = "",
  sessionLoginId = "",
  apiRequest: voiceApiRequest = null,
  messages,
  issues = [],
  historyLoading = false,
  historyError = "",
  hasOlderMessages = false,
  remainingHistoryCount = 0,
  onLoadOlderMessages = null,
  signalNow,
  messagesLoading,
  messagesError,
  onRefreshMessages,
  onStopThreadExecution,
  onInterruptIssue,
  onRetryIssue,
  onDeleteIssue,
  onSubmitPrompt,
  onVoiceDelegatePrompt,
  submitBusy,
  onBack,
  threadInstructionSupported = false,
  messageFilter,
  onChangeMessageFilter,
  composerDraftKey = "",
  composerDraft = "",
  onPersistComposerDraft = null,
  isDraft = false,
  showBackButton = true,
  standalone = true,
  emptyStateMessage = "",
  voiceSessionEnabled = true,
  voiceState = null,
  onVoiceStateChange = null,
  voiceFollowupThreadDetail = null,
  inlineIssueComposerHelpers,
  helpers = {}
}) {
  const {
    buildSpeechFriendlyMessageText,
    buildRunTimeline,
    buildThreadResponseSignal,
    captureScrollAnchorSnapshot,
    copyTextToClipboard,
    createInitialThreadVoiceState,
    findActiveIssueForThread,
    formatDateTime,
    formatMessageAttachmentSize,
    formatRelativeTime,
    formatThreadContextUsage,
    getDistanceFromBottom,
    getRealtimeProgressText,
    isRetryableIssueStatus,
    getStatusMeta,
    getThreadContextUsage,
    isBottomBoundaryMomentumLocked,
    isTextInputElement,
    normalizeIssue,
    normalizeMessageAttachment,
    normalizeMessageAttachments,
    resolveMessageAttachmentBadge,
    restoreScrollAnchorSnapshot,
    useTouchScrollBoundaryLock
  } = helpers;
  const status = thread ? getStatusMeta(thread.status) : null;
  const responseSignal = thread ? buildThreadResponseSignal(thread, signalNow) : null;
  const scrollRef = useRef(null);
  const scrollContentRef = useRef(null);
  const scrollAnchorRef = useRef(null);
  const footerRef = useRef(null);
  const previousScrollTopRef = useRef(0);
  const pinnedToLatestRef = useRef(true);
  const [isPinnedToLatest, setIsPinnedToLatest] = useState(true);
  const [showJumpToLatestButton, setShowJumpToLatestButton] = useState(false);
  const autoScrollingRef = useRef(false);
  const [showHeaderMenus, setShowHeaderMenus] = useState(true);
  const headerMenuViewportLockUntilRef = useRef(0);
  const keyboardPinnedToBottomRef = useRef(false);
  const historyScrollRestoreRef = useRef(null);
  const [refreshPending, setRefreshPending] = useState(false);
  const [interruptingIssueId, setInterruptingIssueId] = useState("");
  const [retryingIssueId, setRetryingIssueId] = useState("");
  const [deletingIssueId, setDeletingIssueId] = useState("");
  const [activeMessageAction, setActiveMessageAction] = useState(null);
  const [previewAttachment, setPreviewAttachment] = useState(null);
  const [composerSpeechInsert, setComposerSpeechInsert] = useState({
    token: "",
    text: ""
  });
  const { alert: showAlert } = useMobileFeedback();
  const resolvedVoiceState = normalizeResolvedVoiceState(voiceState, createInitialThreadVoiceState);
  const voiceModeEnabled = resolvedVoiceState.enabled;
  const voiceMode = resolvedVoiceState.mode;
  const voicePromptSubmittedAt = resolvedVoiceState.promptSubmittedAt;
  const voiceLastSubmittedPrompt = resolvedVoiceState.lastSubmittedPrompt;
  const voiceDelegatedThreadId = resolvedVoiceState.delegatedThreadId;
  const voiceRealtimeStatus = resolvedVoiceState.realtimeStatus;
  const voiceTtsStatus = resolvedVoiceState.ttsStatus;
  const voiceLastError = resolvedVoiceState.lastError;
  const voicePanelOpen = voiceModeEnabled && (voiceMode === "realtime" || voiceMode === "tts");
  const voiceSttOnlyMode = voiceMode === "stt_only";
  const currentVoiceModeRef = useRef(voiceMode);
  const currentVoiceStateRef = useRef(resolvedVoiceState);
  const voiceCapabilityDateKey = getVoiceCapabilityDateKey();
  const voiceCapabilityScope = useMemo(
    () => ({
      loginId: sessionLoginId,
      bridgeId
    }),
    [bridgeId, sessionLoginId]
  );
  const updateVoiceState = useCallback(
    (updater) => {
      if (typeof onVoiceStateChange !== "function") {
        return;
      }

      onVoiceStateChange((current) => {
        const baseState = normalizeResolvedVoiceState(current, createInitialThreadVoiceState);
        const nextState = typeof updater === "function" ? updater(baseState) : updater;

        if (!nextState || typeof nextState !== "object") {
          return baseState;
        }

        return normalizeResolvedVoiceState(nextState, createInitialThreadVoiceState);
      });
    },
    [createInitialThreadVoiceState, onVoiceStateChange]
  );
  const resetVoiceState = useCallback(() => {
    updateVoiceState(createInitialThreadVoiceState());
  }, [updateVoiceState]);

  useEffect(() => {
    currentVoiceModeRef.current = voiceMode;
    currentVoiceStateRef.current = resolvedVoiceState;
  }, [resolvedVoiceState, voiceMode]);

  const readVoiceCapabilitySnapshot = useCallback(() => {
    return readStoredVoiceCapabilitySnapshot(voiceCapabilityScope, voiceCapabilityDateKey);
  }, [voiceCapabilityDateKey, voiceCapabilityScope]);

  const updateVoiceCapabilitySnapshot = useCallback(
    (updater) => {
      return updateStoredVoiceCapabilitySnapshot(voiceCapabilityScope, updater, voiceCapabilityDateKey);
    },
    [voiceCapabilityDateKey, voiceCapabilityScope]
  );

  const handleVoicePromptSubmit = useCallback((prompt) => {
    const normalizedPrompt = buildSpeechFriendlyMessageText(prompt);
    const delegatePromptHandler =
      !voiceDelegatedThreadId && typeof onVoiceDelegatePrompt === "function" ? onVoiceDelegatePrompt : onSubmitPrompt;

    if (!normalizedPrompt || typeof delegatePromptHandler !== "function") {
      return {
        ok: false,
        accepted: false,
        prompt: normalizedPrompt
      };
    }

    const submittedAt = new Date().toISOString();
    updateVoiceState((current) => ({
      ...current,
      promptSubmittedAt: submittedAt,
      lastSubmittedPrompt: normalizedPrompt
    }));
    return Promise.resolve(
      delegatePromptHandler({
        prompt: normalizedPrompt,
        project_id: String(project?.id ?? "").trim(),
        source: "realtime_voice_delegate"
      })
    ).then((result) => {
      const resolvedThreadId =
        typeof result === "object" && result?.thread_id
          ? String(result.thread_id).trim()
          : voiceDelegatedThreadId || String(thread?.id ?? "").trim();
      const resolvedProjectId =
        typeof result === "object" && result?.project_id
          ? String(result.project_id).trim()
          : String(project?.id ?? "").trim();
      const handoffToNewThread = !voiceDelegatedThreadId && Boolean(resolvedThreadId);

      if (handoffToNewThread) {
        const applyVoiceThreadHandoff = () => {
          updateVoiceState((current) => ({
            ...current,
            delegatedThreadId: resolvedThreadId
          }));
        };

        if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
          window.setTimeout(applyVoiceThreadHandoff, 0);
        } else {
          applyVoiceThreadHandoff();
        }
      }

      return {
        ...(result && typeof result === "object" ? result : null),
        ok: result !== false && (typeof result === "object" ? result?.ok ?? true : true),
        accepted: result !== false && (typeof result === "object" ? result?.accepted ?? true : true),
        prompt: normalizedPrompt,
        submitted_at: submittedAt,
        thread_id: resolvedThreadId,
        project_id: resolvedProjectId,
        switch_to_thread_id: handoffToNewThread ? resolvedThreadId : "",
        voice_handoff: handoffToNewThread
      };
    });
  }, [onSubmitPrompt, onVoiceDelegatePrompt, project?.id, thread?.id, updateVoiceState, voiceDelegatedThreadId]);

  const syncVoiceCapabilityToState = useCallback(
    (snapshot, overrides = {}) => {
      updateVoiceState((current) => ({
        ...current,
        capabilityDateKey: snapshot.dateKey,
        realtimeStatus: snapshot.realtime,
        ttsStatus: snapshot.tts,
        ...(Object.prototype.hasOwnProperty.call(overrides, "lastError")
          ? {
              lastError: String(overrides.lastError ?? "").trim()
            }
          : null)
      }));
    },
    [updateVoiceState]
  );

  useEffect(() => {
    const snapshot = readStoredVoiceCapabilitySnapshot(voiceCapabilityScope, voiceCapabilityDateKey);

    if (
      resolvedVoiceState.capabilityDateKey === snapshot.dateKey &&
      resolvedVoiceState.realtimeStatus === snapshot.realtime &&
      resolvedVoiceState.ttsStatus === snapshot.tts
    ) {
      return;
    }

    syncVoiceCapabilityToState(snapshot, {
      lastError:
        resolvedVoiceState.capabilityDateKey && resolvedVoiceState.capabilityDateKey !== snapshot.dateKey
          ? ""
          : currentVoiceStateRef.current.lastError
    });
  }, [
    resolvedVoiceState.capabilityDateKey,
    resolvedVoiceState.realtimeStatus,
    resolvedVoiceState.ttsStatus,
    syncVoiceCapabilityToState,
    voiceCapabilityDateKey,
    voiceCapabilityScope
  ]);

  const probeTtsCapability = useCallback(async () => {
    if (!sessionLoginId || !bridgeId || typeof voiceApiRequest !== "function") {
      return updateVoiceCapabilitySnapshot((current) => ({
        ...current,
        tts: VOICE_CAPABILITY_STATUS_BLOCKED,
        ttsCheckedAt: new Date().toISOString(),
        ttsError: "음성 TTS를 사용할 수 없습니다."
      }));
    }

    try {
      await voiceApiRequest(
        `/api/voice/narrations?login_id=${encodeURIComponent(sessionLoginId)}&bridge_id=${encodeURIComponent(bridgeId)}`,
        {
          method: "POST",
          body: JSON.stringify({
            text: "음성 준비가 완료되었습니다."
          })
        }
      );

      return updateVoiceCapabilitySnapshot((current) => ({
        ...current,
        tts: VOICE_CAPABILITY_STATUS_AVAILABLE,
        ttsCheckedAt: new Date().toISOString(),
        ttsError: ""
      }));
    } catch (error) {
      const describedError = describeTtsAvailabilityError(error);

      return updateVoiceCapabilitySnapshot((current) => ({
        ...current,
        tts: VOICE_CAPABILITY_STATUS_BLOCKED,
        ttsCheckedAt: new Date().toISOString(),
        ttsError: describedError
      }));
    }
  }, [bridgeId, sessionLoginId, updateVoiceCapabilitySnapshot, voiceApiRequest]);

  const activateTtsOrSttMode = useCallback(
    async ({ capabilitySnapshot = null, errorMessage = "", announce = false } = {}) => {
      let nextSnapshot = capabilitySnapshot ?? readVoiceCapabilitySnapshot();

      if (nextSnapshot.tts !== VOICE_CAPABILITY_STATUS_BLOCKED && nextSnapshot.tts !== VOICE_CAPABILITY_STATUS_AVAILABLE) {
        nextSnapshot = await probeTtsCapability();
      }

      const nextMode =
        nextSnapshot.tts === VOICE_CAPABILITY_STATUS_AVAILABLE
          ? "tts"
          : "stt_only";
      const nextErrorMessage = String(errorMessage || nextSnapshot.ttsError || currentVoiceStateRef.current.lastError || "").trim();

      updateVoiceState((current) => ({
        ...current,
        enabled: nextMode === "tts",
        mode: nextMode,
        promptSubmittedAt: "",
        lastSubmittedPrompt: "",
        delegatedThreadId: "",
        capabilityDateKey: nextSnapshot.dateKey,
        realtimeStatus: nextSnapshot.realtime,
        ttsStatus: nextSnapshot.tts,
        lastError: nextErrorMessage
      }));

      if (announce) {
        showAlert(
          nextMode === "tts"
            ? "실시간 음성 API를 사용할 수 없어 음성 TTS 모드로 전환했습니다."
            : "실시간 음성과 TTS를 사용할 수 없어 일반 채팅 STT 입력 모드로 전환했습니다.",
          {
            title: "음성 모드",
            tone: nextMode === "tts" ? "info" : "error"
          }
        );
      }

      return nextMode;
    },
    [probeTtsCapability, readVoiceCapabilitySnapshot, showAlert, updateVoiceState]
  );

  const handleRealtimeAvailabilityChange = useCallback(
    async ({ status = "", error = "" } = {}) => {
      const normalizedStatus = normalizeVoiceCapabilityStatus(status);

      if (normalizedStatus === VOICE_CAPABILITY_STATUS_UNKNOWN) {
        return;
      }

      const normalizedError = String(error ?? "").trim();
      const nextSnapshot = updateVoiceCapabilitySnapshot((current) => ({
        ...current,
        realtime: normalizedStatus,
        realtimeCheckedAt: new Date().toISOString(),
        realtimeError: normalizedStatus === VOICE_CAPABILITY_STATUS_BLOCKED ? normalizedError : ""
      }));

      syncVoiceCapabilityToState(nextSnapshot, {
        lastError: normalizedStatus === VOICE_CAPABILITY_STATUS_BLOCKED ? normalizedError : ""
      });

      if (normalizedStatus === VOICE_CAPABILITY_STATUS_BLOCKED && currentVoiceModeRef.current === "realtime") {
        await activateTtsOrSttMode({
          capabilitySnapshot: nextSnapshot,
          errorMessage: normalizedError,
          announce: true
        });
      }
    },
    [activateTtsOrSttMode, syncVoiceCapabilityToState, updateVoiceCapabilitySnapshot]
  );

  const handleTtsAvailabilityChange = useCallback(
    async ({ status = "", error = "" } = {}) => {
      const normalizedStatus = normalizeVoiceCapabilityStatus(status);

      if (normalizedStatus === VOICE_CAPABILITY_STATUS_UNKNOWN) {
        return;
      }

      const normalizedError = String(error ?? "").trim();
      const nextSnapshot = updateVoiceCapabilitySnapshot((current) => ({
        ...current,
        tts: normalizedStatus,
        ttsCheckedAt: new Date().toISOString(),
        ttsError: normalizedStatus === VOICE_CAPABILITY_STATUS_BLOCKED ? normalizedError : ""
      }));

      syncVoiceCapabilityToState(nextSnapshot, {
        lastError: normalizedStatus === VOICE_CAPABILITY_STATUS_BLOCKED ? normalizedError : ""
      });

      if (normalizedStatus === VOICE_CAPABILITY_STATUS_BLOCKED && currentVoiceModeRef.current === "tts") {
        await activateTtsOrSttMode({
          capabilitySnapshot: nextSnapshot,
          errorMessage: normalizedError,
          announce: true
        });
      }
    },
    [activateTtsOrSttMode, syncVoiceCapabilityToState, updateVoiceCapabilitySnapshot]
  );

  const handleFallbackDraftTranscript = useCallback((transcript) => {
    const normalizedTranscript = String(transcript ?? "").trim();

    if (!normalizedTranscript) {
      return;
    }

    setComposerSpeechInsert({
      token: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: normalizedTranscript
    });
  }, []);

  useTouchScrollBoundaryLock(scrollRef);
  const [viewMode] = useState("chat");
  const threadTitle = thread?.title ?? "새 채팅창";
  const threadTimestamp = thread?.created_at ?? new Date().toISOString();
  const contextUsage = getThreadContextUsage(thread);
  const safeIssues = Array.isArray(issues) ? issues : [];
  const normalizedIssues = useMemo(
    () => safeIssues.map((issue) => normalizeIssue(issue, thread?.id)).filter(Boolean),
    [safeIssues, thread?.id]
  );
  const voiceFollowupThreadState = useMemo(() => {
    const normalizedVoiceThreadId = String(voiceDelegatedThreadId ?? "").trim();

    if (!normalizedVoiceThreadId) {
      return null;
    }

    if (String(thread?.id ?? "").trim() === normalizedVoiceThreadId) {
      return {
        thread,
        messages: Array.isArray(messages) ? messages : [],
        issues: normalizedIssues
      };
    }

    const fallbackThread =
      String(voiceFollowupThreadDetail?.thread?.id ?? "").trim() === normalizedVoiceThreadId
        ? voiceFollowupThreadDetail.thread
        : {
            id: normalizedVoiceThreadId,
            title: "",
            status: ""
          };

    return {
      thread: fallbackThread,
      messages: Array.isArray(voiceFollowupThreadDetail?.messages) ? voiceFollowupThreadDetail.messages : [],
      issues: (Array.isArray(voiceFollowupThreadDetail?.issues) ? voiceFollowupThreadDetail.issues : [])
        .map((issue) => normalizeIssue(issue, normalizedVoiceThreadId))
        .filter(Boolean)
    };
  }, [messages, normalizedIssues, thread, voiceDelegatedThreadId, voiceFollowupThreadDetail]);
  const issueById = useMemo(() => {
    const next = new Map();

    normalizedIssues.forEach((issue) => {
      next.set(issue.id, issue);
    });

    return next;
  }, [normalizedIssues]);
  const voiceFollowupThreadReady = Boolean(String(voiceDelegatedThreadId ?? "").trim());
  const voiceContextThread = voiceFollowupThreadReady ? voiceFollowupThreadState?.thread ?? null : thread;
  const voiceContextMessages =
    voiceFollowupThreadReady ? voiceFollowupThreadState?.messages ?? [] : Array.isArray(messages) ? messages : [];
  const voiceContextIssues = voiceFollowupThreadReady ? voiceFollowupThreadState?.issues ?? [] : normalizedIssues;
  const activePhysicalThreadId = thread?.active_physical_thread_id ?? null;
  const interruptibleIssue = useMemo(() => {
    const activeIssue = findActiveIssueForThread(normalizedIssues, activePhysicalThreadId);

    if (!activeIssue || !["running", "awaiting_input"].includes(activeIssue.status ?? "")) {
      return null;
    }

    return activeIssue;
  }, [activePhysicalThreadId, normalizedIssues]);
  const isInputDisabled = !isDraft && thread?.status === "running";
  const chatTimeline = useMemo(() => {
    const normalized = [];
    let lastPrompt = null;

    const safeMessages = Array.isArray(messages) ? messages.filter((message) => !shouldHideMessageFromChatWindow(message)) : [];

    safeMessages.forEach((message, index) => {
      if (!message) {
        return;
      }

      const role =
        message.role === "assistant"
          ? "assistant"
          : isSystemLikeMessage(message)
            ? "system"
            : "user";
      const content = String(message.content ?? "").trim();
      const timestamp = message.timestamp ?? thread.updated_at ?? thread.created_at ?? new Date().toISOString();
      const issueAttachments =
        role === "user" && message.issue_id ? issueById.get(message.issue_id)?.attachments ?? [] : [];
      const attachments = normalizeMessageAttachments(message.attachments?.length ? message.attachments : issueAttachments);
      const base = {
        id: message.id ?? `${role}-${index}`,
        role,
        content,
        timestamp,
        issueId: message.issue_id ?? null,
        attachments
      };

      if (role === "system") {
        lastPrompt = null;
        normalized.push({
          ...base,
          align: "center",
          tone: "system",
          title: getSystemMessageTitle(message)
        });
        return;
      }

      if (role === "user") {
        lastPrompt = base;
        normalized.push({
          ...base,
          align: "right",
          tone: "brand",
          title: "프롬프트"
        });
        return;
      }

      normalized.push({
        ...base,
        align: "left",
        tone: "light",
        title: getAssistantMessageTitle(message),
        replyTo: lastPrompt
      });
    });

    return normalized;
  }, [issueById, messages, thread?.created_at, thread?.updated_at]);
  const conversationTimeline = useMemo(() => {
    const fallbackTimestamp = thread?.updated_at ?? thread?.created_at ?? new Date().toISOString();
    const safeMessages = Array.isArray(messages) ? messages.filter((message) => !shouldHideMessageFromChatWindow(message)) : [];
    const groups = [];
    let currentGroup = null;
    let syntheticIndex = 0;

    const commitGroup = () => {
      if (!currentGroup) {
        return;
      }

      groups.push({
        ...currentGroup,
        prompt: currentGroup.prompt,
        promptAt: currentGroup.promptAt ?? fallbackTimestamp,
        responses: currentGroup.responses
      });
      currentGroup = null;
    };

    safeMessages.forEach((message, index) => {
      if (!message) {
        return;
      }

      const role =
        message.role === "assistant"
          ? "assistant"
          : isSystemLikeMessage(message)
            ? "system"
            : "user";
      const content = String(message.content ?? "").trim();
      const timestamp = message.timestamp ?? fallbackTimestamp;
      const identifier = message.id ?? `${role}-${index}`;

      if (role === "system") {
        commitGroup();
        groups.push({
          id: identifier,
          prompt: getSystemMessageTitle(message, "시스템 메시지"),
          promptAt: timestamp,
          responses: [
            {
              id: `${identifier}-system`,
              content,
              timestamp
            }
          ]
        });
        return;
      }

      if (role === "user") {
        commitGroup();
        currentGroup = {
          id: identifier,
          prompt: content || "",
          promptAt: timestamp,
          responses: []
        };
        return;
      }

      if (!currentGroup) {
        currentGroup = {
          id: `synthetic-${syntheticIndex++}`,
          prompt: "이전 프롬프트 없음",
          promptAt: timestamp,
          responses: []
        };
      }

      currentGroup.responses.push({
        id: identifier,
        content,
        timestamp
      });
    });

    commitGroup();

    return groups;
  }, [messages, thread?.created_at, thread?.updated_at]);
  const runTimeline = useMemo(() => buildRunTimeline(thread, messages), [buildRunTimeline, messages, thread]);
  const promptTimeline = useMemo(
    () => conversationTimeline.map((entry) => ({ ...entry, responses: [] })),
    [conversationTimeline]
  );
  const responseTimeline = useMemo(
    () =>
      chatTimeline.filter((entry) => entry.role === "assistant").map((entry) => ({
        id: entry.id,
        content: entry.content,
        timestamp: entry.timestamp
      })),
    [chatTimeline]
  );
  const visibleChatTimeline = useMemo(() => {
    if (messageFilter === "prompts") {
      return chatTimeline.filter((entry) => entry.role === "user");
    }

    if (messageFilter === "responses") {
      return chatTimeline.filter((entry) => entry.role === "assistant");
    }

    if (messageFilter === "runs") {
      return [];
    }

    return chatTimeline;
  }, [chatTimeline, messageFilter]);
  const visibleChatTimelineSignature = useMemo(
    () =>
      visibleChatTimeline
        .map(
          (entry) =>
            `${entry.id}:${entry.timestamp ?? ""}:${entry.role}:${String(entry.content ?? "").length}:${entry.attachments?.length ?? 0}`
        )
        .join("|"),
    [visibleChatTimeline]
  );
  const latestHandoffSummaryText = useMemo(() => {
    const safeMessages = Array.isArray(voiceContextMessages) ? voiceContextMessages : [];

    for (let index = safeMessages.length - 1; index >= 0; index -= 1) {
      const message = safeMessages[index];

      if (!message || message.kind !== "handoff_summary") {
        continue;
      }

      const content = String(message.content ?? "").trim();

      if (content) {
        return content;
      }
    }

    return "";
  }, [voiceContextMessages]);
  const voiceSyncAnchorTimestamp = voicePromptSubmittedAt;
  const voiceLinkedAssistantText = useMemo(() => {
    if (!voiceModeEnabled || !voiceSyncAnchorTimestamp) {
      return "";
    }

    const anchorTime = Date.parse(voiceSyncAnchorTimestamp);

    if (!Number.isFinite(anchorTime)) {
      return "";
    }

    const safeMessages = Array.isArray(voiceContextMessages) ? voiceContextMessages : [];
    const fallbackTimestamp =
      voiceContextThread?.updated_at ?? voiceContextThread?.created_at ?? thread?.updated_at ?? thread?.created_at ?? new Date().toISOString();
    const latestAssistantEntry = [...safeMessages]
      .reverse()
      .find((message) => {
        if (message?.role !== "assistant") {
          return false;
        }

        const spokenText = formatAssistantResponseForVoice(message.content);
        const entryTime = Date.parse(message.timestamp ?? fallbackTimestamp);
        return Boolean(spokenText) && Number.isFinite(entryTime) && entryTime >= anchorTime;
      });

    return formatAssistantResponseForVoice(latestAssistantEntry?.content);
  }, [thread?.created_at, thread?.updated_at, voiceContextMessages, voiceContextThread, voiceModeEnabled, voiceSyncAnchorTimestamp]);
  const voiceSeedUserText = useMemo(() => {
    const safeMessages = Array.isArray(voiceContextMessages) ? voiceContextMessages : [];
    const latestUserEntry = [...safeMessages]
      .reverse()
      .find((message) => message?.role !== "assistant" && message?.role !== "system" && Boolean(String(message?.content ?? "").trim()));

    return String(latestUserEntry?.content ?? voiceLastSubmittedPrompt ?? "").trim();
  }, [voiceContextMessages, voiceLastSubmittedPrompt]);
  const voiceSeedAssistantText = useMemo(() => {
    const safeMessages = Array.isArray(voiceContextMessages) ? voiceContextMessages : [];
    const latestAssistantEntry = [...safeMessages]
      .reverse()
      .find((message) => message?.role === "assistant" && Boolean(String(message?.content ?? "").trim()));

    return formatAssistantResponseForVoice(latestAssistantEntry?.content) || String(latestAssistantEntry?.content ?? "").trim();
  }, [voiceContextMessages]);

  const recentVoiceContextSummary = useMemo(() => {
    const safeMessages = Array.isArray(voiceContextMessages) ? voiceContextMessages : [];
    const normalizedEntries = safeMessages
      .map((message) => {
        if (!message) {
          return null;
        }

        const content = String(message.content ?? "").trim();

        if (!content) {
          return null;
        }

        const role =
          message.kind === "handoff_summary"
            ? "handoff"
            : message.role === "assistant"
              ? "assistant"
              : message.role === "system"
                ? "system"
                : "user";

        return `${role}: ${content.replace(/\s+/g, " ").slice(0, 280)}`;
      })
      .filter(Boolean);

    const latestVoicePromptEntry = String(voiceLastSubmittedPrompt ?? "").trim();

    if (latestVoicePromptEntry) {
      const normalizedPromptEntry = `user: ${latestVoicePromptEntry}`;

      if (normalizedEntries[normalizedEntries.length - 1] !== normalizedPromptEntry) {
        normalizedEntries.push(normalizedPromptEntry);
      }
    }

    if (normalizedEntries.length === 0) {
      return "";
    }

    return normalizedEntries.slice(-8).join("\n");
  }, [voiceContextMessages, voiceLastSubmittedPrompt]);
  const voiceFileContextSummary = useMemo(() => {
    const safeMessages = Array.isArray(voiceContextMessages) ? voiceContextMessages : [];
    const attachments = [
      ...voiceContextIssues.flatMap((issue) => normalizeMessageAttachments(issue?.attachments)),
      ...safeMessages.flatMap((message) => normalizeMessageAttachments(message?.attachments))
    ];

    return formatFileContextSummaryForVoice(attachments);
  }, [voiceContextIssues, voiceContextMessages]);
  const voiceThreadContinuitySummary = useMemo(() => {
    const summaryParts = [];
    const continuityStatus = String(voiceContextThread?.continuity_status ?? "").trim();
    const rootThreadId = String(voiceContextThread?.root_thread_id ?? voiceContextThread?.id ?? "").trim();
    const activePhysicalThreadId = String(voiceContextThread?.active_physical_thread_id ?? "").trim();
    const lastEvent = String(voiceContextThread?.last_event ?? "").trim();
    const contextUsage = Number(voiceContextThread?.context_usage_percent);

    if (rootThreadId) {
      summaryParts.push(`root_thread_id=${rootThreadId}`);
    }

    if (continuityStatus) {
      summaryParts.push(`continuity_status=${continuityStatus}`);
    }

    if (activePhysicalThreadId) {
      summaryParts.push(`active_physical_thread_id=${activePhysicalThreadId}`);
    }

    if (lastEvent) {
      summaryParts.push(`last_event=${lastEvent}`);
    }

    if (Number.isFinite(contextUsage)) {
      summaryParts.push(`context_usage_percent=${contextUsage}`);
    }

    return summaryParts.join(", ");
  }, [
    voiceContextThread?.active_physical_thread_id,
    voiceContextThread?.context_usage_percent,
    voiceContextThread?.continuity_status,
    voiceContextThread?.id,
    voiceContextThread?.last_event,
    voiceContextThread?.root_thread_id
  ]);
  const voiceProgramSummary = useMemo(
    () =>
      formatProjectProgramSummaryForVoice({
        projectName: String(project?.name ?? "").trim(),
        workspacePath: String(project?.workspace_path ?? "").trim(),
        projectBaseInstructions: String(project?.base_instructions ?? "").trim(),
        projectDeveloperInstructions: String(project?.developer_instructions ?? "").trim(),
        threadTitle: String(thread?.title ?? "").trim(),
        threadStatusLabel: String(thread?.status ?? "").trim(),
        threadContinuitySummary: voiceThreadContinuitySummary,
        latestHandoffSummary: latestHandoffSummaryText,
        recentConversationSummary: recentVoiceContextSummary
      }),
    [
      latestHandoffSummaryText,
      project?.base_instructions,
      project?.developer_instructions,
      project?.name,
      project?.workspace_path,
      recentVoiceContextSummary,
      thread?.status,
      thread?.title,
      voiceThreadContinuitySummary
    ]
  );
  const voiceProjectIntakeSummary = useMemo(
    () =>
      formatProjectProgramSummaryForVoice({
        projectName: String(project?.name ?? "").trim(),
        workspacePath: String(project?.workspace_path ?? "").trim(),
        projectBaseInstructions: String(project?.base_instructions ?? "").trim(),
        projectDeveloperInstructions: String(project?.developer_instructions ?? "").trim(),
        threadTitle: "",
        threadStatusLabel: "",
        threadContinuitySummary: "",
        latestHandoffSummary: "",
        recentConversationSummary: ""
      }),
    [project?.base_instructions, project?.developer_instructions, project?.name, project?.workspace_path]
  );
  const voiceSessionThread = useMemo(() => {
    if (!voiceFollowupThreadReady) {
      return null;
    }

    return voiceFollowupThreadState?.thread ?? null;
  }, [voiceFollowupThreadReady, voiceFollowupThreadState]);
  const voiceSessionContextKey = useMemo(() => {
    const normalizedProjectId = String(project?.id ?? "").trim() || "project-unknown";
    const normalizedVoiceThreadId = String(voiceDelegatedThreadId ?? "").trim();
    return normalizedVoiceThreadId
      ? `${normalizedProjectId}:thread:${normalizedVoiceThreadId}`
      : `${normalizedProjectId}:project-intake`;
  }, [project?.id, voiceDelegatedThreadId]);
  const voiceProgressReportText = useMemo(() => {
    if (!voiceModeEnabled || !voiceFollowupThreadReady || !voicePromptSubmittedAt || voiceLinkedAssistantText) {
      return "";
    }

    const anchorTimestamp = Date.parse(voicePromptSubmittedAt);

    if (!Number.isFinite(anchorTimestamp)) {
      return "";
    }

    const recentIssue = [...voiceContextIssues]
      .filter((issue) => {
        const updatedAt = Date.parse(issue.updated_at ?? issue.created_at ?? "");
        return Number.isFinite(updatedAt) && updatedAt >= anchorTimestamp;
      })
      .sort((left, right) => Date.parse(right.updated_at ?? right.created_at ?? "") - Date.parse(left.updated_at ?? left.created_at ?? ""))[0] ?? null;

    const threadUpdatedAt = Date.parse(voiceContextThread?.updated_at ?? voiceContextThread?.created_at ?? "");
    const progressTarget =
      recentIssue ??
      (Number.isFinite(threadUpdatedAt) && threadUpdatedAt >= anchorTimestamp
        ? voiceContextThread
        : isThreadExecutionInProgress(voiceContextThread)
          ? voiceContextThread
          : null);

    if (!progressTarget && !voiceLastSubmittedPrompt) {
      return "";
    }

    const progressText = getRealtimeProgressText(progressTarget ?? voiceContextThread);
    const statusMessage = formatAssistantResponseForVoice(progressTarget?.last_message ?? "", { maxLength: 120 });

    return formatVoiceExecutionReportForVoice({
      prompt: voiceLastSubmittedPrompt,
      issueTitle: recentIssue?.title ?? "",
      progressText,
      lastMessage: statusMessage
    });
  }, [
    voiceContextIssues,
    voiceContextThread,
    voiceLastSubmittedPrompt,
    voiceLinkedAssistantText,
    voiceModeEnabled,
    voiceFollowupThreadReady,
    voicePromptSubmittedAt
  ]);
  const voiceSession = useRealtimeVoiceSession({
    enabled: voiceMode === "realtime" && voiceSessionEnabled,
    sessionContextKey: voiceSessionContextKey,
    apiRequest: voiceApiRequest,
    loginId: sessionLoginId,
    bridgeId,
    project,
    thread: voiceSessionThread,
    latestUserText: voiceSeedUserText,
    latestAssistantText: voiceSeedAssistantText,
    appServerFinalText: voiceFollowupThreadReady ? voiceLinkedAssistantText : "",
    appServerProgressText: voiceFollowupThreadReady ? voiceProgressReportText : "",
    projectWorkspacePath: String(project?.workspace_path ?? "").trim(),
    projectBaseInstructions: String(project?.base_instructions ?? "").trim(),
    projectDeveloperInstructions: String(project?.developer_instructions ?? "").trim(),
    threadDeveloperInstructions: voiceFollowupThreadReady ? String(voiceContextThread?.developer_instructions ?? "").trim() : "",
    threadContinuitySummary: voiceFollowupThreadReady ? voiceThreadContinuitySummary : "",
    latestHandoffSummary: voiceFollowupThreadReady ? latestHandoffSummaryText : "",
    recentConversationSummary: voiceFollowupThreadReady ? recentVoiceContextSummary : "",
    projectProgramSummary: voiceFollowupThreadReady ? voiceProgramSummary : voiceProjectIntakeSummary,
    threadFileContextSummary: voiceFollowupThreadReady ? voiceFileContextSummary : "",
    onSubmitPrompt: handleVoicePromptSubmit,
    onAvailabilityChange: handleRealtimeAvailabilityChange
  });
  const fallbackVoiceSession = useFallbackVoiceSession({
    active: voiceMode === "tts" || voiceSttOnlyMode,
    ttsEnabled: voiceMode === "tts",
    apiRequest: voiceApiRequest,
    loginId: sessionLoginId,
    bridgeId,
    latestAssistantText: voiceSeedAssistantText,
    appServerFinalText: voiceFollowupThreadReady ? voiceLinkedAssistantText : "",
    appServerProgressText: voiceFollowupThreadReady ? voiceProgressReportText : "",
    onSubmitPrompt: handleVoicePromptSubmit,
    onDraftTranscript: handleFallbackDraftTranscript,
    onTtsAvailabilityChange: handleTtsAvailabilityChange
  });
  const activeVoiceSession = voiceMode === "tts" ? fallbackVoiceSession : voiceSession;
  const voicePanelAssistantText =
    activeVoiceSession.latestAssistantSubtitle ||
    activeVoiceSession.latestAssistantTranscript ||
    (voiceFollowupThreadReady ? voiceProgressReportText || voiceLinkedAssistantText : "");
  const stopAllVoiceSessions = useCallback(async () => {
    await Promise.allSettled([
      voiceSession.stopSession({ preserveTranscript: true }),
      fallbackVoiceSession.stopSession({ preserveTranscript: true })
    ]);
  }, [fallbackVoiceSession, voiceSession]);
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
  const visibleContentSignature = useMemo(() => {
    if (messageFilter === "runs") {
      return runTimeline.map((entry) => `${entry.id}:${entry.timestamp ?? ""}`).join("|");
    }

    if (viewMode === "chat") {
      return visibleChatTimelineSignature;
    }

    if (messageFilter === "prompts") {
      return promptTimeline.map((entry) => `${entry.id}:${entry.promptAt ?? ""}`).join("|");
    }

    if (messageFilter === "responses") {
      return responseTimeline.map((entry) => `${entry.id}:${entry.timestamp ?? ""}`).join("|");
    }

    return conversationTimeline.map((entry) => `${entry.id}:${entry.promptAt ?? ""}:${entry.responses.length}`).join("|");
  }, [
    conversationTimeline,
    messageFilter,
    promptTimeline,
    responseTimeline,
    runTimeline,
    viewMode,
    visibleChatTimelineSignature
  ]);

  const syncPinnedToLatestState = useCallback((shouldPin) => {
    if (shouldPin !== pinnedToLatestRef.current) {
      pinnedToLatestRef.current = shouldPin;
      setIsPinnedToLatest(shouldPin);
    }
  }, []);

  const requestOlderMessages = useCallback(() => {
    if (!onLoadOlderMessages) {
      return;
    }

    const scrollNode = scrollRef.current;
    const restoreSnapshot = scrollNode ? captureScrollAnchorSnapshot(scrollNode) : null;

    historyScrollRestoreRef.current = restoreSnapshot;

    Promise.resolve(onLoadOlderMessages())
      .then((didStart) => {
        if (didStart === false && historyScrollRestoreRef.current === restoreSnapshot) {
          historyScrollRestoreRef.current = null;
        }
      })
      .catch(() => {
        if (historyScrollRestoreRef.current === restoreSnapshot) {
          historyScrollRestoreRef.current = null;
        }
      });
  }, [onLoadOlderMessages]);

  const maybeLoadOlderMessages = useCallback(() => {
    if (
      !onLoadOlderMessages ||
      historyLoading ||
      !hasOlderMessages ||
      messagesLoading ||
      Boolean(messagesError) ||
      messageFilter === "runs"
    ) {
      return;
    }

    const scrollNode = scrollRef.current;

    if (!scrollNode || scrollNode.scrollTop > THREAD_HISTORY_PRELOAD_SCROLL_TOP_PX) {
      return;
    }

    requestOlderMessages();
  }, [hasOlderMessages, historyLoading, messageFilter, messagesError, messagesLoading, onLoadOlderMessages, requestOlderMessages]);

  const recomputeScrollUiState = useCallback((options = {}) => {
    const { nextPinnedToLatest = null } = options;
    const scrollNode = scrollRef.current;

    if (!scrollNode) {
      syncPinnedToLatestState(false);
      setShowJumpToLatestButton(false);
      return;
    }

    const distanceFromBottom = getDistanceFromBottom(scrollNode);
    const shouldPin =
      typeof nextPinnedToLatest === "boolean" ? nextPinnedToLatest : distanceFromBottom <= CHAT_AUTO_SCROLL_THRESHOLD_PX;
    const shouldShowJumpButton = distanceFromBottom >= CHAT_JUMP_TO_LATEST_BUTTON_THRESHOLD_PX;

    syncPinnedToLatestState(shouldPin);
    setShowJumpToLatestButton((current) => (current === shouldShowJumpButton ? current : shouldShowJumpButton));
  }, [syncPinnedToLatestState]);

  const alignScrollToLatest = useCallback((options = {}) => {
    const { updatePreviousScrollTop = false } = options;
    const containerNode = scrollRef.current;
    const anchorNode = scrollAnchorRef.current;

    if (!containerNode && !anchorNode) {
      return false;
    }

    if (containerNode) {
      containerNode.scrollTop = containerNode.scrollHeight;
    }

    if (anchorNode) {
      anchorNode.scrollIntoView({ block: "end", inline: "nearest" });
    } else if (containerNode) {
      containerNode.scrollTop = containerNode.scrollHeight;
    }

    const nextContainerNode = scrollRef.current ?? containerNode;

    if (updatePreviousScrollTop && nextContainerNode) {
      previousScrollTopRef.current = Math.max(0, nextContainerNode.scrollTop);
    }

    return true;
  }, []);

  const lockHeaderMenusForViewportShift = useCallback(() => {
    headerMenuViewportLockUntilRef.current = Date.now() + HEADER_MENU_VIEWPORT_SETTLE_MS;

    const scrollNode = scrollRef.current;

    if (!scrollNode) {
      return;
    }

    previousScrollTopRef.current = Math.max(0, scrollNode.scrollTop);

    if (getDistanceFromBottom(scrollNode) <= CHAT_AUTO_SCROLL_THRESHOLD_PX) {
      setShowHeaderMenus(true);
    }
  }, []);

  const keepKeyboardPinnedToBottom = useCallback(() => {
    if (!alignScrollToLatest({ updatePreviousScrollTop: true })) {
      return;
    }

    autoScrollingRef.current = true;

    window.requestAnimationFrame(() => {
      alignScrollToLatest({ updatePreviousScrollTop: true });
      autoScrollingRef.current = false;
      recomputeScrollUiState();
    });
  }, [alignScrollToLatest, recomputeScrollUiState]);

  useEffect(() => {
    syncPinnedToLatestState(true);
    setShowJumpToLatestButton(false);
    autoScrollingRef.current = false;
    historyScrollRestoreRef.current = null;
    keyboardPinnedToBottomRef.current = false;
    previousScrollTopRef.current = 0;
    setShowHeaderMenus(true);
    recomputeScrollUiState();
  }, [recomputeScrollUiState, syncPinnedToLatestState, thread?.id, viewMode]);

  useEffect(() => {
    if (viewMode !== "chat" || typeof window === "undefined") {
      return undefined;
    }

    const viewport = window.visualViewport;
    const handleViewportShift = () => {
      lockHeaderMenusForViewportShift();
    };

    if (!viewport) {
      window.addEventListener("resize", handleViewportShift);

      return () => {
        window.removeEventListener("resize", handleViewportShift);
      };
    }

    viewport.addEventListener("resize", handleViewportShift);
    viewport.addEventListener("scroll", handleViewportShift);
    window.addEventListener("resize", handleViewportShift);

    return () => {
      viewport.removeEventListener("resize", handleViewportShift);
      viewport.removeEventListener("scroll", handleViewportShift);
      window.removeEventListener("resize", handleViewportShift);
    };
  }, [lockHeaderMenusForViewportShift, viewMode]);

  useEffect(() => {
    if (viewMode !== "chat" || typeof window === "undefined") {
      return undefined;
    }

    const viewport = window.visualViewport;
    const handleKeyboardViewportChange = () => {
      if (!keyboardPinnedToBottomRef.current) {
        return;
      }

      const activeElement = document.activeElement;

      if (!footerRef.current?.contains(activeElement) || !isTextInputElement(activeElement)) {
        keyboardPinnedToBottomRef.current = false;
        return;
      }

      keepKeyboardPinnedToBottom();
      lockHeaderMenusForViewportShift();
    };

    if (!viewport) {
      window.addEventListener("resize", handleKeyboardViewportChange);

      return () => {
        window.removeEventListener("resize", handleKeyboardViewportChange);
      };
    }

    viewport.addEventListener("resize", handleKeyboardViewportChange);
    viewport.addEventListener("scroll", handleKeyboardViewportChange);
    window.addEventListener("resize", handleKeyboardViewportChange);

    return () => {
      viewport.removeEventListener("resize", handleKeyboardViewportChange);
      viewport.removeEventListener("scroll", handleKeyboardViewportChange);
      window.removeEventListener("resize", handleKeyboardViewportChange);
    };
  }, [keepKeyboardPinnedToBottom, lockHeaderMenusForViewportShift, viewMode]);

  useEffect(() => {
    if (viewMode !== "chat") {
      return;
    }

    const scrollNode = scrollRef.current;

    if (!scrollNode) {
      return;
    }

    let rafId = null;

    const handleScroll = () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }

      rafId = window.requestAnimationFrame(() => {
        const node = scrollRef.current;
        let nextPinnedToLatest = pinnedToLatestRef.current;

        if (node && !autoScrollingRef.current) {
          const nextScrollTop = Math.max(0, node.scrollTop);
          const delta = nextScrollTop - previousScrollTopRef.current;
          const distanceFromBottom = getDistanceFromBottom(node);
          const isHeaderMenuViewportLocked = headerMenuViewportLockUntilRef.current > Date.now();
          const shouldGuardHeaderVisibility =
            distanceFromBottom <= CHAT_AUTO_SCROLL_THRESHOLD_PX ||
            isBottomBoundaryMomentumLocked(node) ||
            isHeaderMenuViewportLocked;

          if (delta <= -CHAT_MANUAL_SCROLL_UNPIN_DELTA_PX) {
            nextPinnedToLatest = false;
            keyboardPinnedToBottomRef.current = false;
          } else if (distanceFromBottom <= CHAT_AUTO_SCROLL_THRESHOLD_PX) {
            nextPinnedToLatest = true;
          }

          if (nextScrollTop <= 8) {
            setShowHeaderMenus(true);
          } else if (shouldGuardHeaderVisibility) {
            setShowHeaderMenus(true);
            previousScrollTopRef.current = nextScrollTop;
            recomputeScrollUiState({ nextPinnedToLatest });
            return;
          } else if (delta >= HEADER_MENU_SCROLL_DELTA_PX) {
            setShowHeaderMenus(false);
          } else if (delta <= -HEADER_MENU_SCROLL_DELTA_PX) {
            setShowHeaderMenus(true);
          }

          previousScrollTopRef.current = nextScrollTop;
        }

        recomputeScrollUiState({ nextPinnedToLatest });
        maybeLoadOlderMessages();
      });
    };

    recomputeScrollUiState();
    scrollNode.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      scrollNode.removeEventListener("scroll", handleScroll);

      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [maybeLoadOlderMessages, recomputeScrollUiState, viewMode]);

  useLayoutEffect(() => {
    const restoreTarget = historyScrollRestoreRef.current;
    const scrollNode = scrollRef.current;

    if (!restoreTarget || !scrollNode || historyLoading) {
      return;
    }

    if (restoreScrollAnchorSnapshot(scrollNode, restoreTarget)) {
      autoScrollingRef.current = true;
      previousScrollTopRef.current = scrollNode.scrollTop;

      window.requestAnimationFrame(() => {
        autoScrollingRef.current = false;
        recomputeScrollUiState();
      });
    }

    historyScrollRestoreRef.current = null;
  }, [historyLoading, recomputeScrollUiState, visibleContentSignature]);

  useLayoutEffect(() => {
    if (viewMode !== "chat" || !isPinnedToLatest || historyLoading || historyScrollRestoreRef.current) {
      return;
    }

    autoScrollingRef.current = true;
    alignScrollToLatest({ updatePreviousScrollTop: true });

    const frame = window.requestAnimationFrame(() => {
      alignScrollToLatest({ updatePreviousScrollTop: true });
      autoScrollingRef.current = false;
      recomputeScrollUiState();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    alignScrollToLatest,
    historyLoading,
    isPinnedToLatest,
    recomputeScrollUiState,
    thread?.id,
    viewMode,
    visibleChatTimelineSignature
  ]);

  useLayoutEffect(() => {
    if (viewMode !== "chat" || historyLoading || typeof ResizeObserver === "undefined") {
      return undefined;
    }

    const contentNode = scrollContentRef.current;

    if (!contentNode) {
      return undefined;
    }

    let frameId = 0;
    const handleContentResize = () => {
      if (historyScrollRestoreRef.current) {
        return;
      }

      if (!pinnedToLatestRef.current && !keyboardPinnedToBottomRef.current) {
        return;
      }

      autoScrollingRef.current = true;
      alignScrollToLatest({ updatePreviousScrollTop: true });

      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }

      frameId = window.requestAnimationFrame(() => {
        alignScrollToLatest({ updatePreviousScrollTop: true });
        autoScrollingRef.current = false;
        recomputeScrollUiState();
      });
    };

    const observer = new ResizeObserver(handleContentResize);
    observer.observe(contentNode);

    return () => {
      observer.disconnect();

      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [alignScrollToLatest, historyLoading, recomputeScrollUiState, viewMode]);

  const handleJumpToLatest = useCallback(() => {
    if (!alignScrollToLatest({ updatePreviousScrollTop: true })) {
      return;
    }

    syncPinnedToLatestState(true);
    autoScrollingRef.current = true;

    window.requestAnimationFrame(() => {
      alignScrollToLatest({ updatePreviousScrollTop: true });
      autoScrollingRef.current = false;
      recomputeScrollUiState();
    });
  }, [alignScrollToLatest, recomputeScrollUiState, syncPinnedToLatestState]);

  const handleComposerFocus = useCallback(() => {
    const scrollNode = scrollRef.current;

    if (!scrollNode) {
      keyboardPinnedToBottomRef.current = false;
      return;
    }

    const shouldStickBottom = getDistanceFromBottom(scrollNode) <= CHAT_AUTO_SCROLL_THRESHOLD_PX;
    keyboardPinnedToBottomRef.current = shouldStickBottom;

    if (!shouldStickBottom) {
      return;
    }

    syncPinnedToLatestState(true);
    setShowJumpToLatestButton(false);
    keepKeyboardPinnedToBottom();
    lockHeaderMenusForViewportShift();
    window.setTimeout(() => {
      if (keyboardPinnedToBottomRef.current) {
        keepKeyboardPinnedToBottom();
      }
    }, 120);
  }, [keepKeyboardPinnedToBottom, lockHeaderMenusForViewportShift, syncPinnedToLatestState]);

  const handleComposerBlur = useCallback(() => {
    window.setTimeout(() => {
      const activeElement = typeof document !== "undefined" ? document.activeElement : null;

      if (!footerRef.current?.contains(activeElement)) {
        keyboardPinnedToBottomRef.current = false;
      }
    }, 0);
  }, []);

  const handleRefreshMessages = async () => {
    if (!onRefreshMessages || refreshPending) {
      return;
    }

    setRefreshPending(true);

    try {
      await onRefreshMessages();
    } finally {
      setRefreshPending(false);
    }
  };

  const handleDeleteIssue = async (issueId) => {
    if (!issueId || !onDeleteIssue || deletingIssueId) {
      return false;
    }

    setDeletingIssueId(issueId);

    try {
      const accepted = await onDeleteIssue(issueId);
      return accepted !== false;
    } finally {
      setDeletingIssueId((current) => (current === issueId ? "" : current));
    }
  };

  const handleRetryIssue = async (issueId) => {
    if (!issueId || !onRetryIssue || retryingIssueId) {
      return false;
    }

    setRetryingIssueId(issueId);

    try {
      const accepted = await onRetryIssue(issueId);
      return accepted !== false;
    } finally {
      setRetryingIssueId((current) => (current === issueId ? "" : current));
    }
  };

  const handleInterruptIssue = async (issueId, options = {}) => {
    if (!issueId || !onInterruptIssue || interruptingIssueId) {
      return false;
    }

    setInterruptingIssueId(issueId);

    try {
      const accepted = await onInterruptIssue(issueId, options);
      return accepted !== false;
    } finally {
      setInterruptingIssueId((current) => (current === issueId ? "" : current));
    }
  };

  const handleStopCurrentExecution = useCallback(async () => {
    if (!interruptibleIssue?.id || !onStopThreadExecution || interruptingIssueId) {
      return false;
    }

    setInterruptingIssueId(interruptibleIssue.id);

    try {
      const accepted = await onStopThreadExecution({ reason: "mobile_stop_button" });
      return accepted !== false;
    } finally {
      setInterruptingIssueId((current) => (current === interruptibleIssue.id ? "" : current));
    }
  }, [interruptibleIssue?.id, interruptingIssueId, onStopThreadExecution]);

  const canDeleteIssueFromBubble = useCallback(
    (issueId) => {
      if (!issueId || !activePhysicalThreadId) {
        return false;
      }

      const issue = issueById.get(issueId);

      if (!issue || ["running", "awaiting_input"].includes(issue.status)) {
        return false;
      }

      const issuePhysicalThreadId = issue.executed_physical_thread_id ?? issue.created_physical_thread_id ?? null;

      return issuePhysicalThreadId === activePhysicalThreadId;
    },
    [activePhysicalThreadId, issueById]
  );

  const canRetryIssueFromBubble = useCallback(
    (issueId) => {
      if (!issueId) {
        return false;
      }

      const issue = issueById.get(issueId);
      return Boolean(issue && isRetryableIssueStatus(issue.status));
    },
    [issueById]
  );

  const handleCopyMessage = useCallback(async (content) => {
    try {
      await copyTextToClipboard(content);
      showAlert("텍스트를 복사했습니다.", {
        title: "복사 완료"
      });

      return true;
    } catch (error) {
      showAlert(error.message ?? "텍스트를 복사하지 못했습니다.", {
        tone: "error",
        title: "복사 실패"
      });

      return false;
    }
  }, [showAlert]);

  const handleToggleVoiceMode = useCallback(async () => {
    if (voiceModeEnabled || voiceSttOnlyMode) {
      resetVoiceState();
      await stopAllVoiceSessions();
      return;
    }

    if (!voiceSessionEnabled) {
      showAlert("이 환경에서는 실시간 음성 모드가 비활성화되어 있습니다.", {
        tone: "error",
        title: "음성 모드"
      });
      return;
    }

    if (!project?.id || !sessionLoginId || !bridgeId) {
      showAlert("음성 모드는 현재 프로젝트 문맥이 있을 때만 시작할 수 있습니다.", {
        tone: "error",
        title: "음성 모드"
      });
      return;
    }

    const capabilitySnapshot = readVoiceCapabilitySnapshot();
    syncVoiceCapabilityToState(capabilitySnapshot, {
      lastError: capabilitySnapshot.realtimeError || capabilitySnapshot.ttsError || ""
    });

    if (capabilitySnapshot.realtime === VOICE_CAPABILITY_STATUS_BLOCKED) {
      await activateTtsOrSttMode({
        capabilitySnapshot,
        errorMessage: capabilitySnapshot.realtimeError,
        announce: true
      });
      return;
    }

    updateVoiceState((current) => ({
      ...current,
      enabled: true,
      mode: "realtime",
      promptSubmittedAt: "",
      lastSubmittedPrompt: "",
      delegatedThreadId: "",
      capabilityDateKey: capabilitySnapshot.dateKey,
      realtimeStatus: capabilitySnapshot.realtime,
      ttsStatus: capabilitySnapshot.tts,
      lastError: capabilitySnapshot.realtime === VOICE_CAPABILITY_STATUS_AVAILABLE ? "" : current.lastError
    }));
  }, [
    activateTtsOrSttMode,
    bridgeId,
    project?.id,
    readVoiceCapabilitySnapshot,
    resetVoiceState,
    sessionLoginId,
    showAlert,
    stopAllVoiceSessions,
    syncVoiceCapabilityToState,
    updateVoiceState,
    voiceModeEnabled,
    voiceSessionEnabled,
    voiceSttOnlyMode
  ]);

  useEffect(() => {
    setActiveMessageAction(null);
    setInterruptingIssueId("");
    setRetryingIssueId("");
    setDeletingIssueId("");
  }, [thread?.id]);

  useEffect(() => {
    if (voiceModeEnabled || !voicePromptSubmittedAt) {
      return;
    }

    resetVoiceState();
  }, [resetVoiceState, voiceModeEnabled, voicePromptSubmittedAt]);

  const canRefresh = Boolean(thread?.id && onRefreshMessages);
  const rootStyle = standalone ? { height: "calc(var(--app-stable-viewport-height) - var(--app-safe-area-top))" } : undefined;
  const rootClassName = standalone
    ? "flex min-h-0 flex-col overflow-hidden"
    : "flex h-full min-h-0 flex-col overflow-hidden";
  const contentWidthClassName = standalone ? "max-w-3xl" : "max-w-none";
  const showHeaderFilterArea = showHeaderMenus && !voiceModeEnabled;
  const showEmptyState = (() => {
    if (messagesLoading || messagesError) {
      return false;
    }

    if (messageFilter === "runs") {
      return runTimeline.length === 0;
    }

    if (viewMode === "chat") {
      return visibleChatTimeline.length === 0;
    }

    if (messageFilter === "prompts") {
      return promptTimeline.length === 0;
    }

    if (messageFilter === "responses") {
      return responseTimeline.length === 0;
    }

    return conversationTimeline.length === 0;
  })();
  return (
    <div className={rootClassName} style={rootStyle} data-testid="thread-detail-panel">
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
            <p className="truncate text-sm font-semibold text-white">{threadTitle}</p>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-400">
              <span className="truncate">{project?.name ?? "프로젝트 미지정"}</span>
              {status ? (
                <span
                  className={`h-1.5 w-1.5 rounded-full ${responseSignal ? "" : status.dotClassName}`}
                  style={responseSignal ? { backgroundColor: responseSignal.dotColor } : undefined}
                />
              ) : null}
              <span>{status ? status.label : "새 채팅창"}</span>
              {contextUsage?.percent != null ? (
                <>
                  <span className="h-1.5 w-1.5 rounded-full bg-white/20" />
                  <span>{formatThreadContextUsage(thread)}</span>
                </>
              ) : null}
            </div>
          </div>

          <button
            type="button"
            onClick={() => void handleRefreshMessages()}
            disabled={messagesLoading || refreshPending || !canRefresh}
            aria-label="마지막 이슈 락 해제 및 새로고침"
            title="마지막 이슈 락을 해제하고 현재 채팅창 상태를 다시 불러옵니다."
            className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {messagesLoading || refreshPending ? (
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            ) : (
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  d="M4 4v5h.582m15.418 11v-5h-.581M5.007 9a7 7 0 0111.995-3m2.998 9a7 7 0 01-11.995 3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                />
              </svg>
            )}
          </button>
        </div>

        <div
          data-testid="thread-detail-header-filters"
          className={`overflow-hidden transition-all duration-200 ease-out ${
            showHeaderFilterArea ? "mt-3 max-h-32 opacity-100" : "max-h-0 opacity-0"
          }`}
          aria-hidden={!showHeaderFilterArea}
        >
          <div className="flex gap-2 overflow-x-auto pb-1">
            {THREAD_CONTENT_FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                onClick={() => onChangeMessageFilter(filter.id)}
                className={`shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium transition ${
                  messageFilter === filter.id
                    ? "bg-white text-slate-900"
                    : "bg-transparent text-slate-400 hover:text-white"
                }`}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        {voicePanelOpen ? (
          <div className="h-full">
            <div className="h-full w-full">
              <VoiceModePanel
                open={voicePanelOpen}
                mode={voiceMode}
                latestUserText={activeVoiceSession.latestUserTranscript}
                latestAssistantText={voicePanelAssistantText}
                connectionState={activeVoiceSession.connectionState}
                micState={activeVoiceSession.micState}
                isListening={activeVoiceSession.isListening}
                isResponding={activeVoiceSession.isResponding}
                audioMetricsRef={activeVoiceSession.audioMetricsRef}
                audioMetricsStore={activeVoiceSession.audioMetricsStore}
                inputDevices={activeVoiceSession.inputDevices}
                selectedInputDeviceId={activeVoiceSession.selectedInputDeviceId}
                errorMessage={activeVoiceSession.error || voiceLastError}
                onSelectInputDevice={(deviceId) => void activeVoiceSession.selectInputDevice?.(deviceId)}
                onClose={() => {
                  resetVoiceState();
                  void stopAllVoiceSessions();
                }}
              />
            </div>
          </div>
        ) : (
          <div
            ref={scrollRef}
            data-testid="thread-detail-scroll"
            className="telegram-grid touch-scroll-boundary-lock min-h-0 h-full overflow-y-auto px-4 pb-5 pt-5"
          >
            <div ref={scrollContentRef} className={`mx-auto flex w-full ${contentWidthClassName} flex-col gap-4 pb-4`}>
          {historyLoading || historyError || hasOlderMessages ? (
            <div className="flex justify-center">
              <div className="rounded-full border border-white/10 bg-slate-950/80 px-3 py-1.5 text-[11px] text-slate-300">
                {historyLoading
                  ? "이전 히스토리를 불러오는 중..."
                  : historyError
                    ? (
                        <>
                          <span>{historyError}</span>
                          {onLoadOlderMessages ? (
                            <button
                              type="button"
                              onClick={requestOlderMessages}
                              className="ml-2 rounded-full border border-white/15 px-2 py-0.5 text-[10px] text-white transition hover:bg-white/10"
                            >
                              다시 시도
                            </button>
                          ) : null}
                        </>
                      )
                    : remainingHistoryCount > 0
                      ? `이전 히스토리 ${remainingHistoryCount}개가 더 있습니다. 위로 올리면 미리 불러옵니다.`
                      : "이전 히스토리를 더 불러올 수 있습니다."}
              </div>
            </div>
          ) : null}

          <div className="flex justify-center">
            <span className="rounded-full bg-slate-950/70 px-3 py-1.5 text-[11px] text-slate-300">
              {formatDateTime(threadTimestamp)}
            </span>
          </div>

          {messagesError ? (
            <div className="rounded-2xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
              <p>메시지를 불러오는 중 문제가 발생했습니다.</p>
              <button
                type="button"
                onClick={handleRefreshMessages}
                className="mt-2 rounded-full border border-white/20 px-3 py-1.5 text-xs text-white/80 transition hover:bg-white/10"
              >
                다시 시도
              </button>
            </div>
          ) : null}

          {messageFilter === "runs" ? (
            <RunTimeline entries={runTimeline} formatRelativeTime={formatRelativeTime} />
          ) : viewMode === "chat" ? (
            visibleChatTimeline.map((message) => {
              const canCopy = Boolean(String(message.content ?? "").trim());
              const canDelete = canDeleteIssueFromBubble(message.issueId);
              const canRetry = canRetryIssueFromBubble(message.issueId);
              const canOpenActionSheet = canCopy || canDelete || canRetry;

              return (
                <div key={message.id} data-scroll-anchor-id={`chat:${message.id}`}>
                  <MessageBubble
                    align={message.align}
                    tone={message.tone}
                    title={message.title}
                    meta={formatRelativeTime(message.timestamp)}
                    onLongPress={
                      canOpenActionSheet
                        ? () =>
                            setActiveMessageAction({
                              id: message.id,
                              title: message.title,
                              content: message.content ?? "",
                              meta: formatRelativeTime(message.timestamp),
                              issueId: message.issueId,
                              canCopy,
                              canRetry,
                              canDelete
                            })
                        : null
                    }
                    longPressTitle={canOpenActionSheet ? "길게 눌러 메시지 작업 열기" : ""}
                  >
                    {message.replyTo ? (
                      <div className="mb-2 border-l-2 border-slate-300/45 pl-3 text-xs text-slate-700/80">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-600/70">프롬프트</p>
                        <p className="mt-1 break-words [overflow-wrap:anywhere] text-sm leading-5">
                          {summarizeMessageContent(message.replyTo.content)}
                        </p>
                      </div>
                    ) : null}
                    <RichMessageContent
                      content={
                        message.content || (message.role === "assistant" ? "응답을 기다리고 있습니다..." : "프롬프트가 비어 있습니다.")
                      }
                      tone={message.tone}
                    />
                    <MessageAttachmentPreview
                      attachments={message.attachments}
                      bubbleTone={message.tone}
                      onOpenAttachment={handleOpenAttachment}
                      normalizeAttachments={normalizeMessageAttachments}
                      resolveBadge={resolveMessageAttachmentBadge}
                      formatSize={formatMessageAttachmentSize}
                    />
                  </MessageBubble>
                </div>
              );
            })
          ) : messageFilter === "prompts" ? (
            <ConversationTimeline
              entries={promptTimeline}
              formatDateTime={formatDateTime}
              formatRelativeTime={formatRelativeTime}
            />
          ) : messageFilter === "responses" ? (
            <ul className="space-y-3">
              {responseTimeline.map((response) => (
                <li key={response.id} data-scroll-anchor-id={`response:${response.id}`} className="border-b border-white/8 px-1 pb-3">
                  <div className="flex items-center justify-between gap-3 text-[11px] text-slate-500">
                    <span>응답</span>
                    <span>{formatRelativeTime(response.timestamp)}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm leading-6 text-slate-200">
                    {response.content || "응답이 비어 있습니다."}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <ConversationTimeline
              entries={conversationTimeline}
              formatDateTime={formatDateTime}
              formatRelativeTime={formatRelativeTime}
            />
          )}

          {messagesLoading ? (
            <div className="flex justify-center py-4">
              <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-white" />
            </div>
          ) : null}

          {showEmptyState && emptyStateMessage ? (
            <div className="rounded-2xl border border-dashed border-white/15 px-4 py-4 text-center text-sm text-slate-300">
              {emptyStateMessage}
            </div>
          ) : null}

          {showEmptyState && !emptyStateMessage ? (
            <div className="rounded-2xl border border-dashed border-white/15 px-4 py-4 text-center text-sm text-slate-300">
              {messageFilter === "runs"
                ? "표시할 실행 기록이 없습니다."
                : viewMode === "chat"
                  ? isDraft
                    ? "첫 프롬프트를 입력해 작업을 시작해 주세요."
                    : "아직 대화가 없습니다. 첫 프롬프트를 입력해 작업을 시작해 보세요."
                  : messageFilter === "responses"
                    ? "표시할 응답이 없습니다."
                    : messageFilter === "prompts"
                      ? "표시할 프롬프트가 없습니다."
                      : "타임라인으로 정리할 대화가 없습니다. 새 프롬프트를 입력해 히스토리를 만들어 보세요."}
            </div>
          ) : null}

          {status ? (
            <div className="flex justify-center">
              <div
                className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] ${
                  responseSignal ? "" : "border-white/10 bg-slate-950/70 text-slate-300"
                }`}
                style={responseSignal?.chipStyle}
                title={responseSignal?.title}
              >
                <span
                  className={`h-2 w-2 rounded-full ${responseSignal ? "" : status.dotClassName}`}
                  style={responseSignal ? { backgroundColor: responseSignal.dotColor } : undefined}
                />
                <span>{status.label}</span>
                <span className="text-slate-500">{formatRelativeTime(thread.updated_at)}</span>
              </div>
            </div>
          ) : null}
          {thread ? (
            <div className="flex justify-center">
              <div className="flex flex-wrap items-center justify-center gap-2">
                <div className="rounded-full border border-white/8 bg-white/5 px-3 py-1 text-[11px] text-slate-300">
                  {getRealtimeProgressText(thread)}
                </div>
                {contextUsage?.percent != null ? (
                  <div className="rounded-full border border-white/8 bg-white/5 px-3 py-1 text-[11px] text-slate-300">
                    {formatThreadContextUsage(thread)}
                    {contextUsage?.usedTokens !== null && contextUsage?.windowTokens !== null
                      ? ` · ${contextUsage.usedTokens.toLocaleString("ko-KR")} / ${contextUsage.windowTokens.toLocaleString("ko-KR")}`
                      : ""}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
            <div ref={scrollAnchorRef} />
          </div>
          </div>
        )}

        {!voiceModeEnabled && showJumpToLatestButton ? (
          <div className="pointer-events-none absolute bottom-4 right-4 z-10">
            <button
              type="button"
              onClick={handleJumpToLatest}
              aria-label="대화 맨 아래로 이동"
              title="대화 맨 아래로 이동"
              className="pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full border border-sky-400/40 bg-slate-950/90 text-sky-200 shadow-[0_16px_40px_rgba(15,23,42,0.45)] backdrop-blur transition hover:border-sky-300/60 hover:bg-slate-900"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M7 10l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" />
              </svg>
            </button>
          </div>
        ) : null}
      </div>

      <ThreadMessageActionSheet
        open={Boolean(activeMessageAction)}
        message={activeMessageAction}
        busy={
          Boolean(
            activeMessageAction?.issueId &&
              (
                interruptingIssueId === activeMessageAction.issueId ||
                retryingIssueId === activeMessageAction.issueId ||
                deletingIssueId === activeMessageAction.issueId
              )
          )
        }
        onClose={() => {
          if (!interruptingIssueId && !retryingIssueId && !deletingIssueId) {
            setActiveMessageAction(null);
          }
        }}
        onCopy={
          activeMessageAction?.canCopy
            ? async () => {
                const copied = await handleCopyMessage(activeMessageAction.content);

                if (copied) {
                  setActiveMessageAction(null);
                }
              }
            : null
        }
        onRetry={
          activeMessageAction?.canRetry
            ? async () => {
                const retried = await handleRetryIssue(activeMessageAction.issueId);

                if (retried) {
                  setActiveMessageAction(null);
                }
              }
            : null
        }
        onDelete={
          activeMessageAction?.canDelete
            ? async () => {
                const deleted = await handleDeleteIssue(activeMessageAction.issueId);

                if (deleted !== false) {
                  setActiveMessageAction(null);
                }
              }
            : null
        }
      />

      {!voiceModeEnabled ? (
        <div
          ref={footerRef}
          data-testid="thread-detail-footer"
          className="telegram-safe-bottom-panel shrink-0 border-t border-white/10 bg-slate-950/92 px-4 pt-2 backdrop-blur"
        >
          <div className={`mx-auto w-full ${contentWidthClassName}`}>
            <InlineIssueComposer
              helpers={inlineIssueComposerHelpers}
              busy={submitBusy}
              bridgeId={bridgeId}
              selectedProject={project}
              onSubmit={onSubmitPrompt}
              onOpenVoiceMode={thread?.id ? () => void handleToggleVoiceMode() : null}
              voiceSessionEnabled={voiceSessionEnabled}
              label={isDraft ? "첫 프롬프트" : "프롬프트"}
              draftKey={composerDraftKey}
              draftValue={composerDraft}
              onDraftPersist={onPersistComposerDraft}
              disabled={isInputDisabled}
              onStop={interruptibleIssue ? handleStopCurrentExecution : null}
              stopBusy={Boolean(interruptibleIssue?.id && interruptingIssueId === interruptibleIssue.id)}
              stopLabel={interruptibleIssue?.status === "awaiting_input" ? "입력 중단" : "중단"}
              onInputFocus={handleComposerFocus}
              onInputBlur={handleComposerBlur}
              speechInputEnabled={voiceSttOnlyMode}
              speechInputSupported={fallbackVoiceSession.speechRecognitionSupported}
              speechInputListening={fallbackVoiceSession.isListening}
              speechInputBusy={fallbackVoiceSession.connectionState === "connecting" || fallbackVoiceSession.micState === "requesting"}
              speechInputHint={voiceLastError || fallbackVoiceSession.error}
              onToggleSpeechInput={() => void fallbackVoiceSession.toggleListening()}
              externalPromptInsertText={composerSpeechInsert.text}
              externalPromptInsertToken={composerSpeechInsert.token}
            />
          </div>
        </div>
      ) : null}

      <AttachmentPreviewDialog
        attachment={previewAttachment}
        sizeLabel={previewAttachment ? formatMessageAttachmentSize(previewAttachment.size_bytes) : ""}
        onClose={() => setPreviewAttachment(null)}
      />
    </div>
  );
}
