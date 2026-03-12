import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { applyBridgeCliArgs, loadOctopEnv, resolveBridgeRuntimeEnv } from "./shared-env.mjs";

const workspaceRoot = process.cwd();
const env = await resolveBridgeRuntimeEnv(
  applyBridgeCliArgs(loadOctopEnv(workspaceRoot), process.argv.slice(2))
);

console.log("OctOP bridge launcher");
console.log(`- bridge: http://${env.OCTOP_BRIDGE_HOST}:${env.OCTOP_BRIDGE_PORT}`);
console.log(`- nats: ${env.OCTOP_NATS_URL}`);
console.log(`- app-server: ${env.OCTOP_APP_SERVER_WS_URL}`);
console.log(`- bridge-id: ${env.OCTOP_BRIDGE_ID}`);
console.log(`- device: ${env.OCTOP_BRIDGE_DEVICE_NAME}`);
console.log(`- owner-login: ${env.OCTOP_BRIDGE_OWNER_LOGIN_ID}`);

const bridgeEntry = resolve(workspaceRoot, "services/codex-adapter/src/index.js");
const bridgeProcess = spawn(process.execPath, [bridgeEntry], {
  cwd: workspaceRoot,
  env,
  stdio: "inherit"
});

bridgeProcess.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

for (const eventName of ["SIGINT", "SIGTERM"]) {
  process.on(eventName, () => {
    if (!bridgeProcess.killed) {
      bridgeProcess.kill(eventName);
    }
  });
}
