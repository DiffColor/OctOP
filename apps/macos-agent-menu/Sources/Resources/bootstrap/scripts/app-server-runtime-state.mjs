import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import { dirname, resolve } from "node:path";

const DEFAULT_ACTIVITY_BEACON_STALE_MS = 45000;
const DEFAULT_ACTIVITY_BEACON_PULSE_INTERVAL_MS = 5000;
const DEFAULT_RUNTIME_HEARTBEAT_INTERVAL_MS = 5000;
const ACTIVITY_SESSION_RETENTION_MS = 6 * 60 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function parsePositiveNumber(rawValue, fallback) {
  const parsed = Number(String(rawValue ?? "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function withDefault(value, fallback) {
  return String(value ?? "").trim() || fallback;
}

function sanitizeFileToken(value, fallback = "bridge") {
  const normalized = String(value ?? "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized || fallback;
}

function parseTimestampMs(value) {
  const timestampMs = Date.parse(String(value ?? "").trim());
  return Number.isFinite(timestampMs) ? timestampMs : 0;
}

function readJsonFile(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, filePath);
}

function resolveStatusPath(env = process.env, workspaceRoot = process.cwd()) {
  return withDefault(
    env.OCTOP_APP_SERVER_RUNTIME_STATUS_PATH,
    resolveAppServerRuntimePaths(env, workspaceRoot).statusPath
  );
}

function resolveActivityDir(env = process.env, workspaceRoot = process.cwd()) {
  return withDefault(
    env.OCTOP_APP_SERVER_ACTIVITY_DIR,
    resolveAppServerRuntimePaths(env, workspaceRoot).activityDir
  );
}

function readRuntimeStatusFile(statusPath) {
  const parsed = readJsonFile(statusPath);
  return parsed && typeof parsed === "object" ? parsed : {};
}

function cleanupOldActivitySessions(activityDir, nowMs = Date.now()) {
  if (!activityDir || !existsSync(activityDir)) {
    return;
  }

  for (const entryName of readdirSync(activityDir)) {
    if (!entryName.endsWith(".json")) {
      continue;
    }

    const sessionPath = resolve(activityDir, entryName);
    const session = readJsonFile(sessionPath);

    if (!session || typeof session !== "object") {
      rmSync(sessionPath, { force: true });
      continue;
    }

    const stoppedAtMs = parseTimestampMs(session.stopped_at);
    const heartbeatAtMs = parseTimestampMs(session.last_heartbeat_at);
    const referenceMs = Math.max(stoppedAtMs, heartbeatAtMs);

    if (referenceMs > 0 && nowMs - referenceMs > ACTIVITY_SESSION_RETENTION_MS) {
      rmSync(sessionPath, { force: true });
    }
  }
}

function listActivitySessions(activityDir, staleAfterMs = DEFAULT_ACTIVITY_BEACON_STALE_MS, nowMs = Date.now()) {
  cleanupOldActivitySessions(activityDir, nowMs);

  if (!activityDir || !existsSync(activityDir)) {
    return [];
  }

  const sessions = [];

  for (const entryName of readdirSync(activityDir)) {
    if (!entryName.endsWith(".json")) {
      continue;
    }

    const sessionPath = resolve(activityDir, entryName);
    const session = readJsonFile(sessionPath);

    if (!session || typeof session !== "object") {
      continue;
    }

    const lastHeartbeatAt = String(session.last_heartbeat_at ?? "").trim();
    const lastHeartbeatAtMs = parseTimestampMs(lastHeartbeatAt);
    const stoppedAt = String(session.stopped_at ?? "").trim();
    const fresh = Boolean(lastHeartbeatAtMs) && nowMs - lastHeartbeatAtMs <= staleAfterMs;
    const active = !stoppedAt && fresh;

    sessions.push({
      sessionId: String(session.session_id ?? entryName.replace(/\.json$/u, "")).trim(),
      label: String(session.label ?? "").trim(),
      metadata: session.metadata && typeof session.metadata === "object" ? session.metadata : {},
      startedAt: String(session.started_at ?? "").trim() || null,
      lastHeartbeatAt: lastHeartbeatAt || null,
      lastHeartbeatAtMs,
      stoppedAt: stoppedAt || null,
      active,
      fresh,
      filePath: sessionPath
    });
  }

  return sessions.sort((left, right) => right.lastHeartbeatAtMs - left.lastHeartbeatAtMs);
}

export function resolveOctopStateDir(env = process.env) {
  const configured = String(env.OCTOP_STATE_HOME ?? "").trim();
  return configured ? resolve(configured) : resolve(os.homedir(), ".octop");
}

export function resolveAppServerRuntimePaths(env = process.env, workspaceRoot = process.cwd()) {
  const stateDir = resolveOctopStateDir(env);
  const bridgeId = sanitizeFileToken(env.OCTOP_BRIDGE_ID ?? os.hostname());

  return {
    stateDir,
    statusPath: resolve(stateDir, `${bridgeId}-app-server-runtime.json`),
    activityDir: resolve(stateDir, `${bridgeId}-app-server-activity`),
    scriptPath: resolve(workspaceRoot, "scripts", "app-server-activity-beacon.mjs")
  };
}

export function applyAppServerRuntimeEnv(env = process.env, workspaceRoot = process.cwd()) {
  const paths = resolveAppServerRuntimePaths(env, workspaceRoot);

  return {
    ...env,
    OCTOP_APP_SERVER_RUNTIME_STATUS_PATH: withDefault(
      env.OCTOP_APP_SERVER_RUNTIME_STATUS_PATH,
      paths.statusPath
    ),
    OCTOP_APP_SERVER_ACTIVITY_DIR: withDefault(
      env.OCTOP_APP_SERVER_ACTIVITY_DIR,
      paths.activityDir
    ),
    OCTOP_APP_SERVER_ACTIVITY_BEACON_SCRIPT_PATH: withDefault(
      env.OCTOP_APP_SERVER_ACTIVITY_BEACON_SCRIPT_PATH,
      paths.scriptPath
    ),
    OCTOP_APP_SERVER_ACTIVITY_BEACON_STALE_MS: withDefault(
      env.OCTOP_APP_SERVER_ACTIVITY_BEACON_STALE_MS,
      String(DEFAULT_ACTIVITY_BEACON_STALE_MS)
    ),
    OCTOP_APP_SERVER_ACTIVITY_BEACON_PULSE_INTERVAL_MS: withDefault(
      env.OCTOP_APP_SERVER_ACTIVITY_BEACON_PULSE_INTERVAL_MS,
      String(DEFAULT_ACTIVITY_BEACON_PULSE_INTERVAL_MS)
    ),
    OCTOP_APP_SERVER_RUNTIME_HEARTBEAT_INTERVAL_MS: withDefault(
      env.OCTOP_APP_SERVER_RUNTIME_HEARTBEAT_INTERVAL_MS,
      String(DEFAULT_RUNTIME_HEARTBEAT_INTERVAL_MS)
    )
  };
}

export function createAppServerRuntimeTracker({
  env = process.env,
  workspaceRoot = process.cwd(),
  launcher = "unknown"
} = {}) {
  const runtimeEnv = applyAppServerRuntimeEnv(env, workspaceRoot);
  const statusPath = resolveStatusPath(runtimeEnv, workspaceRoot);
  const activityDir = resolveActivityDir(runtimeEnv, workspaceRoot);
  const heartbeatIntervalMs = parsePositiveNumber(
    runtimeEnv.OCTOP_APP_SERVER_RUNTIME_HEARTBEAT_INTERVAL_MS,
    DEFAULT_RUNTIME_HEARTBEAT_INTERVAL_MS
  );
  let heartbeatTimer = null;
  let currentStatus = readRuntimeStatusFile(statusPath);

  function stopHeartbeatTimer() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function writeStatus(patch = {}) {
    currentStatus = {
      version: 1,
      launcher,
      supervisor_pid: process.pid,
      status_path: statusPath,
      activity_dir: activityDir,
      ...currentStatus,
      ...patch,
      updated_at: nowIso()
    };
    writeJsonAtomic(statusPath, currentStatus);
    return currentStatus;
  }

  writeStatus({
    state: String(currentStatus.state ?? "idle").trim() || "idle",
    process_alive: currentStatus.process_alive === true
  });

  return {
    env: runtimeEnv,
    statusPath,
    activityDir,
    markProcessLaunching({ command = "" } = {}) {
      writeStatus({
        state: "starting",
        command: String(command ?? "").trim(),
        process_alive: false,
        child_pid: null,
        child_started_at: null,
        last_heartbeat_at: null,
        last_error: null
      });
    },
    attachChild(child, { command = "" } = {}) {
      stopHeartbeatTimer();
      const heartbeat = nowIso();
      writeStatus({
        state: "running",
        command: String(command ?? "").trim(),
        process_alive: true,
        child_pid: child?.pid ?? null,
        child_started_at: heartbeat,
        last_heartbeat_at: heartbeat,
        last_exit_at: null,
        last_exit_code: null,
        last_exit_signal: null,
        last_error: null
      });

      heartbeatTimer = setInterval(() => {
        if (!child || child.exitCode !== null || child.killed) {
          stopHeartbeatTimer();
          return;
        }

        writeStatus({
          state: "running",
          process_alive: true,
          child_pid: child.pid ?? null,
          last_heartbeat_at: nowIso()
        });
      }, heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    },
    markStdoutActivity() {
      const activityAt = nowIso();
      writeStatus({
        state: "running",
        process_alive: true,
        last_stdout_activity_at: activityAt,
        last_heartbeat_at: activityAt
      });
    },
    markStderrActivity() {
      const activityAt = nowIso();
      writeStatus({
        state: "running",
        process_alive: true,
        last_stderr_activity_at: activityAt,
        last_heartbeat_at: activityAt
      });
    },
    markProcessExit({ code = null, signal = null, reason = "" } = {}) {
      stopHeartbeatTimer();
      writeStatus({
        state: "exited",
        process_alive: false,
        child_pid: null,
        last_exit_at: nowIso(),
        last_exit_code: code ?? null,
        last_exit_signal: signal ?? null,
        last_error:
          String(reason ?? "").trim() ||
          (code === 0 || signal === "SIGTERM"
            ? null
            : `app-server exited (${code ?? signal ?? "unknown"})`)
      });
    },
    markProcessError(error) {
      writeStatus({
        state: "error",
        last_error: error instanceof Error ? error.message : String(error)
      });
    },
    dispose({ state = "stopped" } = {}) {
      stopHeartbeatTimer();
      writeStatus({
        state,
        process_alive: false,
        child_pid: null
      });
    }
  };
}

export function createActivitySession({
  env = process.env,
  workspaceRoot = process.cwd(),
  label = "",
  metadata = {}
} = {}) {
  const runtimeEnv = applyAppServerRuntimeEnv(env, workspaceRoot);
  const activityDir = resolveActivityDir(runtimeEnv, workspaceRoot);
  const sessionId = randomUUID();
  const sessionPath = resolve(activityDir, `${sessionId}.json`);
  const heartbeatAt = nowIso();

  mkdirSync(activityDir, { recursive: true });
  writeJsonAtomic(sessionPath, {
    session_id: sessionId,
    label: String(label ?? "").trim(),
    started_at: heartbeatAt,
    last_heartbeat_at: heartbeatAt,
    pid: process.pid,
    metadata: metadata && typeof metadata === "object" ? metadata : {}
  });

  return {
    sessionId,
    sessionPath,
    activityDir,
    env: runtimeEnv
  };
}

export function pulseActivitySession({
  activityDir,
  sessionId,
  label = "",
  metadata = {}
} = {}) {
  if (!activityDir || !sessionId) {
    return null;
  }

  const sessionPath = resolve(activityDir, `${sessionId}.json`);
  const current = readJsonFile(sessionPath);

  if (!current || typeof current !== "object") {
    return null;
  }

  const next = {
    ...current,
    session_id: sessionId,
    label: String(label ?? "").trim() || String(current.label ?? "").trim(),
    last_heartbeat_at: nowIso(),
    pid: process.pid,
    ...(metadata && typeof metadata === "object" && Object.keys(metadata).length > 0
      ? {
          metadata: {
            ...(current.metadata && typeof current.metadata === "object" ? current.metadata : {}),
            ...metadata
          }
        }
      : {})
  };

  writeJsonAtomic(sessionPath, next);
  return next;
}

export function stopActivitySession({
  activityDir,
  sessionId,
  status = "completed",
  error = ""
} = {}) {
  if (!activityDir || !sessionId) {
    return null;
  }

  const sessionPath = resolve(activityDir, `${sessionId}.json`);
  const current = readJsonFile(sessionPath);

  if (!current || typeof current !== "object") {
    return null;
  }

  const next = {
    ...current,
    stopped_at: nowIso(),
    status: String(status ?? "").trim() || "completed",
    ...(String(error ?? "").trim() ? { error: String(error ?? "").trim() } : {})
  };

  writeJsonAtomic(sessionPath, next);
  return next;
}

export function readAppServerRuntimeSnapshot({
  env = process.env,
  workspaceRoot = process.cwd()
} = {}) {
  const runtimeEnv = applyAppServerRuntimeEnv(env, workspaceRoot);
  const statusPath = resolveStatusPath(runtimeEnv, workspaceRoot);
  const activityDir = resolveActivityDir(runtimeEnv, workspaceRoot);
  const staleAfterMs = parsePositiveNumber(
    runtimeEnv.OCTOP_APP_SERVER_ACTIVITY_BEACON_STALE_MS,
    DEFAULT_ACTIVITY_BEACON_STALE_MS
  );
  const heartbeatFreshWindowMs = Math.max(
    staleAfterMs,
    parsePositiveNumber(
      runtimeEnv.OCTOP_APP_SERVER_RUNTIME_HEARTBEAT_INTERVAL_MS,
      DEFAULT_RUNTIME_HEARTBEAT_INTERVAL_MS
    ) * 3
  );
  const runtimeStatus = readRuntimeStatusFile(statusPath);
  const nowMs = Date.now();
  const statusHeartbeatAtMs = parseTimestampMs(runtimeStatus.last_heartbeat_at);
  const sessions = listActivitySessions(activityDir, staleAfterMs, nowMs);
  const activeSessions = sessions.filter((session) => session.active);
  const latestSession = sessions[0] ?? null;

  return {
    statusPath,
    activityDir,
    runtime: {
      available: Boolean(statusPath),
      state: String(runtimeStatus.state ?? "").trim() || null,
      processAlive: runtimeStatus.process_alive === true,
      heartbeatFresh:
        runtimeStatus.process_alive === true &&
        statusHeartbeatAtMs > 0 &&
        nowMs - statusHeartbeatAtMs <= heartbeatFreshWindowMs,
      lastHeartbeatAt: String(runtimeStatus.last_heartbeat_at ?? "").trim() || null,
      lastStdoutActivityAt: String(runtimeStatus.last_stdout_activity_at ?? "").trim() || null,
      lastStderrActivityAt: String(runtimeStatus.last_stderr_activity_at ?? "").trim() || null,
      childPid: Number(runtimeStatus.child_pid ?? 0) || null,
      lastExitAt: String(runtimeStatus.last_exit_at ?? "").trim() || null,
      lastExitCode: runtimeStatus.last_exit_code ?? null,
      lastExitSignal: String(runtimeStatus.last_exit_signal ?? "").trim() || null,
      lastError: String(runtimeStatus.last_error ?? "").trim() || null
    },
    activityBeacon: {
      available: Boolean(activityDir),
      active: activeSessions.length > 0,
      fresh: activeSessions.length > 0,
      activeCount: activeSessions.length,
      staleAfterMs,
      lastHeartbeatAt: latestSession?.lastHeartbeatAt ?? null,
      lastLabel: latestSession?.label ?? null
    }
  };
}
