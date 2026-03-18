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
import { createPortal } from "react-dom";
import { PWA_UPDATE_ACTIVATOR_KEY, PWA_UPDATE_READY_EVENT } from "./pwaEvents.js";

const LOCAL_STORAGE_KEY = "octop.mobile.session";
const SESSION_STORAGE_KEY = "octop.mobile.session.ephemeral";
const LEGACY_LOCAL_STORAGE_KEY = "octop.dashboard.session";
const LEGACY_SESSION_STORAGE_KEY = "octop.dashboard.session.ephemeral";
const SELECTED_BRIDGE_STORAGE_KEY = "octop.mobile.selectedBridge";
const createDefaultStatus = () => ({
  app_server: {
    connected: false,
    initialized: false,
    account: null,
    last_error: null
  },
  updated_at: null
});
const PWA_PROMPT_DISMISSED_KEY = "octop.mobile.pwa.install.dismissed";
const PWA_PROMPT_DISMISSED_VALUE = "manual";
const DEFAULT_API_BASE_URL =
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
    ? "http://127.0.0.1:4000"
    : "https://octop.ilycode.app";
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
const STREAM_SILENCE_START_MS = 60_000;
const STREAM_SILENCE_STEP_MS = 30_000;
const STREAM_SILENCE_MAX_MS = 180_000;
const BRIDGE_STATUS_POLL_INTERVAL_MS = 10_000;
const BRIDGE_STALE_DISCONNECT_MS = 150_000;
const THREAD_RELOAD_MIN_INTERVAL_MS = 1_500;
const ACTIVE_ISSUE_POLL_INTERVAL_MS = 2_000;
const ACTIVE_ISSUE_POLL_SUPPRESS_AFTER_LIVE_MS = 6_000;
const APP_RESUME_COALESCE_MS = 400;
const MESSAGE_BUBBLE_LONG_PRESS_DELAY_MS = 600;
const MESSAGE_BUBBLE_LONG_PRESS_MOVE_TOLERANCE_PX = 10;

function formatSilentDuration(ms) {
  const safeMs = Math.max(0, Number(ms) || 0);
  const totalSeconds = Math.floor(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) {
    return `${seconds}초`;
  }

  if (seconds === 0) {
    return `${minutes}분`;
  }

  return `${minutes}분 ${seconds}초`;
}

function buildBridgeSignal({ connected, lastActivityAt, lastSocketActivityAt, now }) {
  if (!connected) {
    return {
      label: "미연결",
      title: "브릿지 연결이 끊어졌습니다.",
      dotColor: "#fb7185",
      chipStyle: {
        backgroundColor: "rgba(244, 63, 94, 0.14)",
        borderColor: "rgba(244, 63, 94, 0.3)",
        color: "#fecdd3"
      }
    };
  }

  const socketActivityAt = Number.isFinite(lastSocketActivityAt) ? lastSocketActivityAt : 0;
  const bridgeSilentMs = socketActivityAt > 0 ? Math.max(0, now - socketActivityAt) : 0;

  if (socketActivityAt > 0 && bridgeSilentMs >= BRIDGE_STALE_DISCONNECT_MS) {
    return {
      label: "미연결",
      title: `브릿지 소켓 응답이 ${formatSilentDuration(bridgeSilentMs)} 동안 없습니다.`,
      dotColor: "#fb7185",
      chipStyle: {
        backgroundColor: "rgba(244, 63, 94, 0.14)",
        borderColor: "rgba(244, 63, 94, 0.3)",
        color: "#fecdd3"
      }
    };
  }

  const activityAt = Number.isFinite(lastActivityAt) ? lastActivityAt : 0;
  const effectiveActivityAt = Math.max(activityAt, socketActivityAt);
  const silentMs = effectiveActivityAt > 0 ? Math.max(0, now - effectiveActivityAt) : 0;
  const ratio =
    silentMs <= STREAM_SILENCE_START_MS
      ? 0
      : Math.min(1, (silentMs - STREAM_SILENCE_START_MS) / (STREAM_SILENCE_MAX_MS - STREAM_SILENCE_START_MS));
  const hue = Math.round(145 - 140 * ratio);
  const dotColor = `hsl(${hue} 82% 58%)`;
  const label =
    silentMs < STREAM_SILENCE_START_MS
      ? "연결됨"
      : `${formatSilentDuration(silentMs)} 무응답`;
  const stage =
    silentMs < STREAM_SILENCE_START_MS
      ? 0
      : Math.min(5, Math.floor((silentMs - STREAM_SILENCE_START_MS) / STREAM_SILENCE_STEP_MS) + 1);

  return {
    label,
    title:
      stage === 0
        ? "최근 이벤트 응답이 정상입니다."
        : `최근 ${formatSilentDuration(silentMs)} 동안 이벤트 응답이 없습니다. 필요하면 수동 새로고침으로 복구해 주세요.`,
    dotColor,
    chipStyle: {
      backgroundColor: `hsla(${hue}, 82%, 58%, 0.14)`,
      borderColor: `hsla(${hue}, 82%, 58%, 0.3)`,
      color: `hsl(${Math.max(hue - 8, 0)} 70% 88%)`
    }
  };
}

