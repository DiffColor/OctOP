import net from "node:net";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  createAppServerRuntimeTracker,
  readAppServerRuntimeSnapshot
} from "./app-server-runtime-state.mjs";
import { applyBridgeCliArgs, loadOctopEnv, resolveBridgeRuntimeEnv } from "./shared-env.mjs";
import {
  evaluateBridgeAppServerRecovery
} from "./local-agent-health.mjs";

const workspaceRoot = process.cwd();
const runtimeTracker = createAppServerRuntimeTracker({
  env: await prepareLocalAgentEnv(await resolveBridgeRuntimeEnv(
    applyBridgeCliArgs(loadOctopEnv(workspaceRoot), process.argv.slice(2))
  )),
  workspaceRoot,
  launcher: "run-local-agent"
});
const env = runtimeTracker.env;
const bridgeEnv = {
  ...env,
  OCTOP_APP_SERVER_AUTOSTART: "false"
};
const APP_SERVER_RESTART_INITIAL_DELAY_MS = normalizePositiveNumber(
  env.OCTOP_APP_SERVER_RESTART_INITIAL_DELAY_MS,
  500
);
const APP_SERVER_RESTART_MAX_DELAY_MS = normalizePositiveNumber(
  env.OCTOP_APP_SERVER_RESTART_MAX_DELAY_MS,
  5000
);
const APP_SERVER_RESTART_MAX_ATTEMPTS = normalizePositiveInteger(
  env.OCTOP_APP_SERVER_RESTART_MAX_ATTEMPTS,
  12
);
const APP_SERVER_RESTART_STABLE_WINDOW_MS = normalizePositiveNumber(
  env.OCTOP_APP_SERVER_RESTART_STABLE_WINDOW_MS,
  15000
);
const APP_SERVER_CONTROLLED_RESTART_DELAY_MS = normalizePositiveNumber(
  env.OCTOP_APP_SERVER_CONTROLLED_RESTART_DELAY_MS,
  400
);
const APP_SERVER_HEALTHCHECK_INTERVAL_MS = normalizePositiveNumber(
  env.OCTOP_APP_SERVER_HEALTHCHECK_INTERVAL_MS,
  5000
);
const APP_SERVER_HEALTHCHECK_FAILURE_THRESHOLD = normalizePositiveInteger(
  env.OCTOP_APP_SERVER_HEALTHCHECK_FAILURE_THRESHOLD,
  3
);
const APP_SERVER_HEALTHCHECK_STARTUP_GRACE_MS = normalizePositiveNumber(
  env.OCTOP_APP_SERVER_HEALTHCHECK_STARTUP_GRACE_MS,
  Math.max(15000, APP_SERVER_RESTART_STABLE_WINDOW_MS)
);
const FULL_SERVICE_RESTART_DELAY_MS = 60000;
const BRIDGE_HEALTHCHECK_TIMEOUT_MS = normalizePositiveNumber(
  env.OCTOP_BRIDGE_HEALTHCHECK_TIMEOUT_MS,
  1500
);

console.log("OctOP local agent launcher");
console.log(`- app-server: ${env.OCTOP_APP_SERVER_WS_URL}`);
console.log(`- bridge: http://${env.OCTOP_BRIDGE_HOST}:${env.OCTOP_BRIDGE_PORT}`);
console.log(`- nats: ${env.OCTOP_NATS_URL}`);
console.log(`- bridge-id: ${env.OCTOP_BRIDGE_ID}`);
console.log(`- device: ${env.OCTOP_BRIDGE_DEVICE_NAME}`);
console.log(`- owner-login: ${env.OCTOP_BRIDGE_OWNER_LOGIN_ID}`);

let bridgeProcess = null;
let appServerProcess = null;
let appServerRestartCount = 0;
let appServerStartedAt = 0;
let appServerRestartTimer = null;
let appServerHealthMonitorTimer = null;
let appServerHealthCheckInFlight = false;
let appServerHealthFailureCount = 0;
let pendingControlledAppServerRestartReason = "";
let pendingFullServiceRestartReason = "";
let fullServiceRestartTimer = null;
let isShuttingDown = false;

