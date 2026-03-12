import { spawn } from "node:child_process";
import { loadOctopEnv } from "./shared-env.mjs";

const workspaceRoot = process.cwd();
const env = loadOctopEnv(workspaceRoot);

console.log("OctOP app-server launcher");
console.log(`- listen: ${env.OCTOP_APP_SERVER_WS_URL}`);
console.log(`- command: ${env.OCTOP_APP_SERVER_COMMAND}`);

const appServerProcess = spawn(env.OCTOP_APP_SERVER_COMMAND, {
  cwd: workspaceRoot,
  env,
  stdio: "inherit",
  shell: true
});

appServerProcess.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

for (const eventName of ["SIGINT", "SIGTERM"]) {
  process.on(eventName, () => {
    if (!appServerProcess.killed) {
      appServerProcess.kill(eventName);
    }
  });
}
