import {
  Suspense,
  lazy,
  startTransition,
  useCallback,
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
  resolveRealtimeProgressText,
  reduceBridgeDisconnectEvidence,
  resolveApiBaseUrl
} from "../../../packages/domain/src/index.js";
import { PWA_UPDATE_ACTIVATOR_KEY, PWA_UPDATE_READY_EVENT } from "./pwaEvents.js";
import buildMobileDetailProps from "./buildMobileDetailProps.js";
import buildMobileInboxScreenProps from "./buildMobileInboxScreenProps.js";
import buildMobileUiHelperBundles from "./buildMobileUiHelperBundles.js";
import PushNotificationCard from "./PushNotificationCard.jsx";
import MobileInboxScreen, {
  MobileInboxActionBar,
  MobileInboxChrome,
  MobileInboxListContent
} from "./mobileInboxScreen.jsx";
import {
  MessageBubble,
  RichMessageContent,
  normalizeAssistantMessageContent,
  summarizeMessageContent
} from "./mobileRichMessageUi.jsx";
import { createThreadTitleFromPrompt } from "./mobileOverlayUtils.js";
import useMobileDeferredOverlayProps from "./useMobileDeferredOverlayProps.js";
import useMobileFeedbackState from "./useMobileFeedbackState.js";
import useProjectChipReorder from "./useProjectChipReorder.js";
import useThreadSelectionState from "./useThreadSelectionState.js";
import useThreadListReorder from "./useThreadListReorder.js";
import useWideThreadSplitResize from "./useWideThreadSplitResize.js";
import {
  LoginPage,
  MobileConfirmDialog,
  MobileFeedbackContext,
  MobileNoticeCenter,
  PwaUpdateDialog,
  useMobileFeedback
} from "./mobileSharedUi.jsx";

const MobileDeferredOverlays = lazy(() => import("./MobileDeferredOverlays.jsx"));
const MobileThreadStandaloneScreen = lazy(() => import("./mobileThreadStandaloneScreen.jsx"));
const MobileTodoStandaloneScreen = lazy(() => import("./mobileTodoStandaloneScreen.jsx"));
const MobileWideSplitWorkspace = lazy(() => import("./mobileWideSplitWorkspace.jsx"));

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
const SERVICE_WORKER_CLIENT_CONTEXT_REQUEST_MESSAGE_TYPE = "octop.client.context.request";
const SERVICE_WORKER_NOTIFICATION_LAUNCH_MESSAGE_TYPE = "octop.push.launch";
const API_BASE_URL = resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
const VOICE_SESSION_ENABLED = String(import.meta.env.VITE_VOICE_SESSION_ENABLED ?? "true").trim().toLowerCase() !== "false";
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

