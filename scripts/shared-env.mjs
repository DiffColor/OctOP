import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

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
    ...process.env,
    ...fileEnv
  };

  env.OCTOP_NATS_URL = withDefault(env.OCTOP_NATS_URL, "nats://ilysrv.ddns.net:4222");
  env.OCTOP_BRIDGE_HOST = withDefault(env.OCTOP_BRIDGE_HOST, "0.0.0.0");
  env.OCTOP_BRIDGE_PORT = withDefault(env.OCTOP_BRIDGE_PORT, "4100");
  env.OCTOP_BRIDGE_MODE = withDefault(env.OCTOP_BRIDGE_MODE, "app-server");
  env.OCTOP_BRIDGE_TOKEN = withDefault(env.OCTOP_BRIDGE_TOKEN, "octop-local-bridge");
  env.OCTOP_APP_SERVER_MODE = withDefault(env.OCTOP_APP_SERVER_MODE, "ws-local");
  env.OCTOP_APP_SERVER_WS_URL = withDefault(env.OCTOP_APP_SERVER_WS_URL, "ws://127.0.0.1:4600");
  env.OCTOP_APP_SERVER_COMMAND = withDefault(
    env.OCTOP_APP_SERVER_COMMAND,
    `codex app-server --listen ${env.OCTOP_APP_SERVER_WS_URL}`
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

  return env;
}

export async function resolveBridgeRuntimeEnv(env, options = {}) {
  const { prompt = false } = options;

  if (!input.isTTY || !output.isTTY) {
    return applyBridgeIdentityDefaults(env);
  }

  const currentEnv = applyBridgeIdentityDefaults(env);
  const shouldPrompt =
    prompt ||
    !currentEnv.OCTOP_BRIDGE_ID ||
    !currentEnv.OCTOP_BRIDGE_DEVICE_NAME ||
    !currentEnv.OCTOP_BRIDGE_OWNER_USER_ID;

  if (!shouldPrompt) {
    return currentEnv;
  }

  const readline = createInterface({ input, output });

  try {
    const bridgeId = await askQuestion(
      readline,
      "Bridge ID",
      currentEnv.OCTOP_BRIDGE_ID
    );
    const deviceName = await askQuestion(
      readline,
      "Bridge 표시 이름",
      currentEnv.OCTOP_BRIDGE_DEVICE_NAME
    );
    const ownerUserId = await askQuestion(
      readline,
      "LicenseHub userId",
      currentEnv.OCTOP_BRIDGE_OWNER_USER_ID
    );

    return {
      ...currentEnv,
      OCTOP_BRIDGE_ID: bridgeId,
      OCTOP_BRIDGE_DEVICE_NAME: deviceName,
      OCTOP_BRIDGE_OWNER_USER_ID: ownerUserId
    };
  } finally {
    readline.close();
  }
}

function applyBridgeIdentityDefaults(env) {
  const hostname = os.hostname();

  return {
    ...env,
    OCTOP_BRIDGE_ID: env.OCTOP_BRIDGE_ID?.trim() || hostname,
    OCTOP_BRIDGE_DEVICE_NAME: env.OCTOP_BRIDGE_DEVICE_NAME?.trim() || hostname,
    OCTOP_BRIDGE_OWNER_USER_ID: env.OCTOP_BRIDGE_OWNER_USER_ID?.trim() || "local-user"
  };
}

async function askQuestion(readline, label, fallbackValue) {
  while (true) {
    const suffix = fallbackValue ? ` [${fallbackValue}]` : "";
    const answer = (await readline.question(`${label}${suffix}: `)).trim();
    const resolved = answer || fallbackValue || "";

    if (resolved) {
      return resolved;
    }
  }
}
