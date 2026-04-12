import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  isBridgeDisconnectConfirmed,
  mergeProjectSnapshots,
  normalizeBridgeDisconnectEvidence,
  reduceBridgeDisconnectEvidence
} from "../../../packages/domain/src/index.js";
import { createPortal } from "react-dom";
import { PWA_UPDATE_ACTIVATOR_KEY, PWA_UPDATE_READY_EVENT } from "./pwaEvents.js";
import PushNotificationCard from "./PushNotificationCard.jsx";

const LOCAL_STORAGE_KEY = "octop.mobile.session";
const SESSION_STORAGE_KEY = "octop.mobile.session.ephemeral";
const LEGACY_LOCAL_STORAGE_KEY = "octop.dashboard.session";
const LEGACY_SESSION_STORAGE_KEY = "octop.dashboard.session.ephemeral";
const SELECTED_BRIDGE_STORAGE_KEY = "octop.mobile.selectedBridge";
const MOBILE_WORKSPACE_LAYOUT_STORAGE_KEY = "octop.mobile.workspace.layout.v1";
const THREAD_DETAIL_CACHE_STORAGE_KEY = "octop.mobile.threadDetails.cache.v1";
const WORKSPACE_SNAPSHOT_CACHE_STORAGE_KEY = "octop.mobile.workspace.snapshot.v1";
const ISSUE_SOURCE_APP_ID = "mobile-web";
const createDefaultStatus = () => ({
  bridge_status_received: false,
  app_server: {
    connected: false,
    initialized: false,
    account: null,
    last_error: null,
    last_socket_activity_at: null
  },
  capabilities: {
    thread_developer_instructions: false
  },
  counts: {
    projects: 0,
    threads: 0
  },
  updated_at: null
});
const normalizeBridgeStatus = (nextStatus) => {
  const base = createDefaultStatus();
  const resolved = nextStatus && typeof nextStatus === "object" ? nextStatus : {};

  return {
    ...base,
    ...resolved,
    bridge_status_received: resolved.bridge_status_received === true,
    app_server: {
      ...base.app_server,
      ...(resolved.app_server ?? {})
    },
    capabilities: {
      ...base.capabilities,
      ...(resolved.capabilities ?? {})
    },
    counts: {
      projects: Number.isFinite(Number(resolved.counts?.projects))
        ? Number(resolved.counts.projects)
        : base.counts.projects,
      threads: Number.isFinite(Number(resolved.counts?.threads))
        ? Number(resolved.counts.threads)
        : base.counts.threads
    }
  };
};

const withReceivedBridgeStatus = (nextStatus) => {
  const resolved = nextStatus && typeof nextStatus === "object" ? nextStatus : {};

  return {
    ...resolved,
    bridge_status_received: true
  };
};

const bridgeSupportsThreadDeveloperInstructions = (status) =>
  status?.capabilities?.thread_developer_instructions === true;
const PWA_PROMPT_DISMISSED_KEY = "octop.mobile.pwa.install.dismissed";
const PWA_PROMPT_DISMISSED_VALUE = "manual";
const SERVICE_WORKER_CLIENT_CONTEXT_MESSAGE_TYPE = "octop.client.context";
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
const BRIDGE_RECONNECT_WORKSPACE_RELOAD_DEBOUNCE_MS = 3_000;
const BRIDGE_STALE_DISCONNECT_MS = 150_000;
const THREAD_RELOAD_MIN_INTERVAL_MS = 1_500;
const ACTIVE_ISSUE_POLL_INTERVAL_MS = 2_000;
const ACTIVE_ISSUE_POLL_SUPPRESS_AFTER_LIVE_MS = 6_000;
const ACTIVE_ISSUE_POLL_FAILURE_BASE_BACKOFF_MS = 10_000;
const ACTIVE_ISSUE_POLL_FAILURE_MAX_BACKOFF_MS = 60_000;
const ACTIVE_ISSUE_POLL_RECOVERY_FAILURE_THRESHOLD = 2;
const ACTIVE_ISSUE_POLL_RECOVERY_COOLDOWN_MS = 15_000;
const API_REQUEST_TIMEOUT_MS = 20_000;
const APP_RESUME_COALESCE_MS = 400;
const BACKGROUND_THREAD_PRELOAD_COUNT = 2;
const BACKGROUND_THREAD_PRELOAD_DELAY_MS = 220;
const MESSAGE_BUBBLE_LONG_PRESS_DELAY_MS = 600;
const MESSAGE_BUBBLE_LONG_PRESS_MOVE_TOLERANCE_PX = 10;
const MESSAGE_BUBBLE_LONG_PRESS_IGNORE_SELECTOR =
  "[data-message-code-scroll='true'], [data-message-attachment-interactive='true']";
const BRIDGE_TRANSPORT_ERROR_STATUS_CODES = new Set([503, 504]);
const VIEWPORT_METRICS_STORAGE_KEY = "octop.mobile.viewport.metrics.v1";
const VIEWPORT_STORAGE_REUSE_TOLERANCE_PX = 96;
const MAX_CACHED_THREAD_DETAILS_PER_SCOPE = 6;
const MAX_CACHED_THREAD_MESSAGES_PER_THREAD = 160;
const MAX_CACHED_THREAD_ISSUES_PER_THREAD = 24;
const MAX_CACHED_PROJECTS_PER_SCOPE = 40;
const MAX_CACHED_THREADS_PER_PROJECT = 120;
const MAX_CACHED_TODO_CHATS_PER_SCOPE = 80;
const MAX_MESSAGE_ATTACHMENTS = 8;
const MAX_MESSAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_MESSAGE_ATTACHMENT_TEXT_CHARS = 20_000;
const TEXT_ATTACHMENT_FILE_PATTERN =
  /\.(?:txt|md|markdown|json|jsonc|ya?ml|xml|csv|ts|tsx|js|jsx|mjs|cjs|css|scss|sass|html|htm|cs|java|kt|swift|py|rb|php|go|rs|sh|zsh|bash|ps1|sql|toml|ini|cfg|conf|env|gitignore|dockerfile)$/i;
const MESSAGE_ATTACHMENT_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
const MESSAGE_ATTACHMENT_TEXT_EXTENSIONS = [
  "txt",
  "md",
  "markdown",
  "json",
  "jsonc",
  "yaml",
  "yml",
  "xml",
  "csv",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "css",
  "scss",
  "sass",
  "html",
  "htm",
  "c",
  "cpp",
  "cs",
  "java",
  "kt",
  "swift",
  "py",
  "rb",
  "php",
  "go",
  "rs",
  "sh",
  "zsh",
  "bash",
  "ps1",
  "sql",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "tex"
];
const MESSAGE_ATTACHMENT_SPECIAL_FILE_NAMES = [".gitignore", "dockerfile"];
const MESSAGE_ATTACHMENT_SUPPORTED_EXTENSIONS = [
  ...MESSAGE_ATTACHMENT_IMAGE_EXTENSIONS,
  ...MESSAGE_ATTACHMENT_TEXT_EXTENSIONS
];
const MESSAGE_ATTACHMENT_SUPPORTED_EXTENSION_SET = new Set(MESSAGE_ATTACHMENT_SUPPORTED_EXTENSIONS);
const MESSAGE_ATTACHMENT_SPECIAL_FILE_NAME_SET = new Set(MESSAGE_ATTACHMENT_SPECIAL_FILE_NAMES);
const MESSAGE_ATTACHMENT_ACCEPT = [
  ...MESSAGE_ATTACHMENT_SUPPORTED_EXTENSIONS.map((extension) => `.${extension}`),
  ...MESSAGE_ATTACHMENT_SPECIAL_FILE_NAMES
].join(",");
const THREAD_HISTORY_LAZY_PAGE_SIZE = 2;
const THREAD_HISTORY_PRELOAD_SCROLL_TOP_PX = 480;
const bridgeRequestFailureListeners = new Set();
const bridgeRequestSuccessListeners = new Set();

function subscribeBridgeRequestFailures(listener) {
  if (typeof listener !== "function") {
    return () => {};
  }

  bridgeRequestFailureListeners.add(listener);
  return () => {
    bridgeRequestFailureListeners.delete(listener);
  };
}

function notifyBridgeRequestFailure(event) {
  for (const listener of bridgeRequestFailureListeners) {
    try {
      listener(event);
    } catch {
      // ignore listener failures
    }
  }
}

function subscribeBridgeRequestSuccesses(listener) {
  if (typeof listener !== "function") {
    return () => {};
  }

  bridgeRequestSuccessListeners.add(listener);
  return () => {
    bridgeRequestSuccessListeners.delete(listener);
  };
}

function notifyBridgeRequestSuccess(event) {
  for (const listener of bridgeRequestSuccessListeners) {
    try {
      listener(event);
    } catch {
      // ignore listener failures
    }
  }
}

function extractBridgeIdFromPath(path) {
  const queryIndex = String(path ?? "").indexOf("?");

  if (queryIndex < 0) {
    return "";
  }

  const query = String(path).slice(queryIndex + 1);
  const params = new URLSearchParams(query);
  return String(params.get("bridge_id") ?? "").trim();
}

function shouldInferBridgeTransportFailure(path, method = "GET") {
  const normalizedMethod = String(method ?? "GET").trim().toUpperCase();

  if (normalizedMethod !== "GET") {
    return false;
  }

  return Boolean(extractBridgeIdFromPath(path));
}

