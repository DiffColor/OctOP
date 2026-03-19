import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { delimiter, resolve } from "node:path";

export function loadOctopEnv(workspaceRoot) {
  const envFilePaths = [".env.local", ".env"].map((file) => resolve(workspaceRoot, file));

  function parseEnvFile(filePath) {
    const values = {};
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/u);

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");

      if (separatorIndex < 0) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();

      if (!key) {
        continue;
      }

      values[key] = value;
    }

    return values;
  }

  function withDefault(value, fallback) {
    return value && String(value).trim() ? value : fallback;
  }

  const fileEnv = {};

  for (const filePath of envFilePaths) {
    if (!existsSync(filePath)) {
      continue;
    }

    Object.assign(fileEnv, parseEnvFile(filePath));
  }

  const env = {
    ...fileEnv,
    ...process.env
  };

  env.PATH = buildExecutablePath(env);

  env.OCTOP_NATS_URL = withDefault(env.OCTOP_NATS_URL, "nats://ilysrv.ddns.net:4222");
  env.OCTOP_BRIDGE_HOST = withDefault(env.OCTOP_BRIDGE_HOST, "0.0.0.0");
  env.OCTOP_BRIDGE_PORT = withDefault(env.OCTOP_BRIDGE_PORT, "4100");
  env.OCTOP_BRIDGE_MODE = withDefault(env.OCTOP_BRIDGE_MODE, "app-server");
  env.OCTOP_BRIDGE_TOKEN = withDefault(env.OCTOP_BRIDGE_TOKEN, "octop-local-bridge");
  env.OCTOP_APP_SERVER_MODE = withDefault(env.OCTOP_APP_SERVER_MODE, "ws-local");
  env.OCTOP_APP_SERVER_WS_URL = withDefault(env.OCTOP_APP_SERVER_WS_URL, "ws://127.0.0.1:4600");
  const codexExecutable = resolveExecutable(env, "codex") ?? "codex";
  env.OCTOP_APP_SERVER_COMMAND = withDefault(
    env.OCTOP_APP_SERVER_COMMAND,
    `${shellEscape(codexExecutable)} app-server --listen ${shellEscape(env.OCTOP_APP_SERVER_WS_URL)}`
  );
  env.OCTOP_APP_SERVER_AUTOSTART = withDefault(env.OCTOP_APP_SERVER_AUTOSTART, "true");
  env.OCTOP_APP_SERVER_STARTUP_TIMEOUT_MS = withDefault(
    env.OCTOP_APP_SERVER_STARTUP_TIMEOUT_MS,
    "15000"
  );
  env.OCTOP_APP_SERVER_THREAD_LIST_LIMIT = withDefault(
    env.OCTOP_APP_SERVER_THREAD_LIST_LIMIT,
    "50"
  );
  env.OCTOP_CODEX_MODEL = withDefault(env.OCTOP_CODEX_MODEL, "gpt-5.4");
  env.OCTOP_CODEX_REASONING_EFFORT = withDefault(env.OCTOP_CODEX_REASONING_EFFORT, "none");

  return env;
}

export function applyBridgeCliArgs(env, argv) {
  const args = parseCliArgs(argv);

  return {
    ...env,
    ...(args.deviceName ? { OCTOP_BRIDGE_DEVICE_NAME: args.deviceName } : {}),
    ...(args.ownerUserId ? {
      OCTOP_BRIDGE_OWNER_LOGIN_ID: args.ownerUserId,
      OCTOP_BRIDGE_OWNER_USER_ID: args.ownerUserId
    } : {})
  };
}

export async function resolveBridgeRuntimeEnv(env) {
  return applyBridgeIdentityDefaults(env);
}

