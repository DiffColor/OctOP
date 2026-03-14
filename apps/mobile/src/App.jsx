import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { PWA_UPDATE_ACTIVATOR_KEY, PWA_UPDATE_READY_EVENT } from "./pwaEvents.js";

const LOCAL_STORAGE_KEY = "octop.mobile.session";
const SESSION_STORAGE_KEY = "octop.mobile.session.ephemeral";
const LEGACY_LOCAL_STORAGE_KEY = "octop.dashboard.session";
const LEGACY_SESSION_STORAGE_KEY = "octop.dashboard.session.ephemeral";
const PWA_PROMPT_DISMISSED_KEY = "octop.mobile.pwa.install.dismissed";
const PWA_PROMPT_DISMISSED_VALUE = "manual";
const DEFAULT_API_BASE_URL =
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
    ? "http://127.0.0.1:4000"
    : "https://octop.ilycode.app";
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");

const STATUS_META = {
  queued: {
    label: "Queued",
    chipClassName: "bg-slate-500/15 text-slate-200",
    dotClassName: "bg-slate-300",
    bubbleClassName: "bg-white text-slate-900"
  },
  idle: {
    label: "Idle",
    chipClassName: "bg-slate-500/15 text-slate-200",
    dotClassName: "bg-slate-300",
    bubbleClassName: "bg-white text-slate-900"
  },
  awaiting_input: {
    label: "Need Input",
    chipClassName: "bg-amber-400/20 text-amber-100",
    dotClassName: "bg-amber-300",
    bubbleClassName: "bg-amber-100 text-slate-900"
  },
  running: {
    label: "Running",
    chipClassName: "bg-telegram-400/20 text-telegram-50",
    dotClassName: "bg-telegram-300",
    bubbleClassName: "bg-telegram-500 text-white"
  },
  failed: {
    label: "Failed",
    chipClassName: "bg-rose-400/20 text-rose-100",
    dotClassName: "bg-rose-300",
    bubbleClassName: "bg-rose-100 text-slate-900"
  },
  completed: {
    label: "Done",
    chipClassName: "bg-emerald-400/20 text-emerald-100",
    dotClassName: "bg-emerald-300",
    bubbleClassName: "bg-emerald-100 text-slate-900"
  }
};

const THREAD_CONTENT_FILTERS = [
  { id: "all", label: "all" },
  { id: "prompts", label: "prompts" },
  { id: "responses", label: "responses" },
  { id: "runs", label: "runs" }
];

const CHAT_AUTO_SCROLL_THRESHOLD_PX = 96;
const HEADER_MENU_SCROLL_DELTA_PX = 12;
const PROJECT_DELETE_CONFIRM_MESSAGE = "프로젝트를 삭제하시겠습니까? 해당 프로젝트의 이슈도 함께 제거됩니다.";
const PROJECT_CHIP_LONG_PRESS_MS = 650;

