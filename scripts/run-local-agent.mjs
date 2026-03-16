import { spawn } from "node:child_process";
import net from "node:net";
import { applyBridgeCliArgs, loadOctopEnv, resolveBridgeRuntimeEnv } from "./shared-env.mjs";

const workspaceRoot = process.cwd();
const env = await resolveBridgeRuntimeEnv(
  applyBridgeCliArgs(loadOctopEnv(workspaceRoot), process.argv.slice(2))
);
const bridgeEnv = {
  ...env,
  OCTOP_APP_SERVER_AUTOSTART: "false"
};

console.log("OctOP local agent launcher");
console.log(`- app-server: ${env.OCTOP_APP_SERVER_WS_URL}`);
console.log(`- bridge: http://${env.OCTOP_BRIDGE_HOST}:${env.OCTOP_BRIDGE_PORT}`);
console.log(`- nats: ${env.OCTOP_NATS_URL}`);
console.log(`- bridge-id: ${env.OCTOP_BRIDGE_ID}`);
console.log(`- device: ${env.OCTOP_BRIDGE_DEVICE_NAME}`);
console.log(`- owner-login: ${env.OCTOP_BRIDGE_OWNER_LOGIN_ID}`);

const appServerUrl = new URL(env.OCTOP_APP_SERVER_WS_URL);
const bridgeHost = resolveConnectHost(env.OCTOP_BRIDGE_HOST);
const bridgePort = Number(env.OCTOP_BRIDGE_PORT);

const shouldReuseAppServer = await isPortOpen(appServerUrl.hostname, Number(appServerUrl.port));
const shouldReuseBridge = await isPortOpen(bridgeHost, bridgePort);

const appServerProcess = shouldReuseAppServer
  ? null
  : spawn(env.OCTOP_APP_SERVER_COMMAND, {
      cwd: workspaceRoot,
      env,
      stdio: "inherit",
      shell: true
    });

if (shouldReuseAppServer) {
  console.log(`[local-agent] existing app-server detected at ${env.OCTOP_APP_SERVER_WS_URL}; reusing`);
}

const bridgeProcess = shouldReuseBridge
  ? null
  : spawn(process.execPath, ["./scripts/run-bridge.mjs"], {
      cwd: workspaceRoot,
      env: bridgeEnv,
      stdio: "inherit"
    });

if (shouldReuseBridge) {
  console.log(`[local-agent] existing bridge detected at http://${bridgeHost}:${bridgePort}; reusing`);
}

if (!appServerProcess && !bridgeProcess) {
  console.log("[local-agent] no new processes started");
}

function stopAll(signal = "SIGTERM") {
  if (bridgeProcess && !bridgeProcess.killed) {
    bridgeProcess.kill(signal);
  }

  if (appServerProcess && !appServerProcess.killed) {
    appServerProcess.kill(signal);
  }
}

if (appServerProcess) {
  appServerProcess.on("exit", (code, signal) => {
    if (bridgeProcess && !bridgeProcess.killed) {
      bridgeProcess.kill("SIGTERM");
    }

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });
}

if (bridgeProcess) {
  bridgeProcess.on("exit", (code, signal) => {
    if (appServerProcess && !appServerProcess.killed) {
      appServerProcess.kill("SIGTERM");
    }

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });
}

for (const eventName of ["SIGINT", "SIGTERM"]) {
  process.on(eventName, () => stopAll(eventName));
}

function resolveConnectHost(host) {
  const normalized = String(host ?? "").trim();

  if (!normalized || normalized === "0.0.0.0" || normalized === "::") {
    return "127.0.0.1";
  }

  return normalized;
}

function isPortOpen(host, port) {
  return new Promise((resolve) => {
    if (!host || !Number.isFinite(port) || port <= 0) {
      resolve(false);
      return;
    }

    const socket = net.createConnection({ host, port });
    let settled = false;

    const finish = (result) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}