function applyBridgeIdentityDefaults(env) {
  const hostname = os.hostname();
  const bridgeId = env.OCTOP_BRIDGE_ID?.trim() || loadOrCreateBridgeId(env);

  return {
    ...env,
    OCTOP_BRIDGE_ID: bridgeId,
    OCTOP_BRIDGE_DEVICE_NAME: env.OCTOP_BRIDGE_DEVICE_NAME?.trim() || hostname,
    OCTOP_BRIDGE_OWNER_LOGIN_ID:
      env.OCTOP_BRIDGE_OWNER_LOGIN_ID?.trim() ||
      env.OCTOP_BRIDGE_OWNER_USER_ID?.trim() ||
      "local-user",
    OCTOP_BRIDGE_OWNER_USER_ID:
      env.OCTOP_BRIDGE_OWNER_USER_ID?.trim() ||
      env.OCTOP_BRIDGE_OWNER_LOGIN_ID?.trim() ||
      "local-user"
  };
}

function parseCliArgs(argv = []) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("-")) {
      continue;
    }

    const normalized = token.startsWith("--") ? token.slice(2) : token.slice(1);
    const [rawKey, inlineValue] = normalized.split("=", 2);
    const key = rawKey.trim();

    if (!key) {
      continue;
    }

    const nextToken = argv[index + 1];
    const value =
      inlineValue ?? (nextToken && !nextToken.startsWith("--") ? (index += 1, nextToken) : "");

    if (!value) {
      continue;
    }

    if (key === "name") {
      parsed.deviceName = value.trim();
      continue;
    }

    if (key === "id") {
      parsed.ownerUserId = value.trim();
    }
  }

  return parsed;
}

function loadOrCreateBridgeId(env = process.env) {
  const configDir = resolveOctopStateDir(env);
  const bridgeIdPath = resolve(configDir, "bridge-id");

  if (existsSync(bridgeIdPath)) {
    const existing = readFileSync(bridgeIdPath, "utf8").trim();

    if (existing) {
      return existing;
    }
  }

  mkdirSync(configDir, { recursive: true });
  const generated = `bridge-${randomUUID()}`;
  writeFileSync(bridgeIdPath, `${generated}\n`, "utf8");
  return generated;
}

function resolveOctopStateDir(env = process.env) {
  const configured = String(env.OCTOP_STATE_HOME ?? "").trim();
  return configured ? resolve(configured) : resolve(os.homedir(), ".octop");
}

function buildExecutablePath(env) {
  const directories = [];
  const seen = new Set();
  const pathEntries = String(env.PATH ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const append = (value) => {
    const normalized = String(value ?? "").trim();

    if (!normalized || seen.has(normalized)) {
      return;
    }

    seen.add(normalized);
    directories.push(normalized);
  };

  for (const value of pathEntries) {
    append(value);
  }

  const home = os.homedir();

  if (process.platform === "win32") {
    [
      resolve(env.ProgramFiles ?? "", "nodejs"),
      resolve(env["ProgramFiles(x86)"] ?? "", "nodejs"),
      resolve(env.LocalAppData ?? "", "Programs", "nodejs"),
      resolve(home, ".volta", "bin"),
      resolve(home, "scoop", "shims"),
      resolve(home, "AppData", "Roaming", "npm")
    ].forEach(append);
  } else {
    [
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/local/sbin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      resolve(home, ".local/bin"),
      resolve(home, ".bun/bin"),
      resolve(home, ".volta/bin"),
      resolve(home, ".nodenv/shims"),
      resolve(home, ".asdf/shims"),
      resolve(home, ".cargo/bin")
    ].forEach(append);

    const nvmRoot = resolve(home, ".nvm/versions/node");

    if (existsSync(nvmRoot)) {
      for (const entry of readdirSync(nvmRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }

        append(resolve(nvmRoot, entry.name, "bin"));
      }
    }
  }

  return directories.join(delimiter);
}

function resolveExecutable(env, executableName) {
  const directories = String(env.PATH ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const extensions = process.platform === "win32"
    ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT")
        .split(";")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)]
    : [""];

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = resolve(directory || ".", `${executableName}${extension}`);

      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function shellEscape(value) {
  const text = String(value ?? "");

  if (!text) {
    return process.platform === "win32" ? "\"\"" : "''";
  }

  if (process.platform === "win32") {
    return `"${text.replaceAll("\"", "\"\"")}"`;
  }

  return `'${text.replaceAll("'", `'\"'\"'`)}'`;
}
