import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { loadOctopEnv } from "./shared-env.mjs";

const workspaceRoot = process.cwd();
const env = loadOctopEnv(workspaceRoot);

console.log("OctOP bridge launcher");
console.log(`- bridge: http://${env.OCTOP_BRIDGE_HOST}:${env.OCTOP_BRIDGE_PORT}`);
console.log(`- nats: ${env.OCTOP_NATS_URL}`);
console.log(`- app-server: ${env.OCTOP_APP_SERVER_WS_URL}`);

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