function normalizePositiveNumber(rawValue, fallback) {
  const parsed = Number(String(rawValue ?? "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePositiveInteger(rawValue, fallback) {
  const parsed = Number.parseInt(String(rawValue ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clearAppServerRestartTimer() {
  if (appServerRestartTimer) {
    clearTimeout(appServerRestartTimer);
    appServerRestartTimer = null;
  }
}

function clearAppServerHealthMonitor() {
  if (appServerHealthMonitorTimer) {
    clearInterval(appServerHealthMonitorTimer);
    appServerHealthMonitorTimer = null;
  }
}

function clearFullServiceRestartTimer() {
  if (fullServiceRestartTimer) {
    clearTimeout(fullServiceRestartTimer);
    fullServiceRestartTimer = null;
  }
}

function resetAppServerHealthFailures() {
  appServerHealthFailureCount = 0;
}

function calculateRestartDelay(attempt) {
  return Math.min(APP_SERVER_RESTART_MAX_DELAY_MS, APP_SERVER_RESTART_INITIAL_DELAY_MS * (2 ** Math.max(0, attempt - 1)));
}

function stopAll(signal = "SIGTERM") {
  isShuttingDown = true;
  clearAppServerRestartTimer();
  clearAppServerHealthMonitor();
  clearFullServiceRestartTimer();
  pendingFullServiceRestartReason = "";

  if (isProcessRunning(appServerProcess) && !appServerProcess.killed) {
    appServerProcess.kill(signal);
  }

  if (isProcessRunning(bridgeProcess) && !bridgeProcess.killed) {
    bridgeProcess.kill(signal);
  }
}

function isProcessRunning(process) {
  return Boolean(process && process.exitCode === null);
}

function hasRunningServiceProcesses() {
  return isProcessRunning(appServerProcess) || isProcessRunning(bridgeProcess);
}

function resetRuntimeStateForFullServiceRestart() {
  clearAppServerRestartTimer();
  clearAppServerHealthMonitor();
  appServerHealthCheckInFlight = false;
  appServerRestartCount = 0;
  appServerStartedAt = 0;
  pendingControlledAppServerRestartReason = "";
  resetAppServerHealthFailures();
}

function scheduleFullServiceRestart(delayMs, reason) {
  clearFullServiceRestartTimer();
  fullServiceRestartTimer = setTimeout(() => {
    fullServiceRestartTimer = null;
    if (isShuttingDown) {
      return;
    }

    const restartReason = pendingFullServiceRestartReason || reason;
    pendingFullServiceRestartReason = "";
    resetRuntimeStateForFullServiceRestart();
    console.warn(`[OctOP] 전체 서비스 재시작 실행: ${restartReason}`);
    startServices({ reason: restartReason, resetAppServerRestartCount: true });
  }, Math.max(0, Number(delayMs) || 0));
  fullServiceRestartTimer.unref?.();
}

function maybeScheduleFullServiceRestart(source = "unspecified") {
  if (isShuttingDown || !pendingFullServiceRestartReason) {
    return false;
  }

  if (hasRunningServiceProcesses()) {
    return false;
  }

  if (fullServiceRestartTimer) {
    return true;
  }

  resetRuntimeStateForFullServiceRestart();
  console.warn(
    `[OctOP] 전체 서비스 종료 및 초기화 완료. ${FULL_SERVICE_RESTART_DELAY_MS}ms 후 전체 서비스를 다시 시작합니다. (${source})`
  );
  scheduleFullServiceRestart(FULL_SERVICE_RESTART_DELAY_MS, pendingFullServiceRestartReason);
  return true;
}

function requestFullServiceRestart(reason) {
  if (isShuttingDown) {
    return false;
  }

  if (pendingFullServiceRestartReason) {
    return false;
  }

  pendingFullServiceRestartReason = String(reason ?? "").trim() || "app-server restart attempts exceeded";
  clearAppServerRestartTimer();
  clearAppServerHealthMonitor();
  appServerHealthCheckInFlight = false;
  pendingControlledAppServerRestartReason = "";
  resetAppServerHealthFailures();

  console.error(
    `[OctOP] app-server 재시도 한도 초과. 서비스 중지와 동일한 정리를 수행한 뒤 ${FULL_SERVICE_RESTART_DELAY_MS}ms 후 전체 서비스를 다시 시작합니다.`
  );

  if (isProcessRunning(appServerProcess) && !appServerProcess.killed) {
    appServerProcess.kill("SIGTERM");
  }

  if (isProcessRunning(bridgeProcess) && !bridgeProcess.killed) {
    bridgeProcess.kill("SIGTERM");
  }

  if (!hasRunningServiceProcesses()) {
    maybeScheduleFullServiceRestart("request_full_service_restart");
  }

  return true;
}

function scheduleAppServerRestart(delayMs, reason) {
  clearAppServerRestartTimer();
  appServerRestartTimer = setTimeout(() => {
    appServerRestartTimer = null;
    console.warn(`[OctOP] app-server 재시작 실행: ${reason}`);
    startAppServer();
  }, Math.max(0, Number(delayMs) || 0));
  appServerRestartTimer.unref?.();
}

function requestControlledAppServerRestart(reason) {
  if (isShuttingDown || !appServerProcess || appServerProcess.killed) {
    return false;
  }

  if (pendingControlledAppServerRestartReason) {
    return false;
  }

  pendingControlledAppServerRestartReason = String(reason ?? "").trim() || "bridge health degraded";
  clearAppServerRestartTimer();
  resetAppServerHealthFailures();
  console.warn(`[OctOP] app-server 제어 재시작 요청: ${pendingControlledAppServerRestartReason}`);

  try {
    appServerProcess.kill("SIGTERM");
    return true;
  } catch (error) {
    console.error(`[OctOP] app-server 제어 재시작 신호 전송 실패: ${error instanceof Error ? error.message : String(error)}`);
    pendingControlledAppServerRestartReason = "";
    return false;
  }
}

function startAppServer() {
  if (isShuttingDown) {
    return;
  }

  appServerStartedAt = Date.now();
  pendingControlledAppServerRestartReason = "";
  resetAppServerHealthFailures();
  runtimeTracker.markProcessLaunching({ command: env.OCTOP_APP_SERVER_COMMAND });
  appServerProcess = spawn(env.OCTOP_APP_SERVER_COMMAND, {
    cwd: workspaceRoot,
    env,
    stdio: "inherit",
    shell: true
  });
  runtimeTracker.attachChild(appServerProcess, {
    command: env.OCTOP_APP_SERVER_COMMAND
  });

  appServerProcess.on("exit", (code, signal) => {
    const controlledRestartReason = pendingControlledAppServerRestartReason;
    const fullServiceRestartReason = pendingFullServiceRestartReason;
    pendingControlledAppServerRestartReason = "";
    runtimeTracker.markProcessExit({
      code,
      signal,
      reason:
        controlledRestartReason ||
        fullServiceRestartReason ||
        (signal ? `app-server exited via ${signal}` : "")
    });

    if (isShuttingDown) {
      appServerProcess = null;
      return;
    }

    appServerProcess = null;

    if (fullServiceRestartReason) {
      console.warn(`[OctOP] app-server 전체 서비스 재시작 대기: ${fullServiceRestartReason}`);
      maybeScheduleFullServiceRestart("app_server_exit");
      return;
    }

    if (controlledRestartReason) {
      console.warn(`[OctOP] app-server 제어 재시작 진행: ${controlledRestartReason}`);
      scheduleAppServerRestart(APP_SERVER_CONTROLLED_RESTART_DELAY_MS, controlledRestartReason);
      return;
    }

    const stableRunWindowReached = appServerStartedAt > 0 &&
      Date.now() - appServerStartedAt >= APP_SERVER_RESTART_STABLE_WINDOW_MS;

    if (stableRunWindowReached) {
      appServerRestartCount = 0;
    }

    const detail = signal ? `signal=${signal}` : `code=${code ?? "unknown"}`;
    console.warn(`[OctOP] app-server exited unexpectedly (${detail}).`);

    appServerRestartCount += 1;
    if (appServerRestartCount > APP_SERVER_RESTART_MAX_ATTEMPTS) {
      requestFullServiceRestart(`restart_limit_exceeded:${detail}`);
      return;
    }

    const delay = calculateRestartDelay(appServerRestartCount);
    scheduleAppServerRestart(delay, `unexpected_exit:${detail}`);

    console.warn(`[OctOP] app-server 재시작 대기 ${delay}ms (시도 ${appServerRestartCount}/${APP_SERVER_RESTART_MAX_ATTEMPTS})`);
  });

  appServerProcess.on("error", (error) => {
    if (isShuttingDown) {
      return;
    }

    runtimeTracker.markProcessError(error);
    console.error(`[OctOP] app-server process error: ${error.message}`);
  });
}

function normalizeBridgeProbeHost(host) {
  const trimmed = String(host ?? "").trim();

  if (!trimmed || trimmed === "0.0.0.0" || trimmed === "::" || trimmed === "[::]") {
    return "127.0.0.1";
  }

  return trimmed;
}

function buildBridgeHealthUrl() {
  const bridgePort = normalizePort(bridgeEnv.OCTOP_BRIDGE_PORT);

  if (bridgePort === null) {
    return null;
  }

  const url = new URL(`http://${normalizeBridgeProbeHost(bridgeEnv.OCTOP_BRIDGE_HOST)}:${bridgePort}/health`);
  const ownerLoginId = String(bridgeEnv.OCTOP_BRIDGE_OWNER_LOGIN_ID ?? "").trim();

  if (ownerLoginId) {
    url.searchParams.set("user_id", ownerLoginId);
  }

  return url;
}

async function readBridgeHealth() {
  const url = buildBridgeHealthUrl();

  if (!url) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BRIDGE_HEALTHCHECK_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "x-bridge-token": String(bridgeEnv.OCTOP_BRIDGE_TOKEN ?? "")
      },
      signal: controller.signal
    });

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function monitorBridgeHealth() {
  if (
    isShuttingDown ||
    appServerHealthCheckInFlight ||
    !bridgeProcess ||
    bridgeProcess.killed ||
    !appServerProcess ||
    appServerProcess.killed ||
    appServerRestartTimer ||
    pendingControlledAppServerRestartReason
  ) {
    return;
  }

  if (appServerStartedAt > 0 && Date.now() - appServerStartedAt < APP_SERVER_HEALTHCHECK_STARTUP_GRACE_MS) {
    return;
  }

  appServerHealthCheckInFlight = true;

  try {
    const health = await readBridgeHealth();
    const runtimeSnapshot = readAppServerRuntimeSnapshot({
      env,
      workspaceRoot
    });
    const evaluation = evaluateBridgeAppServerRecovery({
      health,
      runtimeSnapshot,
      consecutiveFailures: appServerHealthFailureCount,
      failureThreshold: APP_SERVER_HEALTHCHECK_FAILURE_THRESHOLD
    });

    if (!evaluation.usable) {
      return;
    }

    if (evaluation.healthy) {
      if (appServerHealthFailureCount > 0) {
        console.log("[OctOP] bridge health recovered. app-server 자동 재시작 대기를 해제합니다.");
      }
      resetAppServerHealthFailures();
      return;
    }

    if (!evaluation.recoverable) {
      resetAppServerHealthFailures();
      return;
    }

    appServerHealthFailureCount = evaluation.nextConsecutiveFailures;
    console.warn(
      `[OctOP] bridge health degraded (${appServerHealthFailureCount}/${APP_SERVER_HEALTHCHECK_FAILURE_THRESHOLD}): ${evaluation.summary}`
    );

    if (evaluation.shouldRestart) {
      requestControlledAppServerRestart(evaluation.reason);
    }
  } finally {
    appServerHealthCheckInFlight = false;
  }
}

function startBridgeHealthMonitor() {
  if (appServerHealthMonitorTimer || APP_SERVER_HEALTHCHECK_INTERVAL_MS <= 0) {
    return;
  }

  appServerHealthMonitorTimer = setInterval(() => {
    void monitorBridgeHealth();
  }, APP_SERVER_HEALTHCHECK_INTERVAL_MS);
  appServerHealthMonitorTimer.unref?.();

  queueMicrotask(() => {
    void monitorBridgeHealth();
  });
}

const bridgeEntry = resolve(workspaceRoot, "scripts", "run-bridge.mjs");

function startBridge() {
  if (isShuttingDown) {
    return;
  }

  bridgeProcess = spawn(process.execPath, [bridgeEntry], {
    cwd: workspaceRoot,
    env: bridgeEnv,
    stdio: "inherit"
  });

  bridgeProcess.on("exit", (code, signal) => {
    const fullServiceRestartReason = pendingFullServiceRestartReason;
    bridgeProcess = null;

    if (fullServiceRestartReason) {
      console.warn(`[OctOP] bridge 전체 서비스 재시작 대기: ${fullServiceRestartReason}`);
      maybeScheduleFullServiceRestart("bridge_exit");
      return;
    }

    isShuttingDown = true;
    clearAppServerRestartTimer();
    clearAppServerHealthMonitor();
    clearFullServiceRestartTimer();

    if (isProcessRunning(appServerProcess) && !appServerProcess.killed) {
      appServerProcess.kill("SIGTERM");
    }

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });

  bridgeProcess.on("error", (error) => {
    if (isShuttingDown || pendingFullServiceRestartReason) {
      return;
    }

    console.error(`[OctOP] bridge process error: ${error.message}`);
  });
}

function startServices({ reason = "startup", resetAppServerRestartCount = false } = {}) {
  if (isShuttingDown) {
    return;
  }

  if (resetAppServerRestartCount) {
    appServerRestartCount = 0;
  }

  appServerHealthCheckInFlight = false;
  pendingControlledAppServerRestartReason = "";
  console.warn(`[OctOP] 전체 서비스 시작: ${reason}`);
  startAppServer();
  startBridge();
  startBridgeHealthMonitor();
}

startServices();

for (const eventName of ["SIGINT", "SIGTERM"]) {
  process.on(eventName, () => stopAll(eventName));
}

async function prepareLocalAgentEnv(env) {
  const nextEnv = { ...env };
  const desiredBridgePort = normalizePort(nextEnv.OCTOP_BRIDGE_PORT);
  const desiredAppServerUrl = parseUrl(nextEnv.OCTOP_APP_SERVER_WS_URL);
  const desiredAppServerPort = desiredAppServerUrl ? normalizePort(desiredAppServerUrl.port) : null;
  const desiredAppServerUrlText = desiredAppServerUrl ? formatUrlWithoutTrailingSlash(desiredAppServerUrl) : null;

  if (desiredBridgePort !== null) {
    const bridgePort = await resolveAvailablePort({
      host: nextEnv.OCTOP_BRIDGE_HOST,
      preferredPort: desiredBridgePort,
      label: "bridge"
    });

    nextEnv.OCTOP_BRIDGE_PORT = String(bridgePort);
  }

  if (desiredAppServerUrl && desiredAppServerPort !== null) {
    const appServerPort = await resolveAvailablePort({
      host: desiredAppServerUrl.hostname,
      preferredPort: desiredAppServerPort,
      label: "app-server"
    });

    if (appServerPort !== desiredAppServerPort) {
      const nextAppServerUrl = new URL(desiredAppServerUrl.toString());
      nextAppServerUrl.port = String(appServerPort);
      nextEnv.OCTOP_APP_SERVER_WS_URL = formatUrlWithoutTrailingSlash(nextAppServerUrl);
      nextEnv.OCTOP_APP_SERVER_COMMAND = rewriteAppServerCommand({
        command: nextEnv.OCTOP_APP_SERVER_COMMAND,
        previousUrl: desiredAppServerUrlText,
        nextUrl: nextEnv.OCTOP_APP_SERVER_WS_URL
      });
    }
  }

  return nextEnv;
}

async function resolveAvailablePort({ host, preferredPort, label }) {
  if (await isPortAvailable(host, preferredPort)) {
    return preferredPort;
  }

  const fallbackPort = await getFreePort(host);
  console.warn(`[OctOP] ${label} port ${preferredPort} is busy, using ${fallbackPort} instead.`);
  return fallbackPort;
}

function normalizePort(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);

  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return null;
  }

  return parsed;
}

function parseUrl(value) {
  try {
    return new URL(String(value ?? "").trim());
  } catch {
    return null;
  }
}

function formatUrlWithoutTrailingSlash(url) {
  const nextUrl = new URL(url.toString());
  const pathname = nextUrl.pathname === "/" ? "" : nextUrl.pathname;
  return `${nextUrl.protocol}//${nextUrl.host}${pathname}${nextUrl.search}${nextUrl.hash}`;
}

function rewriteAppServerCommand({ command, previousUrl, nextUrl }) {
  const normalizedCommand = String(command ?? "").trim();
  const defaultCommand = `codex app-server --listen ${previousUrl}`;

  if (!normalizedCommand || normalizedCommand === defaultCommand) {
    return `codex app-server --listen ${nextUrl}`;
  }

  if (normalizedCommand.includes(previousUrl)) {
    return normalizedCommand.split(previousUrl).join(nextUrl);
  }

  return normalizedCommand;
}

async function isPortAvailable(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

async function getFreePort(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to resolve free port")));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}