function readPushDeepLinkFromValue(value) {
  if (typeof window === "undefined") {
    return null;
  }

  let url;

  try {
    url = new URL(typeof value === "string" && value ? value : window.location.href, window.location.origin);
  } catch {
    return null;
  }

  const params = url.searchParams;
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

function readPushDeepLink() {
  return readPushDeepLinkFromValue(typeof window === "undefined" ? "" : window.location.href);
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

  if (!isStandaloneDisplayMode()) {
    url.searchParams.delete("client_mode");
  }

  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function isStandaloneDisplayMode() {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    if (window.matchMedia?.("(display-mode: standalone)").matches) {
      return true;
    }
  } catch {
    // ignore unsupported display-mode queries
  }

  return window.navigator.standalone === true;
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

function createInitialThreadVoiceState() {
  return {
    enabled: false,
    mode: "off",
    promptSubmittedAt: "",
    lastSubmittedPrompt: "",
    delegatedThreadId: "",
    capabilityDateKey: "",
    realtimeStatus: "unknown",
    ttsStatus: "unknown",
    lastError: ""
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

const SYSTEM_ACTIVITY_MESSAGE_KINDS = new Set([
  "tool_call",
  "tool_result",
  "mcp_call",
  "mcp_result",
  "skill_call",
  "skill_result",
  "function_call",
  "function_result"
]);
const HIDDEN_THREAD_PREVIEW_MESSAGE_KINDS = new Set([
  "tool_call",
  "mcp_call",
  "skill_call",
  "function_call"
]);

const RUN_TIMELINE_MESSAGE_TITLE_BY_KIND = {
  tool_call: "도구 호출",
  tool_result: "도구 응답",
  mcp_call: "MCP 호출",
  mcp_result: "MCP 응답",
  skill_call: "스킬 호출",
  skill_result: "스킬 응답",
  function_call: "함수 호출",
  function_result: "함수 응답",
  handoff_summary: "핸드오프 요약"
};

function shouldHideThreadPreviewMessage(value = "") {
  return HIDDEN_THREAD_PREVIEW_MESSAGE_KINDS.has(String(value ?? "").trim());
}

function isSystemActivityMessageKind(value = "") {
  const normalizedKind = String(value ?? "").trim();
  return normalizedKind === "handoff_summary" || SYSTEM_ACTIVITY_MESSAGE_KINDS.has(normalizedKind);
}

function getThreadPreviewMessageKind(thread) {
  const explicitKind = String(thread?.last_message_kind ?? thread?.lastMessageKind ?? "")
    .trim()
    .toLowerCase();

  if (explicitKind) {
    return explicitKind;
  }

  const lastEvent = String(thread?.last_event ?? "")
    .trim()
    .toLowerCase();

  if (lastEvent.startsWith("item.")) {
    return lastEvent.slice(5);
  }

  return "";
}

function shouldHideThreadPreviewForThread(thread) {
  return shouldHideThreadPreviewMessage(getThreadPreviewMessageKind(thread));
}

function buildRunTimeline(thread, messages = []) {
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

  const timelineMessages = (Array.isArray(messages) ? messages : [])
    .filter((message) => {
      const normalizedKind = String(message?.kind ?? "").trim();
      return isSystemActivityMessageKind(normalizedKind);
    })
    .map((message, index) => ({
      id: message.id ?? `${thread.id}-message-${index}`,
      title: RUN_TIMELINE_MESSAGE_TITLE_BY_KIND[String(message?.kind ?? "").trim()] ?? "진행 내역",
      description: String(message?.content ?? "").trim() || "내용이 비어 있습니다.",
      timestamp: message.timestamp ?? message.created_at ?? thread.updated_at
    }));

  return [...entries, ...timelineMessages]
    .filter((entry) => entry.timestamp)
    .sort((left, right) => Date.parse(left.timestamp ?? 0) - Date.parse(right.timestamp ?? 0));
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
  return resolveRealtimeProgressText(entity, { language: "ko" });
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

function buildSpeechFriendlyMessageText(content) {
  return String(content ?? "")
    .replace(/```[\s\S]*?```/g, " 코드 블록 ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " 이미지 ")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/[*#>~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
    last_message_kind: thread.last_message_kind ?? thread.lastMessageKind ?? "",
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
    last_message_kind: issue.last_message_kind ?? issue.lastMessageKind ?? "",
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
          ...(nextMessage
            ? {
                last_message: nextMessage,
                last_message_kind: ""
              }
            : {}),
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
        last_message_kind: "message",
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
                last_message: String(payload.turn.error.message).trim(),
                last_message_kind: ""
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
  const rawPreview =
    shouldHideThreadPreviewForThread(thread)
      ? getRealtimeProgressText(thread)
      : thread.last_message || getRealtimeProgressText(thread);
  const normalizedPreview = normalizeAssistantMessageContent(rawPreview)
    .replace(/\s+/g, " ")
    .trim();

  return summarizeMessageContent(normalizedPreview, 120);
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
  onRegisterBackHandler,
  threadVoiceState,
  voiceFollowupThreadDetail,
  onChangeThreadVoiceState
}) {
  const { confirm: confirmMobileAction } = useMobileFeedback();
  const [searchOpen, setSearchOpen] = useState(false);
  const handleToggleSearch = useCallback(() => {
    setSearchOpen((current) => !current);
  }, []);
  const [projectActionProjectId, setProjectActionProjectId] = useState("");
  const [todoChatBeingEdited, setTodoChatBeingEdited] = useState(null);
  const [activeTodoMessage, setActiveTodoMessage] = useState(null);
  const [todoMessageEditorOpen, setTodoMessageEditorOpen] = useState(false);
  const [todoTransferOpen, setTodoTransferOpen] = useState(false);
  const [optimisticProjectChipOrder, setOptimisticProjectChipOrder] = useState(null);
  const [optimisticThreadOrderByProjectId, setOptimisticThreadOrderByProjectId] = useState({});
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
  const {
    inlineIssueComposerHelpers,
    todoChatDetailUiComponents,
    todoChatDetailUtils,
    threadDetailHelpers,
    threadListItemHelpers
  } = buildMobileUiHelperBundles({
    MessageBubble,
    RichMessageContent,
    CHAT_COMPOSER_MAX_HEIGHT_PX,
    MAX_MESSAGE_ATTACHMENTS,
    MESSAGE_ATTACHMENT_ACCEPT,
    THREAD_LIST_ITEM_LONG_PRESS_MS,
    THREAD_LIST_ITEM_REORDER_MOVE_TOLERANCE_PX,
    THREAD_LIST_ITEM_LONG_PRESS_CANCEL_TOLERANCE_PX,
    appendMessageAttachments,
    buildRunTimeline,
    buildSpeechFriendlyMessageText,
    buildThreadResponseSignal,
    captureScrollAnchorSnapshot,
    cleanupMessageAttachmentUpload,
    cleanupMessageAttachmentUploads,
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
    getThreadPreview,
    getViewportOrientation,
    hasCoarsePointerDevice,
    isBottomBoundaryMomentumLocked,
    isTextInputElement,
    normalizeComposerDraftValue,
    normalizeIssue,
    normalizeMessageAttachment,
    normalizeMessageAttachments,
    resolveMessageAttachmentBadge,
    restoreScrollAnchorSnapshot,
    useTouchScrollBoundaryLock
  });

  const filteredTodoChats = useMemo(() => {
    return todoChats.filter((chat) => {
      const normalizedTitle = String(chat?.title ?? "").toLowerCase();
      const normalizedLastMessage = String(chat?.last_message ?? "").toLowerCase();
      const matchesSearch =
        !searchKeyword ||
        normalizedTitle.includes(searchKeyword) ||
        normalizedLastMessage.includes(searchKeyword);

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
      const normalizedTitle = String(thread?.title ?? "").toLowerCase();
      const normalizedLastMessage = String(thread?.last_message ?? "").toLowerCase();
      const matchesProject = !selectedProjectId || thread.project_id === selectedProjectId;
      const matchesSearch =
        !searchKeyword ||
        normalizedTitle.includes(searchKeyword) ||
        normalizedLastMessage.includes(searchKeyword);

      return matchesProject && matchesSearch;
    });
  }, [orderedThreads, searchKeyword, selectedProjectId]);
  const orderedThreadIds = useMemo(() => orderedThreads.map((thread) => thread.id), [orderedThreads]);
  const filteredThreadIds = useMemo(() => filteredThreads.map((thread) => thread.id), [filteredThreads]);
  const selectedProjectThreadIds = useMemo(
    () =>
      new Set(
        threads
          .filter((thread) => !selectedProjectId || thread.project_id === selectedProjectId)
          .map((thread) => thread.id)
      ),
    [selectedProjectId, threads]
  );
  const {
    threadSelectionMode,
    selectedThreadIds,
    resetThreadSelection,
    handleEnterThreadSelectionMode,
    handleCancelThreadSelection,
    handleToggleThreadSelection,
    handleDeleteSelectedThreads
  } = useThreadSelectionState({
    activeView,
    filteredThreads,
    isTodoScope,
    onDeleteThreads,
    selectedProjectThreadIds
  });
  const {
    projectChipRowRef,
    projectChipNodesRef,
    projectChipLayoutSnapshotRef,
    draggingProjectChipId,
    draggingProjectChipOffsetX,
    lockProjectChipDropLayout,
    registerProjectChipNode,
    resolveProjectChipSlideOffsetX,
    handleProjectChipPointerDown,
    handleProjectChipContextMenu,
    handleProjectChipClick
  } = useProjectChipReorder({
    orderedProjectIds,
    projects,
    projectChipOrder,
    optimisticProjectChipOrder,
    setOptimisticProjectChipOrder,
    onChangeProjectChipOrder,
    onOpenProjectEditDialog,
    setProjectActionProjectId,
    onResetThreadSelection: resetThreadSelection,
    onSelectProject,
    longPressMs: PROJECT_CHIP_LONG_PRESS_MS,
    reorderMoveTolerancePx: PROJECT_CHIP_REORDER_MOVE_TOLERANCE_PX,
    longPressCancelTolerancePx: PROJECT_CHIP_LONG_PRESS_CANCEL_TOLERANCE_PX,
    reorderPositionLockFrameCount: REORDER_POSITION_LOCK_FRAME_COUNT,
    utils: {
      areStringArraysEqual,
      buildProjectChipCollapsedLayouts,
      getFlexRowGapPx,
      normalizeProjectChipOrder,
      reorderProjectChipIdsByIndex
    }
  });
  const {
    registerThreadListItemNode,
    draggingThreadId,
    draggingThreadOffsetY,
    lockThreadListDropLayout,
    resolveThreadListItemSlideOffsetY,
    handleThreadReorderStart,
    handleThreadReorderMove,
    handleThreadReorderEnd,
    handleThreadReorderCancel
  } = useThreadListReorder({
    filteredThreadIds,
    optimisticThreadOrderByProjectId,
    orderedThreadIds,
    onChangeThreadOrder,
    onResetThreadSelection: resetThreadSelection,
    reorderMoveTolerancePx: THREAD_LIST_ITEM_REORDER_MOVE_TOLERANCE_PX,
    reorderPositionLockFrameCount: REORDER_POSITION_LOCK_FRAME_COUNT,
    selectedProjectId,
    setOptimisticThreadOrderByProjectId,
    threadOrderByProjectId,
    utils: {
      applySubsetThreadOrder,
      areStringArraysEqual,
      buildThreadListCollapsedLayouts,
      normalizeThreadOrder,
      reorderThreadIdsByIndex
    }
  });
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
        resetThreadSelection();
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
    resetThreadSelection,
    searchOpen,
    threadSelectionMode,
    todoChatBeingEdited,
    todoMessageEditorOpen,
    todoTransferOpen
  ]);
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
  const {
    wideThreadSplitLayoutRef,
    wideThreadSplitResizeEnabled,
    wideThreadSplitLeftWeight,
    wideThreadSplitRightWeight,
    handleWideThreadSplitResizePointerDown,
    handleWideThreadSplitResizePointerMove,
    handleWideThreadSplitResizePointerUp
  } = useWideThreadSplitResize({
    selectedBridgeId,
    sessionLoginId: session?.loginId ?? "",
    showWideSplitLayout,
    viewportWidth,
    resizeMinWidthPx: MOBILE_WIDE_THREAD_SPLIT_RESIZE_MIN_WIDTH_PX,
    utils: {
      clampWideThreadSplitRatio,
      readStoredMobileWorkspaceLayout,
      storeMobileWorkspaceLayout
    }
  });
  const splitThreadEmptyStateMessage =
    !selectedThreadId && !draftProject
      ? "채팅창이 없습니다. 좌측 쓰레드를 선택하거나 새 채팅창을 시작해 주세요."
      : "";
  const { chromeProps, listProps, actionBarProps } = buildMobileInboxScreenProps({
    appHeaderTitle,
    bridges,
    selectedBridgeId,
    bridgeSignal,
    bridgeListSyncing,
    searchOpen,
    search,
    installPromptVisible,
    installBusy,
    isTodoScope,
    orderedProjects,
    selectedProjectId,
    draggingProjectChipId,
    draggingProjectChipOffsetX,
    lockProjectChipDropLayout,
    optimisticProjectChipOrder,
    projectChipRowRef,
    projectChipNodesRef,
    projectChipLayoutSnapshotRef,
    registerProjectChipNode,
    resolveProjectChipSlideOffsetX,
    onSelectTodoScope,
    onProjectChipClick: handleProjectChipClick,
    onProjectChipPointerDown: handleProjectChipPointerDown,
    onProjectChipContextMenu: handleProjectChipContextMenu,
    onOpenUtility,
    onSelectBridge,
    onOpenBridgeDropdown,
    onToggleSearch: handleToggleSearch,
    onSearchChange,
    onInstallPwa,
    onDismissInstallPrompt,
    filteredTodoChats,
    selectedTodoChatId,
    formatRelativeTime,
    getTodoChatPreview,
    onOpenTodoChat: onSelectTodoChat,
    onRenameTodoChat: (targetChat) => setTodoChatBeingEdited(targetChat),
    onDeleteTodoChat: (targetChat) => void onDeleteTodoChat(targetChat.id),
    filteredThreads,
    selectedThreadId,
    selectedThreadIds,
    threadSelectionMode,
    signalNow,
    registerThreadListItemNode,
    draggingThreadId,
    draggingThreadOffsetY,
    lockThreadListDropLayout,
    optimisticThreadOrderByProjectId,
    resolveThreadListItemSlideOffsetY,
    onStartThreadReorder: handleThreadReorderStart,
    onMoveThreadReorder: handleThreadReorderMove,
    onEndThreadReorder: handleThreadReorderEnd,
    onCancelThreadReorder: handleThreadReorderCancel,
    onOpenThread: onSelectThread,
    onRenameThread: onOpenThreadInstructionDialog,
    onDeleteThread: (targetThread) => void onDeleteThread(targetThread.id),
    onToggleThreadSelection: handleToggleThreadSelection,
    onEnterThreadSelectionMode: handleEnterThreadSelectionMode,
    threadListItemHelpers,
    bridgeAvailable,
    loadingState,
    threadBusy,
    selectedProject,
    onCancelThreadSelection: handleCancelThreadSelection,
    onDeleteSelectedThreads: handleDeleteSelectedThreads,
    onCreateInstantThread,
    onOpenNewThread,
    onOpenNewTodoChat
  });
  const { shouldRenderDeferredOverlays, deferredOverlayProps } = useMobileDeferredOverlayProps({
    threadDeleteDialog,
    threadBusy,
    onCloseThreadDeleteDialog,
    onConfirmThreadDeleteDialog,
    todoChatBeingEdited,
    setTodoChatBeingEdited,
    todoRenameBusy,
    onRenameTodoChat,
    activeTodoMessage,
    setActiveTodoMessage,
    todoMessageEditorOpen,
    setTodoMessageEditorOpen,
    todoTransferOpen,
    setTodoTransferOpen,
    onDeleteTodoMessage,
    todoBusy,
    onEditTodoMessage,
    todoTransferBusy,
    projects,
    threadOptionsByProjectId,
    selectedProjectId,
    onEnsureProjectThreads,
    onTransferTodoMessage,
    projectActionTarget,
    projectEditBusy,
    projectBusy,
    setProjectActionProjectId,
    onOpenProjectEditDialog,
    requestProjectDeletion,
    utilityOpen,
    session,
    bridgeSignal,
    selectedProject,
    pushNotificationCard,
    onOpenProjectInstructionDialog,
    onCloseUtility,
    onOpenProjectComposer,
    onRefresh,
    onLogout,
    projectComposerOpen,
    workspaceRoots,
    folderState,
    folderLoading,
    selectedWorkspacePath,
    onBrowseFolder,
    onSelectWorkspace,
    onCloseProjectComposer,
    onSubmitProject,
    threadCreateDialogOpen,
    onCloseThreadCreateDialog,
    onSubmitThreadCreateDialog,
    projectInstructionDialogOpen,
    projectInstructionBusy,
    projectInstructionType,
    onCloseProjectInstructionDialog,
    onSubmitProjectInstruction,
    projectEditDialogOpen,
    projectEditTarget,
    projectEditError,
    onCloseProjectEditDialog,
    onSubmitProjectEdit,
    threadInstructionDialogOpen,
    threadInstructionBusy,
    threadInstructionTarget,
    threadInstructionProject,
    threadInstructionSupported,
    threadInstructionError,
    onCloseThreadInstructionDialog,
    onSubmitThreadInstruction
  });
  const deferredOverlays = shouldRenderDeferredOverlays ? (
    <Suspense fallback={null}>
      <MobileDeferredOverlays {...deferredOverlayProps} />
    </Suspense>
  ) : null;
  const {
    todoStandaloneDetailProps,
    todoSplitDetailProps,
    baseThreadDetailProps,
    threadStandaloneDetailKey,
    threadSplitDetailKey,
    threadSplitDetailProps
  } = buildMobileDetailProps({
    selectedTodoChat,
    todoChatDetail,
    selectedBridgeId,
    todoChatMessages,
    todoChatLoading,
    todoChatError,
    todoBusy,
    todoComposerDraftKey,
    todoComposerDraft,
    onChangeThreadComposerDraft,
    onBackToInbox,
    onRefreshTodoChat,
    setTodoChatBeingEdited,
    setActiveTodoMessage,
    onSubmitTodoMessage,
    inlineIssueComposerHelpers,
    todoChatDetailUiComponents,
    todoChatDetailUtils,
    onDeleteTodoChat,
    resolvedThread,
    threadProject,
    session,
    apiRequest,
    threadDetailMessages,
    threadDetail,
    hasOlderMessages,
    remainingHistoryCount,
    onLoadOlderMessages,
    signalNow,
    threadDetailLoading,
    threadDetailError,
    onRefreshThreadDetail,
    onStopThreadExecution,
    onInterruptThreadIssue,
    onRetryThreadIssue,
    onDeleteThreadIssue,
    threadInstructionSupported,
    onAppendThreadMessage,
    onCreateThread,
    threadBusy,
    threadMessageFilter,
    onChangeThreadMessageFilter,
    threadComposerDraftKey,
    threadComposerDraft,
    selectedThread,
    VOICE_SESSION_ENABLED,
    threadVoiceState,
    voiceFollowupThreadDetail,
    onChangeThreadVoiceState,
    threadDetailHelpers,
    selectedThreadId,
    draftThreadProjectId,
    splitThreadEmptyStateMessage
  });
  const appChrome = <MobileInboxChrome {...chromeProps} />;
  const inboxListContent = <MobileInboxListContent {...listProps} />;
  const actionBarContent = <MobileInboxActionBar {...actionBarProps} />;

  if (!showWideTodoSplitLayout && activeView === "todo" && selectedTodoChatId) {
    return (
      <Suspense fallback={null}>
        <MobileTodoStandaloneScreen
          todoChatDetailProps={todoStandaloneDetailProps}
          deferredOverlays={deferredOverlays}
        />
      </Suspense>
    );
  }

  if (showWideSplitLayout) {
    return (
      <Suspense fallback={null}>
        <MobileWideSplitWorkspace
          minPaneWidthPx={MOBILE_WIDE_THREAD_SPLIT_MIN_PANE_WIDTH_PX}
          appChrome={appChrome}
          inboxListContent={inboxListContent}
          actionBarContent={actionBarContent}
          deferredOverlays={deferredOverlays}
          wideThreadSplitLayoutRef={wideThreadSplitLayoutRef}
          wideThreadSplitResizeEnabled={wideThreadSplitResizeEnabled}
          wideThreadSplitLeftWeight={wideThreadSplitLeftWeight}
          wideThreadSplitRightWeight={wideThreadSplitRightWeight}
          onResizePointerDown={handleWideThreadSplitResizePointerDown}
          onResizePointerMove={handleWideThreadSplitResizePointerMove}
          onResizePointerUp={handleWideThreadSplitResizePointerUp}
          isTodoScope={isTodoScope}
          selectedTodoChatId={selectedTodoChatId}
          todoChatDetailProps={todoSplitDetailProps}
          threadDetailKey={threadSplitDetailKey}
          threadDetailProps={threadSplitDetailProps}
        />
      </Suspense>
    );
  }

  if (activeView === "thread" && (resolvedThread || draftProject || selectedThreadId)) {
    return (
      <Suspense fallback={null}>
        <MobileThreadStandaloneScreen
          threadDetailKey={threadStandaloneDetailKey}
          threadDetailProps={baseThreadDetailProps}
        />
      </Suspense>
    );
  }

  return (
    <MobileInboxScreen
      chromeProps={chromeProps}
      listProps={listProps}
      actionBarProps={actionBarProps}
      deferredOverlays={deferredOverlays}
    />
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
  const [bridgeDisconnectOverrideById, setBridgeDisconnectOverrideById] = useState({});
  const [threadVoiceState, setThreadVoiceState] = useState(createInitialThreadVoiceState);
  const viewportWidth = useVisualViewportWidth();
  const wideThreadSplitEnabled = viewportWidth >= MOBILE_WIDE_THREAD_SPLIT_MIN_WIDTH_PX;
  const activeViewRef = useRef(activeView);
  const pendingUpdateActivatorRef = useRef(null);
  const pwaUpdateActivationInFlightRef = useRef(false);
  const standaloneBackNavigationInFlightRef = useRef(false);
  const allowStandaloneNativeBackCountRef = useRef(0);
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
  const {
    mobileNotices,
    mobileConfirmState,
    dismissMobileNotice,
    resolveMobileConfirm,
    showMobileAlert,
    confirmMobileAction,
    mobileFeedbackValue,
    notifyError
  } = useMobileFeedbackState({
    createId,
    noticeAutoDismissMs: MOBILE_NOTICE_AUTO_DISMISS_MS,
    noticeErrorDismissMs: MOBILE_NOTICE_ERROR_DISMISS_MS
  });
  const selectedBridgeKnown = !selectedBridgeId || bridges.some((bridge) => bridge.bridge_id === selectedBridgeId);

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
  const resetThreadVoiceState = useCallback(() => {
    setThreadVoiceState(createInitialThreadVoiceState());
  }, []);
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

  useEffect(() => {
    resetThreadVoiceState();
  }, [resetThreadVoiceState, selectedBridgeId, selectedProjectId, selectedScope.kind]);

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

        if (payload.type === "logicalThread.timeline.updated") {
          const threadId = payload.payload?.thread_id ?? payload.payload?.root_thread_id ?? "";

          if (threadId) {
            const nextMessages = normalizeCachedThreadMessages(payload.payload?.entries ?? []);

            setThreadDetails((current) => ({
              ...current,
              [threadId]: {
                ...(current[threadId] ?? {}),
                messages: nextMessages,
                loaded_issue_ids: normalizeIssueIdList(
                  [
                    ...(current[threadId]?.loaded_issue_ids ?? []),
                    ...collectLoadedIssueIdsFromMessages(nextMessages)
                  ],
                  current[threadId]?.issues ?? []
                )
              }
            }));
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
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      return undefined;
    }

    const handleServiceWorkerMessage = (event) => {
      if (event.data?.type === SERVICE_WORKER_CLIENT_CONTEXT_REQUEST_MESSAGE_TYPE) {
        void publishServiceWorkerClientContext();
        return;
      }

      if (event.data?.type !== SERVICE_WORKER_NOTIFICATION_LAUNCH_MESSAGE_TYPE) {
        return;
      }

      const launchUrl = typeof event.data?.launchUrl === "string" ? event.data.launchUrl.trim() : "";
      const pendingLaunch = readPushDeepLinkFromValue(launchUrl);

      if (!pendingLaunch) {
        return;
      }

      pendingPushDeepLinkRef.current = pendingLaunch;

      try {
        const nextUrl = new URL(launchUrl, window.location.origin);
        window.history.replaceState(null, "", `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
      } catch {
        // ignore malformed launch URL
      }
    };

    navigator.serviceWorker.addEventListener("message", handleServiceWorkerMessage);

    return () => {
      navigator.serviceWorker.removeEventListener("message", handleServiceWorkerMessage);
    };
  }, []);

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
      const preserveCurrentThreadSelection = Boolean(options?.preserveCurrentThreadSelection);

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
        if (!preserveCurrentThreadSelection) {
          setSelectedThreadId(threadId);
          setDraftThreadProjectId("");
          setThreadMessageFilter("all");
        }

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
        if (!preserveCurrentThreadSelection) {
          setActiveView(wideThreadSplitEnabled ? "inbox" : "thread");
        }
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
      return {
        ok: true,
        accepted: true,
        thread_id: threadId,
        issue_id: issueId ?? "",
        prompt: String(payload.prompt ?? "").trim()
      };
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
      return {
        ok: true,
        accepted: true,
        thread_id: threadId,
        issue_id: issueId ?? "",
        prompt
      };
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

    allowStandaloneNativeBackCountRef.current = Math.max(allowStandaloneNativeBackCountRef.current, 2);

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
    resetThreadVoiceState();
    selectProjectScope(projectId);
    clearInstantThreadIfNeeded();
    setSelectedThreadId("");
    setSelectedTodoChatId("");
    setDraftThreadProjectId("");
    setActiveView("inbox");
  };

  const handleSelectThread = (threadId) => {
    clearInstantThreadIfNeeded(threadId);
    resetThreadVoiceState();

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

    resetThreadVoiceState();
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
      if (allowStandaloneNativeBackCountRef.current > 0) {
        return;
      }

      window.history.pushState({ octopStandaloneBackGuard: true }, "", window.location.href);
    };

    const handleStandalonePopState = (event) => {
      if (allowStandaloneNativeBackCountRef.current > 0) {
        allowStandaloneNativeBackCountRef.current -= 1;

        if (allowStandaloneNativeBackCountRef.current > 0) {
          window.setTimeout(() => {
            try {
              window.close();
            } catch {
              // noop
            }

            window.history.back();
          }, 0);
        }

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
      allowStandaloneNativeBackCountRef.current = 0;
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
  const voiceFollowupThreadId = String(threadVoiceState?.delegatedThreadId ?? "").trim();
  const currentVoiceFollowupThreadDetailState = voiceFollowupThreadId ? threadDetails[voiceFollowupThreadId] ?? null : null;

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
        threadVoiceState={threadVoiceState}
        voiceFollowupThreadDetail={currentVoiceFollowupThreadDetailState}
        onChangeThreadVoiceState={setThreadVoiceState}
      />
      <PwaUpdateDialog visible={pwaUpdateVisible} busy={pwaUpdateBusy} onConfirm={handleConfirmPwaUpdate} />
      <MobileNoticeCenter notices={mobileNotices} onDismiss={dismissMobileNotice} />
      <MobileConfirmDialog state={mobileConfirmState} onResolve={resolveMobileConfirm} />
    </MobileFeedbackContext.Provider>
  );
}