function readPushDeepLink() {
  if (typeof window === "undefined") {
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  const bridgeId = String(params.get("bridge_id") ?? "").trim();
  const projectId = String(params.get("project_id") ?? "").trim();
  const threadId = String(params.get("thread_id") ?? "").trim();
  const issueId = String(params.get("issue_id") ?? "").trim();

  if (!bridgeId && !projectId && !threadId && !issueId) {
    return null;
  }

  return {
    bridgeId,
    projectId,
    threadId,
    issueId
  };
}

function clearPushDeepLink() {
  if (typeof window === "undefined" || !window.history?.replaceState) {
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.delete("bridge_id");
  url.searchParams.delete("project_id");
  url.searchParams.delete("thread_id");
  url.searchParams.delete("issue_id");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function isStandaloneDisplayMode() {
  if (typeof window === "undefined") {
    return false;
  }

  const standaloneClientMode =
    (() => {
      try {
        return new URL(window.location.href).searchParams.get("client_mode") === "standalone";
      } catch {
        return false;
      }
    })();

  return (
    standaloneClientMode ||
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

function hasStandaloneVisibleNestedView({
  activeView = "inbox",
  selectedScopeKind = "project",
  selectedThreadId = "",
  selectedTodoChatId = "",
  draftThreadProjectId = "",
  wideSplitEnabled = false
} = {}) {
  if (String(draftThreadProjectId ?? "").trim()) {
    return true;
  }

  if (activeView === "thread" || activeView === "todo") {
    return true;
  }

  return false;
}

function hasCoarsePointerDevice() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  try {
    return window.matchMedia("(pointer: coarse)").matches || window.matchMedia("(any-pointer: coarse)").matches;
  } catch {
    return false;
  }
}

async function publishServiceWorkerClientContext() {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }

  const message = {
    type: SERVICE_WORKER_CLIENT_CONTEXT_MESSAGE_TYPE,
    clientMode: isStandaloneDisplayMode() ? "standalone" : "browser"
  };

  try {
    navigator.serviceWorker.controller?.postMessage(message);
  } catch {
    // ignore controller message failures
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    registration.active?.postMessage(message);
  } catch {
    // ignore registration message failures
  }
}

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

function buildBridgeSignal({
  statusReceived,
  socketConnected,
  disconnectConfirmed,
  hasDisconnectEvidence,
  lastSocketActivityAt,
  statusUpdatedAt,
  now
}) {
  if (disconnectConfirmed) {
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

  if (!statusReceived && !hasDisconnectEvidence) {
    return {
      label: "브릿지 확인 중",
      title: "브릿지 상태를 확인하고 있습니다.",
      dotColor: "#94a3b8",
      chipStyle: {
        backgroundColor: "rgba(148, 163, 184, 0.14)",
        borderColor: "rgba(148, 163, 184, 0.3)",
        color: "#cbd5e1"
      }
    };
  }

  if (!statusReceived || !socketConnected) {
    return {
      label: "연결됨",
      title: "브릿지 연결을 다시 확인하고 있습니다.",
      dotColor: "#f59e0b",
      chipStyle: {
        backgroundColor: "rgba(245, 158, 11, 0.14)",
        borderColor: "rgba(245, 158, 11, 0.3)",
        color: "#fde68a"
      }
    };
  }

  const socketActivityAt = Number.isFinite(lastSocketActivityAt) ? lastSocketActivityAt : 0;
  const statusActivityAt = Number.isFinite(statusUpdatedAt) ? statusUpdatedAt : 0;
  const effectiveActivityAt = Math.max(socketActivityAt, statusActivityAt);
  const bridgeSilentMs = effectiveActivityAt > 0 ? Math.max(0, now - effectiveActivityAt) : 0;

  if (effectiveActivityAt > 0 && bridgeSilentMs >= BRIDGE_STALE_DISCONNECT_MS) {
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
const CHAT_MANUAL_SCROLL_UNPIN_DELTA_PX = 2;
const CHAT_JUMP_TO_LATEST_BUTTON_THRESHOLD_PX = 240;
const HEADER_MENU_SCROLL_DELTA_PX = 12;
const HEADER_MENU_VIEWPORT_SETTLE_MS = 320;
const MOBILE_NOTICE_AUTO_DISMISS_MS = 4_000;
const MOBILE_NOTICE_ERROR_DISMISS_MS = 6_000;
const SCROLL_BOUNDARY_EPSILON_PX = 1;
const BOTTOM_BOUNDARY_HEADER_GUARD_PX = 24;
const BOTTOM_BOUNDARY_MOMENTUM_LOCK_MS = 180;
const PROJECT_DELETE_CONFIRM_MESSAGE = "프로젝트를 삭제하시겠습니까? 해당 프로젝트의 이슈도 함께 제거됩니다.";
const PROJECT_CHIP_LONG_PRESS_MS = 650;
const TODO_SCOPE_ID = "todo";
const CHAT_COMPOSER_MAX_HEIGHT_PX = 240; // 최대 입력창 높이(px)를 제한해 채팅 영역이 사라지는 것을 방지
const MOBILE_SINGLE_PAGE_MAX_WIDTH_PX = 768;
const MOBILE_BASE_PAGE_MIN_WIDTH_PX = 430;
const DEFAULT_WIDE_THREAD_SPLIT_RATIO = 0.5;
const MOBILE_WIDE_THREAD_SPLIT_MIN_WIDTH_PX = Math.max(
  MOBILE_SINGLE_PAGE_MAX_WIDTH_PX + 1,
  MOBILE_BASE_PAGE_MIN_WIDTH_PX * 2
);
const MOBILE_WIDE_THREAD_SPLIT_RESIZE_MIN_WIDTH_PX = MOBILE_BASE_PAGE_MIN_WIDTH_PX * 2;
const MOBILE_WIDE_THREAD_SPLIT_MIN_PANE_WIDTH_PX = 320;
const MAX_TRACKED_PROJECT_FILTER_USAGE = 120;
const PROJECT_CHIP_REORDER_MOVE_TOLERANCE_PX = 8;
const PROJECT_CHIP_LONG_PRESS_CANCEL_TOLERANCE_PX = 10;
const THREAD_LIST_ITEM_LONG_PRESS_MS = 420;
const THREAD_LIST_ITEM_LONG_PRESS_CANCEL_TOLERANCE_PX = 10;
const THREAD_LIST_ITEM_REORDER_MOVE_TOLERANCE_PX = 8;
const REORDER_POSITION_LOCK_FRAME_COUNT = 2;

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

function getScrollAnchorElements(node) {
  if (!node?.querySelectorAll) {
    return [];
  }

  return [...node.querySelectorAll("[data-scroll-anchor-id]")].filter((element) => element instanceof HTMLElement);
}

function captureScrollAnchorSnapshot(node) {
  if (!node) {
    return null;
  }

  const containerRect = node.getBoundingClientRect();
  const anchors = getScrollAnchorElements(node);

  if (anchors.length === 0) {
    return {
      scrollTop: node.scrollTop,
      scrollHeight: node.scrollHeight
    };
  }

  const visibleAnchor =
    anchors.find((anchor) => {
      const rect = anchor.getBoundingClientRect();

      return rect.bottom >= containerRect.top && rect.top <= containerRect.bottom;
    }) ?? anchors[0];
  const anchorRect = visibleAnchor.getBoundingClientRect();

  return {
    anchorId: String(visibleAnchor.dataset.scrollAnchorId ?? "").trim(),
    anchorTop: anchorRect.top - containerRect.top,
    scrollTop: node.scrollTop,
    scrollHeight: node.scrollHeight
  };
}

function restoreScrollAnchorSnapshot(node, snapshot) {
  if (!node || !snapshot) {
    return false;
  }

  const anchorId = String(snapshot.anchorId ?? "").trim();

  if (anchorId) {
    const targetAnchor = getScrollAnchorElements(node).find(
      (element) => String(element.dataset.scrollAnchorId ?? "").trim() === anchorId
    );

    if (targetAnchor) {
      const containerRect = node.getBoundingClientRect();
      const targetRect = targetAnchor.getBoundingClientRect();
      const deltaTop = targetRect.top - containerRect.top - Number(snapshot.anchorTop ?? 0);

      if (deltaTop !== 0) {
        node.scrollTop = Math.max(0, node.scrollTop + deltaTop);
      }

      return true;
    }
  }

  const deltaHeight = node.scrollHeight - Number(snapshot.scrollHeight ?? node.scrollHeight);

  if (deltaHeight !== 0) {
    node.scrollTop = Math.max(0, Number(snapshot.scrollTop ?? node.scrollTop) + deltaHeight);
    return true;
  }

  return false;
}

function clampWideThreadSplitRatio(ratio, containerWidth) {
  const safeContainerWidth = Math.max(containerWidth ?? 0, MOBILE_WIDE_THREAD_SPLIT_RESIZE_MIN_WIDTH_PX);
  const minRatio = Math.min(0.45, MOBILE_WIDE_THREAD_SPLIT_MIN_PANE_WIDTH_PX / safeContainerWidth);
  const maxRatio = 1 - minRatio;

  return Math.min(maxRatio, Math.max(minRatio, ratio));
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

function createDefaultMobileWorkspaceLayout() {
  return {
    loginId: "",
    bridgeId: "",
    selectedScope: { kind: "project", id: "" },
    selectedThreadId: "",
    instantThreadId: "",
    selectedTodoChatId: "",
    draftThreadProjectId: "",
    threadComposerDrafts: {},
    projectFilterUsage: {},
    projectChipOrder: [],
    threadOrderByProjectId: {},
    activeView: "inbox",
    wideThreadSplitRatio: DEFAULT_WIDE_THREAD_SPLIT_RATIO
  };
}

function normalizeProjectChipOrder(source, availableProjectIds = null) {
  if (!Array.isArray(source)) {
    return [];
  }

  const allowedProjectIds = Array.isArray(availableProjectIds)
    ? new Set(
        availableProjectIds
          .map((projectId) => String(projectId ?? "").trim())
          .filter(Boolean)
      )
    : null;
  const seen = new Set();
  const next = [];

  for (const rawProjectId of source) {
    const projectId = String(rawProjectId ?? "").trim();

    if (!projectId || seen.has(projectId)) {
      continue;
    }

    if (allowedProjectIds && !allowedProjectIds.has(projectId)) {
      continue;
    }

    seen.add(projectId);
    next.push(projectId);
  }

  return next.slice(0, MAX_TRACKED_PROJECT_FILTER_USAGE);
}

function areStringArraysEqual(left = [], right = []) {
  if (left === right) {
    return true;
  }

  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function areStringArrayRecordEqual(left = {}, right = {}) {
  const leftEntries = Object.entries(left)
    .map(([key, value]) => [String(key ?? "").trim(), Array.isArray(value) ? value : []])
    .filter(([key]) => Boolean(key))
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  const rightEntries = Object.entries(right)
    .map(([key, value]) => [String(key ?? "").trim(), Array.isArray(value) ? value : []])
    .filter(([key]) => Boolean(key))
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));

  if (leftEntries.length !== rightEntries.length) {
    return false;
  }

  for (let index = 0; index < leftEntries.length; index += 1) {
    const [leftKey, leftValue] = leftEntries[index];
    const [rightKey, rightValue] = rightEntries[index];

    if (leftKey !== rightKey || !areStringArraysEqual(leftValue, rightValue)) {
      return false;
    }
  }

  return true;
}

function getFlexRowGapPx(node) {
  if (!node || typeof window === "undefined" || typeof window.getComputedStyle !== "function") {
    return 0;
  }

  const style = window.getComputedStyle(node);
  const rawGap = style.columnGap || style.gap || "0";
  const parsedGap = Number.parseFloat(rawGap);
  return Number.isFinite(parsedGap) ? parsedGap : 0;
}

function reorderProjectChipIdsByIndex(projectIds, draggedProjectId, targetIndex) {
  const normalizedProjectIds = normalizeProjectChipOrder(projectIds);
  const normalizedDraggedProjectId = String(draggedProjectId ?? "").trim();

  if (!normalizedDraggedProjectId || normalizedProjectIds.length <= 1) {
    return normalizedProjectIds;
  }

  const fromIndex = normalizedProjectIds.indexOf(normalizedDraggedProjectId);

  if (fromIndex < 0) {
    return normalizedProjectIds;
  }

  const nextProjectIds = [...normalizedProjectIds];
  const [draggedId] = nextProjectIds.splice(fromIndex, 1);
  const clampedTargetIndex = Math.max(0, Math.min(Number(targetIndex) || 0, nextProjectIds.length));
  nextProjectIds.splice(clampedTargetIndex, 0, draggedId);
  return nextProjectIds;
}

function buildProjectChipCollapsedLayouts(orderedProjectIds, draggedProjectId, layoutSnapshot, draggedWidth, gapPx) {
  const normalizedOrderedProjectIds = normalizeProjectChipOrder(orderedProjectIds);
  const normalizedDraggedProjectId = String(draggedProjectId ?? "").trim();
  const draggedProjectIndex = normalizedOrderedProjectIds.indexOf(normalizedDraggedProjectId);
  const shiftDistance = Math.max(0, draggedWidth) + Math.max(0, gapPx);
  const draggableLayouts = [];

  normalizedOrderedProjectIds.forEach((projectId, orderedIndex) => {
    if (projectId === normalizedDraggedProjectId) {
      return;
    }

    const layout = layoutSnapshot.get(projectId);

    if (!layout) {
      return;
    }

    draggableLayouts.push({
      id: projectId,
      orderedIndex,
      left: layout.left + (orderedIndex > draggedProjectIndex ? -shiftDistance : 0),
      width: layout.width
    });
  });

  return {
    draggedProjectIndex,
    draggableLayouts,
    shiftDistance
  };
}

function resolveProjectChipSlotLeft(draggableLayouts, slotIndex, gapPx, fallbackLeft = 0) {
  const normalizedSlotIndex = Math.max(0, Math.min(Number(slotIndex) || 0, draggableLayouts.length));

  if (draggableLayouts.length === 0) {
    return fallbackLeft;
  }

  if (normalizedSlotIndex < draggableLayouts.length) {
    return draggableLayouts[normalizedSlotIndex].left;
  }

  const lastLayout = draggableLayouts[draggableLayouts.length - 1];
  return lastLayout.left + lastLayout.width + Math.max(0, gapPx);
}

function resolveProjectedProjectChipLayout(draggableLayouts, itemIndex, slotIndex, shiftDistance) {
  const layout = draggableLayouts[itemIndex];

  if (!layout) {
    return null;
  }

  return {
    left: layout.left + (itemIndex >= slotIndex ? shiftDistance : 0),
    width: layout.width
  };
}

function buildThreadListCollapsedLayouts(orderedThreadIds, draggedThreadId, layoutSnapshot, draggedHeight) {
  const normalizedOrderedThreadIds = normalizeThreadOrder(orderedThreadIds);
  const normalizedDraggedThreadId = String(draggedThreadId ?? "").trim();
  const draggedThreadIndex = normalizedOrderedThreadIds.indexOf(normalizedDraggedThreadId);
  const shiftDistance = Math.max(0, draggedHeight);
  const draggableLayouts = [];

  normalizedOrderedThreadIds.forEach((threadId, orderedIndex) => {
    if (threadId === normalizedDraggedThreadId) {
      return;
    }

    const layout = layoutSnapshot.get(threadId);

    if (!layout) {
      return;
    }

    draggableLayouts.push({
      id: threadId,
      orderedIndex,
      top: layout.top + (orderedIndex > draggedThreadIndex ? -shiftDistance : 0),
      height: layout.height
    });
  });

  return {
    draggedThreadIndex,
    draggableLayouts,
    shiftDistance
  };
}

function resolveThreadSlotTop(draggableLayouts, slotIndex, fallbackTop = 0) {
  const normalizedSlotIndex = Math.max(0, Math.min(Number(slotIndex) || 0, draggableLayouts.length));

  if (draggableLayouts.length === 0) {
    return fallbackTop;
  }

  if (normalizedSlotIndex < draggableLayouts.length) {
    return draggableLayouts[normalizedSlotIndex].top;
  }

  const lastLayout = draggableLayouts[draggableLayouts.length - 1];
  return lastLayout.top + lastLayout.height;
}

function resolveProjectedThreadLayout(draggableLayouts, itemIndex, slotIndex, shiftDistance) {
  const layout = draggableLayouts[itemIndex];

  if (!layout) {
    return null;
  }

  return {
    top: layout.top + (itemIndex >= slotIndex ? shiftDistance : 0),
    height: layout.height
  };
}

function normalizeThreadOrder(source, availableThreadIds = null) {
  if (!Array.isArray(source)) {
    return [];
  }

  const allowedThreadIds = Array.isArray(availableThreadIds)
    ? new Set(
        availableThreadIds
          .map((threadId) => String(threadId ?? "").trim())
          .filter(Boolean)
      )
    : null;
  const seen = new Set();
  const next = [];

  for (const rawThreadId of source) {
    const threadId = String(rawThreadId ?? "").trim();

    if (!threadId || seen.has(threadId)) {
      continue;
    }

    if (allowedThreadIds && !allowedThreadIds.has(threadId)) {
      continue;
    }

    seen.add(threadId);
    next.push(threadId);
  }

  return next.slice(0, MAX_CACHED_THREADS_PER_PROJECT);
}

function normalizeThreadOrderByProjectId(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(source)
      .map(([rawProjectId, rawThreadOrder]) => {
        const projectId = String(rawProjectId ?? "").trim();

        if (!projectId) {
          return null;
        }

        const normalizedThreadOrder = normalizeThreadOrder(rawThreadOrder);

        if (normalizedThreadOrder.length === 0) {
          return null;
        }

        return [projectId, normalizedThreadOrder];
      })
      .filter(Boolean)
  );
}

function resolveOrderedThreadIds(threadIds, threadOrder = []) {
  const normalizedThreadIds = normalizeThreadOrder(threadIds);
  const preferredOrderIds = normalizeThreadOrder(threadOrder, normalizedThreadIds);
  const preferredOrderSet = new Set(preferredOrderIds);

  return [...preferredOrderIds, ...normalizedThreadIds.filter((threadId) => !preferredOrderSet.has(threadId))];
}

function reorderThreadIdsByIndex(threadIds, draggedThreadId, targetIndex) {
  const normalizedThreadIds = normalizeThreadOrder(threadIds);
  const normalizedDraggedThreadId = String(draggedThreadId ?? "").trim();

  if (!normalizedDraggedThreadId || normalizedThreadIds.length <= 1) {
    return normalizedThreadIds;
  }

  const fromIndex = normalizedThreadIds.indexOf(normalizedDraggedThreadId);

  if (fromIndex < 0) {
    return normalizedThreadIds;
  }

  const nextThreadIds = [...normalizedThreadIds];
  const [draggedId] = nextThreadIds.splice(fromIndex, 1);
  const clampedTargetIndex = Math.max(0, Math.min(Number(targetIndex) || 0, nextThreadIds.length));
  nextThreadIds.splice(clampedTargetIndex, 0, draggedId);
  return nextThreadIds;
}

function applySubsetThreadOrder(threadIds, subsetThreadIds, reorderedSubsetThreadIds) {
  const normalizedThreadIds = normalizeThreadOrder(threadIds);
  const normalizedSubsetThreadIds = normalizeThreadOrder(subsetThreadIds, normalizedThreadIds);
  const normalizedReorderedSubsetThreadIds = normalizeThreadOrder(reorderedSubsetThreadIds, normalizedSubsetThreadIds);

  if (normalizedSubsetThreadIds.length === 0 || normalizedReorderedSubsetThreadIds.length !== normalizedSubsetThreadIds.length) {
    return normalizedThreadIds;
  }

  const subsetThreadIdSet = new Set(normalizedSubsetThreadIds);
  let subsetIndex = 0;

  return normalizedThreadIds.map((threadId) => {
    if (!subsetThreadIdSet.has(threadId)) {
      return threadId;
    }

    const nextThreadId = normalizedReorderedSubsetThreadIds[subsetIndex] ?? threadId;
    subsetIndex += 1;
    return nextThreadId;
  });
}

function resolveOrderedThreads(threads, threadOrder = []) {
  const normalizedThreads = threads.map((thread) => normalizeThread(thread)).filter(Boolean);
  const availableThreadIds = normalizedThreads.map((thread) => thread.id);
  const preferredOrderIds = normalizeThreadOrder(threadOrder, availableThreadIds);
  const preferredOrderSet = new Set(preferredOrderIds);
  const threadById = new Map(normalizedThreads.map((thread) => [thread.id, thread]));

  return [
    ...preferredOrderIds.map((threadId) => threadById.get(threadId)).filter(Boolean),
    ...normalizedThreads.filter((thread) => !preferredOrderSet.has(thread.id))
  ];
}

function resolveOrderedProjects(projects, projectFilterUsage, projectChipOrder = []) {
  void projectFilterUsage;
  const projectEntries = [...projects].map((project, index) => ({
    project,
    index
  }));
  const availableProjectIds = projectEntries.map(({ project }) => project.id);
  const preferredOrderIds = normalizeProjectChipOrder(projectChipOrder, availableProjectIds);
  const preferredOrderSet = new Set(preferredOrderIds);
  const projectById = new Map(projectEntries.map(({ project }) => [project.id, project]));
  const remainingProjects = projectEntries
    .filter(({ project }) => !preferredOrderSet.has(project.id))
    .sort((left, right) => left.index - right.index)
    .map(({ project }) => project);

  return [
    ...preferredOrderIds.map((projectId) => projectById.get(projectId)).filter(Boolean),
    ...remainingProjects
  ];
}

function normalizeThreadComposerDrafts(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return {};
  }

  const next = {};

  Object.entries(source).forEach(([rawKey, rawValue]) => {
    const key = String(rawKey ?? "").trim();

    if (!key) {
      return;
    }

    const value = typeof rawValue === "string" ? rawValue : String(rawValue ?? "");

    if (!value) {
      return;
    }

    next[key] = value.slice(0, 20000);
  });

  return next;
}

function buildThreadComposerDraftKey({ threadId, projectId, isDraft = false } = {}) {
  const normalizedThreadId = String(threadId ?? "").trim();

  if (normalizedThreadId) {
    return `thread:${normalizedThreadId}`;
  }

  const normalizedProjectId = String(projectId ?? "").trim();

  if (isDraft && normalizedProjectId) {
    return `project-draft:${normalizedProjectId}`;
  }

  return "";
}

function buildTodoComposerDraftKey({ chatId } = {}) {
  const normalizedChatId = String(chatId ?? "").trim();

  if (!normalizedChatId) {
    return "";
  }

  return `todo-chat:${normalizedChatId}`;
}

function normalizeComposerDraftValue(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return typeof value === "string" ? value : String(value);
}

function normalizeMobileWorkspaceLayoutScope(scope) {
  if (scope?.kind === "todo") {
    return { kind: "todo", id: TODO_SCOPE_ID };
  }

  return {
    kind: "project",
    id: String(scope?.id ?? "").trim()
  };
}

function normalizeProjectFilterUsage(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(source)
      .map(([rawProjectId, rawUsage]) => {
        const projectId = String(rawProjectId ?? "").trim();

        if (!projectId || !rawUsage || typeof rawUsage !== "object" || Array.isArray(rawUsage)) {
          return null;
        }

        const usageCount = Math.max(0, Math.round(Number(rawUsage.usageCount ?? 0) || 0));
        const lastUsedAt = Math.max(0, Math.round(Number(rawUsage.lastUsedAt ?? 0) || 0));

        if (usageCount <= 0 && lastUsedAt <= 0) {
          return null;
        }

        return [
          projectId,
          {
            usageCount,
            lastUsedAt
          }
        ];
      })
      .filter(Boolean)
      .sort(([, left], [, right]) => {
        const lastUsedDelta = Number(right?.lastUsedAt ?? 0) - Number(left?.lastUsedAt ?? 0);

        if (lastUsedDelta !== 0) {
          return lastUsedDelta;
        }

        return Number(right?.usageCount ?? 0) - Number(left?.usageCount ?? 0);
      })
      .slice(0, MAX_TRACKED_PROJECT_FILTER_USAGE)
  );
}

function normalizeMobileWorkspaceLayout(layout, filters = {}) {
  const base = createDefaultMobileWorkspaceLayout();
  const source = layout && typeof layout === "object" ? layout : {};
  const selectedScope = normalizeMobileWorkspaceLayoutScope(source.selectedScope);
  const activeView =
    source.activeView === "thread" || source.activeView === "todo" || source.activeView === "inbox"
      ? source.activeView
      : base.activeView;
  const ratio = Number(source.wideThreadSplitRatio);

  return {
    loginId: String(filters.loginId ?? source.loginId ?? "").trim(),
    bridgeId: String(filters.bridgeId ?? source.bridgeId ?? "").trim(),
    selectedScope,
    selectedThreadId: String(source.selectedThreadId ?? "").trim(),
    instantThreadId: String(source.instantThreadId ?? "").trim(),
    selectedTodoChatId: String(source.selectedTodoChatId ?? "").trim(),
    draftThreadProjectId: String(source.draftThreadProjectId ?? "").trim(),
    threadComposerDrafts: normalizeThreadComposerDrafts(source.threadComposerDrafts),
    projectFilterUsage: normalizeProjectFilterUsage(source.projectFilterUsage),
    projectChipOrder: normalizeProjectChipOrder(source.projectChipOrder),
    threadOrderByProjectId: normalizeThreadOrderByProjectId(source.threadOrderByProjectId),
    activeView,
    wideThreadSplitRatio:
      Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? ratio : DEFAULT_WIDE_THREAD_SPLIT_RATIO
  };
}

function readStoredMobileWorkspaceLayout(filters = {}) {
  if (typeof window === "undefined") {
    return createDefaultMobileWorkspaceLayout();
  }

  try {
    const raw = window.localStorage.getItem(MOBILE_WORKSPACE_LAYOUT_STORAGE_KEY);

    if (!raw) {
      return createDefaultMobileWorkspaceLayout();
    }

    const parsed = JSON.parse(raw);
    const normalized = normalizeMobileWorkspaceLayout(parsed, filters);

    if (filters.loginId && normalized.loginId !== String(filters.loginId).trim()) {
      return createDefaultMobileWorkspaceLayout();
    }

    if (filters.bridgeId && normalized.bridgeId !== String(filters.bridgeId).trim()) {
      return createDefaultMobileWorkspaceLayout();
    }

    return normalized;
  } catch {
    return createDefaultMobileWorkspaceLayout();
  }
}

function storeMobileWorkspaceLayout(patch, filters = {}) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const current = readStoredMobileWorkspaceLayout(filters);
    const next = normalizeMobileWorkspaceLayout({ ...current, ...patch }, filters);
    window.localStorage.setItem(MOBILE_WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage failures
  }
}

function clearStoredMobileWorkspaceLayout() {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.removeItem(MOBILE_WORKSPACE_LAYOUT_STORAGE_KEY);
  } catch {
    // ignore storage failures
  }
}

function buildWorkspaceLayoutOwnerKey(loginId, bridgeId) {
  return `${String(loginId ?? "").trim()}::${String(bridgeId ?? "").trim()}`;
}

function createDefaultWorkspaceSnapshot() {
  return {
    projects: [],
    todoChats: [],
    threadListsByProjectId: {}
  };
}

function createDefaultWorkspaceSnapshotCacheStore() {
  return {
    version: 1,
    scopes: {}
  };
}

function normalizeCachedProjects(projects = []) {
  return projects
    .map((project) => {
      const id = String(project?.id ?? "").trim();

      if (!id) {
        return null;
      }

      return {
        ...project,
        id
      };
    })
    .filter(Boolean)
    .slice(0, MAX_CACHED_PROJECTS_PER_SCOPE);
}

function normalizeCachedThreadListsByProjectId(threadListsByProjectId = {}) {
  if (!threadListsByProjectId || typeof threadListsByProjectId !== "object" || Array.isArray(threadListsByProjectId)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(threadListsByProjectId)
      .map(([rawProjectId, threadList]) => {
        const projectId = String(rawProjectId ?? "").trim();

        if (!projectId || !Array.isArray(threadList)) {
          return null;
        }

        const normalizedThreads = mergeThreads([], threadList).slice(0, MAX_CACHED_THREADS_PER_PROJECT);

        if (normalizedThreads.length === 0) {
          return null;
        }

        return [projectId, normalizedThreads];
      })
      .filter(Boolean)
  );
}

function normalizeWorkspaceSnapshot(snapshot) {
  const source = snapshot && typeof snapshot === "object" ? snapshot : {};

  return {
    projects: normalizeCachedProjects(source.projects ?? []),
    todoChats: mergeTodoChats([], source.todoChats ?? []).slice(0, MAX_CACHED_TODO_CHATS_PER_SCOPE),
    threadListsByProjectId: normalizeCachedThreadListsByProjectId(source.threadListsByProjectId ?? {})
  };
}

function resolveThreadsForScopeFromSnapshot(snapshot, scope) {
  if (scope?.kind !== "project") {
    return [];
  }

  const projectId = String(scope?.id ?? "").trim();

  if (!projectId) {
    return [];
  }

  return snapshot?.threadListsByProjectId?.[projectId] ?? [];
}

function readStoredWorkspaceSnapshot(filters = {}) {
  if (typeof window === "undefined") {
    return createDefaultWorkspaceSnapshot();
  }

  const ownerKey = buildWorkspaceLayoutOwnerKey(filters.loginId, filters.bridgeId);

  if (!ownerKey || ownerKey === "::") {
    return createDefaultWorkspaceSnapshot();
  }

  try {
    const raw = window.localStorage.getItem(WORKSPACE_SNAPSHOT_CACHE_STORAGE_KEY);

    if (!raw) {
      return createDefaultWorkspaceSnapshot();
    }

    const parsed = JSON.parse(raw);
    const scopedSnapshot = parsed?.scopes?.[ownerKey]?.snapshot ?? null;
    return normalizeWorkspaceSnapshot(scopedSnapshot);
  } catch {
    return createDefaultWorkspaceSnapshot();
  }
}

function storeWorkspaceSnapshot(snapshot, filters = {}) {
  if (typeof window === "undefined") {
    return;
  }

  const ownerKey = buildWorkspaceLayoutOwnerKey(filters.loginId, filters.bridgeId);

  if (!ownerKey || ownerKey === "::") {
    return;
  }

  try {
    const raw = window.localStorage.getItem(WORKSPACE_SNAPSHOT_CACHE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : createDefaultWorkspaceSnapshotCacheStore();
    const nextStore = {
      ...createDefaultWorkspaceSnapshotCacheStore(),
      ...(parsed && typeof parsed === "object" ? parsed : {}),
      scopes: {
        ...(parsed?.scopes ?? {})
      }
    };
    const normalizedSnapshot = normalizeWorkspaceSnapshot(snapshot);

    if (
      normalizedSnapshot.projects.length === 0 &&
      normalizedSnapshot.todoChats.length === 0 &&
      Object.keys(normalizedSnapshot.threadListsByProjectId).length === 0
    ) {
      delete nextStore.scopes[ownerKey];
    } else {
      nextStore.scopes[ownerKey] = {
        updatedAt: new Date().toISOString(),
        snapshot: normalizedSnapshot
      };
    }

    window.localStorage.setItem(WORKSPACE_SNAPSHOT_CACHE_STORAGE_KEY, JSON.stringify(nextStore));
  } catch {
    // ignore storage failures
  }
}

function createDefaultThreadDetailCacheStore() {
  return {
    version: 1,
    scopes: {}
  };
}

function normalizeCachedThreadMessages(messages = []) {
  return messages
    .map((message, index) => {
      if (!message) {
        return null;
      }

      const role =
        message.role === "assistant"
          ? "assistant"
          : message.role === "system" || message.kind === "handoff_summary"
            ? "system"
            : "user";
      const timestamp = String(message.timestamp ?? new Date().toISOString());
      const id = String(message.id ?? `${role}-${index}`).trim();

      if (!id) {
        return null;
      }

      return {
        id,
        role,
        kind: typeof message.kind === "string" ? message.kind : "message",
        content: typeof message.content === "string" ? message.content : String(message.content ?? ""),
        timestamp,
        issue_id: message.issue_id ?? null,
        issue_title: typeof message.issue_title === "string" ? message.issue_title : String(message.issue_title ?? ""),
        issue_status: typeof message.issue_status === "string" ? message.issue_status : String(message.issue_status ?? ""),
        attachments: normalizeMessageAttachments(message.attachments)
      };
    })
    .filter(Boolean)
    .sort((left, right) => Date.parse(left.timestamp ?? "") - Date.parse(right.timestamp ?? ""))
    .slice(-MAX_CACHED_THREAD_MESSAGES_PER_THREAD);
}

function normalizeCachedThreadDetailEntry(entry, fallbackThreadId = "") {
  const normalizedThread = normalizeThread(entry?.thread);
  const resolvedThreadId = normalizedThread?.id ?? String(fallbackThreadId ?? "").trim();

  if (!resolvedThreadId) {
    return null;
  }

  const normalizedIssues = (entry?.issues ?? [])
    .map((issue) => normalizeIssue(issue, resolvedThreadId))
    .filter(Boolean)
    .sort((left, right) => Date.parse(left.created_at ?? "") - Date.parse(right.created_at ?? ""))
    .slice(-MAX_CACHED_THREAD_ISSUES_PER_THREAD);
  const normalizedMessages = normalizeCachedThreadMessages(entry?.messages ?? []);
  const fetchedAt = Number(entry?.fetchedAt);
  const versionCandidate =
    typeof entry?.version === "string" && entry.version.trim()
      ? entry.version.trim()
      : normalizedThread?.updated_at ?? normalizedThread?.created_at ?? null;

  if (!normalizedThread && normalizedIssues.length === 0 && normalizedMessages.length === 0) {
    return null;
  }

  return {
    loading: false,
    error: "",
    thread: normalizedThread ?? null,
    issues: normalizedIssues,
    messages: normalizedMessages,
    fetchedAt: Number.isFinite(fetchedAt) && fetchedAt > 0 ? fetchedAt : Date.now(),
    version: versionCandidate
  };
}

function trimThreadDetailCacheEntries(entries = {}) {
  return Object.fromEntries(
    Object.entries(entries)
      .map(([threadId, entry]) => [threadId, normalizeCachedThreadDetailEntry(entry, threadId)])
      .filter(([, entry]) => Boolean(entry))
      .sort(([, left], [, right]) => {
        const leftFetchedAt = Number(left?.fetchedAt ?? 0);
        const rightFetchedAt = Number(right?.fetchedAt ?? 0);
        return rightFetchedAt - leftFetchedAt;
      })
      .slice(0, MAX_CACHED_THREAD_DETAILS_PER_SCOPE)
  );
}

function readStoredThreadDetailCache(filters = {}) {
  if (typeof window === "undefined") {
    return {};
  }

  const ownerKey = buildWorkspaceLayoutOwnerKey(filters.loginId, filters.bridgeId);

  if (!ownerKey || ownerKey === "::") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(THREAD_DETAIL_CACHE_STORAGE_KEY);

    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    const scopedEntries = parsed?.scopes?.[ownerKey]?.entries ?? {};
    return trimThreadDetailCacheEntries(scopedEntries);
  } catch {
    return {};
  }
}

function storeThreadDetailCache(entries, filters = {}) {
  if (typeof window === "undefined") {
    return;
  }

  const ownerKey = buildWorkspaceLayoutOwnerKey(filters.loginId, filters.bridgeId);

  if (!ownerKey || ownerKey === "::") {
    return;
  }

  try {
    const raw = window.localStorage.getItem(THREAD_DETAIL_CACHE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : createDefaultThreadDetailCacheStore();
    const nextStore = {
      ...createDefaultThreadDetailCacheStore(),
      ...(parsed && typeof parsed === "object" ? parsed : {}),
      scopes: {
        ...(parsed?.scopes ?? {})
      }
    };
    const trimmedEntries = trimThreadDetailCacheEntries(entries);

    if (Object.keys(trimmedEntries).length === 0) {
      delete nextStore.scopes[ownerKey];
    } else {
      nextStore.scopes[ownerKey] = {
        updatedAt: new Date().toISOString(),
        entries: trimmedEntries
      };
    }

    window.localStorage.setItem(THREAD_DETAIL_CACHE_STORAGE_KEY, JSON.stringify(nextStore));
  } catch {
    // ignore storage failures
  }
}

function shouldPreloadThreadDetail(entry, thread, options = {}) {
  if (!thread?.id) {
    return false;
  }

  if (entry?.loading) {
    return false;
  }

  if (options.force === true) {
    return true;
  }

  const cachedMessageCount = Array.isArray(entry?.messages) ? entry.messages.length : 0;
  const threadVersion = String(thread?.updated_at ?? thread?.created_at ?? "").trim();
  const entryVersion = String(entry?.version ?? entry?.thread?.updated_at ?? entry?.thread?.created_at ?? "").trim();

  if (!entry) {
    return true;
  }

  if (cachedMessageCount === 0) {
    return true;
  }

  if (!threadVersion) {
    return false;
  }

  return entryVersion !== threadVersion;
}

function pickBackgroundThreadPreloadIds(threads = [], preferredThreadIds = [], limit = BACKGROUND_THREAD_PRELOAD_COUNT) {
  const ordered = [];
  const seen = new Set();

  const append = (threadId) => {
    const normalizedThreadId = String(threadId ?? "").trim();

    if (!normalizedThreadId || seen.has(normalizedThreadId)) {
      return;
    }

    seen.add(normalizedThreadId);
    ordered.push(normalizedThreadId);
  };

  preferredThreadIds.forEach(append);
  [...threads]
    .sort((left, right) => Date.parse(right?.updated_at ?? "") - Date.parse(left?.updated_at ?? ""))
    .forEach((thread) => append(thread?.id));

  return ordered.slice(0, Math.max(0, limit));
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

function getBridgeThreadCount(bridge) {
  const rawCount = bridge?.runtime?.counts?.threads;
  const count = Number(rawCount);
  return Number.isFinite(count) ? count : 0;
}

function pickDefaultBridgeId(bridges) {
  if (!Array.isArray(bridges) || bridges.length === 0) {
    return "";
  }

  const bridgeWithThreads = bridges.find((bridge) => getBridgeThreadCount(bridge) > 0);
  return bridgeWithThreads?.bridge_id ?? bridges[0]?.bridge_id ?? "";
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

function isRetryableIssueStatus(status) {
  return String(status ?? "").trim() === "failed";
}

function createId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `mobile-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isImageAttachmentMimeType(mimeType = "") {
  return String(mimeType ?? "")
    .trim()
    .toLowerCase()
    .startsWith("image/");
}

function getMessageAttachmentFileName(value = "") {
  return String(value ?? "").trim().toLowerCase();
}

function getMessageAttachmentFileExtension(fileName = "") {
  const normalized = getMessageAttachmentFileName(fileName);

  if (!normalized) {
    return "";
  }

  if (MESSAGE_ATTACHMENT_SPECIAL_FILE_NAME_SET.has(normalized)) {
    return normalized;
  }

  if (normalized.startsWith(".") && normalized.indexOf(".", 1) < 0) {
    return normalized;
  }

  const extensionIndex = normalized.lastIndexOf(".");

  if (extensionIndex <= 0 || extensionIndex === normalized.length - 1) {
    return "";
  }

  return normalized.slice(extensionIndex + 1);
}

function isSupportedMessageAttachmentFile(file) {
  const fileName = getMessageAttachmentFileName(file?.name);
  const extension = getMessageAttachmentFileExtension(fileName);

  if (!fileName) {
    return false;
  }

  if (MESSAGE_ATTACHMENT_SPECIAL_FILE_NAME_SET.has(fileName)) {
    return true;
  }

  if (!extension) {
    return false;
  }

  return MESSAGE_ATTACHMENT_SUPPORTED_EXTENSION_SET.has(extension);
}

function shouldInlineTextAttachment(file) {
  const mimeType = String(file?.type ?? "")
    .trim()
    .toLowerCase();
  const fileName = String(file?.name ?? "").trim();
  const extension = getMessageAttachmentFileExtension(fileName);

  return (
    mimeType.startsWith("text/") ||
    mimeType.includes("json") ||
    mimeType.includes("xml") ||
    MESSAGE_ATTACHMENT_SPECIAL_FILE_NAME_SET.has(getMessageAttachmentFileName(fileName)) ||
    MESSAGE_ATTACHMENT_TEXT_EXTENSIONS.includes(extension) ||
    TEXT_ATTACHMENT_FILE_PATTERN.test(fileName)
  );
}

function truncateAttachmentTextContent(text) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");

  if (normalized.length <= MAX_MESSAGE_ATTACHMENT_TEXT_CHARS) {
    return {
      text: normalized,
      truncated: false
    };
  }

  return {
    text: normalized.slice(0, MAX_MESSAGE_ATTACHMENT_TEXT_CHARS),
    truncated: true
  };
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("파일을 읽지 못했습니다."));
    reader.readAsDataURL(file);
  });
}

async function createImageThumbnailDataUrl(file) {
  const sourceUrl = await fileToDataUrl(file);

  if (typeof document === "undefined") {
    return sourceUrl;
  }

  const image = await new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("이미지 미리보기를 생성하지 못했습니다."));
    element.src = sourceUrl;
  });
  const maxEdge = 240;
  const width = Number(image.width) || maxEdge;
  const height = Number(image.height) || maxEdge;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");

  if (!context) {
    return sourceUrl;
  }

  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/webp", 0.82);
}

function normalizeMessageAttachment(attachment) {
  if (!attachment) {
    return null;
  }

  const name = String(attachment.name ?? "").trim();

  if (!name) {
    return null;
  }

  const mimeType = String(attachment.mime_type ?? attachment.mimeType ?? "").trim();
  const textContent = attachment.text_content == null ? null : String(attachment.text_content);
  const uploadId =
    attachment.upload_id == null && attachment.uploadId == null
      ? null
      : String(attachment.upload_id ?? attachment.uploadId).trim() || null;
  const downloadUrl =
    attachment.download_url == null && attachment.downloadUrl == null
      ? null
      : String(attachment.download_url ?? attachment.downloadUrl).trim() || null;
  const cleanupUrl =
    attachment.cleanup_url == null && attachment.cleanupUrl == null
      ? null
      : String(attachment.cleanup_url ?? attachment.cleanupUrl).trim() || null;
  const uploadedAt =
    attachment.uploaded_at == null && attachment.uploadedAt == null
      ? null
      : String(attachment.uploaded_at ?? attachment.uploadedAt).trim() || null;
  const kind = attachment.kind === "image" || isImageAttachmentMimeType(mimeType) ? "image" : "file";
  const previewUrl =
    attachment.preview_url == null && attachment.previewUrl == null
      ? kind === "image"
        ? downloadUrl
        : null
      : String(attachment.preview_url ?? attachment.previewUrl).trim() || (kind === "image" ? downloadUrl : null);

  return {
    id: String(attachment.id ?? createId()).trim() || createId(),
    name,
    kind,
    mime_type: mimeType || null,
    size_bytes: Number.isFinite(Number(attachment.size_bytes ?? attachment.sizeBytes))
      ? Number(attachment.size_bytes ?? attachment.sizeBytes)
      : 0,
    preview_url: previewUrl || null,
    text_content: textContent && textContent.length > 0 ? textContent : null,
    text_truncated: Boolean(attachment.text_truncated ?? attachment.textTruncated),
    upload_id: uploadId,
    download_url: downloadUrl,
    cleanup_url: cleanupUrl,
    uploaded_at: uploadedAt
  };
}

function normalizeMessageAttachments(attachments) {
  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments.map((attachment) => normalizeMessageAttachment(attachment)).filter(Boolean);
}

async function uploadMessageAttachmentFile(file, bridgeId = "") {
  const formData = new FormData();
  formData.set("file", file);
  const query = bridgeId ? `?bridge_id=${encodeURIComponent(bridgeId)}` : "";
  const response = await apiRequest(`/api/attachments${query}`, {
    method: "POST",
    body: formData
  });

  return normalizeMessageAttachment(response?.attachment) ?? {};
}

async function cleanupMessageAttachmentUpload(attachment) {
  const cleanupUrl = String(attachment?.cleanup_url ?? attachment?.cleanupUrl ?? "").trim();

  if (!cleanupUrl) {
    return;
  }

  try {
    await fetch(cleanupUrl, {
      method: "DELETE",
      keepalive: true
    });
  } catch {
    // ignore cleanup failures
  }
}

async function cleanupMessageAttachmentUploads(attachments) {
  const normalizedAttachments = normalizeMessageAttachments(attachments);

  await Promise.allSettled(
    normalizedAttachments
      .filter((attachment) => attachment.cleanup_url)
      .map((attachment) => cleanupMessageAttachmentUpload(attachment))
  );
}

async function createMessageAttachmentFromFile(file, bridgeId = "") {
  const mimeType = String(file?.type ?? "").trim();
  const attachment = {
    id: createId(),
    name: String(file?.name ?? "").trim() || "attachment",
    kind: isImageAttachmentMimeType(mimeType) ? "image" : "file",
    mime_type: mimeType || null,
    size_bytes: Number(file?.size ?? 0) || 0,
    preview_url: null,
    text_content: null,
    text_truncated: false
  };
  const shouldInlineText = shouldInlineTextAttachment(file);

  if (attachment.kind === "image") {
    const uploaded = await uploadMessageAttachmentFile(file, bridgeId);
    attachment.preview_url = await createImageThumbnailDataUrl(file);
    attachment.upload_id = uploaded.upload_id ?? null;
    attachment.download_url = uploaded.download_url ?? null;
    attachment.cleanup_url = uploaded.cleanup_url ?? null;
    attachment.uploaded_at = uploaded.uploaded_at ?? null;
    attachment.size_bytes = Number(uploaded.size_bytes ?? attachment.size_bytes) || attachment.size_bytes;
    return attachment;
  }

  if (shouldInlineText) {
    const { text, truncated } = truncateAttachmentTextContent(await file.text());
    attachment.text_content = text;
    attachment.text_truncated = truncated;

    if (!truncated) {
      return attachment;
    }
  }

  const uploaded = await uploadMessageAttachmentFile(file, bridgeId);
  attachment.upload_id = uploaded.upload_id ?? null;
  attachment.download_url = uploaded.download_url ?? null;
  attachment.cleanup_url = uploaded.cleanup_url ?? null;
  attachment.uploaded_at = uploaded.uploaded_at ?? null;
  attachment.size_bytes = Number(uploaded.size_bytes ?? attachment.size_bytes) || attachment.size_bytes;
  return attachment;
}

async function appendMessageAttachments(currentAttachments, files, bridgeId = "") {
  const attachments = [...normalizeMessageAttachments(currentAttachments)];
  const dedupeKeys = new Set(
    attachments.map((attachment) => `${attachment.name}:${attachment.size_bytes}:${attachment.mime_type ?? ""}`)
  );
  let rejectedCount = 0;

  for (const file of files) {
    if (attachments.length >= MAX_MESSAGE_ATTACHMENTS) {
      rejectedCount += 1;
      continue;
    }

    if (!isSupportedMessageAttachmentFile(file)) {
      rejectedCount += 1;
      continue;
    }

    if ((Number(file?.size ?? 0) || 0) > MAX_MESSAGE_ATTACHMENT_BYTES) {
      rejectedCount += 1;
      continue;
    }

    const dedupeKey = `${String(file?.name ?? "").trim()}:${Number(file?.size ?? 0) || 0}:${String(file?.type ?? "").trim()}`;

    if (dedupeKeys.has(dedupeKey)) {
      continue;
    }

    try {
      const attachment = await createMessageAttachmentFromFile(file, bridgeId);
      attachments.push(attachment);
      dedupeKeys.add(dedupeKey);
    } catch {
      rejectedCount += 1;
    }
  }

  return {
    attachments,
    rejectedCount
  };
}

function formatMessageAttachmentSize(sizeBytes) {
  const size = Math.max(0, Number(sizeBytes) || 0);

  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function resolveMessageAttachmentBadge(fileName = "", mimeType = "") {
  const extension = getMessageAttachmentFileExtension(fileName);
  const label = (() => {
    if (extension === ".gitignore") {
      return "GIT";
    }

    if (extension === "dockerfile") {
      return "DKR";
    }

    if (!extension) {
      return "FILE";
    }

    return extension.replace(/^\./, "").slice(0, 4).toUpperCase();
  })();

  if (isImageAttachmentMimeType(mimeType) || MESSAGE_ATTACHMENT_IMAGE_EXTENSIONS.includes(extension)) {
    return {
      label,
      className: "border-fuchsia-400/40 bg-fuchsia-500/15 text-fuchsia-100"
    };
  }

  return {
    label,
    className: "border-slate-400/30 bg-white/10 text-white/90"
  };
}

function getViewportOrientation(width, height) {
  return width > height ? "landscape" : "portrait";
}

function isTextInputElement(element) {
  if (!element || typeof element !== "object") {
    return false;
  }

  const tagName = String(element.tagName ?? "").toLowerCase();

  if (tagName === "textarea" || tagName === "select") {
    return true;
  }

  if (tagName === "input") {
    const type = String(element.type ?? "text").toLowerCase();

    return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(type);
  }

  return Boolean(element.isContentEditable);
}

function readStoredViewportMetrics() {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(VIEWPORT_METRICS_STORAGE_KEY);

    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function storeViewportMetrics(metrics) {
  if (
    typeof window === "undefined" ||
    !metrics ||
    !Number.isFinite(metrics.width) ||
    metrics.width <= 0 ||
    !Number.isFinite(metrics.height) ||
    metrics.height <= 0
  ) {
    return;
  }

  try {
    const current = readStoredViewportMetrics();
    const orientation = getViewportOrientation(metrics.width, metrics.height);
    window.localStorage.setItem(
      VIEWPORT_METRICS_STORAGE_KEY,
      JSON.stringify({
        ...current,
        [orientation]: {
          width: Math.round(metrics.width),
          height: Math.round(metrics.height)
        }
      })
    );
  } catch {
    // ignore storage failures
  }
}

function getStableViewportMetrics() {
  if (typeof window === "undefined") {
    return {
      width: 0,
      height: 0
    };
  }

  const viewport = window.visualViewport;
  const layoutWidth = Math.max(0, Math.round(window.innerWidth || viewport?.width || 0));
  const layoutHeight = Math.max(0, Math.round(window.innerHeight || viewport?.height || 0));
  const visualWidth = Math.max(0, Math.round(viewport?.width || layoutWidth));
  const visualHeight = Math.max(0, Math.round(viewport?.height || layoutHeight));
  const inputFocused = isTextInputElement(document?.activeElement);
  const width = inputFocused ? Math.min(layoutWidth, visualWidth || layoutWidth) : Math.max(layoutWidth, visualWidth);
  const height = inputFocused ? Math.min(layoutHeight, visualHeight || layoutHeight) : Math.max(layoutHeight, visualHeight);

  return {
    width,
    height
  };
}

function readBootstrappedStableViewportWidth() {
  if (typeof document === "undefined") {
    return 0;
  }

  const inlineWidth = Number.parseFloat(
    document.documentElement.style.getPropertyValue("--app-stable-viewport-width")
  );

  if (Number.isFinite(inlineWidth) && inlineWidth > 0) {
    return Math.max(0, Math.round(inlineWidth));
  }

  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") {
    return 0;
  }

  const computedWidth = Number.parseFloat(
    window.getComputedStyle(document.documentElement).getPropertyValue("--app-stable-viewport-width")
  );

  return Number.isFinite(computedWidth) && computedWidth > 0 ? Math.max(0, Math.round(computedWidth)) : 0;
}

function getVisualViewportWidth() {
  if (typeof window === "undefined") {
    return 0;
  }

  const viewport = window.visualViewport;
  const layoutWidth = Math.max(0, Math.round(window.innerWidth || 0));
  const visualWidth = Math.max(0, Math.round(viewport?.width || 0));
  const bootstrappedWidth = readBootstrappedStableViewportWidth();

  return Math.max(layoutWidth, visualWidth, bootstrappedWidth);
}
function getInitialStableViewportMetrics() {
  const liveMetrics = getStableViewportMetrics();
  const storedMetrics = readStoredViewportMetrics();
  const orientation = getViewportOrientation(liveMetrics.width, liveMetrics.height);
  const cachedMetrics = storedMetrics?.[orientation];
  const reusableCachedHeight =
    cachedMetrics &&
    Number.isFinite(Number(cachedMetrics.width)) &&
    Number.isFinite(Number(cachedMetrics.height)) &&
    Number(cachedMetrics.width) > 0 &&
    Number(cachedMetrics.height) > 0 &&
    Math.abs(Number(cachedMetrics.width) - liveMetrics.width) <= VIEWPORT_STORAGE_REUSE_TOLERANCE_PX
      ? Number(cachedMetrics.height)
      : 0;

  return {
    width: liveMetrics.width,
    height: reusableCachedHeight > 0 ? Math.max(liveMetrics.height, reusableCachedHeight) : liveMetrics.height
  };
}

function applyViewportMetricsToDocument(metrics) {
  if (typeof document === "undefined" || !metrics) {
    return;
  }

  const rootStyle = document.documentElement.style;
  rootStyle.setProperty("--app-stable-viewport-width", `${Math.max(0, Math.round(metrics.width || 0))}px`);
  rootStyle.setProperty("--app-stable-viewport-height", `${Math.max(0, Math.round(metrics.height || 0))}px`);
}

function useStableViewportMetrics() {
  const [viewportMetrics, setViewportMetrics] = useState(() => getInitialStableViewportMetrics());

  useLayoutEffect(() => {
    applyViewportMetricsToDocument(viewportMetrics);
  }, [viewportMetrics]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const viewport = window.visualViewport;
    const syncViewportMetrics = () => {
      setViewportMetrics((current) => {
        const next = getStableViewportMetrics();

        if (current.width === next.width && current.height === next.height) {
          return current;
        }

        return next;
      });
    };

    syncViewportMetrics();

    if (!viewport) {
      window.addEventListener("resize", syncViewportMetrics);
      window.addEventListener("orientationchange", syncViewportMetrics);
      return () => {
        window.removeEventListener("resize", syncViewportMetrics);
        window.removeEventListener("orientationchange", syncViewportMetrics);
      };
    }

    viewport.addEventListener("resize", syncViewportMetrics);
    window.addEventListener("resize", syncViewportMetrics);
    window.addEventListener("orientationchange", syncViewportMetrics);

    return () => {
      viewport.removeEventListener("resize", syncViewportMetrics);
      window.removeEventListener("resize", syncViewportMetrics);
      window.removeEventListener("orientationchange", syncViewportMetrics);
    };
  }, []);

  useEffect(() => {
    storeViewportMetrics(viewportMetrics);
  }, [viewportMetrics]);

  return viewportMetrics;
}

function useVisualViewportWidth() {
  const [viewportWidth, setViewportWidth] = useState(() => getVisualViewportWidth());

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const viewport = window.visualViewport;
    const syncViewportWidth = () => {
      setViewportWidth(getVisualViewportWidth());
    };

    syncViewportWidth();

    if (!viewport) {
      window.addEventListener("resize", syncViewportWidth);
      return () => {
        window.removeEventListener("resize", syncViewportWidth);
      };
    }

    viewport.addEventListener("resize", syncViewportWidth);
    viewport.addEventListener("scroll", syncViewportWidth);
    window.addEventListener("resize", syncViewportWidth);

    return () => {
      viewport.removeEventListener("resize", syncViewportWidth);
      viewport.removeEventListener("scroll", syncViewportWidth);
      window.removeEventListener("resize", syncViewportWidth);
    };
  }, []);

  return viewportWidth;
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

function getThreadDeveloperInstructionSaveErrorMessage(error) {
  if (error?.code === "unsupported_bridge_feature" && error?.feature === "thread_developer_instructions") {
    const revision = String(error?.bridgeRevision ?? "").trim();
    return revision
      ? `연결된 브리지(${revision})가 채팅창 개발지침 저장을 지원하지 않습니다. 브리지를 최신 버전으로 업데이트한 뒤 다시 시도해 주세요.`
      : "연결된 브리지가 채팅창 개발지침 저장을 지원하지 않습니다. 브리지를 최신 버전으로 업데이트한 뒤 다시 시도해 주세요.";
  }

  return String(error?.message ?? "저장 중 오류가 발생했습니다.");
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

function formatRequestTimeoutMs(timeoutMs) {
  const normalizedTimeoutMs = Number(timeoutMs);

  if (!Number.isFinite(normalizedTimeoutMs) || normalizedTimeoutMs <= 0) {
    return "지정된 시간";
  }

  return `${Math.max(1, Math.round(normalizedTimeoutMs / 1000))}초`;
}

function createRequestSignalWithTimeout(existingSignal, timeoutMs) {
  const normalizedTimeoutMs = Number(timeoutMs);

  if (!Number.isFinite(normalizedTimeoutMs) || normalizedTimeoutMs <= 0 || typeof AbortController === "undefined") {
    return { signal: existingSignal, cleanup: () => {} };
  }

  const timeoutController = new AbortController();
  const timeoutId = window.setTimeout(() => {
    timeoutController.abort(new DOMException(`request_timeout:${normalizedTimeoutMs}`, "AbortError"));
  }, normalizedTimeoutMs);
  const cleanupListeners = [];

  const cleanup = () => {
    window.clearTimeout(timeoutId);
    for (const dispose of cleanupListeners) {
      dispose();
    }
  };

  if (!existingSignal) {
    return {
      signal: timeoutController.signal,
      cleanup
    };
  }

  if (existingSignal.aborted) {
    timeoutController.abort(existingSignal.reason);
    return {
      signal: timeoutController.signal,
      cleanup
    };
  }

  const forwardAbort = () => {
    timeoutController.abort(existingSignal.reason);
  };

  existingSignal.addEventListener("abort", forwardAbort, { once: true });
  cleanupListeners.push(() => existingSignal.removeEventListener("abort", forwardAbort));

  return {
    signal: timeoutController.signal,
    cleanup
  };
}

async function apiRequest(path, options = {}) {
  const method = String(options.method ?? "GET").toUpperCase();
  const bridgeId = extractBridgeIdFromPath(path);
  const {
    timeoutMs = API_REQUEST_TIMEOUT_MS,
    signal: externalSignal,
    ...fetchOptions
  } = options;
  const requestUrl = `${API_BASE_URL}${path}`;
  const { signal, cleanup } = createRequestSignalWithTimeout(externalSignal, timeoutMs);
  const isFormDataBody = typeof FormData !== "undefined" && fetchOptions.body instanceof FormData;
  let response;

  try {
    response = await fetch(requestUrl, {
      ...fetchOptions,
      signal,
      cache: fetchOptions.cache ?? "no-store",
      headers: {
        Accept: "application/json",
        ...(!isFormDataBody && fetchOptions.body ? { "Content-Type": "application/json" } : {}),
        ...(fetchOptions.headers ?? {})
      }
    });
  } catch (error) {
    if (bridgeId && shouldInferBridgeTransportFailure(path, method)) {
      notifyBridgeRequestFailure({
        path,
        method,
        bridgeId,
        status: null,
        message: String(error?.message ?? error ?? "unknown error")
      });
    }
    const message = formatApiRequestError(path, { ...fetchOptions, timeoutMs }, error);
    const detail =
      error?.name === "AbortError"
        ? `${message}\n설명: ${formatRequestTimeoutMs(timeoutMs)} 동안 응답이 없어 요청을 중단했습니다.`
        : message;
    throw new Error(detail);
  } finally {
    cleanup();
  }

  const text = await response.text();
  const payload = parseResponseBody(response, text);

  if (!response.ok) {
    const message =
      payload?.error ??
      payload?.message ??
      payload?.title ??
      `요청에 실패했습니다. (${response.status})`;
    if (bridgeId && shouldInferBridgeTransportFailure(path, method) && BRIDGE_TRANSPORT_ERROR_STATUS_CODES.has(response.status)) {
      notifyBridgeRequestFailure({
        path,
        method,
        bridgeId,
        status: response.status,
        message
      });
    } else if (bridgeId) {
      notifyBridgeRequestSuccess({
        path,
        method,
        bridgeId,
        status: response.status
      });
    }
    const requestError = new Error(message);
    requestError.status = response.status;
    requestError.code = payload?.code ?? null;
    requestError.feature = payload?.feature ?? null;
    requestError.bridgeRevision = payload?.bridge_revision ?? null;
    requestError.payload = payload;
    throw requestError;
  }

  if (bridgeId) {
    notifyBridgeRequestSuccess({
      path,
      method,
      bridgeId,
      status: response.status
    });
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
    developer_instructions: thread.developer_instructions ?? "",
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
    attachments: normalizeMessageAttachments(issue.attachments),
    queue_position: Number.isFinite(Number(issue.queue_position)) ? Number(issue.queue_position) : null,
    prep_position: Number.isFinite(Number(issue.prep_position)) ? Number(issue.prep_position) : null,
    source_app_id: issue.source_app_id ?? null,
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

function buildOptimisticInterruptedIssue(issue, reason = "manual_interrupt") {
  if (!issue?.id) {
    return null;
  }

  const fallbackMessage =
    reason === "drag_to_prep"
      ? "Preparation으로 이동하면서 이슈를 중단했습니다."
      : "수동으로 이슈를 중단했습니다.";

  return normalizeIssue(
    {
      ...issue,
      status: reason === "drag_to_prep" ? "staged" : "interrupted",
      progress: 0,
      queue_position: null,
      prep_position: reason === "drag_to_prep" ? issue.prep_position ?? 0 : null,
      last_event: "issue.interrupted",
      last_message: String(issue.last_message ?? "").trim() || fallbackMessage,
      updated_at: new Date().toISOString()
    },
    issue.thread_id ?? null
  );
}

function buildOptimisticInterruptedThread(thread, reason = "manual_interrupt") {
  if (!thread?.id) {
    return null;
  }

  const fallbackMessage =
    reason === "drag_to_prep"
      ? "Preparation으로 이동하면서 현재 실행을 중단했습니다."
      : "수동으로 현재 실행을 중단했습니다.";

  return normalizeThread(
    {
      ...thread,
      status: "interrupted",
      progress: 0,
      turn_id: null,
      active_physical_thread_id: null,
      last_event: "thread.status.changed",
      last_message: String(thread.last_message ?? "").trim() || fallbackMessage,
      updated_at: new Date().toISOString()
    },
    thread.project_id ?? null
  );
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
    timestamp: message.timestamp ?? fallbackTimestamp ?? new Date().toISOString(),
    attachments: normalizeMessageAttachments(message.attachments)
  }));

  return [...preservedMessages, ...normalizedMessages].sort(
    (left, right) => Date.parse(left.timestamp ?? "") - Date.parse(right.timestamp ?? "")
  );
}

function collectLoadedIssueIdsFromMessages(messages = []) {
  const ordered = [];
  const seen = new Set();

  (messages ?? []).forEach((message) => {
    const issueId = String(message?.issue_id ?? "").trim();

    if (!issueId || seen.has(issueId)) {
      return;
    }

    seen.add(issueId);
    ordered.push(issueId);
  });

  return ordered;
}

function normalizeIssueIdList(issueIds = [], issues = []) {
  const validIssueIds = new Set(
    (issues ?? [])
      .map((issue) => String(issue?.id ?? "").trim())
      .filter(Boolean)
  );
  const ordered = [];
  const seen = new Set();

  (issueIds ?? []).forEach((issueId) => {
    const normalizedIssueId = String(issueId ?? "").trim();

    if (
      !normalizedIssueId ||
      seen.has(normalizedIssueId) ||
      (validIssueIds.size > 0 && !validIssueIds.has(normalizedIssueId))
    ) {
      return;
    }

    seen.add(normalizedIssueId);
    ordered.push(normalizedIssueId);
  });

  return ordered;
}

function replaceIssueInList(issues = [], nextIssue = null, fallbackThreadId = null) {
  const normalizedNextIssue = normalizeIssue(nextIssue, fallbackThreadId);

  if (!normalizedNextIssue) {
    return issues;
  }

  const nextIssues = [...issues];
  const nextIndex = nextIssues.findIndex((issue) => issue?.id === normalizedNextIssue.id);

  if (nextIndex >= 0) {
    nextIssues[nextIndex] = normalizedNextIssue;
  } else {
    nextIssues.push(normalizedNextIssue);
  }

  return nextIssues.sort((left, right) => Date.parse(left.created_at ?? "") - Date.parse(right.created_at ?? ""));
}

function getLazyOlderIssueIds(issues = [], loadedIssueIds = [], activePhysicalThreadId = null) {
  const normalizedIssues = (issues ?? [])
    .map((issue) => normalizeIssue(issue))
    .filter(Boolean);

  if (normalizedIssues.length === 0) {
    return [];
  }

  const activeIssueId = findActiveIssueForThread(normalizedIssues, activePhysicalThreadId)?.id ?? "";
  const loadedIssueIdSet = new Set(normalizeIssueIdList(loadedIssueIds, normalizedIssues));

  return [...normalizedIssues]
    .sort((left, right) => Date.parse(right.created_at ?? "") - Date.parse(left.created_at ?? ""))
    .map((issue) => issue.id)
    .filter((issueId) => issueId && issueId !== activeIssueId && !loadedIssueIdSet.has(issueId));
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
  return ["completed", "failed", "interrupted"].includes(status);
}

function isInstantThread(thread) {
  const title = String(thread?.title ?? thread?.name ?? "").trim();
  return title === "인스턴트 채팅";
}

function getThreadSnapshotTimestamp(thread) {
  const timestamp = Date.parse(thread?.updated_at ?? thread?.created_at ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function pickPreferredThreadSnapshot(primaryThread, secondaryThread) {
  const normalizedPrimary = normalizeThread(primaryThread);
  const normalizedSecondary = normalizeThread(secondaryThread);

  if (!normalizedPrimary) {
    return normalizedSecondary;
  }

  if (!normalizedSecondary) {
    return normalizedPrimary;
  }

  const primaryTimestamp = getThreadSnapshotTimestamp(normalizedPrimary);
  const secondaryTimestamp = getThreadSnapshotTimestamp(normalizedSecondary);

  if (primaryTimestamp !== secondaryTimestamp) {
    return primaryTimestamp > secondaryTimestamp ? normalizedPrimary : normalizedSecondary;
  }

  return normalizedPrimary;
}

function isThreadExecutionInProgress(thread) {
  const status = String(thread?.status ?? "").trim();
  const lastEvent = String(thread?.last_event ?? "").trim();

  if (["running", "queued", "awaiting_input"].includes(status)) {
    return true;
  }

  if (status) {
    return false;
  }

  return ["turn.starting", "turn.started", "turn.plan.updated", "turn.diff.updated", "item.agentMessage.delta"].includes(lastEvent);
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
        last_message: normalizeAssistantMessageContent(`${currentThread?.last_message ?? ""}${payload.delta ?? ""}`),
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
      content: normalizeAssistantMessageContent(`${lastMessage.content ?? ""}${payload.delta}`),
      timestamp: new Date().toISOString()
    };
    return next;
  }

  next.push({
    id: `${issueId || "assistant"}-${Date.now()}`,
    role: "assistant",
    kind: "message",
    content: normalizeAssistantMessageContent(String(payload.delta ?? "")),
    timestamp: new Date().toISOString(),
    issue_id: issueId || fallback.issue_id || null,
    issue_title: fallback.issue_title ?? "",
    issue_status: fallback.issue_status ?? "running"
  });
  return next;
}

function mergeThreads(currentThreads, nextThreads) {
  const nextById = new Map();

  for (const thread of nextThreads) {
    const normalized = normalizeThread(thread);

    if (normalized) {
      nextById.set(normalized.id, normalized);
    }
  }

  const mergedThreads = [];
  const seen = new Set();

  for (const thread of currentThreads) {
    const normalized = normalizeThread(thread);

    if (!normalized || seen.has(normalized.id)) {
      continue;
    }

    mergedThreads.push(nextById.get(normalized.id) ?? normalized);
    seen.add(normalized.id);
    nextById.delete(normalized.id);
  }

  for (const thread of nextById.values()) {
    if (seen.has(thread.id)) {
      continue;
    }

    mergedThreads.push(thread);
    seen.add(thread.id);
  }

  return mergedThreads;
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

  return next;
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
    attachments: normalizeMessageAttachments(message.attachments),
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

const FENCED_CODE_BLOCK_PATTERN = /```([^\n`]*)\n?([\s\S]*?)```/g;
const INLINE_CODE_PATTERN = /`([^`\n]+)`/g;
const MARKDOWN_IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)]+)\)/g;
const SHELL_CODE_LANGUAGES = new Set(["sh", "shell", "bash", "zsh", "console", "terminal", "shellscript"]);

function parseRichMessageContent(content) {
  const normalized = String(content ?? "");

  if (!normalized) {
    return [];
  }

  const segments = [];
  let lastIndex = 0;
  FENCED_CODE_BLOCK_PATTERN.lastIndex = 0;

  for (const match of normalized.matchAll(FENCED_CODE_BLOCK_PATTERN)) {
    const [raw, language = "", code = ""] = match;
    const matchIndex = match.index ?? 0;

    if (matchIndex > lastIndex) {
      segments.push({
        type: "text",
        value: normalized.slice(lastIndex, matchIndex)
      });
    }

    segments.push({
      type: "code",
      language: String(language ?? "").trim(),
      value: String(code ?? "").replace(/\n$/, "")
    });
    lastIndex = matchIndex + raw.length;
  }

  if (lastIndex < normalized.length) {
    segments.push({
      type: "text",
      value: normalized.slice(lastIndex)
    });
  }

  return segments;
}

function normalizeAssistantMessageContent(content) {
  const normalized = String(content ?? "");

  if (!normalized) {
    return "";
  }

  const lines = normalized.split("\n");
  const result = [];
  let seenProgressHistoryHeading = false;
  let skippedDuplicateHeading = false;

  for (const line of lines) {
    const trimmed = String(line ?? "").trim();

    if (trimmed === "[진행 내역]") {
      if (seenProgressHistoryHeading) {
        skippedDuplicateHeading = true;
        continue;
      }

      seenProgressHistoryHeading = true;
      skippedDuplicateHeading = false;
      result.push("[진행 내역]");
      continue;
    }

    if (skippedDuplicateHeading && trimmed === "" && String(result.at(-1) ?? "").trim() === "") {
      continue;
    }

    skippedDuplicateHeading = false;
    result.push(line);
  }

  return result.join("\n");
}

function inferCodeBlockLabel(language, content) {
  const normalizedLanguage = String(language ?? "").trim().toLowerCase();

  if (normalizedLanguage) {
    if (SHELL_CODE_LANGUAGES.has(normalizedLanguage)) {
      return "shell";
    }

    return normalizedLanguage;
  }

  const normalizedContent = String(content ?? "").trim();
  const looksLikeShell =
    /(^|\n)\s*[$#>]\s/.test(normalizedContent) ||
    /(^|\n)\s*(pnpm|npm|yarn|bun|git|cd|ls|mkdir|rm|cp|mv|cat|sed|awk|curl|wget|ssh|docker|kubectl)\b/.test(
      normalizedContent
    );

  return looksLikeShell ? "shell" : "code";
}

function renderInlineCodeTokens(text, inlineCodeClassName, keyPrefix) {
  const normalized = String(text ?? "");

  if (!normalized) {
    return null;
  }

  INLINE_CODE_PATTERN.lastIndex = 0;
  const nodes = [];
  let lastIndex = 0;
  let tokenIndex = 0;

  for (const match of normalized.matchAll(INLINE_CODE_PATTERN)) {
    const [raw, codeText = ""] = match;
    const matchIndex = match.index ?? 0;

    if (matchIndex > lastIndex) {
      nodes.push(
        <span key={`${keyPrefix}-text-${tokenIndex}`}>{normalized.slice(lastIndex, matchIndex)}</span>
      );
    }

    nodes.push(
      <code
        key={`${keyPrefix}-code-${tokenIndex}`}
        className={`rounded-lg border px-1.5 py-0.5 font-mono text-[0.92em] ${inlineCodeClassName}`}
      >
        {codeText}
      </code>
    );

    lastIndex = matchIndex + raw.length;
    tokenIndex += 1;
  }

  if (lastIndex < normalized.length) {
    nodes.push(<span key={`${keyPrefix}-tail`}>{normalized.slice(lastIndex)}</span>);
  }

  return nodes.length > 0 ? nodes : normalized;
}

function extractMarkdownImageDestination(rawDestination) {
  const normalized = String(rawDestination ?? "").trim();

  if (!normalized) {
    return "";
  }

  if (normalized.startsWith("<")) {
    const closingIndex = normalized.indexOf(">");

    if (closingIndex > 1) {
      return normalized.slice(1, closingIndex).trim();
    }
  }

  const firstWhitespaceIndex = normalized.search(/\s/);
  return firstWhitespaceIndex >= 0 ? normalized.slice(0, firstWhitespaceIndex).trim() : normalized;
}

function resolveRichMessageImageSource(rawDestination) {
  const destination = extractMarkdownImageDestination(rawDestination);

  if (!destination) {
    return null;
  }

  if (/^(?:blob:|data:image\/)/i.test(destination)) {
    return destination;
  }

  try {
    const baseUrl = typeof window !== "undefined" ? window.location.href : API_BASE_URL;
    const resolved = new URL(destination, baseUrl);

    if (!["http:", "https:"].includes(resolved.protocol)) {
      return null;
    }

    return resolved.toString();
  } catch {
    return null;
  }
}

function parseRichTextInlineTokens(text) {
  const normalized = String(text ?? "");

  if (!normalized) {
    return [];
  }

  const tokens = [];
  let lastIndex = 0;
  MARKDOWN_IMAGE_PATTERN.lastIndex = 0;

  for (const match of normalized.matchAll(MARKDOWN_IMAGE_PATTERN)) {
    const [raw, alt = "", destination = ""] = match;
    const matchIndex = match.index ?? 0;
    const source = resolveRichMessageImageSource(destination);

    if (!source) {
      continue;
    }

    if (matchIndex > lastIndex) {
      tokens.push({
        type: "text",
        value: normalized.slice(lastIndex, matchIndex)
      });
    }

    tokens.push({
      type: "image",
      alt: String(alt ?? "").trim(),
      source
    });
    lastIndex = matchIndex + raw.length;
  }

  if (lastIndex < normalized.length) {
    tokens.push({
      type: "text",
      value: normalized.slice(lastIndex)
    });
  }

  return tokens;
}

function trimRichTextTokenValue(value) {
  return String(value ?? "").replace(/^\n+/, "").replace(/\n+$/, "");
}

function RichMessageContent({ content, tone = "light" }) {
  const normalizedContent = tone === "brand" ? String(content ?? "") : normalizeAssistantMessageContent(content);
  const segments = parseRichMessageContent(normalizedContent);
  const inlineCodeClassName =
    tone === "brand"
      ? "border-slate-950/10 bg-slate-950/10 text-slate-950"
      : tone === "system"
        ? "border-white/10 bg-white/10 text-slate-50"
        : "border-slate-950/10 bg-slate-950/5 text-slate-950";
  const imageCardClassName =
    tone === "brand"
      ? "border-white/15 bg-slate-950/15"
      : tone === "system"
        ? "border-white/10 bg-white/10"
        : "border-slate-900/10 bg-slate-950/5";
  const imageCaptionClassName =
    tone === "brand" || tone === "system" ? "border-white/10" : "border-slate-900/10";

  if (segments.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      {segments.map((segment, index) => {
        if (segment.type === "code") {
          const label = inferCodeBlockLabel(segment.language, segment.value);

          return (
            <div
              key={`code-${index}`}
              className="overflow-hidden rounded-2xl border border-slate-950/60 bg-[#0a0f1a] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
            >
              <div className="flex items-center justify-between gap-3 border-b border-white/5 bg-white/[0.03] px-3 py-2">
                <div className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-rose-400/90" />
                  <span className="h-2.5 w-2.5 rounded-full bg-amber-300/90" />
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/90" />
                </div>
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                  {label}
                </span>
              </div>
              <div
                className="overflow-x-auto px-3 py-3"
                data-message-code-scroll="true"
                onPointerDownCapture={(event) => {
                  event.stopPropagation();
                }}
              >
                <pre className="m-0 w-max min-w-full font-mono text-[13px] leading-6 text-slate-100">
                  <code>{segment.value}</code>
                </pre>
              </div>
            </div>
          );
        }

        if (!String(segment.value ?? "").trim()) {
          return null;
        }

        const inlineTokens = parseRichTextInlineTokens(segment.value);
        const hasInlineImage = inlineTokens.some((token) => token.type === "image");

        if (!hasInlineImage) {
          return (
            <p
              key={`text-${index}`}
              className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm leading-6"
            >
              {renderInlineCodeTokens(segment.value, inlineCodeClassName, `segment-${index}`)}
            </p>
          );
        }

        return (
          <div key={`text-${index}`} className="space-y-3">
            {inlineTokens.map((token, tokenIndex) => {
              if (token.type === "image") {
                const imageAlt = token.alt || "메시지 이미지";

                return (
                  <button
                    key={`image-${index}-${tokenIndex}`}
                    type="button"
                    data-message-attachment-interactive="true"
                    aria-label={`${imageAlt} 이미지 열기`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();

                      if (typeof window === "undefined") {
                        return;
                      }

                      const opened = window.open(token.source, "_blank", "noopener,noreferrer");

                      if (!opened) {
                        window.location.href = token.source;
                      }
                    }}
                    className={`group block w-full overflow-hidden rounded-2xl border text-left ${imageCardClassName}`}
                  >
                    <div className="overflow-hidden bg-black/10">
                      <img
                        src={token.source}
                        alt={imageAlt}
                        className="max-h-[22rem] w-full object-contain bg-black/5 transition duration-200 group-hover:scale-[1.01]"
                        loading="lazy"
                      />
                    </div>
                    {token.alt ? (
                      <p className={`border-t px-3 py-2 text-xs font-medium opacity-80 ${imageCaptionClassName}`}>
                        {token.alt}
                      </p>
                    ) : null}
                  </button>
                );
              }

              const tokenValue = trimRichTextTokenValue(token.value);

              if (!tokenValue.trim()) {
                return null;
              }

              return (
                <p
                  key={`text-${index}-${tokenIndex}`}
                  className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm leading-6"
                >
                  {renderInlineCodeTokens(tokenValue, inlineCodeClassName, `segment-${index}-${tokenIndex}`)}
                </p>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function MessageAttachmentBadge({ attachment, compact = false }) {
  const badge = resolveMessageAttachmentBadge(attachment?.name, attachment?.mime_type);

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
  onOpenAttachment
}) {
  const normalizedAttachments = normalizeMessageAttachments(attachments);

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
                <MessageAttachmentBadge attachment={attachment} compact />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{attachment.name}</p>
                <div className="mt-1 flex items-center gap-1.5 text-[11px] opacity-70">
                  <span>{formatMessageAttachmentSize(attachment.size_bytes)}</span>
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

function AttachmentPreviewDialog({ attachment, onClose }) {
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
              {formatMessageAttachmentSize(attachment.size_bytes)}
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

function AutoSizingReadOnlyTextarea({ id, value, placeholder, className = "", maxHeight = 320 }) {
  const textareaRef = useRef(null);
  const syncHeight = useCallback(() => {
    const textarea = textareaRef.current;

    if (!textarea) {
      return;
    }

    textarea.style.height = "0px";
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [maxHeight]);

  useLayoutEffect(() => {
    syncHeight();
  }, [syncHeight, value]);

  useEffect(() => {
    const textarea = textareaRef.current;

    if (!textarea) {
      return undefined;
    }

    if (typeof window === "undefined" || typeof window.ResizeObserver !== "function") {
      window.addEventListener("resize", syncHeight);
      return () => {
        window.removeEventListener("resize", syncHeight);
      };
    }

    const resizeObserver = new window.ResizeObserver(() => {
      syncHeight();
    });

    resizeObserver.observe(textarea);

    return () => {
      resizeObserver.disconnect();
    };
  }, [syncHeight]);

  return (
    <textarea
      ref={textareaRef}
      id={id}
      rows="1"
      value={value}
      readOnly
      placeholder={placeholder}
      className={className}
    />
  );
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

function BottomSheet({
  open,
  title,
  description,
  onClose,
  children,
  variant = "bottom",
  headerActions = null,
  headerActionsLayout = "inline",
  panelTestId = ""
}) {
  if (!open) {
    return null;
  }

  const isCenterDialog = variant === "center";
  const shouldStackHeaderActions = headerActionsLayout === "stacked" && Boolean(headerActions);
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
      <section
        className={panelClassName}
        onClick={(event) => event.stopPropagation()}
        data-testid={panelTestId || undefined}
      >
        <div className="border-b border-white/10 bg-white/5 px-5 py-4">
          {isCenterDialog ? null : <div className="mx-auto mb-4 h-1.5 w-14 rounded-full bg-white/15" />}
          {shouldStackHeaderActions ? (
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-white">{title}</h2>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-black/20 text-slate-300 transition hover:bg-white/10 hover:text-white"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                  </svg>
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2">{headerActions}</div>
            </div>
          ) : (
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-white">{title}</h2>
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
          )}
        </div>
        <div className="telegram-scroll max-h-[80dvh] overflow-y-auto">{children}</div>
      </section>
    </div>
  );
}

const MobileFeedbackContext = createContext({
  alert: () => {},
  confirm: async () => false
});

function useMobileFeedback() {
  return useContext(MobileFeedbackContext);
}

function MobileNoticeCenter({ notices, onDismiss }) {
  if (typeof document === "undefined" || !Array.isArray(notices) || notices.length === 0) {
    return null;
  }

  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[120] flex flex-col items-center gap-3 px-3 pt-[max(env(safe-area-inset-top),0px)]">
      {notices.map((notice) => {
        const isError = notice.tone === "error";
        const cardClassName = isError
          ? "border-rose-400/35 bg-[rgba(33,12,18,0.92)] text-rose-50 shadow-[0_18px_40px_rgba(127,29,29,0.28)]"
          : "border-white/15 bg-[rgba(15,23,42,0.88)] text-slate-50 shadow-[0_18px_40px_rgba(15,23,42,0.38)]";
        const iconClassName = isError
          ? "bg-rose-400/20 text-rose-100"
          : "bg-sky-400/18 text-sky-100";

        return (
          <div
            key={notice.id}
            className={`pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-[1.15rem] border px-4 py-3 backdrop-blur-xl ${cardClassName}`}
          >
            <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${iconClassName}`}>
              {isError ? (
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path d="M12 9v4m0 4h.01M10.29 3.86l-8.09 14A2 2 0 004 21h16a2 2 0 001.8-3.14l-8.09-14a2 2 0 00-3.42 0z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                </svg>
              ) : (
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path d="M12 8h.01M11 12h1v4h1m-6 4h10a2 2 0 002-2V6a2 2 0 00-2-2H7a2 2 0 00-2 2v12a2 2 0 002 2z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                </svg>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-semibold tracking-[0.04em] text-white/90">
                {notice.title || (isError ? "오류" : "알림")}
              </p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-5 text-white/90">
                {notice.message}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onDismiss(notice.id)}
              aria-label="알림 닫기"
              title="닫기"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/75 transition hover:bg-white/10 hover:text-white"
            >
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>,
    document.body
  );
}

function MobileConfirmDialog({ state, onResolve }) {
  if (!state?.open) {
    return null;
  }

  const isDanger = state.tone === "danger";

  return (
    <BottomSheet
      open={state.open}
      title={state.title || "확인"}
      description={state.message || ""}
      onClose={() => onResolve(false)}
      variant="center"
      panelTestId="mobile-confirm-dialog"
    >
      <div className="space-y-4 px-5 py-5">
        <div
          className={`rounded-[1.25rem] border px-4 py-4 text-sm leading-6 ${
            isDanger
              ? "border-rose-400/20 bg-rose-500/10 text-rose-50"
              : "border-white/10 bg-white/[0.04] text-slate-100"
          }`}
        >
          {state.message}
        </div>
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={() => onResolve(false)}
            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10"
          >
            {state.cancelLabel || "취소"}
          </button>
          <button
            type="button"
            onClick={() => onResolve(true)}
            className={`rounded-full px-4 py-2 text-sm font-semibold text-white transition ${
              isDanger ? "bg-rose-500 hover:bg-rose-400" : "bg-telegram-500 hover:bg-telegram-400"
            }`}
          >
            {state.confirmLabel || "확인"}
          </button>
        </div>
      </div>
    </BottomSheet>
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
  pushNotificationCard,
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

        {pushNotificationCard ? <section className="border-t border-white/10 pt-4">{pushNotificationCard}</section> : null}

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

function BridgeDropdown({
  bridges,
  selectedBridgeId,
  bridgeSignal,
  onSelectBridge,
  onOpen = null,
  syncing = false
}) {
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
        onClick={() => {
          setOpen((current) => {
            const nextOpen = !current;

            if (nextOpen && typeof onOpen === "function") {
              onOpen();
            }

            return nextOpen;
          });
        }}
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
            <p className="mt-0.5 text-[11px] text-slate-400">
              {syncing ? "브릿지 목록을 동기화하는 중입니다." : "연결할 브릿지를 선택하세요."}
            </p>
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
  bridgeId = "",
  selectedProject,
  onSubmit,
  label,
  disabled = false,
  draftKey = "",
  draftValue = undefined,
  onDraftPersist = null,
  onStop = null,
  stopBusy = false,
  stopLabel = "중단",
  onInputFocus = null,
  onInputBlur = null
}) {
  const LONG_PRESS_THRESHOLD_MS = 650;
  const SOFTWARE_KEYBOARD_HEIGHT_THRESHOLD_PX = 160;
  const SOFTWARE_KEYBOARD_HEIGHT_THRESHOLD_RATIO = 0.14;
  const normalizedDraftKey = String(draftKey ?? "").trim();
  const normalizedDraftValue = normalizeComposerDraftValue(draftValue);
  const [internalPrompt, setInternalPrompt] = useState(() => normalizedDraftValue);
  const [attachments, setAttachments] = useState([]);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const speechRecognitionRef = useRef(null);
  const [isRecording, setIsRecording] = useState(false);
  const longPressTimerRef = useRef(null);
  const voiceRestartTimerRef = useRef(null);
  const suppressClickRef = useRef(false);
  const submitInFlightRef = useRef(false);
  const isRecordingRef = useRef(false);
  const isPromptComposingRef = useRef(false);
  const shouldKeepRecordingRef = useRef(false);
  const processedFinalResultKeysRef = useRef(new Set());
  const lastVoiceAppendRef = useRef({ text: "", at: 0 });
  const lastFinalTranscriptRef = useRef("");
  const promptFocusPointerTypeRef = useRef("");
  const viewportBaselineHeightsRef = useRef({
    portrait: 0,
    landscape: 0
  });
  const { alert: showAlert } = useMobileFeedback();
  const supportsSpeechRecognition =
    typeof window !== "undefined" && ("webkitSpeechRecognition" in window || "SpeechRecognition" in window);
  const prompt = internalPrompt;
  const promptRef = useRef(prompt);
  const attachmentsRef = useRef([]);
  const lastHydratedDraftRef = useRef({
    key: normalizedDraftKey,
    value: normalizedDraftValue
  });

  useEffect(() => {
    promptRef.current = prompt;
  }, [prompt]);

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

  useEffect(
    () => () => {
      if (typeof onDraftPersist === "function" && normalizedDraftKey) {
        onDraftPersist(normalizedDraftKey, promptRef.current);
      }

      void cleanupMessageAttachmentUploads(attachmentsRef.current);
    },
    [normalizedDraftKey, onDraftPersist]
  );

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
      setInternalPrompt(event.target.value);
      syncPromptHeight(event.target);
    },
    [syncPromptHeight]
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

      setInternalPrompt((current) => (current ? `${current.trim()} ${transcript}` : transcript));

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

  const toggleVoiceCapture = useCallback(() => {
    if (isRecordingRef.current) {
      stopVoiceCapture();
      return;
    }

    if (!supportsSpeechRecognition) {
      showAlert("이 브라우저에서는 음성 입력을 지원하지 않습니다.", {
        tone: "error",
        title: "음성 입력"
      });
      return;
    }

    startVoiceCapture();
  }, [showAlert, startVoiceCapture, stopVoiceCapture, supportsSpeechRecognition]);

  const handleSendPointerDown = useCallback(
    (event) => {
      if (!selectedProject || busy || disabled || attachmentBusy) {
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
    [attachmentBusy, busy, clearLongPressTimer, disabled, selectedProject, toggleVoiceCapture]
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

      if (busy || disabled || !selectedProject || attachmentBusy) {
        return;
      }

      void handlePromptSubmit();
    },
    [attachmentBusy, busy, disabled, handlePromptSubmit, selectedProject, toggleVoiceCapture]
  );

  const attachmentCount = attachments.length;
  const actionBusy = busy || attachmentBusy;
  const canSubmit = Boolean(selectedProject) && !disabled && !actionBusy && (prompt.trim() || attachmentCount > 0);

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
                          <MessageAttachmentBadge attachment={attachment} compact />
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
              <button
                type="button"
                onPointerDown={handleSendPointerDown}
                onPointerUp={handleSendPointerUp}
                onPointerLeave={handleSendPointerLeave}
                onPointerCancel={handleSendPointerLeave}
                onClick={handleSendClick}
                onContextMenu={(event) => event.preventDefault()}
                disabled={!canSubmit}
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
                ) : actionBusy ? (
                  <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                ) : (
                  <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path d="M20 4L4 12l6 2 2 6 8-16z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                  </svg>
                )}
              </button>
            )}
          </div>
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
  const [developerInstructions, setDeveloperInstructions] = useState("");
  const tapStateRef = useRef({ path: "", timestamp: 0 });

  useEffect(() => {
    if (!open) {
      setName("");
      setDescription("");
      setDeveloperInstructions("");
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
      developerInstructions,
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

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="project-developer-instructions">
            공통 개발지침
          </label>
          <textarea
            id="project-developer-instructions"
            rows="8"
            value={developerInstructions}
            onChange={(event) => setDeveloperInstructions(event.target.value)}
            placeholder="예: 답변 언어, 금지사항, 출력 형식, 코드 수정 원칙 등 이 프로젝트 전체에 공통으로 적용할 개발지침을 입력해 주세요."
            className="w-full rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-400/30"
          />
          <div className="mt-3 rounded-[1rem] border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-[12px] leading-6 text-emerald-50">
            여기 저장한 공통 개발지침은 이 프로젝트의 새 채팅창이 실행될 때 기본 developerInstructions로 자동 적용됩니다.
          </div>
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

function ThreadCreateDialog({ open, busy, project, onClose, onSubmit }) {
  const [title, setTitle] = useState("");
  const [developerInstructions, setDeveloperInstructions] = useState("");
  const projectDeveloperInstructions = String(project?.developer_instructions ?? "");
  const hasProjectDeveloperInstructions = projectDeveloperInstructions.trim().length > 0;

  useEffect(() => {
    if (!open) {
      setTitle("");
      setDeveloperInstructions("");
    }
  }, [open]);

  if (!open || !project) {
    return null;
  }

  return (
    <BottomSheet
      open={open}
      title="새 채팅창 시작"
      onClose={onClose}
      variant="center"
    >
      <form
        className="space-y-5 px-5 py-5"
        onSubmit={async (event) => {
          event.preventDefault();
          const accepted = await onSubmit({
            title,
            developerInstructions
          });

          if (accepted !== false) {
            onClose();
          }
        }}
      >
        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="thread-create-title">
            제목
          </label>
          <input
            id="thread-create-title"
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="비워두면 제목없음으로 생성됩니다."
            className="w-full rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
          />
        </div>

        {hasProjectDeveloperInstructions ? (
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="thread-create-project-developer-instructions">
              프로젝트 공통 개발지침
            </label>
            <AutoSizingReadOnlyTextarea
              id="thread-create-project-developer-instructions"
              value={projectDeveloperInstructions}
              placeholder="저장된 프로젝트 공통 개발지침이 없습니다."
              className="w-full resize-none rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white/90 outline-none"
            />
            <p className="mt-2 text-[11px] leading-5 text-slate-400">
              프로젝트에 저장된 공통 개발지침이며 여기서는 읽기 전용으로만 표시됩니다.
            </p>
          </div>
        ) : null}

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="thread-create-developer-instructions">
            개발지침
          </label>
          <textarea
            id="thread-create-developer-instructions"
            rows="8"
            value={developerInstructions}
            onChange={(event) => setDeveloperInstructions(event.target.value)}
            placeholder="이 채팅창에서만 추가로 적용할 개발지침이 있으면 입력해 주세요."
            className="w-full rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-400/30"
          />
          {hasProjectDeveloperInstructions ? (
            <div className="mt-3 rounded-[1rem] border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-[12px] leading-6 text-emerald-50">
              이 프로젝트의 공통 개발지침이 새 채팅창 기본 지침으로 자동 적용됩니다. 여기 입력한 채팅창 개발지침은 그 뒤에 이어 붙습니다.
            </div>
          ) : (
            <p className="mt-2 text-[11px] leading-5 text-slate-400">
              프로젝트 공통 개발지침이 없으면 이 값만 이 채팅창의 다음 실행부터 적용됩니다.
            </p>
          )}
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
            {busy ? "생성 중..." : "채팅 시작"}
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
      if (event?.currentTarget && typeof event.currentTarget.releasePointerCapture === "function") {
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          // ignore pointer capture release failures
        }
      }
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
    <BottomSheet open={open} title="메모 작업" onClose={onClose} variant="center">
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

function ThreadMessageActionSheet({ open, message, busy, onClose, onCopy, onRetry, onDelete }) {
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
  standalone = true
}) {
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
              <MessageBubble align="right" tone="brand" title="메모" meta={formatRelativeTime(message.updated_at)}>
                <RichMessageContent content={message.content} tone="brand" />
                <MessageAttachmentPreview attachments={message.attachments} bubbleTone="brand" onOpenAttachment={handleOpenAttachment} />
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

      <div className="telegram-safe-bottom-panel shrink-0 border-t border-white/10 bg-slate-950/92 px-4 pt-2 backdrop-blur">
        <div className={`mx-auto w-full ${contentWidthClassName}`}>
          <InlineIssueComposer
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

      <AttachmentPreviewDialog attachment={previewAttachment} onClose={() => setPreviewAttachment(null)} />
    </div>
  );
}

function ProjectActionSheet({ open, project, busy = false, onClose, onEdit, onDelete }) {
  if (!open || !project) {
    return null;
  }

  return (
    <BottomSheet
      open={open}
      title="프로젝트 작업"
      description={`${project.name} 프로젝트를 편집하거나 삭제할 수 있습니다.`}
      onClose={busy ? () => {} : onClose}
      variant="center"
    >
      <div className="space-y-3 px-5 py-5">
        <div className="rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm leading-6 text-slate-200">
          공통 개발지침은 새 채팅창이 실행될 때 기본 지침으로 자동 주입됩니다.
        </div>
        <button
          type="button"
          onClick={onEdit}
          disabled={busy}
          className="w-full rounded-full bg-telegram-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          편집
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="w-full rounded-full bg-rose-500/90 px-4 py-3 text-sm font-semibold text-white transition hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          삭제
        </button>
      </div>
    </BottomSheet>
  );
}

function ProjectEditDialog({ open, busy, deleteBusy = false, project, errorMessage, onClose, onSubmit, onDelete }) {
  const [name, setName] = useState("");
  const [developerInstructions, setDeveloperInstructions] = useState("");
  const [dirty, setDirty] = useState(false);
  const draftProjectIdRef = useRef("");
  const draftProjectId = open && project ? project.id : "";

  useEffect(() => {
    if (!open) {
      setName("");
      setDeveloperInstructions("");
      setDirty(false);
      draftProjectIdRef.current = "";
      return;
    }

    if (!project) {
      return;
    }

    if (draftProjectIdRef.current !== draftProjectId) {
      draftProjectIdRef.current = draftProjectId;
      setName(project?.name ?? "");
      setDeveloperInstructions(project?.developer_instructions ?? "");
      setDirty(false);
      return;
    }

    if (!dirty) {
      setName(project?.name ?? "");
      setDeveloperInstructions(project?.developer_instructions ?? "");
    }
  }, [dirty, draftProjectId, open, project]);

  if (!open || !project) {
    return null;
  }

  const actionBusy = busy || deleteBusy;

  return (
    <BottomSheet
      open={open}
      title="프로젝트 편집"
      description="프로젝트 이름과 공통 개발지침을 수정합니다. 공통 개발지침은 새 채팅창 실행 시 기본 developerInstructions로 들어갑니다."
      onClose={onClose}
      variant="center"
    >
      <form
        className="space-y-5 px-5 py-5"
        onSubmit={async (event) => {
          event.preventDefault();
          await onSubmit({
            name: name.trim(),
            developerInstructions
          });
        }}
      >
        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="project-edit-name">
            프로젝트 이름
          </label>
          <input
            id="project-edit-name"
            type="text"
            value={name}
            disabled={actionBusy}
            onChange={(event) => {
              setName(event.target.value);
              setDirty(true);
            }}
            className="w-full rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="project-edit-developer-instructions">
            공통 개발지침
          </label>
          <textarea
            id="project-edit-developer-instructions"
            rows="10"
            value={developerInstructions}
            disabled={actionBusy}
            onChange={(event) => {
              setDeveloperInstructions(event.target.value);
              setDirty(true);
            }}
            placeholder="예: 코드 스타일, 테스트 기준, 금지사항, 응답 형식 같은 프로젝트 공통 규칙을 입력해 주세요."
            className="w-full rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white outline-none transition focus:border-emerald-300 focus:ring-2 focus:ring-emerald-400/30"
          />
          <p className="mt-2 text-[11px] leading-5 text-slate-400">
            비워 두고 저장하면 공통 개발지침이 제거됩니다.
          </p>
        </div>

        {errorMessage ? (
          <div className="rounded-[1rem] border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-[12px] leading-6 text-rose-100">
            {errorMessage}
          </div>
        ) : null}

        {typeof onDelete === "function" ? (
          <button
            type="button"
            onClick={() => void onDelete(project)}
            disabled={actionBusy}
            className="w-full rounded-full border border-rose-400/40 bg-rose-500/10 px-4 py-2.5 text-sm font-semibold text-rose-100 transition hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {deleteBusy ? "삭제 중..." : "프로젝트 삭제"}
          </button>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={actionBusy}
            className="rounded-full border border-white/10 px-4 py-2.5 text-sm font-medium text-slate-200 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-60"
          >
            취소
          </button>
          <button
            type="submit"
            disabled={actionBusy || !name.trim()}
            className="rounded-full bg-telegram-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "저장 중..." : "저장"}
          </button>
        </div>
      </form>
    </BottomSheet>
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
      description={
        isDeveloperInstruction
          ? `${project.name} 프로젝트에 저장하고 새 thread 시작 시 app-server에 주입합니다.`
          : "공통 일반지침으로 저장하고 모든 프로젝트의 새 thread 시작 시 app-server에 동일하게 주입합니다."
      }
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
                : "예: 작업 방식, 응답 톤, 우선순위 같은 공통 기본 지침을 입력해 주세요."
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

function ThreadEditDialog({
  open,
  busy,
  thread,
  project,
  threadInstructionSupported = false,
  errorMessage,
  onClose,
  onSubmit
}) {
  const [title, setTitle] = useState("");
  const [developerInstructions, setDeveloperInstructions] = useState("");
  const [dirty, setDirty] = useState(false);
  const draftThreadIdRef = useRef("");
  const instructionValue = thread?.developer_instructions ?? "";
  const projectDeveloperInstructions = String(project?.developer_instructions ?? "");
  const hasProjectDeveloperInstructions = projectDeveloperInstructions.trim().length > 0;
  const draftThreadId = open && thread ? thread.id : "";

  useEffect(() => {
    if (!open) {
      setTitle("");
      setDeveloperInstructions("");
      setDirty(false);
      draftThreadIdRef.current = "";
      return;
    }

    if (!thread) {
      return;
    }

    if (draftThreadIdRef.current !== draftThreadId) {
      draftThreadIdRef.current = draftThreadId;
      setTitle(thread?.title ?? "");
      setDeveloperInstructions(instructionValue);
      setDirty(false);
      return;
    }

    if (!dirty) {
      setTitle(thread?.title ?? "");
      setDeveloperInstructions(instructionValue);
    }
  }, [dirty, draftThreadId, instructionValue, open, thread]);

  if (!open || !thread) {
    return null;
  }

  return (
    <BottomSheet
      open={open}
      title="채팅창 편집"
      description={`${thread.title ?? "채팅창"}의 제목을 수정하고, 필요하면 이 채팅창 전용 개발지침도 함께 저장합니다.`}
      onClose={onClose}
      variant="center"
      >
        <form
        className="space-y-5 px-5 py-5"
        onSubmit={async (event) => {
          event.preventDefault();
          await onSubmit({
            title: title.trim(),
            developerInstructions
          });
        }}
      >
        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="thread-edit-title">
            제목
          </label>
          <input
            id="thread-edit-title"
            type="text"
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              setDirty(true);
            }}
            className="w-full rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white outline-none transition focus:border-telegram-300 focus:ring-2 focus:ring-telegram-400/30"
          />
        </div>

        {hasProjectDeveloperInstructions ? (
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="thread-edit-project-developer-instructions">
              프로젝트 공통 개발지침
            </label>
            <AutoSizingReadOnlyTextarea
              id="thread-edit-project-developer-instructions"
              value={projectDeveloperInstructions}
              placeholder="저장된 프로젝트 공통 개발지침이 없습니다."
              className="w-full resize-none rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white/90 outline-none"
            />
            <p className="mt-2 text-[11px] leading-5 text-slate-400">
              프로젝트에 저장된 공통 개발지침이며 여기서는 읽기 전용으로만 표시됩니다.
            </p>
          </div>
        ) : null}

        {threadInstructionSupported ? (
          <>
            <div>
              <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="thread-instruction-input">
                개발지침 본문
              </label>
              <textarea
                id="thread-instruction-input"
                rows="10"
                value={developerInstructions}
                onChange={(event) => {
                  setDeveloperInstructions(event.target.value);
                  setDirty(true);
                }}
                placeholder="예: 이 채팅창에서만 지켜야 할 출력 형식, 금지사항, 역할 제약을 입력해 주세요."
                className="w-full rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-white outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-400/30"
              />
              <p className="mt-2 text-[11px] leading-5 text-slate-400">
                비워 두고 저장하면 이 채팅창 전용 개발지침이 제거됩니다.
              </p>
            </div>
          </>
        ) : (
          <div className="rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-[12px] leading-6 text-slate-300">
            현재 연결된 브리지는 채팅창 전용 개발지침 저장을 지원하지 않아 제목만 수정할 수 있습니다.
          </div>
        )}

        {errorMessage ? (
          <div className="rounded-[1rem] border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-[12px] leading-6 text-rose-100">
            {errorMessage}
          </div>
        ) : null}

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

function ThreadListItem({
  thread,
  active,
  selected = false,
  selectionMode = false,
  signalNow,
  registerNode,
  reorderActive = false,
  reorderOffsetY = 0,
  transitionLocked = false,
  onStartReorder,
  onMoveReorder,
  onEndReorder,
  onCancelReorder,
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
  const latestPointerPointRef = useRef(null);
  const longPressTimerRef = useRef(null);
  const longPressTriggeredRef = useRef(false);
  const longPressReadyRef = useRef(false);
  const reorderRequestedRef = useRef(false);
  const ACTION_WIDTH = 92;
  const SNAP_THRESHOLD = 42;
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
    latestPointerPointRef.current = { x: event.clientX, y: event.clientY };
    baseOffsetRef.current = offsetRef.current;
    pointerIdRef.current = event.pointerId;
    swipeAxisRef.current = null;
    movedRef.current = false;
    longPressTriggeredRef.current = false;
    longPressReadyRef.current = false;
    reorderRequestedRef.current = false;
    setDragging(false);
    event.currentTarget.setPointerCapture?.(event.pointerId);

    clearPendingLongPress();

    if (
      event.pointerType === "touch" ||
      event.pointerType === "pen" ||
      (event.pointerType === "mouse" && event.button === 0)
    ) {
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTimerRef.current = null;
        longPressTriggeredRef.current = true;
        longPressReadyRef.current = true;
        reorderRequestedRef.current = false;
        setRevealOffset(0);
      }, THREAD_LIST_ITEM_LONG_PRESS_MS);
    }
  }, [clearPendingLongPress, setRevealOffset]);

  const handlePointerMove = useCallback(
    (event) => {
      if (reorderActive) {
        if (event.cancelable) {
          event.preventDefault();
        }

        onMoveReorder?.({
          threadId: thread.id,
          pointerId: event.pointerId,
          clientY: event.clientY
        });
        return;
      }

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
      latestPointerPointRef.current = { x: event.clientX, y: event.clientY };

      if (longPressReadyRef.current) {
        if (!reorderRequestedRef.current && absY > THREAD_LIST_ITEM_REORDER_MOVE_TOLERANCE_PX) {
          reorderRequestedRef.current = true;
          onStartReorder?.({
            thread,
            pointerId: event.pointerId,
            clientY: startPointRef.current?.y ?? event.clientY
          });
          onMoveReorder?.({
            threadId: thread.id,
            pointerId: event.pointerId,
            clientY: event.clientY
          });
        }

        if (event.cancelable) {
          event.preventDefault();
        }

        return;
      }

      if (Math.hypot(deltaX, deltaY) > THREAD_LIST_ITEM_LONG_PRESS_CANCEL_TOLERANCE_PX) {
        clearPendingLongPress();
      }

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
    [clearPendingLongPress, onMoveReorder, onStartReorder, reorderActive, setRevealOffset, thread]
  );

  const handlePointerUp = useCallback((event) => {
    if (reorderActive) {
      clearPendingLongPress();
      startPointRef.current = null;
      baseOffsetRef.current = 0;
      pointerIdRef.current = null;
      swipeAxisRef.current = null;
      latestPointerPointRef.current = null;
      setDragging(false);
      onEndReorder?.({
        threadId: thread.id,
        pointerId: event.pointerId
      });
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      return;
    }

    if (startPointRef.current === null) {
      return;
    }

    const longPressReady = longPressReadyRef.current;
    const reorderRequested = reorderRequestedRef.current;

    clearPendingLongPress();

    if (longPressReady) {
      startPointRef.current = null;
      baseOffsetRef.current = 0;
      pointerIdRef.current = null;
      swipeAxisRef.current = null;
      latestPointerPointRef.current = null;
      longPressReadyRef.current = false;
      reorderRequestedRef.current = false;
      movedRef.current = false;
      setDragging(false);
      setRevealOffset(0);
      event.currentTarget.releasePointerCapture?.(event.pointerId);

      if (!reorderRequested) {
        if (event.cancelable) {
          event.preventDefault();
        }

        onEnterSelectionMode?.(thread.id);
      }

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
    latestPointerPointRef.current = null;
    longPressReadyRef.current = false;
    reorderRequestedRef.current = false;
    setDragging(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, [clearPendingLongPress, onEndReorder, onEnterSelectionMode, reorderActive, setRevealOffset, thread.id]);

  const handlePointerCancel = useCallback(
    (event) => {
      clearPendingLongPress();

      if (reorderActive) {
        onCancelReorder?.({
          threadId: thread.id,
          pointerId: event.pointerId
        });
      }

      startPointRef.current = null;
      baseOffsetRef.current = 0;
      pointerIdRef.current = null;
      swipeAxisRef.current = null;
      latestPointerPointRef.current = null;
      longPressReadyRef.current = false;
      reorderRequestedRef.current = false;
      setDragging(false);

      if (event?.currentTarget && typeof event.currentTarget.releasePointerCapture === "function") {
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          // ignore pointer capture release failures
        }
      }
    },
    [clearPendingLongPress, onCancelReorder, reorderActive, thread.id]
  );

  const showDeleteAction = offset > 0;
  const showRenameAction = offset < 0;

  return (
    <div
      className={`relative border-b border-white/8 ${
        reorderActive || reorderOffsetY !== 0 ? "overflow-visible" : "overflow-hidden"
      }`}
      style={{ zIndex: reorderActive ? 20 : reorderOffsetY !== 0 ? 10 : 0 }}
    >
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
        ref={(node) => registerNode?.(thread.id, node)}
        data-testid={`thread-list-item-${thread.id}`}
        onPointerDown={selectionMode ? undefined : handlePointerDown}
        onPointerMove={selectionMode ? undefined : handlePointerMove}
        onPointerUp={selectionMode ? undefined : handlePointerUp}
        onPointerCancel={selectionMode ? undefined : handlePointerCancel}
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
          dragging || reorderActive || transitionLocked ? "" : "transition-transform duration-180 ease-out"
        } ${highlighted ? "bg-slate-900" : "bg-slate-950 hover:bg-slate-900/90"} `}
        aria-pressed={selectionMode ? selected : undefined}
        aria-label={selectionMode ? `${thread.title} 선택` : undefined}
        style={{
          transform: `translate3d(${offset}px, ${reorderOffsetY}px, 0) scale(${reorderActive ? 1.01 : 1})`,
          transition: transitionLocked ? "none" : undefined,
          touchAction: selectionMode ? "auto" : reorderActive ? "none" : "pan-y",
          zIndex: reorderActive ? 20 : 0,
          willChange: "transform"
        }}
      >
        <div
          className={`min-w-0 rounded-2xl border px-3 py-3 ${
            highlighted
              ? "border-white/12 bg-white/[0.03]"
              : "border-transparent bg-transparent"
          } ${reorderActive ? "shadow-[0_18px_42px_rgba(15,23,42,0.38)]" : ""}`}
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

      if (event.target instanceof Element && event.target.closest(MESSAGE_BUBBLE_LONG_PRESS_IGNORE_SELECTOR)) {
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

function RunTimeline({ entries }) {
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

function ThreadDetail({
  thread,
  project,
  bridgeId = "",
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
  emptyStateMessage = ""
}) {
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
  const { alert: showAlert } = useMobileFeedback();
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
  const isInputDisabled = !isDraft && thread?.status === "running";
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
  }, [issueById, messages, thread?.created_at, thread?.updated_at]);
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
        .map(
          (entry) =>
            `${entry.id}:${entry.timestamp ?? ""}:${entry.role}:${String(entry.content ?? "").length}:${entry.attachments?.length ?? 0}`
        )
        .join("|"),
    [visibleChatTimeline]
  );
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

  useEffect(() => {
    setActiveMessageAction(null);
    setInterruptingIssueId("");
    setRetryingIssueId("");
    setDeletingIssueId("");
  }, [thread?.id]);

  const canRefresh = Boolean(thread?.id && onRefreshMessages);
  const rootStyle = standalone ? { height: "calc(var(--app-stable-viewport-height) - var(--app-safe-area-top))" } : undefined;
  const rootClassName = standalone
    ? "flex min-h-0 flex-col overflow-hidden"
    : "flex h-full min-h-0 flex-col overflow-hidden";
  const contentWidthClassName = standalone ? "max-w-3xl" : "max-w-none";
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

      <div className="relative min-h-0 flex-1">
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
            <RunTimeline entries={runTimeline} />
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
                    <MessageAttachmentPreview attachments={message.attachments} bubbleTone={message.tone} onOpenAttachment={handleOpenAttachment} />
                  </MessageBubble>
                </div>
              );
            })
          ) : messageFilter === "prompts" ? (
            <ConversationTimeline entries={promptTimeline} />
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
            <ConversationTimeline entries={conversationTimeline} />
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

        {showJumpToLatestButton ? (
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

      <div
        ref={footerRef}
        data-testid="thread-detail-footer"
        className="telegram-safe-bottom-panel shrink-0 border-t border-white/10 bg-slate-950/92 px-4 pt-2 backdrop-blur"
      >
        <div className={`mx-auto w-full ${contentWidthClassName}`}>
          <InlineIssueComposer
            busy={submitBusy}
            bridgeId={bridgeId}
            selectedProject={project}
            onSubmit={onSubmitPrompt}
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
          />
        </div>
      </div>

      <AttachmentPreviewDialog attachment={previewAttachment} onClose={() => setPreviewAttachment(null)} />
    </div>
  );
}

function MainPage({
  pushNotificationCard,
  session,
  bridges,
  status,
  bridgeSignal,
  bridgeAvailable,
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
  threadComposerDrafts,
  projectFilterUsage,
  projectChipOrder,
  threadOrderByProjectId,
  search,
  loadingState,
  projectBusy,
  threadCreateDialogOpen,
  threadBusy,
  todoBusy,
  todoRenameBusy,
  todoTransferBusy,
  projectInstructionBusy,
  projectEditDialogOpen,
  projectEditTarget,
  projectEditBusy,
  projectEditError,
  threadInstructionBusy,
  threadInstructionError,
  threadDeleteDialog,
  utilityOpen,
  projectComposerOpen,
  installPromptVisible,
  installBusy,
  activeView,
  threadMessageFilter,
  onSearchChange,
  onChangeThreadMessageFilter,
  onChangeProjectChipOrder,
  onChangeThreadOrder,
  onSelectBridge,
  onOpenBridgeDropdown,
  onSelectProject,
  onSelectTodoScope,
  onSelectThread,
  onSelectTodoChat,
  onOpenNewThread,
  onOpenNewTodoChat,
  onOpenUtility,
  onOpenProjectComposer,
  onOpenProjectInstructionDialog,
  onOpenProjectEditDialog,
  onOpenThreadInstructionDialog,
  onCloseThreadCreateDialog,
  onInstallPwa,
  onDismissInstallPrompt,
  onCloseUtility,
  onCloseProjectComposer,
  projectInstructionDialogOpen,
  projectInstructionType,
  onCloseProjectInstructionDialog,
  onCloseProjectEditDialog,
  threadInstructionDialogOpen,
  threadInstructionTarget,
  threadInstructionSupported,
  onCloseThreadInstructionDialog,
  onBrowseWorkspaceRoot,
  onBrowseFolder,
  onSelectWorkspace,
  onSubmitProject,
  onSubmitThreadCreateDialog,
  onSubmitProjectInstruction,
  onSubmitProjectEdit,
  onSubmitThreadInstruction,
  onCreateInstantThread,
  onCreateThread,
  onAppendThreadMessage,
  onChangeThreadComposerDraft,
  onSubmitTodoMessage,
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
  onLoadOlderMessages,
  onStopThreadExecution,
  onInterruptThreadIssue,
  onRetryThreadIssue,
  onDeleteThreadIssue,
  onRefresh,
  bridgeListSyncing,
  onLogout,
  onBackToInbox,
  onRegisterBackHandler
}) {
  const { confirm: confirmMobileAction } = useMobileFeedback();
  const [searchOpen, setSearchOpen] = useState(false);
  const [threadSelectionMode, setThreadSelectionMode] = useState(false);
  const [projectActionProjectId, setProjectActionProjectId] = useState("");
  const [selectedThreadIds, setSelectedThreadIds] = useState([]);
  const [todoChatBeingEdited, setTodoChatBeingEdited] = useState(null);
  const [activeTodoMessage, setActiveTodoMessage] = useState(null);
  const [todoMessageEditorOpen, setTodoMessageEditorOpen] = useState(false);
  const [todoTransferOpen, setTodoTransferOpen] = useState(false);
  const [wideThreadSplitRatio, setWideThreadSplitRatio] = useState(() =>
    readStoredMobileWorkspaceLayout({
      loginId: session?.loginId ?? "",
      bridgeId: selectedBridgeId
    }).wideThreadSplitRatio
  );
  const projectLongPressTimerRef = useRef(null);
  const projectLongPressTriggeredRef = useRef(false);
  const projectChipRowRef = useRef(null);
  const projectChipNodesRef = useRef(new Map());
  const projectChipDragStateRef = useRef(null);
  const projectChipDropIndexRef = useRef(-1);
  const projectChipLayoutSnapshotRef = useRef(new Map());
  const threadListItemNodesRef = useRef(new Map());
  const threadListDragStateRef = useRef(null);
  const threadListDropIndexRef = useRef(-1);
  const threadListLayoutSnapshotRef = useRef(new Map());
  const wideThreadSplitLayoutRef = useRef(null);
  const wideThreadSplitResizePointerIdRef = useRef(null);
  const wideThreadSplitResizeStartXRef = useRef(0);
  const wideThreadSplitResizeStartRatioRef = useRef(0.5);
  const [draggingProjectChipId, setDraggingProjectChipId] = useState("");
  const [draggingProjectChipOffsetX, setDraggingProjectChipOffsetX] = useState(0);
  const [draggingThreadId, setDraggingThreadId] = useState("");
  const [draggingThreadOffsetY, setDraggingThreadOffsetY] = useState(0);
  const [optimisticProjectChipOrder, setOptimisticProjectChipOrder] = useState(null);
  const [optimisticThreadOrderByProjectId, setOptimisticThreadOrderByProjectId] = useState({});
  const [lockProjectChipDropLayout, setLockProjectChipDropLayout] = useState(false);
  const [lockThreadListDropLayout, setLockThreadListDropLayout] = useState(false);
  const deferredSearch = useDeferredValue(search);
  const searchKeyword = deferredSearch.trim().toLowerCase();
  const viewportWidth = useVisualViewportWidth();
  const isTodoScope = selectedScope?.kind === "todo";
  const selectedProjectId = selectedScope?.kind === "project" ? selectedScope.id : "";
  const effectiveProjectChipOrder = optimisticProjectChipOrder ?? projectChipOrder;
  const effectiveThreadOrderByProjectId = useMemo(
    () => ({
      ...threadOrderByProjectId,
      ...optimisticThreadOrderByProjectId
    }),
    [optimisticThreadOrderByProjectId, threadOrderByProjectId]
  );
  const orderedProjects = useMemo(() => {
    return resolveOrderedProjects(projects, projectFilterUsage, effectiveProjectChipOrder);
  }, [effectiveProjectChipOrder, projectFilterUsage, projects]);
  const orderedProjectIds = useMemo(() => orderedProjects.map((project) => project.id), [orderedProjects]);
  const draggingProjectChipDropIndex =
    draggingProjectChipId && projectChipDragStateRef.current?.active ? projectChipDropIndexRef.current : -1;
  const draggingProjectChipShiftDistance = useMemo(() => {
    if (!draggingProjectChipId) {
      return 0;
    }

    const draggingLayout = projectChipLayoutSnapshotRef.current.get(draggingProjectChipId);
    const draggingNode = projectChipNodesRef.current.get(draggingProjectChipId);
    const draggingWidth = draggingLayout?.width ?? draggingNode?.offsetWidth ?? 0;

    if (draggingWidth <= 0) {
      return 0;
    }

    return draggingWidth + getFlexRowGapPx(projectChipRowRef.current);
  }, [draggingProjectChipId, draggingProjectChipOffsetX, orderedProjectIds]);
  const draggingProjectChipProjectedIds = useMemo(() => {
    const activeDragState = projectChipDragStateRef.current;

    if (
      !draggingProjectChipId ||
      !activeDragState?.active ||
      !activeDragState.moved ||
      draggingProjectChipDropIndex < 0
    ) {
      return orderedProjectIds;
    }

    return reorderProjectChipIdsByIndex(orderedProjectIds, draggingProjectChipId, draggingProjectChipDropIndex);
  }, [draggingProjectChipDropIndex, draggingProjectChipId, draggingProjectChipOffsetX, orderedProjectIds]);
  const resolveProjectChipSlideOffsetX = useCallback(
    (projectId) => {
      const normalizedProjectId = String(projectId ?? "").trim();
      const activeDragState = projectChipDragStateRef.current;

      if (
        !normalizedProjectId ||
        !draggingProjectChipId ||
        normalizedProjectId === draggingProjectChipId ||
        !activeDragState?.active ||
        !activeDragState.moved ||
        draggingProjectChipShiftDistance <= 0
      ) {
        return 0;
      }

      const fromIndex = orderedProjectIds.indexOf(draggingProjectChipId);
      const toIndex = draggingProjectChipProjectedIds.indexOf(draggingProjectChipId);
      const currentIndex = orderedProjectIds.indexOf(normalizedProjectId);

      if (fromIndex < 0 || toIndex < 0 || currentIndex < 0 || fromIndex === toIndex) {
        return 0;
      }

      if (toIndex > fromIndex && currentIndex > fromIndex && currentIndex <= toIndex) {
        return -draggingProjectChipShiftDistance;
      }

      if (toIndex < fromIndex && currentIndex >= toIndex && currentIndex < fromIndex) {
        return draggingProjectChipShiftDistance;
      }

      return 0;
    },
    [draggingProjectChipId, draggingProjectChipProjectedIds, draggingProjectChipShiftDistance, orderedProjectIds]
  );
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const selectedProjectName = String(selectedProject?.name ?? "").trim();
  const appHeaderTitle = !isTodoScope && selectedProjectName ? selectedProjectName : "OctOP";
  const threadInstructionProject =
    projects.find((project) => project.id === threadInstructionTarget?.project_id) ??
    selectedProject ??
    null;
  const draftProject = projects.find((project) => project.id === draftThreadProjectId) ?? null;
  const projectActionTarget = projects.find((project) => project.id === projectActionProjectId) ?? null;
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
  const threadComposerDraftKey = buildThreadComposerDraftKey({
    threadId: resolvedThread?.id ?? selectedThreadId,
    projectId: draftProject?.id ?? selectedProjectId,
    isDraft: !selectedThread && !threadDetail?.thread
  });
  const threadComposerDraft = threadComposerDraftKey ? threadComposerDrafts[threadComposerDraftKey] ?? "" : "";
  const todoComposerDraftKey = buildTodoComposerDraftKey({
    chatId: selectedTodoChat?.id ?? todoChatDetail?.chat?.id ?? selectedTodoChatId
  });
  const todoComposerDraft = todoComposerDraftKey ? threadComposerDrafts[todoComposerDraftKey] ?? "" : "";

  useEffect(() => {
    if (typeof onRegisterBackHandler !== "function") {
      return undefined;
    }

    onRegisterBackHandler(() => {
      if (todoTransferOpen) {
        setTodoTransferOpen(false);
        return true;
      }

      if (todoMessageEditorOpen) {
        setTodoMessageEditorOpen(false);
        return true;
      }

      if (activeTodoMessage) {
        setActiveTodoMessage(null);
        return true;
      }

      if (todoChatBeingEdited) {
        setTodoChatBeingEdited(null);
        return true;
      }

      if (projectActionTarget) {
        setProjectActionProjectId("");
        return true;
      }

      if (threadSelectionMode) {
        setThreadSelectionMode(false);
        setSelectedThreadIds([]);
        return true;
      }

      if (searchOpen) {
        setSearchOpen(false);
        return true;
      }

      return false;
    });

    return () => {
      onRegisterBackHandler(null);
    };
  }, [
    activeTodoMessage,
    onRegisterBackHandler,
    projectActionTarget,
    searchOpen,
    threadSelectionMode,
    todoChatBeingEdited,
    todoMessageEditorOpen,
    todoTransferOpen
  ]);
  const filteredTodoChats = useMemo(() => {
    return todoChats.filter((chat) => {
      const matchesSearch =
        !searchKeyword ||
        chat.title.toLowerCase().includes(searchKeyword) ||
        (chat.last_message ?? "").toLowerCase().includes(searchKeyword);

      return matchesSearch;
    });
  }, [searchKeyword, todoChats]);
  const orderedThreads = useMemo(() => {
    if (selectedScope?.kind !== "project") {
      return [];
    }

    return resolveOrderedThreads(threads, effectiveThreadOrderByProjectId[selectedProjectId] ?? []);
  }, [effectiveThreadOrderByProjectId, selectedProjectId, selectedScope?.kind, threads]);
  const filteredThreads = useMemo(() => {
    return orderedThreads.filter((thread) => {
      const matchesProject = !selectedProjectId || thread.project_id === selectedProjectId;
      const matchesSearch =
        !searchKeyword ||
        thread.title.toLowerCase().includes(searchKeyword) ||
        thread.last_message.toLowerCase().includes(searchKeyword);

      return matchesProject && matchesSearch;
    });
  }, [orderedThreads, searchKeyword, selectedProjectId]);
  const orderedThreadIds = useMemo(() => orderedThreads.map((thread) => thread.id), [orderedThreads]);
  const filteredThreadIds = useMemo(() => filteredThreads.map((thread) => thread.id), [filteredThreads]);
  const draggingThreadDropIndex =
    draggingThreadId && threadListDragStateRef.current?.active ? threadListDropIndexRef.current : -1;
  const draggingThreadShiftDistance = useMemo(() => {
    if (!draggingThreadId) {
      return 0;
    }

    const draggingNode = threadListItemNodesRef.current.get(draggingThreadId);

    if (!draggingNode) {
      return 0;
    }

    return draggingNode.offsetHeight;
  }, [draggingThreadId, draggingThreadOffsetY, filteredThreadIds]);
  const draggingThreadProjectedIds = useMemo(() => {
    const activeDragState = threadListDragStateRef.current;

    if (
      !draggingThreadId ||
      !activeDragState?.active ||
      !activeDragState.moved ||
      draggingThreadDropIndex < 0
    ) {
      return filteredThreadIds;
    }

    return reorderThreadIdsByIndex(filteredThreadIds, draggingThreadId, draggingThreadDropIndex);
  }, [draggingThreadDropIndex, draggingThreadId, draggingThreadOffsetY, filteredThreadIds]);
  const resolveThreadListItemSlideOffsetY = useCallback(
    (threadId) => {
      const normalizedThreadId = String(threadId ?? "").trim();
      const activeDragState = threadListDragStateRef.current;

      if (
        !normalizedThreadId ||
        !draggingThreadId ||
        normalizedThreadId === draggingThreadId ||
        !activeDragState?.active ||
        !activeDragState.moved ||
        draggingThreadShiftDistance <= 0
      ) {
        return 0;
      }

      const fromIndex = filteredThreadIds.indexOf(draggingThreadId);
      const toIndex = draggingThreadProjectedIds.indexOf(draggingThreadId);
      const currentIndex = filteredThreadIds.indexOf(normalizedThreadId);

      if (fromIndex < 0 || toIndex < 0 || currentIndex < 0 || fromIndex === toIndex) {
        return 0;
      }

      if (toIndex > fromIndex && currentIndex > fromIndex && currentIndex <= toIndex) {
        return -draggingThreadShiftDistance;
      }

      if (toIndex < fromIndex && currentIndex >= toIndex && currentIndex < fromIndex) {
        return draggingThreadShiftDistance;
      }

      return 0;
    },
    [draggingThreadId, draggingThreadProjectedIds, draggingThreadShiftDistance, filteredThreadIds]
  );
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
  const loadedIssueIds = useMemo(
    () =>
      normalizeIssueIdList(
        [
          ...(threadDetail?.loaded_issue_ids ?? []),
          ...collectLoadedIssueIdsFromMessages(threadDetailMessages)
        ],
        threadDetail?.issues ?? []
      ),
    [threadDetail?.issues, threadDetail?.loaded_issue_ids, threadDetailMessages]
  );
  const remainingHistoryCount = useMemo(
    () =>
      getLazyOlderIssueIds(
        threadDetail?.issues ?? [],
        loadedIssueIds,
        resolvedThread?.active_physical_thread_id ?? null
      ).length,
    [loadedIssueIds, resolvedThread?.active_physical_thread_id, threadDetail?.issues]
  );
  const hasOlderMessages = remainingHistoryCount > 0;
  const todoChatMessages = todoChatDetail?.messages ?? [];
  const todoChatLoading = todoChatDetail?.loading ?? false;
  const todoChatError = todoChatDetail?.error ?? "";
  const clearPendingProjectLongPress = useCallback(() => {
    if (projectLongPressTimerRef.current) {
      clearTimeout(projectLongPressTimerRef.current);
      projectLongPressTimerRef.current = null;
    }
  }, []);
  const resetProjectChipDragInteraction = useCallback(() => {
    projectChipDragStateRef.current = null;
    projectChipDropIndexRef.current = -1;
    projectChipLayoutSnapshotRef.current = new Map();
    setDraggingProjectChipId("");
    setDraggingProjectChipOffsetX(0);
  }, []);
  const resetThreadListDragInteraction = useCallback(() => {
    threadListDragStateRef.current = null;
    threadListDropIndexRef.current = -1;
    threadListLayoutSnapshotRef.current = new Map();
    setDraggingThreadId("");
    setDraggingThreadOffsetY(0);
  }, []);
  const holdReorderedLayout = useCallback((setter) => {
    setter(true);

    if (typeof window === "undefined") {
      setter(false);
      return;
    }

    let remainingFrames = REORDER_POSITION_LOCK_FRAME_COUNT;

    const release = () => {
      remainingFrames -= 1;

      if (remainingFrames <= 0) {
        setter(false);
        return;
      }

      window.requestAnimationFrame(release);
    };

    window.requestAnimationFrame(release);
  }, []);
  const registerProjectChipNode = useCallback((projectId, node) => {
    const normalizedProjectId = String(projectId ?? "").trim();

    if (!normalizedProjectId) {
      return;
    }

    if (node) {
      projectChipNodesRef.current.set(normalizedProjectId, node);
      return;
    }

    projectChipNodesRef.current.delete(normalizedProjectId);
  }, []);
  const registerThreadListItemNode = useCallback((threadId, node) => {
    const normalizedThreadId = String(threadId ?? "").trim();

    if (!normalizedThreadId) {
      return;
    }

    if (node) {
      threadListItemNodesRef.current.set(normalizedThreadId, node);
      return;
    }

    threadListItemNodesRef.current.delete(normalizedThreadId);
  }, []);
  const captureProjectChipLayoutSnapshot = useCallback((projectIds) => {
    const snapshot = new Map();
    const scrollLeft = projectChipRowRef.current?.scrollLeft ?? 0;

    normalizeProjectChipOrder(projectIds).forEach((projectId) => {
      const node = projectChipNodesRef.current.get(projectId);

      if (!node) {
        return;
      }

      const rect = node.getBoundingClientRect();
      snapshot.set(projectId, {
        left: rect.left + scrollLeft,
        width: rect.width,
        height: rect.height
      });
    });

    projectChipLayoutSnapshotRef.current = snapshot;
    return snapshot;
  }, []);
  const captureThreadListLayoutSnapshot = useCallback((threadIds) => {
    const snapshot = new Map();

    normalizeThreadOrder(threadIds).forEach((threadId) => {
      const node = threadListItemNodesRef.current.get(threadId);

      if (!node) {
        return;
      }

      const rect = node.getBoundingClientRect();
      snapshot.set(threadId, {
        top: rect.top,
        height: rect.height
      });
    });

    threadListLayoutSnapshotRef.current = snapshot;
    return snapshot;
  }, []);
  const resolveProjectChipDropIndex = useCallback(
    (draggedCenterX, draggedProjectId) => {
      const normalizedDraggedProjectId = String(draggedProjectId ?? "").trim();
      const layoutSnapshot = projectChipLayoutSnapshotRef.current;
      const draggedLayout = layoutSnapshot.get(normalizedDraggedProjectId);
      const draggedNode = projectChipNodesRef.current.get(normalizedDraggedProjectId);
      const gapPx = getFlexRowGapPx(projectChipRowRef.current);
      const {
        draggedProjectIndex,
        draggableLayouts
      } = buildProjectChipCollapsedLayouts(
        orderedProjectIds,
        normalizedDraggedProjectId,
        layoutSnapshot,
        draggedLayout?.width ?? draggedNode?.offsetWidth ?? 0,
        gapPx
      );

      if (draggedProjectIndex < 0) {
        return -1;
      }

      for (let index = 0; index < draggableLayouts.length; index += 1) {
        const layout = draggableLayouts[index];
        const triggerX = layout.left + layout.width / 2;

        if (draggedCenterX < triggerX) {
          return index;
        }
      }

      return draggableLayouts.length;
    },
    [orderedProjectIds]
  );
  const maybeAutoScrollProjectChipRow = useCallback((clientX) => {
    const rowNode = projectChipRowRef.current;

    if (!rowNode) {
      return;
    }

    const rect = rowNode.getBoundingClientRect();
    const edgeThreshold = 36;

    if (clientX <= rect.left + edgeThreshold) {
      rowNode.scrollLeft = Math.max(0, rowNode.scrollLeft - 18);
      return;
    }

    if (clientX >= rect.right - edgeThreshold) {
      rowNode.scrollLeft = Math.min(rowNode.scrollWidth - rowNode.clientWidth, rowNode.scrollLeft + 18);
    }
  }, []);
  useEffect(
    () => () => {
      clearPendingProjectLongPress();
      resetProjectChipDragInteraction();
      resetThreadListDragInteraction();
    },
    [clearPendingProjectLongPress, resetProjectChipDragInteraction, resetThreadListDragInteraction]
  );
  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const handleTouchMove = (event) => {
      if (projectChipDragStateRef.current?.active || threadListDragStateRef.current?.active) {
        event.preventDefault();
      }
    };

    window.addEventListener("touchmove", handleTouchMove, { passive: false });

    return () => {
      window.removeEventListener("touchmove", handleTouchMove);
    };
  }, []);
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
    async (project) => {
      if (!project?.id || !onDeleteProject) {
        return;
      }

      const confirmMessage = project?.name
        ? `\"${project.name}\" 프로젝트를 삭제하시겠습니까? 해당 프로젝트의 이슈도 함께 제거됩니다.`
        : PROJECT_DELETE_CONFIRM_MESSAGE;
      const confirmed = await confirmMobileAction({
        title: "프로젝트 삭제",
        message: confirmMessage,
        confirmLabel: "삭제",
        cancelLabel: "취소",
        tone: "danger"
      });

      if (!confirmed) {
        return;
      }

      setProjectActionProjectId("");
      void onDeleteProject(project.id);
    },
    [confirmMobileAction, onDeleteProject]
  );
  const openProjectActionSheet = useCallback((project) => {
    if (!project?.id) {
      return;
    }

    setProjectActionProjectId(project.id);
  }, []);
  const handleProjectChipPointerDown = useCallback(
    (event, project) => {
      if (typeof window === "undefined" || !project) {
        return;
      }

      const isMousePointer = event?.pointerType === "mouse";
      const isTouchPointer = event?.pointerType === "touch" || event?.pointerType === "pen";

      if (!isTouchPointer && !(isMousePointer && event?.button === 0)) {
        return;
      }

      if (!isMousePointer) {
        event.preventDefault();
      }

      projectLongPressTriggeredRef.current = false;
      clearPendingProjectLongPress();
      resetProjectChipDragInteraction();
      projectChipDragStateRef.current = {
        active: false,
        moved: false,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        project,
        startX: event.clientX,
        startY: event.clientY,
        latestClientX: event.clientX,
        latestClientY: event.clientY,
        dragOriginCenterX: event.clientX,
        startScrollLeft: projectChipRowRef.current?.scrollLeft ?? 0
      };
      if (event?.currentTarget && typeof event.currentTarget.setPointerCapture === "function") {
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // ignore pointer capture failures and fall back to window-level listeners
        }
      }

      projectLongPressTimerRef.current = window.setTimeout(() => {
        const activeDragState = projectChipDragStateRef.current;

        if (!activeDragState || activeDragState.pointerId !== event.pointerId) {
          projectLongPressTimerRef.current = null;
          return;
        }

        projectLongPressTimerRef.current = null;
        projectLongPressTriggeredRef.current = true;
        activeDragState.active = true;
        activeDragState.startX = activeDragState.latestClientX ?? event.clientX;
        activeDragState.startY = activeDragState.latestClientY ?? event.clientY;
        activeDragState.startScrollLeft = projectChipRowRef.current?.scrollLeft ?? activeDragState.startScrollLeft;
        const layoutSnapshot = captureProjectChipLayoutSnapshot(orderedProjectIds);
        const draggedLayout = layoutSnapshot.get(project.id);
        const draggedNode = projectChipNodesRef.current.get(project.id);
        const draggedRect = draggedNode?.getBoundingClientRect?.();
        activeDragState.dragOriginCenterX = draggedLayout
          ? draggedLayout.left + draggedLayout.width / 2
          : draggedRect
            ? draggedRect.left + (projectChipRowRef.current?.scrollLeft ?? activeDragState.startScrollLeft) + draggedRect.width / 2
            : activeDragState.startX + (projectChipRowRef.current?.scrollLeft ?? activeDragState.startScrollLeft);
        activeDragState.latestDraggedCenterX = activeDragState.dragOriginCenterX;
        projectChipDropIndexRef.current = resolveProjectChipDropIndex(activeDragState.dragOriginCenterX, project.id);
        setDraggingProjectChipId(project.id);
        setDraggingProjectChipOffsetX(0);
      }, PROJECT_CHIP_LONG_PRESS_MS);
    },
    [
      captureProjectChipLayoutSnapshot,
      clearPendingProjectLongPress,
      orderedProjectIds,
      resetProjectChipDragInteraction,
      resolveProjectChipDropIndex
    ]
  );
  const handleProjectChipContextMenu = useCallback(
    (event, project) => {
      event.preventDefault();

      const activeDragState = projectChipDragStateRef.current;
      const activePointerType = activeDragState?.pointerType ?? "";
      const suppressActionSheet =
        Boolean(projectLongPressTimerRef.current) ||
        Boolean(activeDragState) ||
        projectLongPressTriggeredRef.current ||
        activePointerType === "touch" ||
        activePointerType === "pen";

      if (suppressActionSheet) {
        return;
      }

      clearPendingProjectLongPress();
      projectLongPressTriggeredRef.current = false;
      resetProjectChipDragInteraction();
      openProjectActionSheet(project);
    },
    [clearPendingProjectLongPress, openProjectActionSheet, resetProjectChipDragInteraction]
  );
  const handleProjectChipPointerMove = useCallback(
    (event) => {
      const activeDragState = projectChipDragStateRef.current;

      if (!activeDragState || activeDragState.pointerId !== event.pointerId) {
        return;
      }

      const deltaX = event.clientX - activeDragState.startX;
      const deltaY = event.clientY - activeDragState.startY;
      activeDragState.latestClientX = event.clientX;
      activeDragState.latestClientY = event.clientY;

      if (!activeDragState.active) {
        if (Math.hypot(deltaX, deltaY) > PROJECT_CHIP_LONG_PRESS_CANCEL_TOLERANCE_PX) {
          clearPendingProjectLongPress();
          projectChipDragStateRef.current = null;
        }

        return;
      }

      const currentScrollLeft = projectChipRowRef.current?.scrollLeft ?? activeDragState.startScrollLeft;
      const dragOffsetX = event.clientX - activeDragState.startX + (currentScrollLeft - activeDragState.startScrollLeft);
      const draggedCenterX = activeDragState.dragOriginCenterX + dragOffsetX;
      activeDragState.latestDraggedCenterX = draggedCenterX;

      if (!activeDragState.moved && Math.hypot(dragOffsetX, deltaY) > PROJECT_CHIP_REORDER_MOVE_TOLERANCE_PX) {
        activeDragState.moved = true;
      }

      projectChipDropIndexRef.current = resolveProjectChipDropIndex(draggedCenterX, activeDragState.project.id);
      setDraggingProjectChipOffsetX(dragOffsetX);
      maybeAutoScrollProjectChipRow(event.clientX);
      event.preventDefault();
    },
    [clearPendingProjectLongPress, maybeAutoScrollProjectChipRow, resolveProjectChipDropIndex]
  );
  const handleProjectChipPointerEnd = useCallback(
    (event) => {
      const activeDragState = projectChipDragStateRef.current;

      clearPendingProjectLongPress();

      if (!activeDragState || activeDragState.pointerId !== event.pointerId) {
        projectLongPressTriggeredRef.current = false;
        resetProjectChipDragInteraction();
        return;
      }

      event.currentTarget.releasePointerCapture?.(event.pointerId);

      const { active, moved, project } = activeDragState;
      const dropIndex = projectChipDropIndexRef.current;

      if (!active) {
        projectLongPressTriggeredRef.current = false;
        resetProjectChipDragInteraction();
        return;
      }

      event.preventDefault();

      if (moved) {
        const nextProjectOrder = reorderProjectChipIdsByIndex(orderedProjectIds, project.id, dropIndex);

        if (!areStringArraysEqual(nextProjectOrder, orderedProjectIds)) {
          holdReorderedLayout(setLockProjectChipDropLayout);
          setOptimisticProjectChipOrder(nextProjectOrder);
          onChangeProjectChipOrder(nextProjectOrder);
        }

        resetProjectChipDragInteraction();
        window.setTimeout(() => {
          projectLongPressTriggeredRef.current = false;
        }, 0);
        return;
      }

      resetProjectChipDragInteraction();
      onOpenProjectEditDialog(project);

      window.setTimeout(() => {
        projectLongPressTriggeredRef.current = false;
      }, 0);
    },
    [
      clearPendingProjectLongPress,
      holdReorderedLayout,
      onOpenProjectEditDialog,
      onChangeProjectChipOrder,
      orderedProjectIds,
      resetProjectChipDragInteraction
    ]
  );
  const handleProjectChipPointerCancel = useCallback(
    (event) => {
      clearPendingProjectLongPress();

      if (event?.currentTarget && typeof event.currentTarget.releasePointerCapture === "function" && event.pointerId != null) {
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          // ignore pointer capture release failures
        }
      }

      projectLongPressTriggeredRef.current = false;
      resetProjectChipDragInteraction();
    },
    [clearPendingProjectLongPress, resetProjectChipDragInteraction]
  );
  const handleProjectChipClick = useCallback(
    (projectId) => {
      if (projectLongPressTriggeredRef.current) {
        projectLongPressTriggeredRef.current = false;
        return;
      }

      const normalizedProjectId = String(projectId ?? "").trim();

      setThreadSelectionMode(false);
      setSelectedThreadIds([]);
      onSelectProject(normalizedProjectId);
    },
    [onSelectProject]
  );
  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const handleWindowPointerMove = (event) => {
      if (projectChipDragStateRef.current?.pointerId !== event.pointerId) {
        return;
      }

      handleProjectChipPointerMove(event);
    };
    const handleWindowPointerEnd = (event) => {
      if (projectChipDragStateRef.current?.pointerId !== event.pointerId) {
        return;
      }

      handleProjectChipPointerEnd(event);
    };
    const handleWindowPointerCancel = (event) => {
      if (projectChipDragStateRef.current?.pointerId !== event.pointerId) {
        return;
      }

      handleProjectChipPointerCancel(event);
    };

    window.addEventListener("pointermove", handleWindowPointerMove, { passive: false });
    window.addEventListener("pointerup", handleWindowPointerEnd);
    window.addEventListener("pointercancel", handleWindowPointerCancel);

    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", handleWindowPointerEnd);
      window.removeEventListener("pointercancel", handleWindowPointerCancel);
    };
  }, [handleProjectChipPointerCancel, handleProjectChipPointerEnd, handleProjectChipPointerMove]);
  const resolveThreadDropIndex = useCallback(
    (draggedCenterY, draggedThreadId) => {
      const activeDragState = threadListDragStateRef.current;
      const normalizedDraggedThreadId = String(draggedThreadId ?? "").trim();
      const baseThreadIds = normalizeThreadOrder(activeDragState?.visibleThreadIds ?? filteredThreadIds);
      const layoutSnapshot = threadListLayoutSnapshotRef.current;
      const draggedThreadLayout = layoutSnapshot.get(normalizedDraggedThreadId);
      const draggedNode = threadListItemNodesRef.current.get(normalizedDraggedThreadId);
      const {
        draggedThreadIndex,
        draggableLayouts
      } = buildThreadListCollapsedLayouts(
        baseThreadIds,
        normalizedDraggedThreadId,
        layoutSnapshot,
        draggedThreadLayout?.height ?? draggedNode?.offsetHeight ?? 0
      );

      if (draggedThreadIndex < 0) {
        return -1;
      }

      for (let index = 0; index < draggableLayouts.length; index += 1) {
        const layout = draggableLayouts[index];
        const triggerY = layout.top + layout.height / 2;

        if (draggedCenterY < triggerY) {
          return index;
        }
      }

      return draggableLayouts.length;
    },
    [filteredThreadIds]
  );
  const handleThreadReorderStart = useCallback(
    ({ thread, pointerId, clientY }) => {
      if (!thread?.id || !selectedProjectId) {
        return;
      }

      const visibleThreadIds = [...filteredThreadIds];
      const layoutSnapshot = captureThreadListLayoutSnapshot(visibleThreadIds);
      const draggedLayout = layoutSnapshot.get(thread.id);
      const draggedNode = threadListItemNodesRef.current.get(thread.id);
      const dragOriginCenterY = draggedLayout
        ? draggedLayout.top + draggedLayout.height / 2
        : ((draggedNode?.getBoundingClientRect?.().top ?? clientY) + (draggedNode?.offsetHeight ?? 0) / 2);

      setThreadSelectionMode(false);
      setSelectedThreadIds([]);
      threadListDragStateRef.current = {
        active: true,
        moved: false,
        pointerId,
        thread,
        startY: clientY,
        dragOriginCenterY,
        latestDraggedCenterY: dragOriginCenterY,
        visibleThreadIds
      };
      threadListDropIndexRef.current = resolveThreadDropIndex(dragOriginCenterY, thread.id);
      setDraggingThreadId(thread.id);
      setDraggingThreadOffsetY(0);
    },
    [captureThreadListLayoutSnapshot, filteredThreadIds, resolveThreadDropIndex, selectedProjectId]
  );
  const handleThreadReorderMove = useCallback(
    ({ threadId, pointerId, clientY }) => {
      const activeDragState = threadListDragStateRef.current;

      if (
        !activeDragState ||
        activeDragState.pointerId !== pointerId ||
        activeDragState.thread?.id !== String(threadId ?? "").trim()
      ) {
        return false;
      }

      const dragOffsetY = clientY - activeDragState.startY;
      const draggedCenterY = activeDragState.dragOriginCenterY + dragOffsetY;
      activeDragState.latestDraggedCenterY = draggedCenterY;

      if (!activeDragState.moved && Math.abs(dragOffsetY) > THREAD_LIST_ITEM_REORDER_MOVE_TOLERANCE_PX) {
        activeDragState.moved = true;
      }

      threadListDropIndexRef.current = resolveThreadDropIndex(draggedCenterY, activeDragState.thread.id);
      setDraggingThreadOffsetY(dragOffsetY);
      return true;
    },
    [resolveThreadDropIndex]
  );
  const handleThreadReorderEnd = useCallback(
    ({ threadId, pointerId }) => {
      const activeDragState = threadListDragStateRef.current;

      if (
        !activeDragState ||
        activeDragState.pointerId !== pointerId ||
        activeDragState.thread?.id !== String(threadId ?? "").trim()
      ) {
        resetThreadListDragInteraction();
        return false;
      }

      const { moved, thread } = activeDragState;
      const dropIndex = threadListDropIndexRef.current;

      if (!moved || !selectedProjectId) {
        resetThreadListDragInteraction();
        return true;
      }

      const reorderedVisibleThreadIds = reorderThreadIdsByIndex(filteredThreadIds, thread.id, dropIndex);
      const nextThreadOrder = applySubsetThreadOrder(orderedThreadIds, filteredThreadIds, reorderedVisibleThreadIds);

      if (!areStringArraysEqual(nextThreadOrder, orderedThreadIds)) {
        holdReorderedLayout(setLockThreadListDropLayout);
        setOptimisticThreadOrderByProjectId((current) => ({
          ...current,
          [selectedProjectId]: nextThreadOrder
        }));
        onChangeThreadOrder(selectedProjectId, nextThreadOrder);
      }

      resetThreadListDragInteraction();
      return true;
    },
    [
      filteredThreadIds,
      holdReorderedLayout,
      onChangeThreadOrder,
      orderedThreadIds,
      resetThreadListDragInteraction,
      selectedProjectId
    ]
  );
  const handleThreadReorderCancel = useCallback(
    ({ threadId, pointerId }) => {
      const activeDragState = threadListDragStateRef.current;

      if (
        activeDragState &&
        activeDragState.pointerId === pointerId &&
        activeDragState.thread?.id === String(threadId ?? "").trim()
      ) {
        resetThreadListDragInteraction();
        return true;
      }

      return false;
    },
    [resetThreadListDragInteraction]
  );
  useEffect(() => {
    if (!optimisticProjectChipOrder) {
      return;
    }

    const normalizedAvailableProjectIds = projects.map((project) => project.id);
    const normalizedOptimisticOrder = normalizeProjectChipOrder(optimisticProjectChipOrder, normalizedAvailableProjectIds);
    const normalizedCommittedOrder = normalizeProjectChipOrder(projectChipOrder, normalizedAvailableProjectIds);

    if (areStringArraysEqual(normalizedOptimisticOrder, normalizedCommittedOrder)) {
      setOptimisticProjectChipOrder(null);
    }
  }, [optimisticProjectChipOrder, projectChipOrder, projects]);
  useEffect(() => {
    const optimisticProjectIds = Object.keys(optimisticThreadOrderByProjectId);

    if (optimisticProjectIds.length === 0) {
      return;
    }

    setOptimisticThreadOrderByProjectId((current) => {
      const next = { ...current };
      let changed = false;

      optimisticProjectIds.forEach((projectId) => {
        const normalizedOptimisticOrder = normalizeThreadOrder(current[projectId] ?? []);
        const normalizedCommittedOrder = normalizeThreadOrder(threadOrderByProjectId[projectId] ?? []);

        if (areStringArraysEqual(normalizedOptimisticOrder, normalizedCommittedOrder)) {
          delete next[projectId];
          changed = true;
        }
      });

      return changed ? next : current;
    });
  }, [optimisticThreadOrderByProjectId, threadOrderByProjectId]);
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
  const threadProject =
    projects.find((project) => project.id === resolvedThread?.project_id) ??
    draftProject ??
    selectedProject;
  const showWideTodoSplitLayout = isTodoScope && viewportWidth >= MOBILE_WIDE_THREAD_SPLIT_MIN_WIDTH_PX;
  const showWideThreadSplitLayout =
    !isTodoScope &&
    activeView !== "todo" &&
    viewportWidth >= MOBILE_WIDE_THREAD_SPLIT_MIN_WIDTH_PX &&
    (selectedProjectId || draftThreadProjectId || selectedThreadId);
  const showWideSplitLayout = showWideTodoSplitLayout || showWideThreadSplitLayout;
  const wideThreadSplitResizeEnabled = viewportWidth >= MOBILE_WIDE_THREAD_SPLIT_RESIZE_MIN_WIDTH_PX;
  const splitThreadEmptyStateMessage =
    !selectedThreadId && !draftProject
      ? "채팅창이 없습니다. 좌측 쓰레드를 선택하거나 새 채팅창을 시작해 주세요."
      : "";
  const wideThreadSplitLeftWeight = Math.max(1, Math.round(wideThreadSplitRatio * 100));
  const wideThreadSplitRightWeight = Math.max(1, 100 - wideThreadSplitLeftWeight);
  const projectChipRow = (
    <div className="border-b border-white/10 px-4 py-1.5">
      <div
        ref={projectChipRowRef}
        className={`project-chip-row -mx-1 flex gap-1.5 overflow-x-auto px-1 ${draggingProjectChipId ? "cursor-grabbing" : ""}`}
      >
        <button
          type="button"
          onClick={() => onSelectTodoScope()}
          className={`project-chip-button shrink-0 rounded-full px-3.5 text-[12px] font-medium transition select-none touch-manipulation ${
            isTodoScope ? "bg-white text-slate-900" : "bg-transparent text-slate-400 hover:text-white"
          }`}
        >
          ToDo
        </button>
        {orderedProjects.map((project) => {
          const isDraggingProjectChip = draggingProjectChipId === project.id;
          const projectChipSlideOffsetX = resolveProjectChipSlideOffsetX(project.id);
          const disableProjectChipTransition = lockProjectChipDropLayout || Boolean(optimisticProjectChipOrder);
          const projectChipLayout = projectChipLayoutSnapshotRef.current.get(project.id);
          const projectChipNode = projectChipNodesRef.current.get(project.id);
          const projectChipPlaceholderWidth = projectChipLayout?.width ?? projectChipNode?.offsetWidth ?? undefined;
          const projectChipPlaceholderHeight = projectChipLayout?.height ?? projectChipNode?.offsetHeight ?? undefined;

          return (
            <div
              key={project.id}
              ref={(node) => registerProjectChipNode(project.id, node)}
              data-testid={`project-chip-item-${project.id}`}
              className="relative shrink-0"
              style={
                isDraggingProjectChip
                  ? {
                      width: projectChipPlaceholderWidth ? `${projectChipPlaceholderWidth}px` : undefined,
                      height: projectChipPlaceholderHeight ? `${projectChipPlaceholderHeight}px` : undefined
                    }
                    : projectChipSlideOffsetX !== 0
                    ? {
                        transform: `translateX(${projectChipSlideOffsetX}px)`,
                        transition: disableProjectChipTransition ? "none" : "transform 180ms ease-out"
                      }
                    : disableProjectChipTransition
                      ? { transition: "none" }
                      : undefined
              }
            >
              <button
                type="button"
                onClick={() => handleProjectChipClick(project.id)}
                onPointerDown={(event) => handleProjectChipPointerDown(event, project)}
                onContextMenu={(event) => handleProjectChipContextMenu(event, project)}
                title={project.name}
                className={`project-chip-button max-w-[68vw] overflow-hidden text-ellipsis whitespace-nowrap rounded-full px-3.5 text-[12px] font-medium select-none touch-manipulation ${
                  isDraggingProjectChip ? "w-full" : "shrink-0"
                } ${
                  isDraggingProjectChip
                    ? "bg-white text-slate-900 shadow-[0_12px_24px_rgba(15,23,42,0.35)]"
                    : !isTodoScope && project.id === selectedProjectId
                      ? "bg-white text-slate-900"
                      : "bg-transparent text-slate-400 hover:text-white"
                }`}
                style={
                  isDraggingProjectChip
                    ? {
                        position: "absolute",
                        inset: 0,
                        zIndex: 20,
                        transform: `translateX(${draggingProjectChipOffsetX}px) scale(1.02)`,
                        transition: "none",
                        touchAction: "none",
                        pointerEvents: "none"
                      }
                    : undefined
                }
              >
                {project.name}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );

  useEffect(() => {
    const storedRatio = readStoredMobileWorkspaceLayout({
      loginId: session?.loginId ?? "",
      bridgeId: selectedBridgeId
    }).wideThreadSplitRatio;

    setWideThreadSplitRatio(storedRatio);
  }, [selectedBridgeId, session?.loginId]);

  useEffect(() => {
    if (!session?.loginId || !selectedBridgeId) {
      return;
    }

    storeMobileWorkspaceLayout(
      {
        wideThreadSplitRatio
      },
      {
        loginId: session.loginId,
        bridgeId: selectedBridgeId
      }
    );
  }, [selectedBridgeId, session?.loginId, wideThreadSplitRatio]);

  useEffect(() => {
    if (!showWideSplitLayout || !wideThreadSplitResizeEnabled) {
      return;
    }

    const containerWidth = wideThreadSplitLayoutRef.current?.clientWidth ?? viewportWidth ?? 0;
    setWideThreadSplitRatio((current) => clampWideThreadSplitRatio(current, containerWidth));
  }, [showWideSplitLayout, viewportWidth, wideThreadSplitResizeEnabled]);

  const updateWideThreadSplitRatioFromClientX = useCallback((clientX) => {
    const container = wideThreadSplitLayoutRef.current;

    if (!container) {
      return;
    }

    const rect = container.getBoundingClientRect();

    if (rect.width <= 0) {
      return;
    }

    const deltaX = clientX - wideThreadSplitResizeStartXRef.current;
    const nextRatio = clampWideThreadSplitRatio(
      wideThreadSplitResizeStartRatioRef.current + deltaX / rect.width,
      rect.width
    );

    setWideThreadSplitRatio(nextRatio);
  }, []);

  const handleWideThreadSplitResizePointerDown = useCallback(
    (event) => {
      if (!wideThreadSplitResizeEnabled) {
        return;
      }

      wideThreadSplitResizePointerIdRef.current = event.pointerId;
      wideThreadSplitResizeStartXRef.current = event.clientX;
      wideThreadSplitResizeStartRatioRef.current = wideThreadSplitRatio;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    },
    [wideThreadSplitRatio, wideThreadSplitResizeEnabled]
  );

  const handleWideThreadSplitResizePointerMove = useCallback(
    (event) => {
      if (
        !wideThreadSplitResizeEnabled ||
        wideThreadSplitResizePointerIdRef.current === null ||
        event.pointerId !== wideThreadSplitResizePointerIdRef.current
      ) {
        return;
      }

      updateWideThreadSplitRatioFromClientX(event.clientX);
      event.preventDefault();
    },
    [updateWideThreadSplitRatioFromClientX, wideThreadSplitResizeEnabled]
  );

  const handleWideThreadSplitResizePointerUp = useCallback((event) => {
    if (wideThreadSplitResizePointerIdRef.current === null || event.pointerId !== wideThreadSplitResizePointerIdRef.current) {
      return;
    }

    wideThreadSplitResizePointerIdRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, []);

  useEffect(() => {
    if (!wideThreadSplitResizeEnabled || typeof window === "undefined") {
      return undefined;
    }

    const handleWindowPointerMove = (event) => {
      if (
        wideThreadSplitResizePointerIdRef.current === null ||
        event.pointerId !== wideThreadSplitResizePointerIdRef.current
      ) {
        return;
      }

      updateWideThreadSplitRatioFromClientX(event.clientX);
      event.preventDefault();
    };

    const handleWindowPointerUp = (event) => {
      if (
        wideThreadSplitResizePointerIdRef.current === null ||
        event.pointerId !== wideThreadSplitResizePointerIdRef.current
      ) {
        return;
      }

      wideThreadSplitResizePointerIdRef.current = null;
    };

    window.addEventListener("pointermove", handleWindowPointerMove, { passive: false });
    window.addEventListener("pointerup", handleWindowPointerUp);
    window.addEventListener("pointercancel", handleWindowPointerUp);

    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", handleWindowPointerUp);
      window.removeEventListener("pointercancel", handleWindowPointerUp);
    };
  }, [updateWideThreadSplitRatioFromClientX, wideThreadSplitResizeEnabled]);
  const inboxListContent = isTodoScope ? (
    filteredTodoChats.length === 0 ? (
      <div className="px-2 py-10 text-center text-sm leading-7 text-slate-400">
        {loadingState === "loading"
          ? "데이터를 불러오고 있습니다."
          : "조건에 맞는 ToDo 채팅이 없습니다. 새 ToDo 채팅을 만들어 아이디어를 모아 주세요."}
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
      {!bridgeAvailable ? (
        <div className="px-2 py-10 text-center text-sm leading-7 text-slate-400">
          브리지가 연결되지 않아 채팅창 목록을 표시할 수 없습니다.
        </div>
      ) : filteredThreads.length === 0 ? (
        <div className="px-2 py-10 text-center text-sm leading-7 text-slate-400">
          {loadingState === "loading"
            ? "데이터를 불러오고 있습니다."
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
            registerNode={registerThreadListItemNode}
            reorderActive={draggingThreadId === thread.id}
            transitionLocked={lockThreadListDropLayout || Boolean(optimisticThreadOrderByProjectId[selectedProjectId])}
            reorderOffsetY={
              draggingThreadId === thread.id ? draggingThreadOffsetY : resolveThreadListItemSlideOffsetY(thread.id)
            }
            onStartReorder={handleThreadReorderStart}
            onMoveReorder={handleThreadReorderMove}
            onEndReorder={handleThreadReorderEnd}
            onCancelReorder={handleThreadReorderCancel}
            onOpen={onSelectThread}
            onRename={onOpenThreadInstructionDialog}
            onDelete={(targetThread) => void onDeleteThread(targetThread.id)}
            onToggleSelect={handleToggleThreadSelection}
            onEnterSelectionMode={handleEnterThreadSelectionMode}
          />
        ))
      )}
    </>
  );
  const threadCreateActionButtons = !isTodoScope ? (
    <div className="flex w-full items-center gap-3">
      <button
        type="button"
        data-testid="thread-create-instant-button"
        onClick={() => void onCreateInstantThread()}
        disabled={!selectedProject || !bridgeAvailable || threadBusy}
        className="flex-[2_1_0%] rounded-full bg-rose-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-45"
      >
        +인스턴트
      </button>
      <button
        type="button"
        data-testid="thread-create-button"
        onClick={() => onOpenNewThread(selectedProjectId)}
        disabled={!selectedProject || !bridgeAvailable || threadBusy}
        className="flex-[3_1_0%] rounded-full bg-telegram-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-45"
      >
        +채팅
      </button>
    </div>
  ) : null;
  const actionBarContent =
    threadSelectionMode && !isTodoScope ? (
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
      <div className="flex w-full items-center gap-3">
        {!isTodoScope ? (
          threadCreateActionButtons
        ) : (
          <button
            type="button"
            onClick={() => onOpenNewTodoChat()}
            disabled={threadBusy}
            className="w-full rounded-full bg-telegram-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-45"
          >
            + ToDo 채팅
          </button>
        )}
      </div>
    );
  const appChrome = (
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
            <h1 className="truncate text-base font-semibold text-white">{appHeaderTitle}</h1>
            <div className="mt-0.5">
              <BridgeDropdown
                bridges={bridges}
                selectedBridgeId={selectedBridgeId}
                bridgeSignal={bridgeSignal}
                onSelectBridge={onSelectBridge}
                onOpen={onOpenBridgeDropdown}
                syncing={bridgeListSyncing}
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

      {projectChipRow}
    </div>
  );
  const mainOverlays = (
    <>
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
      <ProjectActionSheet
        open={Boolean(projectActionTarget)}
        project={projectActionTarget}
        busy={projectEditBusy || projectBusy}
        onClose={() => setProjectActionProjectId("")}
        onEdit={() => {
          if (!projectActionTarget) {
            return;
          }

          setProjectActionProjectId("");
          onOpenProjectEditDialog(projectActionTarget);
        }}
        onDelete={() => requestProjectDeletion(projectActionTarget)}
      />
      <UtilitySheet
        open={utilityOpen}
        session={session}
        bridgeSignal={bridgeSignal}
        selectedProject={selectedProject}
        pushNotificationCard={pushNotificationCard}
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
      <ThreadCreateDialog
        open={threadCreateDialogOpen}
        busy={threadBusy}
        project={selectedProject}
        onClose={onCloseThreadCreateDialog}
        onSubmit={onSubmitThreadCreateDialog}
      />
      <ProjectInstructionDialog
        open={projectInstructionDialogOpen}
        busy={projectInstructionBusy}
        project={selectedProject}
        instructionType={projectInstructionType}
        onClose={onCloseProjectInstructionDialog}
        onSubmit={onSubmitProjectInstruction}
      />
      <ProjectEditDialog
        open={projectEditDialogOpen}
        busy={projectEditBusy}
        deleteBusy={projectBusy}
        project={projectEditTarget}
        errorMessage={projectEditError}
        onClose={onCloseProjectEditDialog}
        onSubmit={onSubmitProjectEdit}
        onDelete={(project) => requestProjectDeletion(project)}
      />
      <ThreadEditDialog
        open={threadInstructionDialogOpen}
        busy={threadInstructionBusy}
        thread={threadInstructionTarget}
        project={threadInstructionProject}
        threadInstructionSupported={threadInstructionSupported}
        errorMessage={threadInstructionError}
        onClose={onCloseThreadInstructionDialog}
        onSubmit={onSubmitThreadInstruction}
      />
    </>
  );

  if (!showWideTodoSplitLayout && activeView === "todo" && selectedTodoChatId) {
    return (
      <div className="telegram-shell min-h-screen bg-slate-950 text-slate-100">
        <TodoChatDetail
          chat={selectedTodoChat ?? todoChatDetail?.chat ?? null}
          bridgeId={selectedBridgeId}
          messages={todoChatMessages}
          loading={todoChatLoading}
          error={todoChatError}
          submitBusy={todoBusy}
          composerDraftKey={todoComposerDraftKey}
          composerDraft={todoComposerDraft}
          onPersistComposerDraft={onChangeThreadComposerDraft}
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

  if (showWideSplitLayout) {
    return (
      <div
        className="telegram-shell overflow-hidden bg-slate-950 text-slate-100"
        style={{ height: "var(--app-stable-viewport-height)" }}
        data-testid="thread-split-layout"
      >
        <div className="mx-auto flex h-full min-h-0 w-full flex-col">
          {appChrome}
          <main
            ref={wideThreadSplitLayoutRef}
            className="grid min-h-0 flex-1 overflow-hidden px-4 pb-4 pt-3"
            style={{
              gridTemplateColumns: wideThreadSplitResizeEnabled
                ? `minmax(${MOBILE_WIDE_THREAD_SPLIT_MIN_PANE_WIDTH_PX}px, ${wideThreadSplitLeftWeight}fr) 22px minmax(${MOBILE_WIDE_THREAD_SPLIT_MIN_PANE_WIDTH_PX}px, ${wideThreadSplitRightWeight}fr)`
                : "minmax(0, 1fr) minmax(0, 1fr)",
              columnGap: wideThreadSplitResizeEnabled ? "0px" : "1rem"
            }}
          >
            <section
              data-testid="thread-list-pane"
              className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/72 shadow-2xl shadow-black/20"
            >
              <div data-testid="thread-list-scroll" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3">
                <section className="mt-1">{inboxListContent}</section>
              </div>
              <div
                data-testid="thread-list-footer"
                className="shrink-0 border-t border-white/10 bg-slate-950/92 px-4 py-3 backdrop-blur"
              >
                {actionBarContent}
              </div>
            </section>

            {wideThreadSplitResizeEnabled ? (
              <div className="flex min-h-0 items-center justify-center">
                <button
                  type="button"
                  data-testid="thread-split-resizer"
                  aria-label="좌우 패널 크기 조절"
                  onPointerDown={handleWideThreadSplitResizePointerDown}
                  onPointerMove={handleWideThreadSplitResizePointerMove}
                  onPointerUp={handleWideThreadSplitResizePointerUp}
                  onPointerCancel={handleWideThreadSplitResizePointerUp}
                  className="group flex h-full min-h-0 w-full touch-none items-center justify-center bg-transparent"
                  style={{ cursor: "col-resize" }}
                >
                  <span className="relative flex h-full w-full items-center justify-center">
                    <span className="h-full w-px bg-white/8 transition group-hover:bg-white/18" />
                    <span className="absolute flex h-12 w-4 items-center justify-center rounded-full border border-white/10 bg-slate-900/92 shadow-lg shadow-black/30 backdrop-blur">
                      <span className="h-5 w-px bg-white/20" />
                      <span className="ml-1 h-5 w-px bg-white/20" />
                    </span>
                  </span>
                </button>
              </div>
            ) : null}

            <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/80 shadow-2xl shadow-black/20">
              {isTodoScope ? (
                selectedTodoChatId ? (
                  <TodoChatDetail
                    chat={selectedTodoChat ?? todoChatDetail?.chat ?? null}
                    bridgeId={selectedBridgeId}
                    messages={todoChatMessages}
                    loading={todoChatLoading}
                    error={todoChatError}
                    submitBusy={todoBusy}
                    composerDraftKey={todoComposerDraftKey}
                    composerDraft={todoComposerDraft}
                    onPersistComposerDraft={onChangeThreadComposerDraft}
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
                    showBackButton={false}
                    standalone={false}
                  />
                ) : (
                  <div className="flex h-full min-h-0 flex-col items-center justify-center px-8 text-center">
                    <div className="max-w-md rounded-[2rem] border border-dashed border-white/15 bg-white/[0.03] px-6 py-8">
                      <p className="text-base font-semibold text-white">ToDo 채팅을 선택해 주세요.</p>
                      <p className="mt-3 text-sm leading-6 text-slate-300">
                        좌측 목록에서 기존 ToDo를 열거나 새 ToDo 채팅을 만들어 분할 화면에서 바로 이어서 작업할 수 있습니다.
                      </p>
                    </div>
                  </div>
                )
              ) : (
                <ThreadDetail
                  thread={resolvedThread}
                  project={threadProject}
                  bridgeId={selectedBridgeId}
                  messages={resolvedThread ? threadDetailMessages : []}
                  issues={resolvedThread ? threadDetail?.issues ?? [] : []}
                  historyLoading={threadDetail?.history_loading ?? false}
                  historyError={threadDetail?.history_error ?? ""}
                  hasOlderMessages={Boolean(resolvedThread?.id) && hasOlderMessages}
                  remainingHistoryCount={remainingHistoryCount}
                  onLoadOlderMessages={resolvedThread?.id ? () => onLoadOlderMessages?.(resolvedThread.id) : null}
                  signalNow={signalNow}
                  messagesLoading={threadDetailLoading}
                  messagesError={threadDetailError}
                  onRefreshMessages={resolvedThread?.id ? onRefreshThreadDetail : null}
                  onStopThreadExecution={resolvedThread?.id ? onStopThreadExecution : null}
                  onInterruptIssue={resolvedThread?.id ? onInterruptThreadIssue : null}
                  onRetryIssue={resolvedThread?.id ? onRetryThreadIssue : null}
                  onDeleteIssue={resolvedThread?.id ? onDeleteThreadIssue : null}
                  threadInstructionSupported={threadInstructionSupported}
                  onSubmitPrompt={(payload) => {
                    if (resolvedThread?.id) {
                      return onAppendThreadMessage(resolvedThread.id, payload);
                    }

                    return onCreateThread(payload, { stayOnThread: true });
                  }}
                  submitBusy={threadBusy}
                  onBack={onBackToInbox}
                  messageFilter={threadMessageFilter}
                  onChangeMessageFilter={onChangeThreadMessageFilter}
                  composerDraftKey={threadComposerDraftKey}
                  composerDraft={threadComposerDraft}
                  onPersistComposerDraft={onChangeThreadComposerDraft}
                  isDraft={!selectedThread && !threadDetail?.thread}
                  showBackButton={false}
                  standalone={false}
                  emptyStateMessage={splitThreadEmptyStateMessage}
                />
              )}
            </section>
          </main>
        </div>
        {mainOverlays}
      </div>
    );
  }

  if (activeView === "thread" && (resolvedThread || draftProject || selectedThreadId)) {
    return (
      <div className="telegram-shell min-h-screen bg-slate-950 text-slate-100">
        <ThreadDetail
          thread={resolvedThread}
          project={threadProject}
          bridgeId={selectedBridgeId}
          messages={resolvedThread ? threadDetailMessages : []}
          issues={resolvedThread ? threadDetail?.issues ?? [] : []}
          historyLoading={threadDetail?.history_loading ?? false}
          historyError={threadDetail?.history_error ?? ""}
          hasOlderMessages={Boolean(resolvedThread?.id) && hasOlderMessages}
          remainingHistoryCount={remainingHistoryCount}
          onLoadOlderMessages={resolvedThread?.id ? () => onLoadOlderMessages?.(resolvedThread.id) : null}
          signalNow={signalNow}
          messagesLoading={threadDetailLoading}
          messagesError={threadDetailError}
          onRefreshMessages={resolvedThread?.id ? onRefreshThreadDetail : null}
          onStopThreadExecution={resolvedThread?.id ? onStopThreadExecution : null}
          onInterruptIssue={resolvedThread?.id ? onInterruptThreadIssue : null}
          onRetryIssue={resolvedThread?.id ? onRetryThreadIssue : null}
          onDeleteIssue={resolvedThread?.id ? onDeleteThreadIssue : null}
          threadInstructionSupported={threadInstructionSupported}
          onSubmitPrompt={(payload) => {
            if (resolvedThread?.id) {
              return onAppendThreadMessage(resolvedThread.id, payload);
            }

            return onCreateThread(payload, { stayOnThread: true });
          }}
          submitBusy={threadBusy}
          onBack={onBackToInbox}
          messageFilter={threadMessageFilter}
          onChangeMessageFilter={onChangeThreadMessageFilter}
          composerDraftKey={threadComposerDraftKey}
          composerDraft={threadComposerDraft}
          onPersistComposerDraft={onChangeThreadComposerDraft}
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
                <h1 className="truncate text-base font-semibold text-white">{appHeaderTitle}</h1>
                <div className="mt-0.5">
                  <BridgeDropdown
                    bridges={bridges}
                    selectedBridgeId={selectedBridgeId}
                    bridgeSignal={bridgeSignal}
                    onSelectBridge={onSelectBridge}
                    onOpen={onOpenBridgeDropdown}
                    syncing={bridgeListSyncing}
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

          {projectChipRow}
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
                {!bridgeAvailable ? (
                  <div className="px-2 py-10 text-center text-sm leading-7 text-slate-400">
                    브릿지가 연결되지 않아 채팅창 목록을 표시할 수 없습니다.
                  </div>
                ) : filteredThreads.length === 0 ? (
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
                        registerNode={registerThreadListItemNode}
                        reorderActive={draggingThreadId === thread.id}
                        transitionLocked={lockThreadListDropLayout || Boolean(optimisticThreadOrderByProjectId[selectedProjectId])}
                        reorderOffsetY={
                          draggingThreadId === thread.id ? draggingThreadOffsetY : resolveThreadListItemSlideOffsetY(thread.id)
                        }
                      onStartReorder={handleThreadReorderStart}
                      onMoveReorder={handleThreadReorderMove}
                      onEndReorder={handleThreadReorderEnd}
                      onCancelReorder={handleThreadReorderCancel}
                      onOpen={onSelectThread}
                      onRename={onOpenThreadInstructionDialog}
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

        <div className="telegram-safe-bottom-panel fixed inset-x-0 bottom-0 z-30 mx-auto flex w-full max-w-3xl justify-center border-t border-white/10 bg-slate-950/92 px-4 pt-2 backdrop-blur">
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
            isTodoScope ? (
              <button
                type="button"
                onClick={() => onOpenNewTodoChat()}
                disabled={threadBusy}
                className="w-full rounded-full bg-telegram-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-45"
              >
                새 ToDo 채팅
              </button>
            ) : (
              threadCreateActionButtons
            )
          )}
        </div>
      </div>
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
      <ProjectActionSheet
        open={Boolean(projectActionTarget)}
        project={projectActionTarget}
        busy={projectEditBusy || projectBusy}
        onClose={() => setProjectActionProjectId("")}
        onEdit={() => {
          if (!projectActionTarget) {
            return;
          }

          setProjectActionProjectId("");
          onOpenProjectEditDialog(projectActionTarget);
        }}
        onDelete={() => requestProjectDeletion(projectActionTarget)}
      />
      <UtilitySheet
        open={utilityOpen}
        session={session}
        bridgeSignal={bridgeSignal}
        selectedProject={selectedProject}
        pushNotificationCard={pushNotificationCard}
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
      <ThreadCreateDialog
        open={threadCreateDialogOpen}
        busy={threadBusy}
        project={selectedProject}
        onClose={onCloseThreadCreateDialog}
        onSubmit={onSubmitThreadCreateDialog}
      />
      <ProjectInstructionDialog
        open={projectInstructionDialogOpen}
        busy={projectInstructionBusy}
        project={selectedProject}
        instructionType={projectInstructionType}
        onClose={onCloseProjectInstructionDialog}
        onSubmit={onSubmitProjectInstruction}
      />
      <ProjectEditDialog
        open={projectEditDialogOpen}
        busy={projectEditBusy}
        deleteBusy={projectBusy}
        project={projectEditTarget}
        errorMessage={projectEditError}
        onClose={onCloseProjectEditDialog}
        onSubmit={onSubmitProjectEdit}
        onDelete={(project) => requestProjectDeletion(project)}
      />
      <ThreadEditDialog
        open={threadInstructionDialogOpen}
        busy={threadInstructionBusy}
        thread={threadInstructionTarget}
        project={threadInstructionProject}
        threadInstructionSupported={threadInstructionSupported}
        errorMessage={threadInstructionError}
        onClose={onCloseThreadInstructionDialog}
        onSubmit={onSubmitThreadInstruction}
      />
    </div>
  );
}

export default function App() {
  useStableViewportMetrics();
  const initialSessionRef = useRef(undefined);
  const initialSelectedBridgeIdRef = useRef(undefined);
  const initialWorkspaceLayoutRef = useRef(undefined);
  const initialWorkspaceSnapshotRef = useRef(undefined);
  const initialThreadDetailsRef = useRef(undefined);

  if (initialSessionRef.current === undefined) {
    const initialSession = typeof window === "undefined" ? null : readStoredSession();
    const initialSelectedBridgeId = typeof window === "undefined" ? "" : readStoredBridgeId();

    initialSessionRef.current = initialSession;
    initialSelectedBridgeIdRef.current = initialSelectedBridgeId;
    initialWorkspaceLayoutRef.current = readStoredMobileWorkspaceLayout({
      loginId: initialSession?.loginId ?? "",
      bridgeId: initialSelectedBridgeId
    });
    initialWorkspaceSnapshotRef.current = readStoredWorkspaceSnapshot({
      loginId: initialSession?.loginId ?? "",
      bridgeId: initialSelectedBridgeId
    });
    initialThreadDetailsRef.current = readStoredThreadDetailCache({
      loginId: initialSession?.loginId ?? "",
      bridgeId: initialSelectedBridgeId
    });
  }

  const [session, setSession] = useState(() => initialSessionRef.current);
  const [loginState, setLoginState] = useState({ loading: false, error: "" });
  const [bridges, setBridges] = useState([]);
  const [bridgeStatusById, setBridgeStatusById] = useState({});
  const [projects, setProjects] = useState(() => initialWorkspaceSnapshotRef.current?.projects ?? []);
  const [threads, setThreads] = useState(() =>
    resolveThreadsForScopeFromSnapshot(initialWorkspaceSnapshotRef.current, initialWorkspaceLayoutRef.current?.selectedScope)
  );
  const [threadListsByProjectId, setThreadListsByProjectId] = useState(
    () => initialWorkspaceSnapshotRef.current?.threadListsByProjectId ?? {}
  );
  const [todoChats, setTodoChats] = useState(() => initialWorkspaceSnapshotRef.current?.todoChats ?? []);
  const [threadDetails, setThreadDetails] = useState(() => initialThreadDetailsRef.current ?? {});
  const [todoChatDetails, setTodoChatDetails] = useState({});
  const [workspaceRoots, setWorkspaceRoots] = useState([]);
  const [folderState, setFolderState] = useState({ path: "", parent_path: null, entries: [] });
  const [folderLoading, setFolderLoading] = useState(false);
  const [selectedWorkspacePath, setSelectedWorkspacePath] = useState("");
  const [selectedBridgeId, setSelectedBridgeId] = useState(() => initialSelectedBridgeIdRef.current);
  const [selectedScope, setSelectedScope] = useState(() => initialWorkspaceLayoutRef.current.selectedScope);
  const [selectedThreadId, setSelectedThreadId] = useState(() => initialWorkspaceLayoutRef.current.selectedThreadId);
  const [instantThreadId, setInstantThreadId] = useState(() => initialWorkspaceLayoutRef.current.instantThreadId);
  const pendingPushDeepLinkRef = useRef(readPushDeepLink());
  const [selectedTodoChatId, setSelectedTodoChatId] = useState(() => initialWorkspaceLayoutRef.current.selectedTodoChatId);
  const [draftThreadProjectId, setDraftThreadProjectId] = useState(() => initialWorkspaceLayoutRef.current.draftThreadProjectId);
  const [threadComposerDrafts, setThreadComposerDrafts] = useState(
    () => initialWorkspaceLayoutRef.current.threadComposerDrafts
  );
  const [projectFilterUsage, setProjectFilterUsage] = useState(
    () => initialWorkspaceLayoutRef.current.projectFilterUsage ?? {}
  );
  const [projectChipOrder, setProjectChipOrder] = useState(
    () => initialWorkspaceLayoutRef.current.projectChipOrder ?? []
  );
  const [threadOrderByProjectId, setThreadOrderByProjectId] = useState(
    () => initialWorkspaceLayoutRef.current.threadOrderByProjectId ?? {}
  );
  const [search, setSearch] = useState("");
  const [loadingState, setLoadingState] = useState("idle");
  const [utilityOpen, setUtilityOpen] = useState(false);
  const [projectComposerOpen, setProjectComposerOpen] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const [threadCreateDialogOpen, setThreadCreateDialogOpen] = useState(false);
  const [projectInstructionDialogOpen, setProjectInstructionDialogOpen] = useState(false);
  const [projectInstructionBusy, setProjectInstructionBusy] = useState(false);
  const [projectInstructionType, setProjectInstructionType] = useState("base");
  const [projectEditDialogOpen, setProjectEditDialogOpen] = useState(false);
  const [projectEditBusy, setProjectEditBusy] = useState(false);
  const [projectEditError, setProjectEditError] = useState("");
  const [projectEditTargetId, setProjectEditTargetId] = useState("");
  const [threadInstructionDialogOpen, setThreadInstructionDialogOpen] = useState(false);
  const [threadInstructionBusy, setThreadInstructionBusy] = useState(false);
  const [threadInstructionError, setThreadInstructionError] = useState("");
  const [threadInstructionTarget, setThreadInstructionTarget] = useState(null);
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
  const [activeView, setActiveView] = useState(() => initialWorkspaceLayoutRef.current.activeView);
  const [threadMessageFilter, setThreadMessageFilter] = useState("all");
  const [bridgeListSyncing, setBridgeListSyncing] = useState(false);
  const [streamActivityAt, setStreamActivityAt] = useState(null);
  const [streamNow, setStreamNow] = useState(() => Date.now());
  const [eventStreamReconnectToken, setEventStreamReconnectToken] = useState(0);
  const [deferredInstallPrompt, setDeferredInstallPrompt] = useState(null);
  const [installPromptVisible, setInstallPromptVisible] = useState(false);
  const [installBusy, setInstallBusy] = useState(false);
  const [pwaUpdateVisible, setPwaUpdateVisible] = useState(false);
  const [pwaUpdateBusy, setPwaUpdateBusy] = useState(false);
  const [mobileNotices, setMobileNotices] = useState([]);
  const [mobileConfirmState, setMobileConfirmState] = useState({
    open: false,
    title: "",
    message: "",
    confirmLabel: "확인",
    cancelLabel: "취소",
    tone: "default"
  });
  const [bridgeDisconnectOverrideById, setBridgeDisconnectOverrideById] = useState({});
  const viewportWidth = useVisualViewportWidth();
  const wideThreadSplitEnabled = viewportWidth >= MOBILE_WIDE_THREAD_SPLIT_MIN_WIDTH_PX;
  const activeViewRef = useRef(activeView);
  const pendingUpdateActivatorRef = useRef(null);
  const pwaUpdateActivationInFlightRef = useRef(false);
  const standaloneBackNavigationInFlightRef = useRef(false);
  const allowStandaloneNativeBackRef = useRef(false);
  const threadLoadRequestIdByIdRef = useRef(new Map());
  const todoChatLoadRequestIdRef = useRef(0);
  const threadReloadTimersByIdRef = useRef(new Map());
  const threadReloadMetaByIdRef = useRef(new Map());
  const threadDetailsPersistTimerRef = useRef(null);
  const threadPreloadRunIdRef = useRef(0);
  const threadHistoryLoadRequestIdByIdRef = useRef(new Map());
  const projectThreadListPromiseByKeyRef = useRef(new Map());
  const threadLiveProgressAtByIdRef = useRef(new Map());
  const scheduleThreadMessagesReloadRef = useRef(null);
  const activeIssuePollFailureStateRef = useRef({
    threadId: "",
    issueId: "",
    consecutiveFailures: 0,
    nextRetryAt: 0,
    lastRecoveryAttemptAt: 0
  });
  const lastForegroundResumeAtRef = useRef(0);
  const scheduledResumeTimerRef = useRef(null);
  const scheduledResumeReasonsRef = useRef(new Set());
  const eventStreamReconnectTimerRef = useRef(null);
  const threadDeleteDialogResolverRef = useRef(null);
  const mobileNoticeTimersRef = useRef(new Map());
  const mobileConfirmResolverRef = useRef(null);
  const mainPageBackHandlerRef = useRef(null);
  const selectedThreadIdRef = useRef("");
  const instantThreadIdRef = useRef("");
  const selectedBridgeIdRef = useRef("");
  const selectedScopeKindRef = useRef(selectedScope.kind);
  const draftThreadProjectIdRef = useRef(draftThreadProjectId);
  const wideThreadSplitEnabledRef = useRef(wideThreadSplitEnabled);
  const utilityOpenRef = useRef(utilityOpen);
  const projectComposerOpenRef = useRef(projectComposerOpen);
  const threadCreateDialogOpenRef = useRef(threadCreateDialogOpen);
  const projectInstructionDialogOpenRef = useRef(projectInstructionDialogOpen);
  const projectInstructionBusyRef = useRef(projectInstructionBusy);
  const projectEditDialogOpenRef = useRef(projectEditDialogOpen);
  const projectEditBusyRef = useRef(projectEditBusy);
  const threadInstructionDialogOpenRef = useRef(threadInstructionDialogOpen);
  const threadInstructionBusyRef = useRef(threadInstructionBusy);
  const threadDeleteDialogOpenRef = useRef(threadDeleteDialog.open);
  const threadBusyRef = useRef(threadBusy);
  const sessionRef = useRef(session);
  const bridgeStatusByIdRef = useRef({});
  const bridgeWorkspaceRequestIdRef = useRef(0);
  const bridgeListSyncPromiseRef = useRef(null);
  const refreshBridgeStatusRef = useRef(null);
  const loadBridgeWorkspaceRef = useRef(null);
  const bridgeWorkspaceReloadedAtRef = useRef(new Map());
  const locallyInterruptedThreadIdsRef = useRef(new Set());
  const locallyInterruptedIssueIdsRef = useRef(new Set());
  const dismissMobileNotice = useCallback((noticeId) => {
    const normalizedNoticeId = String(noticeId ?? "").trim();

    if (!normalizedNoticeId) {
      return;
    }

    const timer = mobileNoticeTimersRef.current.get(normalizedNoticeId);

    if (timer) {
      window.clearTimeout(timer);
      mobileNoticeTimersRef.current.delete(normalizedNoticeId);
    }

    setMobileNotices((current) => current.filter((notice) => notice.id !== normalizedNoticeId));
  }, []);
  const showMobileAlert = useCallback(
    (message, options = {}) => {
      const normalizedMessage = String(message ?? "").trim();

      if (!normalizedMessage) {
        return "";
      }

      const tone = options.tone === "error" ? "error" : "info";
      const noticeId = createId();
      const durationMs =
        Number(options.durationMs) > 0
          ? Number(options.durationMs)
          : tone === "error"
            ? MOBILE_NOTICE_ERROR_DISMISS_MS
            : MOBILE_NOTICE_AUTO_DISMISS_MS;

      setMobileNotices((current) => [
        ...current,
        {
          id: noticeId,
          title: String(options.title ?? "").trim(),
          message: normalizedMessage,
          tone
        }
      ]);

      const timer = window.setTimeout(() => {
        dismissMobileNotice(noticeId);
      }, durationMs);

      mobileNoticeTimersRef.current.set(noticeId, timer);
      return noticeId;
    },
    [dismissMobileNotice]
  );
  const resolveMobileConfirm = useCallback((accepted) => {
    const resolver = mobileConfirmResolverRef.current;
    mobileConfirmResolverRef.current = null;
    setMobileConfirmState((current) => ({
      ...current,
      open: false
    }));
    resolver?.(accepted === true);
  }, []);
  const confirmMobileAction = useCallback((options = {}) => {
    const message = String(options.message ?? "").trim();

    if (!message) {
      return Promise.resolve(false);
    }

    if (mobileConfirmResolverRef.current) {
      mobileConfirmResolverRef.current(false);
      mobileConfirmResolverRef.current = null;
    }

    setMobileConfirmState({
      open: true,
      title: String(options.title ?? "확인").trim() || "확인",
      message,
      confirmLabel: String(options.confirmLabel ?? "확인").trim() || "확인",
      cancelLabel: String(options.cancelLabel ?? "취소").trim() || "취소",
      tone: options.tone === "danger" ? "danger" : "default"
    });

    return new Promise((resolve) => {
      mobileConfirmResolverRef.current = resolve;
    });
  }, []);
  const mobileFeedbackValue = useMemo(
    () => ({
      alert: showMobileAlert,
      confirm: confirmMobileAction
    }),
    [confirmMobileAction, showMobileAlert]
  );
  const notifyError = useCallback(
    (error, fallbackMessage = "요청을 처리하지 못했습니다.") => {
      showMobileAlert(error?.message ?? fallbackMessage, {
        tone: "error",
        title: "오류"
      });
    },
    [showMobileAlert]
  );
  const selectedBridgeKnown = !selectedBridgeId || bridges.some((bridge) => bridge.bridge_id === selectedBridgeId);

  useEffect(
    () => () => {
      mobileNoticeTimersRef.current.forEach((timer) => {
        window.clearTimeout(timer);
      });
      mobileNoticeTimersRef.current.clear();

      if (mobileConfirmResolverRef.current) {
        mobileConfirmResolverRef.current(false);
        mobileConfirmResolverRef.current = null;
      }
    },
    []
  );

  const status = useMemo(
    () => normalizeBridgeStatus(selectedBridgeId ? bridgeStatusById[selectedBridgeId] : null),
    [bridgeStatusById, selectedBridgeId]
  );
  const bridgeDisconnectEvidence = useMemo(
    () => normalizeBridgeDisconnectEvidence(selectedBridgeId ? bridgeDisconnectOverrideById[selectedBridgeId] : null),
    [bridgeDisconnectOverrideById, selectedBridgeId]
  );
  const bridgeDisconnectConfirmed = isBridgeDisconnectConfirmed(bridgeDisconnectEvidence);
  const bridgeHasDisconnectEvidence =
    bridgeDisconnectEvidence.socketDisconnectedAt > 0 ||
    bridgeDisconnectEvidence.transportFailureAt > 0 ||
    bridgeDisconnectEvidence.confirmedAt > 0 ||
    Boolean(bridgeDisconnectEvidence.lastError);
  const bridgeSocketConnected = Boolean(status?.app_server?.connected);
  const threadInstructionSupported = bridgeSupportsThreadDeveloperInstructions(status);
  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [threads, selectedThreadId]
  );
  const projectEditTarget = useMemo(
    () => projects.find((project) => project.id === projectEditTargetId) ?? null,
    [projectEditTargetId, projects]
  );
  const selectedProjectId = selectedScope.kind === "project" ? selectedScope.id : "";
  const bridgeConnected = !bridgeDisconnectConfirmed;
  const bridgeAvailable = Boolean(selectedBridgeId) && selectedBridgeKnown && bridgeConnected;
  const bridgeSignal = useMemo(
    () =>
      buildBridgeSignal({
        statusReceived: status?.bridge_status_received === true,
        socketConnected: bridgeSocketConnected,
        disconnectConfirmed: bridgeDisconnectConfirmed,
        hasDisconnectEvidence: bridgeHasDisconnectEvidence,
        lastSocketActivityAt: Date.parse(status?.app_server?.last_socket_activity_at ?? ""),
        statusUpdatedAt: Date.parse(status?.updated_at ?? ""),
        now: streamNow
      }),
    [
      bridgeHasDisconnectEvidence,
      bridgeDisconnectConfirmed,
      bridgeSocketConnected,
      status?.bridge_status_received,
      status?.app_server?.last_socket_activity_at,
      status?.updated_at,
      streamNow
    ]
  );
  const currentTodoChatDetail = todoChatDetails[selectedTodoChatId] ?? null;
  const currentThreadDetail = threadDetails[selectedThreadId] ?? null;
  const threadPanelVisible =
    Boolean(selectedThreadId) &&
    selectedScope.kind === "project" &&
    (activeView === "thread" || wideThreadSplitEnabled);
  const threadPanelVisibleRef = useRef(threadPanelVisible);
  const threadDetailsRef = useRef(threadDetails);
  const workspaceLayoutOwnerKey = buildWorkspaceLayoutOwnerKey(session?.loginId ?? "", selectedBridgeId);
  const workspaceLayoutOwnerKeyRef = useRef(workspaceLayoutOwnerKey);
  const updateBridgeDisconnectOverride = useCallback((bridgeId, event) => {
    const normalized = String(bridgeId ?? "").trim();

    if (!normalized) {
      return;
    }

    setBridgeDisconnectOverrideById((current) => {
      const nextEvidence = reduceBridgeDisconnectEvidence(current[normalized], event);

      if (
        nextEvidence.socketDisconnectedAt <= 0 &&
        nextEvidence.transportFailureAt <= 0 &&
        nextEvidence.confirmedAt <= 0 &&
        !nextEvidence.lastError
      ) {
        if (!current[normalized]) {
          return current;
        }

        const next = { ...current };
        delete next[normalized];
        return next;
      }

      return {
        ...current,
        [normalized]: nextEvidence
      };
    });
  }, []);
  const markBridgeSocketDisconnected = useCallback((bridgeId, message = "") => {
    updateBridgeDisconnectOverride(bridgeId, {
      type: "socket_disconnected",
      message
    });
  }, [updateBridgeDisconnectOverride]);
  const markBridgeSocketConnected = useCallback((bridgeId) => {
    updateBridgeDisconnectOverride(bridgeId, {
      type: "socket_connected"
    });
  }, [updateBridgeDisconnectOverride]);
  const markBridgeStatusDisconnected = useCallback((bridgeId, message = "") => {
    updateBridgeDisconnectOverride(bridgeId, {
      type: "status_disconnected",
      message
    });
  }, [updateBridgeDisconnectOverride]);
  const markBridgeTransportFailure = useCallback((bridgeId, message = "") => {
    updateBridgeDisconnectOverride(bridgeId, {
      type: "transport_failure",
      message
    });
  }, [updateBridgeDisconnectOverride]);
  const markBridgeTransportSuccess = useCallback((bridgeId) => {
    updateBridgeDisconnectOverride(bridgeId, {
      type: "transport_success"
    });
  }, [updateBridgeDisconnectOverride]);
  const setBridgeStatus = useCallback((bridgeId, updater) => {
    const normalizedBridgeId = String(bridgeId ?? "").trim();

    if (!normalizedBridgeId) {
      return;
    }

    setBridgeStatusById((current) => {
      const currentStatus = normalizeBridgeStatus(current[normalizedBridgeId]);
      const nextStatus = typeof updater === "function" ? updater(currentStatus) : updater;

      return {
        ...current,
        [normalizedBridgeId]: normalizeBridgeStatus(nextStatus)
      };
    });
  }, []);
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
  const holdLocalThreadInterrupt = useCallback((threadId, issueId = "") => {
    const normalizedThreadId = String(threadId ?? "").trim();
    const normalizedIssueId = String(issueId ?? "").trim();

    if (normalizedThreadId) {
      locallyInterruptedThreadIdsRef.current.add(normalizedThreadId);
    }

    if (normalizedIssueId) {
      locallyInterruptedIssueIdsRef.current.add(normalizedIssueId);
    }
  }, []);
  const releaseLocalThreadInterrupt = useCallback((threadId, issueId = "") => {
    const normalizedThreadId = String(threadId ?? "").trim();
    const normalizedIssueId = String(issueId ?? "").trim();

    if (normalizedThreadId) {
      locallyInterruptedThreadIdsRef.current.delete(normalizedThreadId);
    }

    if (normalizedIssueId) {
      locallyInterruptedIssueIdsRef.current.delete(normalizedIssueId);
    }
  }, []);
  const isLocalThreadInterruptHeld = useCallback((threadId, issueId = "") => {
    const normalizedThreadId = String(threadId ?? "").trim();
    const normalizedIssueId = String(issueId ?? "").trim();

    if (normalizedThreadId && locallyInterruptedThreadIdsRef.current.has(normalizedThreadId)) {
      return true;
    }

    if (normalizedIssueId && locallyInterruptedIssueIdsRef.current.has(normalizedIssueId)) {
      return true;
    }

    return false;
  }, []);
  const applyThreadDetailSnapshot = useCallback((threadId, { thread = undefined, issues = undefined } = {}) => {
    const normalizedThreadId = String(threadId ?? "").trim();

    if (!normalizedThreadId) {
      return;
    }

    const normalizedThread = thread === undefined ? undefined : normalizeThread(thread);
    const hasIssues = Array.isArray(issues);
    const normalizedIssues = hasIssues
      ? issues.map((issue) => normalizeIssue(issue, normalizedThreadId)).filter(Boolean)
      : null;

    setThreadDetails((current) => {
      const currentEntry = current[normalizedThreadId] ?? null;

      if (!currentEntry && normalizedThread === null && !hasIssues) {
        return current;
      }

      return {
        ...current,
        [normalizedThreadId]: {
          ...(currentEntry ?? {}),
          ...(normalizedThread !== undefined ? { thread: normalizedThread } : {}),
          ...(hasIssues ? { issues: normalizedIssues } : {}),
          loading: false,
          error: currentEntry?.error ?? ""
        }
      };
    });

    if (normalizedThread) {
      setThreads((current) => upsertThread(current, normalizedThread));

      if (normalizedThread.project_id) {
        setThreadListsByProjectId((current) => ({
          ...current,
          [normalizedThread.project_id]: upsertThread(current[normalizedThread.project_id] ?? [], normalizedThread)
        }));
      }
    }
  }, []);
  const updateThreadComposerDraft = useCallback((draftKey, nextValue) => {
    const normalizedDraftKey = String(draftKey ?? "").trim();

    if (!normalizedDraftKey) {
      return;
    }

    setThreadComposerDrafts((current) => {
      const currentValue = current[normalizedDraftKey] ?? "";
      const resolvedValue = typeof nextValue === "function" ? nextValue(currentValue) : nextValue;
      const normalizedValue = typeof resolvedValue === "string" ? resolvedValue : String(resolvedValue ?? "");

      if (!normalizedValue) {
        if (!Object.prototype.hasOwnProperty.call(current, normalizedDraftKey)) {
          return current;
        }

        const next = { ...current };
        delete next[normalizedDraftKey];
        return next;
      }

      if (currentValue === normalizedValue) {
        return current;
      }

      return {
        ...current,
        [normalizedDraftKey]: normalizedValue
      };
    });
  }, []);
  const removeThreadComposerDrafts = useCallback((draftKeys) => {
    const normalizedDraftKeys = [...new Set(draftKeys.map((draftKey) => String(draftKey ?? "").trim()).filter(Boolean))];

    if (normalizedDraftKeys.length === 0) {
      return;
    }

    setThreadComposerDrafts((current) => {
      let changed = false;
      const next = { ...current };

      normalizedDraftKeys.forEach((draftKey) => {
        if (Object.prototype.hasOwnProperty.call(next, draftKey)) {
          delete next[draftKey];
          changed = true;
        }
      });

      return changed ? next : current;
    });
  }, []);
  const removeDeletedThreadsFromState = useCallback((threadIds) => {
    const normalizedThreadIds = [...new Set(threadIds.map((threadId) => String(threadId ?? "").trim()).filter(Boolean))];

    if (normalizedThreadIds.length === 0) {
      return;
    }

    clearThreadTransientState(normalizedThreadIds);
    removeThreadComposerDrafts(normalizedThreadIds.map((threadId) => buildThreadComposerDraftKey({ threadId })));
    setThreads((current) => removeThreadsByIds(current, normalizedThreadIds));
    setThreadListsByProjectId((current) => removeThreadIdsFromProjectCache(current, normalizedThreadIds));
    setThreadOrderByProjectId((current) => {
      let changed = false;
      const next = {};

      Object.entries(current ?? {}).forEach(([projectId, threadOrder]) => {
        const currentThreadOrder = normalizeThreadOrder(threadOrder);
        const nextThreadOrder = currentThreadOrder.filter((threadId) => !normalizedThreadIds.includes(threadId));

        if (!areStringArraysEqual(currentThreadOrder, nextThreadOrder)) {
          changed = true;
        }

        if (nextThreadOrder.length > 0) {
          next[projectId] = nextThreadOrder;
        }
      });

      return changed ? next : current;
    });
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

    if (normalizedThreadIds.includes(instantThreadIdRef.current)) {
      setInstantThreadId("");
    }
  }, [clearThreadTransientState, removeThreadComposerDrafts]);

  const clearInstantThread = useCallback(async (threadId = "") => {
    const targetThreadId = String(threadId ?? instantThreadIdRef.current ?? "").trim();

    if (!targetThreadId || !session?.loginId || !selectedBridgeId) {
      if (targetThreadId) {
        setInstantThreadId((current) => (current === targetThreadId ? "" : current));
        removeDeletedThreadsFromState([targetThreadId]);
      }

      return true;
    }

    removeDeletedThreadsFromState([targetThreadId]);

    try {
      await apiRequest(
        `/api/threads/${encodeURIComponent(targetThreadId)}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "DELETE"
        }
      );
    } catch {
      // 인스턴트 채팅은 UI 제거를 우선 보장하고, 삭제 실패는 UI 동작을 막지 않음
    }

    return true;
  }, [apiRequest, removeDeletedThreadsFromState, session?.loginId, selectedBridgeId]);

  const clearInstantThreadIfNeeded = useCallback(async (nextThreadId = "", options = {}) => {
    const normalizedNextThreadId = String(nextThreadId ?? "").trim();
    const currentInstantThreadId = String(instantThreadIdRef.current ?? "").trim();

    if (!currentInstantThreadId || currentInstantThreadId === normalizedNextThreadId) {
      return true;
    }

    const requireRunningConfirmation = options.requireRunningConfirmation === true;
    const currentInstantThread = pickPreferredThreadSnapshot(
      threadDetailsRef.current[currentInstantThreadId]?.thread ?? null,
      threads.find((thread) => thread.id === currentInstantThreadId) ?? null
    );

    if (isThreadExecutionInProgress(currentInstantThread)) {
      if (!requireRunningConfirmation) {
        return false;
      }

      const confirmed = await confirmMobileAction({
        title: "진행 중인 인스턴트 채팅 교체",
        message:
          "현재 인스턴트 채팅은 아직 작업 중입니다. 새 인스턴트 채팅으로 교체하면 기존 인스턴트 채팅의 작업을 중단하고 삭제합니다. 계속하시겠습니까?",
        confirmLabel: "중단 후 교체",
        cancelLabel: "취소",
        tone: "danger"
      });

      if (!confirmed) {
        return false;
      }
    }

    await clearInstantThread(currentInstantThreadId);
    return true;
  }, [clearInstantThread, confirmMobileAction, threads]);
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
      [normalizedProjectId]: mergeThreads(current[normalizedProjectId] ?? [], nextThreads)
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
  const selectProjectScope = useCallback((projectId, options = {}) => {
    void options;
    const normalizedProjectId = String(projectId ?? "").trim();

    setSelectedScope({ kind: "project", id: normalizedProjectId });
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
  const resetActiveIssuePollFailureState = useCallback((threadId = "", issueId = "") => {
    activeIssuePollFailureStateRef.current = {
      threadId: String(threadId ?? "").trim(),
      issueId: String(issueId ?? "").trim(),
      consecutiveFailures: 0,
      nextRetryAt: 0,
      lastRecoveryAttemptAt: 0
    };
  }, []);
  const getActiveIssuePollFailureState = useCallback((threadId = "", issueId = "") => {
    const normalizedThreadId = String(threadId ?? "").trim();
    const normalizedIssueId = String(issueId ?? "").trim();
    const currentState = activeIssuePollFailureStateRef.current;

    if (currentState.threadId === normalizedThreadId && currentState.issueId === normalizedIssueId) {
      return currentState;
    }

    return {
      threadId: normalizedThreadId,
      issueId: normalizedIssueId,
      consecutiveFailures: 0,
      nextRetryAt: 0,
      lastRecoveryAttemptAt: 0
    };
  }, []);
  const selectedProjectIdRef = useRef(selectedProjectId);
  const selectedTodoChatIdRef = useRef(selectedTodoChatId);

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  useEffect(() => {
    instantThreadIdRef.current = instantThreadId;
  }, [instantThreadId]);

  useEffect(() => {
    activeViewRef.current = activeView;
  }, [activeView]);

  useEffect(() => {
    draftThreadProjectIdRef.current = draftThreadProjectId;
  }, [draftThreadProjectId]);

  useEffect(() => {
    selectedScopeKindRef.current = selectedScope.kind;
  }, [selectedScope.kind]);

  useEffect(() => {
    wideThreadSplitEnabledRef.current = wideThreadSplitEnabled;
  }, [wideThreadSplitEnabled]);

  useEffect(() => {
    threadPanelVisibleRef.current = threadPanelVisible;
  }, [threadPanelVisible]);

  useEffect(() => {
    selectedBridgeIdRef.current = selectedBridgeId;
    storeSelectedBridgeId(selectedBridgeId);
  }, [selectedBridgeId]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    bridgeStatusByIdRef.current = bridgeStatusById;
  }, [bridgeStatusById]);

  useEffect(() => {
    threadDetailsRef.current = threadDetails;
  }, [threadDetails]);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  useEffect(() => {
    selectedTodoChatIdRef.current = selectedTodoChatId;
  }, [selectedTodoChatId]);

  useEffect(() => {
    utilityOpenRef.current = utilityOpen;
  }, [utilityOpen]);

  useEffect(() => {
    projectComposerOpenRef.current = projectComposerOpen;
  }, [projectComposerOpen]);

  useEffect(() => {
    threadCreateDialogOpenRef.current = threadCreateDialogOpen;
  }, [threadCreateDialogOpen]);

  useEffect(() => {
    projectInstructionDialogOpenRef.current = projectInstructionDialogOpen;
  }, [projectInstructionDialogOpen]);

  useEffect(() => {
    projectInstructionBusyRef.current = projectInstructionBusy;
  }, [projectInstructionBusy]);

  useEffect(() => {
    projectEditDialogOpenRef.current = projectEditDialogOpen;
  }, [projectEditDialogOpen]);

  useEffect(() => {
    projectEditBusyRef.current = projectEditBusy;
  }, [projectEditBusy]);

  useEffect(() => {
    threadInstructionDialogOpenRef.current = threadInstructionDialogOpen;
  }, [threadInstructionDialogOpen]);

  useEffect(() => {
    threadInstructionBusyRef.current = threadInstructionBusy;
  }, [threadInstructionBusy]);

  useEffect(() => {
    threadDeleteDialogOpenRef.current = threadDeleteDialog.open;
  }, [threadDeleteDialog.open]);

  useEffect(() => {
    threadBusyRef.current = threadBusy;
  }, [threadBusy]);

  useEffect(() => {
    const knownThreadsById = new Map();
    const registerThread = (thread) => {
      const normalizedThread = normalizeThread(thread);

      if (!normalizedThread?.id) {
        return;
      }

      knownThreadsById.set(
        normalizedThread.id,
        pickPreferredThreadSnapshot(knownThreadsById.get(normalizedThread.id) ?? null, normalizedThread)
      );
    };

    threads.forEach(registerThread);
    Object.values(threadListsByProjectId ?? {}).forEach((threadList) => {
      if (!Array.isArray(threadList)) {
        return;
      }

      threadList.forEach(registerThread);
    });
    Object.values(threadDetails ?? {}).forEach((detail) => {
      registerThread(detail?.thread ?? null);
    });

    const currentInstantThreadId = String(instantThreadId ?? "").trim();
    const selectedKnownThread = knownThreadsById.get(selectedThreadId) ?? null;

    if (currentInstantThreadId && knownThreadsById.has(currentInstantThreadId)) {
      return;
    }

    let nextInstantThread = selectedKnownThread && isInstantThread(selectedKnownThread) ? selectedKnownThread : null;

    for (const thread of knownThreadsById.values()) {
      if (!isInstantThread(thread)) {
        continue;
      }

      nextInstantThread = pickPreferredThreadSnapshot(nextInstantThread, thread);
    }

    const nextInstantThreadId = String(nextInstantThread?.id ?? "").trim();

    if (nextInstantThreadId !== currentInstantThreadId) {
      setInstantThreadId(nextInstantThreadId);
    }
  }, [instantThreadId, selectedThreadId, threadDetails, threadListsByProjectId, threads]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    if (threadDetailsPersistTimerRef.current) {
      window.clearTimeout(threadDetailsPersistTimerRef.current);
      threadDetailsPersistTimerRef.current = null;
    }

    if (!session?.loginId || !selectedBridgeId) {
      return undefined;
    }

    threadDetailsPersistTimerRef.current = window.setTimeout(() => {
      threadDetailsPersistTimerRef.current = null;
      storeThreadDetailCache(threadDetails, {
        loginId: session.loginId,
        bridgeId: selectedBridgeId
      });
    }, 320);

    return () => {
      if (threadDetailsPersistTimerRef.current) {
        window.clearTimeout(threadDetailsPersistTimerRef.current);
        threadDetailsPersistTimerRef.current = null;
      }
    };
  }, [selectedBridgeId, session?.loginId, threadDetails]);

  useEffect(() => {
    if (!session?.loginId || !selectedBridgeId) {
      return;
    }

    storeWorkspaceSnapshot(
      {
        projects,
        todoChats,
        threadListsByProjectId
      },
      {
        loginId: session.loginId,
        bridgeId: selectedBridgeId
      }
    );
  }, [projects, selectedBridgeId, session?.loginId, threadListsByProjectId, todoChats]);

  const handleAppForegroundResume = useCallback(async (reason = "foreground_resume") => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }

    if (!session?.loginId) {
      return;
    }

    const now = Date.now();

    if (now - lastForegroundResumeAtRef.current < 1500) {
      return;
    }

    lastForegroundResumeAtRef.current = now;
    setEventStreamReconnectToken((current) => current + 1);

    const nextBridges = await loadBridges(session);
    const activeBridgeId =
      (selectedBridgeIdRef.current && nextBridges.some((bridge) => bridge.bridge_id === selectedBridgeIdRef.current))
        ? selectedBridgeIdRef.current
        : pickDefaultBridgeId(nextBridges);

    if (!activeBridgeId) {
      return;
    }

    if (activeBridgeId !== selectedBridgeIdRef.current) {
      setSelectedBridgeId(activeBridgeId);
      return;
    }

    await refreshBridgeStatusRef.current?.(session, activeBridgeId);

    if (selectedThreadIdRef.current) {
      threadLiveProgressAtByIdRef.current.delete(selectedThreadIdRef.current);
    }

    if (threadPanelVisibleRef.current && selectedThreadIdRef.current) {
      const mode =
        selectedActiveIssue && ["running", "awaiting_input"].includes(selectedActiveIssue.status ?? "")
          ? "active"
          : "full";

      scheduleThreadMessagesReloadRef.current?.(selectedThreadIdRef.current, {
        force: true,
        mode,
        delay: 0,
        suppressLoadingIndicator: true,
        bypassThrottle: true,
        reason
      });
      return;
    }

    if (selectedScope.kind === "project" && selectedProjectIdRef.current) {
      void loadProjectThreads(session, activeBridgeId, selectedProjectIdRef.current, {
        applyToInbox: true,
        preferredThreadId: selectedThreadIdRef.current
      });
    }
  }, [
    selectedActiveIssue,
    selectedBridgeId,
    selectedScope.kind,
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
      void handleAppForegroundResume(reasonLabel || reason);
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
            version: currentEntry?.version ?? null,
            history_loading: currentEntry?.history_loading ?? false,
            history_error: currentEntry?.history_error ?? "",
            loaded_issue_ids: currentEntry?.loaded_issue_ids ?? collectLoadedIssueIdsFromMessages(currentEntry?.messages ?? [])
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
        const cachedLoadedIssueIds = normalizeIssueIdList(
          [
            ...(cachedEntry?.loaded_issue_ids ?? []),
            ...collectLoadedIssueIdsFromMessages(cachedEntry?.messages ?? [])
          ],
          cachedIssues
        );
        const activeIssue = findActiveIssueForThread(cachedIssues, cachedThread?.active_physical_thread_id ?? null);
        const shouldLoadActiveIssueOnly = mode === "active" && Boolean(activeIssue);
        let issues = cachedIssues;
        let messages = cachedEntry?.messages ?? [];
        let normalizedThread = normalizeThread(cachedThread);
        let loadedIssueIds = cachedLoadedIssueIds;

        const registerActiveIssuePollSuccess = (issueId = "") => {
          if (!issueId) {
            return;
          }

          resetActiveIssuePollFailureState(threadId, issueId);
        };
        const registerActiveIssuePollFailure = (issueId = "", requestError = null) => {
          if (!issueId) {
            return;
          }

          const currentFailureState = getActiveIssuePollFailureState(threadId, issueId);
          const now = Date.now();
          const consecutiveFailures = currentFailureState.consecutiveFailures + 1;
          const backoffMs = Math.min(
            ACTIVE_ISSUE_POLL_FAILURE_BASE_BACKOFF_MS * 2 ** (consecutiveFailures - 1),
            ACTIVE_ISSUE_POLL_FAILURE_MAX_BACKOFF_MS
          );
          const shouldAttemptRecovery =
            !BRIDGE_TRANSPORT_ERROR_STATUS_CODES.has(Number(requestError?.status ?? 0)) &&
            consecutiveFailures >= ACTIVE_ISSUE_POLL_RECOVERY_FAILURE_THRESHOLD &&
            now - Number(currentFailureState.lastRecoveryAttemptAt ?? 0) >= ACTIVE_ISSUE_POLL_RECOVERY_COOLDOWN_MS;

          activeIssuePollFailureStateRef.current = {
            threadId,
            issueId,
            consecutiveFailures,
            nextRetryAt: now + backoffMs,
            lastRecoveryAttemptAt: shouldAttemptRecovery ? now : Number(currentFailureState.lastRecoveryAttemptAt ?? 0)
          };

          if (shouldAttemptRecovery) {
            window.setTimeout(() => {
              scheduleThreadMessagesReloadRef.current?.(threadId, {
                force: true,
                mode: "full",
                suppressLoadingIndicator: true,
                bypassThrottle: true,
                reason: "active_issue_poll_recovery"
              });
            }, 0);
          }
        };

        if (shouldLoadActiveIssueOnly) {
          const detail = await apiRequest(
            `/api/issues/${activeIssue.id}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`
          );
          const nextIssue = normalizeIssue(detail?.issue, threadId) ?? activeIssue;
          issues = replaceIssueInList(issues, nextIssue, threadId);

          messages = mergeIssueMessages(
            cachedEntry?.messages ?? [],
            detail?.messages ?? [],
            nextIssue,
            nextIssue.updated_at ?? nextIssue.created_at ?? new Date().toISOString()
          );
          normalizedThread = normalizeThread(detail?.thread) ?? normalizedThread;
          loadedIssueIds = normalizeIssueIdList([...cachedLoadedIssueIds, nextIssue.id], issues);
          registerActiveIssuePollSuccess(nextIssue.id);
        } else {
          const issueList = await apiRequest(
            `/api/threads/${threadId}/issues?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`
          );
          issues = [...(issueList?.issues ?? [])]
            .map((issue) => normalizeIssue(issue, threadId))
            .filter(Boolean)
            .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));
          const nextIssueIdSet = new Set(issues.map((issue) => issue.id));
          const nextActiveIssue = findActiveIssueForThread(issues, cachedThread?.active_physical_thread_id ?? null);

          messages = (cachedEntry?.messages ?? []).filter((message) => {
            const issueId = String(message?.issue_id ?? "").trim();
            return !issueId || nextIssueIdSet.has(issueId);
          });
          loadedIssueIds = normalizeIssueIdList(
            [...cachedLoadedIssueIds, ...collectLoadedIssueIdsFromMessages(messages)],
            issues
          );

          if (nextActiveIssue?.id) {
            const detail = await apiRequest(
              `/api/issues/${nextActiveIssue.id}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`
            );
            const resolvedActiveIssue = normalizeIssue(detail?.issue, threadId) ?? nextActiveIssue;
            issues = replaceIssueInList(issues, resolvedActiveIssue, threadId);
            messages = mergeIssueMessages(
              messages,
              detail?.messages ?? [],
              resolvedActiveIssue,
              resolvedActiveIssue.updated_at ?? resolvedActiveIssue.created_at ?? new Date().toISOString()
            );
            normalizedThread = normalizeThread(detail?.thread) ?? normalizedThread;
            loadedIssueIds = normalizeIssueIdList([...loadedIssueIds, resolvedActiveIssue.id], issues);
            registerActiveIssuePollSuccess(resolvedActiveIssue.id);
          }
        }

        if (threadLoadRequestIdByIdRef.current.get(threadId) !== nextRequestId) {
          releaseThreadLoadingState();
          return;
        }

        setThreadDetails((current) => ({
          ...current,
          [threadId]: {
            ...(current[threadId] ?? {}),
            loading: false,
            error: "",
            messages,
            issues,
            thread: normalizedThread ?? current[threadId]?.thread ?? null,
            loaded_issue_ids: loadedIssueIds,
            history_loading: false,
            history_error: "",
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
        if (mode === "active") {
          const cachedEntry = threadDetailsRef.current?.[threadId] ?? null;
          const cachedThread = cachedEntry?.thread ?? threads.find((thread) => thread.id === threadId) ?? null;
          const cachedIssues = (cachedEntry?.issues ?? [])
            .map((issue) => normalizeIssue(issue, threadId))
            .filter(Boolean)
            .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));
          const activeIssue = findActiveIssueForThread(cachedIssues, cachedThread?.active_physical_thread_id ?? null);

          if (activeIssue?.id) {
            registerActiveIssuePollFailure(activeIssue.id, error);
          }
        }

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
    [getActiveIssuePollFailureState, resetActiveIssuePollFailureState, selectedBridgeId, session?.loginId, threads]
  );

  const loadOlderThreadHistory = useCallback(
    async (threadId = selectedThreadIdRef.current) => {
      const normalizedThreadId = String(threadId ?? "").trim();

      if (!session?.loginId || !selectedBridgeId || !normalizedThreadId) {
        return false;
      }

      const currentEntry = threadDetailsRef.current?.[normalizedThreadId] ?? null;
      const issues = (currentEntry?.issues ?? [])
        .map((issue) => normalizeIssue(issue, normalizedThreadId))
        .filter(Boolean)
        .sort((left, right) => Date.parse(left.created_at ?? "") - Date.parse(right.created_at ?? ""));

      if (currentEntry?.history_loading || issues.length === 0) {
        return false;
      }

      const loadedIssueIds = normalizeIssueIdList(
        [
          ...(currentEntry?.loaded_issue_ids ?? []),
          ...collectLoadedIssueIdsFromMessages(currentEntry?.messages ?? [])
        ],
        issues
      );
      const remainingIssueIds = getLazyOlderIssueIds(
        issues,
        loadedIssueIds,
        currentEntry?.thread?.active_physical_thread_id ?? null
      );

      if (remainingIssueIds.length === 0) {
        return false;
      }

      const targetIssueIds = remainingIssueIds.slice(0, THREAD_HISTORY_LAZY_PAGE_SIZE);
      const nextRequestId = (threadHistoryLoadRequestIdByIdRef.current.get(normalizedThreadId) ?? 0) + 1;
      threadHistoryLoadRequestIdByIdRef.current.set(normalizedThreadId, nextRequestId);

      setThreadDetails((current) => ({
        ...current,
        [normalizedThreadId]: {
          ...(current[normalizedThreadId] ?? {}),
          history_loading: true,
          history_error: ""
        }
      }));

      try {
        const details = await Promise.all(
          targetIssueIds.map((issueId) =>
            apiRequest(
              `/api/issues/${encodeURIComponent(issueId)}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`
            )
          )
        );

        if (
          threadHistoryLoadRequestIdByIdRef.current.get(normalizedThreadId) !== nextRequestId ||
          selectedBridgeIdRef.current !== selectedBridgeId
        ) {
          return false;
        }

        const latestEntry = threadDetailsRef.current?.[normalizedThreadId] ?? currentEntry;
        let nextIssues = (latestEntry?.issues ?? issues)
          .map((issue) => normalizeIssue(issue, normalizedThreadId))
          .filter(Boolean)
          .sort((left, right) => Date.parse(left.created_at ?? "") - Date.parse(right.created_at ?? ""));
        let nextMessages = latestEntry?.messages ?? [];
        let nextThread = normalizeThread(latestEntry?.thread);

        details.forEach((detail, index) => {
          const fallbackIssue = issues.find((issue) => issue.id === targetIssueIds[index]) ?? null;
          const nextIssue = normalizeIssue(detail?.issue, normalizedThreadId) ?? fallbackIssue;

          if (!nextIssue) {
            return;
          }

          nextIssues = replaceIssueInList(nextIssues, nextIssue, normalizedThreadId);
          nextMessages = mergeIssueMessages(
            nextMessages,
            detail?.messages ?? [],
            nextIssue,
            nextIssue.updated_at ?? nextIssue.created_at ?? new Date().toISOString()
          );
          nextThread = normalizeThread(detail?.thread) ?? nextThread;
        });

        const nextLoadedIssueIds = normalizeIssueIdList(
          [
            ...(latestEntry?.loaded_issue_ids ?? loadedIssueIds),
            ...collectLoadedIssueIdsFromMessages(nextMessages),
            ...targetIssueIds
          ],
          nextIssues
        );

        setThreadDetails((current) => ({
          ...current,
          [normalizedThreadId]: {
            ...(current[normalizedThreadId] ?? {}),
            thread: nextThread ?? current[normalizedThreadId]?.thread ?? null,
            issues: nextIssues,
            messages: nextMessages,
            loaded_issue_ids: nextLoadedIssueIds,
            history_loading: false,
            history_error: "",
            fetchedAt: Date.now()
          }
        }));

        if (nextThread) {
          setThreads((current) => upsertThread(current, nextThread));

          if (nextThread.project_id) {
            setThreadListsByProjectId((current) => ({
              ...current,
              [nextThread.project_id]: upsertThread(current[nextThread.project_id] ?? [], nextThread)
            }));
          }
        }

        return true;
      } catch (error) {
        if (threadHistoryLoadRequestIdByIdRef.current.get(normalizedThreadId) !== nextRequestId) {
          return false;
        }

        setThreadDetails((current) => ({
          ...current,
          [normalizedThreadId]: {
            ...(current[normalizedThreadId] ?? {}),
            history_loading: false,
            history_error: error.message ?? "이전 히스토리를 불러오지 못했습니다."
          }
        }));
        return false;
      }
    },
    [selectedBridgeId, session?.loginId]
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
  useEffect(() => {
    scheduleThreadMessagesReloadRef.current = scheduleThreadMessagesReload;
  }, [scheduleThreadMessagesReload]);

  const preloadThreadDetailsInBackground = useCallback(
    (nextThreads = [], preferredThreadIds = []) => {
      if (!session?.loginId || !selectedBridgeId) {
        return;
      }

      const runId = threadPreloadRunIdRef.current + 1;
      threadPreloadRunIdRef.current = runId;
      const candidates = pickBackgroundThreadPreloadIds(nextThreads, preferredThreadIds);

      if (candidates.length === 0) {
        return;
      }

      void (async () => {
        for (let index = 0; index < candidates.length; index += 1) {
          if (threadPreloadRunIdRef.current !== runId || selectedBridgeIdRef.current !== selectedBridgeId) {
            return;
          }

          const threadId = candidates[index];
          const matchedThread = nextThreads.find((thread) => thread.id === threadId) ?? null;
          const currentEntry = threadDetailsRef.current?.[threadId] ?? null;

          if (shouldPreloadThreadDetail(currentEntry, matchedThread)) {
            await loadThreadMessages(threadId, {
              version: matchedThread?.updated_at ?? matchedThread?.created_at ?? null,
              suppressLoadingIndicator: true
            });
          }

          if (index < candidates.length - 1) {
            await new Promise((resolve) => {
              window.setTimeout(resolve, BACKGROUND_THREAD_PRELOAD_DELAY_MS);
            });
          }
        }
      })();
    },
    [loadThreadMessages, selectedBridgeId, session?.loginId]
  );

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

      return pickDefaultBridgeId(normalizedBridges);
    });

    return normalizedBridges;
  }

  const syncBridgeList = useCallback((sessionArg = session) => {
    if (!sessionArg?.loginId) {
      return Promise.resolve([]);
    }

    if (bridgeListSyncPromiseRef.current) {
      return bridgeListSyncPromiseRef.current;
    }

    setBridgeListSyncing(true);
    const request = loadBridges(sessionArg)
      .finally(() => {
        if (bridgeListSyncPromiseRef.current === request) {
          bridgeListSyncPromiseRef.current = null;
          setBridgeListSyncing(false);
        }
      });
    bridgeListSyncPromiseRef.current = request;
    return request;
  }, [loadBridges, session]);

  const handleOpenBridgeDropdown = useCallback(() => {
    void syncBridgeList().catch((error) => {
      notifyError(error);
    });
  }, [notifyError, syncBridgeList]);

  async function loadBridgeWorkspace(sessionArg, bridgeId) {
    if (!sessionArg?.loginId || !bridgeId) {
      setProjects([]);
      setThreads([]);
      setThreadListsByProjectId({});
      setTodoChats([]);
      setTodoChatDetails({});
      return;
    }

    const requestId = bridgeWorkspaceRequestIdRef.current + 1;
    bridgeWorkspaceRequestIdRef.current = requestId;
    setLoadingState("loading");
    const prioritizeTodoScope = selectedScope.kind === "todo";
    const preferredProjectId = prioritizeTodoScope ? "" : String(selectedProjectIdRef.current ?? "").trim();
    const preferredProjectThreadsPromise = preferredProjectId
      ? loadProjectThreads(sessionArg, bridgeId, preferredProjectId, {
          applyToInbox: true,
          preferredThreadId: selectedThreadIdRef.current,
          preload: false
        })
      : null;

    const statusPromise = apiRequest(
      `/api/bridge/status?login_id=${encodeURIComponent(sessionArg.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`
    )
      .then((nextStatus) => {
        if (bridgeWorkspaceRequestIdRef.current !== requestId || selectedBridgeIdRef.current !== bridgeId) {
          return null;
        }

        if (nextStatus?.app_server?.connected) {
          markBridgeSocketConnected(bridgeId);
        } else {
          markBridgeStatusDisconnected(bridgeId, nextStatus?.app_server?.last_error ?? "");
        }
        setBridgeStatus(bridgeId, withReceivedBridgeStatus(nextStatus));
        markStreamActivity();
        return nextStatus;
      })
      .catch((error) => {
        if (bridgeWorkspaceRequestIdRef.current !== requestId || selectedBridgeIdRef.current !== bridgeId) {
          return null;
        }

        markBridgeStatusDisconnected(bridgeId, error.message);
        setBridgeStatus(bridgeId, (current) => ({
          ...current,
          app_server: {
            ...(current?.app_server ?? {}),
            last_error: error.message
          }
        }));
        return null;
      });

    const todoChatsPromise = apiRequest(
      `/api/todo/chats?login_id=${encodeURIComponent(sessionArg.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`
    )
      .then((nextTodoChats) => {
        if (bridgeWorkspaceRequestIdRef.current !== requestId || selectedBridgeIdRef.current !== bridgeId) {
          return [];
        }

        const resolvedTodoChats = mergeTodoChats([], nextTodoChats.chats ?? []);
        setTodoChats(resolvedTodoChats);
        setTodoChatDetails({});
        return resolvedTodoChats;
      })
      .catch(() => []);

    try {
      const nextProjects = await apiRequest(
        `/api/projects?login_id=${encodeURIComponent(sessionArg.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`
      );

      if (bridgeWorkspaceRequestIdRef.current !== requestId || selectedBridgeIdRef.current !== bridgeId) {
        return;
      }

      setProjects((current) => mergeProjectSnapshots(current, nextProjects.projects ?? []));
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

      if (prioritizeTodoScope) {
        await todoChatsPromise;

        if (bridgeWorkspaceRequestIdRef.current !== requestId || selectedBridgeIdRef.current !== bridgeId) {
          return;
        }

        setLoadingState("ready");
      } else if (nextProjectId) {
        const nextThreads =
          preferredProjectThreadsPromise && preferredProjectId === nextProjectId
            ? await preferredProjectThreadsPromise
            : await loadProjectThreads(sessionArg, bridgeId, nextProjectId, {
                applyToInbox: true,
                preferredThreadId: selectedThreadIdRef.current
              });
        const resolvedSelectedThreadId =
          selectedThreadIdRef.current && nextThreads.some((thread) => thread.id === selectedThreadIdRef.current)
            ? selectedThreadIdRef.current
            : nextThreads[0]?.id || "";

        if (bridgeWorkspaceRequestIdRef.current !== requestId || selectedBridgeIdRef.current !== bridgeId) {
          return;
        }

        setSelectedThreadId(resolvedSelectedThreadId);
        if (preferredProjectId === nextProjectId) {
          preloadThreadDetailsInBackground(nextThreads, [resolvedSelectedThreadId]);
        }
        setLoadingState("ready");
      } else {
        setThreads([]);
        setSelectedThreadId("");
        setLoadingState("ready");
      }

      void Promise.allSettled([statusPromise, todoChatsPromise]);
    } catch (error) {
      if (bridgeWorkspaceRequestIdRef.current !== requestId || selectedBridgeIdRef.current !== bridgeId) {
        return;
      }

      setLoadingState("error");
    }
  }

  useEffect(() => {
    loadBridgeWorkspaceRef.current = loadBridgeWorkspace;
  }, [loadBridgeWorkspace]);

  const reloadBridgeWorkspaceOnReconnect = useCallback((bridgeId, nextStatus) => {
    const normalizedBridgeId = String(bridgeId ?? "").trim();

    if (!normalizedBridgeId || selectedBridgeIdRef.current !== normalizedBridgeId) {
      return;
    }

    const previousStatus = normalizeBridgeStatus(bridgeStatusByIdRef.current[normalizedBridgeId]);
    const nextNormalizedStatus = normalizeBridgeStatus(withReceivedBridgeStatus(nextStatus));
    const wasConnected = previousStatus.app_server?.connected === true;
    const isConnected = nextNormalizedStatus.app_server?.connected === true;

    if (wasConnected || !isConnected) {
      return;
    }

    const sessionArg = sessionRef.current;

    if (!sessionArg?.loginId) {
      return;
    }

    const lastReloadedAt = bridgeWorkspaceReloadedAtRef.current.get(normalizedBridgeId) ?? 0;

    if (Date.now() - lastReloadedAt < BRIDGE_RECONNECT_WORKSPACE_RELOAD_DEBOUNCE_MS) {
      return;
    }

    bridgeWorkspaceReloadedAtRef.current.set(normalizedBridgeId, Date.now());
    void loadBridgeWorkspaceRef.current?.(sessionArg, normalizedBridgeId);
  }, []);

  const refreshBridgeStatus = useCallback(
    async (sessionArg = session, bridgeId = selectedBridgeId) => {
      if (!sessionArg?.loginId || !bridgeId) {
        return false;
      }

      try {
        const nextStatus = await apiRequest(
          `/api/bridge/status?login_id=${encodeURIComponent(sessionArg.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`
        );

        if (selectedBridgeIdRef.current !== bridgeId) {
          return false;
        }

        if (nextStatus?.app_server?.connected) {
          markBridgeSocketConnected(bridgeId);
        } else {
          markBridgeStatusDisconnected(bridgeId, nextStatus?.app_server?.last_error ?? "");
        }
        reloadBridgeWorkspaceOnReconnect(bridgeId, nextStatus);
        setBridgeStatus(bridgeId, withReceivedBridgeStatus(nextStatus));
        return true;
      } catch (error) {
        if (selectedBridgeIdRef.current !== bridgeId) {
          return false;
        }

        markBridgeTransportFailure(bridgeId, error.message);
        setBridgeStatus(bridgeId, (current) => ({
          ...current,
          app_server: {
            ...(current?.app_server ?? {}),
            last_error: error.message
          }
        }));
        return false;
      }
    },
    [
      markBridgeSocketConnected,
      markBridgeSocketDisconnected,
      markBridgeStatusDisconnected,
      markBridgeTransportFailure,
      reloadBridgeWorkspaceOnReconnect,
      selectedBridgeId,
      session,
      setBridgeStatus
    ]
  );
  useEffect(() => {
    refreshBridgeStatusRef.current = refreshBridgeStatus;
  }, [refreshBridgeStatus]);
  useEffect(() => {
    return subscribeBridgeRequestFailures((event) => {
      if (!event?.bridgeId || event.bridgeId !== selectedBridgeIdRef.current) {
        return;
      }

      markBridgeTransportFailure(event.bridgeId, event.message ?? "bridge transport unavailable");
      setBridgeStatus(event.bridgeId, (current) => ({
        ...current,
        app_server: {
          ...(current?.app_server ?? {}),
          last_error: event.message ?? "bridge transport unavailable"
        }
      }));
    });
  }, [markBridgeTransportFailure, setBridgeStatus]);
  useEffect(() => {
    return subscribeBridgeRequestSuccesses((event) => {
      if (!event?.bridgeId || event.bridgeId !== selectedBridgeIdRef.current) {
        return;
      }

      markBridgeTransportSuccess(event.bridgeId);
    });
  }, [markBridgeTransportSuccess]);

  async function loadProjectThreads(sessionArg, bridgeId, projectId, options = {}) {
    if (!sessionArg?.loginId || !bridgeId || !projectId) {
      return [];
    }

    const requestKey = `${String(bridgeId ?? "").trim()}::${String(projectId ?? "").trim()}`;
    let requestPromise = projectThreadListPromiseByKeyRef.current.get(requestKey);

    if (!requestPromise) {
      requestPromise = apiRequest(
        `/api/projects/${projectId}/threads?login_id=${encodeURIComponent(sessionArg.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`
      )
        .then((payload) => mergeThreads([], payload?.threads ?? []))
        .finally(() => {
          if (projectThreadListPromiseByKeyRef.current.get(requestKey) === requestPromise) {
            projectThreadListPromiseByKeyRef.current.delete(requestKey);
          }
        });
      projectThreadListPromiseByKeyRef.current.set(requestKey, requestPromise);
    }

    const nextThreads = await requestPromise;

    if (selectedBridgeIdRef.current !== bridgeId) {
      return [];
    }

    updateThreadCache(projectId, nextThreads);

    if (options.applyToInbox !== false && selectedProjectIdRef.current === projectId) {
      setThreads(nextThreads);
    }

    if (options.preload !== false) {
      const preferredThreadIds = Array.isArray(options.preferredThreadIds)
        ? options.preferredThreadIds
        : [options.preferredThreadId ?? ""];
      preloadThreadDetailsInBackground(nextThreads, preferredThreadIds);
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

    if (isStandaloneDisplayMode() || isPwaPromptDismissed()) {
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

      if (pwaUpdateActivationInFlightRef.current) {
        return;
      }

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
    clearInstantThreadIfNeeded();
    setDraftThreadProjectId("");
    setActiveView("inbox");
    activeViewRef.current = "inbox";
  }, [clearInstantThreadIfNeeded, setActiveView, setDraftThreadProjectId]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.history?.pushState || isStandaloneDisplayMode()) {
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
      if (eventStreamReconnectTimerRef.current) {
        window.clearTimeout(eventStreamReconnectTimerRef.current);
        eventStreamReconnectTimerRef.current = null;
      }
      markStreamActivity();
    });

    eventSource.addEventListener("snapshot", (event) => {
      try {
        markStreamActivity();
        const payload = JSON.parse(event.data);
        if (selectedBridgeIdRef.current) {
          if (payload?.app_server?.connected) {
            markBridgeSocketConnected(selectedBridgeIdRef.current);
          } else {
            markBridgeStatusDisconnected(selectedBridgeIdRef.current, payload?.app_server?.last_error ?? "");
          }
          reloadBridgeWorkspaceOnReconnect(selectedBridgeIdRef.current, payload);
          setBridgeStatus(selectedBridgeIdRef.current, withReceivedBridgeStatus(payload));
        }
      } catch {
        // ignore malformed snapshot
      }
    });

    eventSource.addEventListener("message", (event) => {
      try {
        markStreamActivity();
        const payload = JSON.parse(event.data);
        const { threadId: eventThreadId, issueId: eventIssueId, projectId: eventProjectId } = getLiveEventContext(payload);
        const localInterruptHeld = isLocalThreadInterruptHeld(eventThreadId, eventIssueId);
        const liveStatusType = String(payload?.payload?.status?.type ?? "").trim();
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

        if (
          localInterruptHeld &&
          (
            isLiveThreadProgressEvent(payload.type) ||
            (payload.type === "thread.status.changed" && ["active", "running", "waitingForInput"].includes(liveStatusType))
          )
        ) {
          return;
        }

        if (payload.type === "thread.deleted" || payload.type === "rootThread.deleted") {
          if (eventThreadId) {
            removeDeletedThreadsFromState([eventThreadId]);
          }
          return;
        }

        if (eventThreadId) {
          if (eventThreadId === activeThreadId && isLiveThreadProgressEvent(payload.type)) {
            threadLiveProgressAtByIdRef.current.set(eventThreadId, Date.now());
            resetActiveIssuePollFailureState(eventThreadId, eventIssueId);
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
          if (selectedBridgeIdRef.current) {
            if (payload.payload?.app_server?.connected) {
              markBridgeSocketConnected(selectedBridgeIdRef.current);
            } else {
              markBridgeStatusDisconnected(selectedBridgeIdRef.current, payload.payload?.app_server?.last_error ?? "");
            }
            reloadBridgeWorkspaceOnReconnect(selectedBridgeIdRef.current, payload.payload);
            setBridgeStatus(selectedBridgeIdRef.current, withReceivedBridgeStatus(payload.payload));
          }
          return;
        }

        if (payload.type === "bridge.projects.updated") {
          const nextProjects = payload.payload?.projects ?? [];
          setProjects((current) => mergeProjectSnapshots(current, nextProjects));
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
          const normalizedNextIssues = nextIssues.map((issue) => normalizeIssue(issue, threadId)).filter(Boolean);

          if (threadId) {
            const currentIssues = threadDetailsRef.current?.[threadId]?.issues ?? [];
            const shouldReload =
              threadId === activeThreadId &&
              shouldReloadThreadFromIssueSnapshot(currentIssues, nextIssues, threadId);

            normalizedNextIssues.forEach((issue) => {
              if (!["running", "awaiting_input"].includes(issue.status ?? "")) {
                releaseLocalThreadInterrupt(threadId, issue.id);
              }
            });

            if (!normalizedNextIssues.some((issue) => ["running", "awaiting_input"].includes(issue.status ?? ""))) {
              releaseLocalThreadInterrupt(threadId);
            }

            setThreadDetails((current) => ({
              ...current,
              [threadId]: {
                ...(current[threadId] ?? {}),
                issues: normalizedNextIssues
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

    eventSource.addEventListener("error", () => {
      setStreamActivityAt(null);
      markBridgeSocketDisconnected(selectedBridgeId, "event stream disconnected");
      setBridgeStatus(selectedBridgeId, (current) => ({
        ...current,
        app_server: {
          ...(current?.app_server ?? {}),
          last_error: "event stream disconnected"
        }
      }));
      void refreshBridgeStatus(session, selectedBridgeId);

      const browserOnline =
        typeof navigator === "undefined" || typeof navigator.onLine !== "boolean"
          ? true
          : navigator.onLine;
      if (browserOnline && !eventStreamReconnectTimerRef.current) {
        eventStreamReconnectTimerRef.current = window.setTimeout(() => {
          eventStreamReconnectTimerRef.current = null;
          setEventStreamReconnectToken((current) => current + 1);
        }, 1000);
      }
    });

    return () => {
      eventSource.close();
    };
  }, [
    eventStreamReconnectToken,
    isLocalThreadInterruptHeld,
    markBridgeSocketConnected,
    markBridgeSocketDisconnected,
    markBridgeStatusDisconnected,
    markStreamActivity,
    releaseLocalThreadInterrupt,
    reloadBridgeWorkspaceOnReconnect,
    refreshBridgeStatus,
    setBridgeStatus,
    selectedBridgeId,
    selectedBridgeKnown,
    removeDeletedThreadsFromState,
    session?.loginId
  ]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return undefined;
    }

    void publishServiceWorkerClientContext();

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void publishServiceWorkerClientContext();
        scheduleAppForegroundResume("app_resume:visibility");
      }
    };

    const handleWindowFocus = () => {
      void publishServiceWorkerClientContext();
      scheduleAppForegroundResume("app_resume:focus");
    };

    const handlePageShow = () => {
      void publishServiceWorkerClientContext();
      scheduleAppForegroundResume("app_resume:pageshow");
    };

    const handleOnline = () => {
      void publishServiceWorkerClientContext();
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

  useEffect(() => {
    return () => {
      if (eventStreamReconnectTimerRef.current) {
        window.clearTimeout(eventStreamReconnectTimerRef.current);
        eventStreamReconnectTimerRef.current = null;
      }
    };
  }, []);

  useLayoutEffect(() => {
    const previousOwnerKey = workspaceLayoutOwnerKeyRef.current;
    const ownerChanged = previousOwnerKey !== workspaceLayoutOwnerKey;
    workspaceLayoutOwnerKeyRef.current = workspaceLayoutOwnerKey;
    const restoredThreadDetails = readStoredThreadDetailCache({
      loginId: session?.loginId ?? "",
      bridgeId: selectedBridgeId
    });
    const restoredLayout = readStoredMobileWorkspaceLayout({
      loginId: session?.loginId ?? "",
      bridgeId: selectedBridgeId
    });
    const restoredWorkspaceSnapshot = readStoredWorkspaceSnapshot({
      loginId: session?.loginId ?? "",
      bridgeId: selectedBridgeId
    });

    if (!ownerChanged) {
      setLoadingState(selectedBridgeId && selectedBridgeKnown ? "loading" : "idle");
      return;
    }

    threadPreloadRunIdRef.current += 1;
    threadLoadRequestIdByIdRef.current = new Map();
    todoChatLoadRequestIdRef.current += 1;
    for (const timerId of threadReloadTimersByIdRef.current.values()) {
      window.clearTimeout(timerId);
    }
    threadReloadTimersByIdRef.current.clear();
    threadReloadMetaByIdRef.current = new Map();
    if (threadDetailsPersistTimerRef.current) {
      window.clearTimeout(threadDetailsPersistTimerRef.current);
      threadDetailsPersistTimerRef.current = null;
    }

    setProjects(restoredWorkspaceSnapshot.projects);
    setThreads(resolveThreadsForScopeFromSnapshot(restoredWorkspaceSnapshot, restoredLayout.selectedScope));
    setStreamActivityAt(null);
    locallyInterruptedThreadIdsRef.current.clear();
    locallyInterruptedIssueIdsRef.current.clear();
    setSelectedScope(restoredLayout.selectedScope);
    setSelectedThreadId(restoredLayout.selectedThreadId);
    setInstantThreadId(restoredLayout.instantThreadId);
    setSelectedTodoChatId(restoredLayout.selectedTodoChatId);
    setDraftThreadProjectId(restoredLayout.draftThreadProjectId);
    setThreadComposerDrafts(restoredLayout.threadComposerDrafts);
    setProjectFilterUsage(restoredLayout.projectFilterUsage ?? {});
    setProjectChipOrder(restoredLayout.projectChipOrder ?? []);
    setThreadOrderByProjectId(restoredLayout.threadOrderByProjectId ?? {});
    setThreadListsByProjectId(restoredWorkspaceSnapshot.threadListsByProjectId);
    setTodoChats(restoredWorkspaceSnapshot.todoChats);
    setTodoChatDetails({});
    setThreadDetails(restoredThreadDetails);
    setWorkspaceRoots([]);
    setFolderState({ path: "", parent_path: null, entries: [] });
    setSelectedWorkspacePath("");
    setActiveView(restoredLayout.activeView);
    setLoadingState(selectedBridgeId && selectedBridgeKnown ? "loading" : "idle");
  }, [selectedBridgeId, selectedBridgeKnown, session?.loginId, workspaceLayoutOwnerKey]);

  useEffect(() => {
    if (!session?.loginId || !selectedBridgeId) {
      return;
    }

    storeMobileWorkspaceLayout(
      {
        selectedScope,
        selectedThreadId,
        instantThreadId,
        selectedTodoChatId,
        draftThreadProjectId,
        threadComposerDrafts,
        projectFilterUsage,
        projectChipOrder,
        threadOrderByProjectId,
        activeView
      },
      {
        loginId: session.loginId,
        bridgeId: selectedBridgeId
      }
    );
  }, [
    activeView,
    draftThreadProjectId,
    instantThreadId,
    selectedBridgeId,
    selectedScope,
    selectedThreadId,
    selectedTodoChatId,
    threadComposerDrafts,
    projectFilterUsage,
    projectChipOrder,
    threadOrderByProjectId,
    session?.loginId
  ]);

  useEffect(() => {
    const availableProjectIds = projects.map((project) => project.id);

    setProjectChipOrder((current) => {
      const normalizedOrder = normalizeProjectChipOrder(current, availableProjectIds);
      return areStringArraysEqual(current, normalizedOrder) ? current : normalizedOrder;
    });
  }, [projects]);

  useEffect(() => {
    const availableProjectIds = new Set(projects.map((project) => String(project?.id ?? "").trim()).filter(Boolean));

    setThreadOrderByProjectId((current) => {
      const next = {};
      const projectIds = new Set([
        ...Object.keys(current ?? {}),
        ...Object.keys(threadListsByProjectId ?? {})
      ]);

      projectIds.forEach((projectId) => {
        if (!availableProjectIds.has(projectId)) {
          return;
        }

        const cachedThreads = Array.isArray(threadListsByProjectId?.[projectId]) ? threadListsByProjectId[projectId] : null;

        if (cachedThreads) {
          next[projectId] = resolveOrderedThreadIds(
            cachedThreads.map((thread) => thread?.id),
            current?.[projectId] ?? []
          );
          return;
        }

        const normalizedOrder = normalizeThreadOrder(current?.[projectId] ?? []);

        if (normalizedOrder.length > 0) {
          next[projectId] = normalizedOrder;
        }
      });

      return areStringArrayRecordEqual(current, next) ? current : next;
    });
  }, [projects, threadListsByProjectId]);

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
    void refreshBridgeStatus(session, selectedBridgeId);

    const timer = window.setInterval(() => {
      if (cancelled) {
        return;
      }
      void refreshBridgeStatus(session, selectedBridgeId);
    }, BRIDGE_STATUS_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshBridgeStatus, selectedBridgeId, selectedBridgeKnown, session]);

  useEffect(() => {
    if (!session?.loginId || !selectedBridgeId || !selectedProjectId) {
      return;
    }

    void loadProjectThreads(session, selectedBridgeId, selectedProjectId, {
      applyToInbox: true,
      preferredThreadId: selectedThreadIdRef.current
    });
  }, [selectedBridgeId, selectedProjectId, session]);

  useEffect(() => {
    if (selectedScope.kind !== "project") {
      return;
    }

    if (!selectedProjectId) {
      setThreads([]);
      return;
    }

    const cachedThreads = threadListsByProjectId[selectedProjectId];

    if (Array.isArray(cachedThreads)) {
      setThreads(cachedThreads);
    }
  }, [selectedProjectId, selectedScope.kind, threadListsByProjectId]);

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
    resetActiveIssuePollFailureState(selectedThreadId, selectedActiveIssue?.id ?? "");
  }, [resetActiveIssuePollFailureState, selectedActiveIssue?.id, selectedThreadId]);

  useEffect(() => {
    if (
      !session?.loginId ||
      !selectedBridgeId ||
      !selectedThreadId ||
      !threadPanelVisible
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
    currentThreadDetailLoading,
    currentThreadDetailVersion,
    hasCurrentThreadDetail,
    scheduleThreadMessagesReload,
    selectedBridgeId,
    threadPanelVisible,
    selectedThreadId,
    selectedThreadStatus,
    selectedThreadUpdatedAt,
    session?.loginId
  ]);

  useEffect(() => {
    if (
      !session?.loginId ||
      !selectedBridgeId ||
      !threadPanelVisible ||
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

      const failureState = getActiveIssuePollFailureState(selectedThreadId, selectedActiveIssue.id);

      if (failureState.nextRetryAt > Date.now()) {
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
    getActiveIssuePollFailureState,
    scheduleThreadMessagesReload,
    selectedActiveIssue,
    selectedBridgeId,
    selectedThreadId,
    threadPanelVisible,
    session?.loginId
  ]);

  useEffect(() => {
    if (selectedScope.kind === "todo") {
      return;
    }

    if (!selectedProjectId && projects.length > 0) {
      selectProjectScope(projects[0].id, { recordUsage: false });
    }
  }, [projects, selectProjectScope, selectedProjectId, selectedScope.kind]);

  useEffect(() => {
    const pending = pendingPushDeepLinkRef.current;

    if (!pending || !session?.loginId) {
      return;
    }

    if (pending.bridgeId && bridges.some((bridge) => bridge.bridge_id === pending.bridgeId) && selectedBridgeId !== pending.bridgeId) {
      setSelectedBridgeId(pending.bridgeId);
      return;
    }

    if (
      pending.projectId &&
      projects.some((project) => project.id === pending.projectId) &&
      selectedProjectId !== pending.projectId
    ) {
      selectProjectScope(pending.projectId);
      return;
    }

    const scopedThreads = threads.filter((thread) => !pending.projectId || thread.project_id === pending.projectId);

    if (pending.threadId && scopedThreads.some((thread) => thread.id === pending.threadId) && selectedThreadId !== pending.threadId) {
      setSelectedThreadId(pending.threadId);
      setActiveView(wideThreadSplitEnabled ? "inbox" : "thread");
      return;
    }

    if (!pending.threadId || selectedThreadId === pending.threadId) {
      setActiveView(wideThreadSplitEnabled ? "inbox" : "thread");
      pendingPushDeepLinkRef.current = null;
      clearPushDeepLink();
    }
  }, [
    bridges,
    projects,
    selectProjectScope,
    selectedBridgeId,
    selectedProjectId,
    selectedThreadId,
    session?.loginId,
    threads,
    wideThreadSplitEnabled
  ]);

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
    clearStoredMobileWorkspaceLayout();
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
    setInstantThreadId("");
    setSelectedTodoChatId("");
    setDraftThreadProjectId("");
    setThreadComposerDrafts({});
    setProjectFilterUsage({});
    setProjectChipOrder([]);
    setThreadOrderByProjectId({});
    setSearch("");
    setUtilityOpen(false);
    setProjectComposerOpen(false);
    setActiveView("inbox");
  };

  const handleSelectTodoScope = useCallback(() => {
    clearInstantThreadIfNeeded();
    selectTodoScope();
    setSelectedThreadId("");
    setDraftThreadProjectId("");
    setActiveView("inbox");
  }, [clearInstantThreadIfNeeded, selectTodoScope]);

  const handleSelectTodoChat = useCallback((chatId) => {
    if (!chatId) {
      return;
    }

    clearInstantThreadIfNeeded();
    selectTodoScope();
    setSelectedThreadId("");
    setDraftThreadProjectId("");
    setSelectedTodoChatId(chatId);
    setActiveView("todo");
  }, [clearInstantThreadIfNeeded, selectTodoScope]);

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
        applyToInbox: options.applyToInbox ?? (selectedScope.kind === "project" && selectedProjectId === normalizedProjectId),
        preferredThreadId:
          selectedScope.kind === "project" && selectedProjectId === normalizedProjectId
            ? selectedThreadIdRef.current
            : ""
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

    clearInstantThreadIfNeeded();

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
      notifyError(error);
      return false;
    } finally {
      setTodoBusy(false);
    }
  }, [
    clearInstantThreadIfNeeded,
    notifyError,
    selectedBridgeId,
    selectTodoScope,
    session,
    todoChats
  ]);

  const handleSubmitTodoMessage = useCallback(async (payload = {}) => {
    if (!session?.loginId || !selectedBridgeId || !selectedTodoChatId) {
      return false;
    }

    setTodoBusy(true);

    try {
      const response = await apiRequest(
        `/api/todo/chats/${encodeURIComponent(selectedTodoChatId)}/messages?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "POST",
          body: JSON.stringify({
            content: String(payload.prompt ?? payload.content ?? "").trim(),
            attachments: normalizeMessageAttachments(payload.attachments)
          })
        }
      );

      syncTodoChatPayload(response, selectedTodoChatId);

      if (Array.isArray(response?.chats)) {
        setTodoChats(mergeTodoChats([], response.chats));
      }

      return true;
    } catch (error) {
      notifyError(error);
      return false;
    } finally {
      setTodoBusy(false);
    }
  }, [notifyError, selectedBridgeId, selectedTodoChatId, session, syncTodoChatPayload]);

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
      notifyError(error);
      return false;
    } finally {
      setTodoRenameBusy(false);
    }
  }, [notifyError, selectedBridgeId, session]);

  const handleDeleteTodoChat = useCallback(async (chatId) => {
    if (!session?.loginId || !selectedBridgeId || !chatId) {
      return false;
    }

    const confirmed = await confirmMobileAction({
      title: "ToDo 채팅 삭제",
      message: "이 ToDo 채팅을 삭제하시겠습니까?",
      confirmLabel: "삭제",
      cancelLabel: "취소",
      tone: "danger"
    });

    if (!confirmed) {
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

      removeThreadComposerDrafts([buildTodoComposerDraftKey({ chatId })]);

      return true;
    } catch (error) {
      notifyError(error);
      return false;
    }
  }, [confirmMobileAction, notifyError, removeThreadComposerDrafts, selectedBridgeId, selectedTodoChatId, selectTodoScope, session]);

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
      notifyError(error);
      return false;
    } finally {
      setTodoBusy(false);
    }
  }, [notifyError, selectedBridgeId, selectedTodoChatId, session, syncTodoChatPayload]);

  const handleDeleteTodoMessage = useCallback(async (messageId) => {
    if (!session?.loginId || !selectedBridgeId || !messageId || !selectedTodoChatId) {
      return false;
    }

    const confirmed = await confirmMobileAction({
      title: "메모 삭제",
      message: "이 메모를 삭제하시겠습니까?",
      confirmLabel: "삭제",
      cancelLabel: "취소",
      tone: "danger"
    });

    if (!confirmed) {
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
      notifyError(error);
      return false;
    }
  }, [confirmMobileAction, notifyError, selectedBridgeId, selectedTodoChatId, session, syncTodoChatPayload]);

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
      notifyError(error);
      return false;
    } finally {
      setTodoTransferBusy(false);
    }
  }, [ensureProjectThreadsLoaded, loadTodoChatMessages, notifyError, selectedBridgeId, selectedProjectId, selectedScope.kind, selectedTodoChatId, session]);

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
      notifyError(error);
    }
  }, [loadThreadMessages, notifyError, selectedBridgeId, selectedThreadId, session?.loginId]);

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
      showMobileAlert("현재 active thread에 속한 이슈만 삭제할 수 있습니다.", {
        tone: "error",
        title: "이슈 삭제"
      });
      return false;
    }

    const confirmed = await confirmMobileAction({
      title: "이슈 삭제",
      message: "이 이슈를 삭제하시겠습니까? 관련 메시지도 함께 목록에서 사라집니다.",
      confirmLabel: "삭제",
      cancelLabel: "취소",
      tone: "danger"
    });

    if (!confirmed) {
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
      notifyError(error);
      return false;
    }
  }, [confirmMobileAction, currentThreadDetail?.issues, loadThreadMessages, notifyError, selectedBridgeId, selectedThreadId, selectedThread?.active_physical_thread_id, session, showMobileAlert]);

  const handleRetryThreadIssue = useCallback(async (issueId) => {
    if (!session?.loginId || !selectedBridgeId || !selectedThreadId || !issueId) {
      return false;
    }

    const targetIssue = (currentThreadDetail?.issues ?? [])
      .map((issue) => normalizeIssue(issue, selectedThreadId))
      .find((issue) => issue?.id === issueId);

    if (!targetIssue) {
      return false;
    }

    if (!isRetryableIssueStatus(targetIssue.status)) {
      showMobileAlert("실패한 이슈만 다시 진행할 수 있습니다.", {
        tone: "error",
        title: "이슈 재시도"
      });
      return false;
    }

    try {
      const interruptResponse = await apiRequest(
        `/api/issues/${encodeURIComponent(issueId)}/interrupt?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "POST",
          body: JSON.stringify({
            reason: "drag_to_prep"
          })
        }
      );

      if (Array.isArray(interruptResponse?.issues)) {
        setThreadDetails((current) => ({
          ...current,
          [selectedThreadId]: {
            ...(current[selectedThreadId] ?? {}),
            issues: interruptResponse.issues.map((issue) => normalizeIssue(issue, selectedThreadId)).filter(Boolean)
          }
        }));
      }

      const startResponse = await apiRequest(
        `/api/threads/${encodeURIComponent(selectedThreadId)}/issues/start?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "POST",
          body: JSON.stringify({
            issue_ids: [issueId]
          })
        }
      );

      if (Array.isArray(startResponse?.issues)) {
        setThreadDetails((current) => ({
          ...current,
          [selectedThreadId]: {
            ...(current[selectedThreadId] ?? {}),
            issues: startResponse.issues.map((issue) => normalizeIssue(issue, selectedThreadId)).filter(Boolean)
          }
        }));
      }

      await loadThreadMessages(selectedThreadId, { force: true });
      return true;
    } catch (error) {
      notifyError(error);
      return false;
    }
  }, [currentThreadDetail?.issues, loadThreadMessages, notifyError, selectedBridgeId, selectedThreadId, session, showMobileAlert]);

  const handleInterruptThreadIssue = useCallback(async (issueId, options = {}) => {
    if (!session?.loginId || !selectedBridgeId || !selectedThreadId || !issueId) {
      return false;
    }

    const interruptReason = String(options.reason ?? "mobile_long_press").trim() || "mobile_long_press";
    const activePhysicalThreadId = selectedThread?.active_physical_thread_id ?? null;
    const previousThread = pickPreferredThreadSnapshot(currentThreadDetail?.thread ?? null, selectedThread);
    const previousIssues = (currentThreadDetail?.issues ?? [])
      .map((issue) => normalizeIssue(issue, selectedThreadId))
      .filter(Boolean);
    const targetIssue = previousIssues.find((issue) => issue?.id === issueId) ?? null;

    if (!activePhysicalThreadId || !targetIssue) {
      return false;
    }

    if (!["running", "awaiting_input"].includes(targetIssue.status)) {
      showMobileAlert("실행 중이거나 입력 대기 상태인 이슈만 중단할 수 있습니다.", {
        tone: "error",
        title: "이슈 중단"
      });
      return false;
    }

    const targetPhysicalThreadId = targetIssue.executed_physical_thread_id ?? targetIssue.created_physical_thread_id ?? null;

    if (targetPhysicalThreadId !== activePhysicalThreadId) {
      showMobileAlert("현재 active thread에 속한 이슈만 중단할 수 있습니다.", {
        tone: "error",
        title: "이슈 중단"
      });
      return false;
    }

    const optimisticIssue = buildOptimisticInterruptedIssue(targetIssue, interruptReason);
    const optimisticThread = buildOptimisticInterruptedThread(previousThread, interruptReason);

    if (optimisticIssue || optimisticThread) {
      holdLocalThreadInterrupt(selectedThreadId, targetIssue.id);
      threadLiveProgressAtByIdRef.current.delete(selectedThreadId);
      applyThreadDetailSnapshot(selectedThreadId, {
        thread: optimisticThread ?? previousThread ?? undefined,
        issues: optimisticIssue ? replaceIssueInList(previousIssues, optimisticIssue, selectedThreadId) : previousIssues
      });
    }

    try {
      const response = await apiRequest(
        `/api/issues/${encodeURIComponent(issueId)}/interrupt?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "POST",
          body: JSON.stringify({
            reason: interruptReason
          })
        }
      );

      const nextIssues = Array.isArray(response?.issues)
        ? response.issues.map((issue) => normalizeIssue(issue, selectedThreadId)).filter(Boolean)
        : undefined;
      const nextThread = normalizeThread(response?.thread) ?? undefined;

      if (nextThread || nextIssues) {
        applyThreadDetailSnapshot(selectedThreadId, {
          thread: nextThread,
          issues: nextIssues
        });
      }

      releaseLocalThreadInterrupt(selectedThreadId, targetIssue.id);
      void loadThreadMessages(selectedThreadId, { force: true });
      return true;
    } catch (error) {
      releaseLocalThreadInterrupt(selectedThreadId, targetIssue.id);
      applyThreadDetailSnapshot(selectedThreadId, {
        thread: previousThread ?? undefined,
        issues: previousIssues
      });
      void loadThreadMessages(selectedThreadId, { force: true });
      notifyError(error);
      return false;
    }
  }, [
    applyThreadDetailSnapshot,
    currentThreadDetail?.issues,
    currentThreadDetail?.thread,
    holdLocalThreadInterrupt,
    loadThreadMessages,
    notifyError,
    releaseLocalThreadInterrupt,
    selectedBridgeId,
    selectedThread,
    selectedThreadId,
    session,
    showMobileAlert
  ]);

  const handleStopThreadExecution = useCallback(async (options = {}) => {
    if (!session?.loginId || !selectedBridgeId || !selectedThreadId) {
      return false;
    }

    const stopReason = String(options.reason ?? "mobile_stop_button").trim() || "mobile_stop_button";
    const previousThread = pickPreferredThreadSnapshot(currentThreadDetail?.thread ?? null, selectedThread);
    const previousIssues = (currentThreadDetail?.issues ?? [])
      .map((issue) => normalizeIssue(issue, selectedThreadId))
      .filter(Boolean);
    const activeIssue = findActiveIssueForThread(previousIssues, previousThread?.active_physical_thread_id ?? null);
    const optimisticIssue = buildOptimisticInterruptedIssue(activeIssue, stopReason);
    const optimisticThread = buildOptimisticInterruptedThread(previousThread, stopReason);

    if (activeIssue?.id && (optimisticIssue || optimisticThread)) {
      holdLocalThreadInterrupt(selectedThreadId, activeIssue.id);
      threadLiveProgressAtByIdRef.current.delete(selectedThreadId);
      applyThreadDetailSnapshot(selectedThreadId, {
        thread: optimisticThread ?? previousThread ?? undefined,
        issues: optimisticIssue ? replaceIssueInList(previousIssues, optimisticIssue, selectedThreadId) : previousIssues
      });
    }

    try {
      const stopPath =
        `/api/threads/${encodeURIComponent(selectedThreadId)}/stop?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`;
      const stopOptions = {
        method: "POST",
        body: JSON.stringify({
          reason: stopReason
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
      const nextIssues = Array.isArray(response?.issues)
        ? response.issues.map((issue) => normalizeIssue(issue, selectedThreadId)).filter(Boolean)
        : undefined;

      if (normalizedThread || nextIssues) {
        applyThreadDetailSnapshot(selectedThreadId, {
          thread: normalizedThread ?? undefined,
          issues: nextIssues
        });
      }

      releaseLocalThreadInterrupt(selectedThreadId, activeIssue?.id ?? "");
      void loadThreadMessages(selectedThreadId, { force: true });
      return true;
    } catch (error) {
      releaseLocalThreadInterrupt(selectedThreadId, activeIssue?.id ?? "");
      applyThreadDetailSnapshot(selectedThreadId, {
        thread: previousThread ?? undefined,
        issues: previousIssues
      });
      void loadThreadMessages(selectedThreadId, { force: true });
      notifyError(error);
      return false;
    }
  }, [
    applyThreadDetailSnapshot,
    currentThreadDetail?.issues,
    currentThreadDetail?.thread,
    holdLocalThreadInterrupt,
    loadThreadMessages,
    notifyError,
    releaseLocalThreadInterrupt,
    selectedBridgeId,
    selectedThread,
    selectedThreadId,
    session?.loginId
  ]);

  const handleCreateInstantThread = useCallback(async () => {
    if (!session?.loginId || !selectedBridgeId) {
      return false;
    }

    const projectId = selectedProjectId || draftThreadProjectId;

    if (!projectId) {
      showMobileAlert("프로젝트를 먼저 선택해 주세요.", {
        tone: "error",
        title: "인스턴트 채팅"
      });
      return false;
    }

    const instantThreadReady = await clearInstantThreadIfNeeded("", { requireRunningConfirmation: true });

    if (!instantThreadReady) {
      return false;
    }

    setThreadBusy(true);

    try {
      const createThreadPath =
        `/api/projects/${encodeURIComponent(projectId)}/threads?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`;
      const createThreadOptions = {
        method: "POST",
        body: JSON.stringify({
          name: "인스턴트 채팅"
        })
      };

      let createResponse;

      try {
        createResponse = await apiRequest(createThreadPath, createThreadOptions);
      } catch (error) {
        throw new Error(
          formatApiRequestError(
            createThreadPath,
            createThreadOptions,
            error,
            `인스턴트 채팅 생성 실패\n- project_id: ${projectId}\n- bridge_id: ${selectedBridgeId}`
          )
        );
      }

      const threadId = String(createResponse?.thread?.id ?? "").trim();

      if (!threadId) {
        throw new Error("인스턴트 채팅을 생성하지 못했습니다.");
      }

      const nextThread =
        normalizeThread(createResponse?.thread, projectId) ??
        mergeThreads([], createResponse?.threads ?? []).find((thread) => thread.id === threadId) ??
        {
          id: threadId,
          title: "인스턴트 채팅",
          project_id: projectId,
          status: "idle",
          progress: 0,
          last_event: "thread.created",
          last_message: "",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

      setThreads((current) => upsertThread(current, nextThread));
      setThreadListsByProjectId((current) => ({
        ...current,
        [projectId]: upsertThread(current[projectId] ?? [], nextThread)
      }));
      setThreadOrderByProjectId((current) => {
        const currentOrder = normalizeThreadOrder(current[projectId] ?? []);
        const nextOrder = [threadId, ...currentOrder.filter((id) => id !== threadId)];

        if (currentOrder.length === nextOrder.length && currentOrder.every((id, index) => id === nextOrder[index])) {
          return current;
        }

        return {
          ...current,
          [projectId]: nextOrder
        };
      });
      setThreadDetails((current) => ({
        ...current,
        [threadId]: {
          ...(current[threadId] ?? {}),
          thread: nextThread,
          issues: current[threadId]?.issues ?? [],
          messages: current[threadId]?.messages ?? [],
          loading: false,
          error: ""
        }
      }));

      setSelectedTodoChatId("");
      setSelectedThreadId(threadId);
      setInstantThreadId(threadId);
      setDraftThreadProjectId("");
      setThreadMessageFilter("all");
      setActiveView(wideThreadSplitEnabled ? "inbox" : "thread");

      return true;
    } catch (error) {
      notifyError(error);
      return false;
    } finally {
      setThreadBusy(false);
    }
  }, [
    apiRequest,
    clearInstantThreadIfNeeded,
    draftThreadProjectId,
    notifyError,
    selectedBridgeId,
    selectedProjectId,
    session,
    session?.loginId,
    setActiveView,
    setDraftThreadProjectId,
    setInstantThreadId,
    setSelectedThreadId,
    setSelectedTodoChatId,
    showMobileAlert,
    wideThreadSplitEnabled
  ]);

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
        body: JSON.stringify({
          ...payload,
          source_app_id: ISSUE_SOURCE_APP_ID
        })
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
              issue_status: optimisticIssue.status,
              attachments: normalizeMessageAttachments(optimisticIssue.attachments ?? payload.attachments)
            }
          ]
        : [];

      const stayOnThread = Boolean(options?.stayOnThread);

      if (threadId) {
        clearInstantThreadIfNeeded(threadId);

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
        setActiveView(wideThreadSplitEnabled ? "inbox" : "thread");
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
      notifyError(error);
      return false;
    } finally {
      setThreadBusy(false);
    }
  };

  const handleAppendThreadMessage = async (threadId, payload = {}) => {
    if (!session?.loginId || !selectedBridgeId || !threadId) {
      return false;
    }

    const prompt = String(payload.prompt ?? "").trim();

    setThreadBusy(true);

    try {
      const createIssuePath =
        `/api/threads/${threadId}/issues?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`;
      const createIssueOptions = {
        method: "POST",
        body: JSON.stringify({
          prompt,
          attachments: normalizeMessageAttachments(payload.attachments),
          source_app_id: ISSUE_SOURCE_APP_ID
        })
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
            issue_status: optimisticIssue?.status ?? "running",
            attachments: normalizeMessageAttachments(optimisticIssue?.attachments ?? payload.attachments)
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
      setActiveView(wideThreadSplitEnabled ? "inbox" : "thread");

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
      notifyError(error);
      return false;
    } finally {
      setThreadBusy(false);
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
        const firstFailure = failedThreadIds[0];
        const partialDeleteMessage =
          deletedThreadIds.length > 0
            ? `${deletedThreadIds.length}개를 삭제했고 ${failedThreadIds.length}개는 실패했습니다.\n첫 실패: ${firstFailure.message}`
            : firstFailure.message;
        showMobileAlert(partialDeleteMessage, {
          tone: "error",
          title: "삭제 일부 실패",
          durationMs: MOBILE_NOTICE_ERROR_DISMISS_MS + 1000
        });

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
  }, [removeDeletedThreadsFromState, requestThreadDeleteConfirmation, selectedBridgeId, session?.loginId, showMobileAlert]);

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
        setProjects((current) => mergeProjectSnapshots(current, response.projects));
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

      setProjectFilterUsage((current) => {
        if (!current || !current[projectId]) {
          return current;
        }

        const next = { ...current };
        delete next[projectId];
        return next;
      });
      setProjectChipOrder((current) => normalizeProjectChipOrder(current, updatedProjects.map((project) => project.id)));
      setThreadOrderByProjectId((current) => {
        if (!current || !current[projectId]) {
          return current;
        }

        const next = { ...current };
        delete next[projectId];
        return next;
      });

      setDraftThreadProjectId((current) => (current === projectId ? "" : current));
      if (projectEditTargetId === projectId) {
        setProjectEditDialogOpen(false);
        setProjectEditTargetId("");
        setProjectEditError("");
      }
      removeThreadComposerDrafts([
        buildThreadComposerDraftKey({ projectId, isDraft: true }),
        ...threads
          .filter((thread) => thread.project_id === projectId)
          .map((thread) => buildThreadComposerDraftKey({ threadId: thread.id }))
      ]);

      return true;
    } catch (error) {
      notifyError(error);
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
        setProjects((current) => mergeProjectSnapshots(current, nextProjects));
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
      notifyError(error);
    } finally {
      setProjectBusy(false);
    }
  };

  const handleCloseThreadCreateDialog = () => {
    if (threadBusy) {
      return;
    }

    setThreadCreateDialogOpen(false);
  };

  const handleSubmitThreadCreateDialog = async ({ title, developerInstructions }) => {
    if (!session?.loginId || !selectedBridgeId || !selectedProjectId) {
      return false;
    }

    const projectId = selectedProjectId;
    const bridgeId = selectedBridgeId;
    setThreadBusy(true);

    try {
      const nextTitle = String(title ?? "").trim() || "제목없음";
      const nextDeveloperInstructions = String(developerInstructions ?? "");
      const createThreadPath =
        `/api/projects/${encodeURIComponent(projectId)}/threads?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`;
      const createThreadOptions = {
        method: "POST",
        body: JSON.stringify({
          name: nextTitle
        })
      };
      let createResponse;

      try {
        createResponse = await apiRequest(createThreadPath, createThreadOptions);
      } catch (error) {
        throw new Error(
          formatApiRequestError(
            createThreadPath,
            createThreadOptions,
            error,
            `채팅창 생성 실패\n- project_id: ${projectId}\n- bridge_id: ${bridgeId}`
          )
        );
      }

      const createdThreadId = String(createResponse?.thread?.id ?? "").trim();

      if (!createdThreadId) {
        throw new Error("채팅창을 생성하지 못했습니다.");
      }

      let nextThread =
        normalizeThread(createResponse?.thread, projectId) ??
        mergeThreads([], createResponse?.threads ?? []).find((thread) => thread.id === createdThreadId) ??
        null;

      const trimmedDeveloperInstructions = nextDeveloperInstructions.trim();
      let postCreateWarning = "";

      if (trimmedDeveloperInstructions) {
        const updateThreadPath =
          `/api/threads/${encodeURIComponent(createdThreadId)}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`;
        const updateThreadOptions = {
          method: "PATCH",
          body: JSON.stringify({
            developer_instructions: nextDeveloperInstructions,
            update_developer_instructions: true
          })
        };
        let updateResponse;

        try {
          updateResponse = await apiRequest(updateThreadPath, updateThreadOptions);
        } catch (error) {
          const message = getThreadDeveloperInstructionSaveErrorMessage(error);
          postCreateWarning = `${nextTitle} 채팅창은 생성됐지만 개발지침 저장에 실패했습니다.\n${message}`;
        }

        if (updateResponse) {
          nextThread =
            normalizeThread(updateResponse?.thread, projectId) ??
            mergeThreads([], updateResponse?.threads ?? []).find((thread) => thread.id === createdThreadId) ??
            nextThread;
        }
      }

      if (!nextThread) {
        nextThread = {
          id: createdThreadId,
          title: nextTitle,
          project_id: projectId,
          developer_instructions: trimmedDeveloperInstructions,
          status: "idle",
          progress: 0,
          last_event: "thread.created",
          last_message: "",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
      }

      clearInstantThreadIfNeeded(createdThreadId);

      setThreads((current) => upsertThread(current, nextThread));
      setThreadListsByProjectId((current) => ({
        ...current,
        [projectId]: upsertThread(current[projectId] ?? [], nextThread)
      }));
      setThreadDetails((current) => ({
        ...current,
        [createdThreadId]: {
          ...(current[createdThreadId] ?? {}),
          thread: nextThread,
          issues: current[createdThreadId]?.issues ?? [],
          messages: current[createdThreadId]?.messages ?? [],
          loading: false,
          error: ""
        }
      }));

      setSelectedTodoChatId("");
      setSelectedThreadId(createdThreadId);
      setDraftThreadProjectId("");
      setThreadMessageFilter("all");
      setActiveView(wideThreadSplitEnabled ? "inbox" : "thread");
      setThreadCreateDialogOpen(false);

      if (postCreateWarning) {
        showMobileAlert(postCreateWarning, {
          tone: "error",
          title: "개발지침 저장 실패",
          durationMs: MOBILE_NOTICE_ERROR_DISMISS_MS + 1000
        });
      }

      return true;
    } catch (error) {
      notifyError(error);
      return false;
    } finally {
      setThreadBusy(false);
    }
  };

  const handleOpenProjectInstructionDialog = (instructionType) => {
    if (!selectedProjectId) {
      return;
    }

    setProjectInstructionType(instructionType === "developer" ? "developer" : "base");
    setProjectInstructionDialogOpen(true);
  };

  const handleOpenProjectEditDialog = (project) => {
    const projectId = String(project?.id ?? selectedProjectId ?? "").trim();

    if (!projectId) {
      return;
    }

    setProjectEditError("");
    setProjectEditTargetId(projectId);
    setProjectEditDialogOpen(true);
  };

  const handleCloseProjectInstructionDialog = () => {
    if (projectInstructionBusy) {
      return;
    }

    setProjectInstructionDialogOpen(false);
  };

  const handleCloseProjectEditDialog = () => {
    if (projectEditBusy) {
      return;
    }

    setProjectEditError("");
    setProjectEditDialogOpen(false);
    setProjectEditTargetId("");
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
        setProjects((current) => mergeProjectSnapshots(current, response.projects));
      } else if (response?.project?.id) {
        setProjects((current) =>
          current.map((project) => (project.id === response.project.id ? { ...project, ...response.project } : project))
        );
      }

      setProjectInstructionDialogOpen(false);
    } catch (error) {
      notifyError(error);
    } finally {
      setProjectInstructionBusy(false);
    }
  };

  const handleSubmitProjectEdit = async ({ name, developerInstructions }) => {
    const projectId = String(projectEditTarget?.id ?? "").trim();
    const nextName = String(name ?? "").trim();

    if (!session?.loginId || !selectedBridgeId || !projectId || !nextName) {
      return false;
    }

    setProjectEditBusy(true);
    setProjectEditError("");

    try {
      const response = await apiRequest(
        `/api/projects/${encodeURIComponent(projectId)}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            name: nextName,
            developer_instructions: String(developerInstructions ?? ""),
            update_developer_instructions: true
          })
        }
      );

      let updatedProject = null;

      if (Array.isArray(response?.projects)) {
        setProjects((current) => mergeProjectSnapshots(current, response.projects));
        updatedProject = response.projects.find((project) => project.id === projectId) ?? null;
      } else if (response?.project?.id) {
        updatedProject = response.project.id === projectId ? response.project : null;
        setProjects((current) =>
          current.map((project) => (project.id === response.project.id ? { ...project, ...response.project } : project))
        );
      }

      if (updatedProject?.id) {
        setProjectEditTargetId(updatedProject.id);
      }

      setProjectEditDialogOpen(false);
      setProjectEditTargetId("");
      setProjectEditError("");
      return true;
    } catch (error) {
      setProjectEditError(error.message ?? "프로젝트를 수정하지 못했습니다.");
      return false;
    } finally {
      setProjectEditBusy(false);
    }
  };

  const handleOpenThreadInstructionDialog = (thread) => {
    const normalizedThread = normalizeThread(thread);

    if (!normalizedThread) {
      return;
    }

    setThreadInstructionError("");
    setThreadInstructionTarget(normalizedThread);
    setThreadInstructionDialogOpen(true);
  };

  const handleCloseThreadInstructionDialog = () => {
    if (threadInstructionBusy) {
      return;
    }

    setThreadInstructionError("");
    setThreadInstructionDialogOpen(false);
    setThreadInstructionTarget(null);
  };

  const handleBackToMainPage = useCallback(() => {
    clearInstantThreadIfNeeded();
    setSelectedThreadId("");
    setSelectedTodoChatId("");
    setDraftThreadProjectId("");
    setActiveView("inbox");
    activeViewRef.current = "inbox";
  }, [clearInstantThreadIfNeeded]);

  const consumeStandaloneBackPress = useCallback(() => {
    if (mobileConfirmResolverRef.current) {
      resolveMobileConfirm(false);
      return true;
    }

    if (threadDeleteDialogOpenRef.current) {
      if (threadBusyRef.current) {
        return true;
      }

      closeThreadDeleteDialog(false);
      return true;
    }

    if (threadInstructionDialogOpenRef.current) {
      if (threadInstructionBusyRef.current) {
        return true;
      }

      setThreadInstructionError("");
      setThreadInstructionDialogOpen(false);
      setThreadInstructionTarget(null);
      return true;
    }

    if (projectEditDialogOpenRef.current) {
      if (projectEditBusyRef.current) {
        return true;
      }

      setProjectEditError("");
      setProjectEditDialogOpen(false);
      setProjectEditTargetId("");
      return true;
    }

    if (projectInstructionDialogOpenRef.current) {
      if (projectInstructionBusyRef.current) {
        return true;
      }

      setProjectInstructionDialogOpen(false);
      return true;
    }

    if (threadCreateDialogOpenRef.current) {
      if (threadBusyRef.current) {
        return true;
      }

      setThreadCreateDialogOpen(false);
      return true;
    }

    if (projectComposerOpenRef.current) {
      setProjectComposerOpen(false);
      setSelectedWorkspacePath("");
      setFolderState({ path: "", parent_path: null, entries: [] });
      return true;
    }

    if (utilityOpenRef.current) {
      setUtilityOpen(false);
      return true;
    }

    return false;
  }, [closeThreadDeleteDialog, resolveMobileConfirm]);

  const requestStandaloneAppExit = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }

    allowStandaloneNativeBackRef.current = true;

    window.setTimeout(() => {
      try {
        window.close();
      } catch {
        // noop
      }

      window.history.back();
    }, 0);
  }, []);

  const handleSubmitThreadInstruction = async ({ title, developerInstructions }) => {
    const threadId = String(threadInstructionTarget?.id ?? "").trim();
    const nextTitle = String(title ?? "").trim();

    if (!session?.loginId || !selectedBridgeId || !threadId || !nextTitle) {
      return;
    }

    setThreadInstructionBusy(true);
    setThreadInstructionError("");

    try {
      const requestBody = {
        name: nextTitle
      };

      if (threadInstructionSupported) {
        requestBody.developer_instructions = String(developerInstructions ?? "");
        requestBody.update_developer_instructions = true;
      }

      const response = await apiRequest(
        `/api/threads/${encodeURIComponent(threadId)}?login_id=${encodeURIComponent(session.loginId)}&bridge_id=${encodeURIComponent(selectedBridgeId)}`,
        {
          method: "PATCH",
          body: JSON.stringify(requestBody)
        }
      );

      if (response?.thread) {
        const nextThread = normalizeThread(response.thread);

        if (nextThread) {
          setThreads((current) => upsertThread(current, nextThread));
          setThreadListsByProjectId((current) => {
            if (!nextThread.project_id) {
              return current;
            }

            return {
              ...current,
              [nextThread.project_id]: upsertThread(current[nextThread.project_id] ?? [], nextThread)
            };
          });
          setThreadDetails((current) => ({
            ...current,
            [threadId]: {
              ...(current[threadId] ?? {}),
              thread: nextThread
            }
          }));
          setThreadInstructionTarget(nextThread);
        }
      } else if (Array.isArray(response?.threads)) {
        const nextThreads = mergeThreads([], response.threads);
        const nextThread = nextThreads.find((thread) => thread.id === threadId) ?? null;

        if (nextThread) {
          setThreads((current) => {
            const preserved = current.filter((thread) => thread.project_id !== nextThread.project_id);
            return mergeThreads(preserved, nextThreads);
          });
          setThreadListsByProjectId((current) => ({
            ...current,
            [nextThread.project_id]: nextThreads
          }));
          setThreadDetails((current) => ({
            ...current,
            [threadId]: {
              ...(current[threadId] ?? {}),
              thread: nextThread
            }
          }));
          setThreadInstructionTarget(nextThread);
        }
      }

      setThreadInstructionError("");
      setThreadInstructionDialogOpen(false);
      setThreadInstructionTarget(null);
    } catch (error) {
      const message = threadInstructionSupported
        ? getThreadDeveloperInstructionSaveErrorMessage(error)
        : error.message ?? "채팅창을 수정하지 못했습니다.";
      setThreadInstructionError(message);
    } finally {
      setThreadInstructionBusy(false);
    }
  };

  const handleRefresh = async () => {
    if (!session?.loginId) {
      return;
    }

    try {
      const nextBridges = await syncBridgeList(session);
      const targetBridgeId = selectedBridgeId || nextBridges[0]?.bridge_id;

      if (targetBridgeId) {
        await loadBridgeWorkspace(session, targetBridgeId);
      }
    } catch (error) {
      notifyError(error);
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
    clearInstantThreadIfNeeded();
    setSelectedThreadId("");
    setSelectedTodoChatId("");
    setDraftThreadProjectId("");
    setActiveView("inbox");
  };

  const handleSelectThread = (threadId) => {
    clearInstantThreadIfNeeded(threadId);

    startTransition(() => {
      setDraftThreadProjectId("");
      setSelectedThreadId(threadId);
      setThreadMessageFilter("all");
      setActiveView(wideThreadSplitEnabled ? "inbox" : "thread");
    });
  };

  const handleOpenNewThread = (projectId) => {
    const nextProjectId = projectId || selectedProjectId || projects[0]?.id || "";

    if (!nextProjectId) {
      return;
    }

    clearInstantThreadIfNeeded();
    selectProjectScope(nextProjectId);
    setSelectedThreadId("");
    setSelectedTodoChatId("");
    setDraftThreadProjectId("");
    removeThreadComposerDrafts([buildThreadComposerDraftKey({ projectId: nextProjectId, isDraft: true })]);
    setThreadMessageFilter("all");
    setActiveView("inbox");
    setThreadCreateDialogOpen(true);
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

    if (pwaUpdateActivationInFlightRef.current) {
      return;
    }

    pwaUpdateActivationInFlightRef.current = true;
    setPwaUpdateBusy(true);
    setPwaUpdateVisible(true);
    const activate = pendingUpdateActivatorRef.current;
    window[PWA_UPDATE_ACTIVATOR_KEY] = null;
    pendingUpdateActivatorRef.current = null;

    if (typeof activate === "function") {
      activate();
    } else {
      window.location.reload();
    }
  }, []);

  const registerMainPageBackHandler = useCallback((handler) => {
    mainPageBackHandlerRef.current = typeof handler === "function" ? handler : null;
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !window.history?.pushState || !session || !isStandaloneDisplayMode()) {
      return undefined;
    }

    const pushStandaloneBackGuard = () => {
      if (allowStandaloneNativeBackRef.current) {
        return;
      }

      window.history.pushState({ octopStandaloneBackGuard: true }, "", window.location.href);
    };

    const handleStandalonePopState = (event) => {
      if (allowStandaloneNativeBackRef.current) {
        allowStandaloneNativeBackRef.current = false;
        return;
      }

      event?.preventDefault?.();

      if (consumeStandaloneBackPress()) {
        pushStandaloneBackGuard();
        return;
      }

      if (typeof mainPageBackHandlerRef.current === "function" && mainPageBackHandlerRef.current() === true) {
        pushStandaloneBackGuard();
        return;
      }

      if (standaloneBackNavigationInFlightRef.current) {
        pushStandaloneBackGuard();
        return;
      }

      standaloneBackNavigationInFlightRef.current = true;

      void (async () => {
        try {
          const hasNestedView = hasStandaloneVisibleNestedView({
            activeView: activeViewRef.current,
            selectedScopeKind: selectedScopeKindRef.current,
            selectedThreadId: selectedThreadIdRef.current,
            selectedTodoChatId: selectedTodoChatIdRef.current,
            draftThreadProjectId: draftThreadProjectIdRef.current,
            wideSplitEnabled: wideThreadSplitEnabledRef.current
          });

          if (hasNestedView) {
            handleBackToMainPage();
            pushStandaloneBackGuard();
            return;
          }

          const confirmed = await confirmMobileAction({
            title: "앱 종료",
            message: "OctOP 앱을 종료하시겠습니까?",
            confirmLabel: "종료",
            cancelLabel: "취소",
            tone: "danger"
          });

          if (confirmed) {
            requestStandaloneAppExit();
            return;
          }

          pushStandaloneBackGuard();
        } finally {
          standaloneBackNavigationInFlightRef.current = false;
        }
      })();
    };

    pushStandaloneBackGuard();
    window.addEventListener("popstate", handleStandalonePopState);

    return () => {
      window.removeEventListener("popstate", handleStandalonePopState);
      standaloneBackNavigationInFlightRef.current = false;
      allowStandaloneNativeBackRef.current = false;
      mainPageBackHandlerRef.current = null;
    };
  }, [confirmMobileAction, consumeStandaloneBackPress, handleBackToMainPage, requestStandaloneAppExit, session]);

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

  const currentThreadDetailState = threadDetails[selectedThreadId] ?? {
    messages: [],
    loading: false,
    error: "",
    history_loading: false,
    history_error: "",
    loaded_issue_ids: []
  };

  return (
    <MobileFeedbackContext.Provider value={mobileFeedbackValue}>
      <MainPage
        pushNotificationCard={
          <PushNotificationCard
            apiRequest={apiRequest}
            session={session}
            selectedBridgeId={selectedBridgeId}
          />
        }
        session={session}
        bridges={bridges}
        status={status}
        bridgeSignal={bridgeSignal}
        bridgeAvailable={bridgeAvailable}
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
        threadComposerDrafts={threadComposerDrafts}
        projectFilterUsage={projectFilterUsage}
        projectChipOrder={projectChipOrder}
        threadOrderByProjectId={threadOrderByProjectId}
        search={search}
        loadingState={loadingState}
        utilityOpen={utilityOpen}
        projectBusy={projectBusy}
        threadCreateDialogOpen={threadCreateDialogOpen}
        projectInstructionBusy={projectInstructionBusy}
        projectEditDialogOpen={projectEditDialogOpen}
        projectEditTarget={projectEditTarget}
        projectEditBusy={projectEditBusy}
        projectEditError={projectEditError}
        threadInstructionBusy={threadInstructionBusy}
        threadBusy={threadBusy}
        threadDeleteDialog={threadDeleteDialog}
        todoBusy={todoBusy}
        todoRenameBusy={todoRenameBusy}
        todoTransferBusy={todoTransferBusy}
        projectComposerOpen={projectComposerOpen}
        projectInstructionDialogOpen={projectInstructionDialogOpen}
        projectInstructionType={projectInstructionType}
        threadInstructionDialogOpen={threadInstructionDialogOpen}
        threadInstructionTarget={threadInstructionTarget}
        threadInstructionSupported={threadInstructionSupported}
        installPromptVisible={installPromptVisible}
        installBusy={installBusy}
        activeView={activeView}
        threadMessageFilter={threadMessageFilter}
        threadDetail={currentThreadDetailState}
        onSearchChange={setSearch}
        onChangeThreadMessageFilter={setThreadMessageFilter}
        onChangeProjectChipOrder={setProjectChipOrder}
        onChangeThreadOrder={(projectId, nextThreadOrder) => {
          const normalizedProjectId = String(projectId ?? "").trim();

          if (!normalizedProjectId) {
            return;
          }

          setThreadOrderByProjectId((current) => {
            const normalizedThreadOrder = normalizeThreadOrder(nextThreadOrder);
            const next = { ...current };

            if (normalizedThreadOrder.length === 0) {
              delete next[normalizedProjectId];
            } else {
              next[normalizedProjectId] = normalizedThreadOrder;
            }

            return areStringArrayRecordEqual(current, next) ? current : next;
          });
        }}
        onSelectBridge={setSelectedBridgeId}
        onOpenBridgeDropdown={handleOpenBridgeDropdown}
        onSelectProject={handleSelectProject}
        onSelectTodoScope={handleSelectTodoScope}
        onSelectThread={handleSelectThread}
        onSelectTodoChat={handleSelectTodoChat}
        onOpenNewThread={handleOpenNewThread}
        onOpenNewTodoChat={() => void handleOpenNewTodoChat()}
        onOpenUtility={() => setUtilityOpen(true)}
        onOpenProjectComposer={() => void handleOpenProjectComposer()}
        onOpenProjectInstructionDialog={handleOpenProjectInstructionDialog}
        onOpenProjectEditDialog={handleOpenProjectEditDialog}
        onOpenThreadInstructionDialog={handleOpenThreadInstructionDialog}
        onCloseThreadCreateDialog={handleCloseThreadCreateDialog}
        onInstallPwa={() => void handleInstallPwa()}
        onDismissInstallPrompt={handleDismissInstallPrompt}
        onCloseUtility={() => setUtilityOpen(false)}
        onCloseProjectComposer={handleCloseProjectComposer}
        onCloseProjectInstructionDialog={handleCloseProjectInstructionDialog}
        onCloseProjectEditDialog={handleCloseProjectEditDialog}
        onCloseThreadInstructionDialog={handleCloseThreadInstructionDialog}
        onBrowseWorkspaceRoot={(path) => browseWorkspacePath(path)}
        onBrowseFolder={(path) => browseWorkspacePath(path)}
        onSelectWorkspace={setSelectedWorkspacePath}
        onSubmitProject={handleCreateProject}
        onSubmitThreadCreateDialog={handleSubmitThreadCreateDialog}
        onSubmitProjectInstruction={handleSubmitProjectInstruction}
        onSubmitProjectEdit={handleSubmitProjectEdit}
        onSubmitThreadInstruction={handleSubmitThreadInstruction}
        onCreateInstantThread={() => void handleCreateInstantThread()}
        onCreateThread={handleCreateThread}
        onAppendThreadMessage={handleAppendThreadMessage}
        onChangeThreadComposerDraft={updateThreadComposerDraft}
        onSubmitTodoMessage={handleSubmitTodoMessage}
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
        onLoadOlderMessages={loadOlderThreadHistory}
        onStopThreadExecution={handleStopThreadExecution}
        onInterruptThreadIssue={handleInterruptThreadIssue}
        onRetryThreadIssue={handleRetryThreadIssue}
        onDeleteThreadIssue={handleDeleteThreadIssue}
        onRefresh={() => void handleRefresh()}
        bridgeListSyncing={bridgeListSyncing}
        onLogout={handleLogout}
        onBackToInbox={handleBackToInbox}
        onRegisterBackHandler={registerMainPageBackHandler}
      />
      <PwaUpdateDialog visible={pwaUpdateVisible} busy={pwaUpdateBusy} onConfirm={handleConfirmPwaUpdate} />
      <MobileNoticeCenter notices={mobileNotices} onDismiss={dismissMobileNotice} />
      <MobileConfirmDialog state={mobileConfirmState} onResolve={resolveMobileConfirm} />
    </MobileFeedbackContext.Provider>
  );
}
