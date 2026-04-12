import { spawn } from "node:child_process";
import {
  applyAppServerRuntimeEnv,
  createActivitySession,
  pulseActivitySession,
  stopActivitySession
} from "./app-server-runtime-state.mjs";

function parsePositiveNumber(rawValue, fallback) {
  const parsed = Number(String(rawValue ?? "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function printUsage() {
  console.error(
    "Usage: node scripts/app-server-activity-beacon.mjs run --label <label> --shell <command>"
  );
}

function parseArgs(argv = []) {
  const options = {
    label: "",
    shellCommand: "",
    directCommand: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--label") {
      options.label = String(argv[index + 1] ?? "").trim();
      index += 1;
      continue;
    }

    if (token.startsWith("--label=")) {
      options.label = token.slice("--label=".length).trim();
      continue;
    }

    if (token === "--shell") {
      options.shellCommand = String(argv[index + 1] ?? "").trim();
      index += 1;
      continue;
    }

    if (token.startsWith("--shell=")) {
      options.shellCommand = token.slice("--shell=".length).trim();
      continue;
    }

    if (token === "--") {
      options.directCommand = argv.slice(index + 1);
      break;
    }
  }

  return options;
}

const workspaceRoot = process.cwd();
const env = applyAppServerRuntimeEnv(process.env, workspaceRoot);
const [command, ...restArgs] = process.argv.slice(2);

if (command !== "run") {
  printUsage();
  process.exit(1);
}

const options = parseArgs(restArgs);

if (!options.shellCommand && options.directCommand.length === 0) {
  printUsage();
  process.exit(1);
}

const session = createActivitySession({
  env,
  workspaceRoot,
  label: options.label,
  metadata: {
    mode: options.shellCommand ? "shell" : "direct"
  }
});
const pulseIntervalMs = parsePositiveNumber(
  env.OCTOP_APP_SERVER_ACTIVITY_BEACON_PULSE_INTERVAL_MS,
  5000
);
const child = options.shellCommand
  ? spawn(options.shellCommand, {
      cwd: workspaceRoot,
      env,
      stdio: "inherit",
      shell: true
    })
  : spawn(options.directCommand[0], options.directCommand.slice(1), {
      cwd: workspaceRoot,
      env,
      stdio: "inherit"
    });

function pulse() {
  pulseActivitySession({
    activityDir: session.activityDir,
    sessionId: session.sessionId,
    label: options.label,
    metadata: {
      child_pid: child.pid ?? null
    }
  });
}

const timer = setInterval(pulse, pulseIntervalMs);
timer.unref?.();
pulse();

function finish({ code = null, signal = null, error = null } = {}) {
  clearInterval(timer);
  stopActivitySession({
    activityDir: session.activityDir,
    sessionId: session.sessionId,
    status:
      error
        ? "error"
        : code && code !== 0
          ? "failed"
          : signal
            ? "signaled"
            : "completed",
    error: error ? (error instanceof Error ? error.message : String(error)) : ""
  });

  if (error) {
    console.error(`[OctOP] app-server activity beacon command failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
}

child.on("exit", (code, signal) => finish({ code, signal }));
child.on("error", (error) => finish({ error }));

for (const eventName of ["SIGINT", "SIGTERM"]) {
  process.on(eventName, () => {
    if (!child.killed) {
      child.kill(eventName);
    }
  });
}