function readStoredSession() {
  for (const key of [
    LOCAL_STORAGE_KEY,
    SESSION_STORAGE_KEY,
    LEGACY_LOCAL_STORAGE_KEY,
    LEGACY_SESSION_STORAGE_KEY
  ]) {
    try {
      const raw = window.localStorage.getItem(key) ?? window.sessionStorage.getItem(key);

      if (!raw) {
        continue;
      }

      const parsed = JSON.parse(raw);

      if (parsed?.accessToken && parsed?.userId) {
        return parsed;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function storeSession(session, rememberDevice) {
  const serialized = JSON.stringify(session);

  window.localStorage.removeItem(LOCAL_STORAGE_KEY);
  window.sessionStorage.removeItem(SESSION_STORAGE_KEY);

  if (rememberDevice) {
    window.localStorage.setItem(LOCAL_STORAGE_KEY, serialized);
    return;
  }

  window.sessionStorage.setItem(SESSION_STORAGE_KEY, serialized);
}

function clearSessionStorage() {
  window.localStorage.removeItem(LOCAL_STORAGE_KEY);
  window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
}

function isPwaPromptDismissed() {
  if (typeof window === "undefined") {
    return false;
  }

  return window.localStorage.getItem(PWA_PROMPT_DISMISSED_KEY) === PWA_PROMPT_DISMISSED_VALUE;
}

function dismissPwaPrompt() {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(PWA_PROMPT_DISMISSED_KEY, PWA_PROMPT_DISMISSED_VALUE);
}

function formatDateTime(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function formatRelativeTime(value) {
  if (!value) {
    return "방금 전";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "방금 전";
  }

  const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("ko-KR", { numeric: "auto" });
  const ranges = [
    { limit: 60, unit: "second" },
    { limit: 3600, unit: "minute" },
    { limit: 86400, unit: "hour" },
    { limit: 604800, unit: "day" }
  ];

  for (const range of ranges) {
    if (Math.abs(diffSeconds) < range.limit) {
      const divisor =
        range.unit === "second" ? 1 : range.unit === "minute" ? 60 : range.unit === "hour" ? 3600 : 86400;
      return formatter.format(Math.round(diffSeconds / divisor), range.unit);
    }
  }

  return formatter.format(Math.round(diffSeconds / 604800), "week");
}

function getPathLabel(value) {
  if (!value) {
    return "";
  }

  const normalized = String(value).replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments.at(-1) ?? normalized;
}

function normalizePath(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function getDisplayPathFromStartFolder(value, depth = 2) {
  const normalized = normalizePath(value);

  if (!normalized) {
    return "";
  }

  const segments = normalized.split("/").filter(Boolean);
  return segments.slice(-depth).join("/");
}

function getRelativeWorkspacePath(value, roots = []) {
  const normalizedValue = normalizePath(value);

  if (!normalizedValue) {
    return "";
  }

  const matchingRoot = [...roots]
    .map((root) => normalizePath(root?.path))
    .filter(Boolean)
    .filter((rootPath) => normalizedValue === rootPath || normalizedValue.startsWith(`${rootPath}/`))
    .sort((left, right) => right.length - left.length)[0];

  if (!matchingRoot) {
    return getDisplayPathFromStartFolder(normalizedValue);
  }

  const relativePath = normalizedValue.slice(matchingRoot.length).replace(/^\/+/, "");
  const rootLabel = getPathLabel(matchingRoot);

  return relativePath ? `${rootLabel}/${relativePath}` : rootLabel;
}

function shortenPath(value) {
  if (!value) {
    return "-";
  }

  const normalized = String(value);

  if (normalized.length <= 46) {
    return normalized;
  }

  return `...${normalized.slice(-43)}`;
}

function clampProgress(value) {
  const numeric = Number(value);

  if (Number.isNaN(numeric)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function getStatusMeta(status) {
  return STATUS_META[status] ?? STATUS_META.queued;
}

function createId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `mobile-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getRealtimeProgressText(entity) {
  const status = entity?.status ?? "queued";
  const lastEvent = entity?.last_event ?? "";

  if (status === "awaiting_input") {
    return "입력 대기 중";
  }

  if (status === "failed") {
    return "실패 확인 필요";
  }

  if (status === "completed") {
    return "완료됨";
  }

  if (lastEvent === "turn.starting") {
    return "Codex 실행 요청 중";
  }

  if (lastEvent === "turn.started") {
    return "작업 시작됨";
  }

  if (lastEvent === "turn.plan.updated") {
    return "계획 수립 중";
  }

  if (lastEvent === "turn.diff.updated") {
    return "변경 적용 중";
  }

  if (lastEvent === "item.agentMessage.delta") {
    return "응답 생성 중";
  }

  if (lastEvent === "turn.completed") {
    return "마무리 정리 중";
  }

  if (status === "running") {
    return "실행 중";
  }

  if (status === "queued") {
    return "대기열에서 대기 중";
  }

  if (status === "idle") {
    return "다음 작업 대기 중";
  }

  return "상태 동기화 중";
}

function normalizeNullableInteger(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

function normalizeLiveTokenUsagePayload(tokenUsage = null, currentThread = null) {
  const hasTokenUsageActivity =
    Number(tokenUsage?.total?.inputTokens ?? tokenUsage?.total?.input_tokens ?? 0) > 0 ||
    Number(tokenUsage?.total?.cachedInputTokens ?? tokenUsage?.total?.cached_input_tokens ?? 0) > 0 ||
    Number(tokenUsage?.total?.outputTokens ?? tokenUsage?.total?.output_tokens ?? 0) > 0 ||
    Number(tokenUsage?.total?.reasoningOutputTokens ?? tokenUsage?.total?.reasoning_output_tokens ?? 0) > 0;
  const fallbackUsedTokens =
    Number(currentThread?.context_used_tokens) === 0 && hasTokenUsageActivity
      ? null
      : currentThread?.context_used_tokens;
  const fallbackPercent =
    Number(currentThread?.context_usage_percent) === 0 && hasTokenUsageActivity
      ? null
      : currentThread?.context_usage_percent;
  const usedTokens = normalizeNullableInteger(
    tokenUsage?.total?.totalTokens ??
      tokenUsage?.total?.total_tokens ??
      fallbackUsedTokens
  );
  const windowTokens = normalizeNullableInteger(
    tokenUsage?.modelContextWindow ??
      tokenUsage?.model_context_window ??
      currentThread?.context_window_tokens
  );
  const percent = windowTokens && usedTokens !== null
    ? normalizeNullableInteger((usedTokens / windowTokens) * 100)
    : normalizeNullableInteger(fallbackPercent);

  return {
    context_usage_percent: percent,
    context_used_tokens: usedTokens,
    context_window_tokens: windowTokens
  };
}

function getThreadContextUsage(thread) {
  if (!thread) {
    return null;
  }

  const percent = clampProgress(thread.context_usage_percent ?? thread.contextUsagePercent);
  const hasPercent =
    Number.isFinite(Number(thread.context_usage_percent)) || Number.isFinite(Number(thread.contextUsagePercent));
  const usedTokens = normalizeNullableInteger(
    thread.context_used_tokens ??
      thread.contextUsedTokens ??
      thread.token_usage?.total?.total_tokens ??
      thread.tokenUsage?.total?.totalTokens
  );
  const windowTokens = normalizeNullableInteger(
    thread.context_window_tokens ??
      thread.contextWindowTokens ??
      thread.token_usage?.model_context_window ??
      thread.tokenUsage?.modelContextWindow
  );

  if (!hasPercent && usedTokens === null && windowTokens === null) {
    return null;
  }

  return {
    percent: hasPercent ? percent : null,
    usedTokens,
    windowTokens
  };
}

function formatThreadContextUsage(thread) {
  const usage = getThreadContextUsage(thread);

  if (!usage || usage.percent === null) {
    return null;
  }

  return `사용률 ${usage.percent}%`;
}

function parseResponseBody(response, text) {
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    if (!response.ok) {
      throw new Error(text);
    }

    return { message: text };
  }
}

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {})
    }
  });
  const text = await response.text();
  const payload = parseResponseBody(response, text);

  if (!response.ok) {
    const message =
      payload?.error ??
      payload?.message ??
      payload?.title ??
      `요청에 실패했습니다. (${response.status})`;
    throw new Error(message);
  }

  return payload;
}

function normalizeThread(thread, fallbackProjectId = null) {
  if (!thread?.id) {
    return null;
  }

  const contextUsage = getThreadContextUsage(thread);

  return {
    id: thread.id,
    title: thread.title ?? thread.name ?? "제목 없는 이슈",
    project_id: thread.project_id ?? fallbackProjectId,
    status: thread.status ?? "queued",
    progress: clampProgress(thread.progress),
    last_event: thread.last_event ?? "thread.started",
    last_message: thread.last_message ?? "",
    created_at: thread.created_at ?? new Date().toISOString(),
    updated_at: thread.updated_at ?? thread.created_at ?? new Date().toISOString(),
    source: thread.source ?? "appServer",
    turn_id: thread.turn_id ?? null,
    context_usage_percent: contextUsage?.percent ?? null,
    context_used_tokens: contextUsage?.usedTokens ?? null,
    context_window_tokens: contextUsage?.windowTokens ?? null
  };
}

function normalizeLiveThreadStatus(statusType, currentStatus = "queued") {
  switch (statusType) {
    case "waitingForInput":
      return "awaiting_input";
    case "error":
      return "failed";
    case "completed":
      return "completed";
    case "idle":
      return currentStatus === "running" ? "idle" : currentStatus;
    case "active":
    case "running":
      return "running";
    default:
      return currentStatus;
  }
}

function isTerminalThreadStatus(status) {
  return ["completed", "failed"].includes(status);
}

function isLiveThreadProgressEvent(eventType) {
  return ["turn.started", "turn.starting", "turn.plan.updated", "turn.diff.updated", "item.agentMessage.delta"].includes(
    eventType ?? ""
  );
}

function getLiveEventContext(event) {
  const payload = event?.payload ?? {};
  const threadId = String(payload.thread_id ?? payload.threadId ?? "").trim();
  const issueId = String(payload.issue_id ?? payload.issueId ?? "").trim();
  const projectId = String(payload.project_id ?? payload.projectId ?? "").trim();

  return {
    payload,
    threadId,
    issueId,
    projectId
  };
}

function buildLiveThreadPatch(event, currentThread = null) {
  const { payload, threadId, projectId } = getLiveEventContext(event);

  if (!threadId) {
    return null;
  }

  if (isTerminalThreadStatus(currentThread?.status) && isLiveThreadProgressEvent(event?.type)) {
    return null;
  }

  const currentStatus = currentThread?.status ?? "queued";

  switch (event?.type) {
    case "thread.started":
      return {
        id: threadId,
        project_id: projectId || currentThread?.project_id || null,
        progress: Math.max(currentThread?.progress ?? 0, 5),
        status: currentStatus,
        last_event: "thread.started",
        updated_at: new Date().toISOString()
      };
    case "thread.status.changed":
      return {
        id: threadId,
        project_id: projectId || currentThread?.project_id || null,
        status: normalizeLiveThreadStatus(payload.status?.type ?? "", currentStatus),
        last_event: "thread.status.changed",
        updated_at: new Date().toISOString()
      };
    case "thread.tokenUsage.updated":
      {
        const nextUsage = normalizeLiveTokenUsagePayload(payload.tokenUsage ?? payload.token_usage ?? null, currentThread);
      return {
        id: threadId,
        project_id: projectId || currentThread?.project_id || null,
        ...nextUsage,
        updated_at: currentThread?.updated_at ?? new Date().toISOString()
      };
      }
    case "turn.started":
      return {
        id: threadId,
        project_id: projectId || currentThread?.project_id || null,
        status: "running",
        progress: Math.max(currentThread?.progress ?? 0, 20),
        last_event: "turn.started",
        updated_at: new Date().toISOString()
      };
    case "turn.starting":
      return {
        id: threadId,
        project_id: projectId || currentThread?.project_id || null,
        status: "running",
        progress: Math.max(currentThread?.progress ?? 0, 10),
        last_event: "turn.starting",
        updated_at: new Date().toISOString()
      };
    case "turn.plan.updated":
      return {
        id: threadId,
        project_id: projectId || currentThread?.project_id || null,
        status: "running",
        progress: Math.max(currentThread?.progress ?? 0, 45),
        last_event: "turn.plan.updated",
        updated_at: new Date().toISOString()
      };
    case "turn.diff.updated":
      return {
        id: threadId,
        project_id: projectId || currentThread?.project_id || null,
        status: "running",
        progress: Math.max(currentThread?.progress ?? 0, 75),
        last_event: "turn.diff.updated",
        updated_at: new Date().toISOString()
      };
    case "item.agentMessage.delta":
      return {
        id: threadId,
        project_id: projectId || currentThread?.project_id || null,
        status: "running",
        progress: Math.max(currentThread?.progress ?? 0, 90),
        last_event: "item.agentMessage.delta",
        last_message: `${currentThread?.last_message ?? ""}${payload.delta ?? ""}`,
        updated_at: new Date().toISOString()
      };
    case "turn.completed":
      return {
        id: threadId,
        project_id: projectId || currentThread?.project_id || null,
        status: payload.turn?.status === "completed" ? "idle" : "failed",
        progress: payload.turn?.status === "completed" ? 100 : 0,
        last_event: "turn.completed",
        updated_at: new Date().toISOString()
      };
    default:
      return null;
  }
}

function upsertLiveThread(currentThreads, event) {
  const { threadId } = getLiveEventContext(event);

  if (!threadId) {
    return currentThreads;
  }

  const currentThread = currentThreads.find((thread) => thread.id === threadId) ?? null;
  const patch = buildLiveThreadPatch(event, currentThread);

  if (!patch || !currentThread) {
    return currentThreads;
  }

  return upsertThread(currentThreads, {
    ...currentThread,
    ...patch
  });
}

function appendLiveAssistantMessage(messages, event, fallback = {}) {
  const { payload, issueId } = getLiveEventContext(event);

  if (event?.type !== "item.agentMessage.delta" || !payload.delta) {
    return messages;
  }

  const next = [...messages];
  const lastMessage = next.at(-1);

  if (lastMessage?.role === "assistant" && (lastMessage.issue_id ?? "") === issueId) {
    next[next.length - 1] = {
      ...lastMessage,
      content: `${lastMessage.content ?? ""}${payload.delta}`,
      timestamp: new Date().toISOString()
    };
    return next;
  }

  next.push({
    id: `${issueId || "assistant"}-${Date.now()}`,
    role: "assistant",
    kind: "message",
    content: String(payload.delta ?? ""),
    timestamp: new Date().toISOString(),
    issue_id: issueId || fallback.issue_id || null,
    issue_title: fallback.issue_title ?? "",
    issue_status: fallback.issue_status ?? "running"
  });
  return next;
}

function mergeThreads(currentThreads, nextThreads) {
  const nextById = new Map();

  for (const thread of currentThreads) {
    const normalized = normalizeThread(thread);

    if (normalized) {
      nextById.set(normalized.id, normalized);
    }
  }

  for (const thread of nextThreads) {
    const normalized = normalizeThread(thread);

    if (normalized) {
      nextById.set(normalized.id, normalized);
    }
  }

  return [...nextById.values()].sort(
    (left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at)
  );
}

function upsertThread(currentThreads, thread) {
  const normalized = normalizeThread(thread);

  if (!normalized) {
    return currentThreads;
  }

  const next = [...currentThreads];
  const index = next.findIndex((item) => item.id === normalized.id);

  if (index === -1) {
    next.unshift(normalized);
  } else {
    next[index] = {
      ...next[index],
      ...normalized
    };
  }

  return next.sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
}

function getThreadPreview(thread) {
  if (thread.last_message) {
    return thread.last_message;
  }

  return getRealtimeProgressText(thread);
}

function createThreadTitleFromPrompt(prompt) {
  const normalized = String(prompt ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "";
  }

  return normalized.length <= 34 ? normalized : `${normalized.slice(0, 34)}...`;
}

function summarizeMessageContent(content, limit = 160) {
  const normalized = String(content ?? "").trim();

  if (!normalized) {
    return "내용 없음";
  }

  if (normalized.length <= limit) {
    return normalized;
  }

  const safeLimit = Math.max(0, limit - 3);
  return `${normalized.slice(0, safeLimit)}...`;
}

function buildRunTimeline(thread) {
  if (!thread) {
    return [];
  }

  const entries = [
    {
      id: `${thread.id}-created`,
      title: "Thread 생성",
      description: `${thread.title || "새 채팅창"}이 생성되었습니다.`,
      timestamp: thread.created_at
    }
  ];

  if (thread.last_event && thread.last_event !== "issue.created") {
    entries.push({
      id: `${thread.id}-latest`,
      title: "최근 실행 상태",
      description: `${thread.last_event} · ${getStatusMeta(thread.status).label}`,
      timestamp: thread.updated_at
    });
  }

  if (thread.turn_id) {
    entries.push({
      id: `${thread.id}-turn`,
      title: "최근 turn",
      description: `turn id ${thread.turn_id}`,
      timestamp: thread.updated_at
    });
  }

  return entries.filter((entry) => entry.timestamp);
}

function BottomSheet({ open, title, description, onClose, children, variant = "bottom" }) {
  if (!open) {
    return null;
  }

  const isCenterDialog = variant === "center";
  const containerClassName = isCenterDialog
    ? "fixed inset-0 z-50 flex items-center justify-center bg-slate-950/86 px-4 py-6 backdrop-blur-sm"
    : "fixed inset-0 z-50 flex items-end justify-center bg-slate-950/75 px-4 pb-4 pt-10 backdrop-blur-sm";
  const panelClassName = isCenterDialog
    ? "modal-enter relative z-10 flex w-full max-w-xl max-h-[min(720px,88dvh)] flex-col overflow-hidden rounded-[1.75rem] border border-white/15 bg-[#0b1622] shadow-[0_30px_90px_rgba(0,0,0,0.65)] ring-1 ring-white/8"
    : "sheet-enter relative z-10 w-full max-w-xl overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950 shadow-telegram-soft";

  return (
    <div className={containerClassName}>
      <button type="button" aria-label="닫기" className="absolute inset-0" onClick={onClose} />
      <section className={panelClassName}>
        <div className="border-b border-white/10 bg-white/5 px-5 py-4">
          {isCenterDialog ? null : <div className="mx-auto mb-4 h-1.5 w-14 rounded-full bg-white/15" />}
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-white">{title}</h2>
              {description ? <p className="mt-1 text-sm leading-6 text-slate-400">{description}</p> : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-black/20 text-slate-300 transition hover:bg-white/10 hover:text-white"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
              </svg>
            </button>
          </div>
        </div>
        <div className="telegram-scroll max-h-[80dvh] overflow-y-auto">{children}</div>
      </section>
    </div>
  );
}

function InstallPromptBanner({ visible, installing, onInstall, onDismiss }) {
  if (!visible) {
    return null;
  }

  return (
    <div className="border-b border-telegram-400/20 bg-telegram-500/10 px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-telegram-500/20 text-telegram-100">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M12 3v12m0 0l4-4m-4 4l-4-4M5 19h14" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
            </svg>
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-white">앱으로 설치해서 바로 여시겠습니까?</p>
            <p className="truncate text-xs text-telegram-100/70">홈 화면에 추가하면 더 빠르게 접근하실 수 있습니다.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onInstall}
          disabled={installing}
          className="shrink-0 rounded-full bg-telegram-500 px-3 py-2 text-[11px] font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {installing ? "설치 중" : "설치"}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 text-[11px] text-slate-300 transition hover:text-white"
        >
          다시 보지 않음
        </button>
      </div>
    </div>
  );
}

function PwaUpdateDialog({ visible, busy, onConfirm }) {
  if (!visible) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center px-6 py-8">
      <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" />
      <div className="relative w-full max-w-sm rounded-3xl border border-white/10 bg-slate-900/95 px-6 py-7 text-center shadow-2xl">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-telegram-500/10 text-telegram-300">
          <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path d="M12 8v4l2.5 1.5M12 22a10 10 0 100-20 10 10 0 000 20z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
          </svg>
        </div>
        <h2 className="mt-4 text-base font-semibold text-white">업데이트가 준비되었습니다</h2>
        <p className="mt-2 text-sm leading-6 text-slate-300">최신 버전을 적용하려면 새로고침을 진행해 주세요.</p>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="mt-5 inline-flex w-full items-center justify-center rounded-full bg-white px-4 py-3 text-sm font-semibold text-slate-900 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? (
            <>
              <span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-400 border-t-slate-900" />
              새로고침 중...
            </>
          ) : (
            "지금 새로고침"
          )}
        </button>
      </div>
    </div>
  );
}

function LoginPage({ initialLoginId, loading, error, onSubmit }) {
  const [loginId, setLoginId] = useState(initialLoginId ?? "");
  const [password, setPassword] = useState("");
  const [rememberDevice, setRememberDevice] = useState(Boolean(initialLoginId));

  useEffect(() => {
    setLoginId(initialLoginId ?? "");
  }, [initialLoginId]);

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!loginId.trim() || !password.trim()) {
      return;
    }

    await onSubmit({
      loginId: loginId.trim(),
      password,
      rememberDevice
    });
  };

  return (
    <div className="telegram-shell flex min-h-screen items-center justify-center px-5 py-8">
      <div className="absolute inset-0 overflow-hidden">
        <div className="telegram-grid absolute inset-0 opacity-20" />
        <div className="absolute left-[-15%] top-[-8%] h-72 w-72 rounded-full bg-telegram-400/30 blur-[100px]" />
        <div className="absolute bottom-[-8%] right-[-12%] h-72 w-72 rounded-full bg-orange-300/20 blur-[120px]" />
      </div>

      <main className="relative z-10 w-full max-w-sm overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/85 shadow-telegram-soft backdrop-blur">
        <div className="bg-gradient-to-br from-telegram-500 via-telegram-600 to-telegram-800 px-6 pb-10 pt-8">
          <div className="flex h-14 w-14 items-center justify-center rounded-[1.25rem] bg-white/15 text-white">
            <svg className="h-7 w-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M20 4L4 10.5l6 2.2L12.5 19 20 4z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
            </svg>
          </div>
          <p className="mt-6 text-[11px] uppercase tracking-[0.32em] text-telegram-100/70">OctOP Pocket</p>
          <h1 className="mt-3 font-display text-3xl font-bold tracking-tight text-white">모바일 워크스페이스</h1>
          <p className="mt-3 text-sm leading-6 text-telegram-50/80">
            대시보드의 프로젝트, thread, bridge 상태를 텔레그램 형식으로 바로 확인하실 수 있습니다.
          </p>
        </div>

        <form className="space-y-5 px-6 py-6" onSubmit={handleSubmit}>
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="loginId">
              Login ID
            </label>
            <input
              id="loginId"
              name="loginId"
              type="text"
              autoComplete="username"
              required
              value={loginId}
              onChange={(event) => setLoginId(event.target.value)}
              placeholder="LicenseHub 로그인 ID"
              className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="비밀번호를 입력해 주세요"
              className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
            />
          </div>

          <label className="flex items-center gap-3 text-sm text-slate-400">
            <input
              type="checkbox"
              checked={rememberDevice}
              onChange={(event) => setRememberDevice(event.target.checked)}
              className="h-4 w-4 rounded border-white/10 bg-white/5 text-telegram-400 focus:ring-telegram-300"
            />
            이 기기에서 로그인 유지
          </label>

          {error ? (
            <div className="rounded-2xl border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-telegram-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? (
              <>
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                로그인 중...
              </>
            ) : (
              "접속하기"
            )}
          </button>
        </form>
      </main>
    </div>
  );
}

function UtilitySheet({
  open,
  session,
  status,
  bridges,
  selectedBridgeId,
  projects,
  threads,
  onClose,
  onSelectBridge,
  onOpenProjectComposer,
  onRefresh,
  onLogout
}) {
  return (
    <BottomSheet
      open={open}
      title="워크스페이스 설정"
      onClose={onClose}
      variant="center"
    >
      <div className="px-5 py-5">
        <section className="flex items-center gap-3 border-b border-white/10 pb-4">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-telegram-500/15 text-sm font-semibold text-white">
            {(session.displayName || session.loginId || "O").slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-semibold text-white">{session.displayName || session.loginId}</p>
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  status.app_server?.connected ? "bg-emerald-300" : "bg-rose-300"
                }`}
              />
            </div>
            <p className="truncate text-xs text-slate-400">{session.loginId}</p>
          </div>
        </section>

        <section className="grid grid-cols-3 gap-2 border-b border-white/10 py-4 text-center">
          <div className="rounded-[1rem] border border-white/10 bg-black/15 px-3 py-3">
            <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Bridge</p>
            <p className="mt-1 text-base font-semibold text-white">{bridges.length}</p>
          </div>
          <div className="rounded-[1rem] border border-white/10 bg-black/15 px-3 py-3">
            <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Project</p>
            <p className="mt-1 text-base font-semibold text-white">{projects.length}</p>
          </div>
          <div className="rounded-[1rem] border border-white/10 bg-black/15 px-3 py-3">
            <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Thread</p>
            <p className="mt-1 text-base font-semibold text-white">{threads.length}</p>
          </div>
        </section>

        <section className="py-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold text-white">Bridge 선택</p>
            <span
              className={`text-[11px] ${
                status.app_server?.connected ? "text-emerald-200" : "text-rose-200"
              }`}
            >
              {status.app_server?.connected ? "온라인" : "오프라인"}
            </span>
          </div>

          <div className="divide-y divide-white/10 overflow-hidden rounded-[1.1rem] border border-white/10 bg-black/10">
            {bridges.length === 0 ? (
              <div className="px-4 py-4 text-sm text-slate-400">연결된 bridge가 없습니다.</div>
            ) : (
              bridges.map((bridge) => {
                const active = bridge.bridge_id === selectedBridgeId;

                return (
                  <button
                    key={bridge.bridge_id}
                    type="button"
                    onClick={() => {
                      onSelectBridge(bridge.bridge_id);
                      onClose();
                    }}
                    className={`w-full px-4 py-3 text-left transition ${
                      active ? "bg-telegram-500/10" : "bg-transparent hover:bg-white/[0.03]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-white">{bridge.device_name ?? bridge.bridge_id}</p>
                        <p className="truncate text-[11px] text-slate-500">{bridge.bridge_id}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-[11px] text-slate-400">{formatRelativeTime(bridge.last_seen_at)}</p>
                        {active ? <p className="mt-0.5 text-[10px] text-telegram-200">현재 선택</p> : null}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </section>

        <section className="grid grid-cols-2 gap-2 border-t border-white/10 pt-4">
          <button
            type="button"
            onClick={() => {
              onClose();
              onRefresh();
            }}
            className="flex-1 rounded-full border border-white/10 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-white/5"
          >
            새로고침
          </button>
          <button
            type="button"
            onClick={() => {
              onClose();
              onOpenProjectComposer();
            }}
            className="flex-1 rounded-full bg-telegram-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-telegram-400"
          >
            프로젝트 등록
          </button>
        </section>

        <button
          type="button"
          onClick={onLogout}
          className="mt-4 w-full rounded-full border border-rose-400/20 px-4 py-2.5 text-sm font-semibold text-rose-100 transition hover:bg-rose-500/10"
        >
          로그아웃
        </button>
      </div>
    </BottomSheet>
  );
}

function InlineIssueComposer({
  busy,
  selectedProject,
  onSubmit,
  label,
  disabled = false
}) {
  const LONG_PRESS_THRESHOLD_MS = 650;
  const [prompt, setPrompt] = useState("");
  const textareaRef = useRef(null);
  const speechRecognitionRef = useRef(null);
  const [isRecording, setIsRecording] = useState(false);
  const longPressTimerRef = useRef(null);
  const voiceRestartTimerRef = useRef(null);
  const suppressClickRef = useRef(false);
  const isRecordingRef = useRef(false);
  const shouldKeepRecordingRef = useRef(false);
  const supportsSpeechRecognition =
    typeof window !== "undefined" && ("webkitSpeechRecognition" in window || "SpeechRecognition" in window);

  const syncPromptHeight = useCallback((element) => {
    const textarea = element ?? textareaRef.current;

    if (!textarea) {
      return;
    }

    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, []);

  useLayoutEffect(() => {
    syncPromptHeight();
  }, [prompt, selectedProject, syncPromptHeight]);

  const handlePromptChange = useCallback(
    (event) => {
      setPrompt(event.target.value);
      syncPromptHeight(event.target);
    },
    [syncPromptHeight]
  );

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const clearVoiceRestartTimer = useCallback(() => {
    if (voiceRestartTimerRef.current) {
      window.clearTimeout(voiceRestartTimerRef.current);
      voiceRestartTimerRef.current = null;
    }
  }, []);

  const stopVoiceCapture = useCallback(() => {
    shouldKeepRecordingRef.current = false;
    clearLongPressTimer();
    clearVoiceRestartTimer();

    const recognition = speechRecognitionRef.current;
    speechRecognitionRef.current = null;

    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;

      try {
        recognition.stop();
      } catch {
        // ignore stop race errors from browser implementations
      }
    }

    setIsRecording(false);
  }, [clearLongPressTimer, clearVoiceRestartTimer]);

  useEffect(() => () => stopVoiceCapture(), [stopVoiceCapture]);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  const appendVoiceTranscript = useCallback(
    (text) => {
      const transcript = String(text ?? "").trim();

      if (!transcript) {
        return;
      }

      setPrompt((current) => (current ? `${current.trim()} ${transcript}` : transcript));

      if (typeof window !== "undefined") {
        window.setTimeout(() => syncPromptHeight(), 0);
      }
    },
    [syncPromptHeight]
  );

  const startVoiceCapture = useCallback(() => {
    if (
      !supportsSpeechRecognition ||
      typeof window === "undefined" ||
      speechRecognitionRef.current ||
      busy ||
      disabled ||
      !selectedProject
    ) {
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "ko-KR";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    shouldKeepRecordingRef.current = true;
    recognition.onstart = () => setIsRecording(true);
    recognition.onresult = (event) => {
      let collected = "";

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];

        if (!result) {
          continue;
        }

        if (result.isFinal) {
          collected += result[0]?.transcript ?? "";
        }
      }

      appendVoiceTranscript(collected);
    };
    recognition.onerror = (event) => {
      speechRecognitionRef.current = null;

      if (!shouldKeepRecordingRef.current) {
        setIsRecording(false);
        return;
      }

      if (["not-allowed", "service-not-allowed", "audio-capture"].includes(event?.error ?? "")) {
        shouldKeepRecordingRef.current = false;
        setIsRecording(false);
        return;
      }

      clearVoiceRestartTimer();
      voiceRestartTimerRef.current = window.setTimeout(() => {
        voiceRestartTimerRef.current = null;

        if (shouldKeepRecordingRef.current && !speechRecognitionRef.current) {
          startVoiceCapture();
        }
      }, 40);
    };
    recognition.onend = () => {
      speechRecognitionRef.current = null;

      if (!shouldKeepRecordingRef.current) {
        setIsRecording(false);
        return;
      }

      clearVoiceRestartTimer();
      voiceRestartTimerRef.current = window.setTimeout(() => {
        voiceRestartTimerRef.current = null;

        if (shouldKeepRecordingRef.current && !speechRecognitionRef.current) {
          startVoiceCapture();
        }
      }, 20);
    };
    speechRecognitionRef.current = recognition;

    try {
      recognition.start();
    } catch {
      speechRecognitionRef.current = null;
      clearVoiceRestartTimer();

      if (shouldKeepRecordingRef.current) {
        voiceRestartTimerRef.current = window.setTimeout(() => {
          voiceRestartTimerRef.current = null;

          if (shouldKeepRecordingRef.current && !speechRecognitionRef.current) {
            startVoiceCapture();
          }
        }, 40);
      }
    }
  }, [appendVoiceTranscript, busy, clearVoiceRestartTimer, disabled, selectedProject, supportsSpeechRecognition]);

  useEffect(() => {
    if (!isRecording) {
      return;
    }

    if (busy || disabled || !selectedProject) {
      stopVoiceCapture();
    }
  }, [busy, disabled, isRecording, selectedProject, stopVoiceCapture]);

  useEffect(() => () => clearLongPressTimer(), [clearLongPressTimer]);
  useEffect(() => () => clearVoiceRestartTimer(), [clearVoiceRestartTimer]);

  const handlePromptSubmit = useCallback(async () => {
    const normalizedPrompt = prompt.trim();
    const normalizedTitle = createThreadTitleFromPrompt(normalizedPrompt);

    if (!normalizedPrompt || !selectedProject?.id || disabled) {
      return;
    }

    const accepted = await onSubmit({
      title: normalizedTitle,
      prompt: normalizedPrompt,
      project_id: selectedProject.id
    });

    if (accepted !== false) {
      setPrompt("");
    }
  }, [disabled, onSubmit, prompt, selectedProject?.id]);

  const handleFormSubmit = useCallback(
    (event) => {
      event.preventDefault();
      void handlePromptSubmit();
    },
    [handlePromptSubmit]
  );

  const toggleVoiceCapture = useCallback(() => {
    if (isRecordingRef.current) {
      stopVoiceCapture();
      return;
    }

    if (!supportsSpeechRecognition) {
      if (typeof window !== "undefined") {
        window.alert("이 브라우저에서는 음성 입력을 지원하지 않습니다.");
      }
      return;
    }

    startVoiceCapture();
  }, [startVoiceCapture, stopVoiceCapture, supportsSpeechRecognition]);

  const handleSendPointerDown = useCallback(
    (event) => {
      if (!selectedProject || busy || disabled) {
        return;
      }

      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }

      suppressClickRef.current = false;
      clearLongPressTimer();

      longPressTimerRef.current = window.setTimeout(() => {
        suppressClickRef.current = true;
        toggleVoiceCapture();
      }, LONG_PRESS_THRESHOLD_MS);
    },
    [busy, clearLongPressTimer, disabled, selectedProject, toggleVoiceCapture]
  );

  const handleSendPointerUp = useCallback(() => {
    clearLongPressTimer();
  }, [clearLongPressTimer]);

  const handleSendPointerLeave = useCallback(() => {
    clearLongPressTimer();
  }, [clearLongPressTimer]);

  const handleSendClick = useCallback(
    (event) => {
      if (isRecordingRef.current) {
        toggleVoiceCapture();
        event.preventDefault();
        event.stopPropagation();
        suppressClickRef.current = false;
        return;
      }

      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (busy || disabled || !selectedProject) {
        return;
      }

      void handlePromptSubmit();
    },
    [busy, disabled, handlePromptSubmit, selectedProject, toggleVoiceCapture]
  );

  return (
    <>
      {isRecording ? (
        <div className="pointer-events-none fixed inset-x-0 top-3 z-40 flex justify-center">
          <div className="flex items-center gap-2 rounded-full bg-rose-500/95 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-rose-900/40">
            <span className="h-2.5 w-2.5 rounded-full bg-white animate-pulse" />
            <span>음성 입력 중 · 버튼을 다시 누르면 종료됩니다</span>
          </div>
        </div>
      ) : null}
      <form className="pointer-events-auto w-full" onSubmit={handleFormSubmit}>
        <div className="flex items-end gap-3">
          <div className="min-w-0 flex-1 rounded-[1.35rem] border border-white/10 bg-slate-900 px-3 py-2">
            <div className="mb-1 text-[11px] text-slate-500">
              {selectedProject ? `${selectedProject.name} · ${label ?? "프롬프트"}` : "프로젝트를 선택해 주세요"}
            </div>
            <textarea
              rows="1"
              ref={textareaRef}
              value={prompt}
              onChange={handlePromptChange}
              placeholder=""
              disabled={!selectedProject || busy || disabled}
              className="min-h-[24px] w-full resize-none overflow-hidden border-none bg-transparent p-0 text-sm leading-5 text-white outline-none ring-0 focus:ring-0"
            />
          </div>
          <button
            type="button"
          onPointerDown={handleSendPointerDown}
          onPointerUp={handleSendPointerUp}
          onPointerLeave={handleSendPointerLeave}
          onPointerCancel={handleSendPointerLeave}
          onClick={handleSendClick}
          onContextMenu={(event) => event.preventDefault()}
          disabled={busy || !selectedProject || disabled}
          aria-pressed={isRecording}
          className={`relative flex h-16 w-16 shrink-0 items-center justify-center rounded-full border-2 text-lg transition ${
            isRecording
              ? "border-rose-500 bg-rose-500/20 text-rose-50"
              : "border-telegram-400/80 bg-telegram-500 text-white hover:bg-telegram-400"
          } disabled:cursor-not-allowed disabled:opacity-45`}
        >
          {isRecording ? (
            <>
              <span className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full bg-rose-300 shadow-[0_0_0_8px_rgba(244,63,94,0.35)]" />
              <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  d="M12 3a2 2 0 00-2 2v6a2 2 0 104 0V5a2 2 0 00-2-2z"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                />
                <path d="M19 10v2a7 7 0 01-14 0v-2" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                <path d="M12 19v4" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
              </svg>
            </>
          ) : busy ? (
            <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          ) : (
            <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M20 4L4 12l6 2 2 6 8-16z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
            </svg>
          )}
        </button>
      </div>
    </form>
    </>
  );
}

function ProjectComposerSheet({
  open,
  busy,
  roots,
  folderState,
  folderLoading,
  selectedWorkspacePath,
  onBrowseFolder,
  onSelectWorkspace,
  onClose,
  onSubmit
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const tapStateRef = useRef({ path: "", timestamp: 0 });

  useEffect(() => {
    if (!open) {
      setName("");
      setDescription("");
      tapStateRef.current = { path: "", timestamp: 0 };
      return;
    }
  }, [open]);

  const selectedWorkspaceLabel = useMemo(
    () => getRelativeWorkspacePath(selectedWorkspacePath, roots),
    [roots, selectedWorkspacePath]
  );

  const handleFolderTap = useCallback(
    (path) => {
      const now = Date.now();
      const lastTap = tapStateRef.current;
      const isSecondTap = lastTap.path === path && now - lastTap.timestamp < 320;

      tapStateRef.current = {
        path,
        timestamp: now
      };

      onSelectWorkspace(path);
      setName(getPathLabel(path));

      if (isSecondTap) {
        tapStateRef.current = { path: "", timestamp: 0 };
        void onBrowseFolder(path);
      }
    },
    [onBrowseFolder, onSelectWorkspace]
  );

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!name.trim() || !selectedWorkspacePath) {
      return;
    }

    await onSubmit({
      name: name.trim(),
      description: description.trim(),
      workspace_path: selectedWorkspacePath
    });
  };

  return (
    <BottomSheet
      open={open}
      title="새 프로젝트 등록"
      onClose={onClose}
      variant="center"
    >
      <form className="space-y-5 px-5 py-5" onSubmit={handleSubmit}>
        <section className="border border-white/10 p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-white">워크스페이스 선택</p>
            {folderLoading ? <span className="text-xs text-slate-400">불러오는 중...</span> : null}
          </div>

          <div className="mt-4 rounded-[1rem] border border-white/10 bg-black/10 px-3 py-2 text-[11px] text-slate-400">
            한 번 클릭하면 선택되고, 더블 클릭하면 폴더 내부로 들어갑니다.
          </div>

          <div className="telegram-scroll mt-3 max-h-72 overflow-y-auto rounded-[1rem] border border-white/10">
            {folderState.parent_path ? (
              <button
                type="button"
                onClick={() => handleFolderTap(folderState.parent_path)}
                className={`flex w-full items-center gap-3 border-b border-white/10 px-4 py-3 text-left transition ${
                  selectedWorkspacePath === folderState.parent_path
                    ? "bg-telegram-500/10"
                    : "bg-transparent hover:bg-white/[0.03]"
                }`}
              >
                <span className="text-sm font-medium text-white">..</span>
              </button>
            ) : null}

            {folderState.entries?.length ? (
              folderState.entries.map((entry) => {
                const active = selectedWorkspacePath === entry.path;

                return (
                  <button
                    key={entry.path}
                    type="button"
                    onClick={() => handleFolderTap(entry.path)}
                    className={`flex w-full items-center gap-3 border-b border-white/10 px-4 py-3 text-left last:border-b-0 transition ${
                      active ? "bg-telegram-500/10" : "bg-transparent hover:bg-white/[0.03]"
                    }`}
                  >
                    <span className="text-sm font-medium text-white">{entry.name}</span>
                  </button>
                );
              })
            ) : (
              <div className="px-4 py-4 text-sm text-slate-400">
                하위 폴더가 없습니다.
              </div>
            )}
          </div>
        </section>

        <div className="border border-white/10 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Selected Workspace</p>
          <p className="mt-2 break-all text-sm text-white">
            {selectedWorkspaceLabel || "아직 선택된 경로가 없습니다."}
          </p>
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="project-name">
            프로젝트 이름
          </label>
          <input
            id="project-name"
            type="text"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="예: OctOP 모바일 운영"
            className="w-full rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="project-description">
            프로젝트 설명
          </label>
          <textarea
            id="project-description"
            rows="4"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="프로젝트 목적과 작업 범위를 적어 주세요."
            className="w-full rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-white/10 px-4 py-2.5 text-sm font-medium text-slate-200 transition hover:bg-white/5"
          >
            취소
          </button>
          <button
            type="submit"
            disabled={busy || !selectedWorkspacePath}
            className="rounded-full bg-telegram-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "등록 중..." : "프로젝트 등록"}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}

function ThreadRenameDialog({ open, busy, thread, onClose, onSubmit }) {
  const [title, setTitle] = useState("");

  useEffect(() => {
    if (!open) {
      setTitle("");
      return;
    }

    setTitle(thread?.title ?? "");
  }, [open, thread]);

  if (!open || !thread) {
    return null;
  }

  return (
    <BottomSheet open={open} title="채팅창 제목 변경" onClose={onClose} variant="center">
      <form
        className="space-y-5 px-5 py-5"
        onSubmit={async (event) => {
          event.preventDefault();

          if (!title.trim()) {
            return;
          }

          const accepted = await onSubmit(title.trim());

          if (accepted !== false) {
            onClose();
          }
        }}
      >
        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="thread-title">
            제목
          </label>
          <input
            id="thread-title"
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="w-full rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-white/10 px-4 py-2.5 text-sm font-medium text-slate-200 transition hover:bg-white/5"
          >
            취소
          </button>
          <button
            type="submit"
            disabled={busy || !title.trim()}
            className="rounded-full bg-telegram-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "변경 중..." : "저장"}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}

function ThreadListItem({ thread, active, onOpen, onRename, onDelete }) {
  const status = getStatusMeta(thread.status);
  const contextUsageLabel = formatThreadContextUsage(thread);
  const startPointRef = useRef(null);
  const baseOffsetRef = useRef(0);
  const pointerIdRef = useRef(null);
  const swipeAxisRef = useRef(null);
  const offsetRef = useRef(0);
  const movedRef = useRef(false);
  const ACTION_WIDTH = 92;
  const SNAP_THRESHOLD = 42;
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  const setRevealOffset = useCallback((nextOffset) => {
    const clamped = Math.max(-ACTION_WIDTH, Math.min(ACTION_WIDTH, nextOffset));
    offsetRef.current = clamped;
    setOffset(clamped);
  }, []);

  const handlePointerDown = useCallback((event) => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }

    startPointRef.current = { x: event.clientX, y: event.clientY };
    baseOffsetRef.current = offsetRef.current;
    pointerIdRef.current = event.pointerId;
    swipeAxisRef.current = null;
    movedRef.current = false;
    setDragging(false);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, []);

  const handlePointerMove = useCallback(
    (event) => {
      if (
        startPointRef.current === null ||
        (pointerIdRef.current !== null && event.pointerId !== pointerIdRef.current)
      ) {
        return;
      }

      const deltaX = event.clientX - startPointRef.current.x;
      const deltaY = event.clientY - startPointRef.current.y;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);

      if (swipeAxisRef.current === null) {
        if (absX < 6 && absY < 6) {
          return;
        }

        swipeAxisRef.current = absX > absY ? "x" : "y";
      }

      if (swipeAxisRef.current !== "x") {
        return;
      }

      if (event.cancelable) {
        event.preventDefault();
      }

      if (absX > 6) {
        movedRef.current = true;
      }

      setDragging(true);
      setRevealOffset(baseOffsetRef.current + deltaX);
    },
    [setRevealOffset]
  );

  const handlePointerUp = useCallback((event) => {
    if (startPointRef.current === null) {
      return;
    }

    if (swipeAxisRef.current === "x" && offsetRef.current <= -SNAP_THRESHOLD) {
      setRevealOffset(-ACTION_WIDTH);
    } else if (swipeAxisRef.current === "x" && offsetRef.current >= SNAP_THRESHOLD) {
      setRevealOffset(ACTION_WIDTH);
    } else if (swipeAxisRef.current === "x") {
      setRevealOffset(0);
    }

    startPointRef.current = null;
    baseOffsetRef.current = 0;
    pointerIdRef.current = null;
    swipeAxisRef.current = null;
    setDragging(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, [setRevealOffset]);

  const showDeleteAction = offset > 0;
  const showRenameAction = offset < 0;

  return (
    <div className="relative overflow-hidden border-b border-white/8">
      <button
        type="button"
        onClick={() => {
          setRevealOffset(0);
          onDelete(thread);
        }}
        className={`absolute inset-y-0 left-0 flex w-[92px] items-center justify-center bg-rose-500 text-[12px] font-semibold text-white transition-opacity duration-150 ${
          showDeleteAction ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        삭제
      </button>

      <button
        type="button"
        onClick={() => {
          setRevealOffset(0);
          onRename(thread);
        }}
        className={`absolute inset-y-0 right-0 flex w-[92px] items-center justify-center bg-slate-800 text-[12px] font-semibold text-white transition-opacity duration-150 ${
          showRenameAction ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        편집
      </button>

      <button
        type="button"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClick={() => {
          if (movedRef.current) {
            movedRef.current = false;
            return;
          }

          if (offsetRef.current !== 0) {
            setRevealOffset(0);
            return;
          }

          onOpen(thread.id);
        }}
        className={`relative w-full px-3 py-3 text-left ${
          dragging ? "" : "transition-transform duration-180 ease-out"
        } ${active ? "bg-slate-900" : "bg-slate-950 hover:bg-slate-900/90"} `}
        style={{
          transform: `translate3d(${offset}px, 0, 0)`,
          touchAction: "pan-y",
          willChange: "transform"
        }}
      >
        <div
          className={`min-w-0 rounded-2xl border px-3 py-3 ${
            active
              ? "border-white/12 bg-white/[0.03]"
              : "border-transparent bg-transparent"
          }`}
        >
          <div className="flex items-center justify-between gap-3">
            <p className="thread-title min-w-0 flex-1 truncate text-sm font-semibold text-white">{thread.title}</p>
            <span className="shrink-0 text-[11px] text-slate-500">{formatRelativeTime(thread.updated_at)}</span>
          </div>

          <p className="thread-preview mt-1 text-[13px] leading-5 text-slate-300">{getThreadPreview(thread)}</p>

	          <div className="mt-2 flex items-center gap-2">
	            <span className={`inline-flex items-center gap-2 rounded-full px-2 py-0.5 text-[10px] ${status.chipClassName}`}>
	              <span className={`h-2 w-2 rounded-full ${status.dotClassName}`} />
	              {status.label}
	            </span>
	            {contextUsageLabel ? (
	              <span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] text-slate-300">
	                {contextUsageLabel}
	              </span>
	            ) : null}
	          </div>
	        </div>
	      </button>
    </div>
  );
}

function MessageBubble({ align = "left", tone = "light", title, meta, children }) {
  const bubbleClassName =
    tone === "brand"
      ? "bg-telegram-500 text-white"
      : tone === "success"
        ? "bg-emerald-100 text-slate-900"
        : tone === "warn"
          ? "bg-amber-100 text-slate-900"
          : tone === "danger"
            ? "bg-rose-100 text-slate-900"
            : "bg-white text-slate-900";
  const wrapperClassName = align === "right" ? "justify-end" : "justify-start";

  return (
    <div className={`message-enter flex ${wrapperClassName}`}>
      <article className={`max-w-[86%] rounded-[1.35rem] px-4 py-3 ${bubbleClassName}`}>
        {title ? <p className="text-xs font-semibold uppercase tracking-[0.16em] opacity-70">{title}</p> : null}
        <div className={title ? "mt-2" : ""}>{children}</div>
        {meta ? <p className="mt-3 text-right text-[11px] opacity-60">{meta}</p> : null}
      </article>
    </div>
  );
}

function ConversationTimeline({ entries }) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }

  return (
    <ul className="mt-4 space-y-6 border-l border-white/10 pl-4">
      {entries.map((entry, index) => (
        <li key={entry.id ?? index} className="relative pl-6">
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
            <p className="mt-3 text-base font-semibold text-white">
              {entry.prompt?.trim() ? entry.prompt : "프롬프트가 비어 있습니다."}
            </p>

            {entry.responses.length ? (
              <div className="mt-3 space-y-3">
                {entry.responses.map((response) => (
                  <div
                    key={response.id}
                    className="rounded-[1rem] border border-white/5 bg-slate-950/70 px-3 py-2 text-sm leading-6 text-slate-200"
                  >
                    <p className="whitespace-pre-wrap">{response.content || "응답이 비어 있습니다."}</p>
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

function RunTimeline({ entries }) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }

  return (
    <ul className="space-y-3">
      {entries.map((entry) => (
        <li key={entry.id} className="border-b border-white/8 px-1 pb-3">
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

function ThreadDetail({
  thread,
  project,
  messages,
  issues = [],
  messagesLoading,
  messagesError,
  onRefreshMessages,
  onSubmitPrompt,
  submitBusy,
  onBack,
  messageFilter,
  onChangeMessageFilter,
  isDraft = false
}) {
  const status = thread ? getStatusMeta(thread.status) : null;
  const scrollRef = useRef(null);
  const scrollAnchorRef = useRef(null);
  const previousScrollTopRef = useRef(0);
  const pinnedToLatestRef = useRef(true);
  const [isPinnedToLatest, setIsPinnedToLatest] = useState(true);
  const autoScrollingRef = useRef(false);
  const [showHeaderMenus, setShowHeaderMenus] = useState(true);
  const [viewMode] = useState("chat");
  const threadTitle = thread?.title ?? "새 채팅창";
  const threadTimestamp = thread?.created_at ?? new Date().toISOString();
  const contextUsage = getThreadContextUsage(thread);
  const safeIssues = Array.isArray(issues) ? issues : [];
  const hasRunningIssue = safeIssues.some((issue) => issue?.status === "running");
  const isInputDisabled = thread?.status === "running" && (messagesLoading || safeIssues.length === 0 || hasRunningIssue);
  const chatTimeline = useMemo(() => {
    const normalized = [];
    let lastPrompt = null;

    const safeMessages = Array.isArray(messages) ? messages : [];

    safeMessages.forEach((message, index) => {
      if (!message) {
        return;
      }

      const role = message.role === "assistant" ? "assistant" : "user";
      const content = String(message.content ?? "").trim();
      const timestamp = message.timestamp ?? thread.updated_at ?? thread.created_at ?? new Date().toISOString();
      const base = {
        id: message.id ?? `${role}-${index}`,
        role,
        content,
        timestamp
      };

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
        title: "응답",
        replyTo: lastPrompt
      });
    });

    return normalized;
  }, [messages, thread?.created_at, thread?.updated_at]);
  const conversationTimeline = useMemo(() => {
    const fallbackTimestamp = thread?.updated_at ?? thread?.created_at ?? new Date().toISOString();
    const safeMessages = Array.isArray(messages) ? messages : [];
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

      const role = message.role === "assistant" ? "assistant" : "user";
      const content = String(message.content ?? "").trim();
      const timestamp = message.timestamp ?? fallbackTimestamp;
      const identifier = message.id ?? `${role}-${index}`;

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
  const runTimeline = useMemo(() => buildRunTimeline(thread), [thread]);
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

  const recomputePinnedState = useCallback(() => {
    const scrollNode = scrollRef.current;

    if (!scrollNode) {
      return;
    }

    const distanceFromBottom = scrollNode.scrollHeight - scrollNode.clientHeight - scrollNode.scrollTop;
    const shouldPin = distanceFromBottom <= CHAT_AUTO_SCROLL_THRESHOLD_PX;

    if (shouldPin !== pinnedToLatestRef.current) {
      pinnedToLatestRef.current = shouldPin;
      setIsPinnedToLatest(shouldPin);
    }
  }, []);

  useEffect(() => {
    pinnedToLatestRef.current = true;
    setIsPinnedToLatest(true);
    autoScrollingRef.current = false;
    previousScrollTopRef.current = 0;
    setShowHeaderMenus(true);
    recomputePinnedState();
  }, [recomputePinnedState, thread?.id, viewMode]);

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

        if (node && !autoScrollingRef.current) {
          const nextScrollTop = Math.max(0, node.scrollTop);
          const delta = nextScrollTop - previousScrollTopRef.current;

          if (nextScrollTop <= 8) {
            setShowHeaderMenus(true);
          } else if (delta >= HEADER_MENU_SCROLL_DELTA_PX) {
            setShowHeaderMenus(false);
          } else if (delta <= -HEADER_MENU_SCROLL_DELTA_PX) {
            setShowHeaderMenus(true);
          }

          previousScrollTopRef.current = nextScrollTop;
        }

        recomputePinnedState();
      });
    };

    recomputePinnedState();
    scrollNode.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      scrollNode.removeEventListener("scroll", handleScroll);

      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [recomputePinnedState, viewMode]);

  useLayoutEffect(() => {
    if (viewMode !== "chat" || !isPinnedToLatest) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const anchorNode = scrollAnchorRef.current;
      const containerNode = scrollRef.current;

      if (!anchorNode && !containerNode) {
        return;
      }

      autoScrollingRef.current = true;

      if (anchorNode) {
        anchorNode.scrollIntoView({ block: "end" });
      } else if (containerNode) {
        containerNode.scrollTop = containerNode.scrollHeight;
      }

      window.requestAnimationFrame(() => {
        autoScrollingRef.current = false;
        recomputePinnedState();
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [isPinnedToLatest, messagesLoading, recomputePinnedState, thread?.id, viewMode, visibleChatTimeline]);

  const handleRefreshMessages = () => {
    if (onRefreshMessages) {
      onRefreshMessages();
    }
  };

  const canRefresh = Boolean(thread?.id && onRefreshMessages);
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
    <div className="flex min-h-[100dvh] flex-col">
      <header className="sticky top-0 z-20 border-b border-white/10 bg-slate-950 px-4 py-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-white/5 text-white transition hover:bg-white/10"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
            </svg>
          </button>

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-white">{threadTitle}</p>
	            <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-400">
	              <span className="truncate">{project?.name ?? "프로젝트 미지정"}</span>
	              {status ? <span className={`h-1.5 w-1.5 rounded-full ${status.dotClassName}`} /> : null}
	              <span>{status ? status.label : "새 채팅창"}</span>
	              {contextUsage?.percent !== null ? (
	                <>
	                  <span className="h-1.5 w-1.5 rounded-full bg-white/20" />
	                  <span>{formatThreadContextUsage(thread)}</span>
	                </>
	              ) : null}
	            </div>
          </div>

          <button
            type="button"
            onClick={handleRefreshMessages}
            disabled={messagesLoading || !canRefresh}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {messagesLoading ? (
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
          className={`overflow-hidden transition-all duration-200 ease-out ${
            showHeaderMenus ? "mt-3 max-h-32 opacity-100" : "max-h-0 opacity-0"
          }`}
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

      <div ref={scrollRef} className="telegram-grid flex-1 overflow-y-auto px-4 py-5">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 pb-10">
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
            <RunTimeline entries={runTimeline} />
          ) : viewMode === "chat" ? (
            visibleChatTimeline.map((message) => (
              <MessageBubble
                key={message.id}
                align={message.align}
                tone={message.tone}
                title={message.title}
                meta={formatRelativeTime(message.timestamp)}
              >
                {message.replyTo ? (
                  <div className="mb-2 border-l-2 border-slate-300/45 pl-3 text-xs text-slate-700/80">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-600/70">프롬프트</p>
                    <p className="mt-1 text-sm leading-5">{summarizeMessageContent(message.replyTo.content)}</p>
                  </div>
                ) : null}
                <p className="whitespace-pre-wrap text-sm leading-6">
                  {message.content || (message.role === "assistant" ? "응답을 기다리고 있습니다..." : "프롬프트가 비어 있습니다.")}
                </p>
              </MessageBubble>
            ))
          ) : messageFilter === "prompts" ? (
            <ConversationTimeline entries={promptTimeline} />
          ) : messageFilter === "responses" ? (
            <ul className="space-y-3">
              {responseTimeline.map((response) => (
                <li key={response.id} className="border-b border-white/8 px-1 pb-3">
                  <div className="flex items-center justify-between gap-3 text-[11px] text-slate-500">
                    <span>응답</span>
                    <span>{formatRelativeTime(response.timestamp)}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-200">{response.content || "응답이 비어 있습니다."}</p>
                </li>
              ))}
            </ul>
          ) : (
            <ConversationTimeline entries={conversationTimeline} />
          )}

          {messagesLoading ? (
            <div className="flex justify-center py-4">
              <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-white" />
            </div>
          ) : null}

          {showEmptyState ? (
            <div className="rounded-2xl border border-dashed border-white/15 px-4 py-4 text-center text-sm text-slate-300">
              {messageFilter === "runs"
                ? "표시할 실행 기록이 없습니다."
                : viewMode === "chat"
                  ? isDraft
                    ? "새 채팅창입니다. 첫 프롬프트를 입력해 작업을 시작해 주세요."
                    : "아직 대화가 없습니다. 첫 프롬프트를 입력해 작업을 시작해 보세요."
                  : "타임라인으로 정리할 대화가 없습니다. 새 프롬프트를 입력해 히스토리를 만들어 보세요."}
            </div>
          ) : null}

          {status ? (
            <div className="flex justify-center">
              <div className="flex items-center gap-2 rounded-full border border-white/10 bg-slate-950/70 px-3 py-1.5 text-[11px] text-slate-300">
                <span className={`h-2 w-2 rounded-full ${status.dotClassName}`} />
                <span>{status.label}</span>
                <span className="text-slate-500">{thread.progress}%</span>
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
	                {contextUsage?.percent !== null ? (
	                  <div className="rounded-full border border-white/8 bg-white/5 px-3 py-1 text-[11px] text-slate-300">
	                    {formatThreadContextUsage(thread)}
	                    {contextUsage.usedTokens !== null && contextUsage.windowTokens !== null
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

      <div className="sticky bottom-0 z-30 border-t border-white/10 bg-slate-950 px-4 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] pt-2">
        <div className="mx-auto w-full max-w-3xl">
          <InlineIssueComposer
            busy={submitBusy}
            selectedProject={project}
            onSubmit={onSubmitPrompt}
            label={isDraft ? "첫 프롬프트" : "프롬프트"}
            disabled={isInputDisabled}
          />
        </div>
      </div>
    </div>
  );
}

function MainPage({
  session,
  bridges,
  status,
  projects,
  threads,
  threadDetail,
  workspaceRoots,
  folderState,
  folderLoading,
  selectedWorkspacePath,
  selectedBridgeId,
  selectedProjectId,
  selectedThreadId,
  draftThreadProjectId,
  search,
  loadingState,
  projectBusy,
  threadBusy,
  renameBusy,
  utilityOpen,
  projectComposerOpen,
  installPromptVisible,
  installBusy,
  activeView,
  threadMessageFilter,
  onSearchChange,
  onChangeThreadMessageFilter,
  onSelectBridge,
  onSelectProject,
  onSelectThread,
  onOpenNewThread,
  onOpenUtility,
  onOpenProjectComposer,
  onInstallPwa,
  onDismissInstallPrompt,
  onCloseUtility,
  onCloseProjectComposer,
  onBrowseWorkspaceRoot,
  onBrowseFolder,
  onSelectWorkspace,
  onSubmitProject,
  onCreateThread,
  onAppendThreadMessage,
  onRenameThread,
  onDeleteThread,
  onDeleteProject,
  onRefreshThreadDetail,
  onRefresh,
  onLogout,
  onBackToInbox
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [threadBeingEdited, setThreadBeingEdited] = useState(null);
  const projectLongPressTimerRef = useRef(null);
  const projectLongPressTriggeredRef = useRef(false);
  const deferredSearch = useDeferredValue(search);
  const searchKeyword = deferredSearch.trim().toLowerCase();
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const draftProject = projects.find((project) => project.id === draftThreadProjectId) ?? null;
  const selectedThread = threads.find((thread) => thread.id === selectedThreadId) ?? null;
  const resolvedThread =
    selectedThread ??
    threadDetail?.thread ??
    (selectedThreadId
      ? {
          id: selectedThreadId,
          title: "새 채팅창",
          project_id: selectedProjectId || draftThreadProjectId || null,
          status: "running",
          progress: 10,
          last_event: "turn.starting",
          last_message: "",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          source: "appServer",
          turn_id: null
        }
      : null);
  const filteredThreads = useMemo(() => {
    return threads.filter((thread) => {
      const matchesProject = !selectedProjectId || thread.project_id === selectedProjectId;
      const matchesSearch =
        !searchKeyword ||
        thread.title.toLowerCase().includes(searchKeyword) ||
        thread.last_message.toLowerCase().includes(searchKeyword);

      return matchesProject && matchesSearch;
    });
  }, [searchKeyword, selectedProjectId, threads]);
  const bridgeLabel =
    bridges.find((bridge) => bridge.bridge_id === selectedBridgeId)?.device_name ??
    bridges.find((bridge) => bridge.bridge_id === selectedBridgeId)?.bridge_id ??
    "No Bridge";
  const threadDetailMessages = threadDetail?.messages ?? [];
  const threadDetailLoading = threadDetail?.loading ?? false;
  const threadDetailError = threadDetail?.error ?? "";
  const clearPendingProjectLongPress = useCallback(() => {
    if (projectLongPressTimerRef.current) {
      clearTimeout(projectLongPressTimerRef.current);
      projectLongPressTimerRef.current = null;
    }
  }, []);
  useEffect(
    () => () => {
      clearPendingProjectLongPress();
    },
    [clearPendingProjectLongPress]
  );
  const requestProjectDeletion = useCallback(
    (project) => {
      if (!project?.id || !onDeleteProject) {
        return;
      }

      if (typeof window !== "undefined") {
        const confirmMessage = project?.name
          ? `\"${project.name}\" 프로젝트를 삭제하시겠습니까? 해당 프로젝트의 이슈도 함께 제거됩니다.`
          : PROJECT_DELETE_CONFIRM_MESSAGE;

        if (!window.confirm(confirmMessage)) {
          return;
        }
      }

      void onDeleteProject(project.id);
    },
    [onDeleteProject]
  );
  const handleProjectChipPointerDown = useCallback(
    (event, project) => {
      if (!onDeleteProject || typeof window === "undefined" || !project) {
        return;
      }

      if (event?.pointerType === "touch" || event?.pointerType === "pen") {
        event.preventDefault();
      }

      projectLongPressTriggeredRef.current = false;
      clearPendingProjectLongPress();

      projectLongPressTimerRef.current = window.setTimeout(() => {
        projectLongPressTimerRef.current = null;
        projectLongPressTriggeredRef.current = true;
        requestProjectDeletion(project);
      }, PROJECT_CHIP_LONG_PRESS_MS);
    },
    [clearPendingProjectLongPress, onDeleteProject, requestProjectDeletion]
  );
  const handleProjectChipPointerCancel = useCallback(() => {
    if (projectLongPressTimerRef.current) {
      clearPendingProjectLongPress();
      projectLongPressTriggeredRef.current = false;
    }
  }, [clearPendingProjectLongPress]);
  const handleProjectChipClick = useCallback(
    (projectId) => {
      if (projectLongPressTriggeredRef.current) {
        projectLongPressTriggeredRef.current = false;
        return;
      }

      onSelectProject(projectId);
    },
    [onSelectProject]
  );

  if (activeView === "thread" && (resolvedThread || draftProject || selectedThreadId)) {
    const threadProject =
      projects.find((project) => project.id === resolvedThread?.project_id) ??
      draftProject ??
      selectedProject;

    return (
      <div className="telegram-shell min-h-screen bg-slate-950 text-slate-100">
        <ThreadDetail
          thread={resolvedThread}
          project={threadProject}
          messages={resolvedThread ? threadDetailMessages : []}
          issues={resolvedThread ? threadDetail?.issues ?? [] : []}
          messagesLoading={threadDetailLoading}
          messagesError={threadDetailError}
          onRefreshMessages={resolvedThread?.id ? onRefreshThreadDetail : null}
          onSubmitPrompt={(payload) => {
            if (resolvedThread?.id) {
              return onAppendThreadMessage(resolvedThread.id, payload.prompt);
            }

            return onCreateThread(payload, { stayOnThread: true });
          }}
          submitBusy={threadBusy}
          onBack={onBackToInbox}
          messageFilter={threadMessageFilter}
          onChangeMessageFilter={onChangeThreadMessageFilter}
          isDraft={!selectedThread && !threadDetail?.thread}
        />
      </div>
    );
  }

  return (
    <div className="telegram-shell min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col">
        <header className="sticky top-0 z-20 border-b border-white/10 bg-slate-950 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={onOpenUtility}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-white/5 text-white transition hover:bg-white/10"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M4 7h16M4 12h16M4 17h10" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
              </svg>
            </button>

            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-semibold text-white">OctOP Pocket</h1>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-400">
                <span className="truncate">{bridgeLabel}</span>
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    status.app_server?.connected ? "bg-emerald-300" : "bg-rose-300"
                  }`}
                />
                <span>{status.app_server?.connected ? "연결됨" : "미연결"}</span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setSearchOpen((current) => !current)}
              className={`flex h-10 w-10 items-center justify-center rounded-full transition ${
                searchOpen ? "bg-white text-slate-900" : "bg-white/5 text-white hover:bg-white/10"
              }`}
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
              </svg>
            </button>
          </div>

          {searchOpen ? (
            <div className="mt-3 flex items-center gap-3 border-t border-white/10 pt-3">
              <svg className="h-4 w-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder="채팅창 검색"
                className="w-full border-none bg-transparent p-0 text-sm text-white outline-none ring-0 placeholder:text-slate-500 focus:ring-0"
              />
            </div>
          ) : null}
        </header>

        <InstallPromptBanner
          visible={installPromptVisible}
          installing={installBusy}
          onInstall={onInstallPwa}
          onDismiss={onDismissInstallPrompt}
        />

        <main className="flex-1 px-4 pb-28 pt-2">
          <div className="border-b border-white/10 pb-3">
            <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
              {projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => handleProjectChipClick(project.id)}
                  onPointerDown={(event) => handleProjectChipPointerDown(event, project)}
                  onPointerUp={handleProjectChipPointerCancel}
                  onPointerLeave={handleProjectChipPointerCancel}
                  onPointerCancel={handleProjectChipPointerCancel}
                  onContextMenu={(event) => event.preventDefault()}
                  className={`shrink-0 rounded-full px-3 py-1.5 text-[13px] font-medium transition select-none touch-manipulation ${
                    project.id === selectedProjectId
                      ? "bg-white text-slate-900"
                      : "bg-transparent text-slate-400 hover:text-white"
                  }`}
                >
                  {project.name}
                </button>
              ))}
            </div>
          </div>

          <section className="mt-1">
            {filteredThreads.length === 0 ? (
              <div className="px-2 py-10 text-center text-sm leading-7 text-slate-400">
                {loadingState === "loading"
                  ? "데이터를 동기화하고 있습니다."
                  : "조건에 맞는 채팅창이 없습니다. 새 채팅창을 열어 작업을 시작해 주세요."}
              </div>
            ) : (
              filteredThreads.map((thread) => (
                <ThreadListItem
                  key={thread.id}
                  thread={thread}
                  active={thread.id === selectedThreadId}
                  onOpen={onSelectThread}
                  onRename={(targetThread) => setThreadBeingEdited(targetThread)}
                  onDelete={(targetThread) => void onDeleteThread(targetThread.id)}
                />
              ))
            )}
          </section>
        </main>

        <div className="fixed inset-x-0 bottom-0 z-30 mx-auto flex w-full max-w-3xl justify-center border-t border-white/10 bg-slate-950/92 px-4 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] pt-2 backdrop-blur">
          <button
            type="button"
            onClick={() => onOpenNewThread(selectedProjectId)}
            disabled={!selectedProject}
            className="w-full rounded-full bg-telegram-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-45"
          >
            새 채팅창
          </button>
        </div>
      </div>

      <ThreadRenameDialog
        open={Boolean(threadBeingEdited)}
        busy={renameBusy}
        thread={threadBeingEdited}
        onClose={() => setThreadBeingEdited(null)}
        onSubmit={(title) => onRenameThread(threadBeingEdited?.id, title)}
      />
      <UtilitySheet
        open={utilityOpen}
        session={session}
        status={status}
        bridges={bridges}
        selectedBridgeId={selectedBridgeId}
        projects={projects}
        threads={threads}
        onClose={onCloseUtility}
        onSelectBridge={onSelectBridge}
        onOpenProjectComposer={onOpenProjectComposer}
        onRefresh={onRefresh}
        onLogout={onLogout}
      />
      <ProjectComposerSheet
        open={projectComposerOpen}
        busy={projectBusy}
        roots={workspaceRoots}
        folderState={folderState}
        folderLoading={folderLoading}
        selectedWorkspacePath={selectedWorkspacePath}
        onBrowseRoot={onBrowseWorkspaceRoot}
        onBrowseFolder={onBrowseFolder}
        onSelectWorkspace={onSelectWorkspace}
        onClose={onCloseProjectComposer}
        onSubmit={onSubmitProject}
      />
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(() => (typeof window === "undefined" ? null : readStoredSession()));
  const [loginState, setLoginState] = useState({ loading: false, error: "" });
  const [bridges, setBridges] = useState([]);
  const [status, setStatus] = useState({
    app_server: {
      connected: false,
      initialized: false,
      account: null,
      last_error: null
    },
    updated_at: null
  });
  const [projects, setProjects] = useState([]);
  const [threads, setThreads] = useState([]);
  const [threadDetails, setThreadDetails] = useState({});
  const [workspaceRoots, setWorkspaceRoots] = useState([]);
  const [folderState, setFolderState] = useState({ path: "", parent_path: null, entries: [] });
  const [folderLoading, setFolderLoading] = useState(false);
  const [selectedWorkspacePath, setSelectedWorkspacePath] = useState("");
  const [selectedBridgeId, setSelectedBridgeId] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [draftThreadProjectId, setDraftThreadProjectId] = useState("");
  const [search, setSearch] = useState("");
  const [loadingState, setLoadingState] = useState("idle");
  const [utilityOpen, setUtilityOpen] = useState(false);
  const [projectComposerOpen, setProjectComposerOpen] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const [threadBusy, setThreadBusy] = useState(false);
  const [renameBusy, setRenameBusy] = useState(false);
  const [activeView, setActiveView] = useState("inbox");
  const [threadMessageFilter, setThreadMessageFilter] = useState("all");
  const [deferredInstallPrompt, setDeferredInstallPrompt] = useState(null);
  const [installPromptVisible, setInstallPromptVisible] = useState(false);
  const [installBusy, setInstallBusy] = useState(false);
  const [pwaUpdateVisible, setPwaUpdateVisible] = useState(false);
  const [pwaUpdateBusy, setPwaUpdateBusy] = useState(false);
  const pendingUpdateActivatorRef = useRef(null);
  const threadLoadRequestIdRef = useRef(0);
  const threadReloadTimerRef = useRef(null);
  const selectedThreadIdRef = useRef("");
  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [threads, selectedThreadId]
  );
  const currentThreadDetail = threadDetails[selectedThreadId] ?? null;
  const currentThreadDetailVersion = currentThreadDetail?.version ?? null;
  const currentThreadDetailLoading = currentThreadDetail?.loading ?? false;
  const currentThreadDetailHasMessages = (currentThreadDetail?.messages?.length ?? 0) > 0;
  const hasCurrentThreadDetail = Boolean(currentThreadDetail);
  const selectedThreadUpdatedAt = selectedThread?.updated_at ?? null;

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  useEffect(() => {
    return () => {
      if (threadReloadTimerRef.current) {
        window.clearTimeout(threadReloadTimerRef.current);
        threadReloadTimerRef.current = null;
      }
    };
  }, []);

  const loadThreadMessages = useCallback(
    async (threadId, { force = false, version = null } = {}) => {
      if (!session?.loginId || !selectedBridgeId || !threadId) {
        return;
      }

      const requestId = threadLoadRequestIdRef.current + 1;
      threadLoadRequestIdRef.current = requestId;

      setThreadDetails((current) => {
        const currentEntry = current[threadId];

        if (!force && currentEntry?.loading) {
          return current;
        }

        return {
          ...current,
          [threadId]: {
            ...currentEntry,
            loading: true,
            error: "",
            messages: currentEntry?.messages ?? [],
            version: currentEntry?.version ?? null
          }
        };
      });

      try {
        const issueList = await apiRequest(
          `/api/threads/${threadId}/issues?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`
        );
        const issues = [...(issueList?.issues ?? [])].sort(
          (left, right) => Date.parse(left.created_at) - Date.parse(right.created_at)
        );
        const details = await Promise.all(
          issues.map((issue) =>
            apiRequest(
              `/api/issues/${issue.id}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`
            )
          )
        );
        const messages = details.flatMap((detail, issueIndex) =>
          (detail?.messages ?? []).map((message, messageIndex) => ({
            ...message,
            id: message.id ?? `${detail?.issue?.id ?? issues[issueIndex]?.id}-${messageIndex}`,
            issue_id: detail?.issue?.id ?? issues[issueIndex]?.id ?? null,
            issue_title: detail?.issue?.title ?? issues[issueIndex]?.title ?? "",
            issue_status: detail?.issue?.status ?? issues[issueIndex]?.status ?? "staged"
          }))
        );
        const latestThread =
          details.at(-1)?.thread ??
          threads.find((thread) => thread.id === threadId) ??
          null;

        if (threadLoadRequestIdRef.current !== requestId || selectedThreadIdRef.current !== threadId) {
          return;
        }

        setThreadDetails((current) => ({
          ...current,
          [threadId]: {
            loading: false,
            error: "",
            messages,
            issues,
            thread: latestThread ?? current[threadId]?.thread ?? null,
            fetchedAt: Date.now(),
            version:
              version ??
              latestThread?.updated_at ??
              latestThread?.created_at ??
              current[threadId]?.version ??
              null
          }
        }));
      } catch (error) {
        if (threadLoadRequestIdRef.current !== requestId || selectedThreadIdRef.current !== threadId) {
          return;
        }

        setThreadDetails((current) => ({
          ...current,
          [threadId]: {
            ...current[threadId],
            loading: false,
            error: error.message ?? "메시지를 불러오지 못했습니다."
          }
        }));
      }
    },
    [selectedBridgeId, session?.loginId, threads]
  );

  const scheduleThreadMessagesReload = useCallback((threadId, options = {}) => {
    if (!threadId) {
      return;
    }

    const { delay = 180, ...loadOptions } = options;

    if (threadReloadTimerRef.current) {
      window.clearTimeout(threadReloadTimerRef.current);
      threadReloadTimerRef.current = null;
    }

    threadReloadTimerRef.current = window.setTimeout(() => {
      threadReloadTimerRef.current = null;
      void loadThreadMessages(threadId, loadOptions);
    }, delay);
  }, [loadThreadMessages]);

  async function loadBridges(sessionArg) {
    if (!sessionArg?.loginId) {
      return [];
    }

    const nextBridges = (await apiRequest(
      `/api/bridges?login_id=${encodeURIComponent(sessionArg.loginId)}`
    )).bridges ?? [];

    setBridges(nextBridges);
    setSelectedBridgeId((current) => {
      if (current && nextBridges.some((bridge) => bridge.bridge_id === current)) {
        return current;
      }

      return nextBridges[0]?.bridge_id ?? "";
    });

    return nextBridges;
  }

  async function loadBridgeWorkspace(sessionArg, bridgeId) {
    if (!sessionArg?.loginId || !bridgeId) {
      setProjects([]);
      setThreads([]);
      setStatus({
        app_server: {
          connected: false,
          initialized: false,
          account: null,
          last_error: null
        },
        updated_at: null
      });
      return;
    }

    setLoadingState("loading");

    try {
      const [nextStatus, nextProjects] = await Promise.all([
        apiRequest(
          `/api/bridge/status?login_id=${encodeURIComponent(sessionArg.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`
        ),
        apiRequest(
          `/api/projects?login_id=${encodeURIComponent(sessionArg.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`
        )
      ]);

      setStatus(nextStatus);
      setProjects(nextProjects.projects ?? []);
      const nextProjectId =
        selectedProjectId && nextProjects.projects?.some((project) => project.id === selectedProjectId)
          ? selectedProjectId
          : nextProjects.projects?.[0]?.id || "";

      setSelectedProjectId(nextProjectId);

      if (nextProjectId) {
        const nextThreads = await loadProjectThreads(sessionArg, bridgeId, nextProjectId);
        setSelectedThreadId((current) =>
          current && nextThreads.some((thread) => thread.id === current) ? current : nextThreads[0]?.id || ""
        );
      } else {
        setThreads([]);
        setSelectedThreadId("");
      }

      setLoadingState("ready");
    } catch (error) {
      setLoadingState("error");
    }
  }

  async function loadProjectThreads(sessionArg, bridgeId, projectId) {
    if (!sessionArg?.loginId || !bridgeId || !projectId) {
      setThreads([]);
      return [];
    }

    const payload = await apiRequest(
      `/api/projects/${projectId}/threads?login_id=${encodeURIComponent(sessionArg.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`
    );

    setThreads(mergeThreads([], payload?.threads ?? []));
    return payload?.threads ?? [];
  }

  async function loadWorkspaceRoots(sessionArg, bridgeId) {
    if (!sessionArg?.loginId || !bridgeId) {
      setWorkspaceRoots([]);
      return [];
    }

    const payload = await apiRequest(
      `/api/workspace-roots?login_id=${encodeURIComponent(sessionArg.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`
    );
    const roots = payload?.roots ?? [];
    setWorkspaceRoots(roots);
    return roots;
  }

  async function browseWorkspacePath(path, bridgeIdArg = selectedBridgeId) {
    if (!session?.loginId || !bridgeIdArg) {
      return null;
    }

    setFolderLoading(true);

    try {
      const query = new URLSearchParams({
        login_id: session.loginId,
        bridge_id: bridgeIdArg
      });

      if (path) {
        query.set("path", path);
      }

      const payload = await apiRequest(`/api/folders?${query.toString()}`);
      setFolderState({
        path: payload?.path ?? "",
        parent_path: payload?.parent_path ?? null,
        entries: payload?.entries ?? []
      });
      return payload;
    } finally {
      setFolderLoading(false);
    }
  }

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const isStandalone =
      window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;

    if (isStandalone || isPwaPromptDismissed()) {
      return undefined;
    }

    const handleBeforeInstallPrompt = (event) => {
      event.preventDefault();
      setDeferredInstallPrompt(event);
      setInstallPromptVisible(true);
    };

    const handleAppInstalled = () => {
      setDeferredInstallPrompt(null);
      setInstallPromptVisible(false);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const syncPendingUpdateActivator = (activate = null) => {
      pendingUpdateActivatorRef.current = typeof activate === "function" ? activate : null;
      setPwaUpdateBusy(false);
      setPwaUpdateVisible(Boolean(pendingUpdateActivatorRef.current));
    };

    const handleUpdateReady = (event) => {
      const activate = event?.detail?.activate ?? window[PWA_UPDATE_ACTIVATOR_KEY] ?? null;
      syncPendingUpdateActivator(activate);
    };

    if (typeof window[PWA_UPDATE_ACTIVATOR_KEY] === "function") {
      syncPendingUpdateActivator(window[PWA_UPDATE_ACTIVATOR_KEY]);
    }

    window.addEventListener(PWA_UPDATE_READY_EVENT, handleUpdateReady);

    return () => {
      window.removeEventListener(PWA_UPDATE_READY_EVENT, handleUpdateReady);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !window.history?.pushState) {
      return undefined;
    }

    const handlePopState = (event) => {
      event?.preventDefault?.();
      window.history.pushState(null, "", window.location.href);
    };

    window.history.pushState(null, "", window.location.href);
    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return undefined;
    }

    let touchStartY = 0;
    let scrollTarget = null;

    const resolveScrollTarget = (node) => {
      let current = node instanceof HTMLElement ? node : node?.parentElement ?? null;

      while (current) {
        const style = window.getComputedStyle(current);
        const overflowY = style.overflowY;

        if ((overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") && current.scrollHeight > current.clientHeight) {
          return current;
        }

        current = current.parentElement;
      }

      return document.scrollingElement ?? document.documentElement;
    };

    const handleTouchStart = (event) => {
      if (event.touches.length !== 1) {
        scrollTarget = null;
        return;
      }

      touchStartY = event.touches[0].clientY;
      scrollTarget = resolveScrollTarget(event.target);
    };

    const handleTouchMove = (event) => {
      if (event.touches.length !== 1 || !scrollTarget) {
        return;
      }

      const currentY = event.touches[0].clientY;
      const deltaY = currentY - touchStartY;
      touchStartY = currentY;

      const scrollContainer =
        scrollTarget === document.scrollingElement || scrollTarget === document.documentElement
          ? document.scrollingElement ?? document.documentElement
          : scrollTarget;
      const scrollTop = scrollContainer ? scrollContainer.scrollTop : 0;

      if (deltaY > 0 && scrollTop <= 0) {
        event.preventDefault();
      }
    };

    window.addEventListener("touchstart", handleTouchStart, { passive: true });
    window.addEventListener("touchmove", handleTouchMove, { passive: false });

    return () => {
      window.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchmove", handleTouchMove);
    };
  }, []);

  useEffect(() => {
    if (!session?.loginId) {
      return;
    }

    void loadBridges(session);
  }, [session]);

  useEffect(() => {
    if (!session?.loginId || !selectedBridgeId) {
      return undefined;
    }

    const eventSource = new EventSource(
      `${API_BASE_URL}/api/events?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`
    );

    eventSource.addEventListener("snapshot", (event) => {
      try {
        const payload = JSON.parse(event.data);
        setStatus(payload);
      } catch {
        // ignore malformed snapshot
      }
    });

    eventSource.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(event.data);
        const { threadId: eventThreadId, issueId: eventIssueId } = getLiveEventContext(payload);

        if (eventThreadId) {
          setThreads((current) => upsertLiveThread(current, payload));
        }

        if (eventThreadId && eventThreadId === selectedThreadId) {
          setThreadDetails((current) => {
            const currentEntry = current[eventThreadId];

            if (!currentEntry) {
              return current;
            }

            const nextThread = currentEntry.thread
              ? {
                  ...currentEntry.thread,
                  ...(buildLiveThreadPatch(payload, currentEntry.thread) ?? {})
                }
              : currentEntry.thread;

            return {
              ...current,
              [eventThreadId]: {
                ...currentEntry,
                thread: nextThread,
                messages: appendLiveAssistantMessage(currentEntry.messages ?? [], payload, {
                  issue_id: eventIssueId,
                  issue_title: currentEntry.issues?.find((issue) => issue.id === eventIssueId)?.title ?? "",
                  issue_status: currentEntry.issues?.find((issue) => issue.id === eventIssueId)?.status ?? "running"
                })
              }
            };
          });
        }

        if (payload.type === "bridge.status.updated") {
          setStatus(payload.payload);
          return;
        }

        if (payload.type === "bridge.projects.updated") {
          const nextProjects = payload.payload?.projects ?? [];
          setProjects(nextProjects);
          setSelectedProjectId((current) => {
            if (current && nextProjects.some((project) => project.id === current)) {
              return current;
            }

            return nextProjects[0]?.id || "";
          });
          return;
        }

        if (payload.type === "bridge.projectThreads.updated") {
          const projectId = payload.payload?.project_id ?? "";

          if (!projectId || projectId === selectedProjectId) {
            setThreads(mergeThreads([], payload.payload?.threads ?? []));
          }

          if (selectedThreadId && payload.payload?.threads?.some((thread) => thread.id === selectedThreadId)) {
            const matched = payload.payload.threads.find((thread) => thread.id === selectedThreadId);
            if (matched) {
              setThreadDetails((current) => ({
                ...current,
                [selectedThreadId]: {
                  ...(current[selectedThreadId] ?? {}),
                  thread: normalizeThread(matched)
                }
              }));
            }
          }
          return;
        }

        if (payload.type === "bridge.threadIssues.updated") {
          const threadId = payload.payload?.thread_id ?? "";

          if (threadId && threadId === selectedThreadId) {
            setThreadDetails((current) => ({
              ...current,
              [threadId]: {
                ...(current[threadId] ?? {}),
                issues: payload.payload?.issues ?? current[threadId]?.issues ?? []
              }
            }));
            scheduleThreadMessagesReload(threadId, { force: true });
          }
          return;
        }

        if (
          eventThreadId &&
          eventThreadId === selectedThreadId &&
          (payload.type === "turn.completed" || payload.type === "thread.status.changed")
        ) {
          scheduleThreadMessagesReload(eventThreadId, { force: true, delay: 0 });
          return;
        }

        if (payload.payload?.thread) {
          const incomingThread = normalizeThread(payload.payload.thread);

          if (!incomingThread) {
            return;
          }

          if (selectedThreadId === incomingThread.id) {
            setThreadDetails((current) => ({
              ...current,
              [incomingThread.id]: {
                ...(current[incomingThread.id] ?? {}),
                thread: incomingThread
              }
            }));
          }

          if (!selectedProjectId || incomingThread.project_id === selectedProjectId) {
            setThreads((current) => upsertThread(current, incomingThread));
          }
        }
      } catch {
        // ignore malformed event payload
      }
    });

    return () => {
      eventSource.close();
    };
  }, [loadThreadMessages, scheduleThreadMessagesReload, selectedBridgeId, selectedProjectId, selectedThreadId, session]);

  useEffect(() => {
    if (!session?.loginId) {
      return;
    }

    void loadBridgeWorkspace(session, selectedBridgeId);
  }, [session, selectedBridgeId]);

  useEffect(() => {
    if (!session?.loginId || !selectedBridgeId || !selectedProjectId) {
      return;
    }

    void loadProjectThreads(session, selectedBridgeId, selectedProjectId);
  }, [selectedBridgeId, selectedProjectId, session]);

  useEffect(() => {
    if (!session?.loginId || !selectedBridgeId || !projectComposerOpen) {
      return;
    }

    void (async () => {
      const roots = await loadWorkspaceRoots(session, selectedBridgeId);
      const currentProjectWorkspace =
        projects.find((project) => project.id === selectedProjectId)?.workspace_path ?? "";
      const preferredPath =
        currentProjectWorkspace ||
        roots[0]?.path ||
        "";

      setSelectedWorkspacePath((current) => current || preferredPath);
      await browseWorkspacePath(preferredPath, selectedBridgeId);
    })();
  }, [projectComposerOpen, projects, selectedBridgeId, selectedProjectId, session]);

  useEffect(() => {
    if (
      !session?.loginId ||
      !selectedBridgeId ||
      !selectedThreadId ||
      activeView !== "thread"
    ) {
      return;
    }

    if (currentThreadDetailLoading) {
      return;
    }

    if (!hasCurrentThreadDetail || currentThreadDetailVersion !== selectedThreadUpdatedAt) {
      scheduleThreadMessagesReload(selectedThreadId, { version: selectedThreadUpdatedAt, delay: 0 });
    }
  }, [
    activeView,
    currentThreadDetailLoading,
    currentThreadDetailVersion,
    hasCurrentThreadDetail,
    scheduleThreadMessagesReload,
    selectedBridgeId,
    selectedThreadId,
    selectedThreadUpdatedAt,
    session?.loginId
  ]);

  useEffect(() => {
    threadLoadRequestIdRef.current += 1;

    setSelectedProjectId("");
    setSelectedThreadId("");
    setDraftThreadProjectId("");
    setWorkspaceRoots([]);
    setFolderState({ path: "", parent_path: null, entries: [] });
    setSelectedWorkspacePath("");
    setActiveView("inbox");
  }, [selectedBridgeId]);

  useEffect(() => {
    threadLoadRequestIdRef.current += 1;
  }, [selectedThreadId]);

  useEffect(() => {
    if (!selectedProjectId && projects.length > 0) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId]);

  useEffect(() => {
    if (!selectedThreadId && threads.length > 0) {
      return;
    }

    if (selectedThreadId && !threads.some((thread) => thread.id === selectedThreadId)) {
      setSelectedThreadId(threads[0]?.id ?? "");
    }
  }, [selectedThreadId, threads]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }

    const projectThreads = threads.filter((thread) => thread.project_id === selectedProjectId);

    if (projectThreads.length === 0) {
      setSelectedThreadId("");
      return;
    }

    if (!selectedThreadId) {
      if (draftThreadProjectId === selectedProjectId) {
        return;
      }

      setSelectedThreadId(projectThreads[0]?.id ?? "");
      return;
    }

    if (!projectThreads.some((thread) => thread.id === selectedThreadId)) {
      setSelectedThreadId(projectThreads[0]?.id ?? "");
      return;
    }

    if (draftThreadProjectId === selectedProjectId) {
      setDraftThreadProjectId("");
    }
  }, [draftThreadProjectId, selectedProjectId, selectedThreadId, threads]);

  const handleLogin = async ({ loginId, password, rememberDevice }) => {
    setLoginState({ loading: true, error: "" });

    try {
      const auth = await apiRequest("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          loginId,
          password
        })
      });

      const nextSession = {
        accessToken: auth.accessToken,
        expiresAt: auth.expiresAt,
        role: auth.role,
        userId: auth.userId,
        displayName: auth.displayName,
        permissions: auth.permissions ?? [],
        loginId
      };

      storeSession(nextSession, rememberDevice);
      setSession(nextSession);
      setLoginState({ loading: false, error: "" });
    } catch (error) {
      setLoginState({ loading: false, error: error.message });
    }
  };

  const handleLogout = () => {
    clearSessionStorage();
    setSession(null);
    setBridges([]);
    setProjects([]);
    setThreads([]);
    setThreadDetails({});
    setWorkspaceRoots([]);
    setFolderState({ path: "", parent_path: null, entries: [] });
    setSelectedWorkspacePath("");
    setSelectedProjectId("");
    setSelectedThreadId("");
    setDraftThreadProjectId("");
    setSearch("");
    setUtilityOpen(false);
    setProjectComposerOpen(false);
    setActiveView("inbox");
  };

  const handleCreateThread = async (payload, options = {}) => {
    if (!session?.loginId || !selectedBridgeId) {
      return;
    }

    setThreadBusy(true);

    try {
      const projectId = payload.project_id ?? draftThreadProjectId ?? selectedProjectId;

      if (!projectId) {
        throw new Error("프로젝트를 먼저 선택해 주세요.");
      }

      const createdThread = await apiRequest(
        `/api/projects/${projectId}/threads?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "POST",
          body: JSON.stringify({
            name: createThreadTitleFromPrompt(payload.prompt) || "새 채팅창"
          })
        }
      );
      const threadId = createdThread?.thread?.id;

      if (!threadId) {
        throw new Error("새 채팅창을 생성하지 못했습니다.");
      }

      const createdIssue = await apiRequest(
        `/api/threads/${threadId}/issues?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "POST",
          body: JSON.stringify(payload)
        }
      );
      const issueId = createdIssue?.issue?.id;
      const optimisticTimestamp = new Date().toISOString();
      const optimisticThread = createdThread?.thread
        ? {
            ...createdThread.thread,
            status: "running",
            progress: 10,
            last_event: "turn.starting",
            updated_at: optimisticTimestamp
          }
        : null;
      const optimisticIssue = createdIssue?.issue
        ? {
            ...createdIssue.issue,
            status: "running",
            progress: 10,
            last_event: "turn.starting",
            updated_at: optimisticTimestamp
          }
        : null;
      const optimisticMessages = optimisticIssue
        ? [
            {
              id: createId(),
              role: "user",
              kind: "prompt",
              content: optimisticIssue.prompt ?? payload.prompt ?? "",
              timestamp: optimisticTimestamp,
              issue_id: optimisticIssue.id,
              issue_title: optimisticIssue.title ?? payload.title ?? "",
              issue_status: optimisticIssue.status
            }
          ]
        : [];

      const stayOnThread = Boolean(options?.stayOnThread);

      if (threadId) {
        if (optimisticThread) {
          setThreads((current) => upsertThread(current, optimisticThread));
          setThreadDetails((current) => ({
            ...current,
            [threadId]: {
              ...(current[threadId] ?? {}),
              thread: optimisticThread,
              issues: optimisticIssue ? [optimisticIssue] : current[threadId]?.issues ?? [],
              messages: optimisticMessages,
              loading: false,
              error: ""
            }
          }));
        } else {
          setThreads((current) => upsertThread(current, createdThread.thread));
        }
        setSelectedThreadId(threadId);
        setDraftThreadProjectId("");
        setThreadMessageFilter("all");

        if (issueId) {
          await apiRequest(
            `/api/threads/${threadId}/issues/start?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
            {
              method: "POST",
              body: JSON.stringify({
                issue_ids: [issueId]
              })
            }
          );
        }
      }

      if (stayOnThread && threadId) {
        setActiveView("thread");
        void loadThreadMessages(threadId, { force: true });
      } else {
        setActiveView("inbox");
      }
      return true;
    } catch (error) {
      if (typeof window !== "undefined") {
        window.alert(error.message);
      }
      return false;
    } finally {
      setThreadBusy(false);
    }
  };

  const handleAppendThreadMessage = async (threadId, prompt) => {
    if (!session?.loginId || !selectedBridgeId || !threadId) {
      return false;
    }

    setThreadBusy(true);

    try {
      const createdIssue = await apiRequest(
        `/api/threads/${threadId}/issues?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "POST",
          body: JSON.stringify({ prompt })
        }
      );
      const issueId = createdIssue?.issue?.id;
      const optimisticTimestamp = new Date().toISOString();
      const optimisticIssue = createdIssue?.issue
        ? {
            ...createdIssue.issue,
            status: "running",
            progress: 10,
            last_event: "turn.starting",
            updated_at: optimisticTimestamp
          }
        : null;

      setThreads((current) => {
        const currentThread = current.find((thread) => thread.id === threadId);

        if (!currentThread) {
          return current;
        }

        return upsertThread(current, {
          ...currentThread,
          status: "running",
          progress: Math.max(currentThread.progress ?? 0, 10),
          last_event: "turn.starting",
          updated_at: optimisticTimestamp
        });
      });
      setThreadDetails((current) => {
        const currentEntry = current[threadId] ?? {};
        const nextMessages = [
          ...(currentEntry.messages ?? []),
          {
            id: createId(),
            role: "user",
            kind: "prompt",
            content: prompt,
            timestamp: optimisticTimestamp,
            issue_id: optimisticIssue?.id ?? null,
            issue_title: optimisticIssue?.title ?? createThreadTitleFromPrompt(prompt),
            issue_status: optimisticIssue?.status ?? "running"
          }
        ];

        return {
          ...current,
          [threadId]: {
            ...currentEntry,
            thread: currentEntry.thread
              ? {
                  ...currentEntry.thread,
                  status: "running",
                  progress: Math.max(currentEntry.thread.progress ?? 0, 10),
                  last_event: "turn.starting",
                  updated_at: optimisticTimestamp
                }
              : currentEntry.thread,
            issues: optimisticIssue
              ? [...(currentEntry.issues ?? []).filter((issue) => issue.id !== optimisticIssue.id), optimisticIssue]
              : currentEntry.issues ?? [],
            messages: nextMessages,
            loading: false,
            error: ""
          }
        };
      });
      setThreadMessageFilter("all");
      setActiveView("thread");

      if (issueId) {
        await apiRequest(
          `/api/threads/${threadId}/issues/start?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
          {
            method: "POST",
            body: JSON.stringify({ issue_ids: [issueId] })
          }
        );
      }
      void loadThreadMessages(threadId, { force: true });
      return true;
    } catch (error) {
      if (typeof window !== "undefined") {
        window.alert(error.message);
      }
      return false;
    } finally {
      setThreadBusy(false);
    }
  };

  const handleRenameThread = async (threadId, title) => {
    if (!session?.loginId || !selectedBridgeId || !threadId) {
      return false;
    }

    setRenameBusy(true);

    try {
      const response = await apiRequest(
        `/api/threads/${threadId}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ name: title })
        }
      );

      if (response?.thread) {
        setThreads((current) => upsertThread(current, response.thread));
        setThreadDetails((current) => ({
          ...current,
          [threadId]: {
            ...(current[threadId] ?? {}),
            thread: response.thread
          }
        }));
      }

      return true;
    } catch (error) {
      if (typeof window !== "undefined") {
        window.alert(error.message);
      }
      return false;
    } finally {
      setRenameBusy(false);
    }
  };

  const handleDeleteThread = async (threadId) => {
    if (!session?.loginId || !selectedBridgeId || !threadId) {
      return false;
    }

    if (typeof window !== "undefined" && !window.confirm("이 채팅창을 삭제하시겠습니까?")) {
      return false;
    }

    try {
      await apiRequest(
        `/api/threads/${threadId}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "DELETE"
        }
      );

      setThreads((current) => current.filter((thread) => thread.id !== threadId));
      setThreadDetails((current) => {
        const next = { ...current };
        delete next[threadId];
        return next;
      });

      if (selectedThreadId === threadId) {
        setSelectedThreadId("");
        setActiveView("inbox");
      }

      return true;
    } catch (error) {
      if (typeof window !== "undefined") {
        window.alert(error.message);
      }
      return false;
    }
  };

  const handleDeleteProject = async (projectId) => {
    if (!session?.loginId || !selectedBridgeId || !projectId) {
      return false;
    }

    try {
      const response = await apiRequest(
        `/api/projects/${projectId}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "DELETE"
        }
      );
      const updatedProjects = Array.isArray(response?.projects)
        ? response.projects
        : projects.filter((project) => project.id !== projectId);

      if (Array.isArray(response?.projects)) {
        setProjects(response.projects);
      } else {
        setProjects(updatedProjects);
      }

      if (Array.isArray(response?.threads)) {
        setThreads(mergeThreads([], response.threads));
      } else {
        setThreads((current) => current.filter((thread) => thread.project_id !== projectId));
      }

      setThreadDetails((current) => {
        const next = { ...current };
        Object.keys(next).forEach((threadKey) => {
          const entry = next[threadKey];
          const entryProjectId =
            entry?.thread?.project_id ?? threads.find((thread) => thread.id === threadKey)?.project_id ?? null;

          if (entryProjectId === projectId) {
            delete next[threadKey];
          }
        });
        return next;
      });

      if (selectedProjectId === projectId) {
        const fallbackProjectId = updatedProjects[0]?.id ?? "";
        setSelectedProjectId(fallbackProjectId);
        setSelectedThreadId("");
        setActiveView("inbox");
      }

      setDraftThreadProjectId((current) => (current === projectId ? "" : current));

      return true;
    } catch (error) {
      if (typeof window !== "undefined") {
        window.alert(error.message);
      }
      return false;
    }
  };

  const handleCreateProject = async (payload) => {
    if (!session?.loginId || !selectedBridgeId) {
      return;
    }

    setProjectBusy(true);

    try {
      const response = await apiRequest(
        `/api/projects?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "POST",
          body: JSON.stringify(payload)
        }
      );

      const nextProjects = response?.projects ?? null;
      const createdProject = response?.project ?? null;

      if (Array.isArray(nextProjects)) {
        setProjects(nextProjects);
      } else if (createdProject?.id) {
        setProjects((current) => {
          const exists = current.some((project) => project.id === createdProject.id);
          return exists ? current : [createdProject, ...current];
        });
      }

      if (createdProject?.id) {
        setSelectedProjectId(createdProject.id);
      }

      setSelectedWorkspacePath("");
      setProjectComposerOpen(false);
    } catch (error) {
      if (typeof window !== "undefined") {
        window.alert(error.message);
      }
    } finally {
      setProjectBusy(false);
    }
  };

  const handleRefresh = async () => {
    if (!session?.loginId) {
      return;
    }

    const nextBridges = await loadBridges(session);
    const targetBridgeId = selectedBridgeId || nextBridges[0]?.bridge_id;

    if (targetBridgeId) {
      await loadBridgeWorkspace(session, targetBridgeId);
    }
  };

  const handleOpenProjectComposer = async () => {
    setProjectComposerOpen(true);
    setSelectedWorkspacePath("");
    setFolderState({ path: "", parent_path: null, entries: [] });

    if (!session?.loginId || !selectedBridgeId) {
      return;
    }

    const roots = await loadWorkspaceRoots(session, selectedBridgeId);
    const preferredPath =
      projects.find((project) => project.id === selectedProjectId)?.workspace_path ??
      roots[0]?.path ??
      "";

    if (preferredPath) {
      setSelectedWorkspacePath(preferredPath);
      await browseWorkspacePath(preferredPath, selectedBridgeId);
    }
  };

  const handleCloseProjectComposer = () => {
    setProjectComposerOpen(false);
    setSelectedWorkspacePath("");
    setFolderState({ path: "", parent_path: null, entries: [] });
  };

  const handleSelectProject = (projectId) => {
    setSelectedProjectId(projectId);
    setSelectedThreadId("");
    setDraftThreadProjectId("");
    setActiveView("inbox");
  };

  const handleSelectThread = (threadId) => {
    startTransition(() => {
      setDraftThreadProjectId("");
      setSelectedThreadId(threadId);
      setThreadMessageFilter("all");
      setActiveView("thread");
    });
  };

  const handleOpenNewThread = (projectId) => {
    const nextProjectId = projectId || selectedProjectId || projects[0]?.id || "";

    if (!nextProjectId) {
      return;
    }

    setSelectedProjectId(nextProjectId);
    setSelectedThreadId("");
    setDraftThreadProjectId(nextProjectId);
    setThreadMessageFilter("all");
    setActiveView("thread");
  };

  const handleDismissInstallPrompt = () => {
    dismissPwaPrompt();
    setInstallPromptVisible(false);
    setDeferredInstallPrompt(null);
  };

  const handleInstallPwa = async () => {
    if (!deferredInstallPrompt) {
      return;
    }

    setInstallBusy(true);

    try {
      await deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice.catch(() => null);
      setDeferredInstallPrompt(null);
      setInstallPromptVisible(false);
    } finally {
      setInstallBusy(false);
    }
  };

  const handleConfirmPwaUpdate = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }

    setPwaUpdateBusy(true);
    const activate = pendingUpdateActivatorRef.current;
    window[PWA_UPDATE_ACTIVATOR_KEY] = null;
    pendingUpdateActivatorRef.current = null;

    if (typeof activate === "function") {
      activate();
    } else {
      window.location.reload();
    }
  }, []);

  if (!session) {
    return (
      <LoginPage
        initialLoginId=""
        loading={loginState.loading}
        error={loginState.error}
        onSubmit={handleLogin}
      />
    );
  }

  const currentThreadDetailState = threadDetails[selectedThreadId] ?? { messages: [], loading: false, error: "" };

  return (
    <>
      <MainPage
        session={session}
        bridges={bridges}
        status={status}
        projects={projects}
        threads={threads}
        workspaceRoots={workspaceRoots}
        folderState={folderState}
        folderLoading={folderLoading}
        selectedWorkspacePath={selectedWorkspacePath}
        selectedBridgeId={selectedBridgeId}
        selectedProjectId={selectedProjectId}
        selectedThreadId={selectedThreadId}
        draftThreadProjectId={draftThreadProjectId}
        search={search}
        loadingState={loadingState}
        utilityOpen={utilityOpen}
        projectBusy={projectBusy}
        threadBusy={threadBusy}
        renameBusy={renameBusy}
        projectComposerOpen={projectComposerOpen}
        installPromptVisible={installPromptVisible}
        installBusy={installBusy}
        activeView={activeView}
        threadMessageFilter={threadMessageFilter}
        threadDetail={currentThreadDetailState}
        onSearchChange={setSearch}
        onChangeThreadMessageFilter={setThreadMessageFilter}
        onSelectBridge={setSelectedBridgeId}
        onSelectProject={handleSelectProject}
        onSelectThread={handleSelectThread}
        onOpenNewThread={handleOpenNewThread}
        onOpenUtility={() => setUtilityOpen(true)}
        onOpenProjectComposer={() => void handleOpenProjectComposer()}
        onInstallPwa={() => void handleInstallPwa()}
        onDismissInstallPrompt={handleDismissInstallPrompt}
        onCloseUtility={() => setUtilityOpen(false)}
        onCloseProjectComposer={handleCloseProjectComposer}
        onBrowseWorkspaceRoot={(path) => browseWorkspacePath(path)}
        onBrowseFolder={(path) => browseWorkspacePath(path)}
        onSelectWorkspace={setSelectedWorkspacePath}
        onSubmitProject={handleCreateProject}
        onCreateThread={handleCreateThread}
        onAppendThreadMessage={handleAppendThreadMessage}
        onRenameThread={handleRenameThread}
        onDeleteThread={handleDeleteThread}
        onDeleteProject={handleDeleteProject}
        onRefreshThreadDetail={() => {
          if (selectedThreadId) {
            void loadThreadMessages(selectedThreadId, { force: true, version: selectedThreadUpdatedAt });
          }
        }}
        onRefresh={() => void handleRefresh()}
        onLogout={handleLogout}
        onBackToInbox={() => {
          setDraftThreadProjectId("");
          setActiveView("inbox");
        }}
      />
      <PwaUpdateDialog visible={pwaUpdateVisible} busy={pwaUpdateBusy} onConfirm={handleConfirmPwaUpdate} />
    </>
  );
}