function buildThreadResponseSignal(thread, now) {
  if (!thread || thread.status !== "running" || thread.last_event !== "item.agentMessage.delta") {
    return null;
  }

  const activityAt = Date.parse(thread.updated_at ?? thread.created_at ?? "");

  if (!Number.isFinite(activityAt)) {
    return null;
  }

  const silentMs = Math.max(0, now - activityAt);
  const ratio =
    silentMs <= STREAM_SILENCE_START_MS
      ? 0
      : Math.min(1, (silentMs - STREAM_SILENCE_START_MS) / (STREAM_SILENCE_MAX_MS - STREAM_SILENCE_START_MS));
  const hue = Math.round(145 - 140 * ratio);

  return {
    title:
      silentMs < STREAM_SILENCE_START_MS
        ? "최근 쓰레드 응답이 정상입니다."
        : `최근 ${formatSilentDuration(silentMs)} 동안 쓰레드 응답이 없습니다. 필요하면 사용자가 작업을 중단하고 수동 복구해 주세요.`,
    dotColor: `hsl(${hue} 82% 58%)`,
    chipStyle: {
      backgroundColor: `hsla(${hue}, 82%, 58%, 0.14)`,
      borderColor: `hsla(${hue}, 82%, 58%, 0.3)`,
      color: `hsl(${Math.max(hue - 8, 0)} 70% 88%)`
    }
  };
}

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
  interrupted: {
    label: "Interrupted",
    chipClassName: "bg-amber-400/20 text-amber-100",
    dotClassName: "bg-amber-300",
    bubbleClassName: "bg-amber-100 text-slate-900"
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
const SCROLL_BOUNDARY_EPSILON_PX = 1;
const BOTTOM_BOUNDARY_HEADER_GUARD_PX = 24;
const BOTTOM_BOUNDARY_MOMENTUM_LOCK_MS = 180;
const PROJECT_DELETE_CONFIRM_MESSAGE = "프로젝트를 삭제하시겠습니까? 해당 프로젝트의 이슈도 함께 제거됩니다.";
const PROJECT_CHIP_LONG_PRESS_MS = 650;
const TODO_SCOPE_ID = "todo";
const CHAT_COMPOSER_MAX_HEIGHT_PX = 240; // 최대 입력창 높이(px)를 제한해 채팅 영역이 사라지는 것을 방지

function getMaxScrollTop(node) {
  if (!node) {
    return 0;
  }

  return Math.max(0, node.scrollHeight - node.clientHeight);
}

function getDistanceFromBottom(node) {
  if (!node) {
    return 0;
  }

  return Math.max(0, node.scrollHeight - node.clientHeight - node.scrollTop);
}

function isBottomBoundaryMomentumLocked(node) {
  if (!node) {
    return false;
  }

  const until = Number(node.dataset.bottomMomentumLockUntil ?? 0);
  return Number.isFinite(until) && until > Date.now();
}

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

function readStoredBridgeId() {
  if (typeof window === "undefined") {
    return "";
  }

  try {
    return window.localStorage.getItem(SELECTED_BRIDGE_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeSelectedBridgeId(bridgeId) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (bridgeId) {
      window.localStorage.setItem(SELECTED_BRIDGE_STORAGE_KEY, bridgeId);
    } else {
      window.localStorage.removeItem(SELECTED_BRIDGE_STORAGE_KEY);
    }
  } catch {
    // ignore storage errors
  }
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

function getVisualViewportHeight() {
  if (typeof window === "undefined") {
    return 0;
  }

  const viewport = window.visualViewport;

  if (!viewport) {
    return window.innerHeight;
  }

  return Math.max(0, Math.round(viewport.height));
}

function useVisualViewportHeight() {
  const [viewportHeight, setViewportHeight] = useState(() => getVisualViewportHeight());

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const viewport = window.visualViewport;
    const syncViewportHeight = () => {
      setViewportHeight(getVisualViewportHeight());
    };

    syncViewportHeight();

    if (!viewport) {
      window.addEventListener("resize", syncViewportHeight);
      return () => {
        window.removeEventListener("resize", syncViewportHeight);
      };
    }

    viewport.addEventListener("resize", syncViewportHeight);
    viewport.addEventListener("scroll", syncViewportHeight);
    window.addEventListener("resize", syncViewportHeight);

    return () => {
      viewport.removeEventListener("resize", syncViewportHeight);
      viewport.removeEventListener("scroll", syncViewportHeight);
      window.removeEventListener("resize", syncViewportHeight);
    };
  }, []);

  return viewportHeight;
}

function useTouchScrollBoundaryLock(scrollRef) {
  useEffect(() => {
    const scrollNode = scrollRef.current;

    if (!scrollNode) {
      return undefined;
    }

    let touchY = 0;
    let lastDeltaY = 0;
    let restoreOverflowTimerId = 0;
    const clearBottomMomentumLock = () => {
      delete scrollNode.dataset.bottomMomentumLockUntil;
    };
    const lockBottomMomentum = () => {
      scrollNode.dataset.bottomMomentumLockUntil = String(Date.now() + BOTTOM_BOUNDARY_MOMENTUM_LOCK_MS);
    };
    const stopBottomMomentum = () => {
      const maxScrollTop = getMaxScrollTop(scrollNode);

      if (maxScrollTop <= 0) {
        return;
      }

      lockBottomMomentum();
      scrollNode.scrollTop = maxScrollTop;

      if (restoreOverflowTimerId) {
        window.clearTimeout(restoreOverflowTimerId);
      }

      scrollNode.style.overflowY = "hidden";
      void scrollNode.offsetHeight;
      scrollNode.style.overflowY = "";
      scrollNode.scrollTop = maxScrollTop;

      restoreOverflowTimerId = window.setTimeout(() => {
        clearBottomMomentumLock();
        restoreOverflowTimerId = 0;
      }, BOTTOM_BOUNDARY_MOMENTUM_LOCK_MS);
    };

    const handleTouchStart = (event) => {
      if (event.touches.length !== 1) {
        return;
      }

      touchY = event.touches[0].clientY;
      lastDeltaY = 0;
      const maxScrollTop = getMaxScrollTop(scrollNode);

      if (maxScrollTop <= 0) {
        return;
      }

      if (scrollNode.scrollTop <= 0) {
        scrollNode.scrollTop = SCROLL_BOUNDARY_EPSILON_PX;
      } else if (scrollNode.scrollTop >= maxScrollTop) {
        scrollNode.scrollTop = Math.max(SCROLL_BOUNDARY_EPSILON_PX, maxScrollTop - SCROLL_BOUNDARY_EPSILON_PX);
      }
    };

    const handleTouchMove = (event) => {
      if (event.touches.length !== 1) {
        return;
      }

      const currentY = event.touches[0].clientY;
      const deltaY = currentY - touchY;
      touchY = currentY;
      lastDeltaY = deltaY;

      const maxScrollTop = getMaxScrollTop(scrollNode);

      if (maxScrollTop <= 0) {
        event.preventDefault();
        return;
      }

      const isPullingPastTop = deltaY > 0 && scrollNode.scrollTop <= SCROLL_BOUNDARY_EPSILON_PX;
      const isPushingPastBottom = deltaY < 0 && scrollNode.scrollTop >= maxScrollTop - SCROLL_BOUNDARY_EPSILON_PX;

      if (isPullingPastTop || isPushingPastBottom) {
        if (isPushingPastBottom) {
          lockBottomMomentum();
        }
        event.preventDefault();
      }
    };

    const handleTouchEnd = () => {
      if (lastDeltaY < 0 && getDistanceFromBottom(scrollNode) <= BOTTOM_BOUNDARY_HEADER_GUARD_PX) {
        stopBottomMomentum();
      }
    };

    scrollNode.addEventListener("touchstart", handleTouchStart, { passive: true });
    scrollNode.addEventListener("touchmove", handleTouchMove, { passive: false });
    scrollNode.addEventListener("touchend", handleTouchEnd, { passive: true });
    scrollNode.addEventListener("touchcancel", handleTouchEnd, { passive: true });

    return () => {
      if (restoreOverflowTimerId) {
        window.clearTimeout(restoreOverflowTimerId);
      }

      clearBottomMomentumLock();
      scrollNode.style.overflowY = "";
      scrollNode.removeEventListener("touchstart", handleTouchStart);
      scrollNode.removeEventListener("touchmove", handleTouchMove);
      scrollNode.removeEventListener("touchend", handleTouchEnd);
      scrollNode.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, [scrollRef]);
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

  if (status === "interrupted") {
    return "중단됨";
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

function getThreadContextUsage(thread) {
  if (!thread) {
    return null;
  }

  const percent = clampProgress(thread.context_usage_percent ?? thread.contextUsagePercent);
  const hasPercent =
    Number.isFinite(Number(thread.context_usage_percent)) || Number.isFinite(Number(thread.contextUsagePercent));
  const usedTokens = normalizeNullableInteger(
    thread.context_used_tokens ?? thread.contextUsedTokens
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

function getVoiceTranscriptDelta(nextTranscript, previousTranscript) {
  const next = String(nextTranscript ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const previous = String(previousTranscript ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (!next) {
    return "";
  }

  if (!previous) {
    return next;
  }

  if (next === previous || previous.startsWith(next)) {
    return "";
  }

  if (next.startsWith(previous)) {
    return next.slice(previous.length).trim();
  }

  const previousTokens = previous.split(" ");
  const nextTokens = next.split(" ");
  const maxOverlap = Math.min(previousTokens.length, nextTokens.length);

  for (let size = maxOverlap; size > 0; size -= 1) {
    const previousSuffix = previousTokens.slice(-size).join(" ");
    const nextPrefix = nextTokens.slice(0, size).join(" ");

    if (previousSuffix === nextPrefix) {
      return nextTokens.slice(size).join(" ").trim();
    }
  }

  return next;
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

function formatApiRequestError(path, options = {}, error, contextLabel = "") {
  const method = String(options.method ?? "GET").toUpperCase();
  const requestUrl = `${API_BASE_URL}${path}`;
  const rawMessage = String(error?.message ?? error ?? "unknown error").trim() || "unknown error";
  const onlineState =
    typeof navigator === "undefined" || typeof navigator.onLine !== "boolean"
      ? "unknown"
      : navigator.onLine
        ? "online"
        : "offline";
  const lines = [];

  if (contextLabel) {
    lines.push(contextLabel);
  }

  lines.push(`요청: ${method} ${path}`);
  lines.push(`API: ${requestUrl}`);
  lines.push(`브라우저 네트워크 상태: ${onlineState}`);

  if (/failed to fetch/i.test(rawMessage)) {
    lines.push("설명: 브라우저에서 API 엔드포인트까지 도달하지 못했습니다. 브릿지가 살아 있어도 현재 모바일 웹 경로에서 이 주소로 접속하지 못하면 이 오류가 발생합니다.");
  }

  lines.push(`원본 오류: ${rawMessage}`);
  return lines.join("\n");
}

async function copyTextToClipboard(text) {
  const value = String(text ?? "");

  if (!value) {
    throw new Error("복사할 텍스트가 없습니다.");
  }

  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch (error) {
      // secure context가 아니거나 브라우저가 clipboard API를 거부하면 fallback으로 내려갑니다.
    }
  }

  if (typeof document === "undefined") {
    throw new Error("현재 환경에서는 텍스트를 복사할 수 없습니다.");
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  textarea.style.top = "0";
  textarea.style.left = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  try {
    const copied = document.execCommand("copy");

    if (!copied) {
      throw new Error("브라우저가 복사 명령을 지원하지 않습니다.");
    }
  } finally {
    document.body.removeChild(textarea);
  }
}

async function apiRequest(path, options = {}) {
  let response;

  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers ?? {})
      }
    });
  } catch (error) {
    throw new Error(formatApiRequestError(path, options, error));
  }

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
    codex_thread_id: thread.codex_thread_id ?? null,
    active_physical_thread_id: thread.active_physical_thread_id ?? null,
    continuity_mode: thread.continuity_mode ?? null,
    continuity_status: thread.continuity_status ?? "healthy",
    rollover_count: Number.isFinite(Number(thread.rollover_count)) ? Number(thread.rollover_count) : 0,
    context_usage_percent: contextUsage?.percent ?? null,
    context_used_tokens: contextUsage?.usedTokens ?? null,
    context_window_tokens: contextUsage?.windowTokens ?? null
  };
}

function normalizeIssue(issue, fallbackThreadId = null) {
  if (!issue?.id || issue.deleted_at) {
    return null;
  }

  return {
    id: issue.id,
    thread_id: issue.thread_id ?? fallbackThreadId,
    root_thread_id: issue.root_thread_id ?? issue.thread_id ?? fallbackThreadId,
    project_id: issue.project_id ?? null,
    title: issue.title ?? "",
    status: issue.status ?? "staged",
    progress: clampProgress(issue.progress),
    last_event: issue.last_event ?? "issue.created",
    last_message: issue.last_message ?? "",
    created_at: issue.created_at ?? new Date().toISOString(),
    updated_at: issue.updated_at ?? issue.created_at ?? new Date().toISOString(),
    prompt: issue.prompt ?? "",
    queue_position: Number.isFinite(Number(issue.queue_position)) ? Number(issue.queue_position) : null,
    prep_position: Number.isFinite(Number(issue.prep_position)) ? Number(issue.prep_position) : null,
    continuity: issue.continuity ?? null,
    created_physical_thread_id: issue.created_physical_thread_id ?? null,
    executed_physical_thread_id: issue.executed_physical_thread_id ?? issue.created_physical_thread_id ?? null
  };
}

function getIssuePhysicalThreadId(issue) {
  if (!issue) {
    return null;
  }

  return issue.executed_physical_thread_id ?? issue.created_physical_thread_id ?? null;
}

function findActiveIssueForThread(issues = [], activePhysicalThreadId = null) {
  const normalizedIssues = issues.filter(Boolean);

  if (normalizedIssues.length === 0) {
    return null;
  }

  const prioritizedIssues = [...normalizedIssues].sort((left, right) => {
    const leftCreatedAt = Date.parse(left.created_at ?? "");
    const rightCreatedAt = Date.parse(right.created_at ?? "");

    return rightCreatedAt - leftCreatedAt;
  });

  if (activePhysicalThreadId) {
    const matchedIssue = prioritizedIssues.find((issue) => getIssuePhysicalThreadId(issue) === activePhysicalThreadId);

    if (matchedIssue) {
      return matchedIssue;
    }
  }

  return prioritizedIssues.find((issue) => ["running", "awaiting_input"].includes(issue.status)) ?? prioritizedIssues[0] ?? null;
}

function mergeIssueMessages(currentMessages = [], detailMessages = [], issue = null, fallbackTimestamp = null) {
  const issueId = issue?.id ?? null;

  if (!issueId) {
    return currentMessages;
  }

  const preservedMessages = currentMessages.filter((message) => String(message?.issue_id ?? "") !== issueId);
  const normalizedMessages = (detailMessages ?? []).map((message, index) => ({
    ...message,
    id: message.id ?? `${issueId}-${index}`,
    issue_id: issueId,
    issue_title: issue?.title ?? "",
    issue_status: issue?.status ?? "staged",
    timestamp: message.timestamp ?? fallbackTimestamp ?? new Date().toISOString()
  }));

  return [...preservedMessages, ...normalizedMessages].sort(
    (left, right) => Date.parse(left.timestamp ?? "") - Date.parse(right.timestamp ?? "")
  );
}

function buildIssueReloadFingerprint(issues = [], fallbackThreadId = null) {
  return issues
    .map((issue) => normalizeIssue(issue, fallbackThreadId))
    .filter(Boolean)
    .map((issue) =>
      [
        issue.id,
        issue.status,
        issue.progress,
        issue.last_event,
        issue.updated_at,
        issue.executed_physical_thread_id ?? "",
        issue.created_physical_thread_id ?? ""
      ].join(":")
    )
    .join("|");
}

function shouldReloadThreadFromIssueSnapshot(currentIssues = [], nextIssues = [], fallbackThreadId = null) {
  const normalizedCurrent = currentIssues
    .map((issue) => normalizeIssue(issue, fallbackThreadId))
    .filter(Boolean);
  const normalizedNext = nextIssues
    .map((issue) => normalizeIssue(issue, fallbackThreadId))
    .filter(Boolean);

  if (normalizedCurrent.length === 0) {
    return normalizedNext.length > 0;
  }

  if (normalizedCurrent.length !== normalizedNext.length) {
    return true;
  }

  const currentIds = normalizedCurrent.map((issue) => issue.id).join("|");
  const nextIds = normalizedNext.map((issue) => issue.id).join("|");

  if (currentIds !== nextIds) {
    return true;
  }

  const currentFingerprint = buildIssueReloadFingerprint(normalizedCurrent, fallbackThreadId);
  const nextFingerprint = buildIssueReloadFingerprint(normalizedNext, fallbackThreadId);

  if (currentFingerprint === nextFingerprint) {
    return false;
  }

  return normalizedNext.some((issue) => ["awaiting_input", "completed", "failed", "interrupted"].includes(issue.status));
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
    case "interrupted":
    case "cancelled":
    case "canceled":
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

function buildLiveThreadTokenUsagePatch(payload = {}, currentThread = null) {
  const tokenUsage = payload.tokenUsage ?? payload.token_usage ?? null;

  if (!tokenUsage || typeof tokenUsage !== "object") {
    return null;
  }

  const currentTokenUsage = currentThread?.token_usage ?? currentThread?.tokenUsage ?? {};
  const nextContextWindowTokens = normalizeNullableInteger(
    tokenUsage.contextWindowTokens ?? tokenUsage.context_window_tokens ?? currentThread?.context_window_tokens
  );
  const nextContextUsedTokens = normalizeNullableInteger(
    tokenUsage.contextUsedTokens ??
      tokenUsage.context_used_tokens ??
      tokenUsage.contextTokens ??
      tokenUsage.context_tokens ??
      currentThread?.context_used_tokens
  );
  const nextContextUsagePercent = clampProgress(
    tokenUsage.contextUsagePercent ??
      tokenUsage.context_usage_percent ??
      currentThread?.context_usage_percent
  );

  return {
    token_usage: {
      ...currentTokenUsage,
      ...(nextContextWindowTokens !== null ? { model_context_window: nextContextWindowTokens } : {})
    },
    context_window_tokens: nextContextWindowTokens,
    context_used_tokens: nextContextUsedTokens,
    context_usage_percent: nextContextUsagePercent
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
      {
        const nextStatus = normalizeLiveThreadStatus(payload.status?.type ?? "", currentStatus);
        const nextMessage = String(payload.status?.message ?? "").trim();

        if (nextStatus === currentStatus && !nextMessage) {
          return null;
        }

        return {
          id: threadId,
          project_id: projectId || currentThread?.project_id || null,
          status: nextStatus,
          last_event: "thread.status.changed",
          ...(nextMessage ? { last_message: nextMessage } : {}),
          updated_at: new Date().toISOString()
        };
      }
    case "thread.tokenUsage.updated":
      {
        const tokenUsagePatch = buildLiveThreadTokenUsagePatch(payload, currentThread);

        if (!tokenUsagePatch) {
          return null;
        }

        return {
          id: threadId,
          project_id: projectId || currentThread?.project_id || null,
          ...tokenUsagePatch,
          updated_at: new Date().toISOString()
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
      {
        const nextStatus = payload.turn?.status === "completed" ? "idle" : "failed";
        const nextProgress = payload.turn?.status === "completed" ? 100 : 0;

        if (
          currentThread &&
          currentThread.status === nextStatus &&
          Number(currentThread.progress ?? 0) === nextProgress &&
          currentThread.last_event === "turn.completed"
        ) {
          return null;
        }

        return {
          id: threadId,
          project_id: projectId || currentThread?.project_id || null,
          status: nextStatus,
          progress: nextProgress,
          last_event: "turn.completed",
          ...(payload.turn?.error?.message
            ? {
                last_message: String(payload.turn.error.message).trim()
              }
            : {}),
          updated_at: new Date().toISOString()
        };
      }
    default:
      return null;
  }
}

function upsertLiveThread(currentThreads, event) {
  const { payload, threadId, projectId } = getLiveEventContext(event);

  if (!threadId) {
    return currentThreads;
  }

  const currentThread = currentThreads.find((thread) => thread.id === threadId) ?? null;
  const patch = buildLiveThreadPatch(event, currentThread);
  const fallbackThread =
    normalizeThread(payload.thread, projectId || null) ??
    normalizeThread({
      id: threadId,
      title: "새 채팅창",
      project_id: projectId || currentThread?.project_id || null,
      status: patch?.status ?? currentThread?.status ?? "queued",
      progress: patch?.progress ?? currentThread?.progress ?? 0,
      last_event: patch?.last_event ?? currentThread?.last_event ?? "thread.started",
      last_message: patch?.last_message ?? currentThread?.last_message ?? "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, projectId || null);

  if (!patch && !currentThread && !fallbackThread) {
    return currentThreads;
  }

  return upsertThread(currentThreads, {
    ...(currentThread ?? fallbackThread ?? {}),
    ...(patch ?? {})
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

function groupThreadsByProjectId(threads) {
  const grouped = new Map();

  for (const thread of threads) {
    const normalized = normalizeThread(thread);
    const projectId = String(normalized?.project_id ?? "").trim();

    if (!normalized || !projectId) {
      continue;
    }

    const current = grouped.get(projectId) ?? [];
    grouped.set(projectId, [...current, normalized]);
  }

  return grouped;
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

function removeThreadsByIds(currentThreads, threadIds) {
  const normalizedThreadIds = [...new Set(threadIds.map((threadId) => String(threadId ?? "").trim()).filter(Boolean))];

  if (normalizedThreadIds.length === 0) {
    return currentThreads;
  }

  const threadIdSet = new Set(normalizedThreadIds);
  return currentThreads.filter((thread) => !threadIdSet.has(String(thread?.id ?? "").trim()));
}

function removeThreadIdsFromProjectCache(currentCache, threadIds) {
  const normalizedThreadIds = [...new Set(threadIds.map((threadId) => String(threadId ?? "").trim()).filter(Boolean))];

  if (normalizedThreadIds.length === 0) {
    return currentCache;
  }

  const threadIdSet = new Set(normalizedThreadIds);
  let changed = false;
  const nextCache = {};

  for (const [projectId, threadList] of Object.entries(currentCache)) {
    if (!Array.isArray(threadList)) {
      nextCache[projectId] = threadList;
      continue;
    }

    const nextThreadList = threadList.filter((thread) => !threadIdSet.has(String(thread?.id ?? "").trim()));

    if (nextThreadList.length !== threadList.length) {
      changed = true;
    }

    nextCache[projectId] = nextThreadList;
  }

  return changed ? nextCache : currentCache;
}

function normalizeTodoChat(chat) {
  if (!chat?.id) {
    return null;
  }

  return {
    id: chat.id,
    title: chat.title ?? "새 ToDo 채팅",
    last_message: chat.last_message ?? "",
    message_count: Number.isFinite(Number(chat.message_count)) ? Number(chat.message_count) : 0,
    created_at: chat.created_at ?? new Date().toISOString(),
    updated_at: chat.updated_at ?? chat.created_at ?? new Date().toISOString()
  };
}

function mergeTodoChats(currentChats, nextChats) {
  const nextById = new Map();

  for (const chat of currentChats) {
    const normalized = normalizeTodoChat(chat);

    if (normalized) {
      nextById.set(normalized.id, normalized);
    }
  }

  for (const chat of nextChats) {
    const normalized = normalizeTodoChat(chat);

    if (normalized) {
      nextById.set(normalized.id, normalized);
    }
  }

  return [...nextById.values()].sort(
    (left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at)
  );
}

function upsertTodoChat(currentChats, chat) {
  const normalized = normalizeTodoChat(chat);

  if (!normalized) {
    return currentChats;
  }

  const next = [...currentChats];
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

function getTodoChatPreview(chat) {
  if (chat?.last_message) {
    return chat.last_message;
  }

  return "아직 저장된 메모가 없습니다.";
}

function normalizeTodoMessage(message) {
  if (!message?.id) {
    return null;
  }

  return {
    id: message.id,
    todo_chat_id: message.todo_chat_id ?? null,
    content: message.content ?? "",
    status: message.status ?? "open",
    created_at: message.created_at ?? new Date().toISOString(),
    updated_at: message.updated_at ?? message.created_at ?? new Date().toISOString()
  };
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

function BottomSheet({ open, title, description, onClose, children, variant = "bottom", headerActions = null }) {
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

  const handleContainerClick = (event) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  return (
    <div className={containerClassName} onClick={handleContainerClick}>
      <section className={panelClassName} onClick={(event) => event.stopPropagation()}>
        <div className="border-b border-white/10 bg-white/5 px-5 py-4">
          {isCenterDialog ? null : <div className="mx-auto mb-4 h-1.5 w-14 rounded-full bg-white/15" />}
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-white">{title}</h2>
              {description ? <p className="mt-1 text-sm leading-6 text-slate-400">{description}</p> : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {headerActions}
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
    <div className="relative min-h-screen overflow-hidden bg-brand-dark text-slate-200">
      <div className="fixed inset-0 -z-10 overflow-hidden">
        <div className="bg-mesh absolute inset-0" />
        <div className="absolute left-[-6%] top-[-8%] h-[20rem] w-[20rem] rounded-full bg-sky-500/8 blur-[140px]" />
        <div className="absolute bottom-[-14%] right-[-10%] h-[22rem] w-[22rem] rounded-full bg-emerald-500/8 blur-[160px]" />
      </div>

      <div className="mx-auto flex min-h-screen max-w-md items-center justify-center px-5 py-8">
        <main className="relative z-10 w-full">
          <header className="mb-10 text-center">
            <div className="inline-flex h-14 w-14 items-center justify-center rounded-3xl border border-white/10 bg-slate-950/70">
              <img src="/octop-login-icon.png" alt="OctOP" className="h-full w-full rounded-3xl object-contain" />
            </div>
            <p className="mt-6 text-[11px] uppercase tracking-[0.34em] text-slate-500">OctOP Workspace</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white">Sign in</h1>
            <p className="mt-3 text-sm leading-6 text-slate-400">
              Use your LicenseHub login ID to open the mobile workspace.
            </p>
          </header>

          <section className="rounded-[28px] border border-white/8 bg-slate-950/72 p-8 shadow-2xl shadow-slate-950/30 backdrop-blur">
            <form className="space-y-6" onSubmit={handleSubmit}>
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
              className="w-full rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3 text-white outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/30"
            />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="block text-sm font-medium text-slate-300" htmlFor="password">
                Password
              </label>
              <span className="text-xs text-slate-500">LicenseHub password</span>
            </div>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
              className="w-full rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3 text-white outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/30"
            />
          </div>

          <label className="flex items-center gap-3 text-sm text-slate-400">
            <input
              type="checkbox"
              checked={rememberDevice}
              onChange={(event) => setRememberDevice(event.target.checked)}
              className="h-4 w-4 rounded border-slate-700 bg-slate-950 text-sky-400 focus:ring-sky-400"
            />
            Keep me signed in on this device
          </label>

          {error ? (
            <div className="rounded-2xl border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-sky-500 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? (
              <>
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-950/25 border-t-slate-950" />
                Signing in...
              </>
            ) : (
              "Sign in"
            )}
          </button>
            </form>

            <div className="mt-6 border-t border-slate-800 pt-4 text-xs leading-6 text-slate-500">
              After sign-in, your connected bridge, projects, and thread board sync automatically.
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

function UtilitySheet({
  open,
  session,
  bridgeSignal,
  selectedProject,
  onOpenProjectInstructionDialog,
  onClose,
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
        <section className="flex items-start gap-3 border-b border-white/10 pb-4">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-telegram-500/15 text-sm font-semibold text-white">
            {(session.displayName || session.loginId || "O").slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-semibold text-white">{session.displayName || session.loginId}</p>
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: bridgeSignal.dotColor }}
                title={bridgeSignal.title}
              />
            </div>
            <p className="mt-1 text-[11px]" style={{ color: bridgeSignal.chipStyle.color }}>
              {bridgeSignal.label}
            </p>
            <p className="truncate text-xs text-slate-400">{session.loginId}</p>
          </div>
        </section>

        <section className="grid grid-cols-2 gap-2 border-t border-white/10 py-4">
          <button
            type="button"
            disabled={!selectedProject}
            onClick={() => onOpenProjectInstructionDialog("base")}
            className="rounded-full bg-sky-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-300 disabled:opacity-60"
          >
            일반지침 설정
          </button>
          <button
            type="button"
            disabled={!selectedProject}
            onClick={() => onOpenProjectInstructionDialog("developer")}
            className="rounded-full bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-300 disabled:opacity-60"
          >
            개발지침 설정
          </button>
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

function BridgeDropdown({ bridges, selectedBridgeId, bridgeSignal, onSelectBridge }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const selectedBridge = useMemo(
    () => bridges.find((bridge) => bridge.bridge_id === selectedBridgeId) ?? null,
    [bridges, selectedBridgeId]
  );
  const statusLabel = bridgeSignal.label;

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function handlePointerDown(event) {
      if (!containerRef.current) {
        return;
      }

      if (!containerRef.current.contains(event.target)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-2 text-left text-xs text-slate-400 transition hover:text-white focus:outline-none"
      >
        <span className="truncate">
          {selectedBridge?.device_name ?? selectedBridge?.bridge_id ?? "브릿지 없음"}
        </span>
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: bridgeSignal.dotColor }} />
        <span>{statusLabel}</span>
        <svg
          className={`h-3.5 w-3.5 shrink-0 text-slate-500 transition ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
        </svg>
      </button>

      {open ? (
        <div className="absolute left-0 z-30 mt-2 w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-white/10 bg-slate-950/95 shadow-2xl shadow-black/40 backdrop-blur">
          <div className="border-b border-white/5 px-4 py-3">
            <p className="text-xs font-semibold text-white">브릿지 선택</p>
            <p className="mt-0.5 text-[11px] text-slate-400">연결할 브릿지를 선택하세요.</p>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {bridges.length === 0 ? (
              <p className="px-4 py-5 text-sm text-slate-400">연결된 브릿지가 없습니다.</p>
            ) : (
              bridges.map((bridge) => {
                const active = bridge.bridge_id === selectedBridgeId;

                return (
                  <button
                    key={bridge.bridge_id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => {
                      onSelectBridge(bridge.bridge_id);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center gap-3 px-4 py-3 text-left text-sm transition ${
                      active ? "bg-telegram-500/10 text-white" : "text-slate-200 hover:bg-white/[0.04]"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{bridge.device_name ?? bridge.bridge_id}</p>
                      <p className="truncate text-[11px] text-slate-400">{bridge.bridge_id}</p>
                    </div>
                    <div className="text-right text-[11px] text-slate-400">
                      <p>{formatRelativeTime(bridge.last_seen_at)}</p>
                      {active ? <p className="mt-0.5 text-telegram-200">선택됨</p> : null}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function InlineIssueComposer({
  busy,
  selectedProject,
  onSubmit,
  label,
  disabled = false,
  onStop = null,
  stopBusy = false,
  stopLabel = "중단"
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
  const processedFinalResultKeysRef = useRef(new Set());
  const lastVoiceAppendRef = useRef({ text: "", at: 0 });
  const lastFinalTranscriptRef = useRef("");
  const supportsSpeechRecognition =
    typeof window !== "undefined" && ("webkitSpeechRecognition" in window || "SpeechRecognition" in window);

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
    processedFinalResultKeysRef.current = new Set();
    lastVoiceAppendRef.current = { text: "", at: 0 };
    lastFinalTranscriptRef.current = "";
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
      const transcript = String(text ?? "")
        .replace(/\s+/g, " ")
        .trim();

      if (!transcript) {
        return;
      }

      if (
        lastVoiceAppendRef.current.text === transcript &&
        Date.now() - lastVoiceAppendRef.current.at < 1200
      ) {
        return;
      }

      lastVoiceAppendRef.current = {
        text: transcript,
        at: Date.now()
      };

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
    processedFinalResultKeysRef.current = new Set();
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
          const transcript = String(result[0]?.transcript ?? "")
            .replace(/\s+/g, " ")
            .trim();

          if (!transcript) {
            continue;
          }

          const resultKey = `${index}:${transcript}`;

          if (processedFinalResultKeysRef.current.has(resultKey)) {
            continue;
          }

          processedFinalResultKeysRef.current.add(resultKey);
          const delta = getVoiceTranscriptDelta(transcript, lastFinalTranscriptRef.current);

          if (!delta) {
            lastFinalTranscriptRef.current = transcript;
            continue;
          }

          lastFinalTranscriptRef.current = transcript;
          collected += collected ? ` ${delta}` : delta;
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
      {isRecording && typeof document !== "undefined"
        ? createPortal(
            <div className="pointer-events-none fixed inset-x-0 top-3 z-[80] flex justify-center px-4">
              <div className="flex items-center gap-2 rounded-full bg-rose-500/95 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-rose-900/40">
                <span className="h-2.5 w-2.5 rounded-full bg-white animate-pulse" />
                <span>음성 입력 중</span>
              </div>
            </div>,
            document.body
          )
        : null}
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
          )}
          
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

function TodoChatListItem({ chat, active, onOpen, onRename, onDelete }) {
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

  const handlePointerUp = useCallback(
    (event) => {
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
    },
    [setRevealOffset]
  );

  const showDeleteAction = offset > 0;
  const showRenameAction = offset < 0;

  return (
    <div className="relative overflow-hidden border-b border-white/8">
      <button
        type="button"
        onClick={() => {
          setRevealOffset(0);
          onDelete(chat);
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
          onRename(chat);
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

          onOpen(chat.id);
        }}
        className={`relative w-full px-3 py-3 text-left ${
          dragging ? "" : "transition-transform duration-180 ease-out"
        } ${active ? "bg-slate-900" : "bg-slate-950 hover:bg-slate-900/90"}`}
        style={{
          transform: `translate3d(${offset}px, 0, 0)`,
          touchAction: "pan-y",
          willChange: "transform"
        }}
      >
        <div
          className={`min-w-0 rounded-2xl border px-3 py-3 ${
            active ? "border-white/12 bg-white/[0.03]" : "border-transparent bg-transparent"
          }`}
        >
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 flex-1 truncate text-sm font-semibold text-white">{chat.title}</p>
            <span className="shrink-0 text-[11px] text-slate-500">{formatRelativeTime(chat.updated_at)}</span>
          </div>
          <p className="mt-1 text-[13px] leading-5 text-slate-300">{getTodoChatPreview(chat)}</p>
          <div className="mt-2 flex items-center gap-2 text-[10px] text-slate-500">
            <span className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-slate-300">
              메모 {chat.message_count}
            </span>
          </div>
        </div>
      </button>
    </div>
  );
}

function DeleteConfirmDialog({
  open,
  busy,
  title,
  description,
  confirmLabel = "삭제",
  cancelLabel = "취소",
  onClose,
  onConfirm
}) {
  return (
    <BottomSheet
      open={open}
      title={title}
      description={description}
      onClose={busy ? () => {} : onClose}
      variant="center"
    >
      <div className="space-y-5 px-5 py-5">
        <div className="rounded-3xl border border-rose-400/15 bg-rose-500/10 px-4 py-4 text-sm leading-7 text-slate-200">
          삭제한 항목은 목록에서 즉시 사라집니다.
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex-1 rounded-full border border-white/10 px-4 py-3 text-sm font-medium text-slate-200 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="flex-1 rounded-full bg-rose-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {busy ? "삭제 중..." : confirmLabel}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}

function TodoChatRenameDialog({ open, busy, chat, onClose, onSubmit }) {
  const [title, setTitle] = useState("");

  useEffect(() => {
    if (!open) {
      setTitle("");
      return;
    }

    setTitle(chat?.title ?? "");
  }, [chat, open]);

  if (!open || !chat) {
    return null;
  }

  return (
    <BottomSheet open={open} title="ToDo 채팅 이름 변경" onClose={onClose} variant="center">
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
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="todo-chat-title">
            제목
          </label>
          <input
            id="todo-chat-title"
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
            {busy ? "저장 중..." : "저장"}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}

function TodoMessageEditorDialog({ open, busy, message, onClose, onSubmit }) {
  const [content, setContent] = useState("");

  useEffect(() => {
    if (!open) {
      setContent("");
      return;
    }

    setContent(message?.content ?? "");
  }, [message, open]);

  if (!open || !message) {
    return null;
  }

  return (
    <BottomSheet open={open} title="메모 수정" onClose={onClose} variant="center">
      <form
        className="space-y-5 px-5 py-5"
        onSubmit={async (event) => {
          event.preventDefault();

          if (!content.trim()) {
            return;
          }

          const accepted = await onSubmit(content.trim());

          if (accepted !== false) {
            onClose();
          }
        }}
      >
        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="todo-message-content">
            내용
          </label>
          <textarea
            id="todo-message-content"
            rows="6"
            value={content}
            onChange={(event) => setContent(event.target.value)}
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
            disabled={busy || !content.trim()}
            className="rounded-full bg-telegram-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "저장 중..." : "저장"}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}

function TodoMessageActionSheet({ open, message, onClose, onEdit, onDelete, onTransfer }) {
  if (!open || !message) {
    return null;
  }

  return (
    <BottomSheet open={open} title="메모 작업" onClose={onClose}>
      <div className="space-y-3 px-5 py-5">
        <div className="rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm leading-6 text-slate-200">
          {message.content}
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="w-full rounded-full border border-white/10 px-4 py-3 text-sm font-medium text-white transition hover:bg-white/5"
        >
          편집
        </button>
        <button
          type="button"
          onClick={onTransfer}
          className="w-full rounded-full bg-telegram-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-telegram-400"
        >
          프로젝트-쓰레드로 이동
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="w-full rounded-full bg-rose-500/90 px-4 py-3 text-sm font-semibold text-white transition hover:bg-rose-400"
        >
          삭제
        </button>
      </div>
    </BottomSheet>
  );
}

function ThreadMessageActionSheet({ open, message, busy, onClose, onCopy, onDelete }) {
  if (!open || !message) {
    return null;
  }

  return (
    <BottomSheet
      open={open}
      title="메시지 작업"
      onClose={busy ? () => {} : onClose}
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

function TodoTransferSheet({
  open,
  busy,
  message,
  projects,
  threadOptionsByProjectId,
  selectedProjectId,
  onEnsureProjectThreads,
  onClose,
  onSubmit
}) {
  const [projectId, setProjectId] = useState("");
  const [threadMode, setThreadMode] = useState("existing");
  const [threadId, setThreadId] = useState("");
  const [threadName, setThreadName] = useState("");

  useEffect(() => {
    if (!open) {
      setProjectId("");
      setThreadMode("existing");
      setThreadId("");
      setThreadName("");
      return;
    }

    const nextProjectId = selectedProjectId || projects[0]?.id || "";
    setProjectId(nextProjectId);
    setThreadMode("existing");
    setThreadId("");
    setThreadName(createThreadTitleFromPrompt(message?.content ?? "") || "새 채팅창");
  }, [message, open, projects, selectedProjectId]);

  useEffect(() => {
    if (!open || !projectId || !onEnsureProjectThreads) {
      return;
    }

    void onEnsureProjectThreads(projectId);
  }, [onEnsureProjectThreads, open, projectId]);

  const availableThreads = useMemo(
    () => threadOptionsByProjectId[projectId] ?? [],
    [projectId, threadOptionsByProjectId]
  );

  if (!open || !message) {
    return null;
  }

  return (
    <BottomSheet
      open={open}
      title="프로젝트-쓰레드로 이동"
      description="이 메모를 staged issue로 넘깁니다. 실행은 자동으로 시작되지 않습니다."
      onClose={onClose}
      variant="center"
    >
      <form
        className="space-y-5 px-5 py-5"
        onSubmit={async (event) => {
          event.preventDefault();

          if (!projectId) {
            return;
          }

          if (threadMode === "existing" && !threadId) {
            return;
          }

          if (threadMode === "new" && !threadName.trim()) {
            return;
          }

          const accepted = await onSubmit({
            project_id: projectId,
            thread_mode: threadMode,
            thread_id: threadMode === "existing" ? threadId : null,
            thread_name: threadMode === "new" ? threadName.trim() : null
          });

          if (accepted !== false) {
            onClose();
          }
        }}
      >
        <div className="rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm leading-6 text-slate-200">
          {message.content}
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="todo-transfer-project">
            프로젝트
          </label>
          <select
            id="todo-transfer-project"
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
              setThreadId("");
            }}
            className="w-full rounded-[1rem] border border-white/10 bg-[#0b1622] px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
          >
            <option value="">프로젝트 선택</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setThreadMode("existing")}
            className={`rounded-full px-4 py-2.5 text-sm font-semibold transition ${
              threadMode === "existing"
                ? "bg-white text-slate-900"
                : "border border-white/10 text-slate-200 hover:bg-white/5"
            }`}
          >
            기존 쓰레드
          </button>
          <button
            type="button"
            onClick={() => setThreadMode("new")}
            className={`rounded-full px-4 py-2.5 text-sm font-semibold transition ${
              threadMode === "new"
                ? "bg-white text-slate-900"
                : "border border-white/10 text-slate-200 hover:bg-white/5"
            }`}
          >
            신규 쓰레드
          </button>
        </div>

        {threadMode === "existing" ? (
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="todo-transfer-thread">
              대상 쓰레드
            </label>
            <select
              id="todo-transfer-thread"
              value={threadId}
              onChange={(event) => setThreadId(event.target.value)}
              className="w-full rounded-[1rem] border border-white/10 bg-[#0b1622] px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
            >
              <option value="">쓰레드 선택</option>
              {availableThreads.map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.title}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="todo-transfer-thread-name">
              새 쓰레드 이름
            </label>
            <input
              id="todo-transfer-thread-name"
              type="text"
              value={threadName}
              onChange={(event) => setThreadName(event.target.value)}
              className="w-full rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
            />
          </div>
        )}

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
            disabled={busy || !projectId || (threadMode === "existing" ? !threadId : !threadName.trim())}
            className="rounded-full bg-telegram-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "이동 중..." : "이동"}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}

function TodoChatDetail({
  chat,
  messages,
  loading,
  error,
  submitBusy,
  onBack,
  onRefresh,
  onRename,
  onDelete,
  onSelectMessage,
  onSubmitMessage
}) {
  const fakeProject = useMemo(() => ({ id: TODO_SCOPE_ID, name: "ToDo" }), []);
  const safeMessages = Array.isArray(messages) ? messages : [];
  const viewportHeight = useVisualViewportHeight();
  const scrollRef = useRef(null);
  useTouchScrollBoundaryLock(scrollRef);

  return (
    <div className="flex min-h-0 flex-col overflow-hidden" style={{ height: viewportHeight ? `${viewportHeight}px` : "100dvh" }}>
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
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 pb-4">
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
              <MessageBubble align="right" tone="brand" title="메모" meta={formatRelativeTime(message.updated_at)}>
                <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm leading-6">{message.content}</p>
              </MessageBubble>
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

      <div className="shrink-0 border-t border-white/10 bg-slate-950/92 px-4 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] pt-2 backdrop-blur">
        <div className="mx-auto w-full max-w-3xl">
          <InlineIssueComposer
            busy={submitBusy}
            selectedProject={fakeProject}
            onSubmit={({ prompt }) => onSubmitMessage(prompt)}
            label="메모"
          />
        </div>
      </div>
    </div>
  );
}

function ProjectInstructionDialog({ open, busy, project, instructionType, onClose, onSubmit }) {
  const [value, setValue] = useState("");
  const [dirty, setDirty] = useState(false);
  const draftScopeRef = useRef("");
  const instructionValue = instructionType === "developer" ? (project?.developer_instructions ?? "") : (project?.base_instructions ?? "");
  const draftScope = open && project ? `${project.id}:${instructionType}` : "";

  useEffect(() => {
    if (!open) {
      setValue("");
      setDirty(false);
      draftScopeRef.current = "";
      return;
    }

    if (!project) {
      return;
    }

    if (draftScopeRef.current !== draftScope) {
      draftScopeRef.current = draftScope;
      setValue(instructionValue);
      setDirty(false);
      return;
    }

    if (!dirty) {
      setValue(instructionValue);
    }
  }, [dirty, draftScope, instructionValue, open, project]);

  if (!open || !project) {
    return null;
  }

  const isDeveloperInstruction = instructionType === "developer";

  return (
    <BottomSheet
      open={open}
      title={isDeveloperInstruction ? "개발지침" : "일반지침"}
      description={`${project.name} 프로젝트에 저장하고 새 thread 시작 시 app-server에 주입합니다.`}
      onClose={onClose}
      variant="center"
    >
      <form
        className="space-y-5 px-5 py-5"
        onSubmit={async (event) => {
          event.preventDefault();
          await onSubmit({
            instructionType,
            value
          });
        }}
      >
        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="project-instruction-input">
            {isDeveloperInstruction ? "개발지침 본문" : "일반지침 본문"}
          </label>
          <textarea
            id="project-instruction-input"
            rows="10"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setDirty(true);
            }}
            placeholder={
              isDeveloperInstruction
                ? "예: 코드 스타일, 테스트 기준, 금지사항 같은 개발 규칙을 입력해 주세요."
                : "예: 작업 방식, 응답 톤, 우선순위 같은 기본 지침을 입력해 주세요."
            }
            className="w-full rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
          />
          <p className="mt-2 text-[11px] leading-5 text-slate-400">
            비워 두고 저장하면 해당 지침은 제거됩니다.
          </p>
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
            disabled={busy}
            className="rounded-full bg-telegram-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "저장 중..." : "저장"}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}

function ThreadListItem({
  thread,
  active,
  selected = false,
  selectionMode = false,
  signalNow,
  onOpen,
  onRename,
  onDelete,
  onToggleSelect,
  onEnterSelectionMode
}) {
  const status = getStatusMeta(thread.status);
  const responseSignal = buildThreadResponseSignal(thread, signalNow);
  const contextUsageLabel = formatThreadContextUsage(thread);
  const startPointRef = useRef(null);
  const baseOffsetRef = useRef(0);
  const pointerIdRef = useRef(null);
  const swipeAxisRef = useRef(null);
  const offsetRef = useRef(0);
  const movedRef = useRef(false);
  const longPressTimerRef = useRef(null);
  const longPressTriggeredRef = useRef(false);
  const ACTION_WIDTH = 92;
  const SNAP_THRESHOLD = 42;
  const LONG_PRESS_TRIGGER_MS = 420;
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const highlighted = selectionMode ? selected : active;

  const clearPendingLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

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
    longPressTriggeredRef.current = false;
    setDragging(false);
    event.currentTarget.setPointerCapture?.(event.pointerId);

    clearPendingLongPress();

    if (event.pointerType === "touch" || event.pointerType === "pen") {
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTimerRef.current = null;
        longPressTriggeredRef.current = true;
        setRevealOffset(0);
        onEnterSelectionMode?.(thread.id);
      }, LONG_PRESS_TRIGGER_MS);
    }
  }, [clearPendingLongPress, onEnterSelectionMode, setRevealOffset, thread.id]);

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

        clearPendingLongPress();
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
    [clearPendingLongPress, setRevealOffset]
  );

  const handlePointerUp = useCallback((event) => {
    if (startPointRef.current === null) {
      return;
    }

    clearPendingLongPress();

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
  }, [clearPendingLongPress, setRevealOffset]);

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
          !selectionMode && showDeleteAction ? "opacity-100" : "pointer-events-none opacity-0"
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
          !selectionMode && showRenameAction ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        편집
      </button>

      <button
        type="button"
        data-testid={`thread-list-item-${thread.id}`}
        onPointerDown={selectionMode ? undefined : handlePointerDown}
        onPointerMove={selectionMode ? undefined : handlePointerMove}
        onPointerUp={selectionMode ? undefined : handlePointerUp}
        onPointerCancel={selectionMode ? undefined : handlePointerUp}
        onClick={() => {
          if (longPressTriggeredRef.current) {
            longPressTriggeredRef.current = false;
            return;
          }

          if (movedRef.current) {
            movedRef.current = false;
            return;
          }

          if (offsetRef.current !== 0) {
            setRevealOffset(0);
            return;
          }

          if (selectionMode) {
            onToggleSelect?.(thread.id);
            return;
          }

          onOpen(thread.id);
        }}
        onContextMenu={(event) => {
          if (!selectionMode) {
            event.preventDefault();
          }
        }}
        className={`thread-list-item-touch-target relative w-full px-3 py-3 text-left ${
          dragging ? "" : "transition-transform duration-180 ease-out"
        } ${highlighted ? "bg-slate-900" : "bg-slate-950 hover:bg-slate-900/90"} `}
        aria-pressed={selectionMode ? selected : undefined}
        aria-label={selectionMode ? `${thread.title} 선택` : undefined}
        style={{
          transform: `translate3d(${offset}px, 0, 0)`,
          touchAction: selectionMode ? "auto" : "pan-y",
          willChange: "transform"
        }}
      >
        <div
          className={`min-w-0 rounded-2xl border px-3 py-3 ${
            highlighted
              ? "border-white/12 bg-white/[0.03]"
              : "border-transparent bg-transparent"
          }`}
        >
          <div className="flex items-start gap-3">
            {selectionMode ? (
              <span
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                  selected
                    ? "border-telegram-400 bg-telegram-500 text-white"
                    : "border-white/20 bg-white/[0.03] text-transparent"
                }`}
                aria-hidden="true"
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" />
                </svg>
              </span>
            ) : null}

            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <p className="thread-title min-w-0 flex-1 truncate text-sm font-semibold text-white">{thread.title}</p>
                <span className="shrink-0 text-[11px] text-slate-500">{formatRelativeTime(thread.updated_at)}</span>
              </div>

              <p className="thread-preview mt-1 text-[13px] leading-5 text-slate-300">{getThreadPreview(thread)}</p>

              <div className="mt-2 flex items-center gap-2">
                <span
                  className={`inline-flex items-center gap-2 rounded-full border px-2 py-0.5 text-[10px] ${
                    responseSignal ? "" : `${status.chipClassName} border-transparent`
                  }`}
                  style={responseSignal?.chipStyle}
                  title={responseSignal?.title}
                >
                  <span
                    className={`h-2 w-2 rounded-full ${responseSignal ? "" : status.dotClassName}`}
                    style={responseSignal ? { backgroundColor: responseSignal.dotColor } : undefined}
                  />
                  {status.label}
                </span>
                {contextUsageLabel ? (
                  <span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] text-slate-300">
                    {contextUsageLabel}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </button>
    </div>
  );
}

function MessageBubble({ align = "left", tone = "light", title, meta, children, onLongPress = null, longPressTitle = "" }) {
  const bubbleClassName =
    tone === "brand"
      ? "bg-telegram-500 text-white"
      : tone === "system"
        ? "border border-white/10 bg-white/[0.06] text-slate-200"
      : tone === "success"
        ? "bg-emerald-100 text-slate-900"
        : tone === "warn"
          ? "bg-amber-100 text-slate-900"
          : tone === "danger"
            ? "bg-rose-100 text-slate-900"
            : "bg-white text-slate-900";
  const wrapperClassName =
    align === "right" ? "justify-end" : align === "center" ? "justify-center" : "justify-start";
  const longPressTimerRef = useRef(null);
  const longPressTriggeredRef = useRef(false);
  const pointerStartRef = useRef(null);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const resetLongPressState = useCallback(() => {
    clearLongPressTimer();
    pointerStartRef.current = null;
  }, [clearLongPressTimer]);

  useEffect(() => () => resetLongPressState(), [resetLongPressState]);

  const beginLongPress = useCallback(
    (event) => {
      if (!onLongPress) {
        return;
      }

      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }

      longPressTriggeredRef.current = false;
      resetLongPressState();
      pointerStartRef.current = {
        x: event.clientX,
        y: event.clientY,
        pointerId: event.pointerId
      };
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTriggeredRef.current = true;
        onLongPress();
      }, MESSAGE_BUBBLE_LONG_PRESS_DELAY_MS);
    },
    [onLongPress, resetLongPressState]
  );

  const cancelLongPress = useCallback(() => {
    resetLongPressState();
  }, [resetLongPressState]);

  const handlePointerMove = useCallback(
    (event) => {
      if (!onLongPress || !pointerStartRef.current) {
        return;
      }

      if (pointerStartRef.current.pointerId !== event.pointerId) {
        return;
      }

      const deltaX = event.clientX - pointerStartRef.current.x;
      const deltaY = event.clientY - pointerStartRef.current.y;

      if (Math.hypot(deltaX, deltaY) > MESSAGE_BUBBLE_LONG_PRESS_MOVE_TOLERANCE_PX) {
        resetLongPressState();
      }
    },
    [onLongPress, resetLongPressState]
  );

  const handleContextMenu = useCallback(
    (event) => {
      if (!onLongPress) {
        return;
      }

      event.preventDefault();
    },
    [onLongPress]
  );

  const handleClickCapture = useCallback((event) => {
    if (!longPressTriggeredRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    longPressTriggeredRef.current = false;
  }, []);

  return (
    <div className={`message-enter flex min-w-0 ${wrapperClassName}`} data-testid={`message-bubble-${tone}`}>
      <article
        className={`min-w-0 max-w-[86%] overflow-hidden rounded-[1.35rem] px-4 py-3 ${bubbleClassName} ${onLongPress ? "select-none" : ""}`}
        title={longPressTitle || undefined}
        onPointerDown={beginLongPress}
        onPointerUp={cancelLongPress}
        onPointerLeave={cancelLongPress}
        onPointerCancel={cancelLongPress}
        onPointerMove={handlePointerMove}
        onContextMenu={handleContextMenu}
        onClickCapture={handleClickCapture}
      >
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
  signalNow,
  messagesLoading,
  messagesError,
  onRefreshMessages,
  onStopThreadExecution,
  onInterruptIssue,
  onDeleteIssue,
  onSubmitPrompt,
  submitBusy,
  onBack,
  messageFilter,
  onChangeMessageFilter,
  isDraft = false
}) {
  const status = thread ? getStatusMeta(thread.status) : null;
  const responseSignal = thread ? buildThreadResponseSignal(thread, signalNow) : null;
  const viewportHeight = useVisualViewportHeight();
  const scrollRef = useRef(null);
  const scrollAnchorRef = useRef(null);
  const previousScrollTopRef = useRef(0);
  const pinnedToLatestRef = useRef(true);
  const [isPinnedToLatest, setIsPinnedToLatest] = useState(true);
  const autoScrollingRef = useRef(false);
  const [showHeaderMenus, setShowHeaderMenus] = useState(true);
  const [refreshPending, setRefreshPending] = useState(false);
  const [interruptingIssueId, setInterruptingIssueId] = useState("");
  const [deletingIssueId, setDeletingIssueId] = useState("");
  const [activeMessageAction, setActiveMessageAction] = useState(null);
  useTouchScrollBoundaryLock(scrollRef);
  const [viewMode] = useState("chat");
  const threadTitle = thread?.title ?? "새 채팅창";
  const threadTimestamp = thread?.created_at ?? new Date().toISOString();
  const contextUsage = getThreadContextUsage(thread);
  const safeIssues = Array.isArray(issues) ? issues : [];
  const issueById = useMemo(() => {
    const next = new Map();

    safeIssues.forEach((issue) => {
      const normalized = normalizeIssue(issue, thread?.id);

      if (normalized) {
        next.set(normalized.id, normalized);
      }
    });

    return next;
  }, [safeIssues, thread?.id]);
  const activePhysicalThreadId = thread?.active_physical_thread_id ?? null;
  const interruptibleIssue = useMemo(() => {
    const activeIssue = findActiveIssueForThread(safeIssues, activePhysicalThreadId);

    if (!activeIssue || !["running", "awaiting_input"].includes(activeIssue.status ?? "")) {
      return null;
    }

    return activeIssue;
  }, [activePhysicalThreadId, safeIssues]);
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

      const role =
        message.role === "assistant"
          ? "assistant"
          : message.role === "system" || message.kind === "handoff_summary"
            ? "system"
            : "user";
      const content = String(message.content ?? "").trim();
      const timestamp = message.timestamp ?? thread.updated_at ?? thread.created_at ?? new Date().toISOString();
      const base = {
        id: message.id ?? `${role}-${index}`,
        role,
        content,
        timestamp,
        issueId: message.issue_id ?? null
      };

      if (role === "system") {
        lastPrompt = null;
        normalized.push({
          ...base,
          align: "center",
          tone: "system",
          title: message.kind === "handoff_summary" ? "핸드오프 요약" : "시스템"
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

      const role =
        message.role === "assistant"
          ? "assistant"
          : message.role === "system" || message.kind === "handoff_summary"
            ? "system"
            : "user";
      const content = String(message.content ?? "").trim();
      const timestamp = message.timestamp ?? fallbackTimestamp;
      const identifier = message.id ?? `${role}-${index}`;

      if (role === "system") {
        commitGroup();
        groups.push({
          id: identifier,
          prompt: message.kind === "handoff_summary" ? "핸드오프 요약" : "시스템 메시지",
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
  const visibleChatTimelineSignature = useMemo(
    () =>
      visibleChatTimeline
        .map((entry) => `${entry.id}:${entry.timestamp ?? ""}:${entry.role}:${String(entry.content ?? "").length}`)
        .join("|"),
    [visibleChatTimeline]
  );

  const recomputePinnedState = useCallback(() => {
    const scrollNode = scrollRef.current;

    if (!scrollNode) {
      return;
    }

    const distanceFromBottom = getDistanceFromBottom(scrollNode);
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
          const distanceFromBottom = getDistanceFromBottom(node);
          const shouldGuardHeaderAtBottom =
            distanceFromBottom <= BOTTOM_BOUNDARY_HEADER_GUARD_PX || isBottomBoundaryMomentumLocked(node);

          if (nextScrollTop <= 8) {
            setShowHeaderMenus(true);
          } else if (shouldGuardHeaderAtBottom) {
            previousScrollTopRef.current = nextScrollTop;
            recomputePinnedState();
            return;
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
  }, [isPinnedToLatest, recomputePinnedState, thread?.id, viewMode, visibleChatTimelineSignature]);

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

  const handleCopyMessage = useCallback(async (content) => {
    try {
      await copyTextToClipboard(content);

      if (typeof window !== "undefined") {
        window.alert("텍스트를 복사했습니다.");
      }

      return true;
    } catch (error) {
      if (typeof window !== "undefined") {
        window.alert(error.message ?? "텍스트를 복사하지 못했습니다.");
      }

      return false;
    }
  }, []);

  useEffect(() => {
    setActiveMessageAction(null);
    setInterruptingIssueId("");
    setDeletingIssueId("");
  }, [thread?.id]);

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
    <div className="flex min-h-0 flex-col overflow-hidden" style={{ height: viewportHeight ? `${viewportHeight}px` : "100dvh" }}>
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
              {status ? (
                <span
                  className={`h-1.5 w-1.5 rounded-full ${responseSignal ? "" : status.dotClassName}`}
                  style={responseSignal ? { backgroundColor: responseSignal.dotColor } : undefined}
                />
              ) : null}
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

      <div
        ref={scrollRef}
        className="telegram-grid touch-scroll-boundary-lock min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-5"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 pb-4">
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
            visibleChatTimeline.map((message) => {
              const canCopy = Boolean(String(message.content ?? "").trim());
              const canDelete = canDeleteIssueFromBubble(message.issueId);
              const canOpenActionSheet = canCopy || canDelete;

              return (
                <MessageBubble
                  key={message.id}
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
                  <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm leading-6">
                    {message.content || (message.role === "assistant" ? "응답을 기다리고 있습니다..." : "프롬프트가 비어 있습니다.")}
                  </p>
                </MessageBubble>
              );
            })
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
                  <p className="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm leading-6 text-slate-200">
                    {response.content || "응답이 비어 있습니다."}
                  </p>
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

      <ThreadMessageActionSheet
        open={Boolean(activeMessageAction)}
        message={activeMessageAction}
        busy={
          Boolean(
            activeMessageAction?.issueId &&
              (interruptingIssueId === activeMessageAction.issueId || deletingIssueId === activeMessageAction.issueId)
          )
        }
        onClose={() => {
          if (!interruptingIssueId && !deletingIssueId) {
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

      <div className="shrink-0 border-t border-white/10 bg-slate-950/92 px-4 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] pt-2 backdrop-blur">
        <div className="mx-auto w-full max-w-3xl">
          <InlineIssueComposer
            busy={submitBusy}
            selectedProject={project}
            onSubmit={onSubmitPrompt}
            label={isDraft ? "첫 프롬프트" : "프롬프트"}
            disabled={isInputDisabled}
            onStop={interruptibleIssue ? handleStopCurrentExecution : null}
            stopBusy={Boolean(interruptibleIssue?.id && interruptingIssueId === interruptibleIssue.id)}
            stopLabel={interruptibleIssue?.status === "awaiting_input" ? "입력 중단" : "중단"}
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
  bridgeSignal,
  signalNow,
  projects,
  threads,
  todoChats,
  threadOptionsByProjectId,
  threadDetail,
  todoChatDetail,
  workspaceRoots,
  folderState,
  folderLoading,
  selectedWorkspacePath,
  selectedBridgeId,
  selectedScope,
  selectedThreadId,
  selectedTodoChatId,
  draftThreadProjectId,
  search,
  loadingState,
  projectBusy,
  threadBusy,
  todoBusy,
  todoRenameBusy,
  todoTransferBusy,
  projectInstructionBusy,
  renameBusy,
  threadDeleteDialog,
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
  onSelectTodoScope,
  onSelectThread,
  onSelectTodoChat,
  onOpenNewThread,
  onOpenNewTodoChat,
  onOpenUtility,
  onOpenProjectComposer,
  onOpenProjectInstructionDialog,
  onInstallPwa,
  onDismissInstallPrompt,
  onCloseUtility,
  onCloseProjectComposer,
  projectInstructionDialogOpen,
  projectInstructionType,
  onCloseProjectInstructionDialog,
  onBrowseWorkspaceRoot,
  onBrowseFolder,
  onSelectWorkspace,
  onSubmitProject,
  onSubmitProjectInstruction,
  onCreateThread,
  onAppendThreadMessage,
  onSubmitTodoMessage,
  onRenameThread,
  onRenameTodoChat,
  onDeleteThread,
  onDeleteThreads,
  onCloseThreadDeleteDialog,
  onConfirmThreadDeleteDialog,
  onDeleteTodoChat,
  onDeleteProject,
  onEditTodoMessage,
  onDeleteTodoMessage,
  onTransferTodoMessage,
  onEnsureProjectThreads,
  onRefreshTodoChat,
  onRefreshThreadDetail,
  onStopThreadExecution,
  onInterruptThreadIssue,
  onDeleteThreadIssue,
  onRefresh,
  onLogout,
  onBackToInbox
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [threadBeingEdited, setThreadBeingEdited] = useState(null);
  const [threadSelectionMode, setThreadSelectionMode] = useState(false);
  const [selectedThreadIds, setSelectedThreadIds] = useState([]);
  const [todoChatBeingEdited, setTodoChatBeingEdited] = useState(null);
  const [activeTodoMessage, setActiveTodoMessage] = useState(null);
  const [todoMessageEditorOpen, setTodoMessageEditorOpen] = useState(false);
  const [todoTransferOpen, setTodoTransferOpen] = useState(false);
  const projectLongPressTimerRef = useRef(null);
  const projectLongPressTriggeredRef = useRef(false);
  const deferredSearch = useDeferredValue(search);
  const searchKeyword = deferredSearch.trim().toLowerCase();
  const isTodoScope = selectedScope?.kind === "todo";
  const selectedProjectId = selectedScope?.kind === "project" ? selectedScope.id : "";
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const draftProject = projects.find((project) => project.id === draftThreadProjectId) ?? null;
  const selectedThread = threads.find((thread) => thread.id === selectedThreadId) ?? null;
  const selectedTodoChat = todoChats.find((chat) => chat.id === selectedTodoChatId) ?? null;
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
  const filteredTodoChats = useMemo(() => {
    return todoChats.filter((chat) => {
      const matchesSearch =
        !searchKeyword ||
        chat.title.toLowerCase().includes(searchKeyword) ||
        (chat.last_message ?? "").toLowerCase().includes(searchKeyword);

      return matchesSearch;
    });
  }, [searchKeyword, todoChats]);
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
  const selectedProjectThreadIds = useMemo(
    () =>
      new Set(
        threads
          .filter((thread) => !selectedProjectId || thread.project_id === selectedProjectId)
          .map((thread) => thread.id)
      ),
    [selectedProjectId, threads]
  );
  const threadDetailMessages = threadDetail?.messages ?? [];
  const threadDetailLoading = threadDetail?.loading ?? false;
  const threadDetailError = threadDetail?.error ?? "";
  const todoChatMessages = todoChatDetail?.messages ?? [];
  const todoChatLoading = todoChatDetail?.loading ?? false;
  const todoChatError = todoChatDetail?.error ?? "";
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
  useEffect(() => {
    setSelectedThreadIds((current) => current.filter((threadId) => selectedProjectThreadIds.has(threadId)));
  }, [selectedProjectThreadIds]);
  useEffect(() => {
    if (activeView !== "inbox" || isTodoScope) {
      setThreadSelectionMode(false);
      setSelectedThreadIds([]);
    }
  }, [activeView, isTodoScope]);
  useEffect(() => {
    if (!threadSelectionMode) {
      return;
    }

    if (filteredThreads.length === 0) {
      setThreadSelectionMode(false);
    }
  }, [filteredThreads.length, threadSelectionMode]);
  useEffect(() => {
    if (threadSelectionMode && selectedThreadIds.length === 0) {
      setThreadSelectionMode(false);
    }
  }, [selectedThreadIds.length, threadSelectionMode]);
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

      setThreadSelectionMode(false);
      setSelectedThreadIds([]);
      onSelectProject(projectId);
    },
    [onSelectProject]
  );
  const handleEnterThreadSelectionMode = useCallback((threadId = "") => {
    const normalizedThreadId = String(threadId ?? "").trim();

    if (filteredThreads.length === 0) {
      return;
    }

    setThreadSelectionMode(true);
    setSelectedThreadIds((current) => {
      if (!normalizedThreadId) {
        return current;
      }

      if (current.includes(normalizedThreadId)) {
        return current;
      }

      return [...current, normalizedThreadId];
    });
  }, [filteredThreads.length]);
  const handleCancelThreadSelection = useCallback(() => {
    setThreadSelectionMode(false);
    setSelectedThreadIds([]);
  }, []);
  const handleToggleThreadSelection = useCallback((threadId) => {
    const normalizedThreadId = String(threadId ?? "").trim();

    if (!normalizedThreadId) {
      return;
    }

    setThreadSelectionMode(true);
    setSelectedThreadIds((current) =>
      current.includes(normalizedThreadId)
        ? current.filter((currentThreadId) => currentThreadId !== normalizedThreadId)
        : [...current, normalizedThreadId]
    );
  }, []);
  const handleDeleteSelectedThreads = useCallback(async () => {
    if (selectedThreadIds.length === 0) {
      return;
    }

    const result = await onDeleteThreads(selectedThreadIds);
    const deletedThreadIds = Array.isArray(result?.deletedThreadIds)
      ? result.deletedThreadIds.map((threadId) => String(threadId ?? "").trim()).filter(Boolean)
      : [];

    if (deletedThreadIds.length > 0) {
      setSelectedThreadIds((current) =>
        current.filter((threadId) => !deletedThreadIds.includes(String(threadId ?? "").trim()))
      );
    }

    if (result?.accepted !== false && result !== false) {
      setThreadSelectionMode(false);
      setSelectedThreadIds([]);
      return;
    }

  }, [onDeleteThreads, selectedThreadIds]);

  if (activeView === "todo" && selectedTodoChatId) {
    return (
      <div className="telegram-shell min-h-screen bg-slate-950 text-slate-100">
        <TodoChatDetail
          chat={selectedTodoChat ?? todoChatDetail?.chat ?? null}
          messages={todoChatMessages}
          loading={todoChatLoading}
          error={todoChatError}
          submitBusy={todoBusy}
          onBack={onBackToInbox}
          onRefresh={onRefreshTodoChat}
          onRename={() => setTodoChatBeingEdited(selectedTodoChat ?? todoChatDetail?.chat ?? null)}
          onDelete={() => {
            const targetChat = selectedTodoChat ?? todoChatDetail?.chat ?? null;

            if (!targetChat) {
              return;
            }

            void onDeleteTodoChat(targetChat.id);
          }}
          onSelectMessage={(message) => setActiveTodoMessage(message)}
          onSubmitMessage={onSubmitTodoMessage}
        />
        <TodoChatRenameDialog
          open={Boolean(todoChatBeingEdited)}
          busy={todoRenameBusy}
          chat={todoChatBeingEdited}
          onClose={() => setTodoChatBeingEdited(null)}
          onSubmit={(title) => onRenameTodoChat(todoChatBeingEdited?.id, title)}
        />
        <TodoMessageActionSheet
          open={Boolean(activeTodoMessage) && !todoMessageEditorOpen && !todoTransferOpen}
          message={activeTodoMessage}
          onClose={() => setActiveTodoMessage(null)}
          onEdit={() => setTodoMessageEditorOpen(true)}
          onDelete={async () => {
            const accepted = await onDeleteTodoMessage(activeTodoMessage?.id);

            if (accepted !== false) {
              setActiveTodoMessage(null);
            }
          }}
          onTransfer={() => setTodoTransferOpen(true)}
        />
        <TodoMessageEditorDialog
          open={todoMessageEditorOpen}
          busy={todoBusy}
          message={activeTodoMessage}
          onClose={() => setTodoMessageEditorOpen(false)}
          onSubmit={async (content) => {
            const accepted = await onEditTodoMessage(activeTodoMessage?.id, content);

            if (accepted !== false) {
              setTodoMessageEditorOpen(false);
              setActiveTodoMessage(null);
            }

            return accepted;
          }}
        />
        <TodoTransferSheet
          open={todoTransferOpen}
          busy={todoTransferBusy}
          message={activeTodoMessage}
          projects={projects}
          threadOptionsByProjectId={threadOptionsByProjectId}
          selectedProjectId={selectedProjectId}
          onEnsureProjectThreads={onEnsureProjectThreads}
          onClose={() => setTodoTransferOpen(false)}
          onSubmit={async (payload) => {
            const accepted = await onTransferTodoMessage(activeTodoMessage?.id, payload);

            if (accepted !== false) {
              setTodoTransferOpen(false);
              setActiveTodoMessage(null);
            }

            return accepted;
          }}
        />
      </div>
    );
  }

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
          signalNow={signalNow}
          messagesLoading={threadDetailLoading}
          messagesError={threadDetailError}
          onRefreshMessages={resolvedThread?.id ? onRefreshThreadDetail : null}
          onStopThreadExecution={resolvedThread?.id ? onStopThreadExecution : null}
          onInterruptIssue={resolvedThread?.id ? onInterruptThreadIssue : null}
          onDeleteIssue={resolvedThread?.id ? onDeleteThreadIssue : null}
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
        <div className="sticky top-0 z-20 bg-slate-950/95 backdrop-blur-xl">
          <header className="border-b border-white/10 px-4 py-3">
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
                <h1 className="truncate text-base font-semibold text-white">OctOP</h1>
                <div className="mt-0.5">
                  <BridgeDropdown
                    bridges={bridges}
                    selectedBridgeId={selectedBridgeId}
                    bridgeSignal={bridgeSignal}
                    onSelectBridge={onSelectBridge}
                  />
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

          <div className="border-b border-white/10 px-4 pb-3 pt-2">
            <div className="flex gap-2 overflow-x-auto pb-1">
              <button
                type="button"
                onClick={() => onSelectTodoScope()}
                className={`shrink-0 rounded-full px-3 py-1.5 text-[13px] font-medium transition select-none touch-manipulation ${
                  isTodoScope ? "bg-white text-slate-900" : "bg-transparent text-slate-400 hover:text-white"
                }`}
              >
                ToDo
              </button>
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
                    !isTodoScope && project.id === selectedProjectId
                      ? "bg-white text-slate-900"
                      : "bg-transparent text-slate-400 hover:text-white"
                  }`}
                >
                  {project.name}
                </button>
              ))}
            </div>
          </div>
        </div>

        <main className="flex-1 px-4 pb-28 pt-3">
          <section className="mt-1">
            {isTodoScope ? (
              filteredTodoChats.length === 0 ? (
                <div className="px-2 py-10 text-center text-sm leading-7 text-slate-400">
                  {loadingState === "loading"
                    ? "데이터를 동기화하고 있습니다."
                    : "조건에 맞는 ToDo 채팅이 없습니다. 새 ToDo 채팅을 만들어 아이디어를 쌓아 주세요."}
                </div>
              ) : (
                filteredTodoChats.map((chat) => (
                  <TodoChatListItem
                    key={chat.id}
                    chat={chat}
                    active={chat.id === selectedTodoChatId}
                    onOpen={onSelectTodoChat}
                    onRename={(targetChat) => setTodoChatBeingEdited(targetChat)}
                    onDelete={(targetChat) => void onDeleteTodoChat(targetChat.id)}
                  />
                ))
              )
            ) : (
              <>
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
                      selected={selectedThreadIds.includes(thread.id)}
                      selectionMode={threadSelectionMode}
                      signalNow={signalNow}
                      onOpen={onSelectThread}
                      onRename={(targetThread) => setThreadBeingEdited(targetThread)}
                      onDelete={(targetThread) => void onDeleteThread(targetThread.id)}
                      onToggleSelect={handleToggleThreadSelection}
                      onEnterSelectionMode={handleEnterThreadSelectionMode}
                    />
                  ))
                )}
              </>
            )}
          </section>
        </main>

        <div className="fixed inset-x-0 bottom-0 z-30 mx-auto flex w-full max-w-3xl justify-center border-t border-white/10 bg-slate-950/92 px-4 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] pt-2 backdrop-blur">
          {threadSelectionMode && !isTodoScope ? (
            <div className="flex w-full items-center gap-3">
              <button
                type="button"
                onClick={handleCancelThreadSelection}
                disabled={threadBusy}
                className="rounded-full border border-white/10 px-4 py-3 text-sm font-medium text-slate-200 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-45"
              >
                취소
              </button>
              <button
                type="button"
                onClick={() => void handleDeleteSelectedThreads()}
                disabled={threadBusy || selectedThreadIds.length === 0}
                aria-label="선택한 채팅창 삭제"
                className="flex-1 rounded-full bg-rose-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {threadBusy ? "삭제 중..." : `선택 ${selectedThreadIds.length}개 삭제`}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => (isTodoScope ? onOpenNewTodoChat() : onOpenNewThread(selectedProjectId))}
              disabled={isTodoScope ? false : !selectedProject}
              className="w-full rounded-full bg-telegram-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {isTodoScope ? "새 ToDo 채팅" : "새 채팅창"}
            </button>
          )}
        </div>
      </div>

      <ThreadRenameDialog
        open={Boolean(threadBeingEdited)}
        busy={renameBusy}
        thread={threadBeingEdited}
        onClose={() => setThreadBeingEdited(null)}
        onSubmit={(title) => onRenameThread(threadBeingEdited?.id, title)}
      />
      <DeleteConfirmDialog
        open={threadDeleteDialog.open}
        busy={threadBusy}
        title={threadDeleteDialog.title}
        description={threadDeleteDialog.description}
        confirmLabel={threadDeleteDialog.confirmLabel}
        onClose={onCloseThreadDeleteDialog}
        onConfirm={onConfirmThreadDeleteDialog}
      />
      <TodoChatRenameDialog
        open={Boolean(todoChatBeingEdited)}
        busy={todoRenameBusy}
        chat={todoChatBeingEdited}
        onClose={() => setTodoChatBeingEdited(null)}
        onSubmit={(title) => onRenameTodoChat(todoChatBeingEdited?.id, title)}
      />
      <TodoMessageActionSheet
        open={Boolean(activeTodoMessage) && !todoMessageEditorOpen && !todoTransferOpen}
        message={activeTodoMessage}
        onClose={() => setActiveTodoMessage(null)}
        onEdit={() => setTodoMessageEditorOpen(true)}
        onDelete={async () => {
          const accepted = await onDeleteTodoMessage(activeTodoMessage?.id);

          if (accepted !== false) {
            setActiveTodoMessage(null);
          }
        }}
        onTransfer={() => setTodoTransferOpen(true)}
      />
      <TodoMessageEditorDialog
        open={todoMessageEditorOpen}
        busy={todoBusy}
        message={activeTodoMessage}
        onClose={() => setTodoMessageEditorOpen(false)}
        onSubmit={async (content) => {
          const accepted = await onEditTodoMessage(activeTodoMessage?.id, content);

          if (accepted !== false) {
            setTodoMessageEditorOpen(false);
            setActiveTodoMessage(null);
          }

          return accepted;
        }}
      />
      <TodoTransferSheet
        open={todoTransferOpen}
        busy={todoTransferBusy}
        message={activeTodoMessage}
        projects={projects}
        threadOptionsByProjectId={threadOptionsByProjectId}
        selectedProjectId={selectedProjectId}
        onEnsureProjectThreads={onEnsureProjectThreads}
        onClose={() => setTodoTransferOpen(false)}
        onSubmit={async (payload) => {
          const accepted = await onTransferTodoMessage(activeTodoMessage?.id, payload);

          if (accepted !== false) {
            setTodoTransferOpen(false);
            setActiveTodoMessage(null);
          }

          return accepted;
        }}
      />
      <UtilitySheet
        open={utilityOpen}
        session={session}
        bridgeSignal={bridgeSignal}
        selectedProject={selectedProject}
        onOpenProjectInstructionDialog={onOpenProjectInstructionDialog}
        onClose={onCloseUtility}
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
      <ProjectInstructionDialog
        open={projectInstructionDialogOpen}
        busy={projectInstructionBusy}
        project={selectedProject}
        instructionType={projectInstructionType}
        onClose={onCloseProjectInstructionDialog}
        onSubmit={onSubmitProjectInstruction}
      />
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(() => (typeof window === "undefined" ? null : readStoredSession()));
  const [loginState, setLoginState] = useState({ loading: false, error: "" });
  const [bridges, setBridges] = useState([]);
  const [status, setStatus] = useState(() => createDefaultStatus());
  const [projects, setProjects] = useState([]);
  const [threads, setThreads] = useState([]);
  const [threadListsByProjectId, setThreadListsByProjectId] = useState({});
  const [todoChats, setTodoChats] = useState([]);
  const [threadDetails, setThreadDetails] = useState({});
  const [todoChatDetails, setTodoChatDetails] = useState({});
  const [workspaceRoots, setWorkspaceRoots] = useState([]);
  const [folderState, setFolderState] = useState({ path: "", parent_path: null, entries: [] });
  const [folderLoading, setFolderLoading] = useState(false);
  const [selectedWorkspacePath, setSelectedWorkspacePath] = useState("");
  const [selectedBridgeId, setSelectedBridgeId] = useState(() =>
    typeof window === "undefined" ? "" : readStoredBridgeId()
  );
  const [selectedScope, setSelectedScope] = useState({ kind: "project", id: "" });
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [selectedTodoChatId, setSelectedTodoChatId] = useState("");
  const [draftThreadProjectId, setDraftThreadProjectId] = useState("");
  const [search, setSearch] = useState("");
  const [loadingState, setLoadingState] = useState("idle");
  const [utilityOpen, setUtilityOpen] = useState(false);
  const [projectComposerOpen, setProjectComposerOpen] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectInstructionDialogOpen, setProjectInstructionDialogOpen] = useState(false);
  const [projectInstructionBusy, setProjectInstructionBusy] = useState(false);
  const [projectInstructionType, setProjectInstructionType] = useState("base");
  const [threadBusy, setThreadBusy] = useState(false);
  const [threadDeleteDialog, setThreadDeleteDialog] = useState({
    open: false,
    title: "채팅창 삭제",
    description: "",
    confirmLabel: "삭제"
  });
  const [todoBusy, setTodoBusy] = useState(false);
  const [todoRenameBusy, setTodoRenameBusy] = useState(false);
  const [todoTransferBusy, setTodoTransferBusy] = useState(false);
  const [renameBusy, setRenameBusy] = useState(false);
  const [activeView, setActiveView] = useState("inbox");
  const [threadMessageFilter, setThreadMessageFilter] = useState("all");
  const [streamActivityAt, setStreamActivityAt] = useState(null);
  const [streamNow, setStreamNow] = useState(() => Date.now());
  const [eventStreamReconnectToken, setEventStreamReconnectToken] = useState(0);
  const [deferredInstallPrompt, setDeferredInstallPrompt] = useState(null);
  const [installPromptVisible, setInstallPromptVisible] = useState(false);
  const [installBusy, setInstallBusy] = useState(false);
  const [pwaUpdateVisible, setPwaUpdateVisible] = useState(false);
  const [pwaUpdateBusy, setPwaUpdateBusy] = useState(false);
  const activeViewRef = useRef(activeView);
  const pendingUpdateActivatorRef = useRef(null);
  const threadLoadRequestIdByIdRef = useRef(new Map());
  const todoChatLoadRequestIdRef = useRef(0);
  const threadReloadTimersByIdRef = useRef(new Map());
  const threadReloadMetaByIdRef = useRef(new Map());
  const threadLiveProgressAtByIdRef = useRef(new Map());
  const lastForegroundResumeAtRef = useRef(0);
  const scheduledResumeTimerRef = useRef(null);
  const scheduledResumeReasonsRef = useRef(new Set());
  const threadDeleteDialogResolverRef = useRef(null);
  const selectedThreadIdRef = useRef("");
  const selectedBridgeIdRef = useRef("");
  const bridgeWorkspaceRequestIdRef = useRef(0);
  const selectedBridgeKnown = !selectedBridgeId || bridges.some((bridge) => bridge.bridge_id === selectedBridgeId);
  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [threads, selectedThreadId]
  );
  const selectedProjectId = selectedScope.kind === "project" ? selectedScope.id : "";
  const bridgeSignal = useMemo(
    () =>
      buildBridgeSignal({
        connected: Boolean(status?.app_server?.connected),
        lastSocketActivityAt: Date.parse(status?.app_server?.last_socket_activity_at ?? ""),
        lastActivityAt: streamActivityAt,
        now: streamNow
      }),
    [status?.app_server?.connected, status?.app_server?.last_socket_activity_at, streamActivityAt, streamNow]
  );
  const currentTodoChatDetail = todoChatDetails[selectedTodoChatId] ?? null;
  const currentThreadDetail = threadDetails[selectedThreadId] ?? null;
  const threadDetailsRef = useRef(threadDetails);
  const clearThreadTransientState = useCallback((threadIds) => {
    const normalizedThreadIds = [...new Set(threadIds.map((threadId) => String(threadId ?? "").trim()).filter(Boolean))];

    for (const threadId of normalizedThreadIds) {
      const timerId = threadReloadTimersByIdRef.current.get(threadId);

      if (timerId) {
        window.clearTimeout(timerId);
      }

      threadReloadTimersByIdRef.current.delete(threadId);
      threadReloadMetaByIdRef.current.delete(threadId);
      threadLoadRequestIdByIdRef.current.delete(threadId);
      threadLiveProgressAtByIdRef.current.delete(threadId);
    }
  }, []);
  const removeDeletedThreadsFromState = useCallback((threadIds) => {
    const normalizedThreadIds = [...new Set(threadIds.map((threadId) => String(threadId ?? "").trim()).filter(Boolean))];

    if (normalizedThreadIds.length === 0) {
      return;
    }

    clearThreadTransientState(normalizedThreadIds);
    setThreads((current) => removeThreadsByIds(current, normalizedThreadIds));
    setThreadListsByProjectId((current) => removeThreadIdsFromProjectCache(current, normalizedThreadIds));
    setThreadDetails((current) => {
      let changed = false;
      const next = { ...current };

      for (const threadId of normalizedThreadIds) {
        if (Object.prototype.hasOwnProperty.call(next, threadId)) {
          delete next[threadId];
          changed = true;
        }
      }

      return changed ? next : current;
    });

    if (normalizedThreadIds.includes(selectedThreadIdRef.current)) {
      setSelectedThreadId("");
      setActiveView("inbox");
    }
  }, [clearThreadTransientState]);
  const markStreamActivity = useCallback(() => {
    setStreamActivityAt(Date.now());
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setStreamNow(Date.now());
    }, 5000);

    return () => {
      window.clearInterval(timer);
    };
  }, []);
  const updateThreadCache = useCallback((projectId, nextThreads) => {
    const normalizedProjectId = String(projectId ?? "").trim();

    if (!normalizedProjectId) {
      return;
    }

    setThreadListsByProjectId((current) => ({
      ...current,
      [normalizedProjectId]: mergeThreads([], nextThreads)
    }));
  }, []);
  const updateThreadCacheRef = useRef(updateThreadCache);
  useEffect(() => {
    updateThreadCacheRef.current = updateThreadCache;
  }, [updateThreadCache]);
  const requestThreadDeleteConfirmation = useCallback(
    ({ title = "채팅창 삭제", description = "", confirmLabel = "삭제" }) =>
      new Promise((resolve) => {
        threadDeleteDialogResolverRef.current = resolve;
        setThreadDeleteDialog({
          open: true,
          title,
          description,
          confirmLabel
        });
      }),
    []
  );
  const closeThreadDeleteDialog = useCallback((accepted = false) => {
    const resolver = threadDeleteDialogResolverRef.current;
    threadDeleteDialogResolverRef.current = null;
    setThreadDeleteDialog((current) => ({ ...current, open: false }));
    if (typeof resolver === "function") {
      resolver(accepted);
    }
  }, []);
  const selectProjectScope = useCallback((projectId) => {
    setSelectedScope({ kind: "project", id: projectId });
  }, []);
  const selectTodoScope = useCallback(() => {
    setSelectedScope({ kind: "todo", id: TODO_SCOPE_ID });
  }, []);
  const currentThreadDetailVersion = currentThreadDetail?.version ?? null;
  const currentThreadDetailLoading = currentThreadDetail?.loading ?? false;
  const currentThreadDetailHasMessages = (currentThreadDetail?.messages?.length ?? 0) > 0;
  const hasCurrentThreadDetail = Boolean(currentThreadDetail);
  const selectedThreadUpdatedAt = selectedThread?.updated_at ?? null;
  const selectedThreadStatus = selectedThread?.status ?? "queued";
  const selectedThreadIssues = useMemo(
    () =>
      (currentThreadDetail?.issues ?? [])
        .map((issue) => normalizeIssue(issue, selectedThreadId))
        .filter(Boolean),
    [currentThreadDetail?.issues, selectedThreadId]
  );
  const selectedActiveIssue = useMemo(
    () => findActiveIssueForThread(selectedThreadIssues, selectedThread?.active_physical_thread_id ?? null),
    [selectedThread?.active_physical_thread_id, selectedThreadIssues]
  );
  const selectedProjectIdRef = useRef(selectedProjectId);
  const selectedTodoChatIdRef = useRef(selectedTodoChatId);

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  useEffect(() => {
    activeViewRef.current = activeView;
  }, [activeView]);

  useEffect(() => {
    selectedBridgeIdRef.current = selectedBridgeId;
    storeSelectedBridgeId(selectedBridgeId);
  }, [selectedBridgeId]);

  useEffect(() => {
    threadDetailsRef.current = threadDetails;
  }, [threadDetails]);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  useEffect(() => {
    selectedTodoChatIdRef.current = selectedTodoChatId;
  }, [selectedTodoChatId]);

  const handleAppForegroundResume = useCallback((reason = "foreground_resume") => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }

    if (!session?.loginId || !selectedBridgeId || !selectedBridgeKnown) {
      return;
    }

    const now = Date.now();

    if (now - lastForegroundResumeAtRef.current < 1500) {
      return;
    }

    lastForegroundResumeAtRef.current = now;
    setEventStreamReconnectToken((current) => current + 1);

    if (selectedThreadId) {
      threadLiveProgressAtByIdRef.current.delete(selectedThreadId);
    }

    if (activeView === "thread" && selectedThreadId) {
      const mode =
        selectedActiveIssue && ["running", "awaiting_input"].includes(selectedActiveIssue.status ?? "")
          ? "active"
          : "full";

      scheduleThreadMessagesReloadRef.current?.(selectedThreadId, {
        force: true,
        mode,
        delay: 0,
        suppressLoadingIndicator: true,
        bypassThrottle: true,
        reason
      });
      return;
    }

    if (selectedScope.kind === "project" && selectedProjectId) {
      void loadProjectThreads(session, selectedBridgeId, selectedProjectId, { applyToInbox: true });
    }
  }, [
    activeView,
    selectedActiveIssue,
    selectedBridgeId,
    selectedBridgeKnown,
    selectedProjectId,
    selectedScope.kind,
    selectedThreadId,
    session
  ]);

  const scheduleAppForegroundResume = useCallback((reason = "foreground_resume") => {
    if (typeof window === "undefined") {
      return;
    }

    scheduledResumeReasonsRef.current.add(reason);

    if (scheduledResumeTimerRef.current) {
      return;
    }

    scheduledResumeTimerRef.current = window.setTimeout(() => {
      const reasonLabel = [...scheduledResumeReasonsRef.current].join(",");
      scheduledResumeReasonsRef.current.clear();
      scheduledResumeTimerRef.current = null;
      handleAppForegroundResume(reasonLabel || reason);
    }, APP_RESUME_COALESCE_MS);
  }, [handleAppForegroundResume]);

  useEffect(() => {
    return () => {
      for (const timerId of threadReloadTimersByIdRef.current.values()) {
        window.clearTimeout(timerId);
      }
      threadReloadTimersByIdRef.current.clear();
    };
  }, []);

  const loadThreadMessages = useCallback(
    async (threadId, { force = false, version = null, suppressLoadingIndicator = false, mode = "full" } = {}) => {
      if (!session?.loginId || !selectedBridgeId || !threadId) {
        return;
      }

      const nextRequestId = (threadLoadRequestIdByIdRef.current.get(threadId) ?? 0) + 1;
      threadLoadRequestIdByIdRef.current.set(threadId, nextRequestId);

      const releaseThreadLoadingState = () => {
        const reloadMeta = threadReloadMetaByIdRef.current.get(threadId) ?? {};
        threadReloadMetaByIdRef.current.set(threadId, {
          ...reloadMeta,
          inFlight: false,
          lastCompletedAt: Date.now()
        });

        setThreadDetails((current) => {
          const currentEntry = current[threadId];

          if (!currentEntry?.loading) {
            return current;
          }

          return {
            ...current,
            [threadId]: {
              ...currentEntry,
              loading: false
            }
          };
        });
      };

      const reloadMeta = threadReloadMetaByIdRef.current.get(threadId) ?? {};
      threadReloadMetaByIdRef.current.set(threadId, {
        ...reloadMeta,
        inFlight: true,
        lastStartedAt: Date.now()
      });

      setThreadDetails((current) => {
        const currentEntry = current[threadId];

        if (!force && currentEntry?.loading) {
          return current;
        }

        const shouldSuppressLoading = suppressLoadingIndicator && Boolean(currentEntry);

        return {
          ...current,
          [threadId]: {
            ...currentEntry,
            loading: shouldSuppressLoading ? currentEntry?.loading ?? false : true,
            error: "",
            messages: currentEntry?.messages ?? [],
            version: currentEntry?.version ?? null
          }
        };
      });

      try {
        const cachedEntry = threadDetailsRef.current?.[threadId] ?? null;
        const cachedThread = cachedEntry?.thread ?? threads.find((thread) => thread.id === threadId) ?? null;
        const cachedIssues = (cachedEntry?.issues ?? [])
          .map((issue) => normalizeIssue(issue, threadId))
          .filter(Boolean)
          .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));
        const activeIssue = findActiveIssueForThread(cachedIssues, cachedThread?.active_physical_thread_id ?? null);
        const shouldLoadActiveIssueOnly = mode === "active" && Boolean(activeIssue);
        let issues = cachedIssues;
        let messages = cachedEntry?.messages ?? [];
        let normalizedThread = normalizeThread(cachedThread);

        if (shouldLoadActiveIssueOnly) {
          const detail = await apiRequest(
            `/api/issues/${activeIssue.id}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`
          );
          const nextIssue = normalizeIssue(detail?.issue, threadId) ?? activeIssue;
          const nextIssueIndex = issues.findIndex((issue) => issue.id === nextIssue.id);

          if (nextIssueIndex >= 0) {
            issues = [...issues];
            issues[nextIssueIndex] = nextIssue;
          } else {
            issues = [...issues, nextIssue].sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));
          }

          messages = mergeIssueMessages(
            cachedEntry?.messages ?? [],
            detail?.messages ?? [],
            nextIssue,
            nextIssue.updated_at ?? nextIssue.created_at ?? new Date().toISOString()
          );
          normalizedThread = normalizeThread(detail?.thread) ?? normalizedThread;
        } else {
          const issueList = await apiRequest(
            `/api/threads/${threadId}/issues?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`
          );
          issues = [...(issueList?.issues ?? [])]
            .map((issue) => normalizeIssue(issue, threadId))
            .filter(Boolean)
            .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));
          const details = await Promise.all(
            issues.map((issue) =>
              apiRequest(
                `/api/issues/${issue.id}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`
              )
            )
          );
          messages = details.flatMap((detail, issueIndex) =>
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
          normalizedThread = normalizeThread(latestThread);
        }

        if (threadLoadRequestIdByIdRef.current.get(threadId) !== nextRequestId) {
          releaseThreadLoadingState();
          return;
        }

        setThreadDetails((current) => ({
          ...current,
          [threadId]: {
            loading: false,
            error: "",
            messages,
            issues,
            thread: normalizedThread ?? current[threadId]?.thread ?? null,
            fetchedAt: Date.now(),
            version:
              version ??
              normalizedThread?.updated_at ??
              normalizedThread?.created_at ??
              current[threadId]?.version ??
              null
          }
        }));

        const completedMeta = threadReloadMetaByIdRef.current.get(threadId) ?? {};
        threadReloadMetaByIdRef.current.set(threadId, {
          ...completedMeta,
          inFlight: false,
          lastCompletedAt: Date.now(),
          lastVersion:
            version ??
            normalizedThread?.updated_at ??
            normalizedThread?.created_at ??
            threadDetailsRef.current?.[threadId]?.version ??
            null
        });

        if (normalizedThread) {
          setThreads((current) => upsertThread(current, normalizedThread));

          if (normalizedThread.project_id) {
            setThreadListsByProjectId((current) => {
              const nextList = upsertThread(current[normalizedThread.project_id] ?? [], normalizedThread);

              return {
                ...current,
                [normalizedThread.project_id]: nextList
              };
            });
          }
        }
      } catch (error) {
        if (threadLoadRequestIdByIdRef.current.get(threadId) !== nextRequestId) {
          releaseThreadLoadingState();
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

        const completedMeta = threadReloadMetaByIdRef.current.get(threadId) ?? {};
        threadReloadMetaByIdRef.current.set(threadId, {
          ...completedMeta,
          inFlight: false,
          lastCompletedAt: Date.now()
        });
      }
    },
    [selectedBridgeId, session?.loginId, threads]
  );

  const loadTodoChatMessages = useCallback(
    async (chatId, { force = false } = {}) => {
      if (!session?.loginId || !selectedBridgeId || !chatId) {
        return;
      }

      const requestId = todoChatLoadRequestIdRef.current + 1;
      todoChatLoadRequestIdRef.current = requestId;

      setTodoChatDetails((current) => {
        const currentEntry = current[chatId];

        if (!force && currentEntry?.loading) {
          return current;
        }

        return {
          ...current,
          [chatId]: {
            ...currentEntry,
            loading: true,
            error: "",
            messages: currentEntry?.messages ?? []
          }
        };
      });

      try {
        const payload = await apiRequest(
          `/api/todo/chats/${chatId}/messages?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`
        );

        if (todoChatLoadRequestIdRef.current !== requestId) {
          return;
        }

        setTodoChatDetails((current) => ({
          ...current,
          [chatId]: {
            loading: false,
            error: "",
            chat: normalizeTodoChat(payload?.chat),
            messages: (payload?.messages ?? []).map(normalizeTodoMessage).filter(Boolean),
            fetchedAt: Date.now()
          }
        }));
      } catch (error) {
        if (todoChatLoadRequestIdRef.current !== requestId) {
          return;
        }

        setTodoChatDetails((current) => ({
          ...current,
          [chatId]: {
            ...current[chatId],
            loading: false,
            error: error.message ?? "메모를 불러오지 못했습니다."
          }
        }));
      }
    },
    [selectedBridgeId, session?.loginId]
  );

  async function loadTodoChats(sessionArg, bridgeId) {
    if (!sessionArg?.loginId || !bridgeId) {
      setTodoChats([]);
      return [];
    }

    const payload = await apiRequest(
      `/api/todo/chats?login_id=${encodeURIComponent(sessionArg.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`
    );
    const nextChats = mergeTodoChats([], payload?.chats ?? []);
    setTodoChats(nextChats);
    return nextChats;
  }

  const scheduleThreadMessagesReload = useCallback((threadId, options = {}) => {
    if (!threadId) {
      return;
    }

    const {
      delay = 180,
      suppressLoadingIndicator = false,
      bypassThrottle = false,
      reason = "unspecified",
      ...loadOptions
    } = options;
    const currentTimer = threadReloadTimersByIdRef.current.get(threadId);
    const reloadMeta = threadReloadMetaByIdRef.current.get(threadId) ?? {};
    const now = Date.now();
    const lastActivityAt = Math.max(
      reloadMeta.lastScheduledAt ?? 0,
      reloadMeta.lastStartedAt ?? 0,
      reloadMeta.lastCompletedAt ?? 0
    );
    const throttleDelay =
      bypassThrottle || lastActivityAt <= 0
        ? 0
        : Math.max(0, THREAD_RELOAD_MIN_INTERVAL_MS - (now - lastActivityAt));
    const effectiveDelay = Math.max(delay, throttleDelay, reloadMeta.inFlight ? 400 : 0);

    if (currentTimer) {
      window.clearTimeout(currentTimer);
      threadReloadTimersByIdRef.current.delete(threadId);
    }

    const timerId = window.setTimeout(() => {
      threadReloadTimersByIdRef.current.delete(threadId);
      void loadThreadMessages(threadId, { ...loadOptions, suppressLoadingIndicator });
    }, effectiveDelay);

    threadReloadTimersByIdRef.current.set(threadId, timerId);
    threadReloadMetaByIdRef.current.set(threadId, {
      ...reloadMeta,
      lastScheduledAt: now,
      lastReason: reason
    });
  }, [loadThreadMessages]);
  const scheduleThreadMessagesReloadRef = useRef(scheduleThreadMessagesReload);
  useEffect(() => {
    scheduleThreadMessagesReloadRef.current = scheduleThreadMessagesReload;
  }, [scheduleThreadMessagesReload]);

  async function loadBridges(sessionArg) {
    if (!sessionArg?.loginId) {
      return [];
    }

    const rawBridges = (await apiRequest(
      `/api/bridges?login_id=${encodeURIComponent(sessionArg.loginId)}`
    )).bridges ?? [];
    const normalizedBridges = rawBridges
      .map((bridge) => {
        if (!bridge) {
          return null;
        }

        const normalizedId = String(bridge.bridge_id ?? bridge.id ?? "").trim();

        if (!normalizedId) {
          return null;
        }

        if (bridge.bridge_id === normalizedId) {
          return bridge;
        }

        return {
          ...bridge,
          bridge_id: normalizedId
        };
      })
      .filter(Boolean);

    setBridges(normalizedBridges);
    const storedBridgeId = readStoredBridgeId();
    setSelectedBridgeId((current) => {
      if (current && normalizedBridges.some((bridge) => bridge.bridge_id === current)) {
        return current;
      }

      if (storedBridgeId && normalizedBridges.some((bridge) => bridge.bridge_id === storedBridgeId)) {
        return storedBridgeId;
      }

      return normalizedBridges[0]?.bridge_id ?? "";
    });

    return normalizedBridges;
  }

  async function loadBridgeWorkspace(sessionArg, bridgeId) {
    if (!sessionArg?.loginId || !bridgeId) {
      setProjects([]);
      setThreads([]);
      setThreadListsByProjectId({});
      setTodoChats([]);
      setTodoChatDetails({});
      setStatus(createDefaultStatus());
      return;
    }

    const requestId = bridgeWorkspaceRequestIdRef.current + 1;
    bridgeWorkspaceRequestIdRef.current = requestId;
    setLoadingState("loading");

    try {
      const [nextStatus, nextProjects, nextTodoChats] = await Promise.all([
        apiRequest(
          `/api/bridge/status?login_id=${encodeURIComponent(sessionArg.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`
        ),
        apiRequest(
          `/api/projects?login_id=${encodeURIComponent(sessionArg.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`
        ),
        apiRequest(
          `/api/todo/chats?login_id=${encodeURIComponent(sessionArg.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`
        )
      ]);

      if (bridgeWorkspaceRequestIdRef.current !== requestId || selectedBridgeIdRef.current !== bridgeId) {
        return;
      }

      setStatus(nextStatus);
      markStreamActivity();
      setProjects(nextProjects.projects ?? []);
      setTodoChats(mergeTodoChats([], nextTodoChats.chats ?? []));
      setTodoChatDetails({});
      const nextProjectId =
        selectedProjectId && nextProjects.projects?.some((project) => project.id === selectedProjectId)
          ? selectedProjectId
          : nextProjects.projects?.[0]?.id || "";

      setSelectedScope((current) => {
        if (current.kind === "todo") {
          return current;
        }

        return {
          kind: "project",
          id: nextProjectId
        };
      });

      setThreadListsByProjectId({});

      if (nextProjectId) {
        const nextThreads = await loadProjectThreads(sessionArg, bridgeId, nextProjectId, { applyToInbox: true });

        if (bridgeWorkspaceRequestIdRef.current !== requestId || selectedBridgeIdRef.current !== bridgeId) {
          return;
        }

        setSelectedThreadId((current) =>
          current && nextThreads.some((thread) => thread.id === current) ? current : nextThreads[0]?.id || ""
        );
      } else {
        setThreads([]);
        setSelectedThreadId("");
      }

      setLoadingState("ready");
    } catch (error) {
      if (bridgeWorkspaceRequestIdRef.current !== requestId || selectedBridgeIdRef.current !== bridgeId) {
        return;
      }

      setLoadingState("error");
    }
  }

  async function loadProjectThreads(sessionArg, bridgeId, projectId, options = {}) {
    if (!sessionArg?.loginId || !bridgeId || !projectId) {
      return [];
    }

    const payload = await apiRequest(
      `/api/projects/${projectId}/threads?login_id=${encodeURIComponent(sessionArg.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`
    );
    const nextThreads = mergeThreads([], payload?.threads ?? []);

    if (selectedBridgeIdRef.current !== bridgeId) {
      return [];
    }

    updateThreadCache(projectId, nextThreads);

    if (options.applyToInbox !== false) {
      setThreads(nextThreads);
    }

    return nextThreads;
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

  const handleBackToInbox = useCallback(() => {
    setDraftThreadProjectId("");
    setActiveView("inbox");
    activeViewRef.current = "inbox";
  }, [setDraftThreadProjectId, setActiveView]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.history?.pushState) {
      return undefined;
    }

    const handlePopState = (event) => {
      event?.preventDefault?.();

      if (activeViewRef.current === "thread") {
        handleBackToInbox();
      }

      window.history.pushState(null, "", window.location.href);
    };

    window.history.pushState(null, "", window.location.href);
    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [handleBackToInbox]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return undefined;
    }

    let touchStartY = 0;
    let scrollTarget = null;

    const resolveBoundaryLockTarget = (node) => {
      let current = node instanceof HTMLElement ? node : node?.parentElement ?? null;

      while (current) {
        if (current.classList?.contains("touch-scroll-boundary-lock")) {
          return current;
        }

        current = current.parentElement;
      }

      return null;
    };

    const resolveScrollTarget = (node) => {
      const boundaryTarget = resolveBoundaryLockTarget(node);

      if (boundaryTarget) {
        return boundaryTarget;
      }

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

      if (!scrollTarget || !(scrollTarget instanceof HTMLElement) || !scrollTarget.classList.contains("touch-scroll-boundary-lock")) {
        return;
      }

      const maxScrollTop = Math.max(0, scrollTarget.scrollHeight - scrollTarget.clientHeight);
      const boundaryEpsilon = 1;

      if (maxScrollTop <= 0) {
        return;
      }

      if (scrollTarget.scrollTop <= 0) {
        scrollTarget.scrollTop = boundaryEpsilon;
      } else if (scrollTarget.scrollTop >= maxScrollTop) {
        scrollTarget.scrollTop = Math.max(boundaryEpsilon, maxScrollTop - boundaryEpsilon);
      }
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

      if (scrollContainer instanceof HTMLElement && scrollContainer.classList.contains("touch-scroll-boundary-lock")) {
        const boundaryEpsilon = 1;
        const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);

        if (maxScrollTop <= 0) {
          event.preventDefault();
          return;
        }

        const isPullingPastTop = deltaY > 0 && scrollTop <= boundaryEpsilon;
        const isPushingPastBottom = deltaY < 0 && scrollTop >= maxScrollTop - boundaryEpsilon;

        if (isPullingPastTop || isPushingPastBottom) {
          event.preventDefault();
        }

        return;
      }

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
    if (!session?.loginId || !selectedBridgeId || !selectedBridgeKnown) {
      return undefined;
    }

    const eventSource = new EventSource(
      `${API_BASE_URL}/api/events?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`
    );

    eventSource.addEventListener("ready", () => {
      markStreamActivity();
    });

    eventSource.addEventListener("snapshot", (event) => {
      try {
        markStreamActivity();
        const payload = JSON.parse(event.data);
        setStatus(payload);
      } catch {
        // ignore malformed snapshot
      }
    });

    eventSource.addEventListener("message", (event) => {
      try {
        markStreamActivity();
        const payload = JSON.parse(event.data);
        const { threadId: eventThreadId, issueId: eventIssueId, projectId: eventProjectId } = getLiveEventContext(payload);
        const activeThreadId = selectedThreadIdRef.current;
        const activeProjectId = selectedProjectIdRef.current;
        const activeTodoChatId = selectedTodoChatIdRef.current;
        const scheduleReload = scheduleThreadMessagesReloadRef.current;
        const applyThreadCacheUpdate = updateThreadCacheRef.current;
        const clearPendingStartConfirmReload = (threadId) => {
          if (!threadId) {
            return;
          }

          const reloadMeta = threadReloadMetaByIdRef.current.get(threadId) ?? null;
          const lastReason = String(reloadMeta?.lastReason ?? "");

          if (!["thread_create_start_confirm", "thread_append_start_confirm"].includes(lastReason)) {
            return;
          }

          const currentTimer = threadReloadTimersByIdRef.current.get(threadId);

          if (currentTimer) {
            window.clearTimeout(currentTimer);
            threadReloadTimersByIdRef.current.delete(threadId);
          }

          threadReloadMetaByIdRef.current.set(threadId, {
            ...reloadMeta,
            lastReason: `${lastReason}:cancelled_by_live_progress`
          });
        };

        if (eventThreadId) {
          if (eventThreadId === activeThreadId && isLiveThreadProgressEvent(payload.type)) {
            threadLiveProgressAtByIdRef.current.set(eventThreadId, Date.now());
            clearPendingStartConfirmReload(eventThreadId);
          }

          if (
            payload.type === "turn.completed" ||
            (
              payload.type === "thread.status.changed" &&
              ["waitingForInput", "idle", "error"].includes(
                String(payload.payload?.status?.type ?? "").trim()
              )
            )
          ) {
            threadLiveProgressAtByIdRef.current.delete(eventThreadId);
          }

          setThreads((current) => upsertLiveThread(current, payload));
          setThreadDetails((current) => {
            const currentEntry = current[eventThreadId] ?? null;
            const currentIssues = currentEntry?.issues ?? [];
            const livePatch = buildLiveThreadPatch(payload, currentEntry?.thread ?? null);
            const baseThread =
              currentEntry?.thread ??
              normalizeThread(payload.payload?.thread, eventProjectId || null) ??
              (livePatch || payload.type === "item.agentMessage.delta"
                ? normalizeThread({
                    id: eventThreadId,
                    title: "새 채팅창",
                    project_id: eventProjectId || null,
                    status: livePatch?.status ?? "running",
                    progress: livePatch?.progress ?? 0,
                    last_event: livePatch?.last_event ?? payload.type ?? "thread.started",
                    last_message: livePatch?.last_message ?? "",
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                  }, eventProjectId || null)
                : null);

            if (!currentEntry && !baseThread) {
              return current;
            }

            const nextThread = baseThread
              ? {
                  ...baseThread,
                  ...(livePatch ?? {})
                }
              : currentEntry?.thread ?? null;

            return {
              ...current,
              [eventThreadId]: {
                ...(currentEntry ?? {}),
                thread: nextThread,
                messages: appendLiveAssistantMessage(currentEntry?.messages ?? [], payload, {
                  issue_id: eventIssueId,
                  issue_title: currentIssues.find((issue) => issue.id === eventIssueId)?.title ?? "",
                  issue_status: currentIssues.find((issue) => issue.id === eventIssueId)?.status ?? "running"
                }),
                issues: currentIssues,
                loading: currentEntry?.loading ?? false,
                error: currentEntry?.error ?? ""
              }
            };
          });

          if (eventProjectId) {
            setThreadListsByProjectId((current) => ({
              ...current,
              [eventProjectId]: upsertLiveThread(current[eventProjectId] ?? [], payload)
            }));
          }
        }

        if (payload.type === "bridge.status.updated") {
          setStatus(payload.payload);
          return;
        }

        if (payload.type === "bridge.projects.updated") {
          const nextProjects = payload.payload?.projects ?? [];
          setProjects(nextProjects);
          setSelectedScope((current) => {
            if (current.kind === "todo") {
              return current;
            }

            if (current.id && nextProjects.some((project) => project.id === current.id)) {
              return current;
            }

            return {
              kind: "project",
              id: nextProjects[0]?.id || ""
            };
          });
          return;
        }

        if (payload.type === "bridge.todoChats.updated") {
          const nextChats = mergeTodoChats([], payload.payload?.chats ?? []);
          setTodoChats(nextChats);
          setSelectedTodoChatId((current) => (current && nextChats.some((chat) => chat.id === current) ? current : ""));
          return;
        }

        if (payload.type === "bridge.todoMessages.updated") {
          const incomingChat = normalizeTodoChat(payload.payload?.chat);

          if (incomingChat) {
            setTodoChats((current) => upsertTodoChat(current, incomingChat));
          }

          if (incomingChat?.id && incomingChat.id === activeTodoChatId) {
            setTodoChatDetails((current) => ({
              ...current,
              [incomingChat.id]: {
                ...(current[incomingChat.id] ?? {}),
                loading: false,
                error: "",
                chat: incomingChat,
                messages: (payload.payload?.messages ?? []).map(normalizeTodoMessage).filter(Boolean)
              }
            }));
          }
          return;
        }

        if (payload.type === "bridge.projectThreads.updated") {
          const projectId = payload.payload?.project_id ?? "";
          const nextThreads = mergeThreads([], payload.payload?.threads ?? []);

          if (projectId) {
            applyThreadCacheUpdate?.(projectId, nextThreads);
          } else {
            const groupedThreads = groupThreadsByProjectId(nextThreads);

            if (groupedThreads.size > 0) {
              setThreadListsByProjectId((current) => {
                const nextCache = { ...current };

                for (const [groupedProjectId, groupedProjectThreads] of groupedThreads.entries()) {
                  nextCache[groupedProjectId] = mergeThreads([], groupedProjectThreads);
                }

                return nextCache;
              });
            }
          }

          if (!projectId || projectId === activeProjectId) {
            setThreads(nextThreads);
          }

          if (activeThreadId && payload.payload?.threads?.some((thread) => thread.id === activeThreadId)) {
            const matched = payload.payload.threads.find((thread) => thread.id === activeThreadId);
            if (matched) {
              setThreadDetails((current) => ({
                ...current,
                [activeThreadId]: {
                  ...(current[activeThreadId] ?? {}),
                  thread: normalizeThread(matched)
                }
              }));
            }
          }
          return;
        }

        if (payload.type === "bridge.threadIssues.updated") {
          const threadId = payload.payload?.thread_id ?? "";
          const nextIssues = payload.payload?.issues ?? [];

          if (threadId) {
            const currentIssues = threadDetailsRef.current?.[threadId]?.issues ?? [];
            const shouldReload =
              threadId === activeThreadId &&
              shouldReloadThreadFromIssueSnapshot(currentIssues, nextIssues, threadId);

            setThreadDetails((current) => ({
              ...current,
              [threadId]: {
                ...(current[threadId] ?? {}),
                issues: nextIssues
              }
            }));
            if (scheduleReload && shouldReload) {
              scheduleReload(threadId, {
                force: true,
                mode: "active",
                suppressLoadingIndicator: true,
                reason: "thread_issues_updated"
              });
            }
          }
          return;
        }

        if (
          eventThreadId &&
          eventThreadId === activeThreadId &&
          (
            payload.type === "turn.completed" ||
            (
              payload.type === "thread.status.changed" &&
              ["waitingForInput", "idle", "error"].includes(
                String(payload.payload?.status?.type ?? "").trim()
              )
            )
          )
        ) {
          if (scheduleReload) {
            scheduleReload(eventThreadId, {
              force: true,
              mode: "active",
              delay: 0,
              suppressLoadingIndicator: true,
              bypassThrottle: true,
              reason: payload.type
            });
          }
          return;
        }

        if (payload.payload?.thread) {
          const incomingThread = normalizeThread(payload.payload.thread);

          if (!incomingThread) {
            return;
          }

          if (activeThreadId === incomingThread.id) {
            setThreadDetails((current) => ({
              ...current,
              [incomingThread.id]: {
                ...(current[incomingThread.id] ?? {}),
                thread: incomingThread
              }
            }));
          }

          if (!activeProjectId || incomingThread.project_id === activeProjectId) {
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
  }, [eventStreamReconnectToken, markStreamActivity, selectedBridgeId, selectedBridgeKnown, session?.loginId]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return undefined;
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        scheduleAppForegroundResume("app_resume:visibility");
      }
    };

    const handleWindowFocus = () => {
      scheduleAppForegroundResume("app_resume:focus");
    };

    const handlePageShow = () => {
      scheduleAppForegroundResume("app_resume:pageshow");
    };

    const handleOnline = () => {
      scheduleAppForegroundResume("app_resume:online");
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleWindowFocus);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("online", handleOnline);

    return () => {
      if (scheduledResumeTimerRef.current) {
        window.clearTimeout(scheduledResumeTimerRef.current);
        scheduledResumeTimerRef.current = null;
      }
      scheduledResumeReasonsRef.current.clear();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleWindowFocus);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("online", handleOnline);
    };
  }, [scheduleAppForegroundResume]);

  useLayoutEffect(() => {
    threadLoadRequestIdByIdRef.current = new Map();
    todoChatLoadRequestIdRef.current += 1;
    for (const timerId of threadReloadTimersByIdRef.current.values()) {
      window.clearTimeout(timerId);
    }
    threadReloadTimersByIdRef.current.clear();
    threadReloadMetaByIdRef.current = new Map();

    setProjects([]);
    setThreads([]);
    setStatus(createDefaultStatus());
    setStreamActivityAt(null);
    setSelectedScope({ kind: "project", id: "" });
    setSelectedThreadId("");
    setSelectedTodoChatId("");
    setDraftThreadProjectId("");
    setThreadListsByProjectId({});
    setTodoChats([]);
    setTodoChatDetails({});
    setThreadDetails({});
    setWorkspaceRoots([]);
    setFolderState({ path: "", parent_path: null, entries: [] });
    setSelectedWorkspacePath("");
    setActiveView("inbox");
    setLoadingState(selectedBridgeId && selectedBridgeKnown ? "loading" : "idle");
  }, [selectedBridgeId, selectedBridgeKnown]);

  useEffect(() => {
    if (!session?.loginId || !selectedBridgeKnown) {
      return;
    }

    void loadBridgeWorkspace(session, selectedBridgeId);
  }, [selectedBridgeId, selectedBridgeKnown, session]);

  useEffect(() => {
    if (!session?.loginId || !selectedBridgeId || !selectedBridgeKnown) {
      return undefined;
    }

    let cancelled = false;

    const pollBridgeStatus = async () => {
      try {
        const nextStatus = await apiRequest(
          `/api/bridge/status?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`
        );

        if (cancelled || selectedBridgeIdRef.current !== selectedBridgeId) {
          return;
        }

        setStatus(nextStatus);
      } catch (error) {
        if (cancelled || selectedBridgeIdRef.current !== selectedBridgeId) {
          return;
        }

        setStatus((current) => ({
          ...current,
          app_server: {
            ...(current?.app_server ?? {}),
            connected: false,
            initialized: false,
            last_error: error.message
          },
          updated_at: new Date().toISOString()
        }));
      }
    };

    const timer = window.setInterval(() => {
      void pollBridgeStatus();
    }, BRIDGE_STATUS_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedBridgeId, selectedBridgeKnown, session]);

  useEffect(() => {
    if (!session?.loginId || !selectedBridgeId || !selectedProjectId) {
      return;
    }

    void loadProjectThreads(session, selectedBridgeId, selectedProjectId, { applyToInbox: true });
  }, [selectedBridgeId, selectedProjectId, session]);

  useEffect(() => {
    if (!session?.loginId || !selectedBridgeId || !projectComposerOpen) {
      return;
    }

    void (async () => {
      const roots = await loadWorkspaceRoots(session, selectedBridgeId);
      const preferredPath = roots[0]?.path || "";

      setSelectedWorkspacePath((current) => current || preferredPath);
      await browseWorkspacePath(preferredPath, selectedBridgeId);
    })();
  }, [projectComposerOpen, selectedBridgeId, session]);

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

    if (hasCurrentThreadDetail && ["running", "awaiting_input"].includes(selectedThreadStatus)) {
      return;
    }

    if (!hasCurrentThreadDetail || currentThreadDetailVersion !== selectedThreadUpdatedAt) {
      scheduleThreadMessagesReload(selectedThreadId, {
        version: selectedThreadUpdatedAt,
        delay: 0,
        suppressLoadingIndicator: hasCurrentThreadDetail,
        reason: "thread_version_mismatch"
      });
    }
  }, [
    activeView,
    currentThreadDetailLoading,
    currentThreadDetailVersion,
    hasCurrentThreadDetail,
    scheduleThreadMessagesReload,
    selectedBridgeId,
    selectedThreadId,
    selectedThreadStatus,
    selectedThreadUpdatedAt,
    session?.loginId
  ]);

  useEffect(() => {
    if (
      !session?.loginId ||
      !selectedBridgeId ||
      activeView !== "thread" ||
      !selectedThreadId ||
      !selectedActiveIssue ||
      !["running", "awaiting_input"].includes(selectedActiveIssue.status ?? "")
    ) {
      return undefined;
    }

    const pollActiveIssue = () => {
      const lastLiveProgressAt = Number(threadLiveProgressAtByIdRef.current.get(selectedThreadId) ?? 0);

      if (lastLiveProgressAt > 0 && Date.now() - lastLiveProgressAt < ACTIVE_ISSUE_POLL_SUPPRESS_AFTER_LIVE_MS) {
        return;
      }

      scheduleThreadMessagesReload(selectedThreadId, {
        force: true,
        mode: "active",
        suppressLoadingIndicator: true,
        reason: "active_issue_poll"
      });
    };

    const intervalId = window.setInterval(pollActiveIssue, ACTIVE_ISSUE_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [
    activeView,
    scheduleThreadMessagesReload,
    selectedActiveIssue,
    selectedBridgeId,
    selectedThreadId,
    session?.loginId
  ]);

  useEffect(() => {
    if (selectedScope.kind === "todo") {
      return;
    }

    if (!selectedProjectId && projects.length > 0) {
      selectProjectScope(projects[0].id);
    }
  }, [projects, selectProjectScope, selectedProjectId, selectedScope.kind]);

  useEffect(() => {
    if (!selectedThreadId && threads.length > 0) {
      return;
    }

    if (selectedThreadId && !threads.some((thread) => thread.id === selectedThreadId)) {
      setSelectedThreadId(threads[0]?.id ?? "");
    }
  }, [selectedThreadId, threads]);

  useEffect(() => {
    if (selectedScope.kind !== "project") {
      return;
    }

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
  }, [draftThreadProjectId, selectedProjectId, selectedScope.kind, selectedThreadId, threads]);

  useEffect(() => {
    if (!session?.loginId || !selectedBridgeId || activeView !== "todo" || !selectedTodoChatId) {
      return;
    }

    void loadTodoChatMessages(selectedTodoChatId);
  }, [activeView, loadTodoChatMessages, selectedBridgeId, selectedTodoChatId, session?.loginId]);

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
    setSelectedBridgeId("");
    setBridges([]);
    setProjects([]);
    setThreads([]);
    setThreadListsByProjectId({});
    setTodoChats([]);
    setThreadDetails({});
    setTodoChatDetails({});
    setWorkspaceRoots([]);
    setFolderState({ path: "", parent_path: null, entries: [] });
    setSelectedWorkspacePath("");
    setSelectedScope({ kind: "project", id: "" });
    setSelectedThreadId("");
    setSelectedTodoChatId("");
    setDraftThreadProjectId("");
    setSearch("");
    setUtilityOpen(false);
    setProjectComposerOpen(false);
    setActiveView("inbox");
  };

  const handleSelectTodoScope = useCallback(() => {
    selectTodoScope();
    setSelectedThreadId("");
    setDraftThreadProjectId("");
    setActiveView("inbox");
  }, [selectTodoScope]);

  const handleSelectTodoChat = useCallback((chatId) => {
    if (!chatId) {
      return;
    }

    selectTodoScope();
    setSelectedThreadId("");
    setDraftThreadProjectId("");
    setSelectedTodoChatId(chatId);
    setActiveView("todo");
  }, [selectTodoScope]);

  const ensureProjectThreadsLoaded = useCallback(
    async (projectId, options = {}) => {
      const normalizedProjectId = String(projectId ?? "").trim();

      if (!session?.loginId || !selectedBridgeId || !normalizedProjectId) {
        return [];
      }

      if (!options.force && Array.isArray(threadListsByProjectId[normalizedProjectId])) {
        return threadListsByProjectId[normalizedProjectId];
      }

      return loadProjectThreads(session, selectedBridgeId, normalizedProjectId, {
        applyToInbox: options.applyToInbox ?? (selectedScope.kind === "project" && selectedProjectId === normalizedProjectId)
      });
    },
    [selectedBridgeId, selectedProjectId, selectedScope.kind, session, threadListsByProjectId]
  );

  const syncTodoChatPayload = useCallback((payload, fallbackChatId = "") => {
    const nextChat = normalizeTodoChat(payload?.chat);
    const targetChatId = nextChat?.id ?? fallbackChatId;

    if (nextChat) {
      setTodoChats((current) => upsertTodoChat(current, nextChat));
    }

    if (targetChatId) {
      setTodoChatDetails((current) => ({
        ...current,
        [targetChatId]: {
          ...(current[targetChatId] ?? {}),
          loading: false,
          error: "",
          chat: nextChat ?? current[targetChatId]?.chat ?? null,
          messages: Array.isArray(payload?.messages)
            ? payload.messages.map(normalizeTodoMessage).filter(Boolean)
            : current[targetChatId]?.messages ?? []
        }
      }));
    }
  }, []);

  const handleOpenNewTodoChat = useCallback(async () => {
    if (!session?.loginId || !selectedBridgeId) {
      return false;
    }

    setTodoBusy(true);

    try {
      const response = await apiRequest(
        `/api/todo/chats?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "POST",
          body: JSON.stringify({ title: "새 ToDo 채팅" })
        }
      );
      const nextChats = mergeTodoChats(todoChats, response?.chats ?? []);
      const createdChat = normalizeTodoChat(response?.chat);

      setTodoChats(nextChats);

      if (createdChat?.id) {
        setTodoChatDetails((current) => ({
          ...current,
          [createdChat.id]: {
            ...(current[createdChat.id] ?? {}),
            loading: false,
            error: "",
            chat: createdChat,
            messages: current[createdChat.id]?.messages ?? []
          }
        }));
        selectTodoScope();
        setSelectedTodoChatId(createdChat.id);
        setSelectedThreadId("");
        setDraftThreadProjectId("");
        setActiveView("todo");
      }

      return true;
    } catch (error) {
      if (typeof window !== "undefined") {
        window.alert(error.message);
      }
      return false;
    } finally {
      setTodoBusy(false);
    }
  }, [selectedBridgeId, selectTodoScope, session, todoChats]);

  const handleSubmitTodoMessage = useCallback(async (content) => {
    if (!session?.loginId || !selectedBridgeId || !selectedTodoChatId) {
      return false;
    }

    setTodoBusy(true);

    try {
      const response = await apiRequest(
        `/api/todo/chats/${encodeURIComponent(selectedTodoChatId)}/messages?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "POST",
          body: JSON.stringify({ content })
        }
      );

      syncTodoChatPayload(response, selectedTodoChatId);

      if (Array.isArray(response?.chats)) {
        setTodoChats(mergeTodoChats([], response.chats));
      }

      return true;
    } catch (error) {
      if (typeof window !== "undefined") {
        window.alert(error.message);
      }
      return false;
    } finally {
      setTodoBusy(false);
    }
  }, [selectedBridgeId, selectedTodoChatId, session, syncTodoChatPayload]);

  const handleRenameTodoChat = useCallback(async (chatId, title) => {
    if (!session?.loginId || !selectedBridgeId || !chatId) {
      return false;
    }

    setTodoRenameBusy(true);

    try {
      const response = await apiRequest(
        `/api/todo/chats/${encodeURIComponent(chatId)}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ title })
        }
      );

      if (Array.isArray(response?.chats)) {
        setTodoChats(mergeTodoChats([], response.chats));
      } else if (response?.chat) {
        setTodoChats((current) => upsertTodoChat(current, response.chat));
      }

      if (response?.chat) {
        setTodoChatDetails((current) => ({
          ...current,
          [chatId]: {
            ...(current[chatId] ?? {}),
            chat: normalizeTodoChat(response.chat)
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
      setTodoRenameBusy(false);
    }
  }, [selectedBridgeId, session]);

  const handleDeleteTodoChat = useCallback(async (chatId) => {
    if (!session?.loginId || !selectedBridgeId || !chatId) {
      return false;
    }

    if (typeof window !== "undefined" && !window.confirm("이 ToDo 채팅을 삭제하시겠습니까?")) {
      return false;
    }

    try {
      const response = await apiRequest(
        `/api/todo/chats/${encodeURIComponent(chatId)}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "DELETE"
        }
      );

      if (Array.isArray(response?.chats)) {
        setTodoChats(mergeTodoChats([], response.chats));
      } else {
        setTodoChats((current) => current.filter((chat) => chat.id !== chatId));
      }

      setTodoChatDetails((current) => {
        const next = { ...current };
        delete next[chatId];
        return next;
      });

      if (selectedTodoChatId === chatId) {
        setSelectedTodoChatId("");
        setActiveView("inbox");
        selectTodoScope();
      }

      return true;
    } catch (error) {
      if (typeof window !== "undefined") {
        window.alert(error.message);
      }
      return false;
    }
  }, [selectedBridgeId, selectedTodoChatId, selectTodoScope, session]);

  const handleEditTodoMessage = useCallback(async (messageId, content) => {
    if (!session?.loginId || !selectedBridgeId || !messageId || !selectedTodoChatId) {
      return false;
    }

    setTodoBusy(true);

    try {
      const response = await apiRequest(
        `/api/todo/messages/${encodeURIComponent(messageId)}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ content })
        }
      );

      syncTodoChatPayload(response, selectedTodoChatId);
      return true;
    } catch (error) {
      if (typeof window !== "undefined") {
        window.alert(error.message);
      }
      return false;
    } finally {
      setTodoBusy(false);
    }
  }, [selectedBridgeId, selectedTodoChatId, session, syncTodoChatPayload]);

  const handleDeleteTodoMessage = useCallback(async (messageId) => {
    if (!session?.loginId || !selectedBridgeId || !messageId || !selectedTodoChatId) {
      return false;
    }

    if (typeof window !== "undefined" && !window.confirm("이 메모를 삭제하시겠습니까?")) {
      return false;
    }

    try {
      const response = await apiRequest(
        `/api/todo/messages/${encodeURIComponent(messageId)}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "DELETE"
        }
      );

      syncTodoChatPayload(response, selectedTodoChatId);
      return true;
    } catch (error) {
      if (typeof window !== "undefined") {
        window.alert(error.message);
      }
      return false;
    }
  }, [selectedBridgeId, selectedTodoChatId, session, syncTodoChatPayload]);

  const handleTransferTodoMessage = useCallback(async (messageId, payload) => {
    if (!session?.loginId || !selectedBridgeId || !messageId) {
      return false;
    }

    setTodoTransferBusy(true);

    try {
      const response = await apiRequest(
        `/api/todo/messages/${encodeURIComponent(messageId)}/transfer?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "POST",
          body: JSON.stringify(payload)
        }
      );

      if (selectedTodoChatId) {
        void loadTodoChatMessages(selectedTodoChatId, { force: true });
      }

      if (response?.thread) {
        const normalizedThread = normalizeThread(response.thread);

        if (normalizedThread) {
          setThreadListsByProjectId((current) => ({
            ...current,
            [normalizedThread.project_id]: mergeThreads(current[normalizedThread.project_id] ?? [], [normalizedThread])
          }));

          if (selectedScope.kind === "project" && selectedProjectId === normalizedThread.project_id) {
            setThreads((current) => upsertThread(current, normalizedThread));
          }
        }
      } else if (payload?.project_id) {
        void ensureProjectThreadsLoaded(payload.project_id, { force: true, applyToInbox: false });
      }

      return true;
    } catch (error) {
      if (typeof window !== "undefined") {
        window.alert(error.message);
      }
      return false;
    } finally {
      setTodoTransferBusy(false);
    }
  }, [ensureProjectThreadsLoaded, loadTodoChatMessages, selectedBridgeId, selectedProjectId, selectedScope.kind, selectedTodoChatId, session]);

  const handleRefreshTodoChat = useCallback(() => {
    if (!selectedTodoChatId) {
      return;
    }

    void loadTodoChatMessages(selectedTodoChatId, { force: true });
  }, [loadTodoChatMessages, selectedTodoChatId]);

  const handleRefreshThreadDetail = useCallback(async () => {
    if (!session?.loginId || !selectedBridgeId || !selectedThreadId) {
      return;
    }

    try {
      const refreshPath =
        `/api/threads/${encodeURIComponent(selectedThreadId)}/unlock?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`;
      const refreshOptions = {
        method: "POST",
        body: JSON.stringify({ reason: "manual_refresh" })
      };
      let response;

      try {
        response = await apiRequest(refreshPath, refreshOptions);
      } catch (error) {
        throw new Error(
          formatApiRequestError(
            refreshPath,
            refreshOptions,
            error,
            `마지막 이슈 락 해제 요청 실패\n- thread_id: ${selectedThreadId}\n- bridge_id: ${selectedBridgeId}`
          )
        );
      }

      const normalizedThread = normalizeThread(response?.thread);

      if (normalizedThread) {
        setThreads((current) => upsertThread(current, normalizedThread));
        setThreadDetails((current) => ({
          ...current,
          [selectedThreadId]: {
            ...(current[selectedThreadId] ?? {}),
            thread: normalizedThread
          }
        }));

        if (normalizedThread.project_id) {
          setThreadListsByProjectId((current) => ({
            ...current,
            [normalizedThread.project_id]: upsertThread(current[normalizedThread.project_id] ?? [], normalizedThread)
          }));
        }
      }

      await loadThreadMessages(selectedThreadId, { force: true });
    } catch (error) {
      if (typeof window !== "undefined") {
        window.alert(error.message);
      }
    }
  }, [loadThreadMessages, selectedBridgeId, selectedThreadId, session?.loginId]);

  const handleDeleteThreadIssue = useCallback(async (issueId) => {
    if (!session?.loginId || !selectedBridgeId || !selectedThreadId || !issueId) {
      return false;
    }

    const activePhysicalThreadId = selectedThread?.active_physical_thread_id ?? null;
    const targetIssue = (currentThreadDetail?.issues ?? [])
      .map((issue) => normalizeIssue(issue, selectedThreadId))
      .find((issue) => issue?.id === issueId);

    if (!activePhysicalThreadId || !targetIssue) {
      return false;
    }

    const targetPhysicalThreadId = targetIssue.executed_physical_thread_id ?? targetIssue.created_physical_thread_id ?? null;

    if (targetPhysicalThreadId !== activePhysicalThreadId) {
      if (typeof window !== "undefined") {
        window.alert("현재 active thread에 속한 이슈만 삭제할 수 있습니다.");
      }
      return false;
    }

    if (typeof window !== "undefined" && !window.confirm("이 이슈를 삭제하시겠습니까? 관련 메시지도 함께 목록에서 사라집니다.")) {
      return false;
    }

    try {
      const response = await apiRequest(
        `/api/issues/${encodeURIComponent(issueId)}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "DELETE"
        }
      );

      if (Array.isArray(response?.issues)) {
        setThreadDetails((current) => ({
          ...current,
          [selectedThreadId]: {
            ...(current[selectedThreadId] ?? {}),
            issues: response.issues.map((issue) => normalizeIssue(issue, selectedThreadId)).filter(Boolean)
          }
        }));
      }

      await loadThreadMessages(selectedThreadId, { force: true });
      return true;
    } catch (error) {
      if (typeof window !== "undefined") {
        window.alert(error.message);
      }
      return false;
    }
  }, [currentThreadDetail?.issues, loadThreadMessages, selectedBridgeId, selectedThreadId, selectedThread?.active_physical_thread_id, session]);

  const handleInterruptThreadIssue = useCallback(async (issueId, options = {}) => {
    if (!session?.loginId || !selectedBridgeId || !selectedThreadId || !issueId) {
      return false;
    }

    const activePhysicalThreadId = selectedThread?.active_physical_thread_id ?? null;
    const targetIssue = (currentThreadDetail?.issues ?? [])
      .map((issue) => normalizeIssue(issue, selectedThreadId))
      .find((issue) => issue?.id === issueId);

    if (!activePhysicalThreadId || !targetIssue) {
      return false;
    }

    if (!["running", "awaiting_input"].includes(targetIssue.status)) {
      if (typeof window !== "undefined") {
        window.alert("실행 중이거나 입력 대기 상태인 이슈만 중단할 수 있습니다.");
      }
      return false;
    }

    const targetPhysicalThreadId = targetIssue.executed_physical_thread_id ?? targetIssue.created_physical_thread_id ?? null;

    if (targetPhysicalThreadId !== activePhysicalThreadId) {
      if (typeof window !== "undefined") {
        window.alert("현재 active thread에 속한 이슈만 중단할 수 있습니다.");
      }
      return false;
    }

    try {
      const response = await apiRequest(
        `/api/issues/${encodeURIComponent(issueId)}/interrupt?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "POST",
          body: JSON.stringify({
            reason: String(options.reason ?? "mobile_long_press").trim() || "mobile_long_press"
          })
        }
      );

      if (Array.isArray(response?.issues)) {
        setThreadDetails((current) => ({
          ...current,
          [selectedThreadId]: {
            ...(current[selectedThreadId] ?? {}),
            issues: response.issues.map((issue) => normalizeIssue(issue, selectedThreadId)).filter(Boolean)
          }
        }));
      }

      await loadThreadMessages(selectedThreadId, { force: true });
      return true;
    } catch (error) {
      if (typeof window !== "undefined") {
        window.alert(error.message);
      }
      return false;
    }
  }, [currentThreadDetail?.issues, loadThreadMessages, selectedBridgeId, selectedThreadId, selectedThread?.active_physical_thread_id, session]);

  const handleStopThreadExecution = useCallback(async (options = {}) => {
    if (!session?.loginId || !selectedBridgeId || !selectedThreadId) {
      return false;
    }

    try {
      const stopPath =
        `/api/threads/${encodeURIComponent(selectedThreadId)}/stop?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`;
      const stopOptions = {
        method: "POST",
        body: JSON.stringify({
          reason: String(options.reason ?? "mobile_stop_button").trim() || "mobile_stop_button"
        })
      };
      let response;

      try {
        response = await apiRequest(stopPath, stopOptions);
      } catch (error) {
        throw new Error(
          formatApiRequestError(
            stopPath,
            stopOptions,
            error,
            `thread 안전 정지 요청 실패\n- thread_id: ${selectedThreadId}\n- bridge_id: ${selectedBridgeId}`
          )
        );
      }

      const normalizedThread = normalizeThread(response?.thread);

      if (normalizedThread) {
        setThreads((current) => upsertThread(current, normalizedThread));
        setThreadDetails((current) => ({
          ...current,
          [selectedThreadId]: {
            ...(current[selectedThreadId] ?? {}),
            thread: normalizedThread
          }
        }));

        if (normalizedThread.project_id) {
          setThreadListsByProjectId((current) => ({
            ...current,
            [normalizedThread.project_id]: upsertThread(current[normalizedThread.project_id] ?? [], normalizedThread)
          }));
        }
      }

      if (Array.isArray(response?.issues)) {
        setThreadDetails((current) => ({
          ...current,
          [selectedThreadId]: {
            ...(current[selectedThreadId] ?? {}),
            issues: response.issues.map((issue) => normalizeIssue(issue, selectedThreadId)).filter(Boolean)
          }
        }));
      }

      await loadThreadMessages(selectedThreadId, { force: true });
      return true;
    } catch (error) {
      if (typeof window !== "undefined") {
        window.alert(error.message);
      }
      return false;
    }
  }, [loadThreadMessages, selectedBridgeId, selectedThreadId, session?.loginId]);

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

      const createThreadPath =
        `/api/projects/${projectId}/threads?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`;
      const createThreadOptions = {
        method: "POST",
        body: JSON.stringify({
          name: createThreadTitleFromPrompt(payload.prompt) || "새 채팅창"
        })
      };
      let createdThread;

      try {
        createdThread = await apiRequest(createThreadPath, createThreadOptions);
      } catch (error) {
        throw new Error(
          formatApiRequestError(
            createThreadPath,
            createThreadOptions,
            error,
            `새 채팅창 생성 실패\n- project_id: ${projectId}\n- bridge_id: ${selectedBridgeId}`
          )
        );
      }
      const threadId = createdThread?.thread?.id;

      if (!threadId) {
        throw new Error("새 채팅창을 생성하지 못했습니다.");
      }

      const createIssuePath =
        `/api/threads/${threadId}/issues?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`;
      const createIssueOptions = {
        method: "POST",
        body: JSON.stringify(payload)
      };
      let createdIssue;

      try {
        createdIssue = await apiRequest(createIssuePath, createIssueOptions);
      } catch (error) {
        throw new Error(
          formatApiRequestError(
            createIssuePath,
            createIssueOptions,
            error,
            `새 이슈 등록 실패\n- project_id: ${projectId}\n- thread_id: ${threadId}\n- bridge_id: ${selectedBridgeId}`
          )
        );
      }
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
          const startIssuePath =
            `/api/threads/${threadId}/issues/start?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`;
          const startIssueOptions = {
            method: "POST",
            body: JSON.stringify({
              issue_ids: [issueId]
            })
          };

          try {
            await apiRequest(startIssuePath, startIssueOptions);
          } catch (error) {
            void loadThreadMessages(threadId, { force: true });
            throw new Error(
              formatApiRequestError(
                startIssuePath,
                startIssueOptions,
                error,
                `이슈 실행 시작 실패\n- thread_id: ${threadId}\n- issue_id: ${issueId}\n- bridge_id: ${selectedBridgeId}\n- 설명: 채팅창과 이슈는 생성되었지만 실행 시작 요청이 실패했습니다. 현재 쓰레드는 idle, 이슈는 staged/queued로 남아 있을 수 있습니다.`
              )
            );
          }
        }
      }

      if (stayOnThread && threadId) {
        setActiveView("thread");
        scheduleThreadMessagesReload(threadId, {
          force: true,
          mode: "active",
          delay: 1200,
          suppressLoadingIndicator: true,
          reason: "thread_create_start_confirm"
        });
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
      const createIssuePath =
        `/api/threads/${threadId}/issues?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`;
      const createIssueOptions = {
        method: "POST",
        body: JSON.stringify({ prompt })
      };
      let createdIssue;

      try {
        createdIssue = await apiRequest(createIssuePath, createIssueOptions);
      } catch (error) {
        throw new Error(
          formatApiRequestError(
            createIssuePath,
            createIssueOptions,
            error,
            `추가 이슈 등록 실패\n- thread_id: ${threadId}\n- bridge_id: ${selectedBridgeId}`
          )
        );
      }
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
        const startIssuePath =
          `/api/threads/${threadId}/issues/start?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`;
        const startIssueOptions = {
          method: "POST",
          body: JSON.stringify({ issue_ids: [issueId] })
        };

        try {
          await apiRequest(startIssuePath, startIssueOptions);
        } catch (error) {
          void loadThreadMessages(threadId, { force: true });
          throw new Error(
            formatApiRequestError(
              startIssuePath,
              startIssueOptions,
              error,
              `추가 이슈 실행 시작 실패\n- thread_id: ${threadId}\n- issue_id: ${issueId}\n- bridge_id: ${selectedBridgeId}\n- 설명: 이슈는 생성되었지만 실행 시작 요청이 실패했습니다. 현재 쓰레드는 idle, 이슈는 staged/queued로 남아 있을 수 있습니다.`
            )
          );
        }
      }
      scheduleThreadMessagesReload(threadId, {
        force: true,
        mode: "active",
        delay: 1200,
        suppressLoadingIndicator: true,
        reason: "thread_append_start_confirm"
      });
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

  const deleteThreads = useCallback(async (threadIds, confirmMessage = "") => {
    if (!session?.loginId || !selectedBridgeId) {
      return {
        accepted: false,
        deletedThreadIds: [],
        failedThreadIds: []
      };
    }

    const normalizedThreadIds = [...new Set(threadIds.map((threadId) => String(threadId ?? "").trim()).filter(Boolean))];

    if (normalizedThreadIds.length === 0) {
      return {
        accepted: false,
        deletedThreadIds: [],
        failedThreadIds: []
      };
    }

    if (confirmMessage) {
      const accepted = await requestThreadDeleteConfirmation({
        title: normalizedThreadIds.length > 1 ? "채팅창 여러 개 삭제" : "채팅창 삭제",
        description: confirmMessage,
        confirmLabel: normalizedThreadIds.length > 1 ? `${normalizedThreadIds.length}개 삭제` : "삭제"
      });

      if (!accepted) {
        return {
          accepted: false,
          deletedThreadIds: [],
          failedThreadIds: []
        };
      }
    }

    setThreadBusy(true);

    try {
      const deletedThreadIds = [];
      const failedThreadIds = [];

      for (const threadId of normalizedThreadIds) {
        try {
          await apiRequest(
            `/api/threads/${threadId}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
            {
              method: "DELETE"
            }
          );
          deletedThreadIds.push(threadId);
        } catch (error) {
          failedThreadIds.push({
            threadId,
            message: error.message ?? "삭제하지 못했습니다."
          });
        }
      }

      if (deletedThreadIds.length > 0) {
        removeDeletedThreadsFromState(deletedThreadIds);
      }

      if (failedThreadIds.length > 0) {
        if (typeof window !== "undefined") {
          const firstFailure = failedThreadIds[0];
          const partialDeleteMessage =
            deletedThreadIds.length > 0
              ? `${deletedThreadIds.length}개를 삭제했고 ${failedThreadIds.length}개는 실패했습니다.\n첫 실패: ${firstFailure.message}`
              : firstFailure.message;
          window.alert(partialDeleteMessage);
        }

        return {
          accepted: false,
          deletedThreadIds,
          failedThreadIds
        };
      }

      return {
        accepted: true,
        deletedThreadIds,
        failedThreadIds: []
      };
    } finally {
      setThreadBusy(false);
    }
  }, [removeDeletedThreadsFromState, requestThreadDeleteConfirmation, selectedBridgeId, session?.loginId]);

  const handleDeleteThread = useCallback(
    async (threadId) => {
      const result = await deleteThreads([threadId], "이 채팅창을 삭제하시겠습니까?");
      return result?.accepted !== false;
    },
    [deleteThreads]
  );

  const handleDeleteThreads = useCallback(
    async (threadIds) => {
      const normalizedThreadIds = [...new Set(threadIds.map((threadId) => String(threadId ?? "").trim()).filter(Boolean))];

      if (normalizedThreadIds.length === 0) {
        return false;
      }

      const confirmMessage =
        normalizedThreadIds.length === 1
          ? "선택한 채팅창을 삭제하시겠습니까?"
          : `선택한 ${normalizedThreadIds.length}개의 채팅창을 삭제하시겠습니까?`;

      return deleteThreads(normalizedThreadIds, confirmMessage);
    },
    [deleteThreads]
  );

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
        const nextThreads = mergeThreads([], response.threads);
        setThreads(nextThreads);
        setThreadListsByProjectId((current) => {
          const next = { ...current };
          delete next[projectId];
          return next;
        });
      } else {
        setThreads((current) => current.filter((thread) => thread.project_id !== projectId));
        setThreadListsByProjectId((current) => {
          const next = { ...current };
          delete next[projectId];
          return next;
        });
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
        setSelectedScope({ kind: "project", id: fallbackProjectId });
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
        selectProjectScope(createdProject.id);
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

  const handleOpenProjectInstructionDialog = (instructionType) => {
    if (!selectedProjectId) {
      return;
    }

    setProjectInstructionType(instructionType === "developer" ? "developer" : "base");
    setProjectInstructionDialogOpen(true);
  };

  const handleCloseProjectInstructionDialog = () => {
    if (projectInstructionBusy) {
      return;
    }

    setProjectInstructionDialogOpen(false);
  };

  const handleSubmitProjectInstruction = async ({ instructionType, value }) => {
    if (!session?.loginId || !selectedBridgeId || !selectedProjectId) {
      return;
    }

    setProjectInstructionBusy(true);

    try {
      const isDeveloperInstruction = instructionType === "developer";
      const response = await apiRequest(
        `/api/projects/${encodeURIComponent(selectedProjectId)}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "PATCH",
          body: JSON.stringify(
            isDeveloperInstruction
              ? {
                  developer_instructions: value,
                  update_developer_instructions: true
                }
              : {
                  base_instructions: value,
                  update_base_instructions: true
                }
          )
        }
      );

      if (Array.isArray(response?.projects)) {
        setProjects(response.projects);
      } else if (response?.project?.id) {
        setProjects((current) =>
          current.map((project) => (project.id === response.project.id ? { ...project, ...response.project } : project))
        );
      }

      setProjectInstructionDialogOpen(false);
    } catch (error) {
      if (typeof window !== "undefined") {
        window.alert(error.message);
      }
    } finally {
      setProjectInstructionBusy(false);
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
    const preferredPath = roots[0]?.path ?? "";

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
    selectProjectScope(projectId);
    setSelectedThreadId("");
    setSelectedTodoChatId("");
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

    selectProjectScope(nextProjectId);
    setSelectedThreadId("");
    setSelectedTodoChatId("");
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
        bridgeSignal={bridgeSignal}
        signalNow={streamNow}
        projects={projects}
        threads={threads}
        todoChats={todoChats}
        threadOptionsByProjectId={threadListsByProjectId}
        todoChatDetail={currentTodoChatDetail}
        workspaceRoots={workspaceRoots}
        folderState={folderState}
        folderLoading={folderLoading}
        selectedWorkspacePath={selectedWorkspacePath}
        selectedBridgeId={selectedBridgeId}
        selectedScope={selectedScope}
        selectedThreadId={selectedThreadId}
        selectedTodoChatId={selectedTodoChatId}
        draftThreadProjectId={draftThreadProjectId}
        search={search}
        loadingState={loadingState}
        utilityOpen={utilityOpen}
        projectBusy={projectBusy}
        projectInstructionBusy={projectInstructionBusy}
        threadBusy={threadBusy}
        threadDeleteDialog={threadDeleteDialog}
        todoBusy={todoBusy}
        todoRenameBusy={todoRenameBusy}
        todoTransferBusy={todoTransferBusy}
        renameBusy={renameBusy}
        projectComposerOpen={projectComposerOpen}
        projectInstructionDialogOpen={projectInstructionDialogOpen}
        projectInstructionType={projectInstructionType}
        installPromptVisible={installPromptVisible}
        installBusy={installBusy}
        activeView={activeView}
        threadMessageFilter={threadMessageFilter}
        threadDetail={currentThreadDetailState}
        onSearchChange={setSearch}
        onChangeThreadMessageFilter={setThreadMessageFilter}
        onSelectBridge={setSelectedBridgeId}
        onSelectProject={handleSelectProject}
        onSelectTodoScope={handleSelectTodoScope}
        onSelectThread={handleSelectThread}
        onSelectTodoChat={handleSelectTodoChat}
        onOpenNewThread={handleOpenNewThread}
        onOpenNewTodoChat={() => void handleOpenNewTodoChat()}
        onOpenUtility={() => setUtilityOpen(true)}
        onOpenProjectComposer={() => void handleOpenProjectComposer()}
        onOpenProjectInstructionDialog={handleOpenProjectInstructionDialog}
        onInstallPwa={() => void handleInstallPwa()}
        onDismissInstallPrompt={handleDismissInstallPrompt}
        onCloseUtility={() => setUtilityOpen(false)}
        onCloseProjectComposer={handleCloseProjectComposer}
        onCloseProjectInstructionDialog={handleCloseProjectInstructionDialog}
        onBrowseWorkspaceRoot={(path) => browseWorkspacePath(path)}
        onBrowseFolder={(path) => browseWorkspacePath(path)}
        onSelectWorkspace={setSelectedWorkspacePath}
        onSubmitProject={handleCreateProject}
        onSubmitProjectInstruction={handleSubmitProjectInstruction}
        onCreateThread={handleCreateThread}
        onAppendThreadMessage={handleAppendThreadMessage}
        onSubmitTodoMessage={handleSubmitTodoMessage}
        onRenameThread={handleRenameThread}
        onRenameTodoChat={handleRenameTodoChat}
        onDeleteThread={handleDeleteThread}
        onDeleteThreads={handleDeleteThreads}
        onCloseThreadDeleteDialog={() => closeThreadDeleteDialog(false)}
        onConfirmThreadDeleteDialog={() => closeThreadDeleteDialog(true)}
        onDeleteTodoChat={handleDeleteTodoChat}
        onDeleteProject={handleDeleteProject}
        onEditTodoMessage={handleEditTodoMessage}
        onDeleteTodoMessage={handleDeleteTodoMessage}
        onTransferTodoMessage={handleTransferTodoMessage}
        onEnsureProjectThreads={ensureProjectThreadsLoaded}
        onRefreshTodoChat={handleRefreshTodoChat}
        onRefreshThreadDetail={handleRefreshThreadDetail}
        onStopThreadExecution={handleStopThreadExecution}
        onInterruptThreadIssue={handleInterruptThreadIssue}
        onDeleteThreadIssue={handleDeleteThreadIssue}
        onRefresh={() => void handleRefresh()}
        onLogout={handleLogout}
        onBackToInbox={handleBackToInbox}
      />
      <PwaUpdateDialog visible={pwaUpdateVisible} busy={pwaUpdateBusy} onConfirm={handleConfirmPwaUpdate} />
    </>
  );
}
