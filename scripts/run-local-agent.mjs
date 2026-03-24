import net from "node:net";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
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

const bridgeEntry = resolve(workspaceRoot, "scripts", "run-bridge.mjs");
const bridgeProcess = spawn(process.execPath, [bridgeEntry], {
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
