import net from "node:net";
import { spawn } from "node:child_process";
import { applyBridgeCliArgs, loadOctopEnv, resolveBridgeRuntimeEnv } from "./shared-env.mjs";

const workspaceRoot = process.cwd();
const env = await prepareLocalAgentEnv(await resolveBridgeRuntimeEnv(
  applyBridgeCliArgs(loadOctopEnv(workspaceRoot), process.argv.slice(2))
));
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

const appServerProcess = spawn(env.OCTOP_APP_SERVER_COMMAND, {
  cwd: workspaceRoot,
  env,
  stdio: "inherit",
  shell: true
});

const bridgeProcess = spawn(process.execPath, ["./scripts/run-bridge.mjs"], {
  cwd: workspaceRoot,
  env: bridgeEnv,
  stdio: "inherit"
});

function stopAll(signal = "SIGTERM") {
  if (!bridgeProcess.killed) {
    bridgeProcess.kill(signal);
  }

  if (!appServerProcess.killed) {
    appServerProcess.kill(signal);
  }
}

appServerProcess.on("exit", (code, signal) => {
  if (!bridgeProcess.killed) {
    bridgeProcess.kill("SIGTERM");
  }

  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

bridgeProcess.on("exit", (code, signal) => {
  if (!appServerProcess.killed) {
    appServerProcess.kill("SIGTERM");
  }

  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

for (const eventName of ["SIGINT", "SIGTERM"]) {
  process.on(eventName, () => stopAll(eventName));
}

async function prepareLocalAgentEnv(env) {
  const nextEnv = { ...env };
  const desiredBridgePort = normalizePort(nextEnv.OCTOP_BRIDGE_PORT);
  const desiredAppServerUrl = parseUrl(nextEnv.OCTOP_APP_SERVER_WS_URL);
  const desiredAppServerPort = desiredAppServerUrl ? normalizePort(desiredAppServerUrl.port) : null;

  if (desiredBridgePort !== null) {
    if (!(await isPortAvailable(nextEnv.OCTOP_BRIDGE_HOST, desiredBridgePort))) {
      throw new Error(
        `[OctOP] bridge port ${desiredBridgePort} is busy. OCTOP_BRIDGE_PORT must remain fixed as ${desiredBridgePort}.`
      );
    }
  }

  if (desiredAppServerUrl && desiredAppServerPort !== null) {
    if (!(await isPortAvailable(desiredAppServerUrl.hostname, desiredAppServerPort))) {
      throw new Error(
        `[OctOP] app-server port ${desiredAppServerPort} is busy. OCTOP_APP_SERVER_WS_URL must remain fixed as ${formatUrlWithoutTrailingSlash(desiredAppServerUrl)}.`
      );
    }
  }

  return nextEnv;
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
