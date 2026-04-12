import { spawn } from "node:child_process";
import { createAppServerRuntimeTracker } from "./app-server-runtime-state.mjs";
import { loadOctopEnv, resolveBridgeRuntimeEnv } from "./shared-env.mjs";

const workspaceRoot = process.cwd();
const runtimeTracker = createAppServerRuntimeTracker({
  env: await resolveBridgeRuntimeEnv(loadOctopEnv(workspaceRoot)),
  workspaceRoot,
  launcher: "run-app-server"
});
const env = runtimeTracker.env;

console.log("OctOP app-server launcher");
console.log(`- listen: ${env.OCTOP_APP_SERVER_WS_URL}`);
console.log(`- command: ${env.OCTOP_APP_SERVER_COMMAND}`);
console.log(`- runtime-status: ${runtimeTracker.statusPath}`);

runtimeTracker.markProcessLaunching({ command: env.OCTOP_APP_SERVER_COMMAND });
const appServerProcess = spawn(env.OCTOP_APP_SERVER_COMMAND, {
  cwd: workspaceRoot,
  env,
  stdio: "inherit",
  shell: true
});
runtimeTracker.attachChild(appServerProcess, {
  command: env.OCTOP_APP_SERVER_COMMAND
});

appServerProcess.on("exit", (code, signal) => {
  runtimeTracker.markProcessExit({
    code,
    signal,
    reason: signal ? `app-server exited via ${signal}` : ""
  });

  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

appServerProcess.on("error", (error) => {
  runtimeTracker.markProcessError(error);
});

for (const eventName of ["SIGINT", "SIGTERM"]) {
  process.on(eventName, () => {
    if (!appServerProcess.killed) {
      appServerProcess.kill(eventName);
    }
  });
}
