import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import dns from "node:dns";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { connect, StringCodec } from "nats";
import WebSocket from "ws";
import {
  bridgeSubjects,
  sanitizeBridgeId,
  sanitizeUserId
} from "./domain.js";
import {
  buildSystemNetworkStateSignature,
  shouldAttemptSystemNetworkRecovery,
  shouldResetAppServerForSystemNetworkRecovery
} from "./systemNetwork.js";

// Runtime update verification marker: non-functional comment for atomic update validation.
// Runtime update verification marker 2: second non-functional comment for follow-up validation.
// Runtime update verification marker 3: menu indicator validation without logic change.
// Runtime update verification marker 4: source-only change to trigger update detection.
// Runtime update verification marker 5: atomic update smoke-test commit without behavior change.
// Runtime update verification marker 6: push-only change to verify atomic update propagation.
// Runtime update verification marker 7: follow-up push to recheck first-launch atomic update.
// Runtime update verification marker 8: retest after startup/restart preparation unification.
const HOST = process.env.OCTOP_BRIDGE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.OCTOP_BRIDGE_PORT ?? 4100);
const TOKEN = process.env.OCTOP_BRIDGE_TOKEN ?? "octop-local-bridge";
const NATS_URL = process.env.OCTOP_NATS_URL ?? "nats://ilysrv.ddns.net:4222";
const NATS_CONNECT_TIMEOUT_MS = Number(process.env.OCTOP_NATS_CONNECT_TIMEOUT_MS ?? 5000);
const NATS_RETRY_DELAY_MS = Number(process.env.OCTOP_NATS_RETRY_DELAY_MS ?? 2000);
const SYSTEM_NETWORK_EVENT_DEBOUNCE_MS = Number(
  process.env.OCTOP_SYSTEM_NETWORK_EVENT_DEBOUNCE_MS ?? 1500
);
const SYSTEM_NETWORK_MONITOR_RESTART_DELAY_MS = Number(
  process.env.OCTOP_SYSTEM_NETWORK_MONITOR_RESTART_DELAY_MS ?? 3000
);
const SYSTEM_NETWORK_RECOVERY_TIMEOUT_MS = Number(
  process.env.OCTOP_SYSTEM_NETWORK_RECOVERY_TIMEOUT_MS ?? 120000
);
const SYSTEM_NETWORK_RECOVERY_RETRY_DELAY_MS = Number(
  process.env.OCTOP_SYSTEM_NETWORK_RECOVERY_RETRY_DELAY_MS ?? 2000
);
const SYSTEM_NETWORK_PROBE_TIMEOUT_MS = Number(
  process.env.OCTOP_SYSTEM_NETWORK_PROBE_TIMEOUT_MS ?? 3000
);
const SYSTEM_NETWORK_ROUTE_CHECK_TIMEOUT_MS = Number(
  process.env.OCTOP_SYSTEM_NETWORK_ROUTE_CHECK_TIMEOUT_MS ?? 3000
);
const BRIDGE_MODE = process.env.OCTOP_BRIDGE_MODE ?? "app-server";
const APP_SERVER_MODE = process.env.OCTOP_APP_SERVER_MODE ?? "ws-local";
const APP_SERVER_WS_URL = process.env.OCTOP_APP_SERVER_WS_URL ?? "ws://127.0.0.1:4600";
const SHOULD_RESET_APP_SERVER_FOR_SYSTEM_NETWORK_RECOVERY =
  shouldResetAppServerForSystemNetworkRecovery(APP_SERVER_WS_URL);
const APP_SERVER_COMMAND =
  process.env.OCTOP_APP_SERVER_COMMAND ?? `codex app-server --listen ${APP_SERVER_WS_URL}`;
const APP_SERVER_AUTOSTART = (process.env.OCTOP_APP_SERVER_AUTOSTART ?? "true") !== "false";
const APP_SERVER_STARTUP_TIMEOUT_MS = Number(
  process.env.OCTOP_APP_SERVER_STARTUP_TIMEOUT_MS ?? 15000
);
const APP_SERVER_REQUEST_TIMEOUT_MS = Number(
  process.env.OCTOP_APP_SERVER_REQUEST_TIMEOUT_MS ?? 20000
);
const APP_SERVER_HEARTBEAT_INTERVAL_MS = Number(
  process.env.OCTOP_APP_SERVER_HEARTBEAT_INTERVAL_MS ?? 90000
);
const APP_SERVER_HEARTBEAT_TIMEOUT_MS = Number(
  process.env.OCTOP_APP_SERVER_HEARTBEAT_TIMEOUT_MS ?? 45000
);
const APP_SERVER_ACTIVE_HEARTBEAT_FORCE_RECONNECT_MISSES = Number(
  process.env.OCTOP_APP_SERVER_ACTIVE_HEARTBEAT_FORCE_RECONNECT_MISSES ?? 2
);
const APP_SERVER_SILENT_STATE_CHECK_INTERVAL_MS = Number(
  process.env.OCTOP_APP_SERVER_SILENT_STATE_CHECK_INTERVAL_MS ?? 60000
);
const APP_SERVER_RECONNECT_DELAY_MS = Number(
  process.env.OCTOP_APP_SERVER_RECONNECT_DELAY_MS ?? 1000
);
const APP_SERVER_RECONNECT_MAX_DELAY_MS = Number(
  process.env.OCTOP_APP_SERVER_RECONNECT_MAX_DELAY_MS ?? 5000
);
const THREAD_LIST_LIMIT = Number(process.env.OCTOP_APP_SERVER_THREAD_LIST_LIMIT ?? 50);
const CODEX_APPROVAL_POLICY = process.env.OCTOP_CODEX_APPROVAL_POLICY ?? "on-request";
const CODEX_SANDBOX = process.env.OCTOP_CODEX_SANDBOX ?? "danger-full-access";
const CODEX_SANDBOX_DANGEROUSLY_BYPASS = "dangerously-bypass-approvals-and-sandbox";
const CODEX_MODEL = normalizeCodexModel(process.env.OCTOP_CODEX_MODEL);
const CODEX_REASONING_EFFORT = normalizeReasoningEffort(process.env.OCTOP_CODEX_REASONING_EFFORT);
const THREAD_CONTEXT_ROLLOVER_ENABLED =
  (process.env.OCTOP_THREAD_CONTEXT_ROLLOVER_ENABLED ?? "true") !== "false";
const {
  value: THREAD_CONTEXT_ROLLOVER_THRESHOLD_PERCENT,
  reason: THREAD_CONTEXT_ROLLOVER_THRESHOLD_PARSE_REASON
} = resolveRolloverThreshold(process.env.OCTOP_THREAD_CONTEXT_ROLLOVER_THRESHOLD_PERCENT, 85);
const THREAD_CONTEXT_ROLLOVER_COOLDOWN_MS = Number(
  process.env.OCTOP_THREAD_CONTEXT_ROLLOVER_COOLDOWN_MS ?? 30000
);
const RECENTLY_CLOSED_PHYSICAL_THREAD_GRACE_WINDOW_MS = Number(
  process.env.OCTOP_RECENTLY_CLOSED_PHYSICAL_THREAD_GRACE_WINDOW_MS ?? 60000
);
const CLOSED_PHYSICAL_THREAD_TOMBSTONE_TTL_MS = Number(
  process.env.OCTOP_CLOSED_PHYSICAL_THREAD_TOMBSTONE_TTL_MS ?? 600000
);
const DELETED_ROOT_THREAD_TOMBSTONE_TTL_MS = Number(
  process.env.OCTOP_DELETED_ROOT_THREAD_TOMBSTONE_TTL_MS ?? 1800000
);
const HOST_NAME = os.hostname();
const BRIDGE_ID = sanitizeBridgeId(process.env.OCTOP_BRIDGE_ID ?? HOST_NAME);
const DEVICE_NAME = process.env.OCTOP_BRIDGE_DEVICE_NAME ?? os.hostname();
const BRIDGE_OWNER_LOGIN_ID = sanitizeUserId(
  process.env.OCTOP_BRIDGE_OWNER_LOGIN_ID ?? process.env.OCTOP_BRIDGE_OWNER_USER_ID ?? "local-user"
);
const BRIDGE_STORAGE_DIR = resolve(process.env.OCTOP_STATE_HOME ?? resolve(os.homedir(), ".octop"));
const PROJECT_STATE_PATH = resolve(BRIDGE_STORAGE_DIR, `${BRIDGE_ID}-projects.json`);
const THREAD_STATE_PATH = resolve(BRIDGE_STORAGE_DIR, `${BRIDGE_ID}-threads.json`);
const DIAGNOSTIC_LOG_PATH = resolve(BRIDGE_STORAGE_DIR, `${BRIDGE_ID}-diagnostics.jsonl`);
const DIAGNOSTIC_LOG_MAX_BYTES = 1024 * 1024;
const ISSUE_ATTACHMENT_STAGE_ROOT = resolve(BRIDGE_STORAGE_DIR, `${BRIDGE_ID}-issue-attachments`);
const DIAGNOSTIC_LOG_ENABLED = (process.env.OCTOP_DIAGNOSTIC_LOG_ENABLED ?? "true") !== "false";
const WORKSPACE_ROOTS = resolveWorkspaceRoots();
const CURRENT_FILE_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(CURRENT_FILE_PATH), "../../..");
const BRIDGE_REVISION = resolveBridgeRevision();

dns.setDefaultResultOrder("ipv4first");

const sc = StringCodec();
const nc = await connectToNats();
let natsProjectionReplayPromise = null;
let systemNetworkConnected = null;
let lastSystemNetworkStateSignature = null;
let systemNetworkReplayPromise = null;
let systemNetworkRecoveryPending = false;
let systemNetworkRecoveryPollTimer = null;
let systemNetworkEventMonitor = null;
let systemNetworkEventTimer = null;
let pendingSystemNetworkEvent = null;

const users = new Map();
const threadOwners = new Map();
const threadStateById = new Map();
const threadEventsById = new Map();
const threadMessagesById = new Map();
const pendingStartQueues = new Map();
const issueCardsById = new Map();
const issueMessagesById = new Map();
const threadIssueIdsById = new Map();
const todoChatsById = new Map();
const todoChatIdsByUserId = new Map();
const todoMessagesById = new Map();
const todoMessageIdsByChatId = new Map();
const activeIssueByThreadId = new Map();
const activeIssueByPhysicalThreadId = new Map();
const runningIssueMetaByThreadId = new Map();
const issueQueueProcessingStateByThreadId = new Map();
const issueAttachmentCleanupLocksByIssueId = new Map();
let runningIssueBackfillPromise = null;
let runningIssueThreadReadSamplePromise = null;
const codexThreadToThreadId = new Map();
const codexThreadToPhysicalThreadId = new Map();
const physicalThreadStateById = new Map();
const rootThreadPhysicalThreadIdsById = new Map();
const handoffSummariesById = new Map();
const rolloverLocksByRootThreadId = new Map();
const rolloverCooldownByRootThreadId = new Map();
const recentlyClosedPhysicalThreadIdsByRootThreadId = new Map();
const closedPhysicalThreadTombstonesById = new Map();
const deletedRootThreadTombstonesById = new Map();

const RUNNING_ISSUE_WATCHDOG_INTERVAL_MS = Number(process.env.OCTOP_RUNNING_ISSUE_WATCHDOG_INTERVAL_MS ?? 15000);
const RUNNING_ISSUE_STALE_MS = Number(process.env.OCTOP_RUNNING_ISSUE_STALE_MS ?? 120000);
const RUNNING_ISSUE_MISSING_REMOTE_RETRY_COUNT = Number(
  process.env.OCTOP_RUNNING_ISSUE_MISSING_REMOTE_RETRY_COUNT ?? 2
);
const RUNNING_ISSUE_BACKFILL_INTERVAL_MS = Number(
  process.env.OCTOP_RUNNING_ISSUE_BACKFILL_INTERVAL_MS ?? 5000
);
const RUNNING_ISSUE_THREAD_READ_SAMPLE_INTERVAL_MS = Number(
  process.env.OCTOP_RUNNING_ISSUE_THREAD_READ_SAMPLE_INTERVAL_MS ?? 15000
);
const RUNNING_ISSUE_BACKFILL_NO_PROGRESS_FORCE_RECONNECT_COUNT = Number(
  process.env.OCTOP_RUNNING_ISSUE_BACKFILL_NO_PROGRESS_FORCE_RECONNECT_COUNT ?? 3
);
const RUNNING_ISSUE_DEGRADED_FORCE_RECONNECT_DELAY_MS = Number(
  process.env.OCTOP_RUNNING_ISSUE_DEGRADED_FORCE_RECONNECT_DELAY_MS ?? 30000
);
const THREAD_DELETE_STOP_TIMEOUT_MS = Number(process.env.OCTOP_THREAD_DELETE_STOP_TIMEOUT_MS ?? 2500);
const NATS_DELTA_CHUNK_MAX_BYTES = Number(process.env.OCTOP_NATS_DELTA_CHUNK_MAX_BYTES ?? 12000);
const INTERRUPTED_THREAD_STATUS_TYPES = new Set(["interrupted", "cancelled", "canceled"]);

if (
  THREAD_CONTEXT_ROLLOVER_THRESHOLD_PARSE_REASON &&
  process.env.OCTOP_THREAD_CONTEXT_ROLLOVER_THRESHOLD_PERCENT
) {
  console.warn("[OctOP bridge] invalid rollover threshold env value", {
    env_value: process.env.OCTOP_THREAD_CONTEXT_ROLLOVER_THRESHOLD_PERCENT,
    fallback_percent: THREAD_CONTEXT_ROLLOVER_THRESHOLD_PERCENT,
    reason: THREAD_CONTEXT_ROLLOVER_THRESHOLD_PARSE_REASON
  });
}

cleanupIssueAttachmentStageRootOnStartup();

function resolveRolloverThreshold(rawValue, fallbackPercent = 85) {
  if (rawValue === undefined || rawValue === null) {
    return { value: fallbackPercent, reason: null };
  }

  const normalized = String(rawValue).trim();

  if (!normalized) {
    return { value: fallbackPercent, reason: null };
  }

  const sanitized = normalized.endsWith("%") ? normalized.slice(0, -1).trim() : normalized;
  let parsed = Number(sanitized);

  if (!Number.isFinite(parsed)) {
    return { value: fallbackPercent, reason: "invalid" };
  }

  if (parsed > 0 && parsed < 1) {
    parsed *= 100;
  }

  if (parsed <= 0) {
    return { value: fallbackPercent, reason: "non_positive" };
  }

  return {
    value: Math.max(1, Math.min(100, parsed)),
    reason: null
  };
}

function now() {
  return new Date().toISOString();
}

function truncateDiagnosticText(value, maxLength = 4000) {
  const text = String(value ?? "");

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}…[truncated ${text.length - maxLength} chars]`;
}

function serializeDiagnosticValue(value, depth = 0) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncateDiagnosticText(value.message),
      stack: truncateDiagnosticText(value.stack ?? "", 8000)
    };
  }

  if (value === null || value === undefined) {
    return value ?? null;
  }

  if (depth >= 4) {
    return "[truncated_depth]";
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => serializeDiagnosticValue(item, depth + 1));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 40)
        .map(([key, entryValue]) => [key, serializeDiagnosticValue(entryValue, depth + 1)])
    );
  }

  if (typeof value === "string") {
    return truncateDiagnosticText(value);
  }

  return value;
}

function appendDiagnosticLog(level, event, message, details = {}) {
  if (!DIAGNOSTIC_LOG_ENABLED) {
    return;
  }

  const entry = {
    timestamp: now(),
    level,
    event,
    message: truncateDiagnosticText(message),
    bridge_id: BRIDGE_ID,
    bridge_revision: BRIDGE_REVISION,
    device_name: DEVICE_NAME,
    details: serializeDiagnosticValue(details)
  };

  try {
    const serializedEntry = `${JSON.stringify(entry)}\n`;
    mkdirSync(dirname(DIAGNOSTIC_LOG_PATH), { recursive: true });

    if (existsSync(DIAGNOSTIC_LOG_PATH)) {
      const currentSize = statSync(DIAGNOSTIC_LOG_PATH).size;
      const nextSize = currentSize + Buffer.byteLength(serializedEntry, "utf8");

      if (currentSize >= DIAGNOSTIC_LOG_MAX_BYTES || nextSize > DIAGNOSTIC_LOG_MAX_BYTES) {
        rmSync(DIAGNOSTIC_LOG_PATH, { force: true });
      }
    }

    writeFileSync(DIAGNOSTIC_LOG_PATH, serializedEntry, {
      encoding: "utf8",
      flag: "a"
    });
  } catch (error) {
    process.stderr.write(
      `[OctOP bridge] diagnostic log write failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
}

function resolveBridgeRevision() {
  try {
    const revision = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();

    return revision || "unknown";
  } catch {
    return "unknown";
  }
}

function buildLogContext(overrides = {}) {
  return {
    root_thread_id: overrides.root_thread_id ?? null,
    physical_thread_id: overrides.physical_thread_id ?? null,
    source_physical_thread_id: overrides.source_physical_thread_id ?? null,
    target_physical_thread_id: overrides.target_physical_thread_id ?? null,
    codex_thread_id: overrides.codex_thread_id ?? null,
    issue_id: overrides.issue_id ?? null,
    event_type: overrides.event_type ?? null,
    drop_reason: overrides.drop_reason ?? null,
    ...overrides
  };
}

const bridgeMetrics = {
  root_thread_rollover_total: 0,
  root_thread_rollover_failed_total: 0,
  root_thread_rollover_duration_ms: {
    count: 0,
    sum: 0,
    max: 0,
    last: 0
  },
  late_event_drop_total: 0,
  root_thread_delete_total: 0,
  root_thread_delete_failed_total: 0
};

function incrementBridgeMetric(name, value = 1) {
  if (!(name in bridgeMetrics)) {
    return;
  }

  bridgeMetrics[name] = Number(bridgeMetrics[name] ?? 0) + value;
}

function observeBridgeDurationMetric(name, durationMs) {
  const safeDuration = Math.max(0, Number(durationMs) || 0);
  const current = bridgeMetrics[name];

  if (!current || typeof current !== "object") {
    return;
  }

  bridgeMetrics[name] = {
    count: Number(current.count ?? 0) + 1,
    sum: Number(current.sum ?? 0) + safeDuration,
    max: Math.max(Number(current.max ?? 0), safeDuration),
    last: safeDuration
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLinkLocalAddress(family, address) {
  const normalizedFamily = String(family ?? "").toLowerCase();
  const normalizedAddress = String(address ?? "").trim().toLowerCase();

  if (!normalizedAddress) {
    return false;
  }

  if (normalizedFamily === "ipv4" || normalizedFamily === "4") {
    return normalizedAddress.startsWith("169.254.");
  }

  if (normalizedFamily === "ipv6" || normalizedFamily === "6") {
    return normalizedAddress.startsWith("fe80:");
  }

  return false;
}

function listRoutableNetworkInterfaces() {
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, addresses]) =>
      (Array.isArray(addresses) ? addresses : [])
        .filter((entry) =>
          entry &&
          !entry.internal &&
          entry.address &&
          !isLinkLocalAddress(entry.family, entry.address)
        )
        .map((entry) => ({
          name,
          family: String(entry.family ?? "").toUpperCase(),
          address: entry.address
        }))
    );
}

function runSystemNetworkCommand(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: SYSTEM_NETWORK_ROUTE_CHECK_TIMEOUT_MS,
      windowsHide: true
    }).trim();
  } catch {
    return "";
  }
}

function readDefaultRouteState() {
  if (process.platform === "win32") {
    const output = runSystemNetworkCommand("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$route = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | " +
        "Where-Object { $_.State -eq 'Alive' } | Sort-Object -Property RouteMetric, InterfaceMetric | Select-Object -First 1; " +
        "if (-not $route) { " +
        "$route = Get-NetRoute -AddressFamily IPv6 -DestinationPrefix '::/0' -ErrorAction SilentlyContinue | " +
        "Where-Object { $_.State -eq 'Alive' } | Sort-Object -Property RouteMetric, InterfaceMetric | Select-Object -First 1; } " +
        "if ($route) { " +
        "$adapter = Get-NetAdapter -InterfaceIndex $route.InterfaceIndex -ErrorAction SilentlyContinue | Select-Object -First 1; " +
        "if ($adapter -and $adapter.Status -eq 'Up') { Write-Output $adapter.Name } }"
    ]);
    return {
      supported: true,
      connected: Boolean(output),
      interfaceName: output || null
    };
  }

  if (process.platform === "darwin") {
    const output = runSystemNetworkCommand("route", ["-n", "get", "default"]);
    const match = output.match(/interface:\s+([^\s]+)/i);
    return {
      supported: true,
      connected: Boolean(match?.[1]),
      interfaceName: match?.[1] ?? null
    };
  }

  const output = runSystemNetworkCommand("ip", ["route", "show", "default"]);
  const match = output.match(/\bdev\s+([^\s]+)/i);
  return {
    supported: Boolean(output),
    connected: Boolean(match?.[1]),
    interfaceName: match?.[1] ?? null
  };
}

function getSystemNetworkState(reason = "unspecified") {
  const interfaces = listRoutableNetworkInterfaces();
  const defaultRoute = readDefaultRouteState();
  return {
    connected: interfaces.length > 0 && (defaultRoute.supported ? defaultRoute.connected : true),
    checked_at: now(),
    reason,
    interfaces,
    default_route: defaultRoute
  };
}

function buildSystemNetworkLogContext(networkState) {
  return {
    system_network_connected: Boolean(networkState?.connected),
    system_network_checked_at: networkState?.checked_at ?? null,
    system_network_interface_names: Array.isArray(networkState?.interfaces)
      ? networkState.interfaces.map((entry) => entry.name)
      : [],
    system_network_default_route_interface: networkState?.default_route?.interfaceName ?? null
  };
}

async function waitForNatsReplayAfterSystemNetworkRestore(trigger = "unspecified") {
  if (systemNetworkReplayPromise) {
    return systemNetworkReplayPromise;
  }

  const deadline = Date.now() + SYSTEM_NETWORK_RECOVERY_TIMEOUT_MS;
  systemNetworkReplayPromise = (async () => {
    if (SHOULD_RESET_APP_SERVER_FOR_SYSTEM_NETWORK_RECOVERY) {
      appServer.prepareForSystemNetworkRestore(trigger);
    } else {
      appendDiagnosticLog(
        "info",
        "app_server.websocket.system_network_restore_preserved",
        "preserving local app-server websocket during system network recovery",
        {
          trigger,
          app_server_url: APP_SERVER_WS_URL
        }
      );
      console.warn("[OctOP bridge] preserving local app-server websocket during system network recovery", {
        trigger,
        app_server_url: APP_SERVER_WS_URL
      });
    }

    while (Date.now() < deadline) {
      if (nc.isClosed()) {
        break;
      }

      try {
        await Promise.race([
          nc.flush(),
          sleep(SYSTEM_NETWORK_PROBE_TIMEOUT_MS).then(() => {
            throw new Error("flush_timeout");
          })
        ]);
        await scheduleNatsProjectionReplay(`system_network_restored:${trigger}`);
        await publishBridgeStatusUpdates({ ensureReady: false });
        const activeSocket = appServer.socket;

        if (activeSocket && appServer.connected && appServer.initialized && activeSocket.readyState === WebSocket.OPEN) {
          void appServer.checkLastKnownState(`system_network_restored:${trigger}`);
        } else {
          appServer.scheduleReconnect(`system_network_restored:${trigger}`);
        }
        return true;
      } catch {
        await sleep(SYSTEM_NETWORK_RECOVERY_RETRY_DELAY_MS);
      }
    }

    console.warn("[OctOP bridge] NATS replay skipped after system network restore", {
      trigger,
      closed: nc.isClosed()
    });
    return false;
  })().finally(() => {
    systemNetworkReplayPromise = null;
  });

  return systemNetworkReplayPromise;
}

function scheduleSystemNetworkEvent(event) {
  pendingSystemNetworkEvent = {
    trigger: String(event?.trigger ?? "system_network").trim() || "system_network",
    source: String(event?.source ?? "unspecified").trim() || "unspecified",
    available: event?.available,
    raw: event?.raw ?? null
  };

  if (systemNetworkEventTimer) {
    clearTimeout(systemNetworkEventTimer);
  }

  systemNetworkEventTimer = setTimeout(() => {
    systemNetworkEventTimer = null;
    const nextEvent = pendingSystemNetworkEvent;
    pendingSystemNetworkEvent = null;
    void handleSystemNetworkEvent(nextEvent);
  }, SYSTEM_NETWORK_EVENT_DEBOUNCE_MS);
  systemNetworkEventTimer.unref?.();
}

function startSystemNetworkRecoveryPoll(reason = "unspecified") {
  if (systemNetworkRecoveryPollTimer || SYSTEM_NETWORK_RECOVERY_RETRY_DELAY_MS <= 0) {
    return;
  }

  console.warn("[OctOP bridge] starting system network recovery poll", {
    reason,
    interval_ms: SYSTEM_NETWORK_RECOVERY_RETRY_DELAY_MS
  });

  systemNetworkRecoveryPollTimer = setInterval(() => {
    scheduleSystemNetworkEvent({
      trigger: `system_network_recovery_poll:${reason}`,
      source: "system_network_recovery_poll",
      available: systemNetworkConnected,
      raw: null
    });
  }, SYSTEM_NETWORK_RECOVERY_RETRY_DELAY_MS);
  systemNetworkRecoveryPollTimer.unref?.();
}

function stopSystemNetworkRecoveryPoll(reason = "recovered") {
  if (!systemNetworkRecoveryPollTimer) {
    return;
  }

  clearInterval(systemNetworkRecoveryPollTimer);
  systemNetworkRecoveryPollTimer = null;
  console.warn("[OctOP bridge] stopped system network recovery poll", {
    reason
  });
}

async function handleSystemNetworkEvent(event = {}) {
  const networkState = getSystemNetworkState(event.trigger ?? "system_network");
  const previousConnected = systemNetworkConnected;
  const previousStateSignature = lastSystemNetworkStateSignature;
  const nextStateSignature = buildSystemNetworkStateSignature(networkState);
  const stateChanged = previousStateSignature !== nextStateSignature;
  systemNetworkConnected = networkState.connected;
  lastSystemNetworkStateSignature = nextStateSignature;

  if (stateChanged) {
    appendDiagnosticLog("info", "system_network.event", "system network event received", {
      trigger: event.trigger ?? "system_network",
      source: event.source ?? "unspecified",
      available: event.available ?? null,
      raw: event.raw ?? null,
      ...buildSystemNetworkLogContext(networkState)
    });
  }

  if (!networkState.connected) {
    systemNetworkRecoveryPending = true;
    startSystemNetworkRecoveryPoll(event.trigger ?? "system_network");
    if (stateChanged) {
      console.warn("[OctOP bridge] system network became unavailable", {
        trigger: event.trigger ?? "system_network",
        source: event.source ?? "unspecified",
        ...buildSystemNetworkLogContext(networkState)
      });
    }
    return;
  }

  const shouldAttemptRecovery = shouldAttemptSystemNetworkRecovery({
    previousConnected,
    previousStateSignature,
    nextStateSignature,
    recoveryPending: systemNetworkRecoveryPending,
    networkConnected: networkState.connected
  });

  if (!shouldAttemptRecovery) {
    if (!systemNetworkRecoveryPending) {
      stopSystemNetworkRecoveryPoll("network_stable");
    }
    return;
  }

  systemNetworkRecoveryPending = true;
  startSystemNetworkRecoveryPoll(event.trigger ?? "system_network");

  const recovered = await waitForNatsReplayAfterSystemNetworkRestore(event.trigger ?? "system_network");

  if (recovered) {
    systemNetworkRecoveryPending = false;
    stopSystemNetworkRecoveryPoll(event.trigger ?? "system_network");
    return;
  }

  systemNetworkRecoveryPending = true;
}

function buildSystemNetworkMonitorSpec() {
  if (process.platform === "win32") {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      "function Emit([string]$Type, [bool]$Available) {",
      "  $payload = @{ type = $Type; available = $Available; timestamp = [DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json -Compress",
      "  [Console]::Out.WriteLine($payload)",
      "  [Console]::Out.Flush()",
      "}",
      "Emit 'startup' ([System.Net.NetworkInformation.NetworkInterface]::GetIsNetworkAvailable())",
      "Register-ObjectEvent -InputObject ([System.Net.NetworkInformation.NetworkChange]) -EventName NetworkAvailabilityChanged -SourceIdentifier 'OctOP.NetworkAvailability' | Out-Null",
      "Register-ObjectEvent -InputObject ([System.Net.NetworkInformation.NetworkChange]) -EventName NetworkAddressChanged -SourceIdentifier 'OctOP.NetworkAddress' | Out-Null",
      "while ($true) {",
      "  $event = Wait-Event -Timeout 3600",
      "  if (-not $event) { continue }",
      "  if ($event.SourceIdentifier -eq 'OctOP.NetworkAvailability') {",
      "    Emit 'availability' ([bool]$event.SourceEventArgs.IsAvailable)",
      "  } else {",
      "    Emit 'address' ([System.Net.NetworkInformation.NetworkInterface]::GetIsNetworkAvailable())",
      "  }",
      "  Remove-Event -EventIdentifier $event.EventIdentifier",
      "}"
    ].join("; ");

    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", script],
      source: "powershell_network_change"
    };
  }

  if (process.platform === "darwin") {
    return {
      command: "route",
      args: ["-n", "monitor"],
      source: "route_monitor"
    };
  }

  return {
    command: "ip",
    args: ["monitor", "link", "route", "address"],
    source: "ip_monitor"
  };
}

function restartSystemNetworkEventMonitor(reason = "unspecified") {
  setTimeout(() => {
    void startSystemNetworkEventMonitor(`restart:${reason}`);
  }, SYSTEM_NETWORK_MONITOR_RESTART_DELAY_MS).unref?.();
}

async function startSystemNetworkEventMonitor(reason = "startup") {
  if (systemNetworkEventMonitor && systemNetworkEventMonitor.exitCode === null) {
    return;
  }

  const spec = buildSystemNetworkMonitorSpec();
  const initialNetworkState = getSystemNetworkState(`monitor:${reason}`);
  systemNetworkConnected = initialNetworkState.connected;
  lastSystemNetworkStateSignature = buildSystemNetworkStateSignature(initialNetworkState);
  systemNetworkEventMonitor = spawn(spec.command, spec.args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  const output = createInterface({
    input: systemNetworkEventMonitor.stdout
  });

  output.on("line", (line) => {
    const text = String(line ?? "").trim();

    if (!text) {
      return;
    }

    let payload = null;

    if (process.platform === "win32") {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { type: "unknown", raw: text };
      }
    } else {
      payload = {
        type: "change",
        raw: text
      };
    }

    scheduleSystemNetworkEvent({
      trigger: `os_network_event:${payload.type ?? "change"}`,
      source: spec.source,
      available: payload.available,
      raw: payload.raw ?? text
    });
  });

  systemNetworkEventMonitor.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();

    if (!text) {
      return;
    }

    console.warn("[OctOP bridge] system network monitor stderr", {
      reason,
      source: spec.source,
      message: text
    });
  });

  systemNetworkEventMonitor.on("error", (error) => {
    console.warn("[OctOP bridge] failed to start system network monitor", {
      reason,
      source: spec.source,
      message: error.message
    });
    restartSystemNetworkEventMonitor(`error:${spec.source}`);
  });

  systemNetworkEventMonitor.on("exit", (code, signal) => {
    output.close();
    console.warn("[OctOP bridge] system network monitor exited", {
      reason,
      source: spec.source,
      code: code ?? null,
      signal: signal ?? null
    });
    restartSystemNetworkEventMonitor(`exit:${spec.source}`);
  });
}

function cleanupIssueAttachmentStageRootOnStartup() {
  try {
    rmSync(ISSUE_ATTACHMENT_STAGE_ROOT, { recursive: true, force: true });
    mkdirSync(ISSUE_ATTACHMENT_STAGE_ROOT, { recursive: true });
  } catch (error) {
    console.warn("[OctOP bridge] failed to reset issue attachment staging directory", {
      root: ISSUE_ATTACHMENT_STAGE_ROOT,
      error: error.message
    });
  }
}

function createThreadEntityId() {
  return sanitizeBridgeId(`thread-${randomUUID()}`);
}

function createIssueCardId() {
  return sanitizeBridgeId(`issue-${randomUUID()}`);
}

function createPhysicalThreadId() {
  return sanitizeBridgeId(`pth-${randomUUID()}`);
}

function createHandoffSummaryId() {
  return sanitizeBridgeId(`summary-${randomUUID()}`);
}

function createTodoChatId() {
  return sanitizeBridgeId(`todo-chat-${randomUUID()}`);
}

function createTodoMessageId() {
  return sanitizeBridgeId(`todo-msg-${randomUUID()}`);
}

async function connectToNats() {
  let attempt = 0;

  while (true) {
    attempt += 1;

    try {
      console.log(`[bridge] NATS 연결 시도 ${attempt}: ${NATS_URL}`);
      const connection = await connect({
        servers: NATS_URL,
        timeout: NATS_CONNECT_TIMEOUT_MS
      });

      void connection.closed().then((error) => {
        if (error) {
          console.error(`[bridge] NATS 연결 종료: ${error.message}`);
          return;
        }

        console.warn("[bridge] NATS 연결이 종료되었습니다.");
      });

      console.log("[bridge] NATS 연결 성공");
      return connection;
    } catch (error) {
      console.error(
        `[bridge] NATS 연결 실패 (${attempt}회): ${error.message}. ${Math.round(NATS_RETRY_DELAY_MS / 1000)}초 후 재시도합니다.`
      );
      await sleep(NATS_RETRY_DELAY_MS);
    }
  }
}

function normalizeCodexModel(value) {
  const normalized = String(value ?? "").trim();
  return normalized || "gpt-5.4";
}

function resolveCodexModelFromOptions(options = {}) {
  const requestModel = options.model;
  const fallbackModel = process.env.OCTOP_CODEX_MODEL
    ?? resolveCodexModelFromEnvironmentFiles()
    ?? CODEX_MODEL;

  return normalizeCodexModel(requestModel || fallbackModel);
}

function resolveCodexApprovalPolicyFromOptions(options = {}) {
  const requestApprovalPolicy = options.approvalPolicy ?? options.approval_policy;
  const fallbackApprovalPolicy =
    process.env.OCTOP_CODEX_APPROVAL_POLICY
    ?? resolveCodexStringFromEnvironmentFile("OCTOP_CODEX_APPROVAL_POLICY")
    ?? CODEX_APPROVAL_POLICY;

  return normalizeStringOption(requestApprovalPolicy, fallbackApprovalPolicy);
}

function resolveCodexSandboxFromOptions(options = {}) {
  const requestSandbox = options.sandbox;
  const fallbackSandbox =
    process.env.OCTOP_CODEX_SANDBOX
    ?? resolveCodexStringFromEnvironmentFile("OCTOP_CODEX_SANDBOX")
    ?? CODEX_SANDBOX;

  return normalizeStringOption(requestSandbox, fallbackSandbox);
}

function isDangerouslyBypassCodexSandbox(value) {
  return normalizeStringOption(value, "") === CODEX_SANDBOX_DANGEROUSLY_BYPASS;
}

function resolveCodexExecutionPolicyFromOptions(options = {}) {
  const sandbox = resolveCodexSandboxFromOptions(options);

  if (isDangerouslyBypassCodexSandbox(sandbox)) {
    return {
      approvalPolicy: undefined,
      sandbox: undefined
    };
  }

  return {
    approvalPolicy: resolveCodexApprovalPolicyFromOptions(options),
    sandbox
  };
}

function resolveCodexReasoningEffortFromOptions(options = {}) {
  const requestReasoningEffort = options.reasoningEffort ?? options.reasoning_effort;
  const fallbackReasoningEffort =
    process.env.OCTOP_CODEX_REASONING_EFFORT
    ?? resolveCodexStringFromEnvironmentFile("OCTOP_CODEX_REASONING_EFFORT")
    ?? CODEX_REASONING_EFFORT;

  const request = normalizeReasoningEffort(requestReasoningEffort);

  return request ?? normalizeReasoningEffort(fallbackReasoningEffort);
}

function resolveCodexModelFromEnvironmentFiles() {
  const candidates = [".env.local", ".env"].map((fileName) => resolve(process.cwd(), fileName));

  for (const filePath of candidates) {
    const model = readEnvironmentFileValue(filePath, "OCTOP_CODEX_MODEL");

    if (model?.trim()) {
      return model.trim();
    }
  }

  return null;
}

function resolveCodexStringFromEnvironmentFile(key) {
  const candidates = [".env.local", ".env"].map((fileName) => resolve(process.cwd(), fileName));

  for (const filePath of candidates) {
    const value = readEnvironmentFileValue(filePath, key);

    if (value?.trim()) {
      return value.trim();
    }
  }

  return null;
}

function normalizeStringOption(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || String(fallback ?? "").trim();
}

function readEnvironmentFileValue(filePath, key) {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/u);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex < 0) {
        continue;
      }

      const parsedKey = trimmed.slice(0, separatorIndex).trim();
      if (parsedKey !== key) {
        continue;
      }

      return trimmed.slice(separatorIndex + 1).trim();
    }
  } catch {
    return null;
  }

  return null;
}

function normalizeReasoningEffort(value) {
  const normalized = String(value ?? "").trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  if (["none", "low", "medium", "high", "xhigh"].includes(normalized)) {
    return normalized;
  }

  console.warn("[OctOP bridge] invalid OCTOP_CODEX_REASONING_EFFORT ignored", {
    value
  });
  return null;
}

function createIssueTitle(payload = {}) {
  const title = String(payload.title ?? "").trim();

  if (title) {
    return title;
  }

  const prompt = String(payload.prompt ?? "").trim();

  if (!prompt) {
    return "새 이슈";
  }

  const singleLine = prompt.replace(/\s+/g, " ").trim();
  return singleLine.slice(0, 42) + (singleLine.length > 42 ? "..." : "");
}

function unixSecondsToIso(value) {
  if (!value) {
    return now();
  }

  return new Date(Number(value) * 1000).toISOString();
}

function parseJson(data) {
  return JSON.parse(sc.decode(data));
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function ensureUserState(userId) {
  const normalized = sanitizeUserId(userId);

  if (!users.has(normalized)) {
    const projectEntry = loadProjectEntry(normalized);
    const restoredState = loadThreadsForUser(normalized);
    users.set(normalized, {
      projects: loadProjectsForUser(normalized, projectEntry),
      deletedWorkspacePaths: projectEntry.deletedWorkspacePaths,
      threadIds: restoredState.threadIds,
      todoChatIds: restoredState.todoChatIds,
      updated_at: now()
    });
  }

  const state = users.get(normalized);

  if (!(state.todoChatIds instanceof Set)) {
    state.todoChatIds = ensureTodoChatIdsForUser(normalized);
  } else {
    todoChatIdsByUserId.set(normalized, state.todoChatIds);
  }

  const discoveredProjects = discoverProjectsForUser(normalized, state.deletedWorkspacePaths);
  const mergedProjects = mergeProjects(state.projects, discoveredProjects);

  if (hasProjectSetChanged(state.projects, mergedProjects)) {
    state.projects = mergedProjects;
    persistUserProjects(normalized, state.projects, state.deletedWorkspacePaths);
  }

  return state;
}

function readThreadStorage() {
  if (!existsSync(THREAD_STATE_PATH)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(THREAD_STATE_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeThreadStorage(payload) {
  writeJsonFileAtomic(THREAD_STATE_PATH, payload);
}

function writeJsonFileAtomic(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const serialized = JSON.stringify(payload, null, 2);
  let fd = null;

  try {
    fd = openSync(tempPath, "w");
    writeFileSync(fd, serialized, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tempPath, path);
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore close failure on error path
      }
    }

    try {
      unlinkSync(tempPath);
    } catch (cleanupError) {
      console.warn("[OctOP bridge] atomic write temp cleanup failed", {
        path,
        tempPath,
        error: cleanupError.message
      });
    }

    throw error;
  }
}

function loadThreadsForUser(loginId) {
  const storage = readThreadStorage();
  const stored = storage[loginId];

  if (!stored || typeof stored !== "object") {
    return {
      threadIds: new Set(),
      todoChatIds: new Set()
    };
  }

  if (Array.isArray(stored.project_thread_ids)) {
    return restoreThreadCentricState(loginId, stored);
  }

  return {
    threadIds: migrateLegacyThreadState(loginId, stored),
    todoChatIds: new Set()
  };
}

function persistThreadsForUser(loginId) {
  const normalized = sanitizeUserId(loginId);
  const state = users.get(normalized);

  if (!state) {
    return;
  }

  const storage = readThreadStorage();
  const threadIds = [...state.threadIds].filter((threadId) => threadStateById.has(threadId));
  const issueIds = threadIds.flatMap((threadId) => getThreadIssueIds(threadId));
  const todoChatIds = [...(state.todoChatIds ?? new Set())].filter((chatId) => todoChatsById.has(chatId));
  const todoMessageIds = todoChatIds.flatMap((chatId) => getTodoMessageIds(chatId));
  const queueIds = Object.fromEntries(
    threadIds.map((threadId) => [threadId, ensurePendingQueue(threadId)])
  );
  const activeIssueIds = Object.fromEntries(
    threadIds
      .filter((threadId) => activeIssueByThreadId.has(threadId))
      .map((threadId) => [threadId, activeIssueByThreadId.get(threadId)])
  );
  const activeIssueIdsByPhysicalThreadId = Object.fromEntries(
    [...activeIssueByPhysicalThreadId.entries()].filter(([physicalThreadId]) =>
      physicalThreadStateById.has(physicalThreadId)
    )
  );
  const codexThreadIds = Object.fromEntries(
    threadIds
      .map((threadId) => [threadId, threadStateById.get(threadId)?.codex_thread_id ?? null])
  );
  const physicalThreadIds = threadIds.flatMap((threadId) => getRootThreadPhysicalThreadIds(threadId));
  const handoffSummaryIds = [...handoffSummariesById.values()]
    .filter((summary) => threadIds.includes(summary.root_thread_id))
    .map((summary) => summary.id);

  storage[normalized] = {
    project_thread_ids: threadIds,
    project_threads: Object.fromEntries(
      threadIds.map((threadId) => [threadId, threadStateById.get(threadId)])
    ),
    issue_ids: issueIds,
    issues: Object.fromEntries(
      issueIds.map((issueId) => [issueId, issueCardsById.get(issueId)])
    ),
    thread_issue_ids: Object.fromEntries(
      threadIds.map((threadId) => [threadId, getThreadIssueIds(threadId)])
    ),
    issue_queue_ids: queueIds,
    active_issue_ids: activeIssueIds,
    active_issue_ids_by_physical_thread_id: activeIssueIdsByPhysicalThreadId,
    codex_thread_ids: codexThreadIds,
    physical_thread_ids: physicalThreadIds,
    physical_threads: Object.fromEntries(
      physicalThreadIds.map((physicalThreadId) => [physicalThreadId, physicalThreadStateById.get(physicalThreadId)])
    ),
    root_thread_physical_thread_ids: Object.fromEntries(
      threadIds.map((threadId) => [threadId, getRootThreadPhysicalThreadIds(threadId)])
    ),
    handoff_summary_ids: handoffSummaryIds,
    handoff_summaries: Object.fromEntries(
      handoffSummaryIds.map((summaryId) => [summaryId, handoffSummariesById.get(summaryId)])
    ),
    issue_messages: Object.fromEntries(
      issueIds
        .filter((issueId) => issueMessagesById.has(issueId))
        .map((issueId) => [issueId, issueMessagesById.get(issueId)])
    ),
    todo_chat_ids: todoChatIds,
    todo_chats: Object.fromEntries(todoChatIds.map((chatId) => [chatId, todoChatsById.get(chatId)])),
    todo_message_ids_by_chat: Object.fromEntries(
      todoChatIds.map((chatId) => [chatId, getTodoMessageIds(chatId)])
    ),
    todo_messages: Object.fromEntries(
      todoMessageIds.map((messageId) => [messageId, todoMessagesById.get(messageId)])
    ),
    updated_at: now()
  };

  writeThreadStorage(storage);
}

function persistThreadById(threadId) {
  const owner = threadOwners.get(threadId);

  if (!owner) {
    return;
  }

  persistThreadsForUser(owner);
}

function restoreThreadCentricState(loginId, stored) {
  const threadIds = new Set();
  const todoChatIds = new Set();

  for (const threadId of stored.project_thread_ids ?? []) {
    if (!threadId) {
      continue;
    }

    const thread = stored.project_threads?.[threadId];

    if (!thread) {
      continue;
    }

    const normalizedThread = normalizeProjectThread(loginId, thread);
    threadStateById.set(threadId, normalizedThread);
    threadOwners.set(threadId, loginId);
    threadIds.add(threadId);

    if (normalizedThread.codex_thread_id) {
      codexThreadToThreadId.set(normalizedThread.codex_thread_id, threadId);
    }
  }

  for (const physicalThreadId of stored.physical_thread_ids ?? []) {
    if (!physicalThreadId) {
      continue;
    }

    const physicalThread = stored.physical_threads?.[physicalThreadId];

    if (!physicalThread) {
      continue;
    }

    const rootThread = threadStateById.get(
      sanitizeBridgeId(physicalThread.root_thread_id ?? physicalThread.thread_id ?? "")
    );
    const normalizedPhysicalThread = normalizePhysicalThread(physicalThread, rootThread);
    physicalThreadStateById.set(normalizedPhysicalThread.id, normalizedPhysicalThread);

    if (normalizedPhysicalThread.codex_thread_id) {
      codexThreadToPhysicalThreadId.set(normalizedPhysicalThread.codex_thread_id, normalizedPhysicalThread.id);
      codexThreadToThreadId.set(normalizedPhysicalThread.codex_thread_id, normalizedPhysicalThread.root_thread_id);
    }
  }

  for (const [rootThreadId, physicalThreadIds] of Object.entries(stored.root_thread_physical_thread_ids ?? {})) {
    setRootThreadPhysicalThreadIds(
      rootThreadId,
      Array.isArray(physicalThreadIds)
        ? physicalThreadIds.filter((physicalThreadId) => physicalThreadStateById.has(physicalThreadId))
        : []
    );
  }

  for (const summaryId of stored.handoff_summary_ids ?? []) {
    if (!summaryId) {
      continue;
    }

    const summary = stored.handoff_summaries?.[summaryId];

    if (!summary) {
      continue;
    }

    const normalizedSummary = normalizeHandoffSummary(summary);
    handoffSummariesById.set(normalizedSummary.id, normalizedSummary);
  }

  for (const issueId of stored.issue_ids ?? []) {
    if (!issueId) {
      continue;
    }

    const issue = stored.issues?.[issueId];

    if (!issue) {
      continue;
    }

    const normalizedIssue = normalizeIssueCard(issue);
    issueCardsById.set(issueId, normalizedIssue);

    const messages = stored.issue_messages?.[issueId];

    if (Array.isArray(messages) && messages.length > 0) {
      issueMessagesById.set(issueId, messages);
    }
  }

  for (const [threadId, issueIds] of Object.entries(stored.thread_issue_ids ?? {})) {
    threadIssueIdsById.set(
      threadId,
      Array.isArray(issueIds) ? issueIds.filter((issueId) => issueCardsById.has(issueId)) : []
    );
  }

  for (const [threadId, issueIds] of Object.entries(stored.issue_queue_ids ?? {})) {
    pendingStartQueues.set(
      threadId,
      Array.isArray(issueIds) ? issueIds.filter((issueId) => issueCardsById.has(issueId)) : []
    );
  }

  for (const [threadId, issueId] of Object.entries(stored.active_issue_ids ?? {})) {
    const issue = issueCardsById.get(issueId);
    const thread = threadStateById.get(threadId);

    if (!issue || !thread) {
      continue;
    }

    if (!["running", "awaiting_input"].includes(issue.status)) {
      continue;
    }

    activeIssueByThreadId.set(threadId, issueId);
    const executedPhysicalThreadId =
      issue.executed_physical_thread_id ?? issue.created_physical_thread_id ?? null;

    if (executedPhysicalThreadId) {
      activeIssueByPhysicalThreadId.set(sanitizeBridgeId(executedPhysicalThreadId), issueId);
    }
    markRunningIssueActivity(threadId, {
      startedAt: issue.updated_at ?? thread.updated_at ?? now(),
      lastActivityAt: issue.updated_at ?? thread.updated_at ?? now(),
      reconcileAttempts: 0,
      missingRemoteAttempts: 0,
      lastReconciledAt: null,
      lastSeenCodexThreadId: thread.codex_thread_id ?? null
    });
  }

  for (const [physicalThreadId, issueId] of Object.entries(stored.active_issue_ids_by_physical_thread_id ?? {})) {
    if (!physicalThreadStateById.has(physicalThreadId) || !issueCardsById.has(issueId)) {
      continue;
    }

    activeIssueByPhysicalThreadId.set(physicalThreadId, issueId);
  }

  for (const threadId of threadIds) {
    ensureRootThreadPhysicalStructure(loginId, threadId);

    for (const issueId of getThreadIssueIds(threadId)) {
      const issue = issueCardsById.get(issueId);

      if (!issue) {
        continue;
      }

      const activePhysicalThread = getActivePhysicalThread(threadId);
      const normalizedIssue = normalizeIssueCard({
        ...issue,
        thread_id: threadId,
        root_thread_id: issue.root_thread_id ?? threadId,
        created_physical_thread_id: issue.created_physical_thread_id ?? activePhysicalThread?.id ?? null,
        executed_physical_thread_id:
          issue.executed_physical_thread_id ??
          issue.created_physical_thread_id ??
          activePhysicalThread?.id ??
          null
      });

      issueCardsById.set(issueId, normalizedIssue);
    }

    if (activeIssueByThreadId.has(threadId)) {
      continue;
    }

    ensureRunningIssueTrackingForThread(threadId);
  }

  for (const chatId of stored.todo_chat_ids ?? []) {
    if (!chatId) {
      continue;
    }

    const chat = stored.todo_chats?.[chatId];

    if (!chat) {
      continue;
    }

    const normalizedChat = normalizeTodoChat(loginId, chat);
    todoChatsById.set(chatId, normalizedChat);
    todoChatIds.add(chatId);
  }

  for (const [chatId, messageIds] of Object.entries(stored.todo_message_ids_by_chat ?? {})) {
    todoMessageIdsByChatId.set(
      chatId,
      Array.isArray(messageIds) ? messageIds.filter((messageId) => stored.todo_messages?.[messageId]) : []
    );
  }

  for (const messageId of Object.keys(stored.todo_messages ?? {})) {
    const message = stored.todo_messages?.[messageId];

    if (!message) {
      continue;
    }

    const normalizedMessage = normalizeTodoMessage(loginId, message);
    todoMessagesById.set(messageId, normalizedMessage);
  }

  for (const chatId of todoChatIds) {
    syncTodoChatSnapshot(chatId);
  }

  todoChatIdsByUserId.set(loginId, todoChatIds);
  return {
    threadIds,
    todoChatIds
  };
}

function migrateLegacyThreadState(loginId, stored) {
  const migratedThreadIds = new Set();
  const legacyThreads = Array.isArray(stored.thread_ids) ? stored.thread_ids : [];

  for (const legacyThreadId of legacyThreads) {
    const legacyThread = stored.threads?.[legacyThreadId];

    if (!legacyThread) {
      continue;
    }

    const projectId = legacyThread.project_id ?? buildDefaultProject(loginId).id;
    const migratedThreadId = ensureDefaultProjectThread(loginId, projectId, "Legacy");
    const cardId = createIssueCardId();
    const issue = normalizeIssueCard({
      id: cardId,
      project_id: projectId,
      thread_id: migratedThreadId,
      title: legacyThread.title ?? legacyThread.name ?? "Legacy issue",
      prompt: legacyThread.prompt ?? "",
      status: legacyThread.status ?? "completed",
      progress: legacyThread.progress ?? 100,
      last_event: legacyThread.last_event ?? "legacy.migrated",
      last_message: legacyThread.last_message ?? "",
      created_at: legacyThread.created_at ?? now(),
      updated_at: legacyThread.updated_at ?? now(),
      source: "legacy"
    });

    issueCardsById.set(cardId, issue);
    setThreadIssueIds(migratedThreadId, [...getThreadIssueIds(migratedThreadId), cardId]);

    const legacyMessages = stored.messages?.[legacyThreadId];

    if (Array.isArray(legacyMessages) && legacyMessages.length > 0) {
      issueMessagesById.set(cardId, legacyMessages);
    }

    migratedThreadIds.add(migratedThreadId);
    updateProjectThreadSnapshot(migratedThreadId);
  }

  return migratedThreadIds;
}

function loadProjectEntry(loginId) {
  const persisted = readProjectStorage();
  const stored = persisted[loginId];

  if (Array.isArray(stored)) {
    return {
      projects: stored,
      deletedWorkspacePaths: []
    };
  }

  if (stored && typeof stored === "object") {
    return {
      projects: Array.isArray(stored.projects) ? stored.projects : [],
      deletedWorkspacePaths: Array.isArray(stored.deleted_workspace_paths)
        ? stored.deleted_workspace_paths.map((value) => resolve(String(value)))
        : []
    };
  }

  return {
    projects: [],
    deletedWorkspacePaths: []
  };
}

function loadProjectsForUser(loginId, projectEntry = loadProjectEntry(loginId)) {
  const persisted = readProjectStorage();
  const storedProjects = projectEntry.projects;
  const discoveredProjects = discoverProjectsForUser(loginId, projectEntry.deletedWorkspacePaths);

  if (Array.isArray(storedProjects) && storedProjects.length > 0) {
    return mergeProjects(
      storedProjects.map((project) => normalizeProject(loginId, project)),
      discoveredProjects
    );
  }

  const project = discoveredProjects[0] ?? buildDefaultProject(loginId);
  persisted[loginId] = {
    projects: mergeProjects([project], discoveredProjects),
    deleted_workspace_paths: projectEntry.deletedWorkspacePaths,
    updated_at: now()
  };
  writeProjectStorage(persisted);
  return persisted[loginId].projects;
}

function buildDefaultProject(loginId) {
  return normalizeProject(loginId, {
    id: buildProjectId(loginId, process.cwd()),
    key: loginId.toUpperCase().replace(/-/g, "_"),
    name: `${loginId} project`,
    description: "OctOP bridge와 app-server 연결 점검용 기본 프로젝트",
    workspace_path: process.cwd(),
    source: "default"
  });
}

function normalizeInstructionText(value) {
  return String(value ?? "").trim();
}

function normalizeProject(loginId, project = {}) {
  const sanitizedLoginId = sanitizeUserId(loginId);
  const resolvedWorkspacePath = project.workspace_path
    ? resolve(String(project.workspace_path))
    : "";
  const fallbackId = resolvedWorkspacePath
    ? buildProjectId(sanitizedLoginId, resolvedWorkspacePath)
    : `${BRIDGE_ID}-${sanitizedLoginId}-${randomUUID().slice(0, 8)}`;
  const fallbackName = `${sanitizedLoginId} project`;

  return {
    id: sanitizeBridgeId(project.id ?? fallbackId),
    key: String(project.key ?? fallbackName).trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_"),
    name: String(project.name ?? fallbackName).trim() || fallbackName,
    description: String(project.description ?? "").trim(),
    base_instructions: normalizeInstructionText(project.base_instructions ?? project.baseInstructions),
    developer_instructions: normalizeInstructionText(
      project.developer_instructions ?? project.developerInstructions
    ),
    bridge_id: BRIDGE_ID,
    workspace_path: resolvedWorkspacePath || null,
    source: project.source ?? (resolvedWorkspacePath ? "workspace" : "manual"),
    created_at: project.created_at ?? now(),
    updated_at: project.updated_at ?? now()
  };
}

function normalizeProjectThread(loginId, thread = {}) {
  const tokenUsageState = normalizeThreadTokenUsage(thread.token_usage ?? thread.tokenUsage ?? null, thread);
  const activePhysicalThreadId = thread.active_physical_thread_id
    ? sanitizeBridgeId(thread.active_physical_thread_id)
    : null;

  return {
    id: sanitizeBridgeId(thread.id ?? createThreadEntityId()),
    project_id: String(thread.project_id ?? "").trim(),
    name: String(thread.name ?? thread.title ?? "Main").trim() || "Main",
    description: String(thread.description ?? "").trim(),
    developer_instructions: normalizeInstructionText(
      thread.developer_instructions ?? thread.developerInstructions
    ),
    bridge_id: BRIDGE_ID,
    login_id: sanitizeUserId(loginId),
    codex_thread_id: thread.codex_thread_id ? String(thread.codex_thread_id).trim() : null,
    status: String(thread.status ?? "idle").trim() || "idle",
    progress: Number.isFinite(Number(thread.progress)) ? Number(thread.progress) : 0,
    last_event: String(thread.last_event ?? "thread.ready").trim(),
    last_message: String(thread.last_message ?? "").trim(),
    turn_id: thread.turn_id ? String(thread.turn_id).trim() : null,
    token_usage: tokenUsageState.token_usage,
    context_window_tokens: tokenUsageState.context_window_tokens,
    context_used_tokens: tokenUsageState.context_used_tokens,
    context_usage_percent: tokenUsageState.context_usage_percent,
    active_physical_thread_id: activePhysicalThreadId,
    latest_physical_sequence: Number.isFinite(Number(thread.latest_physical_sequence))
      ? Number(thread.latest_physical_sequence)
      : activePhysicalThreadId
        ? 1
        : 0,
    rollover_count: Number.isFinite(Number(thread.rollover_count)) ? Number(thread.rollover_count) : 0,
    continuity_mode: String(thread.continuity_mode ?? "projection_merge").trim() || "projection_merge",
    continuity_status: String(thread.continuity_status ?? "healthy").trim() || "healthy",
    created_at: thread.created_at ?? now(),
    updated_at: thread.updated_at ?? now(),
    deleted_at: thread.deleted_at ?? null
  };
}

function normalizeTokenUsageBreakdown(breakdown = null, fallback = {}) {
  const safeFallback = fallback && typeof fallback === "object" ? fallback : {};
  const inputTokens = Number.isFinite(Number(breakdown?.inputTokens ?? breakdown?.input_tokens))
    ? Number(breakdown.inputTokens ?? breakdown.input_tokens)
    : Number.isFinite(Number(safeFallback.input_tokens))
      ? Number(safeFallback.input_tokens)
      : null;
  const cachedInputTokens = Number.isFinite(Number(breakdown?.cachedInputTokens ?? breakdown?.cached_input_tokens))
    ? Number(breakdown.cachedInputTokens ?? breakdown.cached_input_tokens)
    : Number.isFinite(Number(safeFallback.cached_input_tokens))
      ? Number(safeFallback.cached_input_tokens)
      : null;
  const outputTokens = Number.isFinite(Number(breakdown?.outputTokens ?? breakdown?.output_tokens))
    ? Number(breakdown.outputTokens ?? breakdown.output_tokens)
    : Number.isFinite(Number(safeFallback.output_tokens))
      ? Number(safeFallback.output_tokens)
      : null;
  const reasoningOutputTokens = Number.isFinite(
    Number(breakdown?.reasoningOutputTokens ?? breakdown?.reasoning_output_tokens)
  )
    ? Number(breakdown.reasoningOutputTokens ?? breakdown.reasoning_output_tokens)
    : Number.isFinite(Number(safeFallback.reasoning_output_tokens))
      ? Number(safeFallback.reasoning_output_tokens)
      : null;
  const totalTokens = Number.isFinite(Number(breakdown?.totalTokens ?? breakdown?.total_tokens))
    ? Number(breakdown.totalTokens ?? breakdown.total_tokens)
    : Number.isFinite(Number(safeFallback.total_tokens))
      ? Number(safeFallback.total_tokens)
      : null;
  const hasPositiveComponent =
    (inputTokens ?? 0) > 0 ||
    (cachedInputTokens ?? 0) > 0 ||
    (outputTokens ?? 0) > 0 ||
    (reasoningOutputTokens ?? 0) > 0;
  const normalizedTotalTokens = totalTokens === 0 && hasPositiveComponent ? null : totalTokens;

  if (
    inputTokens === null &&
    cachedInputTokens === null &&
    outputTokens === null &&
    reasoningOutputTokens === null &&
    normalizedTotalTokens === null
  ) {
    return null;
  }

  return {
    input_tokens: inputTokens ?? 0,
    cached_input_tokens: cachedInputTokens ?? 0,
    output_tokens: outputTokens ?? 0,
    reasoning_output_tokens: reasoningOutputTokens ?? 0,
    total_tokens: normalizedTotalTokens
  };
}

function normalizeThreadTokenUsage(tokenUsage = null, fallback = {}) {
  const fallbackTokenUsage = fallback.token_usage ?? fallback.tokenUsage ?? null;
  const last = normalizeTokenUsageBreakdown(tokenUsage?.last, fallbackTokenUsage?.last);
  const total = normalizeTokenUsageBreakdown(tokenUsage?.total, fallbackTokenUsage?.total);
  const hasTokenUsageActivity =
    (last?.input_tokens ?? 0) > 0 ||
    (last?.cached_input_tokens ?? 0) > 0 ||
    (last?.output_tokens ?? 0) > 0 ||
    (last?.reasoning_output_tokens ?? 0) > 0 ||
    (total?.input_tokens ?? 0) > 0 ||
    (total?.cached_input_tokens ?? 0) > 0 ||
    (total?.output_tokens ?? 0) > 0 ||
    (total?.reasoning_output_tokens ?? 0) > 0;
  const parseTokenCount = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };
  const clampPercent = (value) => Math.max(0, Math.min(100, Math.round(value)));
  const derivePromptTokens = (breakdown = null) => {
    if (!breakdown) {
      return null;
    }

    const inputTokens = Number.isFinite(Number(breakdown.input_tokens)) ? Number(breakdown.input_tokens) : 0;
    const cachedInputTokens = Number.isFinite(Number(breakdown.cached_input_tokens))
      ? Number(breakdown.cached_input_tokens)
      : 0;
    const totalPromptTokens = inputTokens + cachedInputTokens;

    return totalPromptTokens > 0 ? totalPromptTokens : null;
  };
  const explicitContextWindowTokens = parseTokenCount(
    tokenUsage?.contextWindowTokens ??
      tokenUsage?.context_window_tokens ??
      tokenUsage?.contextWindow ??
      tokenUsage?.context_window
  );
  const explicitContextUsedTokens = parseTokenCount(
    tokenUsage?.contextUsedTokens ??
      tokenUsage?.context_used_tokens ??
      tokenUsage?.contextTokens ??
      tokenUsage?.context_tokens
  );
  const explicitContextUsagePercent = parseTokenCount(
    tokenUsage?.contextUsagePercent ?? tokenUsage?.context_usage_percent
  );
  const hasExplicitContextUsedTokens = explicitContextUsedTokens !== null;
  const hasExplicitContextUsagePercent = explicitContextUsagePercent !== null;
  const hasExplicitContextUsage = hasExplicitContextUsedTokens || hasExplicitContextUsagePercent;
  const lastPromptTokens = derivePromptTokens(last);
  const totalPromptTokens = derivePromptTokens(total);
  const fallbackTotalPromptTokens = derivePromptTokens(fallbackTokenUsage?.total ?? null);
  const rawModelContextWindow =
    explicitContextWindowTokens ??
    tokenUsage?.modelContextWindow ??
    tokenUsage?.model_context_window ??
    fallback.context_window_tokens ??
    fallbackTokenUsage?.model_context_window;
  const modelContextWindow =
    rawModelContextWindow === null || rawModelContextWindow === undefined
      ? null
      : Number.isFinite(Number(rawModelContextWindow))
        ? Number(rawModelContextWindow)
        : null;
  const rawFallbackContextUsedTokens =
    Number(fallback.context_used_tokens) === 0 && hasTokenUsageActivity
      ? null
      : fallback.context_used_tokens;
  let derivedContextUsedTokens = explicitContextUsedTokens;

  if (derivedContextUsedTokens === null && lastPromptTokens !== null) {
    derivedContextUsedTokens = lastPromptTokens;
  }

  if (derivedContextUsedTokens === null && totalPromptTokens !== null) {
    if (fallbackTotalPromptTokens !== null && totalPromptTokens >= fallbackTotalPromptTokens) {
      derivedContextUsedTokens = totalPromptTokens - fallbackTotalPromptTokens;
    } else {
      derivedContextUsedTokens = totalPromptTokens;
    }
  }

  const rawContextUsedTokens =
    derivedContextUsedTokens === null || derivedContextUsedTokens === undefined
      ? rawFallbackContextUsedTokens
      : derivedContextUsedTokens;
  const fallbackContextUsedTokensValue = parseTokenCount(fallback.context_used_tokens);
  let contextUsedTokens =
    rawContextUsedTokens === null || rawContextUsedTokens === undefined
      ? null
      : Number.isFinite(Number(rawContextUsedTokens))
        ? Number(rawContextUsedTokens)
        : null;
  const rawContextUsagePercent =
    Number(fallback.context_usage_percent) === 0 && hasTokenUsageActivity
      ? null
      : fallback.context_usage_percent;
  const fallbackContextUsagePercentValue =
    rawContextUsagePercent === null || rawContextUsagePercent === undefined
      ? null
      : Number.isFinite(Number(rawContextUsagePercent))
        ? clampPercent(Number(rawContextUsagePercent))
        : null;
  if (hasTokenUsageActivity && !hasExplicitContextUsage && fallbackContextUsedTokensValue !== null) {
    if (contextUsedTokens === null || contextUsedTokens < fallbackContextUsedTokensValue) {
      contextUsedTokens = fallbackContextUsedTokensValue;
    }
  } else if (
    !hasExplicitContextUsage &&
    contextUsedTokens === null &&
    fallbackContextUsedTokensValue !== null
  ) {
    contextUsedTokens = fallbackContextUsedTokensValue;
  }
  let contextUsagePercent =
    explicitContextUsagePercent !== null
      ? clampPercent(explicitContextUsagePercent)
      : modelContextWindow && contextUsedTokens !== null
        ? clampPercent((contextUsedTokens / modelContextWindow) * 100)
        : fallbackContextUsagePercentValue;
  if (
    hasTokenUsageActivity &&
    !hasExplicitContextUsage &&
    fallbackContextUsagePercentValue !== null
  ) {
    if (contextUsagePercent === null || contextUsagePercent < fallbackContextUsagePercentValue) {
      contextUsagePercent = fallbackContextUsagePercentValue;
    }
  } else if (
    !hasExplicitContextUsage &&
    contextUsagePercent === null &&
    fallbackContextUsagePercentValue !== null
  ) {
    contextUsagePercent = fallbackContextUsagePercentValue;
  }

  if (!last && !total && modelContextWindow === null && contextUsedTokens === null && contextUsagePercent === null) {
    return {
      token_usage: null,
      context_window_tokens: null,
      context_used_tokens: null,
      context_usage_percent: null
    };
  }

  return {
    token_usage:
      last || total || modelContextWindow !== null
        ? {
            last,
            total,
            model_context_window: modelContextWindow
          }
        : null,
    context_window_tokens: modelContextWindow,
    context_used_tokens: contextUsedTokens,
    context_usage_percent: contextUsagePercent
  };
}

function normalizeIssueCard(issue = {}) {
  const queuePosition = issue.queue_position ?? issue.queuePosition;
  const prepPosition = issue.prep_position ?? issue.prepPosition;

  return {
    id: sanitizeBridgeId(issue.id ?? createIssueCardId()),
    project_id: String(issue.project_id ?? "").trim(),
    thread_id: String(issue.thread_id ?? "").trim(),
    root_thread_id: String(issue.root_thread_id ?? issue.thread_id ?? "").trim(),
    created_physical_thread_id: issue.created_physical_thread_id
      ? sanitizeBridgeId(issue.created_physical_thread_id)
      : null,
    executed_physical_thread_id: issue.executed_physical_thread_id
      ? sanitizeBridgeId(issue.executed_physical_thread_id)
      : null,
    title: String(issue.title ?? "").trim() || "Untitled issue",
    prompt: String(issue.prompt ?? "").trim(),
    attachments: normalizeIssueAttachments(issue.attachments),
    status: String(issue.status ?? "staged").trim() || "staged",
    progress: Number.isFinite(Number(issue.progress)) ? Number(issue.progress) : 0,
    last_event: String(issue.last_event ?? "issue.created").trim(),
    last_message: String(issue.last_message ?? "").trim(),
    queue_position:
      queuePosition == null || queuePosition === ""
        ? null
        : Number.isFinite(Number(queuePosition))
          ? Number(queuePosition)
          : null,
    prep_position:
      prepPosition == null || prepPosition === ""
        ? null
        : Number.isFinite(Number(prepPosition))
          ? Number(prepPosition)
          : null,
    source_app_id: String(issue.source_app_id ?? issue.sourceAppId ?? "").trim() || null,
    created_at: issue.created_at ?? now(),
    updated_at: issue.updated_at ?? now(),
    source: issue.source ?? "bridge",
    deleted_at: issue.deleted_at ?? null
  };
}

function normalizeIssueAttachmentUrl(value) {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    return null;
  }

  return /^https?:\/\//i.test(normalized) ? normalized.slice(0, 4000) : null;
}

function normalizeIssueAttachmentLocalPath(value) {
  const normalized = String(value ?? "").trim();

  if (!normalized || !isAbsolute(normalized)) {
    return null;
  }

  return normalized.slice(0, 2000);
}

function hasOwnAttachmentField(attachment, ...fieldNames) {
  if (!attachment || typeof attachment !== "object") {
    return false;
  }

  return fieldNames.some((fieldName) => Object.hasOwn(attachment, fieldName));
}

function mergePreservedIssueAttachmentRuntimeFields(attachment, previousAttachment) {
  if (!previousAttachment) {
    return attachment;
  }

  return {
    ...attachment,
    upload_id: hasOwnAttachmentField(attachment, "upload_id", "uploadId")
      ? attachment.upload_id ?? attachment.uploadId
      : previousAttachment.upload_id,
    download_url: hasOwnAttachmentField(attachment, "download_url", "downloadUrl")
      ? attachment.download_url ?? attachment.downloadUrl
      : previousAttachment.download_url,
    cleanup_url: hasOwnAttachmentField(attachment, "cleanup_url", "cleanupUrl")
      ? attachment.cleanup_url ?? attachment.cleanupUrl
      : previousAttachment.cleanup_url,
    local_path: hasOwnAttachmentField(attachment, "local_path", "localPath")
      ? attachment.local_path ?? attachment.localPath
      : previousAttachment.local_path,
    uploaded_at: hasOwnAttachmentField(attachment, "uploaded_at", "uploadedAt")
      ? attachment.uploaded_at ?? attachment.uploadedAt
      : previousAttachment.uploaded_at
  };
}

function normalizeIssueAttachment(attachment = {}) {
  const name = String(attachment.name ?? "").trim().slice(0, 160);

  if (!name) {
    return null;
  }

  const mimeType = String(attachment.mime_type ?? attachment.mimeType ?? "").trim().slice(0, 120);
  const previewUrl = String(attachment.preview_url ?? attachment.previewUrl ?? "")
    .trim()
    .slice(0, 200_000);
  const textContent = String(attachment.text_content ?? attachment.textContent ?? "")
    .replace(/\r\n/g, "\n")
    .slice(0, 20_000);
  const downloadUrl = normalizeIssueAttachmentUrl(attachment.download_url ?? attachment.downloadUrl);
  const cleanupUrl = normalizeIssueAttachmentUrl(attachment.cleanup_url ?? attachment.cleanupUrl);
  const localPath = normalizeIssueAttachmentLocalPath(attachment.local_path ?? attachment.localPath);
  const uploadId = sanitizeBridgeId(attachment.upload_id ?? attachment.uploadId ?? `iatt-${randomUUID()}`);
  const uploadedAt = String(attachment.uploaded_at ?? attachment.uploadedAt ?? "").trim();
  const kind =
    attachment.kind === "image" ||
    mimeType.toLowerCase().startsWith("image/") ||
    previewUrl.startsWith("data:image/")
      ? "image"
      : "file";

  return {
    id: sanitizeBridgeId(attachment.id ?? `iatt-${randomUUID()}`),
    name,
    kind,
    mime_type: mimeType || null,
    size_bytes: Number.isFinite(Number(attachment.size_bytes ?? attachment.sizeBytes))
      ? Math.max(0, Number(attachment.size_bytes ?? attachment.sizeBytes))
      : 0,
    preview_url: previewUrl || null,
    text_content: textContent || null,
    text_truncated: Boolean(attachment.text_truncated ?? attachment.textTruncated),
    upload_id: uploadId || null,
    download_url: downloadUrl,
    cleanup_url: cleanupUrl,
    local_path: localPath,
    uploaded_at: uploadedAt || null
  };
}

function normalizeIssueAttachments(attachments = []) {
  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments
    .map((attachment) => normalizeIssueAttachment(attachment))
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeIssueAttachmentsWithExisting(attachments = [], existingAttachments = []) {
  if (!Array.isArray(attachments)) {
    return [];
  }

  const existingById = new Map(
    normalizeIssueAttachments(existingAttachments).map((attachment) => [attachment.id, attachment])
  );

  return attachments
    .map((attachment) => {
      const rawId = sanitizeBridgeId(attachment?.id ?? "");
      const previousAttachment = rawId ? existingById.get(rawId) ?? null : null;
      return normalizeIssueAttachment(mergePreservedIssueAttachmentRuntimeFields(attachment, previousAttachment));
    })
    .filter(Boolean)
    .slice(0, 8);
}

function serializeIssueAttachmentForClient(attachment = {}) {
  const normalized = normalizeIssueAttachment(attachment);

  if (!normalized) {
    return null;
  }

  return {
    id: normalized.id,
    name: normalized.name,
    kind: normalized.kind,
    mime_type: normalized.mime_type,
    size_bytes: normalized.size_bytes,
    preview_url: normalized.preview_url,
    text_content: normalized.text_content,
    text_truncated: normalized.text_truncated
  };
}

function serializeIssueAttachmentsForClient(attachments = []) {
  return normalizeIssueAttachments(attachments)
    .map((attachment) => serializeIssueAttachmentForClient(attachment))
    .filter(Boolean);
}

function sanitizeIssueAttachmentFileName(fileName = "") {
  const baseName = basename(String(fileName ?? "").trim() || "attachment");
  const extension = extname(baseName).replace(/[^a-zA-Z0-9.]/g, "").slice(0, 16);
  const stem = baseName
    .slice(0, baseName.length - extension.length)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return `${stem || "attachment"}${extension}`;
}

function resolveIssueAttachmentStageDirectory(issueId) {
  return resolve(ISSUE_ATTACHMENT_STAGE_ROOT, sanitizeBridgeId(issueId));
}

function clearIssueAttachmentStageDirectory(issueId) {
  try {
    rmSync(resolveIssueAttachmentStageDirectory(issueId), { recursive: true, force: true });
  } catch (error) {
    console.warn("[OctOP bridge] issue attachment stage cleanup failed", {
      issue_id: issueId,
      error: error.message
    });
  }
}

async function deleteRemoteIssueAttachmentUpload(attachment) {
  const normalized = normalizeIssueAttachment(attachment);

  if (!normalized?.cleanup_url) {
    return;
  }

  const response = await fetch(normalized.cleanup_url, {
    method: "DELETE",
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`attachment cleanup failed (${response.status})`);
  }
}

function stripIssueAttachmentRuntimeFields(attachment, options = {}) {
  const normalized = normalizeIssueAttachment(attachment);

  if (!normalized) {
    return null;
  }

  return normalizeIssueAttachment({
    ...normalized,
    local_path: null,
    ...(options.removeRemote ? { download_url: null, cleanup_url: null } : {})
  });
}

async function cleanupRemovedIssueAttachments(previousAttachments = [], nextAttachments = []) {
  const nextIds = new Set(normalizeIssueAttachments(nextAttachments).map((attachment) => attachment.id));
  const removedAttachments = normalizeIssueAttachments(previousAttachments).filter(
    (attachment) => !nextIds.has(attachment.id)
  );

  for (const attachment of removedAttachments) {
    try {
      await deleteRemoteIssueAttachmentUpload(attachment);
    } catch (error) {
      console.warn("[OctOP bridge] removed issue attachment cleanup failed", {
        issue_attachment_id: attachment.id,
        error: error.message
      });
    }
  }
}

async function cleanupIssueAttachmentResources(issueId, options = {}) {
  const normalizedIssueId = sanitizeBridgeId(issueId);
  const issue = issueCardsById.get(normalizedIssueId);
  const attachments = normalizeIssueAttachments(options.attachments ?? issue?.attachments ?? []);
  const removeRemote = options.removeRemote !== false;

  for (const attachment of attachments) {
    if (!removeRemote) {
      continue;
    }

    try {
      await deleteRemoteIssueAttachmentUpload(attachment);
    } catch (error) {
      console.warn("[OctOP bridge] issue attachment cleanup failed", {
        issue_id: normalizedIssueId,
        issue_attachment_id: attachment.id,
        error: error.message
      });
    }
  }

  clearIssueAttachmentStageDirectory(normalizedIssueId);

  const currentIssue = issueCardsById.get(normalizedIssueId);

  if (!currentIssue || options.forgetIssue) {
    return;
  }

  const nextAttachments = normalizeIssueAttachments(currentIssue.attachments)
    .map((attachment) => stripIssueAttachmentRuntimeFields(attachment, { removeRemote }))
    .filter(Boolean);

  issueCardsById.set(normalizedIssueId, {
    ...currentIssue,
    attachments: nextAttachments,
    updated_at: now()
  });
  persistThreadById(currentIssue.thread_id);
}

function queueIssueAttachmentCleanup(issueId, options = {}) {
  const normalizedIssueId = sanitizeBridgeId(issueId);
  const currentLock = issueAttachmentCleanupLocksByIssueId.get(normalizedIssueId);

  if (currentLock) {
    return currentLock;
  }

  const cleanupPromise = cleanupIssueAttachmentResources(normalizedIssueId, options)
    .catch((error) => {
      console.warn("[OctOP bridge] queued issue attachment cleanup failed", {
        issue_id: normalizedIssueId,
        error: error.message
      });
    })
    .finally(() => {
      if (issueAttachmentCleanupLocksByIssueId.get(normalizedIssueId) === cleanupPromise) {
        issueAttachmentCleanupLocksByIssueId.delete(normalizedIssueId);
      }
    });

  issueAttachmentCleanupLocksByIssueId.set(normalizedIssueId, cleanupPromise);
  return cleanupPromise;
}

async function stageIssueAttachmentsForExecution(issueId) {
  const issue = issueCardsById.get(issueId);

  if (!issue) {
    throw new Error("첨부를 준비할 이슈를 찾을 수 없습니다.");
  }

  const attachments = normalizeIssueAttachments(issue.attachments);

  if (attachments.length === 0) {
    return issue;
  }

  const issueStageDirectory = resolveIssueAttachmentStageDirectory(issueId);
  mkdirSync(issueStageDirectory, { recursive: true });
  const nextAttachments = [];

  try {
    for (const [index, attachment] of attachments.entries()) {
      if (!attachment.download_url) {
        nextAttachments.push(attachment);
        continue;
      }

      const stagedFilePath =
        attachment.local_path && existsSync(attachment.local_path)
          ? attachment.local_path
          : resolve(
              issueStageDirectory,
              `${String(index + 1).padStart(2, "0")}-${sanitizeIssueAttachmentFileName(attachment.name)}`
            );

      if (!existsSync(stagedFilePath)) {
        const response = await fetch(attachment.download_url, {
          headers: {
            Accept: "*/*"
          }
        });

        if (!response.ok) {
          throw new Error(`첨부 다운로드에 실패했습니다. (${response.status})`);
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        writeFileSync(stagedFilePath, buffer);
      }

      nextAttachments.push(
        normalizeIssueAttachment({
          ...attachment,
          local_path: stagedFilePath
        })
      );
    }
  } catch (error) {
    clearIssueAttachmentStageDirectory(issueId);
    throw error;
  }

  updateIssueCard(issueId, { attachments: nextAttachments });
  return issueCardsById.get(issueId) ?? { ...issue, attachments: nextAttachments };
}

function normalizeTodoChat(loginId, chat = {}) {
  return {
    id: sanitizeBridgeId(chat.id ?? createTodoChatId()),
    bridge_id: BRIDGE_ID,
    login_id: sanitizeUserId(chat.login_id ?? loginId),
    title: String(chat.title ?? "").trim() || "새 ToDo 채팅",
    last_message: String(chat.last_message ?? "").trim(),
    message_count: Number.isFinite(Number(chat.message_count)) ? Number(chat.message_count) : 0,
    created_at: chat.created_at ?? now(),
    updated_at: chat.updated_at ?? now(),
    deleted_at: chat.deleted_at ?? null
  };
}

function normalizeTodoMessage(loginId, message = {}) {
  return {
    id: sanitizeBridgeId(message.id ?? createTodoMessageId()),
    todo_chat_id: sanitizeBridgeId(message.todo_chat_id ?? message.todoChatId ?? createTodoChatId()),
    bridge_id: BRIDGE_ID,
    login_id: sanitizeUserId(message.login_id ?? loginId),
    content: String(message.content ?? "").trim(),
    status: String(message.status ?? "open").trim() || "open",
    moved_to_project_id: String(message.moved_to_project_id ?? "").trim() || null,
    moved_to_thread_id: String(message.moved_to_thread_id ?? "").trim() || null,
    moved_to_issue_id: String(message.moved_to_issue_id ?? "").trim() || null,
    created_at: message.created_at ?? now(),
    updated_at: message.updated_at ?? now(),
    deleted_at: message.deleted_at ?? null
  };
}

function normalizePhysicalThread(physicalThread = {}, fallbackRootThread = null) {
  const tokenUsageState = normalizeThreadTokenUsage(
    physicalThread.token_usage ?? physicalThread.tokenUsage ?? null,
    physicalThread
  );

  return {
    id: sanitizeBridgeId(physicalThread.id ?? createPhysicalThreadId()),
    root_thread_id: sanitizeBridgeId(
      physicalThread.root_thread_id ?? fallbackRootThread?.id ?? physicalThread.thread_id ?? createThreadEntityId()
    ),
    project_id: String(physicalThread.project_id ?? fallbackRootThread?.project_id ?? "").trim(),
    bridge_id: BRIDGE_ID,
    login_id: sanitizeUserId(physicalThread.login_id ?? fallbackRootThread?.login_id ?? BRIDGE_OWNER_LOGIN_ID),
    sequence: Number.isFinite(Number(physicalThread.sequence)) ? Number(physicalThread.sequence) : 1,
    codex_thread_id: physicalThread.codex_thread_id ? String(physicalThread.codex_thread_id).trim() : null,
    status: String(physicalThread.status ?? "active").trim() || "active",
    opened_reason: String(physicalThread.opened_reason ?? "initial").trim() || "initial",
    opened_from_physical_thread_id: physicalThread.opened_from_physical_thread_id
      ? sanitizeBridgeId(physicalThread.opened_from_physical_thread_id)
      : null,
    rollover_trigger_percent: Number.isFinite(Number(physicalThread.rollover_trigger_percent))
      ? Number(physicalThread.rollover_trigger_percent)
      : null,
    handoff_summary_id: physicalThread.handoff_summary_id
      ? sanitizeBridgeId(physicalThread.handoff_summary_id)
      : null,
    turn_id: physicalThread.turn_id ? String(physicalThread.turn_id).trim() : null,
    last_event: String(physicalThread.last_event ?? fallbackRootThread?.last_event ?? "physicalThread.ready").trim(),
    last_message: String(physicalThread.last_message ?? fallbackRootThread?.last_message ?? "").trim(),
    token_usage: tokenUsageState.token_usage,
    context_window_tokens: tokenUsageState.context_window_tokens,
    context_used_tokens: tokenUsageState.context_used_tokens,
    context_usage_percent: tokenUsageState.context_usage_percent,
    created_at: physicalThread.created_at ?? now(),
    updated_at: physicalThread.updated_at ?? now(),
    closed_at: physicalThread.closed_at ?? null,
    deleted_at: physicalThread.deleted_at ?? null
  };
}

function normalizeHandoffSummary(summary = {}) {
  return {
    id: sanitizeBridgeId(summary.id ?? createHandoffSummaryId()),
    root_thread_id: sanitizeBridgeId(summary.root_thread_id ?? summary.thread_id ?? createThreadEntityId()),
    target_physical_thread_id: summary.target_physical_thread_id
      ? sanitizeBridgeId(summary.target_physical_thread_id)
      : null,
    source_physical_thread_id: summary.source_physical_thread_id
      ? sanitizeBridgeId(summary.source_physical_thread_id)
      : null,
    format_version: Number.isFinite(Number(summary.format_version)) ? Number(summary.format_version) : 1,
    summary_type: String(summary.summary_type ?? "handoff").trim() || "handoff",
    content_markdown: String(summary.content_markdown ?? "").trim(),
    content_json: summary.content_json && typeof summary.content_json === "object" ? summary.content_json : {},
    created_at: summary.created_at ?? now(),
    deleted_at: summary.deleted_at ?? null
  };
}

function getRootThreadIdForIssue(issue) {
  return String(issue?.root_thread_id ?? issue?.thread_id ?? "").trim();
}

function getThreadIssueIds(threadId) {
  if (!threadIssueIdsById.has(threadId)) {
    threadIssueIdsById.set(threadId, []);
  }

  return threadIssueIdsById.get(threadId);
}

function ensureTodoChatIdsForUser(userId) {
  const normalized = sanitizeUserId(userId);

  if (!todoChatIdsByUserId.has(normalized)) {
    todoChatIdsByUserId.set(normalized, new Set());
  }

  return todoChatIdsByUserId.get(normalized);
}

function getTodoMessageIds(chatId) {
  const normalized = sanitizeBridgeId(chatId);

  if (!todoMessageIdsByChatId.has(normalized)) {
    todoMessageIdsByChatId.set(normalized, []);
  }

  return todoMessageIdsByChatId.get(normalized);
}

function setTodoMessageIds(chatId, messageIds) {
  todoMessageIdsByChatId.set(sanitizeBridgeId(chatId), messageIds);
  persistTodoChatById(chatId);
}

function listTodoMessagesByChatId(chatId) {
  return getTodoMessageIds(chatId)
    .map((messageId) => todoMessagesById.get(messageId))
    .filter(Boolean)
    .filter((message) => !message.deleted_at)
    .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));
}

function syncTodoChatSnapshot(chatId) {
  const chat = todoChatsById.get(chatId);

  if (!chat) {
    return null;
  }

  const openMessages = listTodoMessagesByChatId(chatId).filter((message) => message.status === "open");
  const latestMessage = openMessages.at(-1) ?? null;
  const nextChat = {
    ...chat,
    last_message: latestMessage?.content ?? "",
    message_count: openMessages.length,
    updated_at: latestMessage?.updated_at ?? chat.updated_at
  };

  todoChatsById.set(chatId, nextChat);
  return nextChat;
}

function persistTodoChatById(chatId) {
  const owner = todoChatsById.get(chatId)?.login_id ?? null;

  if (!owner) {
    return;
  }

  persistThreadsForUser(owner);
}

function listTodoChats(userId) {
  const state = ensureUserState(userId);
  const todoChatIds = [...(state.todoChatIds ?? ensureTodoChatIdsForUser(userId))];
  return todoChatIds
    .map((chatId) => syncTodoChatSnapshot(chatId) ?? todoChatsById.get(chatId))
    .filter(Boolean)
    .filter((chat) => !chat.deleted_at)
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
}

function getTodoMessagesResponse(userId, chatId) {
  const chat = todoChatsById.get(chatId) ?? null;

  if (!chat || chat.deleted_at || chat.login_id !== sanitizeUserId(userId)) {
    return {
      chat: null,
      messages: []
    };
  }

  return {
    chat: syncTodoChatSnapshot(chatId) ?? chat,
    messages: listTodoMessagesByChatId(chatId).filter(
      (message) => message.login_id === sanitizeUserId(userId) && message.status === "open"
    )
  };
}

function setThreadIssueIds(threadId, issueIds) {
  threadIssueIdsById.set(threadId, issueIds);
  persistThreadById(threadId);
}

function getPrepIssueIds(threadId) {
  return getThreadIssueIds(threadId).filter((issueId) => {
    const issue = issueCardsById.get(issueId);
    return issue && !issue.deleted_at && issue.status === "staged";
  });
}

function getNextPrepPosition(threadId) {
  const stagedIssues = getPrepIssueIds(threadId)
    .map((issueId) => issueCardsById.get(issueId))
    .filter((issue) => Number.isFinite(issue?.prep_position));

  if (stagedIssues.length === 0) {
    return 1;
  }

  const minPosition = Math.min(...stagedIssues.map((issue) => issue.prep_position));
  return Number.isFinite(minPosition) ? minPosition - 1 : 1;
}

function ensurePendingQueue(threadId) {
  const normalized = sanitizeBridgeId(threadId);

  if (!pendingStartQueues.has(normalized)) {
    pendingStartQueues.set(normalized, []);
  }

  return pendingStartQueues.get(normalized);
}

function getRootThreadPhysicalThreadIds(rootThreadId) {
  const normalizedRootThreadId = sanitizeBridgeId(rootThreadId);

  if (!rootThreadPhysicalThreadIdsById.has(normalizedRootThreadId)) {
    rootThreadPhysicalThreadIdsById.set(normalizedRootThreadId, []);
  }

  return rootThreadPhysicalThreadIdsById.get(normalizedRootThreadId);
}

function setRootThreadPhysicalThreadIds(rootThreadId, physicalThreadIds) {
  rootThreadPhysicalThreadIdsById.set(
    sanitizeBridgeId(rootThreadId),
    physicalThreadIds.map((physicalThreadId) => sanitizeBridgeId(physicalThreadId))
  );
}

function listPhysicalThreads(rootThreadId) {
  return getRootThreadPhysicalThreadIds(rootThreadId)
    .map((physicalThreadId) => physicalThreadStateById.get(physicalThreadId))
    .filter(Boolean)
    .sort((left, right) => left.sequence - right.sequence);
}

function getActivePhysicalThread(rootThreadId) {
  const rootThread = threadStateById.get(rootThreadId);
  const activePhysicalThreadId = rootThread?.active_physical_thread_id ?? null;

  if (activePhysicalThreadId) {
    const activePhysicalThread = physicalThreadStateById.get(activePhysicalThreadId) ?? null;

    if (activePhysicalThread && !activePhysicalThread.deleted_at) {
      return activePhysicalThread;
    }
  }

  const fallback = listPhysicalThreads(rootThreadId)
    .filter((physicalThread) => !physicalThread.deleted_at)
    .sort((left, right) => right.sequence - left.sequence)[0] ?? null;

  if (!fallback) {
    return null;
  }

  if (rootThread) {
    threadStateById.set(rootThreadId, {
      ...rootThread,
      active_physical_thread_id: fallback.id,
      latest_physical_sequence: fallback.sequence,
      codex_thread_id: fallback.codex_thread_id ?? null,
      context_window_tokens: fallback.context_window_tokens,
      context_used_tokens: fallback.context_used_tokens,
      context_usage_percent: fallback.context_usage_percent,
      updated_at: now()
    });
  }

  return fallback;
}

function resolvePhysicalThreadIdByCodexThreadId(codexThreadId) {
  const candidate = String(codexThreadId ?? "").trim();

  if (!candidate) {
    return null;
  }

  if (codexThreadToPhysicalThreadId.has(candidate)) {
    return codexThreadToPhysicalThreadId.get(candidate) ?? null;
  }

  for (const [physicalThreadId, physicalThread] of physicalThreadStateById.entries()) {
    if (physicalThread?.codex_thread_id === candidate) {
      codexThreadToPhysicalThreadId.set(candidate, physicalThreadId);
      return physicalThreadId;
    }
  }

  return null;
}

function createPhysicalThread(rootThreadId, reason = "initial", sourcePhysicalThread = null, overrides = {}) {
  const rootThread = threadStateById.get(rootThreadId);

  if (!rootThread) {
    throw new Error("root thread를 찾을 수 없습니다.");
  }

  const nextSequence = Number(rootThread.latest_physical_sequence ?? 0) + 1;
  const physicalThread = normalizePhysicalThread(
    {
      id: createPhysicalThreadId(),
      root_thread_id: rootThreadId,
      project_id: rootThread.project_id,
      sequence: nextSequence,
      status: overrides.status ?? "active",
      opened_reason: reason,
      opened_from_physical_thread_id: sourcePhysicalThread?.id ?? null,
      rollover_trigger_percent: overrides.rollover_trigger_percent ?? null,
      handoff_summary_id: overrides.handoff_summary_id ?? null,
      token_usage: overrides.token_usage ?? null,
      context_window_tokens: overrides.context_window_tokens ?? null,
      context_used_tokens: overrides.context_used_tokens ?? null,
      context_usage_percent: overrides.context_usage_percent ?? null,
      last_event: overrides.last_event ?? "physicalThread.created",
      last_message: overrides.last_message ?? ""
    },
    rootThread
  );

  physicalThreadStateById.set(physicalThread.id, physicalThread);
  setRootThreadPhysicalThreadIds(rootThreadId, [
    ...getRootThreadPhysicalThreadIds(rootThreadId),
    physicalThread.id
  ]);
  return physicalThread;
}

function activatePhysicalThread(rootThreadId, physicalThreadId) {
  const rootThread = threadStateById.get(rootThreadId);
  const physicalThread = physicalThreadStateById.get(physicalThreadId);

  if (!rootThread || !physicalThread) {
    return null;
  }

  const nextRootThread = {
    ...rootThread,
    active_physical_thread_id: physicalThread.id,
    latest_physical_sequence: physicalThread.sequence,
    codex_thread_id: physicalThread.codex_thread_id ?? null,
    context_window_tokens: physicalThread.context_window_tokens,
    context_used_tokens: physicalThread.context_used_tokens,
    context_usage_percent: physicalThread.context_usage_percent,
    updated_at: now()
  };

  threadStateById.set(rootThreadId, nextRootThread);

  if (physicalThread.codex_thread_id) {
    codexThreadToThreadId.set(physicalThread.codex_thread_id, rootThreadId);
  }

  return nextRootThread;
}

function syncRootThreadFromActivePhysicalThread(rootThreadId) {
  const rootThread = threadStateById.get(rootThreadId);
  const activePhysicalThread = getActivePhysicalThread(rootThreadId);

  if (!rootThread || !activePhysicalThread) {
    return rootThread ?? null;
  }

  const nextUpdatedAt = activePhysicalThread.updated_at ?? rootThread.updated_at;
  const nextRootThread = {
    ...rootThread,
    codex_thread_id: activePhysicalThread.codex_thread_id ?? null,
    context_window_tokens: activePhysicalThread.context_window_tokens,
    context_used_tokens: activePhysicalThread.context_used_tokens,
    context_usage_percent: activePhysicalThread.context_usage_percent,
    active_physical_thread_id: activePhysicalThread.id,
    latest_physical_sequence: activePhysicalThread.sequence,
    updated_at: nextUpdatedAt
  };

  if (
    nextRootThread.codex_thread_id === rootThread.codex_thread_id &&
    nextRootThread.context_window_tokens === rootThread.context_window_tokens &&
    nextRootThread.context_used_tokens === rootThread.context_used_tokens &&
    nextRootThread.context_usage_percent === rootThread.context_usage_percent &&
    nextRootThread.active_physical_thread_id === rootThread.active_physical_thread_id &&
    nextRootThread.latest_physical_sequence === rootThread.latest_physical_sequence &&
    nextRootThread.updated_at === rootThread.updated_at
  ) {
    return rootThread;
  }

  threadStateById.set(rootThreadId, nextRootThread);
  return nextRootThread;
}

function isPhysicalThreadClosed(physicalThreadId) {
  const physicalThread = physicalThreadStateById.get(physicalThreadId);
  return Boolean(physicalThread?.closed_at || physicalThread?.deleted_at);
}

function isRootThreadDeleted(rootThreadId) {
  return Boolean(threadStateById.get(rootThreadId)?.deleted_at);
}

function closePhysicalThread(physicalThreadId, reason = "rolled_over") {
  const physicalThread = physicalThreadStateById.get(physicalThreadId);

  if (!physicalThread) {
    return null;
  }

  const nextPhysicalThread = {
    ...physicalThread,
    status: "closed",
    last_event: `physicalThread.${reason}`,
    closed_at: physicalThread.closed_at ?? now(),
    updated_at: now()
  };

  physicalThreadStateById.set(physicalThreadId, nextPhysicalThread);
  return nextPhysicalThread;
}

function markPhysicalThreadClosedForEventDrop(physicalThreadId, ttlMs = CLOSED_PHYSICAL_THREAD_TOMBSTONE_TTL_MS) {
  closedPhysicalThreadTombstonesById.set(physicalThreadId, Date.now() + ttlMs);
}

function markRootThreadDeletedForEventDrop(rootThreadId, ttlMs = DELETED_ROOT_THREAD_TOMBSTONE_TTL_MS) {
  deletedRootThreadTombstonesById.set(rootThreadId, Date.now() + ttlMs);
}

function cleanupExpiredEventDropTombstones() {
  const currentTime = Date.now();

  for (const [physicalThreadId, expiresAt] of closedPhysicalThreadTombstonesById.entries()) {
    if (expiresAt <= currentTime) {
      closedPhysicalThreadTombstonesById.delete(physicalThreadId);
    }
  }

  for (const [rootThreadId, expiresAt] of deletedRootThreadTombstonesById.entries()) {
    if (expiresAt <= currentTime) {
      deletedRootThreadTombstonesById.delete(rootThreadId);
    }
  }
}

function trackRecentlyClosedPhysicalThread(rootThreadId, physicalThreadId, closedAt = now()) {
  const items = recentlyClosedPhysicalThreadIdsByRootThreadId.get(rootThreadId) ?? [];
  const closedAtMs = Date.parse(closedAt) || Date.now();
  const nextItems = [
    ...items.filter((item) => item.physical_thread_id !== physicalThreadId),
    {
      physical_thread_id: physicalThreadId,
      closed_at: closedAt,
      expires_at_ms: closedAtMs + RECENTLY_CLOSED_PHYSICAL_THREAD_GRACE_WINDOW_MS
    }
  ].filter((item) => item.expires_at_ms > Date.now());

  recentlyClosedPhysicalThreadIdsByRootThreadId.set(rootThreadId, nextItems);
}

function pruneRecentlyClosedPhysicalThreads(rootThreadId) {
  const items = recentlyClosedPhysicalThreadIdsByRootThreadId.get(rootThreadId) ?? [];
  const nextItems = items.filter((item) => item.expires_at_ms > Date.now());

  if (nextItems.length === 0) {
    recentlyClosedPhysicalThreadIdsByRootThreadId.delete(rootThreadId);
    return [];
  }

  recentlyClosedPhysicalThreadIdsByRootThreadId.set(rootThreadId, nextItems);
  return nextItems;
}

function ensureRootThreadPhysicalStructure(loginId, rootThreadId) {
  const rootThread = threadStateById.get(rootThreadId);

  if (!rootThread) {
    return null;
  }

  const existingPhysicalThreads = listPhysicalThreads(rootThreadId);

  if (existingPhysicalThreads.length > 0) {
    const activePhysicalThread = getActivePhysicalThread(rootThreadId);

    if (activePhysicalThread) {
      threadStateById.set(rootThreadId, {
        ...rootThread,
        active_physical_thread_id: activePhysicalThread.id,
        latest_physical_sequence: Math.max(
          rootThread.latest_physical_sequence ?? 0,
          activePhysicalThread.sequence
        ),
        codex_thread_id: activePhysicalThread.codex_thread_id ?? rootThread.codex_thread_id ?? null,
        continuity_mode: rootThread.continuity_mode ?? "projection_merge",
        continuity_status: rootThread.continuity_status ?? "healthy"
      });
    }

    return activePhysicalThread;
  }

  const initialPhysicalThread = normalizePhysicalThread(
    {
      root_thread_id: rootThreadId,
      project_id: rootThread.project_id,
      sequence: 1,
      codex_thread_id: rootThread.codex_thread_id ?? null,
      status: "active",
      opened_reason: "initial",
      token_usage: rootThread.token_usage,
      context_window_tokens: rootThread.context_window_tokens,
      context_used_tokens: rootThread.context_used_tokens,
      context_usage_percent: rootThread.context_usage_percent,
      last_event: rootThread.last_event,
      last_message: rootThread.last_message,
      turn_id: rootThread.turn_id
    },
    rootThread
  );

  physicalThreadStateById.set(initialPhysicalThread.id, initialPhysicalThread);
  setRootThreadPhysicalThreadIds(rootThreadId, [initialPhysicalThread.id]);
  threadStateById.set(rootThreadId, {
    ...rootThread,
    login_id: sanitizeUserId(loginId),
    active_physical_thread_id: initialPhysicalThread.id,
    latest_physical_sequence: 1,
    rollover_count: rootThread.rollover_count ?? 0,
    continuity_mode: rootThread.continuity_mode ?? "projection_merge",
    continuity_status: rootThread.continuity_status ?? "healthy",
    codex_thread_id: initialPhysicalThread.codex_thread_id ?? null
  });

  if (initialPhysicalThread.codex_thread_id) {
    codexThreadToPhysicalThreadId.set(initialPhysicalThread.codex_thread_id, initialPhysicalThread.id);
    codexThreadToThreadId.set(initialPhysicalThread.codex_thread_id, rootThreadId);
  }

  return initialPhysicalThread;
}

function markRunningIssueActivity(threadId, patch = {}) {
  const current = runningIssueMetaByThreadId.get(threadId) ?? {
    startedAt: now(),
    lastActivityAt: now(),
    lastReconciledAt: null,
    reconcileAttempts: 0,
    missingRemoteAttempts: 0,
    noProgressBackfillCount: 0,
    lastSeenCodexThreadId: null,
    backfillRequestedAt: null,
    backfillTrigger: null,
    backfillLastPolledAt: null,
    backfillLastError: null,
    lastThreadReadAt: null,
    lastThreadReadReason: null,
    lastThreadReadRemoteStatus: null,
    lastThreadReadTurnId: null,
    lastThreadReadAssistantLength: 0,
    lastThreadReadAppendedDeltaLength: 0,
    lastThreadReadHadProgress: null
  };
  const next = {
    ...current,
    ...patch,
    lastActivityAt: patch.lastActivityAt ?? now()
  };

  runningIssueMetaByThreadId.set(threadId, next);
  return next;
}

function areThreadTokenUsageStatesEqual(left = {}, right = {}) {
  const normalizeComparableNumber = (value) => {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };

  return (
    JSON.stringify(left?.token_usage ?? null) === JSON.stringify(right?.token_usage ?? null) &&
    normalizeComparableNumber(left?.context_window_tokens) === normalizeComparableNumber(right?.context_window_tokens) &&
    normalizeComparableNumber(left?.context_used_tokens) === normalizeComparableNumber(right?.context_used_tokens) &&
    normalizeComparableNumber(left?.context_usage_percent) === normalizeComparableNumber(right?.context_usage_percent)
  );
}

function captureBackfillComparableState(thread = null, issue = null, physicalThread = null) {
  return {
    thread: thread
      ? {
          status: thread.status ?? null,
          progress: Number(thread.progress ?? 0),
          last_event: thread.last_event ?? null,
          last_message: String(thread.last_message ?? ""),
          continuity_status: thread.continuity_status ?? null,
          turn_id: thread.turn_id ?? null,
          token_usage: thread.token_usage ?? null,
          context_window_tokens: thread.context_window_tokens ?? null,
          context_used_tokens: thread.context_used_tokens ?? null,
          context_usage_percent: thread.context_usage_percent ?? null
        }
      : null,
    issue: issue
      ? {
          status: issue.status ?? null,
          progress: Number(issue.progress ?? 0),
          last_event: issue.last_event ?? null,
          last_message: String(issue.last_message ?? "")
        }
      : null,
    physicalThread: physicalThread
      ? {
          status: physicalThread.status ?? null,
          progress: Number(physicalThread.progress ?? 0),
          last_event: physicalThread.last_event ?? null,
          last_message: String(physicalThread.last_message ?? ""),
          turn_id: physicalThread.turn_id ?? null,
          token_usage: physicalThread.token_usage ?? null,
          context_window_tokens: physicalThread.context_window_tokens ?? null,
          context_used_tokens: physicalThread.context_used_tokens ?? null,
          context_usage_percent: physicalThread.context_usage_percent ?? null
        }
      : null
  };
}

function clearRunningIssueTracking(threadId) {
  const activeIssueId = activeIssueByThreadId.get(threadId) ?? null;
  activeIssueByThreadId.delete(threadId);
  runningIssueMetaByThreadId.delete(threadId);

  if (!activeIssueId) {
    return;
  }

  for (const [physicalThreadId, issueId] of activeIssueByPhysicalThreadId.entries()) {
    if (issueId === activeIssueId) {
      activeIssueByPhysicalThreadId.delete(physicalThreadId);
    }
  }
}

function shouldForceUnlockAfterStopFailure(unlockReason, errors = []) {
  return ["manual_refresh", "delete_issue"].includes(unlockReason) && Array.isArray(errors) && errors.length > 0;
}

function settlePhysicalThreadExecutionState(
  rootThreadId,
  {
    issue = null,
    status = "idle",
    progress = null,
    turnId = null,
    lastEvent = "thread.execution.settled",
    lastMessage = undefined,
    updatedAt = undefined
  } = {}
) {
  const rootThread = threadStateById.get(rootThreadId);
  const targetPhysicalThreadId =
    issue?.executed_physical_thread_id ??
    issue?.created_physical_thread_id ??
    rootThread?.active_physical_thread_id ??
    null;

  if (!targetPhysicalThreadId) {
    return null;
  }

  const currentPhysicalThread = physicalThreadStateById.get(targetPhysicalThreadId);

  if (!currentPhysicalThread || currentPhysicalThread.deleted_at || currentPhysicalThread.closed_at) {
    return null;
  }

  const nextPhysicalThread = {
    ...currentPhysicalThread,
    status,
    progress: progress ?? (
      status === "failed"
        ? 0
        : status === "idle"
          ? Math.max(Number(currentPhysicalThread.progress ?? 0), 100)
          : currentPhysicalThread.progress ?? 0
    ),
    turn_id: turnId,
    last_event: lastEvent,
    last_message: lastMessage ?? currentPhysicalThread.last_message,
    updated_at: updatedAt ?? now()
  };

  physicalThreadStateById.set(targetPhysicalThreadId, nextPhysicalThread);
  const nextRootThread = syncRootThreadFromActivePhysicalThread(rootThreadId);

  if (nextRootThread) {
    persistThreadById(rootThreadId);
  }

  return nextPhysicalThread;
}

function resetExecutionProjectionForNewIssue(rootThreadId, physicalThreadId, options = {}) {
  const currentRootThread = threadStateById.get(rootThreadId) ?? null;
  const currentPhysicalThread = physicalThreadStateById.get(physicalThreadId) ?? null;

  if (!currentRootThread || !currentPhysicalThread || currentPhysicalThread.deleted_at || currentPhysicalThread.closed_at) {
    return null;
  }

  const nextUpdatedAt = options.updated_at ?? now();
  const nextProgress = Number.isFinite(Number(options.progress))
    ? Number(options.progress)
    : 10;
  const nextLastEvent = String(options.last_event ?? "turn.starting").trim() || "turn.starting";
  const nextStatus = String(options.status ?? "active").trim() || "active";
  const nextLastMessage = String(options.last_message ?? "");
  const nextTurnId = options.turn_id ?? null;
  const nextPhysicalThread = {
    ...currentPhysicalThread,
    status: nextStatus,
    progress: nextProgress,
    turn_id: nextTurnId,
    last_event: nextLastEvent,
    last_message: nextLastMessage,
    updated_at: nextUpdatedAt
  };

  physicalThreadStateById.set(physicalThreadId, nextPhysicalThread);
  threadStateById.set(rootThreadId, {
    ...currentRootThread,
    status: "running",
    progress: nextProgress,
    last_event: nextLastEvent,
    last_message: nextLastMessage,
    turn_id: nextTurnId,
    continuity_status: "healthy",
    active_physical_thread_id: physicalThreadId,
    latest_physical_sequence: nextPhysicalThread.sequence,
    codex_thread_id: nextPhysicalThread.codex_thread_id ?? currentRootThread.codex_thread_id ?? null,
    context_window_tokens: nextPhysicalThread.context_window_tokens,
    context_used_tokens: nextPhysicalThread.context_used_tokens,
    context_usage_percent: nextPhysicalThread.context_usage_percent,
    updated_at: nextUpdatedAt
  });

  return nextPhysicalThread;
}

function findRecoverableRunningIssue(threadId) {
  return getThreadIssueIds(threadId)
    .map((issueId) => issueCardsById.get(issueId))
    .filter((issue) => issue && !issue.deleted_at && ["running", "awaiting_input"].includes(issue.status))
    .sort((left, right) => Date.parse(right.updated_at ?? 0) - Date.parse(left.updated_at ?? 0))[0] ?? null;
}

function ensureRunningIssueTrackingForThread(threadId) {
  const currentActiveIssueId = activeIssueByThreadId.get(threadId);
  const currentActiveIssue = currentActiveIssueId ? issueCardsById.get(currentActiveIssueId) : null;

  if (currentActiveIssue && ["running", "awaiting_input"].includes(currentActiveIssue.status)) {
    return currentActiveIssue.id;
  }

  const recoverableIssue = findRecoverableRunningIssue(threadId);
  const thread = threadStateById.get(threadId);

  if (!recoverableIssue || !thread) {
    return null;
  }

  activeIssueByThreadId.set(threadId, recoverableIssue.id);
  markRunningIssueActivity(threadId, {
    startedAt: recoverableIssue.updated_at ?? thread.updated_at ?? now(),
    lastActivityAt: recoverableIssue.updated_at ?? thread.updated_at ?? now(),
    reconcileAttempts: 0,
    missingRemoteAttempts: 0,
    noProgressBackfillCount: 0,
    lastReconciledAt: null,
    lastSeenCodexThreadId: thread.codex_thread_id ?? null,
    backfillRequestedAt: null,
    backfillTrigger: null,
    backfillLastPolledAt: null,
    backfillLastError: null
  });
  return recoverableIssue.id;
}

function clearInvalidRunningIssueTracking(threadId) {
  const activeIssueId = activeIssueByThreadId.get(threadId);
  const activeIssue = activeIssueId ? issueCardsById.get(activeIssueId) ?? null : null;

  if (activeIssue && !activeIssue.deleted_at && ["running", "awaiting_input"].includes(activeIssue.status)) {
    return false;
  }

  if (!activeIssueId) {
    return false;
  }

  clearRunningIssueTracking(threadId);
  settlePhysicalThreadExecutionState(threadId, {
    issue: activeIssue,
    status: isIssueTerminalStatus(activeIssue?.status) ? "idle" : "failed",
    progress: activeIssue?.status === "completed" ? 100 : 0,
    lastEvent: activeIssue?.last_event ?? "thread.execution.recovered",
    lastMessage: activeIssue?.last_message
  });
  updateProjectThreadSnapshot(threadId);
  persistThreadById(threadId);
  return true;
}

async function markRunningIssueContinuityDegraded(
  userId,
  threadId,
  issueId,
  thread,
  issue,
  message,
  details = {}
) {
  const degradedMessage = String(message ?? "").trim() || String(issue?.last_message ?? "").trim();
  const currentMeta = runningIssueMetaByThreadId.get(threadId) ?? null;
  const activePhysicalThreadId =
    issue?.executed_physical_thread_id ??
    issue?.created_physical_thread_id ??
    thread?.active_physical_thread_id ??
    null;
  const currentPhysicalThread = activePhysicalThreadId
    ? physicalThreadStateById.get(activePhysicalThreadId) ?? null
    : null;
  const shouldRefreshDegradedProjection =
    thread.continuity_status !== "degraded" ||
    thread.last_event !== "watchdog.degraded" ||
    issue?.last_event !== "watchdog.degraded" ||
    currentPhysicalThread?.last_event !== "watchdog.degraded";
  const nextThread = {
    ...thread,
    continuity_status: "degraded",
    last_event: "watchdog.degraded",
    last_message: degradedMessage,
    updated_at: shouldRefreshDegradedProjection ? now() : thread.updated_at
  };

  threadStateById.set(threadId, nextThread);

  if (issueId && issue && !isIssueTerminalStatus(issue.status)) {
    updateIssueCard(issueId, {
      last_event: "watchdog.degraded",
      ...(shouldRefreshDegradedProjection ? { updated_at: now() } : {}),
      ...(degradedMessage ? { last_message: degradedMessage } : {})
    });
  }

  if (activePhysicalThreadId && currentPhysicalThread && !currentPhysicalThread.deleted_at && !currentPhysicalThread.closed_at) {
    updateBackfilledPhysicalThread(threadId, activePhysicalThreadId, {
      status: currentPhysicalThread.status ?? "running",
      progress: currentPhysicalThread.progress,
      turn_id: currentPhysicalThread.turn_id ?? null,
      last_event: "watchdog.degraded",
      last_message: degradedMessage,
      updated_at: shouldRefreshDegradedProjection ? now() : currentPhysicalThread.updated_at
    });
  }

  markRunningIssueActivity(threadId, {
    lastActivityAt: currentMeta?.lastActivityAt ?? now(),
    backfillRequestedAt: currentMeta?.backfillRequestedAt ?? now(),
    backfillTrigger: details.backfillTrigger ?? "continuity_degraded",
    backfillLastError: null,
    noProgressBackfillCount: currentMeta?.noProgressBackfillCount ?? 0,
    ...(details.remoteThreadId ? { lastSeenCodexThreadId: details.remoteThreadId } : {})
  });
  updateProjectThreadSnapshot(threadId);
  persistThreadById(threadId);
  await publishThreadState(userId, threadId);
}

function listQueuedIssuesForRecovery(threadId) {
  return getThreadIssueIds(threadId)
    .map((issueId) => issueCardsById.get(issueId) ?? null)
    .filter((issue) => issue && !issue.deleted_at && issue.thread_id === threadId && issue.status === "queued")
    .sort((left, right) => {
      const leftQueuePosition = Number.isFinite(left.queue_position) ? left.queue_position : Number.MAX_SAFE_INTEGER;
      const rightQueuePosition = Number.isFinite(right.queue_position) ? right.queue_position : Number.MAX_SAFE_INTEGER;

      if (leftQueuePosition !== rightQueuePosition) {
        return leftQueuePosition - rightQueuePosition;
      }

      return Date.parse(left.created_at ?? 0) - Date.parse(right.created_at ?? 0);
    });
}

function findLatestStagedIssueForRecovery(threadId) {
  return getThreadIssueIds(threadId)
    .map((issueId) => issueCardsById.get(issueId) ?? null)
    .filter((issue) => issue && !issue.deleted_at && issue.thread_id === threadId && issue.status === "staged")
    .sort((left, right) => Date.parse(right.updated_at ?? 0) - Date.parse(left.updated_at ?? 0))[0] ?? null;
}

function repairCurrentThreadIssueQueue(threadId, { includeLatestStaged = false } = {}) {
  const currentQueue = [...ensurePendingQueue(threadId)];
  const queuedIssues = listQueuedIssuesForRecovery(threadId);
  const nextQueue = [];
  const seen = new Set();
  const recoveredQueuedIssueIds = [];

  for (const issueId of currentQueue) {
    const issue = issueCardsById.get(issueId);

    if (!issue || issue.deleted_at || issue.thread_id !== threadId || issue.status !== "queued" || seen.has(issueId)) {
      continue;
    }

    nextQueue.push(issueId);
    seen.add(issueId);
  }

  for (const issue of queuedIssues) {
    if (seen.has(issue.id)) {
      continue;
    }

    nextQueue.push(issue.id);
    seen.add(issue.id);
    recoveredQueuedIssueIds.push(issue.id);
  }

  let promotedStagedIssueId = null;

  if (nextQueue.length === 0 && includeLatestStaged) {
    const stagedIssue = findLatestStagedIssueForRecovery(threadId);

    if (stagedIssue) {
      promotedStagedIssueId = stagedIssue.id;
      nextQueue.push(stagedIssue.id);
      pendingStartQueues.set(threadId, nextQueue);
      updateIssueCard(stagedIssue.id, {
        status: "queued",
        progress: Math.max(stagedIssue.progress ?? 0, 10),
        last_event: "issue.recovered.queued",
        prep_position: null
      });
    }
  }

  const queueChanged =
    promotedStagedIssueId !== null ||
    currentQueue.length !== nextQueue.length ||
    currentQueue.some((issueId, index) => issueId !== nextQueue[index]);

  if (queueChanged && promotedStagedIssueId === null) {
    pendingStartQueues.set(threadId, nextQueue);
  }

  if (queueChanged) {
    refreshIssueQueuePositions(threadId);
  }

  return {
    queue: nextQueue,
    queueChanged,
    recoveredQueuedIssueIds,
    promotedStagedIssueId
  };
}

function ensureIssueMessages(issueId) {
  if (!issueMessagesById.has(issueId)) {
    issueMessagesById.set(issueId, []);
  }

  return issueMessagesById.get(issueId);
}

function pushIssueMessage(issueId, message) {
  const issue = issueCardsById.get(issueId);
  const messages = ensureIssueMessages(issueId);
  messages.push({
    id: randomUUID(),
    timestamp: now(),
    root_thread_id: getRootThreadIdForIssue(issue),
    physical_thread_id:
      message.physical_thread_id ??
      issue?.executed_physical_thread_id ??
      issue?.created_physical_thread_id ??
      null,
    message_class: message.message_class ?? message.role ?? "system",
    ...message
  });
  return messages;
}

function isVisibleIssueMessage(message) {
  return !message?.deleted_at && message?.kind !== "handoff_summary";
}

function listStoredIssueMessages(issueId) {
  return [...(issueMessagesById.get(issueId) ?? [])].filter((message) => !message.deleted_at);
}

function appendAssistantDeltaToIssue(issueId, delta = "", physicalThreadId = null) {
  const issue = issueCardsById.get(issueId);
  const messages = ensureIssueMessages(issueId);
  const lastMessage = messages.at(-1);
  const resolvedPhysicalThreadId =
    physicalThreadId ?? issue?.executed_physical_thread_id ?? issue?.created_physical_thread_id ?? null;

  if (lastMessage?.role === "assistant" && (lastMessage.physical_thread_id ?? null) === resolvedPhysicalThreadId) {
    lastMessage.content = `${lastMessage.content ?? ""}${delta}`;
    lastMessage.timestamp = now();
    return;
  }

  messages.push({
    id: randomUUID(),
    root_thread_id: getRootThreadIdForIssue(issue),
    physical_thread_id: resolvedPhysicalThreadId,
    role: "assistant",
    kind: "message",
    message_class: "assistant",
    content: String(delta ?? ""),
    timestamp: now()
  });
}

function findLatestAssistantMessage(issueId, physicalThreadId = null) {
  const messages = ensureIssueMessages(issueId);

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];

    if (candidate?.deleted_at || candidate?.role !== "assistant") {
      continue;
    }

    if (
      physicalThreadId !== null &&
      (candidate.physical_thread_id ?? null) !== physicalThreadId
    ) {
      continue;
    }

    return candidate;
  }

  return null;
}

function syncAssistantSnapshotToIssue(issueId, fullText = "", physicalThreadId = null) {
  const issue = issueCardsById.get(issueId) ?? null;
  const normalizedText = String(fullText ?? "");
  const resolvedPhysicalThreadId =
    physicalThreadId ?? issue?.executed_physical_thread_id ?? issue?.created_physical_thread_id ?? null;

  if (!normalizedText) {
    return {
      changed: false,
      appendedDelta: "",
      replaced: false,
      content: ""
    };
  }

  const lastAssistantMessage = findLatestAssistantMessage(issueId, resolvedPhysicalThreadId);

  if (!lastAssistantMessage) {
    pushIssueMessage(issueId, {
      role: "assistant",
      kind: "message",
      message_class: "assistant",
      content: normalizedText,
      physical_thread_id: resolvedPhysicalThreadId
    });
    return {
      changed: true,
      appendedDelta: normalizedText,
      replaced: false,
      content: normalizedText
    };
  }

  const currentText = String(lastAssistantMessage.content ?? "");

  if (currentText === normalizedText) {
    return {
      changed: false,
      appendedDelta: "",
      replaced: false,
      content: normalizedText,
      ignoredStaleSnapshot: false
    };
  }

  const shouldIgnoreStaleSnapshot =
    Boolean(currentText) &&
    (
      currentText.startsWith(normalizedText) ||
      currentText.length > normalizedText.length
    );

  if (shouldIgnoreStaleSnapshot) {
    return {
      changed: false,
      appendedDelta: "",
      replaced: false,
      content: currentText,
      ignoredStaleSnapshot: true
    };
  }

  lastAssistantMessage.content = normalizedText;
  lastAssistantMessage.timestamp = now();

  if (normalizedText.startsWith(currentText)) {
    return {
      changed: true,
      appendedDelta: normalizedText.slice(currentText.length),
      replaced: false,
      content: normalizedText,
      ignoredStaleSnapshot: false
    };
  }

  return {
    changed: true,
    appendedDelta: "",
    replaced: true,
    content: normalizedText,
    ignoredStaleSnapshot: false
  };
}

function listIssueMessages(issueId) {
  return listStoredIssueMessages(issueId).filter(isVisibleIssueMessage);
}

function listHandoffSummariesForThread(rootThreadId) {
  return [...handoffSummariesById.values()]
    .filter((summary) => summary.root_thread_id === rootThreadId && !summary.deleted_at)
    .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));
}

function updateProjectThreadSnapshot(threadId) {
  const thread = threadStateById.get(threadId);

  if (!thread) {
    return null;
  }

  const issueIds = getThreadIssueIds(threadId);
  const issues = issueIds
    .map((issueId) => issueCardsById.get(issueId))
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
  const activeIssueId = activeIssueByThreadId.get(threadId);
  const activeIssue = activeIssueId ? issueCardsById.get(activeIssueId) : null;
  const queuedCount = ensurePendingQueue(threadId).length;
  const latestIssue = issues[0] ?? null;

  const nextStatus = activeIssue
    ? activeIssue.status
    : queuedCount > 0
      ? "queued"
      : latestIssue?.status === "running"
        ? "running"
      : latestIssue?.status === "completed"
        ? "completed"
        : latestIssue?.status === "failed"
          ? "failed"
          : latestIssue?.status === "awaiting_input"
            ? "awaiting_input"
            : "idle";

  const nextThread = {
    ...thread,
    status: nextStatus,
    progress: activeIssue?.progress ?? latestIssue?.progress ?? 0,
    last_event: activeIssue?.last_event ?? latestIssue?.last_event ?? thread.last_event,
    last_message: activeIssue?.last_message ?? latestIssue?.last_message ?? thread.last_message,
    updated_at: latestIssue?.updated_at ?? thread.updated_at
  };

  threadStateById.set(threadId, nextThread);
  return syncRootThreadFromActivePhysicalThread(threadId) ?? nextThread;
}

function ensureDefaultProjectThread(loginId, projectId, preferredName = "Main") {
  const normalized = sanitizeUserId(loginId);
  const state = users.get(normalized);
  const existing = [...(state?.threadIds ?? [])]
    .map((threadId) => threadStateById.get(threadId))
    .find((thread) => thread?.project_id === projectId && !thread?.deleted_at);

  if (existing?.id) {
    return existing.id;
  }

  const threadId = createThreadEntityId();
  const thread = normalizeProjectThread(normalized, {
    id: threadId,
    project_id: projectId,
    name: preferredName,
    status: "idle",
    last_event: "thread.created",
    created_at: now(),
    updated_at: now()
  });

  threadStateById.set(threadId, thread);
  threadOwners.set(threadId, normalized);
  state?.threadIds.add(threadId);
  getThreadIssueIds(threadId);
  ensureRootThreadPhysicalStructure(normalized, threadId);
  persistThreadById(threadId);
  return threadId;
}

function listProjectThreads(userId, projectId = "") {
  const state = ensureUserState(userId);
  const items = [...state.threadIds]
    .map((threadId) => updateProjectThreadSnapshot(threadId) ?? threadStateById.get(threadId))
    .filter(Boolean)
    .filter((thread) => !thread.deleted_at)
    .filter((thread) => !projectId || thread.project_id === projectId)
    .map((thread) => ({
      ...thread,
      issue_count: getThreadIssueIds(thread.id).length,
      queued_count: ensurePendingQueue(thread.id).length
    }))
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));

  return items;
}

function listThreadIssues(threadId) {
  return getThreadIssueIds(threadId)
    .map((issueId) => issueCardsById.get(issueId))
    .filter(Boolean)
    .filter((issue) => !issue.deleted_at)
    .sort((left, right) => {
      if (left.status === "staged" && right.status === "staged") {
        const leftHasOrder = Number.isFinite(left.prep_position);
        const rightHasOrder = Number.isFinite(right.prep_position);

        if (leftHasOrder && rightHasOrder && left.prep_position !== right.prep_position) {
          return left.prep_position - right.prep_position;
        }

        if (leftHasOrder && !rightHasOrder) {
          return -1;
        }

        if (!leftHasOrder && rightHasOrder) {
          return 1;
        }
      }

      const leftQueueOrder = left.queue_position ?? Number.MAX_SAFE_INTEGER;
      const rightQueueOrder = right.queue_position ?? Number.MAX_SAFE_INTEGER;

      if (left.status === "queued" && right.status === "queued" && leftQueueOrder !== rightQueueOrder) {
        return leftQueueOrder - rightQueueOrder;
      }

      return Date.parse(right.updated_at) - Date.parse(left.updated_at);
    });
}

function serializeIssueForClient(issue) {
  const normalized = normalizeIssueCard(issue);

  if (!normalized) {
    return null;
  }

  return {
    ...normalized,
    attachments: serializeIssueAttachmentsForClient(normalized.attachments)
  };
}

function listThreadIssuesForClient(threadId) {
  return listThreadIssues(threadId)
    .map((issue) => serializeIssueForClient(issue))
    .filter(Boolean);
}

function listThreadTimeline(threadId) {
  const issues = listThreadIssues(threadId)
    .slice()
    .sort((left, right) => {
      const leftSequence =
        physicalThreadStateById.get(left.executed_physical_thread_id ?? left.created_physical_thread_id ?? "")?.sequence ??
        Number.MAX_SAFE_INTEGER;
      const rightSequence =
        physicalThreadStateById.get(right.executed_physical_thread_id ?? right.created_physical_thread_id ?? "")?.sequence ??
        Number.MAX_SAFE_INTEGER;

      if (leftSequence !== rightSequence) {
        return leftSequence - rightSequence;
      }

      return Date.parse(left.created_at) - Date.parse(right.created_at);
    });

  const issueTimelineEntries = issues
    .flatMap((issue) =>
      listStoredIssueMessages(issue.id).map((message, index) => ({
        ...message,
        id: message.id ?? `${issue.id}-${index}`,
        issue_id: issue.id,
        issue_title: issue.title,
        issue_status: issue.status,
        physical_sequence:
          physicalThreadStateById.get(message.physical_thread_id ?? issue.executed_physical_thread_id ?? "")?.sequence ??
          null
      }))
    );
  const handoffTimelineEntries = listHandoffSummariesForThread(threadId).map((summary) => ({
    id: summary.id,
    kind: "handoff_summary",
    role: "system",
    message_class: "system",
    content: summary.content_markdown,
    timestamp: summary.created_at,
    created_at: summary.created_at,
    root_thread_id: summary.root_thread_id,
    physical_thread_id: summary.target_physical_thread_id,
    physical_sequence:
      physicalThreadStateById.get(summary.target_physical_thread_id ?? "")?.sequence ?? null
  }));

  return [...issueTimelineEntries, ...handoffTimelineEntries]
    .sort((left, right) => {
      const leftSequence = Number(left.physical_sequence ?? Number.MAX_SAFE_INTEGER);
      const rightSequence = Number(right.physical_sequence ?? Number.MAX_SAFE_INTEGER);

      if (leftSequence !== rightSequence) {
        return leftSequence - rightSequence;
      }

      return Date.parse(left.timestamp ?? 0) - Date.parse(right.timestamp ?? 0);
    });
}

function getThreadContinuity(userId, rootThreadId) {
  const normalizedUserId = sanitizeUserId(userId);
  const rootThread = threadStateById.get(rootThreadId);

  if (!rootThread || rootThread.deleted_at || threadOwners.get(rootThreadId) !== normalizedUserId) {
    return {
      root_thread: null,
      physical_threads: [],
      active_physical_thread: null,
      handoff_summaries: [],
      recently_closed_physical_threads: []
    };
  }

  pruneRecentlyClosedPhysicalThreads(rootThreadId);

  return {
    root_thread: rootThread,
    physical_threads: listPhysicalThreads(rootThreadId).filter((physicalThread) => !physicalThread.deleted_at),
    active_physical_thread: getActivePhysicalThread(rootThreadId),
    handoff_summaries: listHandoffSummariesForThread(rootThreadId),
    recently_closed_physical_threads: recentlyClosedPhysicalThreadIdsByRootThreadId.get(rootThreadId) ?? []
  };
}

function resolveWorkspaceRoots() {
  const configured = String(process.env.OCTOP_WORKSPACE_ROOTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => resolve(value));

  const roots = configured.length > 0 ? configured : [process.cwd()];
  return [...new Set(roots)];
}

function listWorkspaceRoots(userId) {
  const state = ensureUserState(userId);

  return WORKSPACE_ROOTS.map((rootPath) => {
    const registeredProject = state.projects.find((project) => project.workspace_path === rootPath);

    return {
      name: basename(rootPath) || rootPath,
      path: rootPath,
      is_workspace: canUseAsWorkspace(rootPath),
      is_registered: Boolean(registeredProject),
      project_id: registeredProject?.id ?? null
    };
  });
}

function isAllowedWorkspacePath(targetPath) {
  const normalizedTargetPath = resolve(String(targetPath));

  return WORKSPACE_ROOTS.some((rootPath) => {
    const normalizedRootPath = resolve(String(rootPath));

    if (normalizedTargetPath === normalizedRootPath) {
      return true;
    }

    const relativePath = relative(normalizedRootPath, normalizedTargetPath);
    return Boolean(relativePath) && !relativePath.startsWith("..") && !isAbsolute(relativePath);
  });
}

function resolveBrowsePath(rawPath = "") {
  const targetPath = rawPath ? resolve(String(rawPath)) : WORKSPACE_ROOTS[0];

  if (!isAllowedWorkspacePath(targetPath)) {
    throw new Error("허용되지 않은 경로입니다.");
  }

  if (!existsSync(targetPath)) {
    throw new Error("경로를 찾을 수 없습니다.");
  }

  return targetPath;
}

function listFoldersForUser(userId, rawPath = "") {
  const state = ensureUserState(userId);
  const path = resolveBrowsePath(rawPath);
  const entries = safeListDirectories(path).map((entryPath) => {
    const registeredProject = state.projects.find((project) => project.workspace_path === entryPath);

    return {
      name: basename(entryPath) || entryPath,
      path: entryPath,
      is_workspace: canUseAsWorkspace(entryPath),
      is_registered: Boolean(registeredProject),
      project_id: registeredProject?.id ?? null
    };
  });
  const parentPath = WORKSPACE_ROOTS.find((rootPath) => rootPath === path)
    ? null
    : dirname(path);

  return {
    path,
    parent_path: parentPath && isAllowedWorkspacePath(parentPath) ? parentPath : null,
    entries
  };
}

function buildProjectId(loginId, workspacePath) {
  const digest = createHash("sha1")
    .update(`${sanitizeUserId(loginId)}:${workspacePath}`)
    .digest("hex")
    .slice(0, 10);

  return sanitizeBridgeId(`${BRIDGE_ID}-${digest}`);
}

function canUseAsWorkspace(path) {
  return (
    existsSync(resolve(path, ".git")) ||
    existsSync(resolve(path, "package.json")) ||
    existsSync(resolve(path, "pnpm-workspace.yaml")) ||
    hasSolutionFile(path) ||
    existsSync(resolve(path, "AGENTS.md"))
  );
}

function safeListDirectories(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => resolve(path, entry.name));
  } catch {
    return [];
  }
}

function hasSolutionFile(path) {
  try {
    return readdirSync(path).some((entry) => entry.endsWith(".sln"));
  } catch {
    return false;
  }
}

function discoverProjectsForUser(loginId, deletedWorkspacePaths = []) {
  const blockedPaths = new Set(
    deletedWorkspacePaths
      .map((value) => resolve(String(value)))
  );
  const discovered = [];

  for (const root of WORKSPACE_ROOTS) {
    const candidates = [root, ...safeListDirectories(root)];

    for (const candidate of candidates) {
      if (blockedPaths.has(candidate)) {
        continue;
      }

      if (!canUseAsWorkspace(candidate)) {
        continue;
      }

      const name = basename(candidate) || `${sanitizeUserId(loginId)} project`;
      discovered.push(
        normalizeProject(loginId, {
          id: buildProjectId(loginId, candidate),
          key: name,
          name,
          description: `${candidate} 워크스페이스`,
          workspace_path: candidate,
          source: "workspace"
        })
      );
    }
  }

  return dedupeProjects(discovered);
}

function dedupeProjects(projects) {
  const seen = new Set();
  const result = [];

  for (const project of projects) {
    const key = project.workspace_path
      ? `path:${project.workspace_path}`
      : `id:${project.id}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(project);
  }

  return result;
}

function mergeProjects(currentProjects, discoveredProjects) {
  const mergedById = new Map();
  const discoveredByPath = new Map(
    discoveredProjects
      .filter((project) => project.workspace_path)
      .map((project) => [project.workspace_path, project])
  );

  for (const project of currentProjects) {
    const normalized = normalizeProject(project.owner_login_id ?? BRIDGE_OWNER_LOGIN_ID, project);
    const discovered = normalized.workspace_path
      ? discoveredByPath.get(normalized.workspace_path)
      : null;

    mergedById.set(normalized.id, {
      ...normalized,
      ...(discovered
        ? {
            key: normalized.key || discovered.key,
            name: normalized.name || discovered.name,
            description: normalized.description || discovered.description,
            source: discovered.source,
            updated_at: discovered.updated_at
          }
        : {})
    });
  }

  for (const project of discoveredProjects) {
    if (![...mergedById.values()].some((current) => current.workspace_path === project.workspace_path)) {
      mergedById.set(project.id, project);
    }
  }

  return [...mergedById.values()].sort((left, right) => left.name.localeCompare(right.name, "ko-KR"));
}

function hasProjectSetChanged(left, right) {
  return JSON.stringify(left) !== JSON.stringify(right);
}

function readProjectStorage() {
  if (!existsSync(PROJECT_STATE_PATH)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(PROJECT_STATE_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeProjectStorage(payload) {
  mkdirSync(dirname(PROJECT_STATE_PATH), { recursive: true });
  writeFileSync(PROJECT_STATE_PATH, JSON.stringify(payload, null, 2), "utf8");
}

function persistUserProjects(loginId, projects, deletedWorkspacePaths = []) {
  const storage = readProjectStorage();
  storage[loginId] = {
    projects,
    deleted_workspace_paths: [...new Set(deletedWorkspacePaths.map((value) => resolve(String(value))))],
    updated_at: now()
  };
  writeProjectStorage(storage);
}

async function createProject(loginId, payload = {}) {
  const state = ensureUserState(loginId);
  const name = String(payload.name ?? "").trim();
  const requestedKey = String(payload.key ?? "").trim();

  if (!name) {
    throw new Error("프로젝트 이름이 필요합니다.");
  }

  const workspacePath = resolveWorkspaceFromPayload(loginId, payload);

  const project = normalizeProject(loginId, {
    id:
      payload.id ??
      (workspacePath
        ? buildProjectId(loginId, workspacePath)
        : `${BRIDGE_ID}-${sanitizeUserId(loginId)}-${randomUUID().slice(0, 8)}`),
    key: requestedKey || name,
    name,
    description: payload.description ?? "",
    workspace_path: workspacePath,
    source: "workspace"
  });

  const keyExists = state.projects.some((item) => item.key === project.key);
  const nameExists = state.projects.some((item) => item.name === project.name);
  const pathExists = state.projects.some((item) => item.workspace_path === project.workspace_path);

  if (pathExists) {
    throw new Error("선택한 workspace는 이미 프로젝트로 등록되어 있습니다.");
  }

  if (keyExists || nameExists) {
    throw new Error("같은 이름 또는 key의 프로젝트가 이미 있습니다.");
  }

  state.projects = [project, ...state.projects];
  state.deletedWorkspacePaths = state.deletedWorkspacePaths.filter((value) => value !== project.workspace_path);
  state.updated_at = now();
  persistUserProjects(loginId, state.projects, state.deletedWorkspacePaths);
  await publishEvent(loginId, "bridge.projects.updated", { projects: state.projects });

  return {
    accepted: true,
    project,
    projects: state.projects
  };
}

async function updateProject(loginId, payload = {}) {
  const state = ensureUserState(loginId);
  const projectId = String(payload.project_id ?? payload.projectId ?? "").trim();
  const hasNameUpdate = payload.name !== undefined && payload.name !== null;
  const hasBaseInstructionsUpdate =
    Object.prototype.hasOwnProperty.call(payload, "update_base_instructions") &&
    Boolean(payload.update_base_instructions);
  const hasDeveloperInstructionsUpdate =
    Object.prototype.hasOwnProperty.call(payload, "update_developer_instructions") &&
    Boolean(payload.update_developer_instructions);
  const name = String(payload.name ?? "").trim();

  if (!projectId) {
    throw new Error("변경할 프로젝트 id가 필요합니다.");
  }

  if (!hasNameUpdate && !hasBaseInstructionsUpdate && !hasDeveloperInstructionsUpdate) {
    throw new Error("변경할 프로젝트 값이 필요합니다.");
  }

  if (hasNameUpdate && !name) {
    throw new Error("프로젝트 이름이 필요합니다.");
  }

  const projectIndex = state.projects.findIndex((item) => item.id === projectId);

  if (projectIndex === -1) {
    throw new Error("프로젝트를 찾을 수 없습니다.");
  }

  const duplicateName = hasNameUpdate
    ? state.projects.some(
        (item, index) => index !== projectIndex && item.name.trim().toLowerCase() === name.toLowerCase()
      )
    : false;

  if (duplicateName) {
    throw new Error("같은 이름의 프로젝트가 이미 있습니다.");
  }

  const currentProject = state.projects[projectIndex];
  const updatedProject = {
    ...currentProject,
    ...(hasNameUpdate ? { name } : {}),
    ...(hasBaseInstructionsUpdate
      ? {
          base_instructions: normalizeInstructionText(
            payload.base_instructions ?? payload.baseInstructions
          )
        }
      : {}),
    ...(hasDeveloperInstructionsUpdate
      ? {
          developer_instructions: normalizeInstructionText(
            payload.developer_instructions ?? payload.developerInstructions
          )
        }
      : {}),
    updated_at: now()
  };

  state.projects = state.projects.map((project) => (project.id === projectId ? updatedProject : project));
  state.updated_at = now();
  persistUserProjects(loginId, state.projects, state.deletedWorkspacePaths);
  await publishEvent(loginId, "project.updated", { project: updatedProject, project_id: projectId });
  await publishEvent(loginId, "bridge.projects.updated", { projects: state.projects });

  return {
    accepted: true,
    project: updatedProject,
    projects: state.projects
  };
}

function resolveWorkspaceFromPayload(loginId, payload = {}) {
  if (payload.workspace_path) {
    return resolve(String(payload.workspace_path));
  }

  const discoveredProjects = discoverProjectsForUser(loginId);
  const requestedName = String(payload.name ?? "").trim().toLowerCase();
  const requestedKey = String(payload.key ?? payload.name ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_");
  const matchedProject = discoveredProjects.find((project) => {
    return (
      project.name.toLowerCase() === requestedName ||
      project.key === requestedKey
    );
  });

  if (matchedProject?.workspace_path) {
    return matchedProject.workspace_path;
  }

  throw new Error(
    "로컬 workspace를 찾을 수 없습니다. bridge를 workspace 루트에서 실행하거나 OCTOP_WORKSPACE_ROOTS를 설정해 주세요."
  );
}

function listProjectState(userId) {
  return ensureUserState(userId).projects;
}

async function createTodoChat(userId, payload = {}) {
  const normalized = sanitizeUserId(userId);
  const state = ensureUserState(normalized);
  const title = String(payload.title ?? "").trim() || "새 ToDo 채팅";
  const chatId = createTodoChatId();
  const chat = normalizeTodoChat(normalized, {
    id: chatId,
    title
  });

  todoChatsById.set(chatId, chat);
  ensureTodoChatIdsForUser(normalized).add(chatId);
  state.todoChatIds.add(chatId);
  persistTodoChatById(chatId);
  await publishEvent(normalized, "todo.chat.created", { chat });
  await publishEvent(normalized, "bridge.todoChats.updated", {
    chats: listTodoChats(normalized)
  });

  return {
    accepted: true,
    chat,
    chats: listTodoChats(normalized)
  };
}

async function updateTodoChat(userId, payload = {}) {
  const normalized = sanitizeUserId(userId);
  const chatId = String(payload.todo_chat_id ?? payload.todoChatId ?? payload.chat_id ?? payload.chatId ?? "").trim();
  const title = String(payload.title ?? "").trim();

  if (!chatId) {
    throw new Error("수정할 ToDo 채팅 id가 필요합니다.");
  }

  if (!title) {
    throw new Error("ToDo 채팅 이름이 필요합니다.");
  }

  const current = todoChatsById.get(chatId);

  if (!current || current.deleted_at || current.login_id !== normalized) {
    throw new Error("ToDo 채팅을 찾을 수 없습니다.");
  }

  const next = normalizeTodoChat(normalized, {
    ...current,
    title,
    updated_at: now()
  });

  todoChatsById.set(chatId, next);
  persistTodoChatById(chatId);
  await publishEvent(normalized, "todo.chat.updated", { chat: next });
  await publishEvent(normalized, "bridge.todoChats.updated", {
    chats: listTodoChats(normalized)
  });

  return {
    accepted: true,
    chat: next,
    chats: listTodoChats(normalized)
  };
}

async function deleteTodoChat(userId, payload = {}) {
  const normalized = sanitizeUserId(userId);
  const chatId = String(payload.todo_chat_id ?? payload.todoChatId ?? payload.chat_id ?? payload.chatId ?? "").trim();

  if (!chatId) {
    throw new Error("삭제할 ToDo 채팅 id가 필요합니다.");
  }

  const current = todoChatsById.get(chatId);

  if (!current || current.deleted_at || current.login_id !== normalized) {
    throw new Error("ToDo 채팅을 찾을 수 없습니다.");
  }

  const deletedAt = now();
  todoChatsById.set(chatId, {
    ...current,
    deleted_at: deletedAt,
    updated_at: deletedAt
  });

  for (const messageId of getTodoMessageIds(chatId)) {
    const currentMessage = todoMessagesById.get(messageId);

    if (!currentMessage || currentMessage.deleted_at) {
      continue;
    }

    todoMessagesById.set(messageId, {
      ...currentMessage,
      status: currentMessage.status === "moved" ? "moved" : "deleted",
      deleted_at: deletedAt,
      updated_at: deletedAt
    });
  }

  persistTodoChatById(chatId);
  await publishEvent(normalized, "todo.chat.deleted", {
    todo_chat_id: chatId
  });
  await publishEvent(normalized, "bridge.todoChats.updated", {
    chats: listTodoChats(normalized)
  });

  return {
    accepted: true,
    todo_chat_id: chatId,
    chats: listTodoChats(normalized)
  };
}

async function createTodoMessage(userId, payload = {}) {
  const normalized = sanitizeUserId(userId);
  const chatId = String(payload.todo_chat_id ?? payload.todoChatId ?? payload.chat_id ?? payload.chatId ?? "").trim();
  const content = String(payload.content ?? "").trim();

  if (!chatId) {
    throw new Error("메시지를 저장할 ToDo 채팅 id가 필요합니다.");
  }

  if (!content) {
    throw new Error("내용을 입력해 주세요.");
  }

  const chat = todoChatsById.get(chatId);

  if (!chat || chat.deleted_at || chat.login_id !== normalized) {
    throw new Error("ToDo 채팅을 찾을 수 없습니다.");
  }

  const message = normalizeTodoMessage(normalized, {
    id: createTodoMessageId(),
    todo_chat_id: chatId,
    content,
    status: "open"
  });

  todoMessagesById.set(message.id, message);
  setTodoMessageIds(chatId, [...getTodoMessageIds(chatId), message.id]);
  syncTodoChatSnapshot(chatId);
  persistTodoChatById(chatId);
  await publishEvent(normalized, "todo.message.created", {
    todo_chat_id: chatId,
    message
  });
  await publishEvent(normalized, "bridge.todoMessages.updated", getTodoMessagesResponse(normalized, chatId));
  await publishEvent(normalized, "bridge.todoChats.updated", {
    chats: listTodoChats(normalized)
  });

  return {
    accepted: true,
    message,
    ...getTodoMessagesResponse(normalized, chatId)
  };
}

async function updateTodoMessage(userId, payload = {}) {
  const normalized = sanitizeUserId(userId);
  const messageId = String(payload.todo_message_id ?? payload.todoMessageId ?? payload.message_id ?? payload.messageId ?? "").trim();
  const content = String(payload.content ?? "").trim();

  if (!messageId) {
    throw new Error("수정할 ToDo 메시지 id가 필요합니다.");
  }

  if (!content) {
    throw new Error("내용을 입력해 주세요.");
  }

  const current = todoMessagesById.get(messageId);

  if (!current || current.deleted_at || current.login_id !== normalized) {
    throw new Error("ToDo 메시지를 찾을 수 없습니다.");
  }

  if (current.status !== "open") {
    throw new Error("이동되지 않은 ToDo 메시지만 수정할 수 있습니다.");
  }

  const next = normalizeTodoMessage(normalized, {
    ...current,
    content,
    updated_at: now()
  });

  todoMessagesById.set(messageId, next);
  syncTodoChatSnapshot(next.todo_chat_id);
  persistTodoChatById(next.todo_chat_id);
  await publishEvent(normalized, "todo.message.updated", {
    todo_chat_id: next.todo_chat_id,
    message: next
  });
  await publishEvent(normalized, "bridge.todoMessages.updated", getTodoMessagesResponse(normalized, next.todo_chat_id));
  await publishEvent(normalized, "bridge.todoChats.updated", {
    chats: listTodoChats(normalized)
  });

  return {
    accepted: true,
    message: next,
    ...getTodoMessagesResponse(normalized, next.todo_chat_id)
  };
}

async function deleteTodoMessage(userId, payload = {}) {
  const normalized = sanitizeUserId(userId);
  const messageId = String(payload.todo_message_id ?? payload.todoMessageId ?? payload.message_id ?? payload.messageId ?? "").trim();

  if (!messageId) {
    throw new Error("삭제할 ToDo 메시지 id가 필요합니다.");
  }

  const current = todoMessagesById.get(messageId);

  if (!current || current.deleted_at || current.login_id !== normalized) {
    throw new Error("ToDo 메시지를 찾을 수 없습니다.");
  }

  const next = normalizeTodoMessage(normalized, {
    ...current,
    status: current.status === "moved" ? "moved" : "deleted",
    deleted_at: current.deleted_at ?? now(),
    updated_at: now()
  });

  todoMessagesById.set(messageId, next);
  syncTodoChatSnapshot(next.todo_chat_id);
  persistTodoChatById(next.todo_chat_id);
  await publishEvent(normalized, "todo.message.deleted", {
    todo_chat_id: next.todo_chat_id,
    todo_message_id: messageId
  });
  await publishEvent(normalized, "bridge.todoMessages.updated", getTodoMessagesResponse(normalized, next.todo_chat_id));
  await publishEvent(normalized, "bridge.todoChats.updated", {
    chats: listTodoChats(normalized)
  });

  return {
    accepted: true,
    todo_message_id: messageId,
    ...getTodoMessagesResponse(normalized, next.todo_chat_id)
  };
}

async function transferTodoMessage(userId, payload = {}) {
  const normalized = sanitizeUserId(userId);
  const messageId = String(payload.todo_message_id ?? payload.todoMessageId ?? payload.message_id ?? payload.messageId ?? "").trim();
  const projectId = String(payload.project_id ?? payload.projectId ?? "").trim();
  const threadMode = String(payload.thread_mode ?? payload.threadMode ?? "").trim().toLowerCase();
  const requestedThreadId = String(payload.thread_id ?? payload.threadId ?? "").trim();
  const requestedThreadName = String(payload.thread_name ?? payload.threadName ?? "").trim();

  if (!messageId) {
    throw new Error("이동할 ToDo 메시지 id가 필요합니다.");
  }

  if (!projectId) {
    throw new Error("이동할 프로젝트 id가 필요합니다.");
  }

  if (!["existing", "new"].includes(threadMode)) {
    throw new Error("thread_mode는 existing 또는 new 여야 합니다.");
  }

  const message = todoMessagesById.get(messageId);

  if (!message || message.deleted_at || message.login_id !== normalized) {
    throw new Error("ToDo 메시지를 찾을 수 없습니다.");
  }

  if (message.status !== "open") {
    throw new Error("이미 이동되었거나 삭제된 ToDo 메시지입니다.");
  }

  const project = ensureUserState(normalized).projects.find((item) => item.id === projectId);

  if (!project) {
    throw new Error("프로젝트를 찾을 수 없습니다.");
  }

  let targetThread = null;

  if (threadMode === "existing") {
    targetThread = threadStateById.get(requestedThreadId) ?? null;

    if (!targetThread || targetThread.deleted_at || threadOwners.get(targetThread.id) !== normalized) {
      throw new Error("대상 thread를 찾을 수 없습니다.");
    }

    if (targetThread.project_id !== projectId) {
      throw new Error("대상 thread가 선택한 프로젝트에 속하지 않습니다.");
    }
  } else {
    const created = await createProjectThread(normalized, {
      project_id: projectId,
      name: requestedThreadName || createIssueTitle({ prompt: message.content })
    });
    targetThread = created.thread;
  }

  const createdIssueResult = await createThreadIssue(normalized, {
    thread_id: targetThread.id,
    title: createIssueTitle({ prompt: message.content }),
    prompt: message.content
  });
  const createdIssue = createdIssueResult?.issue ?? null;
  const createdIssueId = createdIssue?.id ?? null;

  if (!createdIssueId) {
    throw new Error("thread issue를 생성하지 못했습니다.");
  }

  const startResult = await startThreadIssues(normalized, {
    thread_id: targetThread.id,
    issue_ids: [createdIssueId]
  });
  const startedIssue =
    startResult?.issues?.find((issue) => issue.id === createdIssueId) ??
    issueCardsById.get(createdIssueId) ??
    createdIssue;
  targetThread = threadStateById.get(targetThread.id) ?? targetThread;

  const movedMessage = normalizeTodoMessage(normalized, {
    ...message,
    status: "moved",
    moved_to_project_id: projectId,
    moved_to_thread_id: targetThread.id,
    moved_to_issue_id: startedIssue.id,
    updated_at: now()
  });

  todoMessagesById.set(messageId, movedMessage);
  syncTodoChatSnapshot(movedMessage.todo_chat_id);
  persistTodoChatById(movedMessage.todo_chat_id);
  await publishEvent(normalized, "todo.message.transferred", {
    todo_chat_id: movedMessage.todo_chat_id,
    message: movedMessage,
    thread: targetThread,
    issue: startedIssue
  });
  await publishEvent(normalized, "bridge.todoMessages.updated", getTodoMessagesResponse(normalized, movedMessage.todo_chat_id));
  await publishEvent(normalized, "bridge.todoChats.updated", {
    chats: listTodoChats(normalized)
  });

  return {
    accepted: true,
    todo_message: movedMessage,
    thread: targetThread,
    issue: startedIssue
  };
}

function getProjectInstructionOverrides(userId, projectId) {
  if (!projectId) {
    return {};
  }

  const project = ensureUserState(userId).projects.find((item) => item.id === projectId);

  if (!project) {
    return {};
  }

  const baseInstructions = normalizeInstructionText(project.base_instructions);
  const developerInstructions = normalizeInstructionText(project.developer_instructions);

  return {
    ...(baseInstructions ? { baseInstructions } : {}),
    ...(developerInstructions ? { developerInstructions } : {})
  };
}

function mergeDeveloperInstructionTexts(...values) {
  return values
    .map((value) => normalizeInstructionText(value))
    .filter(Boolean)
    .join(" ");
}

function getThreadDeveloperInstruction(userId, threadId) {
  const normalizedThreadId = sanitizeBridgeId(threadId);
  const thread = threadStateById.get(normalizedThreadId);

  if (!thread || threadOwners.get(normalizedThreadId) !== sanitizeUserId(userId)) {
    return "";
  }

  return normalizeInstructionText(thread.developer_instructions);
}

function buildThreadInstructionOverrides(userId, projectId, threadId) {
  const projectOverrides = getProjectInstructionOverrides(userId, projectId);
  try {
    const threadDeveloperInstruction = getThreadDeveloperInstruction(userId, threadId);
    const developerInstructions = mergeDeveloperInstructionTexts(
      projectOverrides.developerInstructions,
      threadDeveloperInstruction
    );

    return {
      ...(projectOverrides.baseInstructions ? { baseInstructions: projectOverrides.baseInstructions } : {}),
      ...(developerInstructions ? { developerInstructions } : {})
    };
  } catch (error) {
    console.warn("[OctOP bridge] thread developer instruction merge failed; falling back to project instructions", {
      user_id: sanitizeUserId(userId),
      project_id: projectId ?? null,
      thread_id: threadId ?? null,
      error: error?.message ?? String(error)
    });
    return projectOverrides;
  }
}

async function createProjectThread(userId, payload = {}) {
  const state = ensureUserState(userId);
  const projectId = String(payload.project_id ?? payload.projectId ?? "").trim();
  const name = String(payload.name ?? "").trim() || "New Thread";

  if (!projectId) {
    throw new Error("thread를 생성할 프로젝트 id가 필요합니다.");
  }

  const project = state.projects.find((item) => item.id === projectId);

  if (!project) {
    throw new Error("프로젝트를 찾을 수 없습니다.");
  }

  const threadId = createThreadEntityId();
  const thread = normalizeProjectThread(userId, {
    id: threadId,
    project_id: projectId,
    name,
    description: payload.description ?? "",
    status: "idle",
    last_event: "thread.created"
  });

  threadStateById.set(threadId, thread);
  threadOwners.set(threadId, sanitizeUserId(userId));
  state.threadIds.add(threadId);
  getThreadIssueIds(threadId);
  const initialPhysicalThread = ensureRootThreadPhysicalStructure(userId, threadId);
  const createdRootThread = threadStateById.get(threadId) ?? thread;
  persistThreadsForUser(userId);
  await publishEvent(userId, "thread.created", { thread: createdRootThread });
  await publishEvent(userId, "rootThread.created", { thread: createdRootThread });
  if (initialPhysicalThread) {
    await publishEvent(userId, "physicalThread.created", {
      root_thread_id: threadId,
      physical_thread: initialPhysicalThread
    });
  }
  await publishEvent(userId, "bridge.projectThreads.updated", {
    scope: "project",
    project_id: projectId,
    threads: listProjectThreads(userId, projectId)
  });

  return {
    accepted: true,
    thread: createdRootThread,
    threads: listProjectThreads(userId, projectId)
  };
}

async function updateProjectThread(userId, payload = {}) {
  const threadId = String(payload.thread_id ?? payload.threadId ?? "").trim();
  const hasNameUpdate = payload.name !== undefined && payload.name !== null;
  const hasDeveloperInstructionsUpdate =
    Object.prototype.hasOwnProperty.call(payload, "update_developer_instructions") &&
    Boolean(payload.update_developer_instructions);
  const name = String(payload.name ?? "").trim();

  if (!threadId) {
    throw new Error("변경할 thread id가 필요합니다.");
  }

  if (!hasNameUpdate && !hasDeveloperInstructionsUpdate) {
    throw new Error("변경할 thread 값이 필요합니다.");
  }

  if (hasNameUpdate && !name) {
    throw new Error("thread 이름이 필요합니다.");
  }

  const current = threadStateById.get(threadId);

  if (!current || threadOwners.get(threadId) !== sanitizeUserId(userId)) {
    throw new Error("thread를 찾을 수 없습니다.");
  }

  const next = {
    ...current,
    ...(hasNameUpdate ? { name } : {}),
    ...(hasDeveloperInstructionsUpdate
      ? {
          developer_instructions: normalizeInstructionText(
            payload.developer_instructions ?? payload.developerInstructions
          )
        }
      : {}),
    updated_at: now()
  };

  threadStateById.set(threadId, next);
  persistThreadById(threadId);
  await publishEvent(userId, "thread.updated", { thread: next });
  await publishEvent(userId, "rootThread.updated", { thread: next });
  await publishEvent(userId, "bridge.projectThreads.updated", {
    scope: "project",
    project_id: next.project_id,
    threads: listProjectThreads(userId, next.project_id)
  });

  return {
    accepted: true,
    thread: next,
    threads: listProjectThreads(userId, next.project_id)
  };
}

async function deleteProjectThread(userId, payload = {}) {
  const threadId = String(payload.thread_id ?? payload.threadId ?? "").trim();

  if (!threadId) {
    throw new Error("삭제할 thread id가 필요합니다.");
  }

  const current = threadStateById.get(threadId);

  if (!current || threadOwners.get(threadId) !== sanitizeUserId(userId)) {
    throw new Error("thread를 찾을 수 없습니다.");
  }

  return deleteRootThreadCascade(userId, threadId, current);
}

async function requestAppServerBestEffort(method, params, timeoutMs = THREAD_DELETE_STOP_TIMEOUT_MS) {
  if (!appServer.connected || !appServer.initialized || appServer.socket?.readyState !== WebSocket.OPEN) {
    return {
      ok: false,
      error: new Error("app-server not connected")
    };
  }

  const requestPromise = appServer.requestInternal(method, params);
  requestPromise.catch(() => {});

  try {
    const response = await Promise.race([
      requestPromise,
      sleep(timeoutMs).then(() => {
        throw new Error(`${method} timed out`);
      })
    ]);

    return {
      ok: true,
      response
    };
  } catch (error) {
    return {
      ok: false,
      error
    };
  }
}

async function interruptThreadExecutionBestEffort(rootThread, options = {}) {
  const activePhysicalThread = rootThread?.id ? getActivePhysicalThread(rootThread.id) : null;
  const codexThreadId = String(activePhysicalThread?.codex_thread_id ?? rootThread?.codex_thread_id ?? "").trim();
  const turnId =
    rootThread?.id
      ? getTrackedExecutionTurnId(rootThread.id, activePhysicalThread?.id ?? null)
      : String(activePhysicalThread?.turn_id ?? rootThread?.turn_id ?? "").trim() || null;
  const timeoutMs = Number(options.timeoutMs ?? THREAD_DELETE_STOP_TIMEOUT_MS);
  const errors = [];

  if (!codexThreadId) {
    return {
      ok: false,
      interrupted: false,
      stoppedRealtime: false,
      errors: ["codex thread not bound"]
    };
  }

  let interrupted = false;
  let stoppedRealtime = false;

  if (turnId) {
    const interruptResult = await requestAppServerBestEffort(
      "turn/interrupt",
      {
        threadId: codexThreadId,
        turnId
      },
      timeoutMs
    );

    interrupted = interruptResult.ok;

    if (!interruptResult.ok) {
      errors.push(`turn/interrupt: ${interruptResult.error?.message ?? "unknown error"}`);
    }
  }

  const realtimeStopResult = await requestAppServerBestEffort(
    "thread/realtime/stop",
    {
      threadId: codexThreadId
    },
    timeoutMs
  );

  stoppedRealtime = realtimeStopResult.ok;

  if (!realtimeStopResult.ok) {
    errors.push(`thread/realtime/stop: ${realtimeStopResult.error?.message ?? "unknown error"}`);
  }

  return {
    ok: errors.length === 0,
    interrupted,
    stoppedRealtime,
    errors
  };
}

async function readThreadSnapshotBestEffort(codexThreadId, reason = "unspecified", timeoutMs = THREAD_DELETE_STOP_TIMEOUT_MS) {
  if (!String(codexThreadId ?? "").trim()) {
    return {
      ok: false,
      thread: null,
      error: new Error("codex thread not bound")
    };
  }

  const readResult = await requestAppServerBestEffort(
    "thread/read",
    {
      threadId: codexThreadId,
      includeTurns: true
    },
    timeoutMs
  );

  if (!readResult.ok) {
    return {
      ok: false,
      thread: null,
      error: readResult.error
    };
  }

  const remoteThread = readResult.response?.result?.thread ?? readResult.response?.thread ?? null;

  if (!remoteThread) {
    return {
      ok: false,
      thread: null,
      error: new Error(`thread/read.${reason} 응답에 thread가 없습니다.`)
    };
  }

  return {
    ok: true,
    thread: remoteThread,
    error: null
  };
}

async function verifyThreadStopState(rootThread, options = {}) {
  const activePhysicalThread = rootThread?.id ? getActivePhysicalThread(rootThread.id) : null;
  const codexThreadId = String(activePhysicalThread?.codex_thread_id ?? rootThread?.codex_thread_id ?? "").trim();
  const expectedTurnId =
    rootThread?.id
      ? getTrackedExecutionTurnId(rootThread.id, activePhysicalThread?.id ?? null)
      : String(activePhysicalThread?.turn_id ?? rootThread?.turn_id ?? "").trim() || null;
  const timeoutMs = Number(options.timeoutMs ?? THREAD_DELETE_STOP_TIMEOUT_MS);
  const reason = String(options.reason ?? "manual_stop").trim() || "manual_stop";

  if (!codexThreadId) {
    return {
      ok: false,
      verifiedStopped: false,
      remoteStatus: null,
      remoteTurnId: null,
      error: "codex thread not bound"
    };
  }

  const readResult = await readThreadSnapshotBestEffort(codexThreadId, reason, timeoutMs);

  if (!readResult.ok) {
    return {
      ok: false,
      verifiedStopped: false,
      remoteStatus: null,
      remoteTurnId: null,
      error: readResult.error?.message ?? "thread/read failed"
    };
  }

  const remoteThread = readResult.thread;
  const remoteTurn = selectRemoteTurnForBackfill(remoteThread, expectedTurnId);
  const remoteStatus = normalizeRemoteTurnRuntimeStatus(
    remoteThread,
    remoteTurn,
    rootThread?.status ?? "running"
  );

  return {
    ok: true,
    verifiedStopped: !["running", "awaiting_input"].includes(remoteStatus),
    remoteStatus,
    remoteTurnId: remoteTurn?.id ?? null,
    error: null
  };
}

async function stopProjectThreadExecutionForDelete(thread) {
  const stopResult = await interruptThreadExecutionBestEffort(thread);

  if (stopResult.errors.includes("codex thread not bound")) {
    return;
  }

  if (stopResult.errors.length > 0) {
    const activePhysicalThread = thread?.id ? getActivePhysicalThread(thread.id) : null;
    const codexThreadId = String(activePhysicalThread?.codex_thread_id ?? thread?.codex_thread_id ?? "").trim();
    console.warn("[OctOP bridge] thread delete proceeded after stop attempt errors", {
      ...buildLogContext({
        root_thread_id: thread.id,
        codex_thread_id: codexThreadId,
        event_type: "rootThread.delete.stopBestEffort.failed"
      }),
      errors: stopResult.errors
    });
  }
}

async function stopActivePhysicalThreadBestEffort(rootThreadId) {
  const rootThread = threadStateById.get(rootThreadId);

  if (!rootThread) {
    return;
  }

  await stopProjectThreadExecutionForDelete(rootThread);
}

function softDeleteRootThreadState(rootThreadId) {
  const rootThread = threadStateById.get(rootThreadId);

  if (!rootThread) {
    return null;
  }

  const nextRootThread = {
    ...rootThread,
    deleted_at: rootThread.deleted_at ?? now(),
    continuity_status: "deleted",
    updated_at: now()
  };

  threadStateById.set(rootThreadId, nextRootThread);
  return nextRootThread;
}

function deleteRootThreadIssues(rootThreadId) {
  const issueIds = [...getThreadIssueIds(rootThreadId)];

  for (const issueId of issueIds) {
    const currentIssue = issueCardsById.get(issueId);

    if (!currentIssue) {
      continue;
    }

    issueCardsById.set(issueId, {
      ...currentIssue,
      deleted_at: currentIssue.deleted_at ?? now(),
      updated_at: now()
    });
  }

  return issueIds;
}

function deleteRootThreadMessages(rootThreadId, issueIds = getThreadIssueIds(rootThreadId)) {
  for (const issueId of issueIds) {
    const issueMessages = issueMessagesById.get(issueId) ?? [];
    issueMessagesById.set(
      issueId,
      issueMessages.map((message) => ({
        ...message,
        deleted_at: message.deleted_at ?? now()
      }))
    );
  }
}

function deleteRootThreadSummaries(rootThreadId) {
  let deletedCount = 0;

  for (const [summaryId, summary] of handoffSummariesById.entries()) {
    if (summary.root_thread_id !== rootThreadId) {
      continue;
    }

    handoffSummariesById.set(summaryId, {
      ...summary,
      deleted_at: summary.deleted_at ?? now()
    });
    deletedCount += 1;
  }

  return deletedCount;
}

function buildThreadIssuesResponse(userId, rootThreadId) {
  return {
    thread: threadStateById.get(rootThreadId) ?? null,
    issues: listThreadIssuesForClient(rootThreadId),
    continuity: getThreadContinuity(userId, rootThreadId)
  };
}

async function deleteRootThreadCascade(userId, rootThreadId, currentRootThread = threadStateById.get(rootThreadId)) {
  const rootThread = currentRootThread ?? threadStateById.get(rootThreadId);
  const deleteStartedAtMs = Date.now();

  if (!rootThread) {
    throw new Error("thread를 찾을 수 없습니다.");
  }

  const physicalThreads = listPhysicalThreads(rootThreadId);
  const issueIds = [...getThreadIssueIds(rootThreadId)];
  const existingLock = rolloverLocksByRootThreadId.get(rootThreadId);

  if (existingLock) {
    throw new Error("현재 thread는 다른 연속성 작업이 진행 중입니다.");
  }

  rolloverLocksByRootThreadId.set(rootThreadId, {
    root_thread_id: rootThreadId,
    started_at: now(),
    reason: "delete"
  });

  try {
    console.info("[OctOP bridge] root thread delete started", {
      ...buildLogContext({
        root_thread_id: rootThreadId,
        physical_thread_id: rootThread.active_physical_thread_id ?? null,
        event_type: "rootThread.delete.started"
      }),
      physical_thread_count: physicalThreads.length,
      issue_count: issueIds.length
    });

    markRootThreadDeletedForEventDrop(rootThreadId);
    softDeleteRootThreadState(rootThreadId);
    await stopActivePhysicalThreadBestEffort(rootThreadId);
    await Promise.all(
      issueIds.map((issueId) =>
        cleanupIssueAttachmentResources(issueId, {
          attachments: issueCardsById.get(issueId)?.attachments ?? [],
          removeRemote: true,
          forgetIssue: true
        })
      )
    );

    for (const physicalThread of physicalThreads) {
      const deletedPhysicalThread = {
        ...physicalThread,
        deleted_at: physicalThread.deleted_at ?? now(),
        closed_at: physicalThread.closed_at ?? now(),
        status: "deleted",
        updated_at: now()
      };

      physicalThreadStateById.set(physicalThread.id, deletedPhysicalThread);
      markPhysicalThreadClosedForEventDrop(physicalThread.id);

      if (deletedPhysicalThread.codex_thread_id) {
        codexThreadToPhysicalThreadId.delete(deletedPhysicalThread.codex_thread_id);
        codexThreadToThreadId.delete(deletedPhysicalThread.codex_thread_id);
      }

      activeIssueByPhysicalThreadId.delete(physicalThread.id);
    }

    deleteRootThreadIssues(rootThreadId);
    deleteRootThreadMessages(rootThreadId, issueIds);
    deleteRootThreadSummaries(rootThreadId);

    pendingStartQueues.delete(rootThreadId);
    clearRunningIssueTracking(rootThreadId);
    recentlyClosedPhysicalThreadIdsByRootThreadId.delete(rootThreadId);

    persistThreadsForUser(userId);

    await publishEvent(userId, "rootThread.deleted", {
      root_thread_id: rootThreadId,
      thread_id: rootThreadId,
      project_id: rootThread.project_id
    });
    await publishEvent(userId, "thread.deleted", {
      root_thread_id: rootThreadId,
      thread_id: rootThreadId,
      project_id: rootThread.project_id
    });
    await publishEvent(userId, "bridge.projectThreads.updated", {
      scope: "project",
      project_id: rootThread.project_id,
      threads: listProjectThreads(userId, rootThread.project_id)
    });

    console.info("[OctOP bridge] root thread delete completed", {
      ...buildLogContext({
        root_thread_id: rootThreadId,
        event_type: "rootThread.delete.completed"
      }),
      deleted_physical_thread_count: physicalThreads.length,
      deleted_issue_count: issueIds.length
    });
    incrementBridgeMetric("root_thread_delete_total");

    return {
      accepted: true,
      thread_id: rootThreadId,
      deleted_physical_thread_count: physicalThreads.length,
      deleted_issue_count: issueIds.length,
      threads: listProjectThreads(userId, rootThread.project_id)
    };
  } catch (error) {
    incrementBridgeMetric("root_thread_delete_failed_total");
    console.error("[OctOP bridge] root thread delete failed", {
      ...buildLogContext({
        root_thread_id: rootThreadId,
        physical_thread_id: rootThread.active_physical_thread_id ?? null,
        event_type: "rootThread.delete.failed"
      }),
      duration_ms: Date.now() - deleteStartedAtMs,
      error: error.message
    });
    throw error;
  } finally {
    rolloverLocksByRootThreadId.delete(rootThreadId);
  }
}

function getIssueDetail(userId, issueId) {
  const issue = issueCardsById.get(issueId);

  if (!issue || issue.deleted_at) {
    return {
      issue: null,
      messages: []
    };
  }

  const thread = threadStateById.get(issue.thread_id);

  if (!thread || thread.deleted_at || threadOwners.get(thread.id) !== sanitizeUserId(userId)) {
    return {
      issue: null,
      messages: []
    };
  }

  return {
    issue: serializeIssueForClient(issue),
    thread,
    messages: listIssueMessages(issueId)
  };
}

async function createThreadIssue(userId, payload = {}) {
  const threadId = String(payload.thread_id ?? payload.threadId ?? "").trim();
  const prompt = String(payload.prompt ?? "").trim();
  const attachments = normalizeIssueAttachments(payload.attachments);

  if (!threadId) {
    throw new Error("이슈를 등록할 thread가 필요합니다.");
  }

  if (!prompt) {
    throw new Error("프롬프트를 입력해 주세요.");
  }

  const thread = threadStateById.get(threadId);
  const activePhysicalThread = getActivePhysicalThread(threadId);

  if (!thread || thread.deleted_at || threadOwners.get(threadId) !== sanitizeUserId(userId)) {
    throw new Error("thread를 찾을 수 없습니다.");
  }

  const issue = normalizeIssueCard({
    id: createIssueCardId(),
    project_id: thread.project_id,
    thread_id: threadId,
    root_thread_id: threadId,
    created_physical_thread_id: activePhysicalThread?.id ?? null,
    executed_physical_thread_id: null,
    title: createIssueTitle(payload),
    prompt,
    attachments,
    status: "staged",
    prep_position: getNextPrepPosition(threadId),
    progress: 0,
    last_event: "issue.created",
    last_message: "",
    source_app_id: payload.source_app_id ?? payload.sourceAppId ?? null
  });

  issueCardsById.set(issue.id, issue);
  setThreadIssueIds(threadId, [...getThreadIssueIds(threadId), issue.id]);
  pushIssueMessage(issue.id, {
    role: "user",
    kind: "prompt",
    content: prompt
  });
  updateProjectThreadSnapshot(threadId);
  persistThreadById(threadId);
  await publishEvent(userId, "issue.created", {
    issue: serializeIssueForClient(issue),
    thread_id: threadId
  });
  await publishEvent(userId, "bridge.threadIssues.updated", {
    thread_id: threadId,
    issues: listThreadIssuesForClient(threadId)
  });
  await publishEvent(userId, "logicalThread.timeline.updated", {
    root_thread_id: threadId,
    thread_id: threadId,
    entries: listThreadTimeline(threadId)
  });
  await publishEvent(userId, "bridge.projectThreads.updated", {
    scope: "project",
    project_id: thread.project_id,
    threads: listProjectThreads(userId, thread.project_id)
  });

  return {
    accepted: true,
    issue: serializeIssueForClient(issue),
    issues: listThreadIssuesForClient(threadId)
  };
}

async function ensureCodexThreadForProjectThread(userId, threadId) {
  return ensureCodexThreadForActivePhysicalThread(userId, threadId);
}

async function ensureCodexThreadForActivePhysicalThread(userId, rootThreadId, options = {}) {
  const activePhysicalThread = getActivePhysicalThread(rootThreadId);

  if (!activePhysicalThread) {
    throw new Error("active physical thread를 찾을 수 없습니다.");
  }

  return ensureCodexThreadForPhysicalThread(userId, activePhysicalThread.id, options);
}

async function ensureCodexThreadForPhysicalThread(userId, physicalThreadId, options = {}) {
  const physicalThread = physicalThreadStateById.get(physicalThreadId);

  if (!physicalThread) {
    throw new Error("physical thread를 찾을 수 없습니다.");
  }

  if (physicalThread.codex_thread_id) {
    return physicalThread.codex_thread_id;
  }

  const rootThread = threadStateById.get(physicalThread.root_thread_id);
  const cwd = resolveProjectWorkspace(userId, physicalThread.project_id);
  const instructionOverrides = buildThreadInstructionOverrides(
    userId,
    physicalThread.project_id,
    physicalThread.root_thread_id
  );
  const executionPolicy = resolveCodexExecutionPolicyFromOptions(options);
  const reasoningEffort = resolveCodexReasoningEffortFromOptions(options);
  const threadStartParams = {
    cwd,
    ...(executionPolicy.approvalPolicy ? { approvalPolicy: executionPolicy.approvalPolicy } : {}),
    ...(executionPolicy.sandbox ? { sandbox: executionPolicy.sandbox } : {}),
    model: resolveCodexModelFromOptions(options),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    personality: "pragmatic",
    ...instructionOverrides
  };
  await appServer.ensureReady("ensureCodexThreadForPhysicalThread");
  appendDiagnosticLog("info", "app_server.thread_start.params", "thread/start params before app-server request", {
    source: "ensureCodexThreadForPhysicalThread",
    user_id: sanitizeUserId(userId),
    project_id: physicalThread.project_id ?? null,
    root_thread_id: physicalThread.root_thread_id ?? null,
    physical_thread_id: physicalThreadId,
    params: threadStartParams
  });
  const threadResponse = await appServer.request("thread/start", threadStartParams, "thread/start.ensureCodexThreadForPhysicalThread");
  const codexThread = threadResponse.result?.thread;

  if (!codexThread?.id) {
    throw new Error("app-server thread/start 응답에 thread id가 없습니다.");
  }

  const nextPhysicalThread = {
    ...physicalThread,
    codex_thread_id: codexThread.id,
    updated_at: now(),
    last_event: "physicalThread.bound"
  };

  physicalThreadStateById.set(physicalThreadId, nextPhysicalThread);
  codexThreadToPhysicalThreadId.set(codexThread.id, physicalThreadId);
  codexThreadToThreadId.set(codexThread.id, physicalThread.root_thread_id);

  if (rootThread?.active_physical_thread_id === physicalThreadId) {
    activatePhysicalThread(physicalThread.root_thread_id, physicalThreadId);
  }

  persistThreadById(physicalThread.root_thread_id);
  await publishEvent(userId, "physicalThread.bound", {
    root_thread_id: physicalThread.root_thread_id,
    physical_thread: nextPhysicalThread
  });
  await publishEvent(userId, "physicalThread.updated", {
    root_thread_id: physicalThread.root_thread_id,
    physical_thread: nextPhysicalThread
  });
  await publishEvent(userId, "bridge.projectThreads.updated", {
    scope: "project",
    project_id: physicalThread.project_id,
    threads: listProjectThreads(userId, physicalThread.project_id)
  });

  return codexThread.id;
}

function updateIssueCard(issueId, patch = {}) {
  const current = issueCardsById.get(issueId);

  if (!current) {
    return null;
  }

  const next = {
    ...current,
    ...patch,
    id: issueId,
    updated_at: patch.updated_at ?? now()
  };

  issueCardsById.set(issueId, next);

  if (
    current.status !== next.status &&
    ["completed", "failed", "interrupted"].includes(String(next.status ?? "").trim())
  ) {
    void queueIssueAttachmentCleanup(issueId, { removeRemote: true });
  }

  updateProjectThreadSnapshot(next.thread_id);
  persistThreadById(next.thread_id);
  return next;
}

function invalidateCodexThreadBinding(threadId) {
  const rootThread = threadStateById.get(threadId);
  const activePhysicalThread = getActivePhysicalThread(threadId);

  if (!rootThread || !activePhysicalThread) {
    return null;
  }

  if (activePhysicalThread.codex_thread_id) {
    codexThreadToThreadId.delete(activePhysicalThread.codex_thread_id);
    codexThreadToPhysicalThreadId.delete(activePhysicalThread.codex_thread_id);
  }

  const nextPhysicalThread = {
    ...activePhysicalThread,
    codex_thread_id: null,
    updated_at: now(),
    last_event: "physicalThread.binding.invalidated"
  };

  physicalThreadStateById.set(activePhysicalThread.id, nextPhysicalThread);
  const nextRootThread = {
    ...rootThread,
    codex_thread_id: null,
    updated_at: now(),
    last_event: "thread.binding.invalidated"
  };

  threadStateById.set(threadId, nextRootThread);
  persistThreadById(threadId);
  return nextRootThread;
}

function shouldInvalidateCodexThreadBindingForFailure(method, params = {}, issuePatch = null) {
  if (issuePatch?.status !== "failed") {
    return false;
  }

  if (method === "thread/status/changed") {
    return (params.status?.type ?? "") === "error";
  }

  if (method === "turn/completed") {
    return params.turn?.status !== "completed";
  }

  return false;
}

async function startTurnOnPhysicalThread(
  userId,
  rootThreadId,
  physicalThreadId,
  issueId,
  buildPrompt,
  turnStartingEvent = "turn.starting"
) {
  const rootThread = threadStateById.get(rootThreadId);
  const physicalThread = physicalThreadStateById.get(physicalThreadId);
  const issue = issueCardsById.get(issueId);

  if (!rootThread || !physicalThread || !issue) {
    throw new Error("실행할 작업을 찾을 수 없습니다.");
  }

  let preparedIssue = issue;
  let inputPrompt = "";
  let turnInput = [];
  let codexThreadId = null;

  try {
    preparedIssue = await stageIssueAttachmentsForExecution(issueId);
    inputPrompt =
      typeof buildPrompt === "function"
        ? buildPrompt(preparedIssue)
        : String(buildPrompt ?? "").trim();
    turnInput = buildIssueTurnInput(preparedIssue, inputPrompt);
    codexThreadId = await ensureCodexThreadForPhysicalThread(userId, physicalThreadId, {
      issue: preparedIssue
    });
  } catch (error) {
    clearIssueAttachmentStageDirectory(issueId);
    throw error;
  }

  const cwd = resolveProjectWorkspace(userId, rootThread.project_id);
  resetExecutionProjectionForNewIssue(rootThreadId, physicalThreadId, {
    status: "active",
    progress: 10,
    turn_id: null,
    last_event: "turn.starting",
    last_message: ""
  });
  activeIssueByThreadId.set(rootThreadId, issueId);
  activeIssueByPhysicalThreadId.set(physicalThreadId, issueId);
  markRunningIssueActivity(rootThreadId, {
    startedAt: now(),
    lastActivityAt: now(),
    reconcileAttempts: 0,
    missingRemoteAttempts: 0,
    noProgressBackfillCount: 0,
    lastReconciledAt: null,
    lastSeenCodexThreadId: codexThreadId,
    backfillRequestedAt: null,
    backfillTrigger: null,
    backfillLastPolledAt: null,
    backfillLastError: null
  });
  updateIssueCard(issueId, {
    executed_physical_thread_id: physicalThreadId,
    status: "running",
    progress: Math.max(issue.progress ?? 0, 10),
    last_event: "turn.starting",
    last_message: ""
  });
  updateProjectThreadSnapshot(rootThreadId);
  await publishEvent(userId, turnStartingEvent, {
    thread_id: rootThreadId,
    physical_thread_id: physicalThreadId,
    issue_id: issueId
  });
  await publishEvent(userId, "bridge.threadIssues.updated", {
    thread_id: rootThreadId,
    issues: listThreadIssuesForClient(rootThreadId)
  });
  await publishEvent(userId, "logicalThread.timeline.updated", {
    root_thread_id: rootThreadId,
    thread_id: rootThreadId,
    entries: listThreadTimeline(rootThreadId)
  });
  await publishEvent(userId, "bridge.projectThreads.updated", {
    scope: "project",
    project_id: rootThread.project_id,
    threads: listProjectThreads(userId, rootThread.project_id)
  });

  let attempt = 0;
  let activeCodexThreadId = codexThreadId;

  while (attempt < 2) {
    try {
      const activePhysicalThread = physicalThreadStateById.get(physicalThreadId);
      activeCodexThreadId = activePhysicalThread?.codex_thread_id ?? codexThreadId;
      const executionPolicy = resolveCodexExecutionPolicyFromOptions(rootThread);

      const turnStartParams = {
        threadId: activeCodexThreadId,
        cwd,
        ...(executionPolicy.approvalPolicy ? { approvalPolicy: executionPolicy.approvalPolicy } : {}),
        input: turnInput
      };
      appendDiagnosticLog("info", "app_server.turn_start.params", "turn/start params before app-server request", {
        source: "startTurnOnPhysicalThread",
        user_id: sanitizeUserId(userId),
        project_id: rootThread.project_id ?? null,
        root_thread_id: rootThreadId,
        physical_thread_id: physicalThreadId,
        issue_id: issueId,
        codex_thread_id: activeCodexThreadId ?? null,
        params: turnStartParams
      });
      const turnResponse = await appServer.request("turn/start", turnStartParams, "turn/start.startTurnOnPhysicalThread");

      const turn = turnResponse.result?.turn ?? null;
      const currentPhysicalThread = physicalThreadStateById.get(physicalThreadId);

      if (currentPhysicalThread) {
        physicalThreadStateById.set(physicalThreadId, {
          ...currentPhysicalThread,
          status: "active",
          progress: 20,
          turn_id: turn?.id ?? currentPhysicalThread.turn_id ?? null,
          last_event: "turn.started",
          last_message: "",
          updated_at: now()
        });
      }

      updateIssueCard(issueId, {
        executed_physical_thread_id: physicalThreadId,
        status: "running",
        progress: 20,
        last_event: "turn.started"
      });
      updateProjectThreadSnapshot(rootThreadId);
      await publishEvent(userId, "turn.started", {
        thread_id: rootThreadId,
        physical_thread_id: physicalThreadId,
        issue_id: issueId,
        turn
      });
      await publishEvent(userId, "bridge.threadIssues.updated", {
        thread_id: rootThreadId,
        issues: listThreadIssuesForClient(rootThreadId)
      });
      await publishEvent(userId, "logicalThread.timeline.updated", {
        root_thread_id: rootThreadId,
        thread_id: rootThreadId,
        entries: listThreadTimeline(rootThreadId)
      });
      await publishEvent(userId, "bridge.projectThreads.updated", {
        scope: "project",
        project_id: rootThread.project_id,
        threads: listProjectThreads(userId, rootThread.project_id)
      });
      return {
        accepted: true,
        turn
      };
    } catch (error) {
      const threadNotFound = /thread not found/i.test(String(error.message ?? ""));

      if (threadNotFound && attempt === 0) {
        invalidateCodexThreadBinding(rootThreadId);
        await ensureCodexThreadForPhysicalThread(userId, physicalThreadId, {
          issue
        });
        attempt += 1;
        continue;
      }

      clearRunningIssueTracking(rootThreadId);
      activeIssueByPhysicalThreadId.delete(physicalThreadId);
      invalidateCodexThreadBinding(rootThreadId);
      appendDiagnosticLog("error", "turn.start.failed", "turn/start failed on physical thread", {
        user_id: userId,
        root_thread_id: rootThreadId,
        physical_thread_id: physicalThreadId,
        issue_id: issueId,
        attempt,
        active_codex_thread_id: activeCodexThreadId,
        cwd,
        error
      });
      settlePhysicalThreadExecutionState(rootThreadId, {
        issue,
        status: "failed",
        progress: 0,
        lastEvent: "turn.start.failed",
        lastMessage: error.message
      });
      updateIssueCard(issueId, {
        executed_physical_thread_id: physicalThreadId,
        status: "failed",
        progress: 0,
        last_event: "turn.start.failed",
        last_message: error.message
      });
      await publishEvent(userId, "turn.start.failed", {
        thread_id: rootThreadId,
        physical_thread_id: physicalThreadId,
        issue_id: issueId,
        error: error.message
      });
      await publishEvent(userId, "bridge.threadIssues.updated", {
        thread_id: rootThreadId,
        issues: listThreadIssuesForClient(rootThreadId)
      });
      await publishEvent(userId, "logicalThread.timeline.updated", {
        root_thread_id: rootThreadId,
        thread_id: rootThreadId,
        entries: listThreadTimeline(rootThreadId)
      });
      void scheduleQueuedIssuesForUser(userId, {
        preferredThreadId: rootThreadId
      });
      return {
        accepted: false,
        error: error.message
      };
    }
  }

  return {
    accepted: false,
    error: "turn.start did not complete"
  };
}

async function startIssueTurn(userId, threadId, issueId) {
  const preflightRollover = await maybeTriggerContextRollover(
    userId,
    threadId,
    "preflight_threshold",
    {
      issueId,
      requireActiveIssue: false
    }
  );

  if (preflightRollover?.accepted) {
    return;
  }

  const activePhysicalThread = getActivePhysicalThread(threadId);
  const issue = issueCardsById.get(issueId);

  if (!activePhysicalThread || !issue) {
    throw new Error("실행할 작업을 찾을 수 없습니다.");
  }

  return startTurnOnPhysicalThread(
    userId,
    threadId,
    activePhysicalThread.id,
    issueId,
    (preparedIssue) => buildExecutionInputPrompt(preparedIssue ?? issue)
  );
}

async function processIssueQueueOnce(userId, threadId, options = {}) {
  const normalizedThreadId = sanitizeBridgeId(threadId);
  ensureRunningIssueTrackingForThread(normalizedThreadId);

  if (activeIssueByThreadId.has(normalizedThreadId)) {
    return;
  }

  const queue = ensurePendingQueue(normalizedThreadId);
  const nextIssueId = queue.shift();

  if (!nextIssueId) {
    updateProjectThreadSnapshot(normalizedThreadId);
    persistThreadById(normalizedThreadId);
    return;
  }

  refreshIssueQueuePositions(normalizedThreadId);

  try {
    return await startIssueTurn(userId, normalizedThreadId, nextIssueId);
  } catch (error) {
    const issue = issueCardsById.get(nextIssueId) ?? null;
    appendDiagnosticLog("error", "thread.issue.start.pipeline.failed", "issue start pipeline failed", {
      user_id: userId,
      thread_id: normalizedThreadId,
      issue_id: nextIssueId,
      issue_status: issue?.status ?? null,
      queue_snapshot: ensurePendingQueue(normalizedThreadId),
      active_issue_id: activeIssueByThreadId.get(normalizedThreadId) ?? null,
      active_physical_thread_id: threadStateById.get(normalizedThreadId)?.active_physical_thread_id ?? null,
      error
    });
    const shouldRestoreQueue =
      issue &&
      !issue.deleted_at &&
      issue.thread_id === normalizedThreadId &&
      ["queued", "staged"].includes(issue.status ?? "");

    if (shouldRestoreQueue) {
      const nextQueue = ensurePendingQueue(normalizedThreadId);
      if (!nextQueue.includes(nextIssueId)) {
        nextQueue.unshift(nextIssueId);
        refreshIssueQueuePositions(normalizedThreadId);
      }
    }

    if (options.allowRecovery !== false) {
      await normalizeRootThread(userId, normalizedThreadId, {
        reason: "recover_current_execution"
      });

      if (activeIssueByThreadId.has(normalizedThreadId)) {
        return {
          accepted: true,
          recovered: true
        };
      }
    }

    throw error;
  }
}

async function processIssueQueue(userId, threadId, options = {}) {
  const normalizedThreadId = sanitizeBridgeId(threadId);
  const existingState = issueQueueProcessingStateByThreadId.get(normalizedThreadId);

  if (existingState) {
    existingState.rerun = true;
    return existingState.promise;
  }

  const state = {
    rerun: false,
    promise: null
  };

  state.promise = (async () => {
    try {
      let result;

      do {
        state.rerun = false;
        result = await processIssueQueueOnce(userId, normalizedThreadId, options);
      } while (
        state.rerun &&
        !activeIssueByThreadId.has(normalizedThreadId) &&
        ensurePendingQueue(normalizedThreadId).length > 0
      );

      return result;
    } finally {
      if (issueQueueProcessingStateByThreadId.get(normalizedThreadId) === state) {
        issueQueueProcessingStateByThreadId.delete(normalizedThreadId);
      }
    }
  })();
  issueQueueProcessingStateByThreadId.set(normalizedThreadId, state);
  return state.promise;
}

function refreshIssueQueuePositions(threadId) {
  const queue = ensurePendingQueue(threadId);

  for (const issueId of getThreadIssueIds(threadId)) {
    const issue = issueCardsById.get(issueId);

    if (!issue) {
      continue;
    }

    const queueIndex = queue.indexOf(issueId);
    issueCardsById.set(issueId, {
      ...issue,
      queue_position: queueIndex >= 0 ? queueIndex + 1 : null,
      updated_at: queueIndex >= 0 ? now() : issue.updated_at
    });
  }

  updateProjectThreadSnapshot(threadId);
  persistThreadById(threadId);
}

async function startThreadIssues(userId, payload = {}) {
  const threadId = String(payload.thread_id ?? payload.threadId ?? "").trim();
  const requestedIssueIds = Array.isArray(payload.issue_ids) ? payload.issue_ids.map((value) => String(value)) : [];

  if (!threadId) {
    throw new Error("시작할 thread가 필요합니다.");
  }

  const eligibleIssueIds = requestedIssueIds.filter((issueId) => {
    const issue = issueCardsById.get(issueId);
    return issue && !issue.deleted_at && issue.thread_id === threadId && issue.status === "staged";
  });

  if (eligibleIssueIds.length === 0) {
    return {
      accepted: true,
      issues: listThreadIssuesForClient(threadId)
    };
  }

  for (const issueId of eligibleIssueIds) {
    updateIssueCard(issueId, {
      status: "queued",
      progress: 10,
      last_event: "issue.queued",
      prep_position: null
    });
  }

  const queue = ensurePendingQueue(threadId);
  for (const issueId of eligibleIssueIds) {
    if (!queue.includes(issueId)) {
      queue.push(issueId);
    }
  }

  refreshIssueQueuePositions(threadId);
  await publishEvent(userId, "thread.issues.queued", {
    thread_id: threadId,
    issue_ids: eligibleIssueIds
  });
  await publishEvent(userId, "bridge.threadIssues.updated", {
    thread_id: threadId,
    issues: listThreadIssuesForClient(threadId)
  });
  await publishEvent(userId, "logicalThread.timeline.updated", {
    root_thread_id: threadId,
    thread_id: threadId,
    entries: listThreadTimeline(threadId)
  });
  await publishEvent(userId, "bridge.projectThreads.updated", {
    scope: "project",
    project_id: threadStateById.get(threadId)?.project_id ?? null,
    threads: listProjectThreads(userId, threadStateById.get(threadId)?.project_id ?? "")
  });
  await processIssueQueue(userId, threadId);

  return {
    accepted: true,
    blocked_by_thread_id: null,
    issues: listThreadIssuesForClient(threadId)
  };
}

async function reorderThreadIssues(userId, payload = {}) {
  const stage = String(payload.stage ?? "").trim().toLowerCase();

  if (stage === "prep" || stage === "staged") {
    return reorderPrepIssues(userId, payload);
  }

  const threadId = String(payload.thread_id ?? payload.threadId ?? "").trim();
  const issueIds = Array.isArray(payload.issue_ids) ? payload.issue_ids.map((value) => String(value)) : [];

  if (!threadId) {
    throw new Error("정렬할 thread가 필요합니다.");
  }

  const queue = ensurePendingQueue(threadId);
  const reordered = issueIds.filter((issueId) => queue.includes(issueId));
  const remaining = queue.filter((issueId) => !reordered.includes(issueId));
  pendingStartQueues.set(threadId, [...reordered, ...remaining]);
  refreshIssueQueuePositions(threadId);
  await publishEvent(userId, "thread.issues.reordered", {
    thread_id: threadId,
    issue_ids: ensurePendingQueue(threadId)
  });
  await publishEvent(userId, "bridge.threadIssues.updated", {
    thread_id: threadId,
    issues: listThreadIssuesForClient(threadId)
  });

  return {
    accepted: true,
    issues: listThreadIssuesForClient(threadId)
  };
}

async function reorderPrepIssues(userId, payload = {}) {
  const threadId = String(payload.thread_id ?? payload.threadId ?? "").trim();
  const issueIds = Array.isArray(payload.issue_ids) ? payload.issue_ids.map((value) => String(value)) : [];

  if (!threadId) {
    throw new Error("정렬할 thread가 필요합니다.");
  }

  const stagedIds = getPrepIssueIds(threadId);

  if (stagedIds.length === 0) {
    return {
      accepted: true,
      issues: listThreadIssuesForClient(threadId)
    };
  }

  const reordered = issueIds.filter((issueId) => stagedIds.includes(issueId));

  if (reordered.length === 0) {
    return {
      accepted: true,
      issues: listThreadIssuesForClient(threadId)
    };
  }

  const finalOrder = [...reordered, ...stagedIds.filter((issueId) => !reordered.includes(issueId))];
  finalOrder.forEach((issueId, index) => {
    updateIssueCard(issueId, {
      prep_position: index + 1
    });
  });

  const stagedSet = new Set(finalOrder);
  const iterator = finalOrder[Symbol.iterator]();
  const nextIssueIds = getThreadIssueIds(threadId).map((issueId) =>
    stagedSet.has(issueId) ? iterator.next().value ?? issueId : issueId
  );
  setThreadIssueIds(threadId, nextIssueIds);

  await publishEvent(userId, "thread.issues.reordered", {
    thread_id: threadId,
    issue_ids: finalOrder,
    stage: "prep"
  });
  await publishEvent(userId, "bridge.threadIssues.updated", {
    thread_id: threadId,
    issues: listThreadIssuesForClient(threadId)
  });

  return {
    accepted: true,
    issues: listThreadIssuesForClient(threadId)
  };
}

async function deleteThreadIssue(userId, payload = {}) {
  const issueId = String(payload.issue_id ?? payload.issueId ?? "").trim();

  if (!issueId) {
    throw new Error("삭제할 이슈 id가 필요합니다.");
  }

  const issue = issueCardsById.get(issueId);

  if (!issue || issue.deleted_at) {
    throw new Error("이슈를 찾을 수 없습니다.");
  }

  const thread = threadStateById.get(issue.thread_id);

  if (!thread || threadOwners.get(thread.id) !== sanitizeUserId(userId)) {
    throw new Error("이슈를 찾을 수 없습니다.");
  }

  const wasActive =
    activeIssueByThreadId.get(issue.thread_id) === issueId ||
    [...activeIssueByPhysicalThreadId.values()].includes(issueId);
  let interruptResult = null;
  const recoverySteps = [];

  if (wasActive) {
    interruptResult = await interruptThreadExecutionBestEffort(thread);
    const blockingStopErrors = interruptResult.errors.filter((error) => error !== "codex thread not bound");

    if (blockingStopErrors.length > 0) {
      const forcedRecovery = shouldForceUnlockAfterStopFailure("delete_issue", blockingStopErrors);

      console.warn(
        forcedRecovery
          ? "[OctOP bridge] issue delete continuing with forced recovery after stop attempt errors"
          : "[OctOP bridge] issue delete aborted due to stop attempt errors",
        {
          ...buildLogContext({
            root_thread_id: issue.thread_id,
            physical_thread_id: thread.active_physical_thread_id ?? null,
            codex_thread_id: thread.codex_thread_id ?? null,
            issue_id: issueId,
            event_type: forcedRecovery
              ? "thread.issue.delete.stopBestEffort.forcedRecovery"
              : "thread.issue.delete.stopBestEffort.failed"
          }),
          errors: blockingStopErrors
        }
      );

      if (!forcedRecovery) {
        return {
          accepted: false,
          action: "stop_failed",
          error: "진행 중인 이슈를 안전하게 중단하지 못했습니다.",
          thread,
          issues: listThreadIssuesForClient(issue.thread_id),
          issue_id: issueId,
          interrupt_result: {
            interrupted: interruptResult.interrupted,
            stopped_realtime: interruptResult.stoppedRealtime,
            errors: interruptResult.errors
          }
        };
      }

      const invalidatedThread = invalidateCodexThreadBinding(issue.thread_id);
      recoverySteps.push("forced_release_after_delete_stop_failed");

      if (invalidatedThread) {
        recoverySteps.push("invalidated_active_binding");
      }
    }

    clearRunningIssueTracking(issue.thread_id);
    settlePhysicalThreadExecutionState(issue.thread_id, {
      issue,
      status: "idle",
      progress: Math.max(0, Math.min(Number(issue.progress ?? 0), 99)),
      lastEvent: "issue.deleted",
      lastMessage:
        String(issue.last_message ?? "").trim() || "실행 중인 이슈를 강제 중단 후 삭제했습니다."
    });
    recoverySteps.push("released_active_issue_lock");
  }

  await cleanupIssueAttachmentResources(issueId, {
    attachments: issue.attachments,
    removeRemote: true,
    forgetIssue: true
  });

  issueCardsById.delete(issueId);
  issueMessagesById.delete(issueId);
  setThreadIssueIds(
    issue.thread_id,
    getThreadIssueIds(issue.thread_id).filter((item) => item !== issueId)
  );
  pendingStartQueues.set(
    issue.thread_id,
    ensurePendingQueue(issue.thread_id).filter((item) => item !== issueId)
  );
  refreshIssueQueuePositions(issue.thread_id);
  await publishEvent(userId, "issue.deleted", {
    issue_id: issueId,
    thread_id: issue.thread_id
  });
  await publishEvent(userId, "bridge.threadIssues.updated", {
    thread_id: issue.thread_id,
    issues: listThreadIssuesForClient(issue.thread_id)
  });
  await publishEvent(userId, "logicalThread.timeline.updated", {
    root_thread_id: issue.thread_id,
    thread_id: issue.thread_id,
    entries: listThreadTimeline(issue.thread_id)
  });
  await publishEvent(userId, "bridge.projectThreads.updated", {
    scope: "project",
    project_id: issue.project_id,
    threads: listProjectThreads(userId, issue.project_id)
  });

  if (wasActive) {
    await scheduleQueuedIssuesForUser(userId, {
      preferredThreadId: issue.thread_id
    });
  }

  return {
    accepted: true,
    issues: listThreadIssuesForClient(issue.thread_id),
    deleted_issue_id: issueId,
    recovery_steps: recoverySteps,
    interrupt_result: interruptResult
      ? {
          interrupted: interruptResult.interrupted,
          stopped_realtime: interruptResult.stoppedRealtime,
          errors: interruptResult.errors
        }
      : null
  };
}

async function interruptThreadIssue(userId, payload = {}) {
  const issueId = String(payload.issue_id ?? payload.issueId ?? "").trim();
  const interruptReason = String(payload.reason ?? "manual_interrupt").trim() || "manual_interrupt";

  if (!issueId) {
    throw new Error("중단할 이슈 id가 필요합니다.");
  }

  const issue = issueCardsById.get(issueId);

  if (!issue || issue.deleted_at) {
    throw new Error("이슈를 찾을 수 없습니다.");
  }

  const thread = threadStateById.get(issue.thread_id);

  if (!thread || thread.deleted_at || threadOwners.get(thread.id) !== sanitizeUserId(userId)) {
    throw new Error("이슈를 중단할 수 없습니다.");
  }

  const issueStatus = String(issue.status ?? "").trim();

  if (!["queued", "idle", "running", "awaiting_input", "failed"].includes(issueStatus)) {
    return {
      accepted: true,
      action: "noop",
      thread,
      issues: listThreadIssuesForClient(issue.thread_id)
    };
  }

  const queue = ensurePendingQueue(issue.thread_id);
  const wasQueued = queue.includes(issueId);
  const wasActive =
    activeIssueByThreadId.get(issue.thread_id) === issueId || [...activeIssueByPhysicalThreadId.values()].includes(issueId);
  const previousActiveIssueId = activeIssueByThreadId.get(issue.thread_id) ?? null;
  const recoverySteps = [];
  let interruptResult = null;

  if (wasActive) {
    interruptResult = await interruptThreadExecutionBestEffort(thread);
    const blockingStopErrors = interruptResult.errors.filter((error) => error !== "codex thread not bound");

    if (blockingStopErrors.length > 0) {
      console.warn("[OctOP bridge] issue interrupt aborted due to stop attempt errors", {
        ...buildLogContext({
          root_thread_id: issue.thread_id,
          physical_thread_id: thread.active_physical_thread_id ?? null,
          codex_thread_id: thread.codex_thread_id ?? null,
          issue_id: issueId,
          event_type: "thread.issue.interrupt.stopBestEffort.failed"
        }),
        errors: blockingStopErrors
      });

      return {
        accepted: false,
        action: "stop_failed",
        error: "진행 중인 이슈를 안전하게 중단하지 못했습니다.",
        thread,
        issues: listThreadIssuesForClient(issue.thread_id),
        issue_id: issueId,
        interrupt_result: {
          interrupted: interruptResult.interrupted,
          stopped_realtime: interruptResult.stoppedRealtime,
          errors: interruptResult.errors
        }
      };
    }

    clearRunningIssueTracking(issue.thread_id);
    settlePhysicalThreadExecutionState(issue.thread_id, {
      issue,
      status: "idle",
      progress: Math.max(0, Math.min(Number(issue.progress ?? 0), 99)),
      lastEvent: "issue.interrupted",
      lastMessage:
        String(issue.last_message ?? "").trim() ||
        (interruptReason === "drag_to_prep"
          ? "Preparation으로 이동하면서 이슈를 중단했습니다."
          : "수동으로 이슈를 중단했습니다.")
    });
    recoverySteps.push("cleared_active_lock");
  }

  if (wasQueued) {
    pendingStartQueues.set(
      issue.thread_id,
      queue.filter((queuedIssueId) => queuedIssueId !== issueId)
    );
    recoverySteps.push("removed_from_queue");
  }

  const nextIssueStatus = interruptReason === "drag_to_prep" ? "staged" : "interrupted";
  updateIssueCard(issueId, {
    status: nextIssueStatus,
    progress: 0,
    queue_position: null,
    prep_position: nextIssueStatus === "staged" ? getNextPrepPosition(issue.thread_id) : null,
    last_event: "issue.interrupted",
    last_message:
      String(issue.last_message ?? "").trim() ||
      (interruptReason === "drag_to_prep"
        ? "Preparation으로 이동하면서 이슈를 중단했습니다."
        : "수동으로 이슈를 중단했습니다.")
  });

  refreshIssueQueuePositions(issue.thread_id);
  updateProjectThreadSnapshot(issue.thread_id);
  persistThreadById(issue.thread_id);
  await publishThreadState(userId, issue.thread_id);

  if (wasActive && previousActiveIssueId === issueId) {
    const scheduleResult = await scheduleQueuedIssuesForUser(userId, {
      preferredThreadId: issue.thread_id
    });

    if (scheduleResult.started) {
      recoverySteps.push("resumed_issue_queue");
    }
  } else if (!wasActive && ensurePendingQueue(issue.thread_id).length > 0) {
    await processIssueQueue(userId, issue.thread_id);
  }

  return {
    accepted: true,
    action: wasActive || wasQueued ? "interrupted" : nextIssueStatus === "staged" ? "restaged" : "interrupted",
    thread: threadStateById.get(issue.thread_id) ?? thread,
    issues: listThreadIssuesForClient(issue.thread_id),
    issue_id: issueId,
    recovery_steps: recoverySteps,
    interrupt_result: interruptResult
      ? {
          interrupted: interruptResult.interrupted,
          stopped_realtime: interruptResult.stoppedRealtime,
          errors: interruptResult.errors
        }
      : null
  };
}

async function stopThreadExecutionSafely(userId, rootThreadId, options = {}) {
  const normalizedUserId = sanitizeUserId(userId);
  const rootThread = threadStateById.get(rootThreadId);
  const stopReason = String(options.reason ?? "manual_stop").trim() || "manual_stop";

  if (!rootThread || rootThread.deleted_at || threadOwners.get(rootThreadId) !== normalizedUserId) {
    throw new Error("thread를 찾을 수 없습니다.");
  }

  const recoverySteps = [];
  const clearedInvalidTracking = clearInvalidRunningIssueTracking(rootThreadId);

  if (clearedInvalidTracking) {
    recoverySteps.push("cleared_invalid_tracking");
  }

  const trackedIssueId = activeIssueByThreadId.get(rootThreadId) ?? ensureRunningIssueTrackingForThread(rootThreadId);
  const trackedIssue = trackedIssueId ? issueCardsById.get(trackedIssueId) ?? null : null;

  if (!trackedIssue || !["running", "awaiting_input"].includes(String(trackedIssue.status ?? "").trim())) {
    if (clearedInvalidTracking) {
      updateProjectThreadSnapshot(rootThreadId);
      persistThreadById(rootThreadId);
      await publishThreadState(normalizedUserId, rootThreadId);
    }

    return {
      accepted: true,
      action: clearedInvalidTracking ? "recovered_tracking" : "noop",
      thread: threadStateById.get(rootThreadId) ?? rootThread,
      issues: listThreadIssuesForClient(rootThreadId),
      stopped_issue_id: null,
      recovery_steps: recoverySteps,
      verification: null,
      interrupt_result: null
    };
  }

  const activePhysicalThread = getActivePhysicalThread(rootThreadId);
  const codexThreadId = String(activePhysicalThread?.codex_thread_id ?? rootThread?.codex_thread_id ?? "").trim();

  if (!codexThreadId) {
    return {
      accepted: false,
      action: "stop_unverified",
      error: "활성 thread binding이 없어 안전하게 정지할 수 없습니다.",
      thread: threadStateById.get(rootThreadId) ?? rootThread,
      issues: listThreadIssuesForClient(rootThreadId),
      stopped_issue_id: trackedIssue.id,
      recovery_steps: recoverySteps,
      verification: {
        ok: false,
        verified_stopped: false,
        remote_status: null,
        remote_turn_id: null,
        error: "codex thread not bound"
      },
      interrupt_result: null
    };
  }

  const interruptResult = await interruptThreadExecutionBestEffort(rootThread, options);
  const verification = await verifyThreadStopState(rootThread, {
    reason: `threadStop:${stopReason}`,
    timeoutMs: options.timeoutMs
  });

  if (!verification.ok) {
    console.warn("[OctOP bridge] thread safe stop could not be verified", {
      ...buildLogContext({
        root_thread_id: rootThreadId,
        physical_thread_id: rootThread.active_physical_thread_id ?? null,
        codex_thread_id: codexThreadId,
        issue_id: trackedIssue.id,
        event_type: "thread.stop.verify.failed"
      }),
      interrupt_errors: interruptResult.errors,
      verification_error: verification.error
    });

    return {
      accepted: false,
      action: "stop_unverified",
      error: "원격 실행 중단 여부를 확인하지 못했습니다.",
      thread: threadStateById.get(rootThreadId) ?? rootThread,
      issues: listThreadIssuesForClient(rootThreadId),
      stopped_issue_id: trackedIssue.id,
      recovery_steps: recoverySteps,
      verification: {
        ok: verification.ok,
        verified_stopped: verification.verifiedStopped,
        remote_status: verification.remoteStatus,
        remote_turn_id: verification.remoteTurnId,
        error: verification.error
      },
      interrupt_result: {
        interrupted: interruptResult.interrupted,
        stopped_realtime: interruptResult.stoppedRealtime,
        errors: interruptResult.errors
      }
    };
  }

  if (!verification.verifiedStopped) {
    console.warn("[OctOP bridge] thread safe stop rejected because remote execution is still active", {
      ...buildLogContext({
        root_thread_id: rootThreadId,
        physical_thread_id: rootThread.active_physical_thread_id ?? null,
        codex_thread_id: codexThreadId,
        issue_id: trackedIssue.id,
        event_type: "thread.stop.verify.stillRunning"
      }),
      interrupt_errors: interruptResult.errors,
      remote_status: verification.remoteStatus,
      remote_turn_id: verification.remoteTurnId
    });

    return {
      accepted: false,
      action: "still_running",
      error: "원격 실행이 아직 중단되지 않았습니다.",
      thread: threadStateById.get(rootThreadId) ?? rootThread,
      issues: listThreadIssuesForClient(rootThreadId),
      stopped_issue_id: trackedIssue.id,
      recovery_steps: recoverySteps,
      verification: {
        ok: verification.ok,
        verified_stopped: verification.verifiedStopped,
        remote_status: verification.remoteStatus,
        remote_turn_id: verification.remoteTurnId,
        error: verification.error
      },
      interrupt_result: {
        interrupted: interruptResult.interrupted,
        stopped_realtime: interruptResult.stoppedRealtime,
        errors: interruptResult.errors
      }
    };
  }

  const stopMessage =
    String(trackedIssue.last_message ?? "").trim() ||
    "수동으로 실행을 중단했습니다.";

  clearRunningIssueTracking(rootThreadId);
  settlePhysicalThreadExecutionState(rootThreadId, {
    issue: trackedIssue,
    status: "idle",
    progress: Math.max(0, Math.min(Number(trackedIssue.progress ?? 0), 99)),
    lastEvent: "thread.stop.completed",
    lastMessage: stopMessage
  });
  recoverySteps.push("cleared_active_lock");

  updateIssueCard(trackedIssue.id, {
    status: "interrupted",
    progress: 0,
    queue_position: null,
    prep_position: null,
    last_event: "thread.stop.completed",
    last_message: stopMessage
  });
  recoverySteps.push("interrupted_active_issue");

  refreshIssueQueuePositions(rootThreadId);
  updateProjectThreadSnapshot(rootThreadId);
  persistThreadById(rootThreadId);
  await publishThreadState(normalizedUserId, rootThreadId);

  return {
    accepted: true,
    action: "stopped",
    thread: threadStateById.get(rootThreadId) ?? rootThread,
    issues: listThreadIssuesForClient(rootThreadId),
    stopped_issue_id: trackedIssue.id,
    recovery_steps: recoverySteps,
    verification: {
      ok: verification.ok,
      verified_stopped: verification.verifiedStopped,
      remote_status: verification.remoteStatus,
      remote_turn_id: verification.remoteTurnId,
      error: verification.error
    },
    interrupt_result: {
      interrupted: interruptResult.interrupted,
      stopped_realtime: interruptResult.stoppedRealtime,
      errors: interruptResult.errors
    }
  };
}

async function moveThreadIssue(userId, payload = {}) {
  const issueId = String(payload.issue_id ?? payload.issueId ?? "").trim();
  const targetThreadId = String(payload.target_thread_id ?? payload.targetThreadId ?? "").trim();

  if (!issueId) {
    throw new Error("이동할 이슈 id가 필요합니다.");
  }

  if (!targetThreadId) {
    throw new Error("이동할 대상 thread id가 필요합니다.");
  }

  const issue = issueCardsById.get(issueId);

  if (!issue || issue.deleted_at) {
    throw new Error("이슈를 찾을 수 없습니다.");
  }

  const sourceThreadId = String(issue.thread_id ?? "").trim();
  const sourceThread = threadStateById.get(sourceThreadId);
  const targetThread = threadStateById.get(targetThreadId);
  const normalizedUserId = sanitizeUserId(userId);

  if (!sourceThread || sourceThread.deleted_at || threadOwners.get(sourceThreadId) !== normalizedUserId) {
    throw new Error("이동할 source thread를 찾을 수 없습니다.");
  }

  if (!targetThread || targetThread.deleted_at || threadOwners.get(targetThreadId) !== normalizedUserId) {
    throw new Error("이동할 target thread를 찾을 수 없습니다.");
  }

  if (sourceThreadId === targetThreadId) {
    return {
      accepted: true,
      action: "noop",
      issue: serializeIssueForClient(issue),
      source_thread: sourceThread,
      target_thread: targetThread,
      source_issues: listThreadIssuesForClient(sourceThreadId),
      target_issues: listThreadIssuesForClient(targetThreadId)
    };
  }

  const issueStatus = String(issue.status ?? "").trim();

  if (!["staged", "queued", "idle", "running", "awaiting_input"].includes(issueStatus)) {
    throw new Error("Preparation 또는 In Progress 상태의 이슈만 이동할 수 있습니다.");
  }

  const sourceQueue = ensurePendingQueue(sourceThreadId);
  const wasQueued = sourceQueue.includes(issueId);
  const wasActive =
    activeIssueByThreadId.get(sourceThreadId) === issueId || [...activeIssueByPhysicalThreadId.values()].includes(issueId);
  const previousActiveIssueId = activeIssueByThreadId.get(sourceThreadId) ?? null;
  const recoverySteps = [];
  let interruptResult = null;

  if (wasActive) {
    interruptResult = await interruptThreadExecutionBestEffort(sourceThread);
    const blockingStopErrors = interruptResult.errors.filter((error) => error !== "codex thread not bound");

    if (blockingStopErrors.length > 0) {
      console.warn("[OctOP bridge] issue move aborted due to stop attempt errors", {
        ...buildLogContext({
          root_thread_id: sourceThreadId,
          physical_thread_id: sourceThread.active_physical_thread_id ?? null,
          codex_thread_id: sourceThread.codex_thread_id ?? null,
          issue_id: issueId,
          event_type: "thread.issue.move.stopBestEffort.failed"
        }),
        target_thread_id: targetThreadId,
        errors: blockingStopErrors
      });

      return {
        accepted: false,
        action: "stop_failed",
        error: "진행 중인 이슈를 안전하게 중단하지 못했습니다.",
        issue_id: issueId,
        source_thread: sourceThread,
        target_thread: targetThread,
        source_issues: listThreadIssuesForClient(sourceThreadId),
        target_issues: listThreadIssuesForClient(targetThreadId),
        interrupt_result: {
          interrupted: interruptResult.interrupted,
          stopped_realtime: interruptResult.stoppedRealtime,
          errors: interruptResult.errors
        }
      };
    }

    clearRunningIssueTracking(sourceThreadId);
    settlePhysicalThreadExecutionState(sourceThreadId, {
      issue,
      status: "idle",
      progress: Math.max(0, Math.min(Number(issue.progress ?? 0), 99)),
      lastEvent: "issue.moved",
      lastMessage: "다른 쓰레드로 이동하면서 이슈를 중단했습니다."
    });
    recoverySteps.push("cleared_active_lock");
  }

  if (wasQueued) {
    pendingStartQueues.set(
      sourceThreadId,
      sourceQueue.filter((queuedIssueId) => queuedIssueId !== issueId)
    );
    recoverySteps.push("removed_from_source_queue");
  }

  setThreadIssueIds(
    sourceThreadId,
    getThreadIssueIds(sourceThreadId).filter((currentIssueId) => currentIssueId !== issueId)
  );
  setThreadIssueIds(
    targetThreadId,
    [...getThreadIssueIds(targetThreadId).filter((currentIssueId) => currentIssueId !== issueId), issueId]
  );

  const nextIssue = updateIssueCard(issueId, {
    thread_id: targetThreadId,
    root_thread_id: targetThreadId,
    project_id: targetThread.project_id,
    status: "staged",
    progress: 0,
    queue_position: null,
    prep_position: getNextPrepPosition(targetThreadId),
    created_physical_thread_id: null,
    executed_physical_thread_id: null,
    last_event: "issue.moved",
    last_message: `다른 쓰레드로 이동했습니다. 대상: ${targetThread.name || targetThread.id}`,
    updated_at: now()
  });

  refreshIssueQueuePositions(sourceThreadId);
  refreshIssueQueuePositions(targetThreadId);
  updateProjectThreadSnapshot(sourceThreadId);
  updateProjectThreadSnapshot(targetThreadId);
  persistThreadById(sourceThreadId);
  persistThreadById(targetThreadId);

  if (wasActive && previousActiveIssueId === issueId) {
    const scheduleResult = await scheduleQueuedIssuesForUser(userId, {
      preferredThreadId: sourceThreadId
    });

    if (scheduleResult.started) {
      recoverySteps.push("resumed_source_queue");
    }
  } else if (!wasActive && ensurePendingQueue(sourceThreadId).length > 0) {
    await processIssueQueue(userId, sourceThreadId);
  }

  await publishEvent(userId, "issue.moved", {
    issue: serializeIssueForClient(nextIssue),
    source_thread_id: sourceThreadId,
    target_thread_id: targetThreadId
  });
  await publishThreadState(userId, sourceThreadId);
  await publishThreadState(userId, targetThreadId);

  return {
    accepted: true,
    action: "moved",
    issue: serializeIssueForClient(nextIssue),
    source_thread: threadStateById.get(sourceThreadId) ?? sourceThread,
    target_thread: threadStateById.get(targetThreadId) ?? targetThread,
    source_issues: listThreadIssuesForClient(sourceThreadId),
    target_issues: listThreadIssuesForClient(targetThreadId),
    recovery_steps: recoverySteps,
    interrupt_result: interruptResult
      ? {
          interrupted: interruptResult.interrupted,
          stopped_realtime: interruptResult.stoppedRealtime,
          errors: interruptResult.errors
        }
      : null
  };
}

async function updateThreadIssue(userId, payload = {}) {
  const issueId = String(payload.issue_id ?? payload.issueId ?? "").trim();
  const prompt = String(payload.prompt ?? "").trim();
  const title = String(payload.title ?? "").trim();

  if (!issueId) {
    throw new Error("수정할 이슈 id가 필요합니다.");
  }

  if (!prompt) {
    throw new Error("프롬프트를 입력해 주세요.");
  }

  const issue = issueCardsById.get(issueId);

  if (!issue || issue.deleted_at) {
    throw new Error("이슈를 찾을 수 없습니다.");
  }

  const thread = threadStateById.get(issue.thread_id);

  if (!thread || thread.deleted_at || threadOwners.get(thread.id) !== sanitizeUserId(userId)) {
    throw new Error("이슈를 수정할 수 없습니다.");
  }

  if (issue.status !== "staged") {
    throw new Error("준비 중인 이슈만 수정할 수 있습니다.");
  }

  const attachments = normalizeIssueAttachmentsWithExisting(payload.attachments, issue.attachments);

  await cleanupRemovedIssueAttachments(issue.attachments, attachments);

  const next = updateIssueCard(issueId, {
    title: title || issue.title,
    prompt,
    attachments,
    last_event: "issue.updated",
    last_message: "",
    updated_at: now()
  });

  const messages = ensureIssueMessages(issueId);
  const promptIndex = messages.findIndex((message) => message?.kind === "prompt");

  if (promptIndex >= 0) {
    messages[promptIndex] = {
      ...messages[promptIndex],
      content: prompt,
      timestamp: now()
    };
  } else {
    pushIssueMessage(issueId, {
      role: "user",
      kind: "prompt",
      content: prompt
    });
  }

  updateProjectThreadSnapshot(thread.id);
  await publishEvent(userId, "issue.updated", {
    issue: serializeIssueForClient(next),
    thread_id: thread.id
  });
  await publishEvent(userId, "bridge.threadIssues.updated", {
    thread_id: thread.id,
    issues: listThreadIssuesForClient(thread.id)
  });
  await publishEvent(userId, "logicalThread.timeline.updated", {
    root_thread_id: thread.id,
    thread_id: thread.id,
    entries: listThreadTimeline(thread.id)
  });
  await publishEvent(userId, "bridge.projectThreads.updated", {
    scope: "project",
    project_id: thread.project_id,
    threads: listProjectThreads(userId, thread.project_id)
  });

  return {
    accepted: true,
    issue: serializeIssueForClient(next),
    issues: listThreadIssuesForClient(thread.id)
  };
}

function normalizeThreadStatus(rawStatus, currentStatus = "queued") {
  if (!rawStatus || typeof rawStatus !== "object") {
    return currentStatus;
  }

  let nextStatus;

  switch (rawStatus.type) {
    case "active":
      nextStatus = "running";
      break;
    case "idle":
      nextStatus = "idle";
      break;
    case "interrupted":
    case "cancelled":
    case "canceled":
      nextStatus = "idle";
      break;
    case "waitingForInput":
      nextStatus = "awaiting_input";
      break;
    case "error":
      nextStatus = "failed";
      break;
    default:
      nextStatus = rawStatus.type ?? currentStatus;
      break;
  }

  if (
    ["completed", "failed"].includes(currentStatus) &&
    !["completed", "failed"].includes(nextStatus)
  ) {
    return currentStatus;
  }

  if (
    currentStatus === "staged" &&
    ["queued", "idle"].includes(nextStatus)
  ) {
    return currentStatus;
  }

  return nextStatus;
}

function isTerminalThreadStatusType(statusType = "") {
  const normalized = String(statusType ?? "").trim();
  return normalized === "idle" || normalized === "error" || INTERRUPTED_THREAD_STATUS_TYPES.has(normalized);
}

function isIssueTerminalStatus(status) {
  return ["completed", "failed"].includes(status);
}

function isIssueProgressEvent(method) {
  return ["turn/started", "turn/plan/updated", "turn/diff/updated", "item/agentMessage/delta"].includes(method);
}

function extractNotificationTurnId(params = {}) {
  const candidate = String(
    params.turn?.id ??
      params.turnId ??
      params.turn_id ??
      ""
  ).trim();
  return candidate || null;
}

function getTrackedExecutionTurnId(rootThreadId, physicalThreadId = null) {
  const currentPhysicalThread = physicalThreadId
    ? physicalThreadStateById.get(physicalThreadId) ?? null
    : getActivePhysicalThread(rootThreadId);
  const currentRootThread = threadStateById.get(rootThreadId) ?? null;
  const candidate = String(
    currentPhysicalThread?.turn_id ??
      currentRootThread?.turn_id ??
      ""
  ).trim();
  return candidate || null;
}

function shouldApplyTerminalThreadStatusChanged(params = {}, rootThreadId, physicalThreadId = null) {
  const statusType = params.status?.type ?? "";

  if (!isTerminalThreadStatusType(statusType)) {
    return true;
  }

  const eventTurnId = extractNotificationTurnId(params);
  const trackedTurnId = getTrackedExecutionTurnId(rootThreadId, physicalThreadId);

  if (!trackedTurnId) {
    return true;
  }

  if (!eventTurnId) {
    return true;
  }

  return eventTurnId === trackedTurnId;
}

function normalizeThreadRecord(thread, fallback = {}) {
  const current = threadStateById.get(thread.id) ?? {};
  const lastEvent = threadEventsById.get(thread.id);
  const tokenUsageState = normalizeThreadTokenUsage(thread.tokenUsage ?? thread.token_usage ?? null, {
    token_usage: fallback.token_usage ?? current.token_usage ?? null,
    context_window_tokens: fallback.context_window_tokens ?? current.context_window_tokens ?? null,
    context_used_tokens: fallback.context_used_tokens ?? current.context_used_tokens ?? null,
    context_usage_percent: fallback.context_usage_percent ?? current.context_usage_percent ?? null
  });

  return {
    id: thread.id,
    bridge_id: fallback.bridge_id ?? current.bridge_id ?? BRIDGE_ID,
    project_id: fallback.project_id ?? current.project_id ?? fallback.projectId ?? null,
    title:
      fallback.title ??
      current.title ??
      thread.name ??
      thread.preview ??
      "OctOP app-server command",
    status: normalizeThreadStatus(thread.status, fallback.status ?? current.status ?? "queued"),
    progress: fallback.progress ?? current.progress ?? 0,
    last_event: fallback.last_event ?? current.last_event ?? lastEvent?.type ?? "thread.synced",
    last_message: fallback.last_message ?? current.last_message ?? "",
    turn_id: fallback.turn_id ?? current.turn_id ?? null,
    prompt: fallback.prompt ?? current.prompt ?? "",
    token_usage: tokenUsageState.token_usage,
    context_window_tokens: tokenUsageState.context_window_tokens,
    context_used_tokens: tokenUsageState.context_used_tokens,
    context_usage_percent: tokenUsageState.context_usage_percent,
    created_at: fallback.created_at ?? current.created_at ?? unixSecondsToIso(thread.createdAt),
    updated_at: fallback.updated_at ?? current.updated_at ?? unixSecondsToIso(thread.updatedAt),
    source: thread.source ?? current.source ?? "appServer",
    queue_position: fallback.queue_position ?? current.queue_position ?? null
  };
}

function upsertThreadState(threadId, patch) {
  const current = threadStateById.get(threadId) ?? {
    id: threadId,
    progress: 0,
    status: "queued",
    last_event: "thread.created",
    last_message: "",
    prompt: "",
    created_at: now(),
    updated_at: now(),
    source: "appServer"
  };
  const next = {
    ...current,
    ...patch,
    id: threadId,
    updated_at: patch.updated_at ?? now()
  };

  threadStateById.set(threadId, next);
  persistThreadById(threadId);
  return next;
}

async function publishEvent(loginId, type, payload) {
  const subjects = bridgeSubjects(loginId, BRIDGE_ID);
  const event = {
    user_id: loginId,
    login_id: loginId,
    bridge_id: BRIDGE_ID,
    host_name: HOST_NAME,
    device_name: DEVICE_NAME,
    type,
    payload,
    timestamp: now()
  };
  ensureUserState(loginId).updated_at = event.timestamp;
  const publishedEvent = publishNatsEventWithFallback(subjects.events, event) ?? event;
  const threadId = resolveLocalThreadId(
    payload?.thread_id ?? payload?.threadId ?? payload?.thread?.id ?? payload?.conversationId
  );

  if (threadId) {
    threadEventsById.set(threadId, publishedEvent);
  }
}

function publishNatsEventWithFallback(subject, event) {
  try {
    nc.publish(subject, sc.encode(JSON.stringify(event)));
    return event;
  } catch (error) {
    if (error?.code !== "MAX_PAYLOAD_EXCEEDED") {
      throw error;
    }

    const chunkedEvent = publishChunkedDeltaEvent(subject, event);

    if (chunkedEvent) {
      return chunkedEvent;
    }

    console.warn("[OctOP bridge] NATS event dropped: max payload exceeded", {
      type: event.type,
      payload_bytes: Buffer.byteLength(JSON.stringify(event), "utf8"),
      thread_id: event.payload?.thread_id ?? event.payload?.threadId ?? event.payload?.thread?.id ?? null,
      root_thread_id: event.payload?.root_thread_id ?? null,
      physical_thread_id: event.payload?.physical_thread_id ?? null,
      project_id: event.payload?.project_id ?? null,
      issue_id: event.payload?.issue_id ?? null
    });
    return null;
  }
}

function publishChunkedDeltaEvent(subject, event) {
  if (event.type !== "item.agentMessage.delta") {
    return null;
  }

  const delta = String(event.payload?.delta ?? "");

  if (!delta) {
    return null;
  }

  const chunks = splitTextByUtf8Bytes(delta, NATS_DELTA_CHUNK_MAX_BYTES);

  if (chunks.length <= 1) {
    return null;
  }

  let lastChunkEvent = null;

  for (let index = 0; index < chunks.length; index += 1) {
    const chunkEvent = {
      ...event,
      payload: {
        ...event.payload,
        delta: chunks[index],
        delta_chunk_index: index + 1,
        delta_chunk_count: chunks.length
      },
      timestamp: now()
    };

    nc.publish(subject, sc.encode(JSON.stringify(chunkEvent)));
    lastChunkEvent = chunkEvent;
  }

  console.warn("[OctOP bridge] split agent delta event for streaming publish", {
    original_bytes: Buffer.byteLength(delta, "utf8"),
    chunk_count: chunks.length,
    max_chunk_bytes: NATS_DELTA_CHUNK_MAX_BYTES,
    thread_id: event.payload?.thread_id ?? null,
    issue_id: event.payload?.issue_id ?? null
  });

  return lastChunkEvent;
}

function splitTextByUtf8Bytes(text, maxBytes) {
  const normalizedText = String(text ?? "");

  if (!normalizedText) {
    return [""];
  }

  if (Buffer.byteLength(normalizedText, "utf8") <= maxBytes) {
    return [normalizedText];
  }

  const chunks = [];
  let cursor = 0;

  while (cursor < normalizedText.length) {
    let end = Math.min(normalizedText.length, cursor + maxBytes);
    let chunk = normalizedText.slice(cursor, end);

    while (chunk && Buffer.byteLength(chunk, "utf8") > maxBytes) {
      end -= 1;
      chunk = normalizedText.slice(cursor, end);
    }

    if (!chunk) {
      end = cursor + 1;
      chunk = normalizedText.slice(cursor, end);
    }

    chunks.push(chunk);
    cursor = end;
  }

  return chunks;
}

function ensureThreadMessages(threadId) {
  if (!threadMessagesById.has(threadId)) {
    threadMessagesById.set(threadId, []);
  }

  return threadMessagesById.get(threadId);
}

function pushThreadMessage(threadId, message) {
  const messages = ensureThreadMessages(threadId);
  messages.push({
    id: randomUUID(),
    timestamp: now(),
    ...message
  });
  persistThreadById(threadId);
  return messages;
}

function appendAssistantDelta(threadId, delta = "") {
  const messages = ensureThreadMessages(threadId);
  const lastMessage = messages.at(-1);

  if (lastMessage?.role === "assistant") {
    lastMessage.content = `${lastMessage.content ?? ""}${delta}`;
    lastMessage.timestamp = now();
    persistThreadById(threadId);
    return;
  }

  messages.push({
    id: randomUUID(),
    role: "assistant",
    kind: "message",
    content: String(delta ?? ""),
    timestamp: now()
  });
  persistThreadById(threadId);
}

function listThreadMessages(threadId) {
  return [...(threadMessagesById.get(threadId) ?? [])];
}

function buildExecutionPrompt(prompt = "") {
  const normalizedPrompt = String(prompt ?? "").trim();
  const instruction = [
    "아래 프롬프트를 최우선 지시로 따르십시오.",
    "질문 없이 작업을 순차적으로 끝까지 진행하십시오.",
    "판단이 필요한 부분은 스스로 가장 합리적인 방법을 선택하십시오.",
    "중간 확인 요청보다 실제 결과를 만드는 데 집중하십시오."
  ].join(" ");

  if (!normalizedPrompt) {
    return instruction;
  }

  return `${instruction}\n\n[사용자 프롬프트]\n${normalizedPrompt}`;
}

function formatIssueAttachmentSize(sizeBytes) {
  const normalizedSize = Math.max(0, Number(sizeBytes) || 0);

  if (normalizedSize < 1024) {
    return `${normalizedSize} B`;
  }

  if (normalizedSize < 1024 * 1024) {
    return `${(normalizedSize / 1024).toFixed(1)} KB`;
  }

  return `${(normalizedSize / (1024 * 1024)).toFixed(1)} MB`;
}

function buildIssueAttachmentPromptSection(attachments = []) {
  const normalizedAttachments = normalizeIssueAttachments(attachments);

  if (normalizedAttachments.length === 0) {
    return "";
  }

  const localFileAttachments = normalizedAttachments.filter(
    (attachment) => attachment.kind !== "image" && attachment.local_path
  );
  const inlineTextAttachments = normalizedAttachments.filter(
    (attachment) => attachment.kind !== "image" && !attachment.local_path && attachment.text_content
  );
  const imageAttachments = normalizedAttachments.filter(
    (attachment) => attachment.kind === "image" && attachment.local_path
  );
  const lines = ["[첨부 자료]"];

  if (localFileAttachments.length > 0) {
    lines.push("아래 로컬 경로 파일을 직접 열어 내용을 확인한 뒤 작업하십시오.");

    for (const [index, attachment] of localFileAttachments.entries()) {
      lines.push("");
      lines.push(`${index + 1}. ${attachment.name}`);
      lines.push(`- mime_type: ${attachment.mime_type ?? "unknown"}`);
      lines.push(`- size: ${formatIssueAttachmentSize(attachment.size_bytes)}`);
      lines.push(`- local_path: ${attachment.local_path}`);
    }
  }

  if (inlineTextAttachments.length > 0) {
    if (localFileAttachments.length > 0) {
      lines.push("");
    }

    lines.push("아래 텍스트 첨부 본문을 직접 참고하십시오.");

    for (const [index, attachment] of inlineTextAttachments.entries()) {
      lines.push("");
      lines.push(`${index + 1}. ${attachment.name}`);
      lines.push(`- mime_type: ${attachment.mime_type ?? "unknown"}`);
      lines.push(`- size: ${formatIssueAttachmentSize(attachment.size_bytes)}`);

      if (attachment.text_truncated) {
        lines.push("- note: 본문이 일부만 포함되었습니다.");
      }

      lines.push("[content]");
      lines.push(String(attachment.text_content ?? ""));
    }
  }

  if (imageAttachments.length > 0) {
    if (localFileAttachments.length > 0 || inlineTextAttachments.length > 0) {
      lines.push("");
    }

    lines.push("아래 이미지는 localImage 입력으로 함께 전달됩니다.");

    for (const [index, attachment] of imageAttachments.entries()) {
      lines.push("");
      lines.push(`${index + 1}. ${attachment.name}`);
      lines.push(`- mime_type: ${attachment.mime_type ?? "unknown"}`);
      lines.push(`- size: ${formatIssueAttachmentSize(attachment.size_bytes)}`);
      lines.push(`- local_path: ${attachment.local_path}`);
    }
  }

  if (
    localFileAttachments.length === 0 &&
    inlineTextAttachments.length === 0 &&
    imageAttachments.length === 0
  ) {
    lines.push("첨부 메타데이터는 저장되어 있지만 현재 읽을 수 있는 로컬 경로가 준비되지 않았습니다.");
  }

  return lines.join("\n");
}

function buildExecutionInputPrompt(issue = null) {
  const sections = [String(issue?.prompt ?? "").trim()];
  const attachmentSection = buildIssueAttachmentPromptSection(issue?.attachments ?? []);

  if (attachmentSection) {
    sections.push(attachmentSection);
  }

  return buildExecutionPrompt(sections.filter(Boolean).join("\n\n"));
}

function buildHandoffPrompt(summary, issue = null) {
  const sections = [
    "이전 thread에서 컨텍스트 사용량 한계로 rollover되었습니다.",
    "아래 handoff summary를 최우선 문맥으로 사용해 같은 작업을 이어가십시오.",
    "",
    "[handoff summary]",
    summary.content_markdown,
    "",
    "[현재 issue 원본 프롬프트]",
    String(issue?.prompt ?? "").trim()
  ];

  const attachmentSection = buildIssueAttachmentPromptSection(issue?.attachments ?? []);

  if (attachmentSection) {
    sections.push("", attachmentSection);
  }

  return buildExecutionPrompt(sections.filter(Boolean).join("\n"));
}

function buildIssueTurnInput(issue = null, inputPrompt = "") {
  const normalizedAttachments = normalizeIssueAttachments(issue?.attachments);
  const input = [
    {
      type: "text",
      text: inputPrompt
    }
  ];

  for (const attachment of normalizedAttachments) {
    if (attachment.kind !== "image" || !attachment.local_path) {
      continue;
    }

    input.push({
      type: "localImage",
      path: attachment.local_path
    });
  }

  return input;
}

function buildDeterministicHandoffSummary(rootThreadId, sourcePhysicalThreadId, issueId = null) {
  const rootThread = threadStateById.get(rootThreadId);
  const sourcePhysicalThread = physicalThreadStateById.get(sourcePhysicalThreadId);
  const activeIssue = issueId ? issueCardsById.get(issueId) : null;
  const recentMessages = activeIssue ? listIssueMessages(activeIssue.id).slice(-8) : [];
  const recentIssues = listThreadIssues(rootThreadId).slice(0, 5);
  const contentJson = {
    root_thread_id: rootThreadId,
    source_physical_thread_id: sourcePhysicalThreadId,
    project_id: rootThread?.project_id ?? null,
    root_thread_name: rootThread?.name ?? "",
    active_issue: activeIssue
      ? {
          id: activeIssue.id,
          title: activeIssue.title,
          prompt: activeIssue.prompt,
          status: activeIssue.status,
          last_message: activeIssue.last_message ?? ""
        }
      : null,
    recent_issues: recentIssues.map((issue) => ({
      id: issue.id,
      title: issue.title,
      status: issue.status,
      last_message: issue.last_message ?? ""
    })),
    recent_messages: recentMessages.map((message) => ({
      role: message.role ?? "system",
      content: String(message.content ?? "").trim()
    })),
    source_context_usage_percent: sourcePhysicalThread?.context_usage_percent ?? null,
    source_context_used_tokens: sourcePhysicalThread?.context_used_tokens ?? null,
    source_context_window_tokens: sourcePhysicalThread?.context_window_tokens ?? null
  };
  const markdownLines = [
    `root thread: ${rootThread?.name ?? rootThreadId}`,
    `source physical thread: ${sourcePhysicalThreadId}`,
    activeIssue ? `active issue: ${activeIssue.title}` : "active issue: 없음",
    activeIssue?.prompt ? `issue prompt: ${activeIssue.prompt}` : null,
    recentIssues.length > 0 ? "recent issues:" : null,
    ...recentIssues.map((issue) => `- ${issue.title} [${issue.status}] ${issue.last_message ?? ""}`),
    recentMessages.length > 0 ? "recent messages:" : null,
    ...recentMessages.map((message) => `- ${message.role}: ${String(message.content ?? "").trim()}`)
  ].filter(Boolean);

  return normalizeHandoffSummary({
    id: createHandoffSummaryId(),
    root_thread_id: rootThreadId,
    source_physical_thread_id: sourcePhysicalThreadId,
    content_markdown: markdownLines.join("\n"),
    content_json: contentJson
  });
}

function validateRolloverPreconditions(rootThreadId, options = {}) {
  const rootThread = threadStateById.get(rootThreadId);
  const activePhysicalThread = getActivePhysicalThread(rootThreadId);
  const requireActiveIssue = options.requireActiveIssue !== false;
  const requestedIssueId = String(options.issueId ?? "").trim() || null;
  const activeIssueId = requestedIssueId ?? activeIssueByThreadId.get(rootThreadId) ?? null;
  const activeIssue = activeIssueId ? issueCardsById.get(activeIssueId) ?? null : null;
  const cooldownUntil = rolloverCooldownByRootThreadId.get(rootThreadId) ?? 0;

  if (!THREAD_CONTEXT_ROLLOVER_ENABLED) {
    return { ok: false, reason: "disabled" };
  }

  if (!rootThread || rootThread.deleted_at) {
    return { ok: false, reason: "missing_root_thread" };
  }

  if (!activePhysicalThread || activePhysicalThread.deleted_at || activePhysicalThread.closed_at) {
    return { ok: false, reason: "missing_active_physical_thread" };
  }

  if (!activeIssueId || !activeIssue || activeIssue.deleted_at || activeIssue.thread_id !== rootThreadId) {
    return {
      ok: false,
      reason: requireActiveIssue ? "missing_active_issue" : "missing_issue_to_start"
    };
  }

  if (rolloverLocksByRootThreadId.has(rootThreadId)) {
    return { ok: false, reason: "locked" };
  }

  if (cooldownUntil > Date.now()) {
    return { ok: false, reason: "cooldown" };
  }

  if ((activePhysicalThread.context_usage_percent ?? 0) < THREAD_CONTEXT_ROLLOVER_THRESHOLD_PERCENT) {
    return { ok: false, reason: "below_threshold" };
  }

  return {
    ok: true,
    rootThread,
    activePhysicalThread,
    activeIssueId,
    activeIssue
  };
}

async function publishRolloverEvents(userId, rootThreadId, sourcePhysicalThread, targetPhysicalThread, summary, issue) {
  await publishEvent(userId, "handoffSummary.created", {
    root_thread_id: rootThreadId,
    summary
  });
  await publishEvent(userId, "physicalThread.closed", {
    root_thread_id: rootThreadId,
    physical_thread: sourcePhysicalThread
  });
  await publishEvent(userId, "physicalThread.created", {
    root_thread_id: rootThreadId,
    physical_thread: targetPhysicalThread
  });
    await publishEvent(userId, "rootThread.rollover.completed", {
      root_thread_id: rootThreadId,
      thread_id: rootThreadId,
      issue_id: issue?.id ?? null,
      source_physical_thread_id: sourcePhysicalThread.id,
      target_physical_thread_id: targetPhysicalThread.id,
      summary_id: summary.id
    });
}

async function performContextRollover(userId, rootThreadId, reason = "threshold", options = {}) {
  const preconditions = validateRolloverPreconditions(rootThreadId, options);
  const rolloverStartedAtMs = Date.now();

  if (!preconditions.ok) {
    return {
      accepted: false,
      reason: preconditions.reason
    };
  }

  const { rootThread, activePhysicalThread: sourcePhysicalThread, activeIssueId, activeIssue } = preconditions;
  const isPreflight = options.requireActiveIssue === false;
  const lockToken = {
    root_thread_id: rootThreadId,
    source_physical_thread_id: sourcePhysicalThread.id,
    started_at: now(),
    reason
  };

  rolloverLocksByRootThreadId.set(rootThreadId, lockToken);

  try {
    await publishEvent(userId, "rootThread.rollover.started", {
      root_thread_id: rootThreadId,
      thread_id: rootThreadId,
      issue_id: activeIssueId,
      source_physical_thread_id: sourcePhysicalThread.id,
      reason
    });

    const summary = buildDeterministicHandoffSummary(rootThreadId, sourcePhysicalThread.id, activeIssueId);
    handoffSummariesById.set(summary.id, summary);

    const targetPhysicalThread = createPhysicalThread(rootThreadId, "context_rollover", sourcePhysicalThread, {
      rollover_trigger_percent: sourcePhysicalThread.context_usage_percent ?? null,
      handoff_summary_id: summary.id,
      status: "active"
    });
    const targetCodexThreadId = await ensureCodexThreadForPhysicalThread(userId, targetPhysicalThread.id, {
      issue: activeIssue
    });
    const interrupted = isPreflight
      ? { ok: true, skipped: true }
      : await requestAppServerBestEffort("turn/interrupt", {
          threadId: sourcePhysicalThread.codex_thread_id,
          turnId: sourcePhysicalThread.turn_id
        });

    if (!interrupted.ok) {
      console.warn("[OctOP bridge] rollover source interrupt best effort failed", {
        ...buildLogContext({
          root_thread_id: rootThreadId,
          physical_thread_id: sourcePhysicalThread.id,
          source_physical_thread_id: sourcePhysicalThread.id,
          codex_thread_id: sourcePhysicalThread.codex_thread_id ?? null,
          issue_id: activeIssueId,
          event_type: "rootThread.rollover.interrupt.failed"
        }),
        error: interrupted.error?.message ?? "unknown"
      });
    }

    const closedSourcePhysicalThread = closePhysicalThread(sourcePhysicalThread.id, "rolled_over");
    markPhysicalThreadClosedForEventDrop(sourcePhysicalThread.id);
    trackRecentlyClosedPhysicalThread(rootThreadId, sourcePhysicalThread.id, closedSourcePhysicalThread?.closed_at ?? now());
    activeIssueByPhysicalThreadId.delete(sourcePhysicalThread.id);
    const nextSummary = {
      ...summary,
      target_physical_thread_id: targetPhysicalThread.id
    };

    handoffSummariesById.set(summary.id, nextSummary);
    const updatedTargetPhysicalThread = normalizePhysicalThread(
      {
        ...targetPhysicalThread,
        codex_thread_id: targetCodexThreadId,
        handoff_summary_id: summary.id
      },
      rootThread
    );
    physicalThreadStateById.set(targetPhysicalThread.id, updatedTargetPhysicalThread);
    activatePhysicalThread(rootThreadId, updatedTargetPhysicalThread.id);
    const nextRootThread = threadStateById.get(rootThreadId);

    if (nextRootThread) {
      threadStateById.set(rootThreadId, {
        ...nextRootThread,
        rollover_count: Number(nextRootThread.rollover_count ?? 0) + 1,
        continuity_status: "healthy",
        updated_at: now()
      });
    }

    updateIssueCard(activeIssueId, {
      executed_physical_thread_id: updatedTargetPhysicalThread.id,
      status: "running",
      last_event: "rootThread.rollover.completed"
    });

    const continuationStartResult = await startTurnOnPhysicalThread(
      userId,
      rootThreadId,
      updatedTargetPhysicalThread.id,
      activeIssueId,
      (preparedIssue) => buildHandoffPrompt(nextSummary, preparedIssue ?? activeIssue ?? null),
      isPreflight ? "rootThread.rollover.preflight.starting" : "rootThread.rollover.continuation.starting"
    );

    if (!continuationStartResult?.accepted) {
      throw new Error(continuationStartResult?.error ?? "rollover continuation start failed");
    }

    await publishRolloverEvents(
      userId,
      rootThreadId,
      closedSourcePhysicalThread ?? sourcePhysicalThread,
      updatedTargetPhysicalThread,
      nextSummary,
      activeIssue
    );
    rolloverCooldownByRootThreadId.set(rootThreadId, Date.now() + THREAD_CONTEXT_ROLLOVER_COOLDOWN_MS);
    incrementBridgeMetric("root_thread_rollover_total");
    observeBridgeDurationMetric("root_thread_rollover_duration_ms", Date.now() - rolloverStartedAtMs);

    return {
      accepted: true,
      root_thread_id: rootThreadId,
      source_physical_thread_id: sourcePhysicalThread.id,
      target_physical_thread_id: updatedTargetPhysicalThread.id,
      summary_id: nextSummary.id
    };
  } catch (error) {
    incrementBridgeMetric("root_thread_rollover_failed_total");
    observeBridgeDurationMetric("root_thread_rollover_duration_ms", Date.now() - rolloverStartedAtMs);
    const currentRootThread = threadStateById.get(rootThreadId);

    if (currentRootThread) {
      threadStateById.set(rootThreadId, {
        ...currentRootThread,
        continuity_status: "degraded",
        updated_at: now()
      });
    }

    await publishEvent(userId, "rootThread.rollover.failed", {
      root_thread_id: rootThreadId,
      thread_id: rootThreadId,
      source_physical_thread_id: sourcePhysicalThread.id,
      issue_id: activeIssueId,
      error: error.message
    });
    console.error("[OctOP bridge] rollover failed", {
      ...buildLogContext({
        root_thread_id: rootThreadId,
        physical_thread_id: sourcePhysicalThread.id,
        source_physical_thread_id: sourcePhysicalThread.id,
        codex_thread_id: sourcePhysicalThread.codex_thread_id ?? null,
        issue_id: activeIssueId,
        event_type: "rootThread.rollover.failed"
      }),
      error: error.message
    });
    throw error;
  } finally {
    rolloverLocksByRootThreadId.delete(rootThreadId);
  }
}

async function maybeTriggerContextRollover(userId, rootThreadId, reason = "threshold", options = {}) {
  const preconditions = validateRolloverPreconditions(rootThreadId, options);

  if (!preconditions.ok) {
    return preconditions;
  }

  return performContextRollover(userId, rootThreadId, reason, options);
}

function refreshQueuePositions(userId) {
  const state = ensureUserState(userId);
  const queue = ensurePendingQueue(userId);

  for (const threadId of state.threadIds) {
    const current = threadStateById.get(threadId);

    if (!current) {
      continue;
    }

    const queueIndex = queue.indexOf(threadId);
    const nextPosition = queueIndex >= 0 ? queueIndex + 1 : null;

    if ((current.queue_position ?? null) === nextPosition) {
      continue;
    }

    upsertThreadState(threadId, {
      ...current,
      queue_position: nextPosition
    });
  }
}

async function publishSnapshots(loginId) {
  const state = ensureUserState(loginId);
  state.updated_at = now();

  await publishEvent(loginId, "bridge.status.updated", await bridgeStatus(loginId));
  await publishEvent(loginId, "bridge.projects.updated", { projects: state.projects });
  await publishEvent(loginId, "bridge.todoChats.updated", {
    chats: listTodoChats(loginId)
  });
  await publishEvent(loginId, "bridge.projectThreads.updated", {
    scope: "all",
    threads: listProjectThreads(loginId)
  });
}

async function publishBridgeStatusUpdates({ ensureReady = false } = {}) {
  for (const loginId of listKnownLoginIds()) {
    await publishEvent(loginId, "bridge.status.updated", await bridgeStatus(loginId, { ensureReady }));
  }
}

async function publishSnapshotsToKnownUsers() {
  for (const loginId of listKnownLoginIds()) {
    await publishSnapshots(loginId);
  }
}

async function publishProjectionRecoverySnapshots(loginId) {
  const normalized = sanitizeUserId(loginId);
  await publishSnapshots(normalized);

  for (const thread of listProjectThreads(normalized)) {
    await publishEvent(normalized, "bridge.threadIssues.updated", {
      thread_id: thread.id,
      issues: listThreadIssuesForClient(thread.id)
    });
    await publishEvent(normalized, "logicalThread.timeline.updated", {
      root_thread_id: thread.id,
      thread_id: thread.id,
      entries: listThreadTimeline(thread.id)
    });
    await publishEvent(normalized, "bridge.threadContinuity.updated", {
      thread_id: thread.id,
      ...getThreadContinuity(normalized, thread.id)
    });
  }

  for (const chat of listTodoChats(normalized)) {
    await publishEvent(normalized, "bridge.todoMessages.updated", getTodoMessagesResponse(normalized, chat.id));
  }
}

async function publishProjectionRecoverySnapshotsToKnownUsers(trigger = "unspecified") {
  for (const loginId of listKnownLoginIds()) {
    await publishProjectionRecoverySnapshots(loginId);
  }

  if (!nc.isClosed()) {
    await nc.flush();
  }

  console.log("[OctOP bridge] NATS projection recovery snapshots published", {
    trigger,
    login_ids: listKnownLoginIds()
  });
}

function scheduleNatsProjectionReplay(trigger = "unspecified") {
  if (natsProjectionReplayPromise) {
    return natsProjectionReplayPromise;
  }

  natsProjectionReplayPromise = (async () => {
    try {
      await publishProjectionRecoverySnapshotsToKnownUsers(trigger);
    } catch (error) {
      console.warn("[OctOP bridge] failed to publish NATS projection recovery snapshots", {
        trigger,
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      natsProjectionReplayPromise = null;
    }
  })();

  return natsProjectionReplayPromise;
}

function startNatsStatusMonitor(connection = nc) {
  void (async () => {
    for await (const status of connection.status()) {
      if (connection !== nc) {
        return;
      }

      const type = String(status?.type ?? "").trim();

      if (!type) {
        continue;
      }

      if (type === "disconnect" || type === "reconnecting" || type === "reconnect") {
        console.warn("[OctOP bridge] NATS status changed", {
          type,
          data: status?.data ?? null
        });
      }

      if (type === "reconnect") {
        void scheduleNatsProjectionReplay("nats_reconnect");
      }
    }
  })().catch((error) => {
    console.warn("[OctOP bridge] NATS status monitor stopped", {
      message: error instanceof Error ? error.message : String(error)
    });
  });
}

function resolveLocalThreadId(threadReference) {
  const candidate = String(threadReference ?? "").trim();

  if (!candidate) {
    return null;
  }

  if (threadStateById.has(candidate)) {
    return candidate;
  }

  if (physicalThreadStateById.has(candidate)) {
    return physicalThreadStateById.get(candidate)?.root_thread_id ?? null;
  }

  const mappedPhysicalThreadId = resolvePhysicalThreadIdByCodexThreadId(candidate);

  if (mappedPhysicalThreadId) {
    return physicalThreadStateById.get(mappedPhysicalThreadId)?.root_thread_id ?? null;
  }

  const mappedThreadId = codexThreadToThreadId.get(candidate);

  if (mappedThreadId) {
    return mappedThreadId;
  }

  for (const [threadId, thread] of threadStateById.entries()) {
    if (thread?.codex_thread_id === candidate) {
      codexThreadToThreadId.set(candidate, threadId);
      return threadId;
    }
  }

  return null;
}

function tryRebindOwnerlessCodexThread(codexThreadId) {
  const candidate = String(codexThreadId ?? "").trim();

  if (!candidate) {
    return null;
  }

  const resolvedPhysicalThreadId = resolvePhysicalThreadIdByCodexThreadId(candidate);
  const resolvedThreadId = resolveLocalThreadId(candidate);

  if (resolvedPhysicalThreadId || resolvedThreadId) {
    return {
      threadId:
        resolvedThreadId ??
        physicalThreadStateById.get(resolvedPhysicalThreadId)?.root_thread_id ??
        null,
      physicalThreadId: resolvedPhysicalThreadId ?? null,
      rebound: false
    };
  }

  for (const [threadId, activeIssueId] of activeIssueByThreadId.entries()) {
    const rootThread = threadStateById.get(threadId);
    const activeIssue = issueCardsById.get(activeIssueId);
    const activePhysicalThread = getActivePhysicalThread(threadId);
    const meta = runningIssueMetaByThreadId.get(threadId);

    if (
      !rootThread ||
      !activeIssue ||
      !activePhysicalThread ||
      rootThread.deleted_at ||
      activeIssue.deleted_at ||
      activePhysicalThread.deleted_at ||
      activePhysicalThread.closed_at
    ) {
      continue;
    }

    if (rootThread.continuity_status !== "degraded") {
      continue;
    }

    if (!["running", "awaiting_input"].includes(activeIssue.status ?? rootThread.status ?? "")) {
      continue;
    }

    if (String(meta?.lastSeenCodexThreadId ?? "").trim() !== candidate) {
      continue;
    }

    const nextPhysicalThread = {
      ...activePhysicalThread,
      codex_thread_id: candidate,
      updated_at: now(),
      last_event: "physicalThread.binding.rebound"
    };

    physicalThreadStateById.set(activePhysicalThread.id, nextPhysicalThread);
    codexThreadToPhysicalThreadId.set(candidate, activePhysicalThread.id);
    codexThreadToThreadId.set(candidate, threadId);

    const nextRootThread = {
      ...rootThread,
      codex_thread_id: candidate,
      active_physical_thread_id: activePhysicalThread.id,
      updated_at: now(),
      last_event: "thread.binding.rebound"
    };

    threadStateById.set(threadId, nextRootThread);
    persistThreadById(threadId);

    console.warn("[OctOP bridge] rebound ownerless codex thread binding", {
      ...buildLogContext({
        root_thread_id: threadId,
        physical_thread_id: activePhysicalThread.id,
        codex_thread_id: candidate,
        event_type: "thread.binding.rebound"
      }),
      rebound_reason: "degraded_running_issue_last_seen_match"
    });

    return {
      threadId,
      physicalThreadId: activePhysicalThread.id,
      rebound: true
    };
  }

  return null;
}

function resolveOwnerFromParams(params = {}) {
  const codexThreadId = params.threadId ?? params.thread?.id ?? params.conversationId ?? params.thread_id;

  if (!codexThreadId) {
    return null;
  }

  const threadId = resolveLocalThreadId(codexThreadId);

  if (!threadId) {
    return null;
  }

  return threadOwners.get(threadId) ?? null;
}

function isContinuityRecoverySignal(method, params = {}) {
  switch (method) {
    case "thread/started":
    case "thread/tokenUsage/updated":
    case "turn/started":
    case "turn/plan/updated":
    case "turn/diff/updated":
    case "item/agentMessage/delta":
    case "turn/completed":
      return true;
    case "thread/status/changed":
      return String(params.status?.type ?? "").trim() !== "error";
    default:
      return false;
  }
}

function recoverDegradedThreadContinuity(threadId, method, params = {}, activeIssueId = null) {
  const rootThread = threadStateById.get(threadId);

  if (!rootThread || rootThread.deleted_at || rootThread.continuity_status !== "degraded") {
    return false;
  }

  if (!isContinuityRecoverySignal(method, params)) {
    return false;
  }

  const activePhysicalThread = getActivePhysicalThread(threadId);
  const issueId = activeIssueId ?? activeIssueByThreadId.get(threadId) ?? null;
  const activeIssue = issueId ? issueCardsById.get(issueId) ?? null : null;
  const recoveredMessage =
    String(activePhysicalThread?.last_message ?? "").trim() ||
    (activeIssue?.last_event !== "watchdog.degraded"
      ? String(activeIssue?.last_message ?? "").trim()
      : "");

  threadStateById.set(threadId, {
    ...rootThread,
    continuity_status: "healthy",
    last_event: method.replaceAll("/", "."),
    last_message: recoveredMessage,
    updated_at: now()
  });

  if (activeIssue && !isIssueTerminalStatus(activeIssue.status) && activeIssue.last_event === "watchdog.degraded") {
    updateIssueCard(issueId, {
      last_event: "watchdog.recovered",
      ...(recoveredMessage ? { last_message: recoveredMessage } : {})
    });
  }

  updateProjectThreadSnapshot(threadId);
  persistThreadById(threadId);
  return true;
}

function buildRemoteNotificationPayload(method, params = {}, context = {}) {
  const remotePayload = buildCompactRemoteNotificationPayload(method, params);

  if (context.codexThreadId && !remotePayload.codex_thread_id) {
    remotePayload.codex_thread_id = context.codexThreadId;
  }

  if (context.threadId) {
    remotePayload.thread_id = context.threadId;
  }

  if (context.rootThreadId && !remotePayload.root_thread_id) {
    remotePayload.root_thread_id = context.rootThreadId;
  }

  if (context.physicalThreadId && !remotePayload.physical_thread_id) {
    remotePayload.physical_thread_id = context.physicalThreadId;
  }

  if (context.projectId) {
    remotePayload.project_id = context.projectId;
  }

  if (context.issueId) {
    remotePayload.issue_id = context.issueId;
  }

  if (context.issueStatus) {
    remotePayload.issue_status = context.issueStatus;
  }

  return remotePayload;
}

const orderedBridgeEventQueueByKey = new Map();

function resolveOrderedBridgeEventQueueKey(context = {}) {
  const normalizedThreadId = String(context.threadId ?? context.rootThreadId ?? "").trim();

  if (normalizedThreadId) {
    return `thread:${normalizedThreadId}`;
  }

  const normalizedPhysicalThreadId = String(context.physicalThreadId ?? "").trim();

  if (normalizedPhysicalThreadId) {
    const rootThreadId = physicalThreadStateById.get(normalizedPhysicalThreadId)?.root_thread_id ?? null;

    if (rootThreadId) {
      return `thread:${rootThreadId}`;
    }

    return `physical:${normalizedPhysicalThreadId}`;
  }

  const normalizedCodexThreadId = String(context.codexThreadId ?? "").trim();

  if (normalizedCodexThreadId) {
    const resolvedPhysicalThreadId = resolvePhysicalThreadIdByCodexThreadId(normalizedCodexThreadId);
    const rootThreadId =
      (resolvedPhysicalThreadId
        ? physicalThreadStateById.get(resolvedPhysicalThreadId)?.root_thread_id ?? null
        : null) ??
      resolveLocalThreadId(normalizedCodexThreadId);

    if (rootThreadId) {
      return `thread:${rootThreadId}`;
    }

    return `codex:${normalizedCodexThreadId}`;
  }

  const owner = String(context.owner ?? BRIDGE_OWNER_LOGIN_ID ?? "global").trim() || "global";
  return `global:${owner}`;
}

async function enqueueOrderedBridgeEvent(context = {}, handler = async () => {}) {
  const queueKey = resolveOrderedBridgeEventQueueKey(context);
  const previous = orderedBridgeEventQueueByKey.get(queueKey) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => handler());
  const tracked = next.finally(() => {
    if (orderedBridgeEventQueueByKey.get(queueKey) === tracked) {
      orderedBridgeEventQueueByKey.delete(queueKey);
    }
  });

  orderedBridgeEventQueueByKey.set(queueKey, tracked);
  return tracked;
}

function buildCompactRemoteNotificationPayload(method, params = {}) {
  switch (method) {
    case "thread/started":
      return {
        thread: params.thread?.id ? { id: params.thread.id } : undefined
      };
    case "thread/status/changed":
      return {
        status: params.status?.type
          ? {
              type: params.status.type,
              ...(params.status?.message ? { message: truncateNotificationText(params.status.message, 4000) } : {})
            }
          : undefined
      };
    case "thread/tokenUsage/updated":
      return {
        tokenUsage: compactTokenUsage(params.tokenUsage ?? params.token_usage ?? null)
      };
    case "turn/started":
    case "turn/completed":
      return {
        turn: params.turn
          ? {
              id: params.turn.id ?? null,
              status: params.turn.status ?? null,
              ...(params.turn?.error?.message
                ? {
                    error: {
                      message: truncateNotificationText(params.turn.error.message, 4000)
                    }
                  }
                : {})
            }
          : undefined
      };
    case "item/agentMessage/delta":
      return {
        delta: String(params.delta ?? "")
      };
    case "turn/plan/updated":
    case "turn/diff/updated":
      return {};
    default:
      return compactGenericNotificationPayload(params);
  }
}

function compactTokenUsage(tokenUsage) {
  if (!tokenUsage || typeof tokenUsage !== "object") {
    return null;
  }

  return {
    inputTokens: numericOrNull(tokenUsage.inputTokens ?? tokenUsage.input_tokens),
    outputTokens: numericOrNull(tokenUsage.outputTokens ?? tokenUsage.output_tokens),
    totalTokens: numericOrNull(tokenUsage.totalTokens ?? tokenUsage.total_tokens),
    contextWindowTokens: numericOrNull(
      tokenUsage.contextWindowTokens ?? tokenUsage.context_window_tokens
    ),
    contextUsedTokens: numericOrNull(
      tokenUsage.contextUsedTokens ??
        tokenUsage.context_used_tokens ??
        tokenUsage.contextTokens ??
        tokenUsage.context_tokens
    ),
    contextUsagePercent: numericOrNull(
      tokenUsage.contextUsagePercent ?? tokenUsage.context_usage_percent
    )
  };
}

function compactGenericNotificationPayload(params = {}) {
  const compact = {};

  if (params.thread?.id) {
    compact.thread = { id: params.thread.id };
  }

  if (params.status?.type) {
    compact.status = { type: params.status.type };
  }

  if (params.turn) {
    compact.turn = {
      id: params.turn.id ?? null,
      status: params.turn.status ?? null
    };
  }

  if (params.delta) {
    compact.delta = truncateNotificationText(params.delta, 16000);
  }

  if (params.conversationId) {
    compact.conversationId = params.conversationId;
  }

  if (params.threadId) {
    compact.threadId = params.threadId;
  }

  if (params.thread_id) {
    compact.thread_id = params.thread_id;
  }

  if (params.root_thread_id) {
    compact.root_thread_id = params.root_thread_id;
  }

  if (params.physical_thread_id) {
    compact.physical_thread_id = params.physical_thread_id;
  }

  return compact;
}

function truncateNotificationText(value, maxLength = 16000) {
  const text = String(value ?? "");

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}…[truncated ${text.length - maxLength} chars]`;
}

function numericOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function formatAccount(accountInfo) {
  if (!accountInfo?.account && !accountInfo?.requiresOpenaiAuth && !accountInfo?.rateLimits) {
    return null;
  }

  return {
    type: accountInfo?.account?.type ?? null,
    email: accountInfo?.account?.email ?? null,
    plan_type: accountInfo?.account?.planType ?? null,
    requires_openai_auth: Boolean(accountInfo.requiresOpenaiAuth),
    rate_limits: accountInfo.rateLimits ?? null
  };
}

function getAppServerAuthenticationError(account) {
  if (!account?.requires_openai_auth) {
    return null;
  }

  const accountType = String(account?.type ?? "").trim();
  const hasSignedInAccount = Boolean(
    (String(account?.email ?? "").trim() && accountType) ||
    accountType === "apiKey"
  );

  if (hasSignedInAccount) {
    return null;
  }

  return "codex app-server 인증이 필요합니다. WSL에서 `codex login`을 완료한 뒤 bridge와 app-server를 다시 시작하세요.";
}

class AppServerClient {
  constructor() {
    this.child = null;
    this.socket = null;
    this.requests = new Map();
    this.connected = false;
    this.initialized = false;
    this.lastError = null;
    this.lastStartedAt = null;
    this.account = null;
    this.readyPromise = null;
    this.lastReadyReason = null;
    this.socketConnectAttempt = 0;
    this.heartbeatTimer = null;
    this.lastSocketActivityAt = 0;
    this.heartbeatProbeSentAt = 0;
    this.heartbeatTimeoutCount = 0;
    this.lastSilentStateCheckAt = 0;
    this.lastSilentStateCheckError = null;
    this.silentStateCheckPromise = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
  }

  async ensureReady(reason = "unspecified") {
    if (this.connected && this.initialized && this.socket?.readyState === WebSocket.OPEN) {
      this.assertUsable();
      return this;
    }

    if (this.readyPromise) {
      return this.readyPromise;
    }

    this.lastReadyReason = reason;
    console.warn("[OctOP bridge] app-server ensureReady triggered", {
      reason,
      connected: this.connected,
      initialized: this.initialized,
      socket_state: describeWebSocketReadyState(this.socket?.readyState),
      last_error: this.lastError
    });

    this.readyPromise = this.start(reason)
      .catch((error) => {
        this.lastError = error.message;
        this.scheduleReconnect(`ensureReady:${reason}`);
        throw error;
      })
      .finally(() => {
        this.readyPromise = null;
      });

    return this.readyPromise;
  }

  async start(reason = "unspecified") {
    await this.startProcess(reason);
    await this.connectSocket(reason);
    await this.requestInternal("initialize", {
      clientInfo: {
        name: "octop-bridge",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
    this.notify("initialized", {});
    const accountInfo = await this.requestInternal("account/read", { refreshToken: false });
    this.account = formatAccount(accountInfo.result ?? accountInfo);
    appendDiagnosticLog("info", "app_server.account.read", "app-server account/read completed", {
      reason,
      raw_account_info: accountInfo.result ?? accountInfo,
      formatted_account: this.account,
      env_home: process.env.HOME ?? null,
      env_user: process.env.USER ?? process.env.LOGNAME ?? null,
      os_home: os.homedir(),
      app_server_command: APP_SERVER_COMMAND
    });
    this.initialized = true;
    this.lastError = getAppServerAuthenticationError(this.account);
    this.lastStartedAt = now();
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    await publishBridgeStatusUpdates({ ensureReady: false });
    console.log("[OctOP bridge] app-server ready", {
      reason,
      account_email: this.account?.email ?? null,
      account_type: this.account?.type ?? null
    });
    queueMicrotask(() => {
      void backfillRequestedRunningIssues(`ready:${reason}`);
    });
    return this;
  }

  assertUsable() {
    const authenticationError = getAppServerAuthenticationError(this.account);

    if (authenticationError) {
      this.lastError = authenticationError;
      appendDiagnosticLog("error", "app_server.auth_required", "app-server requires authentication", {
        account: this.account,
        env_home: process.env.HOME ?? null,
        env_user: process.env.USER ?? process.env.LOGNAME ?? null,
        os_home: os.homedir(),
        app_server_command: APP_SERVER_COMMAND
      });
      throw new Error(authenticationError);
    }
  }

  async startProcess(reason = "unspecified") {
    if (!APP_SERVER_AUTOSTART) {
      return;
    }

    if (this.child && this.child.exitCode === null) {
      return;
    }

    console.warn("[OctOP bridge] starting app-server process", {
      reason,
      command: APP_SERVER_COMMAND
    });
    this.child = spawn(APP_SERVER_COMMAND, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    this.child.stdout.on("data", (chunk) => {
      process.stdout.write(`[app-server] ${chunk.toString()}`);
    });
    this.child.stderr.on("data", (chunk) => {
      process.stderr.write(`[app-server] ${chunk.toString()}`);
    });
    this.child.on("exit", (code, signal) => {
      this.resetSocketState();
      this.lastError = code === 0 ? null : `app-server exited (${code ?? signal ?? "unknown"})`;
      appendDiagnosticLog("error", "app_server.process.exit", "app-server process exited", {
        code: code ?? null,
        signal: signal ?? null,
        last_ready_reason: this.lastReadyReason
      });
      console.warn("[OctOP bridge] app-server process exited", {
        code: code ?? null,
        signal: signal ?? null,
        last_ready_reason: this.lastReadyReason
      });
      void publishBridgeStatusUpdates({ ensureReady: false }).catch((error) => {
        console.warn("[OctOP bridge] failed to publish bridge status after app-server exit", {
          message: error.message
        });
      });
    });
    this.child.on("error", (error) => {
      this.lastError = error.message;
      appendDiagnosticLog("error", "app_server.process.error", "app-server process error", {
        error,
        last_ready_reason: this.lastReadyReason
      });
      console.error("[OctOP bridge] app-server process error", {
        message: error.message,
        last_ready_reason: this.lastReadyReason
      });
      void publishBridgeStatusUpdates({ ensureReady: false }).catch((publishError) => {
        console.warn("[OctOP bridge] failed to publish bridge status after app-server error", {
          message: publishError.message
        });
      });
    });
  }

  async connectSocket(reason = "unspecified") {
    const startedAt = Date.now();

    while (Date.now() - startedAt < APP_SERVER_STARTUP_TIMEOUT_MS) {
      try {
        await this.openWebSocket(reason);
        return;
      } catch (error) {
        this.lastError = error.message;
        console.warn("[OctOP bridge] app-server websocket open failed", {
          reason,
          message: error.message
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    throw new Error(`app-server 연결에 실패했습니다: ${this.lastError ?? "timeout"}`);
  }

  async openWebSocket(reason = "unspecified") {
    await new Promise((resolve, reject) => {
      const attempt = ++this.socketConnectAttempt;
      console.warn("[OctOP bridge] opening app-server websocket", {
        reason,
        attempt,
        url: APP_SERVER_WS_URL
      });
      const ws = new WebSocket(APP_SERVER_WS_URL);
      let settled = false;

      const cleanup = () => {
        ws.off("open", handleOpen);
        ws.off("error", handleError);
      };
      const handleOpen = () => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        this.socket = ws;
        this.connected = true;
        this.markSocketActivity();
        console.log("[OctOP bridge] app-server websocket connected", {
          reason,
          attempt
        });
        this.startHeartbeat(ws, { reason, attempt });
        ws.on("message", (payload) => this.handleMessage(payload));
        ws.on("ping", () => {
          this.markSocketActivity();
        });
        ws.on("pong", () => {
          this.markSocketActivity();
        });
        ws.on("close", (code, closeReasonBuffer) => {
          this.resetSocketState(ws, "app-server socket closed");
          const closeReason = normalizeWebSocketCloseReason(closeReasonBuffer);
          this.lastError = formatAppServerSocketCloseError(code, closeReason);
          requestRunningIssueBackfill(`close:${code || "unknown"}`);
          appendDiagnosticLog("error", "app_server.websocket.close", "app-server websocket closed", {
            reason,
            attempt,
            code,
            close_reason: closeReason,
            pending_requests: this.requests.size,
            last_ready_reason: this.lastReadyReason
          });
          console.warn("[OctOP bridge] app-server websocket closed", {
            reason,
            attempt,
            code,
            close_reason: closeReason,
            pending_requests: this.requests.size
          });
          void publishBridgeStatusUpdates({ ensureReady: false }).catch((error) => {
            console.warn("[OctOP bridge] failed to publish bridge status after websocket close", {
              message: error.message
            });
          });
          this.scheduleReconnect(`close:${code || "unknown"}`);
        });
        ws.on("error", (error) => {
          this.connected = false;
          this.lastError = describeWebSocketErrorEvent(error);
          appendDiagnosticLog("error", "app_server.websocket.error", "app-server websocket error", {
            reason,
            attempt,
            error
          });
          console.error("[OctOP bridge] app-server websocket error", {
            reason,
            attempt,
            detail: describeWebSocketErrorEvent(error)
          });
          void publishBridgeStatusUpdates({ ensureReady: false }).catch((publishError) => {
            console.warn("[OctOP bridge] failed to publish bridge status after websocket error", {
              message: publishError.message
            });
          });
        });
        resolve();
      };
      const handleError = (error) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        reject(
          new Error(
            `WebSocket open failed (${describeWebSocketErrorEvent(error)})`
          )
        );
      };

      ws.once("open", handleOpen);
      ws.once("error", handleError);
    });
  }

  handleMessage(payload) {
    this.markSocketActivity();
    const data = JSON.parse(extractWebSocketMessageText(payload));

    if (data.id) {
      const pending = this.requests.get(String(data.id));

      if (!pending) {
        return;
      }

      this.requests.delete(String(data.id));

      if (data.error) {
        pending.reject(new Error(data.error.message ?? "app-server request failed"));
        return;
      }

      pending.resolve(data);
      return;
    }

    if (!data.method) {
      return;
    }

    const params = data.params ?? {};
    const codexThreadId =
      params.thread?.id ??
      params.threadId ??
      params.conversationId ??
      params.thread_id ??
      null;

    void enqueueOrderedBridgeEvent({
      owner: resolveOwnerFromParams(params),
      rootThreadId: params.root_thread_id ?? null,
      physicalThreadId: params.physical_thread_id ?? null,
      codexThreadId
    }, () => this.handleNotification(data.method, params)).catch((error) => {
      this.lastError = error.message;
      appendDiagnosticLog("error", "app_server.notification.failed", "app-server notification handling failed", {
        method: data.method,
        params,
        error
      });
      console.error("[OctOP bridge] app-server notification handling failed", {
        method: data.method,
        message: error.message
      });
    });
  }

  async handleNotification(method, params) {
    if (method === "account/rateLimits/updated") {
      this.account = {
        ...(this.account ?? {}),
        rate_limits: params.rateLimits ?? null
      };

      await publishBridgeStatusUpdates({ ensureReady: false });

      return;
    }

    if (method === "skills/changed") {
      if (BRIDGE_OWNER_LOGIN_ID) {
        await publishEvent(
          BRIDGE_OWNER_LOGIN_ID,
          "bridge.status.updated",
          await bridgeStatus(BRIDGE_OWNER_LOGIN_ID)
        );
      }

      return;
    }

    cleanupExpiredEventDropTombstones();

    const codexThreadId = params.thread?.id ?? params.threadId ?? params.conversationId ?? params.thread_id ?? null;
    let physicalThreadId =
      params.physical_thread_id ??
      resolvePhysicalThreadIdByCodexThreadId(codexThreadId) ??
      null;
    let threadId =
      params.root_thread_id ??
      (physicalThreadId ? physicalThreadStateById.get(physicalThreadId)?.root_thread_id ?? null : null) ??
      resolveLocalThreadId(codexThreadId);
    const reboundBinding =
      !threadId && !physicalThreadId && codexThreadId
        ? tryRebindOwnerlessCodexThread(codexThreadId)
        : null;

    if (reboundBinding) {
      physicalThreadId = reboundBinding.physicalThreadId ?? physicalThreadId;
      threadId = reboundBinding.threadId ?? threadId;
    }
    let owner = threadId ? threadOwners.get(threadId) ?? null : resolveOwnerFromParams(params);
    let eventPatch = null;
    let issuePatch = null;
    const activeIssueId = physicalThreadId
      ? activeIssueByPhysicalThreadId.get(physicalThreadId) ?? activeIssueByThreadId.get(threadId) ?? null
      : threadId
        ? activeIssueByThreadId.get(threadId) ?? null
        : null;
    const ignoreTerminalThreadStatusChanged =
      method === "thread/status/changed" &&
      threadId &&
      isTerminalThreadStatusType(params.status?.type) &&
      !shouldApplyTerminalThreadStatusChanged(params, threadId, physicalThreadId);

    if (
      (physicalThreadId && closedPhysicalThreadTombstonesById.has(physicalThreadId)) ||
      (threadId && deletedRootThreadTombstonesById.has(threadId)) ||
      (physicalThreadId && isPhysicalThreadClosed(physicalThreadId)) ||
      (threadId && isRootThreadDeleted(threadId))
    ) {
      const dropReason = physicalThreadId && isPhysicalThreadClosed(physicalThreadId)
        ? "physical_thread_closed"
        : threadId && isRootThreadDeleted(threadId)
          ? "root_thread_deleted"
          : physicalThreadId && closedPhysicalThreadTombstonesById.has(physicalThreadId)
            ? "physical_thread_tombstone"
            : "root_thread_tombstone";
      incrementBridgeMetric("late_event_drop_total");

      console.warn("[OctOP bridge] app-server notification dropped", {
        ...buildLogContext({
          root_thread_id: threadId,
          physical_thread_id: physicalThreadId,
          codex_thread_id: codexThreadId,
          event_type: method,
          drop_reason: dropReason
        }),
        method
      });
      return;
    }

    if (threadId) {
      if (
        method === "thread/started" ||
        (method === "thread/status/changed" && !ignoreTerminalThreadStatusChanged) ||
        method === "thread/tokenUsage/updated" ||
        method === "turn/started" ||
        method === "turn/plan/updated" ||
        method === "turn/diff/updated" ||
        method === "item/agentMessage/delta"
      ) {
        markRunningIssueActivity(threadId, {
          reconcileAttempts: 0,
          missingRemoteAttempts: 0,
          noProgressBackfillCount: 0,
          backfillRequestedAt: null,
          backfillTrigger: null,
          backfillLastError: null,
          backfillLastPolledAt: now(),
          ...(codexThreadId ? { lastSeenCodexThreadId: codexThreadId } : {})
        });
      }

      if (ignoreTerminalThreadStatusChanged) {
        appendDiagnosticLog("info", "thread.status.changed.ignored", "ignored terminal thread/status/changed due to turn mismatch", {
          thread_id: threadId,
          physical_thread_id: physicalThreadId,
          issue_id: activeIssueId,
          codex_thread_id: codexThreadId,
          status_type: params.status?.type ?? null,
          event_turn_id: extractNotificationTurnId(params),
          tracked_turn_id: getTrackedExecutionTurnId(threadId, physicalThreadId)
        });
      }

      eventPatch = buildThreadPatch(method, params, threadId, physicalThreadId, {
        allowTerminalThreadStatusChange: !ignoreTerminalThreadStatusChanged
      });

      if (eventPatch) {
        const targetPhysicalThread = physicalThreadId ? physicalThreadStateById.get(physicalThreadId) : null;

        if (targetPhysicalThread && physicalThreadId) {
          const nextPhysicalThread = {
            ...targetPhysicalThread,
            ...eventPatch,
            updated_at: eventPatch.updated_at ?? now()
          };

          physicalThreadStateById.set(physicalThreadId, nextPhysicalThread);

          if (method === "thread/tokenUsage/updated") {
            persistThreadById(threadId);
          }

          if (method !== "item/agentMessage/delta") {
            await publishEvent(owner ?? threadOwners.get(threadId) ?? BRIDGE_OWNER_LOGIN_ID, "physicalThread.updated", {
              root_thread_id: threadId,
              physical_thread: nextPhysicalThread
            });
          }
        }

        syncRootThreadFromActivePhysicalThread(threadId);
        updateProjectThreadSnapshot(threadId);
      }

      if (activeIssueId) {
        issuePatch = buildIssuePatch(method, params, activeIssueId, {
          allowTerminalThreadStatusChange: !ignoreTerminalThreadStatusChanged
        });

        if (issuePatch) {
          updateIssueCard(activeIssueId, {
            ...issuePatch,
            ...(physicalThreadId ? { executed_physical_thread_id: physicalThreadId } : {})
          });
        }
      }

      if (shouldInvalidateCodexThreadBindingForFailure(method, params, issuePatch)) {
        invalidateCodexThreadBinding(threadId);
      }

      if (method === "item/agentMessage/delta" && params.delta) {
        const activeIssueId =
          (physicalThreadId ? activeIssueByPhysicalThreadId.get(physicalThreadId) : null) ??
          activeIssueByThreadId.get(threadId);

        if (activeIssueId) {
          appendAssistantDeltaToIssue(activeIssueId, params.delta, physicalThreadId);
        }
      }

      recoverDegradedThreadContinuity(threadId, method, params, activeIssueId);
    }

    if (!owner && (threadId || codexThreadId)) {
      owner = threadId ? threadOwners.get(threadId) ?? null : null;

      if (!owner && BRIDGE_OWNER_LOGIN_ID) {
        owner = BRIDGE_OWNER_LOGIN_ID;
      }
    }

    if (!owner) {
      console.warn("[OctOP bridge] ownerless app-server notification dropped", {
        ...buildLogContext({
          root_thread_id: threadId,
          physical_thread_id: physicalThreadId,
          codex_thread_id: codexThreadId,
          event_type: method,
          drop_reason: "ownerless_notification"
        }),
        method
      });
      return;
    }

    const projectId = threadId ? threadStateById.get(threadId)?.project_id ?? "" : "";
    if (!ignoreTerminalThreadStatusChanged) {
      await publishEvent(
        owner,
        method.replaceAll("/", "."),
        buildRemoteNotificationPayload(method, params, {
          codexThreadId,
          threadId,
          rootThreadId: threadId,
          physicalThreadId,
          projectId,
          issueId: activeIssueId,
          issueStatus:
            issuePatch?.status ??
            (activeIssueId ? issueCardsById.get(activeIssueId)?.status ?? null : null)
        })
      );
    }

    if (threadId && shouldPublishFullThreadSnapshotForNotification(method, eventPatch, issuePatch, params)) {
      await publishEvent(owner, "bridge.projectThreads.updated", {
        scope: projectId ? "project" : "all",
        project_id: projectId,
        threads: listProjectThreads(owner, projectId)
      });
      if (threadId) {
        await publishEvent(owner, "bridge.threadIssues.updated", {
          thread_id: threadId,
          issues: listThreadIssuesForClient(threadId)
        });
        await publishEvent(owner, "logicalThread.timeline.updated", {
          root_thread_id: threadId,
          thread_id: threadId,
          entries: listThreadTimeline(threadId)
        });
      }
    }

    if (
      method === "turn/completed" ||
      (method === "thread/status/changed" &&
        isTerminalThreadStatusType(params.status?.type) &&
        !ignoreTerminalThreadStatusChanged)
    ) {
      if (threadId) {
        if (physicalThreadId) {
          activeIssueByPhysicalThreadId.delete(physicalThreadId);
        }
        clearRunningIssueTracking(threadId);
        void scheduleQueuedIssuesForUser(owner, {
          preferredThreadId: threadId
        });
      }
    }

  }

  notify(method, params) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method,
        params
      })
    );
  }

  requestInternal(method, params) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("app-server socket is not connected");
    }

    const id = randomUUID();
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
      setTimeout(() => {
        if (!this.requests.has(id)) {
          return;
        }

        this.requests.delete(id);
        appendDiagnosticLog("error", "app_server.request.timeout", "app-server request timeout", {
          method,
          params,
          request_id: id,
          socket_state: describeWebSocketReadyState(this.socket?.readyState),
          connected: this.connected,
          initialized: this.initialized,
          last_socket_activity_at: this.lastSocketActivityAt
            ? new Date(this.lastSocketActivityAt).toISOString()
            : null
        });
        requestRunningIssueBackfill(`request_timeout:${method}`);
        this.forceReconnect(this.socket ?? null, `request_timeout:${method}`, {
          method,
          request_id: id,
          last_socket_activity_at: this.lastSocketActivityAt
            ? new Date(this.lastSocketActivityAt).toISOString()
            : null
        });
        reject(new Error(`app-server request timeout: ${method}`));
      }, APP_SERVER_REQUEST_TIMEOUT_MS);
    });
  }

  async request(method, params, reason = method) {
    await this.ensureReady(`request:${reason}`);
    this.assertUsable();
    return this.requestInternal(method, params);
  }

  markSocketActivity() {
    this.lastSocketActivityAt = Date.now();
    this.heartbeatProbeSentAt = 0;
    this.heartbeatTimeoutCount = 0;
    this.lastSilentStateCheckError = null;
  }

  startHeartbeat(ws, context = {}) {
    this.stopHeartbeat();
    this.markSocketActivity();

    if (APP_SERVER_HEARTBEAT_INTERVAL_MS <= 0) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }

      const bridgeIdle = isBridgeIdle();

      const silentForMs = this.lastSocketActivityAt > 0 ? Date.now() - this.lastSocketActivityAt : 0;

      if (this.heartbeatProbeSentAt > 0) {
        const probeAgeMs = Date.now() - this.heartbeatProbeSentAt;

        if (APP_SERVER_HEARTBEAT_TIMEOUT_MS <= 0 || probeAgeMs < APP_SERVER_HEARTBEAT_TIMEOUT_MS) {
          return;
        }

        const timeoutCount = Number(this.heartbeatTimeoutCount ?? 0) + 1;
        this.heartbeatTimeoutCount = timeoutCount;
        console.warn("[OctOP bridge] app-server websocket heartbeat timeout", {
          ...context,
          idle: bridgeIdle,
          timeout_count: timeoutCount,
          timeout_ms: APP_SERVER_HEARTBEAT_TIMEOUT_MS,
          probe_age_ms: probeAgeMs,
          last_activity_at: this.lastSocketActivityAt
            ? new Date(this.lastSocketActivityAt).toISOString()
            : null
        });
        this.heartbeatProbeSentAt = 0;
        void this.checkLastKnownState("heartbeat_timeout", {
          ...context,
          idle: bridgeIdle,
          timeout_count: timeoutCount,
          probe_age_ms: probeAgeMs
        });

        if (
          !bridgeIdle &&
          APP_SERVER_ACTIVE_HEARTBEAT_FORCE_RECONNECT_MISSES > 0 &&
          timeoutCount >= APP_SERVER_ACTIVE_HEARTBEAT_FORCE_RECONNECT_MISSES
        ) {
          this.forceReconnect(ws, "heartbeat_timeout_active", {
            ...context,
            timeout_count: timeoutCount,
            probe_age_ms: probeAgeMs,
            last_activity_at: this.lastSocketActivityAt
              ? new Date(this.lastSocketActivityAt).toISOString()
              : null
          });
        }
        return;
      }

      if (silentForMs < APP_SERVER_HEARTBEAT_INTERVAL_MS) {
        return;
      }

      try {
        this.heartbeatProbeSentAt = Date.now();
        ws.ping();
      } catch (error) {
        this.heartbeatProbeSentAt = 0;
        console.warn("[OctOP bridge] app-server websocket ping failed", {
          ...context,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }, APP_SERVER_HEARTBEAT_INTERVAL_MS);

    this.heartbeatTimer.unref?.();
  }

  async checkLastKnownState(trigger = "unspecified", detail = {}) {
    if (
      !this.connected ||
      !this.initialized ||
      this.socket?.readyState !== WebSocket.OPEN ||
      this.readyPromise
    ) {
      return null;
    }

    if (this.silentStateCheckPromise) {
      return this.silentStateCheckPromise;
    }

    const nowMs = Date.now();

    if (
      APP_SERVER_SILENT_STATE_CHECK_INTERVAL_MS > 0 &&
      this.lastSilentStateCheckAt > 0 &&
      nowMs - this.lastSilentStateCheckAt < APP_SERVER_SILENT_STATE_CHECK_INTERVAL_MS
    ) {
      return null;
    }

    this.lastSilentStateCheckAt = nowMs;
    this.silentStateCheckPromise = (async () => {
      try {
        await recoverSilentBridgeState(`app-server:${trigger}`);
        this.lastSilentStateCheckError = null;
      } catch (error) {
        this.lastSilentStateCheckError = error.message;
        this.lastError = error.message;
        console.warn("[OctOP bridge] silent state check failed", {
          trigger,
          ...detail,
          message: error.message
        });
      } finally {
        this.silentStateCheckPromise = null;
        void publishBridgeStatusUpdates({ ensureReady: false }).catch((publishError) => {
          console.warn("[OctOP bridge] failed to publish bridge status after silent state check", {
            message: publishError.message
          });
        });
      }
    })();

    return this.silentStateCheckPromise;
  }

  stopHeartbeat(ws = null) {
    if (ws && this.socket && this.socket !== ws) {
      return;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.heartbeatProbeSentAt = 0;
    this.heartbeatTimeoutCount = 0;
  }

  resetSocketState(ws = null, reason = "app-server socket closed") {
    this.connected = false;
    this.initialized = false;

    if (!ws || this.socket === ws) {
      this.socket = null;
    }

    this.stopHeartbeat(ws);

    for (const [id, pending] of this.requests) {
      pending.reject(new Error(reason));
      this.requests.delete(id);
    }
  }

  prepareForSystemNetworkRestore(trigger = "system_network") {
    const ws = this.socket;

    this.lastError = `system network restore pending (${trigger})`;

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.resetSocketState(ws, `system network restore pending (${trigger})`);
      return false;
    }

    appendDiagnosticLog("warn", "app_server.websocket.system_network_restore_prepare", "closing stale app-server websocket before system network recovery", {
      trigger,
      pending_requests: this.requests.size,
      last_ready_reason: this.lastReadyReason
    });
    console.warn("[OctOP bridge] closing stale app-server websocket before system network recovery", {
      trigger,
      pending_requests: this.requests.size
    });

    this.resetSocketState(ws, `system network restore pending (${trigger})`);
    void publishBridgeStatusUpdates({ ensureReady: false }).catch((error) => {
      console.warn("[OctOP bridge] failed to publish bridge status while preparing system network recovery", {
        trigger,
        message: error.message
      });
    });

    try {
      if (typeof ws.terminate === "function") {
        ws.terminate();
      } else {
        ws.close();
      }
    } catch (error) {
      console.warn("[OctOP bridge] failed to close stale app-server websocket before system network recovery", {
        trigger,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    return true;
  }

  forceReconnect(ws = null, trigger = "unspecified", detail = {}) {
    if (!ws || this.socket !== ws) {
      return false;
    }

    appendDiagnosticLog("warn", "app_server.websocket.force_reconnect", "forcing app-server websocket reconnect", {
      trigger,
      detail,
      pending_requests: this.requests.size,
      last_ready_reason: this.lastReadyReason
    });
    console.warn("[OctOP bridge] forcing app-server websocket reconnect", {
      trigger,
      pending_requests: this.requests.size,
      ...detail
    });

    this.lastError = `app-server websocket forced reconnect (${trigger})`;
    requestRunningIssueBackfill(`forced_reconnect:${trigger}`);
    this.resetSocketState(ws, `app-server socket forced reconnect (${trigger})`);
    void publishBridgeStatusUpdates({ ensureReady: false }).catch((error) => {
      console.warn("[OctOP bridge] failed to publish bridge status after forced reconnect", {
        trigger,
        message: error.message
      });
    });
    this.scheduleReconnect(`forced:${trigger}`);

    try {
      if (typeof ws.terminate === "function") {
        ws.terminate();
      } else {
        ws.close();
      }
    } catch (error) {
      console.warn("[OctOP bridge] app-server websocket forced reconnect close failed", {
        trigger,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    return true;
  }

  scheduleReconnect(trigger = "unspecified") {

    if (this.reconnectTimer || this.readyPromise) {
      return;
    }

    if (this.connected && this.initialized && this.socket?.readyState === WebSocket.OPEN) {
      return;
    }

    const attempt = this.reconnectAttempt + 1;
    const uncappedDelayMs = APP_SERVER_RECONNECT_DELAY_MS * attempt;
    const delayMs = Math.max(
      100,
      APP_SERVER_RECONNECT_MAX_DELAY_MS > 0
        ? Math.min(APP_SERVER_RECONNECT_MAX_DELAY_MS, uncappedDelayMs)
        : uncappedDelayMs
    );
    this.reconnectAttempt = attempt;
    console.warn("[OctOP bridge] scheduling app-server reconnect", {
      trigger,
      attempt,
      delay_ms: delayMs,
      uncapped_delay_ms: uncappedDelayMs
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureReady(`reconnect:${trigger}`).catch((error) => {
        this.lastError = error.message;
        console.warn("[OctOP bridge] app-server reconnect failed", {
          trigger,
          attempt,
          message: error.message
        });
        this.scheduleReconnect(`retry:${trigger}`);
      });
    }, delayMs);

    this.reconnectTimer.unref?.();
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

function describeWebSocketReadyState(state) {
  switch (state) {
    case WebSocket.CONNECTING:
      return "CONNECTING";
    case WebSocket.OPEN:
      return "OPEN";
    case WebSocket.CLOSING:
      return "CLOSING";
    case WebSocket.CLOSED:
      return "CLOSED";
    default:
      return "UNKNOWN";
  }
}

function formatAppServerSocketCloseError(codeOrEvent, reasonOverride = "") {
  const code =
    typeof codeOrEvent === "number"
      ? codeOrEvent
      : Number.isFinite(codeOrEvent?.code)
        ? codeOrEvent.code
        : "unknown";
  const reason =
    reasonOverride ||
    normalizeWebSocketCloseReason(codeOrEvent?.reason);
  return reason ? `app-server socket closed (${code}: ${reason})` : `app-server socket closed (${code})`;
}

function normalizeWebSocketCloseReason(reason) {
  if (Buffer.isBuffer(reason)) {
    const text = reason.toString("utf8").trim();
    return text || "";
  }

  return String(reason ?? "").trim();
}

function extractWebSocketMessageText(payload) {
  if (typeof payload === "string") {
    return payload;
  }

  if (Buffer.isBuffer(payload)) {
    return payload.toString("utf8");
  }

  if (payload instanceof ArrayBuffer) {
    return Buffer.from(payload).toString("utf8");
  }

  if (Array.isArray(payload)) {
    return Buffer.concat(payload.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))).toString("utf8");
  }

  return String(payload);
}

function describeWebSocketErrorEvent(error) {
  if (!error) {
    return "unknown";
  }

  const details = [];

  if (error.type) {
    details.push(`type=${error.type}`);
  }

  if (typeof error.message === "string" && error.message.trim()) {
    details.push(`message=${error.message.trim()}`);
  }

  return details.join(", ") || "unknown";
}

function extractAppServerErrorMessage(params = {}) {
  const primaryMessage = String(
    params.turn?.error?.message ??
      params.error?.message ??
      params.status?.message ??
      ""
  ).trim();
  const detailMessage = String(
    params.turn?.error?.additionalDetails ?? params.error?.additionalDetails ?? ""
  ).trim();

  if (primaryMessage && detailMessage && !primaryMessage.includes(detailMessage)) {
    return `${primaryMessage}\n${detailMessage}`;
  }

  return primaryMessage || detailMessage || "";
}

function buildThreadPatch(method, params, rootThreadId = null, physicalThreadId = null, options = {}) {
  const codexThreadId = params.thread?.id ?? params.threadId ?? params.conversationId ?? null;
  const resolvedPhysicalThreadId =
    physicalThreadId ??
    resolvePhysicalThreadIdByCodexThreadId(codexThreadId) ??
    null;
  const currentPhysicalThread = resolvedPhysicalThreadId
    ? physicalThreadStateById.get(resolvedPhysicalThreadId) ?? null
    : null;
  const currentStatus = currentPhysicalThread?.status ?? "idle";

  switch (method) {
    case "thread/started":
      return {
        codex_thread_id: params.thread?.id ?? codexThreadId ?? null,
        progress: Math.max(5, currentPhysicalThread?.progress ?? 0),
        status: currentStatus,
        last_event: "thread.started",
        turn_id: currentPhysicalThread?.turn_id ?? null
      };
    case "thread/status/changed":
      {
        if (isTerminalThreadStatusType(params.status?.type) && options.allowTerminalThreadStatusChange === false) {
          return null;
        }

        const nextStatus = normalizeThreadStatus(params.status, currentStatus);
        const nextTurnId = isTerminalThreadStatusType(params.status?.type)
          ? null
          : currentPhysicalThread?.turn_id ?? null;
        const errorMessage = nextStatus === "failed" ? extractAppServerErrorMessage(params) : "";

        if (
          nextStatus === currentStatus &&
          nextTurnId === (currentPhysicalThread?.turn_id ?? null) &&
          (!errorMessage || errorMessage === String(currentPhysicalThread?.last_message ?? "").trim())
        ) {
          return null;
        }

        return {
          status: nextStatus,
          last_event: "thread.status.changed",
          turn_id: nextTurnId,
          ...(errorMessage ? { last_message: errorMessage } : {})
        };
      }
    case "thread/tokenUsage/updated":
      return {
        ...normalizeThreadTokenUsage(params.tokenUsage ?? params.token_usage ?? null, currentPhysicalThread ?? {}),
        updated_at: currentPhysicalThread?.updated_at ?? now()
      };
    case "turn/started":
      return {
        status: "running",
        progress: 20,
        last_event: "turn.started",
        turn_id: params.turn?.id ?? currentPhysicalThread?.turn_id ?? null
      };
    case "turn/plan/updated":
      return {
        status: "running",
        progress: 45,
        last_event: "turn.plan.updated"
      };
    case "turn/diff/updated":
      return {
        status: "running",
        progress: 75,
        last_event: "turn.diff.updated"
      };
    case "item/agentMessage/delta":
      return {
        status: "running",
        progress: 90,
        last_event: "item.agentMessage.delta",
        last_message: `${currentPhysicalThread?.last_message ?? ""}${params.delta ?? ""}`
      };
    case "turn/completed":
      {
        const nextStatus = params.turn?.status === "completed" ? "idle" : "failed";
        const nextProgress = params.turn?.status === "completed" ? 100 : 0;
        const errorMessage = nextStatus === "failed" ? extractAppServerErrorMessage(params) : "";

        if (
          currentPhysicalThread &&
          currentPhysicalThread.status === nextStatus &&
          Number(currentPhysicalThread.progress ?? 0) === nextProgress &&
          currentPhysicalThread.last_event === "turn.completed" &&
          (currentPhysicalThread.turn_id ?? null) === null &&
          (!errorMessage || errorMessage === String(currentPhysicalThread.last_message ?? "").trim())
        ) {
          return null;
        }

        return {
          status: nextStatus,
          progress: nextProgress,
          last_event: "turn.completed",
          turn_id: null,
          ...(errorMessage ? { last_message: errorMessage } : {})
        };
      }
    default:
      return null;
  }
}

function buildIssuePatch(method, params, issueId, options = {}) {
  const current = issueCardsById.get(issueId);

  if (!current) {
    return null;
  }

  if (isIssueTerminalStatus(current.status) && isIssueProgressEvent(method)) {
    return null;
  }

  switch (method) {
    case "turn/started":
      return {
        status: "running",
        progress: Math.max(current.progress ?? 0, 20),
        last_event: "turn.started"
      };
    case "turn/plan/updated":
      return {
        status: "running",
        progress: 45,
        last_event: "turn.plan.updated"
      };
    case "turn/diff/updated":
      return {
        status: "running",
        progress: 75,
        last_event: "turn.diff.updated"
      };
    case "item/agentMessage/delta":
      return {
        status: "running",
        progress: 90,
        last_event: "item.agentMessage.delta",
        last_message: `${current.last_message ?? ""}${params.delta ?? ""}`
      };
    case "thread/status/changed":
      if (isTerminalThreadStatusType(params.status?.type) && options.allowTerminalThreadStatusChange === false) {
        return null;
      }

      if ((params.status?.type ?? "") === "waitingForInput") {
        return {
          status: "awaiting_input",
          last_event: "thread.status.changed"
        };
      }

      if ((params.status?.type ?? "") === "error") {
        const errorMessage = extractAppServerErrorMessage(params);
        return {
          status: "failed",
          progress: 0,
          last_event: "thread.status.changed",
          ...(errorMessage ? { last_message: errorMessage } : {})
        };
      }

      if (isTerminalThreadStatusType(params.status?.type)) {
        const terminalStatus = inferReconciledTerminalStatus(current);
        const errorMessage = terminalStatus === "failed" ? extractAppServerErrorMessage(params) : "";
        return {
          status: terminalStatus,
          progress: terminalStatus === "completed" ? 100 : Math.max(current.progress ?? 0, 0),
          last_event: "thread.status.changed",
          ...(errorMessage ? { last_message: errorMessage } : {})
        };
      }

      return null;
    case "turn/completed":
      {
        const errorMessage = params.turn?.status === "completed" ? "" : extractAppServerErrorMessage(params);
        return {
          status: params.turn?.status === "completed" ? "completed" : "failed",
          progress: params.turn?.status === "completed" ? 100 : 0,
          last_event: "turn.completed",
          ...(errorMessage ? { last_message: errorMessage } : {})
        };
      }
    default:
      return null;
  }
}

function shouldPublishFullThreadSnapshotForNotification(method, eventPatch, issuePatch, params = {}) {
  if (method === "item/agentMessage/delta" && String(params.delta ?? "")) {
    return false;
  }

  return Boolean(eventPatch || issuePatch);
}

function getThreadDetail(userId, threadId) {
  const normalizedUserId = sanitizeUserId(userId);
  const thread = threadStateById.get(threadId);

  if (!thread || threadOwners.get(threadId) !== normalizedUserId) {
    return {
      thread: null,
      messages: []
    };
  }

  return {
    thread,
    messages: []
  };
}

function enqueueThreadsForStart(userId, threadIds = []) {
  const queue = ensurePendingQueue(userId);

  for (const threadId of threadIds) {
    if (!threadId || queue.includes(threadId)) {
      continue;
    }

    queue.push(threadId);
  }

  return queue;
}

function removeThreadFromQueue(userId, threadId) {
  const queue = ensurePendingQueue(userId);
  const index = queue.indexOf(threadId);

  if (index >= 0) {
    queue.splice(index, 1);
  }
}

function deleteThreadState(userId, threadId) {
  const normalized = sanitizeUserId(userId);
  const state = ensureUserState(normalized);
  state.threadIds.delete(threadId);
  removeThreadFromQueue(normalized, threadId);
  threadOwners.delete(threadId);
  threadStateById.delete(threadId);
  threadEventsById.delete(threadId);
  threadMessagesById.delete(threadId);
  persistThreadsForUser(normalized);
}

function hasRunningThread(userId) {
  return listLocalThreads(userId).some((thread) => thread.status === "running");
}

function hasActiveThreadExecution(userId) {
  return listLocalThreads(userId).some((thread) => ["running", "awaiting_input"].includes(thread.status));
}

async function scheduleQueuedIssuesForUser(userId, options = {}) {
  const normalizedUserId = sanitizeUserId(userId);
  const preferredThreadId = String(options.preferredThreadId ?? "").trim() || null;
  const state = ensureUserState(normalizedUserId);
  const candidateThreadIds = [];

  if (
    preferredThreadId &&
    threadOwners.get(preferredThreadId) === normalizedUserId &&
    ensurePendingQueue(preferredThreadId).length > 0
  ) {
    candidateThreadIds.push(preferredThreadId);
  }

  for (const threadId of state.threadIds) {
    if (
      candidateThreadIds.includes(threadId) ||
      threadOwners.get(threadId) !== normalizedUserId ||
      ensurePendingQueue(threadId).length === 0
    ) {
      continue;
    }

    candidateThreadIds.push(threadId);
  }

  const startResults = await Promise.all(
    candidateThreadIds.map(async (threadId) => {
      ensureRunningIssueTrackingForThread(threadId);

      if (activeIssueByThreadId.has(threadId)) {
        return false;
      }

      await processIssueQueue(normalizedUserId, threadId);
      return activeIssueByThreadId.has(threadId);
    })
  );

  const startedThreadIds = candidateThreadIds.filter((threadId, index) => startResults[index] === true);

  return {
    accepted: true,
    started: startedThreadIds.length > 0,
    thread_id: startedThreadIds[0] ?? null,
    started_thread_ids: startedThreadIds,
    blocked_by_thread_id: null
  };
}

function hasLocalLiveExecution() {
  for (const [threadId, issueId] of activeIssueByThreadId.entries()) {
    const thread = threadStateById.get(threadId);
    const issue = issueCardsById.get(issueId);

    if (thread?.deleted_at || issue?.deleted_at) {
      continue;
    }

    if (["running", "awaiting_input"].includes(issue?.status ?? thread?.status ?? "")) {
      return true;
    }
  }

  for (const issue of issueCardsById.values()) {
    if (!issue || issue.deleted_at) {
      continue;
    }

    const thread = threadStateById.get(issue.thread_id);

    if (!thread || thread.deleted_at) {
      continue;
    }

    if (["running", "awaiting_input"].includes(issue.status ?? "")) {
      return true;
    }
  }

  for (const physicalThread of physicalThreadStateById.values()) {
    if (!physicalThread || physicalThread.deleted_at || physicalThread.closed_at) {
      continue;
    }

    const rootThread = threadStateById.get(physicalThread.root_thread_id);

    if (!rootThread || rootThread.deleted_at) {
      continue;
    }

    if (physicalThread.status === "active" || String(physicalThread.turn_id ?? "").trim()) {
      return true;
    }
  }

  return false;
}

function isBridgeIdle() {
  return !hasLocalLiveExecution();
}

const appServer = new AppServerClient();

function listKnownLoginIds() {
  return [...new Set([BRIDGE_OWNER_LOGIN_ID, ...users.keys()].filter(Boolean))];
}

function collectBridgeStatus(userId) {
  const state = ensureUserState(userId);
  const threads = listLocalThreads(userId);

  return {
    bridge_mode: BRIDGE_MODE,
    bridge_id: BRIDGE_ID,
    host_name: HOST_NAME,
    bridge_revision: BRIDGE_REVISION,
    device_name: DEVICE_NAME,
    app_server: {
      mode: APP_SERVER_MODE,
      connected: appServer.connected,
      initialized: appServer.initialized,
      diagnostic_log_path: DIAGNOSTIC_LOG_PATH,
      diagnostic_log_enabled: DIAGNOSTIC_LOG_ENABLED,
      account: appServer.account,
      last_started_at: appServer.lastStartedAt,
      last_error: appServer.lastError,
      last_socket_activity_at: appServer.lastSocketActivityAt
        ? new Date(appServer.lastSocketActivityAt).toISOString()
        : null,
      heartbeat_probe_sent_at: appServer.heartbeatProbeSentAt
        ? new Date(appServer.heartbeatProbeSentAt).toISOString()
        : null,
      last_silent_state_check_at: appServer.lastSilentStateCheckAt
        ? new Date(appServer.lastSilentStateCheckAt).toISOString()
        : null,
      last_silent_state_check_error: appServer.lastSilentStateCheckError,
      idle_only_heartbeat: false,
      heartbeat_interval_ms: APP_SERVER_HEARTBEAT_INTERVAL_MS,
      request_timeout_ms: APP_SERVER_REQUEST_TIMEOUT_MS,
      heartbeat_timeout_ms: APP_SERVER_HEARTBEAT_TIMEOUT_MS,
      heartbeat_timeout_count: appServer.heartbeatTimeoutCount,
      active_heartbeat_force_reconnect_misses: APP_SERVER_ACTIVE_HEARTBEAT_FORCE_RECONNECT_MISSES,
      silent_state_check_interval_ms: APP_SERVER_SILENT_STATE_CHECK_INTERVAL_MS,
      idle: isBridgeIdle()
    },
    nats: {
      connected: !nc.isClosed()
    },
    capabilities: {
      thread_developer_instructions: true
    },
    counts: {
      projects: state.projects.length,
      threads: threads.length
    },
    updated_at: now()
  };
}

async function bridgeStatus(userId, { ensureReady = true } = {}) {
  try {
    if (ensureReady) {
      await appServer.ensureReady("bridgeStatus");
    }
  } catch (error) {
    appServer.lastError = error.message;
  }

  return collectBridgeStatus(userId);
}

async function syncThreadListFromAppServer() {
  const response = await appServer.request(
    "thread/list",
    { limit: THREAD_LIST_LIMIT },
    "thread/list.syncThreadListFromAppServer"
  );
  return response.result?.data ?? [];
}

function requestRunningIssueBackfill(reason = "unspecified") {
  for (const threadId of activeIssueByThreadId.keys()) {
    const meta = runningIssueMetaByThreadId.get(threadId);
    const issueId = activeIssueByThreadId.get(threadId) ?? null;
    const issue = issueId ? issueCardsById.get(issueId) ?? null : null;
    const thread = threadStateById.get(threadId) ?? null;

    if (
      !meta ||
      !issue ||
      !thread ||
      thread.deleted_at ||
      issue.deleted_at ||
      !["running", "awaiting_input"].includes(issue.status)
    ) {
      continue;
    }

    markRunningIssueActivity(threadId, {
      lastActivityAt: meta.lastActivityAt,
      backfillRequestedAt: meta.backfillRequestedAt ?? now(),
      backfillTrigger: reason,
      backfillLastError: null
    });

    if (reason !== "interval") {
      appendDiagnosticLog("info", "running_issue.backfill.requested", "running issue backfill requested", {
        thread_id: threadId,
        issue_id: issueId,
        reason,
        issue_status: issue?.status ?? null,
        continuity_status: thread.continuity_status ?? null,
        backfill_requested_at: meta.backfillRequestedAt ?? now(),
        active_physical_thread_id: issue?.executed_physical_thread_id ?? issue?.created_physical_thread_id ?? thread.active_physical_thread_id ?? null,
        codex_thread_id:
          issue?.executed_physical_thread_id
            ? (physicalThreadStateById.get(issue.executed_physical_thread_id)?.codex_thread_id ?? null)
            : issue?.created_physical_thread_id
              ? (physicalThreadStateById.get(issue.created_physical_thread_id)?.codex_thread_id ?? null)
              : thread.codex_thread_id ?? meta.lastSeenCodexThreadId ?? null,
        last_seen_codex_thread_id: meta.lastSeenCodexThreadId ?? null,
        last_activity_at: meta.lastActivityAt ?? null
      });
    }
  }
}

function clearRunningIssueBackfill(threadId) {
  const meta = runningIssueMetaByThreadId.get(threadId);

  if (!meta) {
    return;
  }

  markRunningIssueActivity(threadId, {
    lastActivityAt: meta.lastActivityAt,
    backfillRequestedAt: null,
    backfillTrigger: null,
    backfillLastError: null,
    backfillLastPolledAt: now(),
    noProgressBackfillCount: 0
  });
}

async function readThreadSnapshotFromAppServer(codexThreadId, reason = "unspecified") {
  const response = await appServer.request(
    "thread/read",
    {
      threadId: codexThreadId,
      includeTurns: true
    },
    `thread/read.${reason}`
  );
  return response.result?.thread ?? response.thread ?? null;
}

function buildThreadReadDebugPatch(reason, remoteThread, remoteTurn, remoteAssistantText, options = {}) {
  const assistantText = String(remoteAssistantText ?? "");
  return {
    lastThreadReadAt: now(),
    lastThreadReadReason: reason,
    lastThreadReadRemoteStatus: normalizeRemoteTurnRuntimeStatus(
      remoteThread,
      remoteTurn,
      options.fallbackStatus ?? "running"
    ),
    lastThreadReadTurnId: remoteTurn?.id ?? null,
    lastThreadReadAssistantLength: assistantText.length,
    lastThreadReadAppendedDeltaLength: Number(options.appendedDeltaLength ?? 0),
    lastThreadReadHadProgress:
      typeof options.hadProgress === "boolean" ? options.hadProgress : null
  };
}

function selectRemoteTurnForBackfill(remoteThread, expectedTurnId = null) {
  const turns = Array.isArray(remoteThread?.turns) ? remoteThread.turns : [];

  if (turns.length === 0) {
    return null;
  }

  if (expectedTurnId) {
    const matchedTurn = turns.find((turn) => String(turn?.id ?? "").trim() === String(expectedTurnId).trim());

    if (matchedTurn) {
      return matchedTurn;
    }
  }

  return turns.at(-1) ?? null;
}

function joinBackfillTextSegments(segments = []) {
  return segments.reduce((combined, segment) => {
    const nextSegment = String(segment ?? "");

    if (!nextSegment) {
      return combined;
    }

    if (!combined) {
      return nextSegment;
    }

    if (combined.endsWith("\n") || nextSegment.startsWith("\n")) {
      return `${combined}${nextSegment}`;
    }

    return `${combined}\n${nextSegment}`;
  }, "");
}

function collectTextFromRemoteMessageContent(content) {
  if (!Array.isArray(content)) {
    return "";
  }

  return joinBackfillTextSegments(
    content
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return "";
        }

        if (typeof entry.text === "string" && entry.text.trim()) {
          return entry.text;
        }

        return "";
      })
      .filter(Boolean)
  );
}

function collectAssistantTextFromRemoteTurn(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  return joinBackfillTextSegments(
    items
      .map((item) => {
        if (!item || typeof item !== "object") {
          return "";
        }

        if (String(item.type ?? "").trim() === "agentMessage") {
          return (
            String(item.text ?? "").trim() ||
            collectTextFromRemoteMessageContent(item.content) ||
            String(item?.agentMessage?.text ?? "").trim()
          );
        }

        if (item.agentMessage && typeof item.agentMessage === "object") {
          return (
            String(item.agentMessage.text ?? "").trim() ||
            collectTextFromRemoteMessageContent(item.agentMessage.content)
          );
        }

        return "";
      })
      .filter(Boolean)
  );
}

function normalizeRemoteTurnRuntimeStatus(remoteThread, turn, fallbackStatus = "running") {
  const turnStatus = String(turn?.status ?? "").trim();

  if (turnStatus === "completed") {
    return "completed";
  }

  if (turnStatus === "failed") {
    return "failed";
  }

  if (turnStatus === "interrupted" || turnStatus === "cancelled" || turnStatus === "canceled") {
    return "failed";
  }

  if (turnStatus === "inProgress" || turnStatus === "running") {
    return "running";
  }

  const threadStatus = normalizeThreadStatus(remoteThread?.status, fallbackStatus);

  if (threadStatus === "awaiting_input") {
    return "awaiting_input";
  }

  if (threadStatus === "failed") {
    return "failed";
  }

  if (threadStatus === "idle" || threadStatus === "completed") {
    return "completed";
  }

  return "running";
}

function updateBackfilledPhysicalThread(rootThreadId, physicalThreadId, patch = {}) {
  if (!physicalThreadId) {
    return null;
  }

  const currentPhysicalThread = physicalThreadStateById.get(physicalThreadId);

  if (!currentPhysicalThread || currentPhysicalThread.deleted_at || currentPhysicalThread.closed_at) {
    return null;
  }

  const nextPhysicalThread = {
    ...currentPhysicalThread,
    ...patch,
    updated_at: patch.updated_at ?? now()
  };

  physicalThreadStateById.set(physicalThreadId, nextPhysicalThread);
  syncRootThreadFromActivePhysicalThread(rootThreadId);
  return nextPhysicalThread;
}

async function publishSyntheticRemoteEvent(userId, method, params, context = {}) {
  await publishEvent(
    userId,
    method.replaceAll("/", "."),
    buildRemoteNotificationPayload(method, params, context)
  );
}

async function backfillRunningIssueFromSnapshot(userId, threadId, reason = "unspecified") {
  const owner = sanitizeUserId(userId);
  const activeIssueId = activeIssueByThreadId.get(threadId) ?? null;
  const meta = runningIssueMetaByThreadId.get(threadId) ?? null;
  const thread = threadStateById.get(threadId) ?? null;
  const issue = activeIssueId ? issueCardsById.get(activeIssueId) ?? null : null;
  const physicalThreadId =
    issue?.executed_physical_thread_id ??
    issue?.created_physical_thread_id ??
    thread?.active_physical_thread_id ??
    null;
  const physicalThread = physicalThreadId ? physicalThreadStateById.get(physicalThreadId) ?? null : null;
  const codexThreadId = String(
    physicalThread?.codex_thread_id ??
    thread?.codex_thread_id ??
    meta?.lastSeenCodexThreadId ??
    ""
  ).trim();

  if (!activeIssueId || !meta || !thread || !issue || thread.deleted_at || issue.deleted_at || !codexThreadId) {
    if (reason !== "interval") {
      appendDiagnosticLog("warn", "running_issue.backfill.skipped", "running issue backfill skipped", {
        thread_id: threadId,
        reason,
        active_issue_id: activeIssueId,
        has_meta: Boolean(meta),
        has_thread: Boolean(thread),
        has_issue: Boolean(issue),
        thread_deleted: Boolean(thread?.deleted_at),
        issue_deleted: Boolean(issue?.deleted_at),
        active_physical_thread_id: issue?.executed_physical_thread_id ?? issue?.created_physical_thread_id ?? thread?.active_physical_thread_id ?? null,
        physical_thread_found: Boolean(physicalThread),
        thread_codex_thread_id: thread?.codex_thread_id ?? null,
        physical_codex_thread_id: physicalThread?.codex_thread_id ?? null,
        last_seen_codex_thread_id: meta?.lastSeenCodexThreadId ?? null
      });
    }
    return { accepted: false, skipped: true };
  }

  if (reason !== "interval") {
    appendDiagnosticLog("info", "running_issue.backfill.started", "running issue backfill started", {
      thread_id: threadId,
      issue_id: activeIssueId,
      reason,
      active_physical_thread_id: physicalThreadId,
      codex_thread_id: codexThreadId,
      issue_status: issue.status ?? null,
      continuity_status: thread.continuity_status ?? null,
      backfill_trigger: meta.backfillTrigger ?? null,
      last_activity_at: meta.lastActivityAt ?? null
    });
  }

  markRunningIssueActivity(threadId, {
    lastActivityAt: meta.lastActivityAt,
    backfillLastPolledAt: now()
  });

  const remoteThread = await readThreadSnapshotFromAppServer(codexThreadId, `runningIssueBackfill:${reason}`);

  if (!remoteThread?.id) {
    throw new Error("thread/read 응답에 thread가 없습니다.");
  }

  return enqueueOrderedBridgeEvent({
    owner,
    threadId,
    rootThreadId: threadId,
    physicalThreadId,
    codexThreadId: remoteThread.id
  }, () => applyRunningIssueBackfillSnapshot(owner, threadId, remoteThread, reason));
}

async function applyRunningIssueBackfillSnapshot(userId, threadId, remoteThread, reason = "unspecified") {
  const owner = sanitizeUserId(userId);
  const activeIssueId = activeIssueByThreadId.get(threadId) ?? null;
  const meta = runningIssueMetaByThreadId.get(threadId) ?? null;
  const thread = threadStateById.get(threadId) ?? null;
  const issue = activeIssueId ? issueCardsById.get(activeIssueId) ?? null : null;
  const physicalThreadId =
    issue?.executed_physical_thread_id ??
    issue?.created_physical_thread_id ??
    thread?.active_physical_thread_id ??
    null;
  const physicalThread = physicalThreadId ? physicalThreadStateById.get(physicalThreadId) ?? null : null;

  if (!remoteThread?.id) {
    throw new Error("thread/read 응답에 thread가 없습니다.");
  }

  if (!activeIssueId || !meta || !thread || !issue || thread.deleted_at || issue.deleted_at) {
    if (reason !== "interval") {
      appendDiagnosticLog("warn", "running_issue.backfill.skipped", "running issue backfill skipped after queue wait", {
        thread_id: threadId,
        reason,
        active_issue_id: activeIssueId,
        has_meta: Boolean(meta),
        has_thread: Boolean(thread),
        has_issue: Boolean(issue),
        thread_deleted: Boolean(thread?.deleted_at),
        issue_deleted: Boolean(issue?.deleted_at),
        remote_thread_id: remoteThread.id
      });
    }
    return { accepted: false, skipped: true };
  }

  const previousComparableState = captureBackfillComparableState(thread, issue, physicalThread);
  const remoteTurn = selectRemoteTurnForBackfill(remoteThread, physicalThread?.turn_id ?? thread.turn_id ?? null);
  const remoteAssistantText = collectAssistantTextFromRemoteTurn(remoteTurn);
  const remoteStatus = normalizeRemoteTurnRuntimeStatus(remoteThread, remoteTurn, issue.status ?? thread.status ?? "running");
  const syncedAssistant = syncAssistantSnapshotToIssue(activeIssueId, remoteAssistantText, physicalThreadId);
  const tokenUsageState = normalizeThreadTokenUsage(
    remoteThread.tokenUsage ?? remoteThread.token_usage ?? null,
    physicalThread ?? thread ?? {}
  );
  const shouldContinuePolling = remoteStatus === "running";
  const previousTurnId = physicalThread?.turn_id ?? thread.turn_id ?? null;
  const previousStatus = issue.status ?? thread.status ?? "running";
  const preservedRunningLastEvent = [
    "item.agentMessage.delta",
    "turn.diff.updated",
    "turn.plan.updated",
    "turn.started",
    "turn.starting"
  ].includes(physicalThread?.last_event ?? "")
    ? physicalThread?.last_event
    : [
          "item.agentMessage.delta",
          "turn.diff.updated",
          "turn.plan.updated",
          "turn.started",
          "turn.starting"
        ].includes(issue?.last_event ?? "")
      ? issue?.last_event
      : "turn.started";
  const recoveredMessage =
    syncedAssistant.content ||
    extractAppServerErrorMessage({ turn: remoteTurn, status: remoteThread?.status }) ||
    String(issue.last_message ?? "").trim();
  const tokenUsageChanged = !areThreadTokenUsageStatesEqual(previousComparableState.physicalThread ?? {}, tokenUsageState);
  const remoteTurnChanged =
    Boolean(remoteTurn?.id) &&
    String(remoteTurn.id).trim() !== String(previousTurnId ?? "").trim();
  const remoteStatusChanged = remoteStatus !== previousStatus;
  const remoteMessageChanged =
    Boolean(recoveredMessage) &&
    recoveredMessage !== String(issue.last_message ?? physicalThread?.last_message ?? "");
  const hasResponsiveRunningSnapshot =
    remoteStatus === "running" &&
    Boolean(remoteThread?.id) &&
    Boolean(remoteTurn?.id) &&
    Boolean(
      String(remoteAssistantText ?? "").trim() ||
      remoteThread?.tokenUsage ||
      remoteThread?.token_usage
    );
  const hasObservableRunningProgress =
    syncedAssistant.changed || tokenUsageChanged || remoteTurnChanged || remoteStatusChanged || remoteMessageChanged;
  const hasRecoverableRunningSnapshot =
    hasObservableRunningProgress || hasResponsiveRunningSnapshot;
  const recoveredRunningLastEvent =
    syncedAssistant.changed || String(remoteAssistantText ?? "").trim()
      ? "item.agentMessage.delta"
      : preservedRunningLastEvent;
  const threadReadDebugPatch = buildThreadReadDebugPatch(reason, remoteThread, remoteTurn, remoteAssistantText, {
    fallbackStatus: issue.status ?? thread.status ?? "running",
    appendedDeltaLength: syncedAssistant.appendedDelta.length,
    hadProgress: hasRecoverableRunningSnapshot
  });
  const nextNoProgressBackfillCount =
    remoteStatus === "running" && !hasRecoverableRunningSnapshot
      ? Number(meta.noProgressBackfillCount ?? 0) + 1
      : 0;
  const degradedAgeMs = Math.max(
    0,
    Date.now() - Date.parse(
      threadStateById.get(threadId)?.updated_at ??
      thread.updated_at ??
      meta?.lastActivityAt ??
      0
    )
  );

  if (physicalThreadId && tokenUsageChanged) {
    updateBackfilledPhysicalThread(threadId, physicalThreadId, {
      ...tokenUsageState
    });
  }

  if (syncedAssistant.changed) {
    updateBackfilledPhysicalThread(threadId, physicalThreadId, {
      ...tokenUsageState,
      status: "running",
      progress: Math.max(Number(physicalThread?.progress ?? 0), 90),
      last_event: "item.agentMessage.delta",
      last_message: recoveredMessage,
      turn_id: remoteTurn?.id ?? physicalThread?.turn_id ?? null
    });
    updateIssueCard(activeIssueId, {
      executed_physical_thread_id: physicalThreadId,
      status: "running",
      progress: Math.max(Number(issue.progress ?? 0), 90),
      last_event: "item.agentMessage.delta",
      last_message: recoveredMessage
    });
  }

  if (remoteStatus === "running") {
    if (hasRecoverableRunningSnapshot) {
      updateBackfilledPhysicalThread(threadId, physicalThreadId, {
        ...tokenUsageState,
        status: "running",
        progress: Math.max(Number(physicalThread?.progress ?? 0), syncedAssistant.changed ? 90 : 20),
        last_event: recoveredRunningLastEvent,
        last_message: recoveredMessage || String(physicalThread?.last_message ?? ""),
        turn_id: remoteTurn?.id ?? physicalThread?.turn_id ?? null
      });
      updateIssueCard(activeIssueId, {
        executed_physical_thread_id: physicalThreadId,
        status: "running",
        progress: Math.max(Number(issue.progress ?? 0), syncedAssistant.changed ? 90 : 20),
        last_event: recoveredRunningLastEvent,
        ...(recoveredMessage ? { last_message: recoveredMessage } : {})
      });
    } else {
      const currentRunningThread = threadStateById.get(threadId) ?? thread;
      const currentRunningIssue = issueCardsById.get(activeIssueId) ?? issue;
      const currentRunningPhysicalThread = physicalThreadId
        ? physicalThreadStateById.get(physicalThreadId) ?? physicalThread
        : physicalThread;
      const shouldRefreshDegradedProjection =
        currentRunningThread.continuity_status !== "degraded" ||
        currentRunningThread.last_event !== "watchdog.degraded" ||
        currentRunningIssue?.last_event !== "watchdog.degraded" ||
        currentRunningPhysicalThread?.last_event !== "watchdog.degraded";

      if (shouldRefreshDegradedProjection) {
        const degradedUpdatedAt = now();
        if (physicalThreadId) {
          updateBackfilledPhysicalThread(threadId, physicalThreadId, {
            ...tokenUsageState,
            status: "running",
            progress: currentRunningPhysicalThread?.progress ?? physicalThread?.progress ?? 90,
            last_event: "watchdog.degraded",
            last_message: recoveredMessage || String(currentRunningPhysicalThread?.last_message ?? physicalThread?.last_message ?? ""),
            turn_id: remoteTurn?.id ?? currentRunningPhysicalThread?.turn_id ?? physicalThread?.turn_id ?? null,
            updated_at: degradedUpdatedAt
          });
        }
        updateIssueCard(activeIssueId, {
          executed_physical_thread_id: physicalThreadId,
          status: "running",
          progress: currentRunningIssue?.progress ?? issue.progress ?? 90,
          last_event: "watchdog.degraded",
          updated_at: degradedUpdatedAt,
          ...(recoveredMessage ? { last_message: recoveredMessage } : {})
        });
        threadStateById.set(threadId, {
          ...currentRunningThread,
          continuity_status: "degraded",
          last_event: "watchdog.degraded",
          ...(recoveredMessage ? { last_message: recoveredMessage } : {}),
          updated_at: degradedUpdatedAt
        });
      }
    }
  } else if (remoteStatus === "awaiting_input") {
    updateBackfilledPhysicalThread(threadId, physicalThreadId, {
      ...tokenUsageState,
      status: "awaiting_input",
      progress: Math.max(Number(physicalThread?.progress ?? 0), 90),
      last_event: "thread.status.changed",
      last_message: recoveredMessage,
      turn_id: remoteTurn?.id ?? physicalThread?.turn_id ?? null
    });
    updateIssueCard(activeIssueId, {
      executed_physical_thread_id: physicalThreadId,
      status: "awaiting_input",
      progress: Math.max(Number(issue.progress ?? 0), 90),
      last_event: "thread.status.changed",
      ...(recoveredMessage ? { last_message: recoveredMessage } : {})
    });
  } else if (remoteStatus === "completed") {
    settlePhysicalThreadExecutionState(threadId, {
      issue,
      status: "idle",
      progress: 100,
      turnId: null,
      lastEvent: "turn.completed",
      lastMessage: recoveredMessage
    });
    updateIssueCard(activeIssueId, {
      executed_physical_thread_id: physicalThreadId,
      status: "completed",
      progress: 100,
      last_event: "turn.completed",
      ...(recoveredMessage ? { last_message: recoveredMessage } : {})
    });
    if (physicalThreadId) {
      activeIssueByPhysicalThreadId.delete(physicalThreadId);
    }
    clearRunningIssueTracking(threadId);
  } else if (remoteStatus === "failed") {
    settlePhysicalThreadExecutionState(threadId, {
      issue,
      status: "failed",
      progress: 0,
      turnId: null,
      lastEvent: "turn.completed",
      lastMessage: recoveredMessage
    });
    updateIssueCard(activeIssueId, {
      executed_physical_thread_id: physicalThreadId,
      status: "failed",
      progress: 0,
      last_event: "turn.completed",
      ...(recoveredMessage ? { last_message: recoveredMessage } : {})
    });
    if (physicalThreadId) {
      activeIssueByPhysicalThreadId.delete(physicalThreadId);
    }
    clearRunningIssueTracking(threadId);
  }

  const currentThread = threadStateById.get(threadId) ?? thread;
  const shouldRestoreHealthyContinuity =
    remoteStatus !== "running" || hasRecoverableRunningSnapshot;
  const nextThread = shouldRestoreHealthyContinuity
    ? {
        ...currentThread,
        continuity_status: "healthy",
        updated_at: now()
      }
    : currentThread;
  threadStateById.set(threadId, nextThread);
  updateProjectThreadSnapshot(threadId);
  persistThreadById(threadId);
  const nextIssue = issueCardsById.get(activeIssueId) ?? issue;
  const nextPhysicalThread = physicalThreadId
    ? physicalThreadStateById.get(physicalThreadId) ?? physicalThread
    : physicalThread;
  const nextComparableState = captureBackfillComparableState(nextThread, nextIssue, nextPhysicalThread);
  const shouldPublishState =
    JSON.stringify(previousComparableState) !== JSON.stringify(nextComparableState);

  const eventContext = {
    codexThreadId: remoteThread.id,
    threadId,
    rootThreadId: threadId,
    physicalThreadId,
    projectId: thread.project_id,
    issueId: activeIssueId,
    issueStatus: nextIssue?.status ?? issue?.status ?? null
  };

  if (syncedAssistant.appendedDelta) {
    await publishSyntheticRemoteEvent(owner, "item/agentMessage/delta", {
      threadId: remoteThread.id,
      delta: syncedAssistant.appendedDelta
    }, eventContext);
  }

  if (tokenUsageChanged) {
    await publishSyntheticRemoteEvent(owner, "thread/tokenUsage/updated", {
      threadId: remoteThread.id,
      tokenUsage: remoteThread.tokenUsage ?? remoteThread.token_usage ?? null
    }, eventContext);
  }

  if (remoteStatus === "awaiting_input") {
    await publishSyntheticRemoteEvent(owner, "thread/status/changed", {
      threadId: remoteThread.id,
      status: {
        type: "waitingForInput"
      }
    }, eventContext);
  } else if (remoteStatus === "completed") {
    await publishSyntheticRemoteEvent(owner, "turn/completed", {
      threadId: remoteThread.id,
      turn: {
        id: remoteTurn?.id ?? null,
        status: "completed"
      }
    }, eventContext);
    await publishSyntheticRemoteEvent(owner, "thread/status/changed", {
      threadId: remoteThread.id,
      status: {
        type: "idle"
      }
    }, eventContext);
    void scheduleQueuedIssuesForUser(owner, {
      preferredThreadId: threadId
    });
  } else if (remoteStatus === "failed") {
    await publishSyntheticRemoteEvent(owner, "turn/completed", {
      threadId: remoteThread.id,
      turn: {
        id: remoteTurn?.id ?? null,
        status: "failed",
        error: recoveredMessage
          ? {
              message: recoveredMessage
            }
          : undefined
      }
    }, eventContext);
    await publishSyntheticRemoteEvent(owner, "thread/status/changed", {
      threadId: remoteThread.id,
      status: {
        type: "error",
        ...(recoveredMessage ? { message: recoveredMessage } : {})
      }
    }, eventContext);
    void scheduleQueuedIssuesForUser(owner, {
      preferredThreadId: threadId
    });
  }

  if (shouldPublishState) {
    await publishThreadState(owner, threadId);
  }

  if (reason !== "interval") {
    appendDiagnosticLog("info", "running_issue.backfill.completed", "running issue backfill completed", {
      thread_id: threadId,
      issue_id: activeIssueId,
      reason,
      active_physical_thread_id: physicalThreadId,
      codex_thread_id: remoteThread.id,
      remote_status: remoteStatus,
      appended_delta_length: syncedAssistant.appendedDelta.length,
      stale_snapshot_ignored: syncedAssistant.ignoredStaleSnapshot,
      token_usage_changed: tokenUsageChanged,
      observable_progress: hasObservableRunningProgress,
      no_progress_backfill_count: nextNoProgressBackfillCount,
      state_changed: shouldPublishState,
      should_continue_polling: shouldContinuePolling,
      issue_status: (issueCardsById.get(activeIssueId) ?? issue)?.status ?? null,
      physical_thread_status: (physicalThreadId ? physicalThreadStateById.get(physicalThreadId) : null)?.status ?? null
    });
  }

  if (shouldContinuePolling && !shouldRestoreHealthyContinuity) {
    markRunningIssueActivity(threadId, {
      lastActivityAt: hasRecoverableRunningSnapshot ? now() : meta.lastActivityAt,
      backfillRequestedAt: meta.backfillRequestedAt ?? now(),
      backfillTrigger: reason,
      backfillLastError: null,
      backfillLastPolledAt: now(),
      noProgressBackfillCount: nextNoProgressBackfillCount,
      ...threadReadDebugPatch
    });
  } else {
    clearRunningIssueBackfill(threadId);
    const refreshedMeta = runningIssueMetaByThreadId.get(threadId);
    if (refreshedMeta) {
      markRunningIssueActivity(threadId, {
        lastActivityAt: shouldRestoreHealthyContinuity ? now() : refreshedMeta.lastActivityAt,
        ...threadReadDebugPatch
      });
    }
  }

  if (
    remoteStatus === "running" &&
    !hasRecoverableRunningSnapshot &&
    nextNoProgressBackfillCount >= (
      (threadStateById.get(threadId)?.continuity_status === "degraded" && degradedAgeMs >= RUNNING_ISSUE_DEGRADED_FORCE_RECONNECT_DELAY_MS)
        ? 1
        : RUNNING_ISSUE_BACKFILL_NO_PROGRESS_FORCE_RECONNECT_COUNT
    )
  ) {
    const activeSocket = appServer.socket;
    if (activeSocket && appServer.connected && appServer.initialized) {
      appServer.forceReconnect(activeSocket, "running_backfill_no_progress", {
        thread_id: threadId,
        issue_id: activeIssueId,
        active_physical_thread_id: physicalThreadId,
        codex_thread_id: remoteThread.id,
        no_progress_backfill_count: nextNoProgressBackfillCount,
        reason
      });
    }

    const refreshedMeta = runningIssueMetaByThreadId.get(threadId);
    if (refreshedMeta) {
      markRunningIssueActivity(threadId, {
        lastActivityAt: refreshedMeta.lastActivityAt,
        backfillRequestedAt: refreshedMeta.backfillRequestedAt ?? now(),
        backfillTrigger: `forced_reconnect:${reason}`,
        backfillLastError: null,
        backfillLastPolledAt: now(),
        noProgressBackfillCount: 0
      });
    }
  }

  return {
    accepted: true,
    remote_status: remoteStatus,
    appended_delta: syncedAssistant.appendedDelta,
    replaced: syncedAssistant.replaced
  };
}

async function backfillRequestedRunningIssues(trigger = "interval") {
  const candidateThreadIds = [...activeIssueByThreadId.keys()].filter((threadId) => {
    const meta = runningIssueMetaByThreadId.get(threadId);
    const issueId = activeIssueByThreadId.get(threadId) ?? null;
    const issue = issueId ? issueCardsById.get(issueId) ?? null : null;
    return Boolean(meta?.backfillRequestedAt && issue && !issue.deleted_at);
  });

  if (candidateThreadIds.length === 0) {
    return;
  }

  if (runningIssueBackfillPromise) {
    return runningIssueBackfillPromise;
  }

  runningIssueBackfillPromise = (async () => {
    for (const threadId of candidateThreadIds) {
      const owner = threadOwners.get(threadId) ?? BRIDGE_OWNER_LOGIN_ID;

      if (!owner) {
        continue;
      }

      try {
        await backfillRunningIssueFromSnapshot(owner, threadId, trigger);
      } catch (error) {
        const meta = runningIssueMetaByThreadId.get(threadId);

        if (meta) {
          markRunningIssueActivity(threadId, {
            lastActivityAt: meta.lastActivityAt,
            backfillLastError: error.message,
            backfillLastPolledAt: now()
          });
        }

        appServer.lastError = error.message;
        appendDiagnosticLog("error", "running_issue.backfill.failed", "running issue backfill failed", {
          thread_id: threadId,
          trigger,
          error
        });
      }
    }
  })().finally(() => {
    runningIssueBackfillPromise = null;
  });

  return runningIssueBackfillPromise;
}

async function sampleRunningIssueThreadReads(trigger = "interval_sample") {
  const candidateThreadIds = [...activeIssueByThreadId.keys()].filter((threadId) => {
    const meta = runningIssueMetaByThreadId.get(threadId);
    const issueId = activeIssueByThreadId.get(threadId) ?? null;
    const issue = issueId ? issueCardsById.get(issueId) ?? null : null;
    const lastThreadReadAtMs = Date.parse(meta?.lastThreadReadAt ?? 0);

    if (!meta || !issue || issue.deleted_at || !["running", "awaiting_input"].includes(issue.status ?? "")) {
      return false;
    }

    if (meta.backfillRequestedAt) {
      return false;
    }

    if (!Number.isFinite(lastThreadReadAtMs)) {
      return true;
    }

    return Date.now() - lastThreadReadAtMs >= RUNNING_ISSUE_THREAD_READ_SAMPLE_INTERVAL_MS;
  });

  if (candidateThreadIds.length === 0) {
    return;
  }

  if (runningIssueThreadReadSamplePromise) {
    return runningIssueThreadReadSamplePromise;
  }

  runningIssueThreadReadSamplePromise = (async () => {
    for (const threadId of candidateThreadIds) {
      const activeIssueId = activeIssueByThreadId.get(threadId) ?? null;
      const meta = runningIssueMetaByThreadId.get(threadId) ?? null;
      const thread = threadStateById.get(threadId) ?? null;
      const issue = activeIssueId ? issueCardsById.get(activeIssueId) ?? null : null;
      const physicalThreadId =
        issue?.executed_physical_thread_id ??
        issue?.created_physical_thread_id ??
        thread?.active_physical_thread_id ??
        null;
      const physicalThread = physicalThreadId ? physicalThreadStateById.get(physicalThreadId) ?? null : null;
      const codexThreadId = String(
        physicalThread?.codex_thread_id ??
        thread?.codex_thread_id ??
        meta?.lastSeenCodexThreadId ??
        ""
      ).trim();

      if (!activeIssueId || !meta || !thread || !issue || !codexThreadId) {
        continue;
      }

      try {
        const remoteThread = await readThreadSnapshotFromAppServer(codexThreadId, trigger);
        const remoteTurn = selectRemoteTurnForBackfill(remoteThread, physicalThread?.turn_id ?? thread.turn_id ?? null);
        const remoteAssistantText = collectAssistantTextFromRemoteTurn(remoteTurn);
        const remoteStatus = normalizeRemoteTurnRuntimeStatus(
          remoteThread,
          remoteTurn,
          issue.status ?? thread.status ?? "running"
        );
        const tokenUsageState = normalizeThreadTokenUsage(
          remoteThread?.tokenUsage ?? remoteThread?.token_usage ?? null,
          physicalThread ?? thread ?? {}
        );
        const tokenUsageChanged = !areThreadTokenUsageStatesEqual(physicalThread ?? thread ?? {}, tokenUsageState);
        const previousAssistantLength = Number(meta.lastThreadReadAssistantLength ?? 0);
        const currentAssistantLength = String(remoteAssistantText ?? "").length;
        const hasSampleProgress =
          currentAssistantLength > previousAssistantLength ||
          String(remoteTurn?.id ?? "").trim() !== String(meta.lastThreadReadTurnId ?? "").trim() ||
          String(remoteStatus ?? "").trim() !== String(meta.lastThreadReadRemoteStatus ?? "").trim() ||
          tokenUsageChanged;
        const threadReadDebugPatch = buildThreadReadDebugPatch(trigger, remoteThread, remoteTurn, remoteAssistantText, {
          fallbackStatus: issue.status ?? thread.status ?? "running",
          hadProgress: hasSampleProgress
        });
        const shouldPromoteSampleToBackfill =
          Boolean(String(remoteAssistantText ?? "").trim() || remoteStatus !== "running" || tokenUsageChanged) &&
          (
            hasSampleProgress ||
            thread.continuity_status === "degraded" ||
            issue.last_event === "watchdog.degraded" ||
            physicalThread?.last_event === "watchdog.degraded"
          );

        markRunningIssueActivity(threadId, {
          lastActivityAt: hasSampleProgress ? now() : meta.lastActivityAt,
          backfillLastError: null,
          ...threadReadDebugPatch
        });

        if (shouldPromoteSampleToBackfill) {
          markRunningIssueActivity(threadId, {
            lastActivityAt: hasSampleProgress ? now() : meta.lastActivityAt,
            backfillRequestedAt: meta.backfillRequestedAt ?? now(),
            backfillTrigger: trigger,
            backfillLastError: null,
            ...threadReadDebugPatch
          });

          const owner = threadOwners.get(threadId) ?? BRIDGE_OWNER_LOGIN_ID;
          await backfillRunningIssueFromSnapshot(owner, threadId, trigger);
        }
      } catch (error) {
        markRunningIssueActivity(threadId, {
          lastActivityAt: meta.lastActivityAt,
          backfillLastError: error.message
        });
      }
    }
  })().finally(() => {
    runningIssueThreadReadSamplePromise = null;
  });

  return runningIssueThreadReadSamplePromise;
}

function inferReconciledTerminalStatus(issue) {
  const hasOutput = Boolean(String(issue?.last_message ?? "").trim());
  const hasMeaningfulProgress = Number(issue?.progress ?? 0) >= 45;
  const hasExecutionTrail = [
    "turn.plan.updated",
    "turn.diff.updated",
    "item.agentMessage.delta",
    "turn.completed"
  ].includes(issue?.last_event ?? "");

  return hasOutput || hasMeaningfulProgress || hasExecutionTrail ? "completed" : "failed";
}

function shouldTreatMissingRemoteThreadAsTerminal(issue, meta = {}) {
  const missingRemoteAttempts = Number(meta.missingRemoteAttempts ?? 0);

  if (missingRemoteAttempts < RUNNING_ISSUE_MISSING_REMOTE_RETRY_COUNT) {
    return false;
  }

  return true;
}

async function publishThreadState(userId, threadId) {
  const projectId = threadStateById.get(threadId)?.project_id ?? "";
  await publishEvent(userId, "bridge.projectThreads.updated", {
    scope: projectId ? "project" : "all",
    project_id: projectId,
    threads: listProjectThreads(userId, projectId)
  });
  await publishEvent(userId, "bridge.threadIssues.updated", {
    thread_id: threadId,
    issues: listThreadIssuesForClient(threadId)
  });
  await publishEvent(userId, "logicalThread.timeline.updated", {
    root_thread_id: threadId,
    thread_id: threadId,
    entries: listThreadTimeline(threadId)
  });
}

async function unlockCurrentThreadExecution(userId, rootThreadId, options = {}) {
  const normalizedUserId = sanitizeUserId(userId);
  const rootThread = threadStateById.get(rootThreadId);
  const unlockReason = String(options.reason ?? "manual_unlock").trim() || "manual_unlock";

  if (!rootThread || rootThread.deleted_at || threadOwners.get(rootThreadId) !== normalizedUserId) {
    throw new Error("thread를 찾을 수 없습니다.");
  }

  const recoverySteps = [];
  const clearedInvalidTracking = clearInvalidRunningIssueTracking(rootThreadId);

  if (clearedInvalidTracking) {
    recoverySteps.push("cleared_invalid_tracking");
  }

  const trackedIssueId = activeIssueByThreadId.get(rootThreadId) ?? ensureRunningIssueTrackingForThread(rootThreadId);
  const trackedIssue = trackedIssueId ? issueCardsById.get(trackedIssueId) ?? null : null;
  let interruptResult = null;

  if (trackedIssue && ["running", "awaiting_input"].includes(trackedIssue.status)) {
    interruptResult = await interruptThreadExecutionBestEffort(rootThread);
    const blockingStopErrors = interruptResult.errors.filter((error) => error !== "codex thread not bound");

    if (blockingStopErrors.length > 0) {
      const forcedRecovery = shouldForceUnlockAfterStopFailure(unlockReason, blockingStopErrors);
      console.warn(
        forcedRecovery
          ? "[OctOP bridge] thread unlock continuing with forced recovery after stop attempt errors"
          : "[OctOP bridge] thread unlock aborted due to stop attempt errors",
        {
          ...buildLogContext({
            root_thread_id: rootThreadId,
            physical_thread_id: rootThread.active_physical_thread_id ?? null,
            codex_thread_id: rootThread.codex_thread_id ?? null,
            issue_id: trackedIssue.id,
            event_type: forcedRecovery
              ? "thread.unlock.stopBestEffort.forcedRecovery"
              : "thread.unlock.stopBestEffort.failed"
          }),
          errors: blockingStopErrors
        }
      );

      if (!forcedRecovery) {
        return {
          accepted: false,
          action: "stop_failed",
          error: "마지막 이슈를 안전하게 중단하지 못했습니다.",
          thread: threadStateById.get(rootThreadId) ?? rootThread,
          issues: listThreadIssuesForClient(rootThreadId),
          unlocked_issue_id: null,
          queued_issue_ids: [...ensurePendingQueue(rootThreadId)],
          recovery_steps: recoverySteps,
          interrupt_result: {
            interrupted: interruptResult.interrupted,
            stopped_realtime: interruptResult.stoppedRealtime,
            errors: interruptResult.errors
          }
        };
      }

      const invalidatedThread = invalidateCodexThreadBinding(rootThreadId);
      recoverySteps.push("forced_release_after_stop_failed");

      if (invalidatedThread) {
        recoverySteps.push("invalidated_active_binding");
      }
    }

    updateIssueCard(trackedIssue.id, {
      status: "failed",
      progress: Math.max(0, Math.min(Number(trackedIssue.progress ?? 0), 99)),
      queue_position: null,
      last_event: "issue.unlocked",
      last_message:
        String(trackedIssue.last_message ?? "").trim() ||
        (unlockReason === "manual_refresh"
          ? "수동 새로고침으로 마지막 이슈 락을 해제했습니다."
          : "수동으로 마지막 이슈 락을 해제했습니다.")
    });
    clearRunningIssueTracking(rootThreadId);
    settlePhysicalThreadExecutionState(rootThreadId, {
      issue: trackedIssue,
      status: "idle",
      progress: Math.max(0, Math.min(Number(trackedIssue.progress ?? 0), 99)),
      lastEvent: "issue.unlocked",
      lastMessage:
        String(trackedIssue.last_message ?? "").trim() ||
        (unlockReason === "manual_refresh"
          ? "수동 새로고침으로 마지막 이슈 락을 해제했습니다."
          : "수동으로 마지막 이슈 락을 해제했습니다.")
    });
    recoverySteps.push("released_last_issue_lock");
  }

  if (!activeIssueByThreadId.has(rootThreadId)) {
    const scheduleResult = await scheduleQueuedIssuesForUser(normalizedUserId, {
      preferredThreadId: rootThreadId
    });

    if (scheduleResult.started) {
      recoverySteps.push("resumed_issue_queue");
    }
  }

  updateProjectThreadSnapshot(rootThreadId);
  persistThreadById(rootThreadId);
  await publishThreadState(normalizedUserId, rootThreadId);

  return {
    accepted: true,
    action:
      recoverySteps.includes("forced_release_after_stop_failed")
        ? "forced_unlock"
        : recoverySteps.includes("released_last_issue_lock")
        ? "unlocked"
        : recoverySteps.includes("resumed_issue_queue")
          ? "resumed"
          : "noop",
    thread: threadStateById.get(rootThreadId) ?? rootThread,
    issues: listThreadIssuesForClient(rootThreadId),
    unlocked_issue_id: recoverySteps.includes("released_last_issue_lock") ? trackedIssue?.id ?? null : null,
    queued_issue_ids: [...ensurePendingQueue(rootThreadId)],
    recovery_steps: recoverySteps,
    interrupt_result: interruptResult
      ? {
          interrupted: interruptResult.interrupted,
          stopped_realtime: interruptResult.stoppedRealtime,
          errors: interruptResult.errors
        }
      : null
  };
}

async function reconcileRunningIssue(userId, threadId, remoteThreadsByCodexId, options = {}) {
  const activeIssueId = activeIssueByThreadId.get(threadId);
  const meta = runningIssueMetaByThreadId.get(threadId);
  const thread = threadStateById.get(threadId);
  const force = options.force === true;

  if (!activeIssueId || !meta || !thread) {
    return;
  }

  const lastActivityAt = Date.parse(meta.lastActivityAt ?? 0);

  if (!force && (!Number.isFinite(lastActivityAt) || Date.now() - lastActivityAt < RUNNING_ISSUE_STALE_MS)) {
    return;
  }

  const issue = issueCardsById.get(activeIssueId);

  if (!issue) {
    clearRunningIssueTracking(threadId);
    return;
  }

  const remoteThread = thread.codex_thread_id ? remoteThreadsByCodexId.get(thread.codex_thread_id) ?? null : null;
  const reconciledStatus = remoteThread
    ? normalizeThreadStatus(remoteThread.status, thread.status ?? issue.status ?? "running")
    : null;
  const reconcileAttempts = Number(meta.reconcileAttempts ?? 0) + 1;
  const missingRemoteAttempts = remoteThread ? 0 : Number(meta.missingRemoteAttempts ?? 0) + 1;

  markRunningIssueActivity(threadId, {
    lastReconciledAt: now(),
    reconcileAttempts,
    missingRemoteAttempts,
    lastActivityAt: meta.lastActivityAt,
    ...(remoteThread?.id ? { lastSeenCodexThreadId: remoteThread.id } : {})
  });

  if (!reconciledStatus) {
    if (!shouldTreatMissingRemoteThreadAsTerminal(issue, { missingRemoteAttempts })) {
      if (missingRemoteAttempts === RUNNING_ISSUE_MISSING_REMOTE_RETRY_COUNT) {
        console.warn("[OctOP bridge] running issue reconcile skipped: remote thread missing", {
          thread_id: threadId,
          issue_id: activeIssueId,
          reconcile_attempts: reconcileAttempts,
          missing_remote_attempts: missingRemoteAttempts,
          socket_connected: appServer.connected,
          app_server_initialized: appServer.initialized,
          app_server_last_error: appServer.lastError
        });
      }
      return;
    }

    await markRunningIssueContinuityDegraded(
      userId,
      threadId,
      activeIssueId,
      thread,
      issue,
      String(issue.last_message ?? "").trim() ||
        "Codex thread가 thread/list에 보이지 않아 추적을 일시 보류했습니다. normalize 또는 unlock으로 복구해 주세요."
    );
    return;
  }

  if (reconciledStatus === "running") {
    await markRunningIssueContinuityDegraded(
      userId,
      threadId,
      activeIssueId,
      thread,
      issue,
      String(issue.last_message ?? "").trim() ||
        "실시간 이벤트가 끊겨 RPC 상태 복구를 시도합니다.",
      {
        remoteThreadId: remoteThread?.id ?? null,
        backfillTrigger: "reconcile_remote_running"
      }
    );
    try {
      await backfillRunningIssueFromSnapshot(userId, threadId, "reconcile:running");
    } catch (error) {
      appServer.lastError = error.message;
      appendDiagnosticLog("error", "running_issue.backfill.failed", "running issue backfill failed", {
        thread_id: threadId,
        trigger: "reconcile:running",
        error
      });
    }
    return;
  }

  if (reconciledStatus === "awaiting_input") {
    await markRunningIssueContinuityDegraded(
      userId,
      threadId,
      activeIssueId,
      thread,
      issue,
      String(issue.last_message ?? "").trim() ||
        "실시간 이벤트가 끊겨 RPC 상태 복구를 시도합니다.",
      {
        remoteThreadId: remoteThread?.id ?? null,
        backfillTrigger: "reconcile_remote_awaiting_input"
      }
    );
    try {
      await backfillRunningIssueFromSnapshot(userId, threadId, "reconcile:awaiting_input");
    } catch (error) {
      appServer.lastError = error.message;
      appendDiagnosticLog("error", "running_issue.backfill.failed", "running issue backfill failed", {
        thread_id: threadId,
        trigger: "reconcile:awaiting_input",
        error
      });
    }
    return;
  }

  if (reconciledStatus === "failed") {
    await markRunningIssueContinuityDegraded(
      userId,
      threadId,
      activeIssueId,
      thread,
      issue,
      issue.last_message || "Codex 실행 상태를 재확인하는 중 원격 실패 상태가 관측되었습니다. 실제 종료 이벤트를 기다립니다.",
      {
        remoteThreadId: remoteThread?.id ?? null
      }
    );
    return;
  }

  if (reconciledStatus === "idle" || reconciledStatus === "completed") {
    await markRunningIssueContinuityDegraded(
      userId,
      threadId,
      activeIssueId,
      thread,
      issue,
      issue.last_message ||
        "Codex thread가 thread/list에서 종료 상태로 보였지만 실제 완료 이벤트를 받지 못해 추적을 일시 보류했습니다.",
      {
        remoteThreadId: remoteThread?.id ?? null
      }
    );
  }
}

function shouldAttemptNormalizeRollover(rootThread, activePhysicalThread, activeIssue, remoteThread) {
  if (!rootThread || !activePhysicalThread || !activeIssue) {
    return false;
  }

  if (activePhysicalThread.deleted_at || activePhysicalThread.closed_at || activeIssue.deleted_at) {
    return false;
  }

  if (!["running", "awaiting_input"].includes(activeIssue.status ?? rootThread.status ?? "")) {
    return false;
  }

  if ((activePhysicalThread.context_usage_percent ?? 0) < THREAD_CONTEXT_ROLLOVER_THRESHOLD_PERCENT) {
    return false;
  }

  const updatedAtMs = Date.parse(rootThread.updated_at ?? activeIssue.updated_at ?? 0);
  const hasStaleDelta =
    rootThread.last_event === "item.agentMessage.delta" &&
    Number.isFinite(updatedAtMs) &&
    Date.now() - updatedAtMs >= RUNNING_ISSUE_STALE_MS;

  return rootThread.continuity_status === "degraded" || !remoteThread || hasStaleDelta;
}

async function normalizeRootThread(userId, rootThreadId, options = {}) {
  const normalizedUserId = sanitizeUserId(userId);
  const rootThread = threadStateById.get(rootThreadId);
  const normalizeReason = String(options.reason ?? "manual").trim() || "manual";

  if (!rootThread || rootThread.deleted_at || threadOwners.get(rootThreadId) !== normalizedUserId) {
    throw new Error("thread를 찾을 수 없습니다.");
  }

  await appServer.ensureReady(`threadNormalize:${normalizeReason}`);
  const remoteThreads = await syncThreadListFromAppServer();
  const remoteThreadsByCodexId = new Map((remoteThreads ?? []).map((thread) => [thread.id, thread]));
  const previousThread = threadStateById.get(rootThreadId);
  const previousStatus = previousThread?.status ?? null;
  const previousContinuityStatus = previousThread?.continuity_status ?? null;
  const recoverySteps = [];
  const allowStagedResume = normalizeReason === "manual_refresh";

  if (clearInvalidRunningIssueTracking(rootThreadId)) {
    recoverySteps.push("cleared_invalid_tracking");
  }

  const trackedIssueId = ensureRunningIssueTrackingForThread(rootThreadId);

  if (trackedIssueId) {
    await reconcileRunningIssue(normalizedUserId, rootThreadId, remoteThreadsByCodexId, { force: true });
    recoverySteps.push("reconciled_current_issue");
  }

  let currentThread = threadStateById.get(rootThreadId);

  if (!currentThread || currentThread.deleted_at) {
    throw new Error("thread를 찾을 수 없습니다.");
  }

  const activeIssueId = activeIssueByThreadId.get(rootThreadId) ?? trackedIssueId ?? null;
  const activeIssue = activeIssueId ? issueCardsById.get(activeIssueId) ?? null : null;
  const activePhysicalThread = getActivePhysicalThread(rootThreadId);
  const remoteThread = currentThread.codex_thread_id ? remoteThreadsByCodexId.get(currentThread.codex_thread_id) ?? null : null;
  let action = trackedIssueId ? "reconciled" : "noop";
  let rollover = null;

  if (
    currentThread.continuity_status === "degraded" &&
    (remoteThread || !["running", "awaiting_input"].includes(currentThread.status ?? ""))
  ) {
    currentThread = {
      ...currentThread,
      continuity_status: "healthy",
      updated_at: now()
    };
    threadStateById.set(rootThreadId, currentThread);
    persistThreadById(rootThreadId);
    await publishThreadState(normalizedUserId, rootThreadId);
    action = trackedIssueId ? "reconciled" : "recovered";
    recoverySteps.push("recovered_continuity");
  }

  if (shouldAttemptNormalizeRollover(currentThread, activePhysicalThread, activeIssue, remoteThread)) {
    const rolloverResult = await performContextRollover(
      normalizedUserId,
      rootThreadId,
      String(options.reason ?? "manual_normalize").trim() || "manual_normalize"
    );

    if (rolloverResult?.accepted) {
      rollover = rolloverResult;
      currentThread = threadStateById.get(rootThreadId) ?? currentThread;
      action = "rollover";
      recoverySteps.push("rollover");
    }
  }

  if (!activeIssueByThreadId.has(rootThreadId)) {
    const queueRecovery = repairCurrentThreadIssueQueue(rootThreadId, {
      includeLatestStaged: allowStagedResume
    });

    if (queueRecovery.recoveredQueuedIssueIds.length > 0) {
      recoverySteps.push("repaired_issue_queue");
    }

    if (queueRecovery.promotedStagedIssueId) {
      recoverySteps.push("promoted_staged_issue");
    }

    if (ensurePendingQueue(rootThreadId).length > 0) {
      const activeIssueBeforeResume = activeIssueByThreadId.get(rootThreadId) ?? null;
      if (issueQueueProcessingStateByThreadId.has(rootThreadId)) {
        await processIssueQueueOnce(normalizedUserId, rootThreadId, { allowRecovery: false });
      } else {
        await processIssueQueue(normalizedUserId, rootThreadId, { allowRecovery: false });
      }

      const activeIssueAfterResume = activeIssueByThreadId.get(rootThreadId) ?? null;

      if (!activeIssueBeforeResume && activeIssueAfterResume) {
        recoverySteps.push("resumed_issue_queue");
      }
    }
  }

  currentThread = threadStateById.get(rootThreadId) ?? currentThread;
  const currentActiveIssueId = activeIssueByThreadId.get(rootThreadId) ?? null;
  const currentActiveIssue = currentActiveIssueId ? issueCardsById.get(currentActiveIssueId) ?? null : null;
  const currentActivePhysicalThread = getActivePhysicalThread(rootThreadId);
  const currentRemoteThread =
    currentThread.codex_thread_id ? remoteThreadsByCodexId.get(currentThread.codex_thread_id) ?? null : null;
  const finalAction = recoverySteps.at(-1) ?? action;

  return {
    accepted: true,
    action: finalAction,
    recovered:
      recoverySteps.length > 0 ||
      action === "rollover" ||
      previousStatus !== currentThread.status ||
      previousContinuityStatus !== currentThread.continuity_status,
    thread: currentThread,
    continuity: getThreadContinuity(normalizedUserId, rootThreadId),
    active_issue_id: currentActiveIssueId,
    current_issue_id: currentActiveIssue?.id ?? null,
    current_physical_thread_id: currentActivePhysicalThread?.id ?? null,
    queued_issue_ids: [...ensurePendingQueue(rootThreadId)],
    recovery_steps: recoverySteps,
    remote_thread_found: Boolean(currentRemoteThread),
    rollover_trigger_percent: THREAD_CONTEXT_ROLLOVER_THRESHOLD_PERCENT,
    rollover
  };
}

async function reconcileRunningIssues(remoteThreads = null) {
  const candidateThreadIds = new Set(activeIssueByThreadId.keys());

  for (const threadId of threadStateById.keys()) {
    if (ensureRunningIssueTrackingForThread(threadId)) {
      candidateThreadIds.add(threadId);
    }
  }

  if (candidateThreadIds.size === 0) {
    return;
  }

  const reconciliableThreadIds = [...candidateThreadIds].filter((threadId) => {
    const meta = runningIssueMetaByThreadId.get(threadId);
    const lastActivityAt = Date.parse(meta?.lastActivityAt ?? 0);

    return Number.isFinite(lastActivityAt) && Date.now() - lastActivityAt >= RUNNING_ISSUE_STALE_MS;
  });

  if (reconciliableThreadIds.length === 0) {
    return;
  }

  let remoteThreadList = remoteThreads;

  if (!remoteThreadList) {
    try {
      await appServer.ensureReady("reconcileRunningIssues");
      remoteThreadList = await syncThreadListFromAppServer();
    } catch (error) {
      appServer.lastError = error.message;
      return;
    }
  }

  const remoteThreadsByCodexId = new Map((remoteThreadList ?? []).map((thread) => [thread.id, thread]));

  for (const threadId of reconciliableThreadIds) {
    const owner = threadOwners.get(threadId);

    if (!owner) {
      continue;
    }

    await reconcileRunningIssue(owner, threadId, remoteThreadsByCodexId);
  }
}

async function recoverSilentBridgeState(trigger = "unspecified") {
  await appServer.ensureReady(`silentStateCheck:${trigger}`);
  const remoteThreads = await syncThreadListFromAppServer();
  await reconcileRunningIssues(remoteThreads);
  await publishSnapshotsToKnownUsers();
}

function listLocalThreads(userId) {
  const state = ensureUserState(userId);
  const knownIds = [...state.threadIds];

  return knownIds
    .map((threadId) => threadStateById.get(threadId) ?? null)
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
}

function listVisibleThreads(userId, projectId = "") {
  const threads = listLocalThreads(userId);

  if (!projectId) {
    return threads;
  }

  return threads.filter((thread) => thread.project_id === projectId);
}

async function listThreads(userId) {
  const state = ensureUserState(userId);
  const knownIds = [...state.threadIds];

  if (knownIds.length === 0) {
    return [];
  }

  let remoteThreads = [];

  try {
    remoteThreads = await syncThreadListFromAppServer();
  } catch (error) {
    appServer.lastError = error.message;
  }

  const remoteById = new Map(remoteThreads.map((thread) => [thread.id, thread]));

  return knownIds
    .map((threadId) => {
      const remoteThread = remoteById.get(threadId);
      const localThread = threadStateById.get(threadId);

      if (remoteThread) {
        const merged = normalizeThreadRecord(remoteThread, localThread ?? {});
        threadStateById.set(threadId, merged);
        return merged;
      }

      return localThread ?? null;
    })
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
}

async function startThreadTurn(userId, threadId) {
  const current = threadStateById.get(threadId);

  if (!current) {
    throw new Error("시작할 thread를 찾을 수 없습니다.");
  }

  const cwd = resolveProjectWorkspace(userId, current.project_id);
  const executionPolicy = resolveCodexExecutionPolicyFromOptions(current);

  try {
    const turnStartParams = {
      threadId,
      cwd,
      ...(executionPolicy.approvalPolicy ? { approvalPolicy: executionPolicy.approvalPolicy } : {}),
      input: [
        {
          type: "text",
          text: buildExecutionPrompt(
            current.prompt ?? '연결 상태 점검입니다. "pong" 또는 현재 상태를 짧게 답해 주세요.'
          )
        }
      ]
    };
    appendDiagnosticLog("info", "app_server.turn_start.params", "turn/start params before app-server request", {
      source: "startThreadTurn",
      user_id: sanitizeUserId(userId),
      project_id: current.project_id ?? null,
      root_thread_id: threadId,
      params: turnStartParams
    });
    const turnResponse = await appServer.request("turn/start", turnStartParams, "turn/start.startThreadTurn");

    const turn = turnResponse.result?.turn ?? null;

    upsertThreadState(threadId, {
      ...current,
      status: "running",
      progress: Math.max(current.progress ?? 0, 20),
      last_event: "turn.started",
      turn_id: turn?.id ?? null,
      queue_position: null
    });

    await publishEvent(userId, "turn.started", {
      threadId,
      turn
    });
    await publishEvent(userId, "bridge.threads.updated", { threads: listLocalThreads(userId) });
  } catch (error) {
    upsertThreadState(threadId, {
      ...current,
      status: "failed",
      last_event: "turn.start.failed",
      last_message: error.message
    });

    await publishEvent(userId, "turn.start.failed", {
      threadId,
      error: error.message
    });
    await publishEvent(userId, "bridge.threads.updated", { threads: listLocalThreads(userId) });
    void processStartQueue(userId);
  }
}

async function processStartQueue(userId) {
  const queue = ensurePendingQueue(userId);

  if (queue.length === 0 || hasRunningThread(userId)) {
    return;
  }

  const nextThreadId = queue.shift();
  refreshQueuePositions(userId);

  if (!nextThreadId) {
    return;
  }

  const nextThread = threadStateById.get(nextThreadId);

  if (!nextThread || ["running", "completed"].includes(nextThread.status)) {
    void processStartQueue(userId);
    return;
  }

  await startThreadTurn(userId, nextThreadId);
}

async function createQueuedIssue(userId, payload = {}) {
  const state = ensureUserState(userId);
  const projectId = payload.project_id ?? state.projects[0]?.id ?? null;
  const cwd = resolveProjectWorkspace(userId, projectId);
  const issueTitle = createIssueTitle(payload);
  const prompt = String(payload.prompt ?? "").trim();
  const instructionOverrides = getProjectInstructionOverrides(userId, projectId);
  const executionPolicy = resolveCodexExecutionPolicyFromOptions(payload);
  const reasoningEffort = resolveCodexReasoningEffortFromOptions(payload);
  const threadStartParams = {
    cwd,
    ...(executionPolicy.approvalPolicy ? { approvalPolicy: executionPolicy.approvalPolicy } : {}),
    ...(executionPolicy.sandbox ? { sandbox: executionPolicy.sandbox } : {}),
    model: resolveCodexModelFromOptions(payload),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    personality: "pragmatic",
    ...instructionOverrides
  };
  await appServer.ensureReady("createQueuedIssue");

  appendDiagnosticLog("info", "app_server.thread_start.params", "thread/start params before app-server request", {
    source: "createQueuedIssue",
    user_id: sanitizeUserId(userId),
    project_id: projectId ?? null,
    issue_title: issueTitle,
    params: threadStartParams
  });
  const threadResponse = await appServer.request("thread/start", threadStartParams, "thread/start.createQueuedIssue");
  const thread = threadResponse.result?.thread;

  if (!thread?.id) {
    throw new Error("app-server thread/start 응답에 thread id가 없습니다.");
  }

  state.threadIds.add(thread.id);
  threadOwners.set(thread.id, userId);
  upsertThreadState(
    thread.id,
    normalizeThreadRecord(thread, {
      title: issueTitle,
      project_id: projectId,
      prompt,
      progress: 5,
      status: "staged",
      last_event: "issue.created"
    })
  );
  pushThreadMessage(thread.id, {
    role: "user",
    kind: "prompt",
    content: prompt
  });

  await publishEvent(userId, "issue.created", {
    thread: threadStateById.get(thread.id)
  });
  await publishEvent(userId, "bridge.threads.updated", { threads: listLocalThreads(userId) });

  return {
    accepted: true,
    thread: threadStateById.get(thread.id),
    queue: ensurePendingQueue(userId)
  };
}

async function startQueuedThreads(userId, payload = {}) {
  const requestedThreadIds = Array.isArray(payload.thread_ids) ? payload.thread_ids : [];
  const state = ensureUserState(userId);
  const eligibleThreadIds = requestedThreadIds
    .map((threadId) => String(threadId))
    .filter((threadId) => {
      const thread = threadStateById.get(threadId);
      return Boolean(
        thread &&
          state.threadIds.has(threadId) &&
          !["running", "completed", "failed"].includes(thread.status)
      );
    });

  for (const threadId of eligibleThreadIds) {
    const thread = threadStateById.get(threadId);

    if (!thread || thread.status !== "staged") {
      continue;
    }

    upsertThreadState(threadId, {
      ...thread,
      status: "queued",
      progress: Math.max(thread.progress ?? 0, 10),
      last_event: "thread.queued"
    });
  }

  enqueueThreadsForStart(userId, eligibleThreadIds);
  refreshQueuePositions(userId);
  await publishEvent(userId, "threads.start.queued", {
    thread_ids: eligibleThreadIds
  });
  await publishEvent(userId, "bridge.threads.updated", { threads: listLocalThreads(userId) });
  await processStartQueue(userId);

  return {
    accepted: true,
    queued_thread_ids: ensurePendingQueue(userId),
    threads: listLocalThreads(userId)
  };
}

async function reorderQueuedThreads(userId, payload = {}) {
  const normalized = sanitizeUserId(userId);
  const queue = ensurePendingQueue(normalized);
  const requestedThreadIds = Array.isArray(payload.thread_ids)
    ? payload.thread_ids.map((threadId) => String(threadId))
    : [];
  const reorderedIds = requestedThreadIds.filter((threadId) => queue.includes(threadId));
  const remainingIds = queue.filter((threadId) => !reorderedIds.includes(threadId));

  pendingStartQueues.set(normalized, [...reorderedIds, ...remainingIds]);
  refreshQueuePositions(normalized);
  await publishEvent(normalized, "threads.reordered", {
    thread_ids: reorderedIds
  });
  await publishEvent(normalized, "bridge.threads.updated", { threads: listLocalThreads(normalized) });

  return {
    accepted: true,
    queued_thread_ids: ensurePendingQueue(normalized),
    threads: listLocalThreads(normalized)
  };
}

async function deleteThread(userId, payload = {}) {
  const threadId = String(payload.thread_id ?? payload.threadId ?? "").trim();

  if (!threadId) {
    throw new Error("삭제할 이슈 id가 필요합니다.");
  }

  const thread = threadStateById.get(threadId);

  if (!thread || threadOwners.get(threadId) !== sanitizeUserId(userId)) {
    throw new Error("이슈를 찾을 수 없습니다.");
  }

  if (!["staged", "queued", "idle", "awaiting_input", "failed"].includes(thread.status)) {
    throw new Error("준비 또는 보류 상태의 이슈만 삭제할 수 있습니다.");
  }

  deleteThreadState(userId, threadId);
  refreshQueuePositions(userId);
  await publishEvent(userId, "thread.deleted", {
    thread_id: threadId,
    project_id: thread.project_id
  });
  await publishEvent(userId, "bridge.threads.updated", { threads: listLocalThreads(userId) });

  return {
    accepted: true,
    thread_id: threadId,
    threads: listLocalThreads(userId)
  };
}

async function deleteProject(userId, payload = {}) {
  const projectId = String(payload.project_id ?? payload.projectId ?? "").trim();

  if (!projectId) {
    throw new Error("삭제할 프로젝트 id가 필요합니다.");
  }

  const normalized = sanitizeUserId(userId);
  const state = ensureUserState(normalized);
  const project = state.projects.find((item) => item.id === projectId);

  if (!project) {
    throw new Error("프로젝트를 찾을 수 없습니다.");
  }

  const runningThread = [...state.threadIds]
    .map((threadId) => threadStateById.get(threadId))
    .find((thread) => thread?.project_id === projectId && thread.status === "running");

  if (runningThread) {
    throw new Error("실행 중인 이슈가 있어 프로젝트를 삭제할 수 없습니다.");
  }

  const projectThreadIds = [...state.threadIds].filter(
    (threadId) => threadStateById.get(threadId)?.project_id === projectId
  );

  for (const threadId of projectThreadIds) {
    const codexThreadId = threadStateById.get(threadId)?.codex_thread_id;

    if (codexThreadId) {
      codexThreadToThreadId.delete(codexThreadId);
    }

    for (const issueId of getThreadIssueIds(threadId)) {
      issueCardsById.delete(issueId);
      issueMessagesById.delete(issueId);
    }

    threadIssueIdsById.delete(threadId);
    pendingStartQueues.delete(threadId);
    clearRunningIssueTracking(threadId);
    deleteThreadState(normalized, threadId);
  }

  state.projects = state.projects.filter((item) => item.id !== projectId);
  if (project.workspace_path) {
    state.deletedWorkspacePaths = [...new Set([...state.deletedWorkspacePaths, project.workspace_path])];
  }
  state.updated_at = now();
  persistUserProjects(normalized, state.projects, state.deletedWorkspacePaths);

  await publishEvent(normalized, "project.deleted", { project_id: projectId });
  await publishEvent(normalized, "bridge.projects.updated", { projects: state.projects });
  await publishEvent(normalized, "bridge.projectThreads.updated", {
    scope: "all",
    threads: listProjectThreads(normalized)
  });

  return {
    accepted: true,
    project_id: projectId,
    projects: state.projects,
    threads: listProjectThreads(normalized)
  };
}

function resolveProjectWorkspace(userId, projectId) {
  const state = ensureUserState(userId);
  const project =
    state.projects.find((item) => item.id === projectId) ??
    state.projects.find((item) => item.workspace_path) ??
    null;

  return project?.workspace_path ?? process.cwd();
}

async function respond(message, payload) {
  if (!message.reply) {
    return;
  }

  nc.publish(message.reply, sc.encode(JSON.stringify(payload)));
}

async function subscribeRequests(connection = nc) {
  const patterns = [
    {
      subject: "octop.user.*.bridge.*.status.get",
      handler: (userId, body) =>
        bridgeStatus(userId, {
          ensureReady:
            body?.ensure_ready === true ||
            body?.ensureReady === true
        })
    },
    {
      subject: "octop.user.*.bridge.*.projects.get",
      handler: (userId) => ({ projects: listProjectState(userId) })
    },
    {
      subject: "octop.user.*.bridge.*.todo.chats.get",
      handler: (userId) => ({ chats: listTodoChats(userId) })
    },
    {
      subject: "octop.user.*.bridge.*.workspace.roots.get",
      handler: (userId) => ({ roots: listWorkspaceRoots(userId) })
    },
    {
      subject: "octop.user.*.bridge.*.project.threads.get",
      handler: async (userId, body) => ({
        threads: listProjectThreads(userId, String(body.project_id ?? ""))
      })
    },
    {
      subject: "octop.user.*.bridge.*.thread.issues.get",
      handler: async (userId, body) =>
        buildThreadIssuesResponse(userId, String(body.thread_id ?? body.threadId ?? ""))
    },
    {
      subject: "octop.user.*.bridge.*.thread.timeline.get",
      handler: async (userId, body) => {
        const rootThreadId = String(body.thread_id ?? body.threadId ?? "");
        return {
          thread: threadStateById.get(rootThreadId) ?? null,
          entries: listThreadTimeline(rootThreadId),
          continuity: getThreadContinuity(userId, rootThreadId)
        };
      }
    },
    {
      subject: "octop.user.*.bridge.*.thread.continuity.get",
      handler: async (userId, body) => getThreadContinuity(userId, String(body.thread_id ?? body.threadId ?? ""))
    },
    {
      subject: "octop.user.*.bridge.*.thread.issue.detail.get",
      handler: (userId, body) => getIssueDetail(userId, body.issue_id ?? body.issueId ?? "")
    },
    {
      subject: "octop.user.*.bridge.*.todo.messages.get",
      handler: (userId, body) =>
        getTodoMessagesResponse(userId, String(body.todo_chat_id ?? body.todoChatId ?? body.chat_id ?? body.chatId ?? ""))
    }
  ];

  for (const entry of patterns) {
    const subscription = connection.subscribe(entry.subject);

    (async () => {
      for await (const message of subscription) {
        const userId = sanitizeUserId(message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }
        try {
          const body = message.data?.length ? parseJson(message.data) : {};
          await respond(message, await entry.handler(userId, body));
        } catch (error) {
          await respond(message, { error: error.message });
        }
      }
    })();
  }

  const todoChatCreateSubscription = connection.subscribe("octop.user.*.bridge.*.todo.chat.create");

  (async () => {
    for await (const message of todoChatCreateSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await createTodoChat(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const todoChatUpdateSubscription = connection.subscribe("octop.user.*.bridge.*.todo.chat.update");

  (async () => {
    for await (const message of todoChatUpdateSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await updateTodoChat(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const todoChatDeleteSubscription = connection.subscribe("octop.user.*.bridge.*.todo.chat.delete");

  (async () => {
    for await (const message of todoChatDeleteSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await deleteTodoChat(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const todoMessageCreateSubscription = connection.subscribe("octop.user.*.bridge.*.todo.message.create");

  (async () => {
    for await (const message of todoMessageCreateSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await createTodoMessage(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const todoMessageUpdateSubscription = connection.subscribe("octop.user.*.bridge.*.todo.message.update");

  (async () => {
    for await (const message of todoMessageUpdateSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await updateTodoMessage(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const todoMessageDeleteSubscription = connection.subscribe("octop.user.*.bridge.*.todo.message.delete");

  (async () => {
    for await (const message of todoMessageDeleteSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await deleteTodoMessage(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const todoMessageTransferSubscription = connection.subscribe("octop.user.*.bridge.*.todo.message.transfer");

  (async () => {
    for await (const message of todoMessageTransferSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await transferTodoMessage(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const projectCreateSubscription = connection.subscribe("octop.user.*.bridge.*.project.create");

  (async () => {
    for await (const message of projectCreateSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.login_id ?? body.user_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await createProject(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const projectDeleteSubscription = connection.subscribe("octop.user.*.bridge.*.project.delete");

  (async () => {
    for await (const message of projectDeleteSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.login_id ?? body.user_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await deleteProject(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const projectUpdateSubscription = connection.subscribe("octop.user.*.bridge.*.project.update");

  (async () => {
    for await (const message of projectUpdateSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.login_id ?? body.user_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await updateProject(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const folderListSubscription = connection.subscribe("octop.user.*.bridge.*.folder.list.get");

  (async () => {
    for await (const message of folderListSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.login_id ?? body.user_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        await respond(message, listFoldersForUser(userId, body.path ?? ""));
      } catch (error) {
        await respond(message, { error: error.message });
      }
    }
  })();

  const projectThreadCreateSubscription = connection.subscribe("octop.user.*.bridge.*.project.thread.create");

  (async () => {
    for await (const message of projectThreadCreateSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await createProjectThread(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const projectThreadDeleteSubscription = connection.subscribe("octop.user.*.bridge.*.project.thread.delete");

  (async () => {
    for await (const message of projectThreadDeleteSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await deleteProjectThread(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const projectThreadRolloverSubscription = connection.subscribe("octop.user.*.bridge.*.project.thread.rollover");

  (async () => {
    for await (const message of projectThreadRolloverSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await performContextRollover(
          userId,
          String(body.thread_id ?? body.threadId ?? "").trim(),
          String(body.reason ?? "manual").trim() || "manual"
        );
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const projectThreadNormalizeSubscription = connection.subscribe("octop.user.*.bridge.*.project.thread.normalize");

  (async () => {
    for await (const message of projectThreadNormalizeSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await normalizeRootThread(
          userId,
          String(body.thread_id ?? body.threadId ?? "").trim(),
          {
            reason: String(body.reason ?? "manual_refresh").trim() || "manual_refresh"
          }
        );
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const projectThreadUnlockSubscription = connection.subscribe("octop.user.*.bridge.*.project.thread.unlock");

  (async () => {
    for await (const message of projectThreadUnlockSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await unlockCurrentThreadExecution(
          userId,
          String(body.thread_id ?? body.threadId ?? "").trim(),
          {
            reason: String(body.reason ?? "manual_unlock").trim() || "manual_unlock"
          }
        );
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const projectThreadStopSubscription = connection.subscribe("octop.user.*.bridge.*.project.thread.stop");

  (async () => {
    for await (const message of projectThreadStopSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await stopThreadExecutionSafely(
          userId,
          String(body.thread_id ?? body.threadId ?? "").trim(),
          {
            reason: String(body.reason ?? "manual_stop").trim() || "manual_stop"
          }
        );
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const projectThreadUpdateSubscription = connection.subscribe("octop.user.*.bridge.*.project.thread.update");

  (async () => {
    for await (const message of projectThreadUpdateSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await updateProjectThread(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const threadIssueCreateSubscription = connection.subscribe("octop.user.*.bridge.*.thread.issue.create");

  (async () => {
    for await (const message of threadIssueCreateSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await createThreadIssue(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const threadIssueUpdateSubscription = connection.subscribe("octop.user.*.bridge.*.thread.issue.update");

  (async () => {
    for await (const message of threadIssueUpdateSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await updateThreadIssue(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const threadIssueDeleteSubscription = connection.subscribe("octop.user.*.bridge.*.thread.issue.delete");

  (async () => {
    for await (const message of threadIssueDeleteSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await deleteThreadIssue(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const threadIssueInterruptSubscription = connection.subscribe("octop.user.*.bridge.*.thread.issue.interrupt");

  (async () => {
    for await (const message of threadIssueInterruptSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await interruptThreadIssue(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const threadIssueMoveSubscription = connection.subscribe("octop.user.*.bridge.*.thread.issue.move");

  (async () => {
    for await (const message of threadIssueMoveSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await moveThreadIssue(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const threadIssuesStartSubscription = connection.subscribe("octop.user.*.bridge.*.thread.issues.start");

  (async () => {
    for await (const message of threadIssuesStartSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await startThreadIssues(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const threadIssuesReorderSubscription = connection.subscribe("octop.user.*.bridge.*.thread.issues.reorder");

  (async () => {
    for await (const message of threadIssuesReorderSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await reorderThreadIssues(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const pingSubscription = connection.subscribe("octop.user.*.bridge.*.command.ping");

  (async () => {
    for await (const message of pingSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const projectId = String(body.project_id ?? ensureUserState(userId).projects[0]?.id ?? "").trim();
        const threadId = ensureDefaultProjectThread(userId, projectId, "Main");
        const created = await createThreadIssue(userId, {
          ...body,
          thread_id: threadId,
          project_id: projectId
        });
        const started = await startThreadIssues(userId, {
          thread_id: threadId,
          issue_ids: [created.issue.id]
        });
        const result = {
          accepted: true,
          issue: created.issue,
          issues: started.issues
        };
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();
}

await subscribeRequests();
startNatsStatusMonitor();
await startSystemNetworkEventMonitor("startup");

setInterval(() => {
  if (!hasActiveThreadExecution(BRIDGE_OWNER_LOGIN_ID)) {
    return;
  }

  void publishSnapshots(BRIDGE_OWNER_LOGIN_ID);
}, 30000).unref();

setInterval(() => {
  void reconcileRunningIssues();
}, RUNNING_ISSUE_WATCHDOG_INTERVAL_MS).unref();

if (RUNNING_ISSUE_BACKFILL_INTERVAL_MS > 0) {
  setInterval(() => {
    void backfillRequestedRunningIssues();
  }, RUNNING_ISSUE_BACKFILL_INTERVAL_MS).unref();
}

if (RUNNING_ISSUE_THREAD_READ_SAMPLE_INTERVAL_MS > 0) {
  setInterval(() => {
    void sampleRunningIssueThreadReads();
  }, RUNNING_ISSUE_THREAD_READ_SAMPLE_INTERVAL_MS).unref();
}

await publishProjectionRecoverySnapshots(BRIDGE_OWNER_LOGIN_ID);

createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
  const token = request.headers["x-bridge-token"];
  const userId = sanitizeUserId(url.searchParams.get("user_id") ?? "local-user");

  if (token !== TOKEN) {
    return sendJson(response, 401, { error: "Unauthorized bridge access" });
  }

  if (request.method === "GET" && url.pathname === "/health") {
    return sendJson(response, 200, {
      ok: true,
      status: await bridgeStatus(userId),
      metrics: bridgeMetrics
    });
  }

  if (request.method === "GET" && url.pathname === "/api/projects") {
    return sendJson(response, 200, { projects: listProjectState(userId) });
  }

  if (request.method === "GET" && url.pathname === "/api/todo/chats") {
    return sendJson(response, 200, { chats: listTodoChats(userId) });
  }

  if (request.method === "POST" && url.pathname === "/api/todo/chats") {
    try {
      const body = await readJsonBody(request);
      const payload = await createTodoChat(userId, body);
      return sendJson(response, 201, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "PATCH" && /^\/api\/todo\/chats\/[^/]+$/.test(url.pathname)) {
    try {
      const chatId = url.pathname.split("/").at(-1);
      const body = await readJsonBody(request);
      const payload = await updateTodoChat(userId, {
        ...body,
        todo_chat_id: chatId
      });
      return sendJson(response, 200, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "DELETE" && /^\/api\/todo\/chats\/[^/]+$/.test(url.pathname)) {
    try {
      const chatId = url.pathname.split("/").at(-1);
      const payload = await deleteTodoChat(userId, { todo_chat_id: chatId });
      return sendJson(response, 200, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "GET" && /^\/api\/todo\/chats\/[^/]+\/messages$/.test(url.pathname)) {
    const chatId = url.pathname.split("/")[4];
    return sendJson(response, 200, getTodoMessagesResponse(userId, chatId));
  }

  if (request.method === "POST" && /^\/api\/todo\/chats\/[^/]+\/messages$/.test(url.pathname)) {
    try {
      const chatId = url.pathname.split("/")[4];
      const body = await readJsonBody(request);
      const payload = await createTodoMessage(userId, {
        ...body,
        todo_chat_id: chatId
      });
      return sendJson(response, 201, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "PATCH" && /^\/api\/todo\/messages\/[^/]+$/.test(url.pathname)) {
    try {
      const messageId = url.pathname.split("/").at(-1);
      const body = await readJsonBody(request);
      const payload = await updateTodoMessage(userId, {
        ...body,
        todo_message_id: messageId
      });
      return sendJson(response, 200, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "DELETE" && /^\/api\/todo\/messages\/[^/]+$/.test(url.pathname)) {
    try {
      const messageId = url.pathname.split("/").at(-1);
      const payload = await deleteTodoMessage(userId, { todo_message_id: messageId });
      return sendJson(response, 200, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "POST" && /^\/api\/todo\/messages\/[^/]+\/transfer$/.test(url.pathname)) {
    try {
      const messageId = url.pathname.split("/")[4];
      const body = await readJsonBody(request);
      const payload = await transferTodoMessage(userId, {
        ...body,
        todo_message_id: messageId
      });
      return sendJson(response, 200, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "GET" && url.pathname === "/api/workspace-roots") {
    return sendJson(response, 200, { roots: listWorkspaceRoots(userId) });
  }

  if (request.method === "GET" && url.pathname === "/api/folders") {
    try {
      return sendJson(response, 200, listFoldersForUser(userId, url.searchParams.get("path") ?? ""));
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }

  if (request.method === "POST" && url.pathname === "/api/projects") {
    try {
      const body = await readJsonBody(request);
      const payload = await createProject(userId, body);
      return sendJson(response, 201, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "DELETE" && url.pathname.startsWith("/api/projects/")) {
    try {
      const projectId = url.pathname.split("/").at(-1);
      const payload = await deleteProject(userId, { project_id: projectId });
      return sendJson(response, 200, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "PATCH" && url.pathname.startsWith("/api/projects/")) {
    try {
      const projectId = url.pathname.split("/").at(-1);
      const payload = await readJsonBody(request);
      const result = await updateProject(userId, {
        ...payload,
        project_id: projectId
      });
      return sendJson(response, 200, result);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "GET" && /^\/api\/projects\/[^/]+\/threads$/.test(url.pathname)) {
    const projectId = url.pathname.split("/")[3];
    return sendJson(response, 200, {
      threads: listProjectThreads(userId, projectId)
    });
  }

  if (request.method === "POST" && /^\/api\/projects\/[^/]+\/threads$/.test(url.pathname)) {
    try {
      const projectId = url.pathname.split("/")[3];
      const body = await readJsonBody(request);
      const payload = await createProjectThread(userId, {
        ...body,
        project_id: projectId
      });
      return sendJson(response, 201, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "PATCH" && /^\/api\/threads\/[^/]+$/.test(url.pathname)) {
    try {
      const threadId = url.pathname.split("/").at(-1);
      const body = await readJsonBody(request);
      const payload = await updateProjectThread(userId, {
        ...body,
        thread_id: threadId
      });
      return sendJson(response, 200, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "DELETE" && /^\/api\/threads\/[^/]+$/.test(url.pathname)) {
    try {
      const threadId = url.pathname.split("/").at(-1);
      const payload = await deleteProjectThread(userId, { thread_id: threadId });
      return sendJson(response, 200, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "GET" && /^\/api\/threads\/[^/]+\/issues$/.test(url.pathname)) {
    const threadId = url.pathname.split("/")[3];
    return sendJson(response, 200, buildThreadIssuesResponse(userId, threadId));
  }

  if (request.method === "GET" && /^\/api\/threads\/[^/]+\/timeline$/.test(url.pathname)) {
    const threadId = url.pathname.split("/")[3];
    return sendJson(response, 200, {
      thread: threadStateById.get(threadId) ?? null,
      entries: listThreadTimeline(threadId),
      continuity: getThreadContinuity(userId, threadId)
    });
  }

  if (request.method === "GET" && /^\/api\/threads\/[^/]+\/continuity$/.test(url.pathname)) {
    const threadId = url.pathname.split("/")[3];
    return sendJson(response, 200, getThreadContinuity(userId, threadId));
  }

  if (request.method === "POST" && /^\/api\/threads\/[^/]+\/issues$/.test(url.pathname)) {
    try {
      const threadId = url.pathname.split("/")[3];
      const body = await readJsonBody(request);
      const payload = await createThreadIssue(userId, {
        ...body,
        thread_id: threadId
      });
      return sendJson(response, 201, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "POST" && /^\/api\/threads\/[^/]+\/issues\/start$/.test(url.pathname)) {
    let body = null;
    try {
      const threadId = url.pathname.split("/")[3];
      body = await readJsonBody(request);
      const payload = await startThreadIssues(userId, {
        ...body,
        thread_id: threadId
      });
      return sendJson(response, 202, payload);
    } catch (error) {
      appendDiagnosticLog("error", "http.thread.issues.start.failed", "HTTP issue start request failed", {
        user_id: userId,
        thread_id: url.pathname.split("/")[3],
        path: url.pathname,
        body,
        error
      });
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "POST" && /^\/api\/threads\/[^/]+\/issues\/reorder$/.test(url.pathname)) {
    try {
      const threadId = url.pathname.split("/")[3];
      const body = await readJsonBody(request);
      const payload = await reorderThreadIssues(userId, {
        ...body,
        thread_id: threadId
      });
      return sendJson(response, 202, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "POST" && /^\/api\/threads\/[^/]+\/rollover$/.test(url.pathname)) {
    try {
      const threadId = url.pathname.split("/")[3];
      const body = await readJsonBody(request);
      const payload = await performContextRollover(
        userId,
        threadId,
        String(body.reason ?? "manual").trim() || "manual"
      );
      return sendJson(response, payload.accepted ? 202 : 400, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "POST" && /^\/api\/threads\/[^/]+\/normalize$/.test(url.pathname)) {
    try {
      const threadId = url.pathname.split("/")[3];
      const body = await readJsonBody(request);
      const payload = await normalizeRootThread(userId, threadId, {
        reason: String(body.reason ?? "manual_refresh").trim() || "manual_refresh"
      });
      return sendJson(response, payload.accepted ? 202 : 400, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "POST" && /^\/api\/threads\/[^/]+\/unlock$/.test(url.pathname)) {
    try {
      const threadId = url.pathname.split("/")[3];
      const body = await readJsonBody(request);
      const payload = await unlockCurrentThreadExecution(userId, threadId, {
        reason: String(body.reason ?? "manual_unlock").trim() || "manual_unlock"
      });
      return sendJson(response, payload.accepted ? 202 : 400, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "POST" && /^\/api\/threads\/[^/]+\/stop$/.test(url.pathname)) {
    try {
      const threadId = url.pathname.split("/")[3];
      const body = await readJsonBody(request);
      const payload = await stopThreadExecutionSafely(userId, threadId, {
        reason: String(body.reason ?? "manual_stop").trim() || "manual_stop"
      });
      return sendJson(response, payload.accepted ? 202 : 400, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "GET" && /^\/api\/issues\/[^/]+$/.test(url.pathname)) {
    const issueId = url.pathname.split("/").at(-1);
    return sendJson(response, 200, getIssueDetail(userId, issueId));
  }

  if (request.method === "PATCH" && /^\/api\/issues\/[^/]+$/.test(url.pathname)) {
    try {
      const issueId = url.pathname.split("/").at(-1);
      const body = await readJsonBody(request);
      const payload = await updateThreadIssue(userId, {
        ...body,
        issue_id: issueId
      });
      return sendJson(response, 200, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "DELETE" && /^\/api\/issues\/[^/]+$/.test(url.pathname)) {
    try {
      const issueId = url.pathname.split("/").at(-1);
      const payload = await deleteThreadIssue(userId, {
        issue_id: issueId
      });
      return sendJson(response, 200, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "POST" && /^\/api\/issues\/[^/]+\/interrupt$/.test(url.pathname)) {
    try {
      const issueId = url.pathname.split("/")[3];
      const body = await readJsonBody(request);
      const payload = await interruptThreadIssue(userId, {
        issue_id: issueId,
        reason: String(body.reason ?? "manual_interrupt").trim() || "manual_interrupt"
      });
      return sendJson(response, payload.accepted ? 202 : 400, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "POST" && /^\/api\/issues\/[^/]+\/move$/.test(url.pathname)) {
    try {
      const issueId = url.pathname.split("/")[3];
      const body = await readJsonBody(request);
      const payload = await moveThreadIssue(userId, {
        issue_id: issueId,
        target_thread_id: String(body.target_thread_id ?? "").trim()
      });
      return sendJson(response, payload.accepted ? 200 : 400, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "POST" && url.pathname === "/api/commands/ping") {
    try {
      const body = await readJsonBody(request);
      const projectId = String(body.project_id ?? ensureUserState(userId).projects[0]?.id ?? "").trim();
      const threadId = ensureDefaultProjectThread(userId, projectId, "Main");
      const created = await createThreadIssue(userId, {
        ...body,
        thread_id: threadId,
        project_id: projectId
      });
      const started = await startThreadIssues(userId, {
        thread_id: threadId,
        issue_ids: [created.issue.id]
      });
      return sendJson(response, 202, {
        accepted: true,
        issue: created.issue,
        issues: started.issues
      });
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }

  return sendJson(response, 404, { error: "Not found" });
}).listen(PORT, HOST, () => {
  appendDiagnosticLog("info", "bridge.startup", "bridge server started", {
    host: HOST,
    port: PORT,
    bridge_revision: BRIDGE_REVISION,
    repo_root: REPO_ROOT
  });
  console.log(`OctOP bridge listening on http://${HOST}:${PORT}`);
});
