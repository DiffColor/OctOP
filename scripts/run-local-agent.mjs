import { spawn } from "node:child_process";
import { loadOctopEnv, resolveBridgeRuntimeEnv } from "./shared-env.mjs";

const workspaceRoot = process.cwd();
const shouldPrompt = process.argv.includes("--prompt");
const env = await resolveBridgeRuntimeEnv(loadOctopEnv(workspaceRoot), {
  prompt: shouldPrompt
});
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
console.log(`- owner-user: ${env.OCTOP_BRIDGE_OWNER_USER_ID}`);

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
