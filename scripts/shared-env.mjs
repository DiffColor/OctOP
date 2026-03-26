import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import { delimiter, resolve } from "node:path";

const DUMMY_FINGERPRINT_VALUES = new Set([
  "",
  "0",
  "00",
  "000",
  "0000",
  "00000000",
  "unknown",
  "none",
  "default",
  "n/a",
  "android",
  "alps",
  "generic",
  "goldfish",
  "default string"
]);
const DANGEROUSLY_BYPASS_APPROVALS_AND_SANDBOX = "dangerously-bypass-approvals-and-sandbox";

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
  env.OCTOP_CODEX_MODEL = withDefault(env.OCTOP_CODEX_MODEL, "gpt-5.4");
  env.OCTOP_CODEX_REASONING_EFFORT = withDefault(env.OCTOP_CODEX_REASONING_EFFORT, "none");
  env.OCTOP_CODEX_APPROVAL_POLICY = withDefault(env.OCTOP_CODEX_APPROVAL_POLICY, "on-request");
  env.OCTOP_CODEX_SANDBOX = withDefault(env.OCTOP_CODEX_SANDBOX, "danger-full-access");
  const codexExecutable = resolveExecutable(env, "codex");
  env.OCTOP_APP_SERVER_COMMAND = withDefault(
    env.OCTOP_APP_SERVER_COMMAND,
    buildAppServerCommand({
      codexExecutable,
      appServerWsUrl: env.OCTOP_APP_SERVER_WS_URL,
      sandboxMode: env.OCTOP_CODEX_SANDBOX
    })
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

function buildAppServerCommand({ codexExecutable, appServerWsUrl, sandboxMode }) {
  const tokens = [formatCommandToken(codexExecutable)];

  if (String(sandboxMode ?? "").trim() === DANGEROUSLY_BYPASS_APPROVALS_AND_SANDBOX) {
    tokens.push("--dangerously-bypass-approvals-and-sandbox");
  }

  tokens.push("app-server", "--listen", shellEscape(appServerWsUrl));
  return tokens.join(" ");
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
  const derived = deriveStableBridgeId(env);

  if (derived) {
    persistBridgeId(configDir, bridgeIdPath, derived);
    return derived;
  }

  const existing = readStoredBridgeId(bridgeIdPath);

  if (existing) {
    return existing;
  }

  const fallback = `bridge-${createHash("sha256")
    .update(`${os.hostname()}|${os.platform()}|${os.release()}`)
    .digest("hex")}`;
  persistBridgeId(configDir, bridgeIdPath, fallback);
  return fallback;
}

function resolveOctopStateDir(env = process.env) {
  const configured = String(env.OCTOP_STATE_HOME ?? "").trim();
  return configured ? resolve(configured) : resolve(os.homedir(), ".octop");
}

function persistBridgeId(configDir, bridgeIdPath, bridgeId) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(bridgeIdPath, `${bridgeId}\n`, "utf8");
}

function readStoredBridgeId(bridgeIdPath) {
  if (!existsSync(bridgeIdPath)) {
    return "";
  }

  return readFileSync(bridgeIdPath, "utf8").trim();
}

function deriveStableBridgeId(env = process.env) {
  const normalized = collectFingerprintSources(env)
    .map(normalizeFingerprintValue)
    .filter(Boolean);
  const distinct = [...new Set(normalized)].sort();

  if (distinct.length === 0) {
    return "";
  }

  const fingerprint = createHash("sha256")
    .update(distinct.join("|"))
    .digest("hex");

  return `bridge-${fingerprint}`;
}

function collectFingerprintSources(env = process.env) {
  if (process.platform === "win32") {
    return collectWindowsFingerprintSources(env);
  }

  if (process.platform === "darwin") {
    return collectMacFingerprintSources(env);
  }

  return collectLinuxFingerprintSources();
}

function collectWindowsFingerprintSources(env = process.env) {
  return [
    readWindowsRegistryMachineGuid(env),
    readWindowsHardwareValue("Win32_Processor", "ProcessorId", env),
    readWindowsHardwareValue("Win32_BaseBoard", "SerialNumber", env),
    readWindowsHardwareValue("Win32_BIOS", "SerialNumber", env),
    readWindowsHardwareValue("Win32_DiskDrive", "SerialNumber", env),
    readWindowsHardwareValue("Win32_ComputerSystemProduct", "UUID", env)
  ];
}

function readWindowsRegistryMachineGuid(env = process.env) {
  return readCommandOutput(
    "reg.exe",
    [
      "query",
      "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
      "/v",
      "MachineGuid"
    ],
    env,
    (output) => output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => /^MachineGuid\s+/iu.test(line))
      ?.split(/\s+/u)
      .at(-1) ?? ""
  );
}

function readWindowsHardwareValue(className, property, env = process.env) {
  const escapedClassName = escapePowerShellLiteral(className);
  const escapedProperty = escapePowerShellLiteral(property);
  const script = [
    "$value = ''",
    `try { $value = Get-CimInstance -ClassName '${escapedClassName}' | Select-Object -First 1 -ExpandProperty '${escapedProperty}' } catch {`,
    `  try { $value = Get-WmiObject -Class '${escapedClassName}' | Select-Object -First 1 -ExpandProperty '${escapedProperty}' } catch { }`,
    "}",
    "if ($null -ne $value) { [Console]::Write($value.ToString()) }"
  ].join(" ");

  return readCommandOutput(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    env
  );
}

function escapePowerShellLiteral(value) {
  return String(value ?? "").replace(/'/g, "''");
}

function collectMacFingerprintSources(env = process.env) {
  const ioRegOutput = readCommandOutput("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], env);
  const systemProfilerOutput = readCommandOutput(
    "/usr/sbin/system_profiler",
    ["SPHardwareDataType"],
    env
  );

  return [
    extractQuotedValue(ioRegOutput, "IOPlatformUUID"),
    extractQuotedValue(ioRegOutput, "IOPlatformSerialNumber"),
    extractColonValue(systemProfilerOutput, "Hardware UUID"),
    extractColonValue(systemProfilerOutput, "Serial Number (system)")
  ];
}

function collectLinuxFingerprintSources() {
  return [
    readTextFile("/etc/machine-id"),
    readTextFile("/var/lib/dbus/machine-id"),
    readTextFile("/sys/class/dmi/id/product_uuid"),
    readTextFile("/sys/class/dmi/id/product_serial"),
    readTextFile("/sys/class/dmi/id/board_serial")
  ];
}

function readTextFile(filePath) {
  try {
    return readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

function readCommandOutput(command, args, env = process.env, transform) {
  try {
    const output = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        ...env
      }
    });
    const text = String(output ?? "").trim();
    return typeof transform === "function" ? String(transform(text) ?? "").trim() : text;
  } catch {
    return "";
  }
}

function extractQuotedValue(text, key) {
  const matcher = new RegExp(`"${escapeRegExp(key)}"\\s*=\\s*"([^"]+)"`, "iu");
  return text.match(matcher)?.[1]?.trim() ?? "";
}

function extractColonValue(text, key) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.toLowerCase().startsWith(`${key.toLowerCase()}:`))
    ?.split(/:\s*/u, 2)?.[1]?.trim() ?? "";
}

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeFingerprintValue(value) {
  if (!value) {
    return "";
  }

  const normalized = String(value).trim().toLowerCase();

  if (!normalized || DUMMY_FINGERPRINT_VALUES.has(normalized)) {
    return "";
  }

  if ([...normalized].every((character) => character === "0")) {
    return "";
  }

  return normalized;
}

function buildExecutablePath(env) {
  const directories = [];
  const seen = new Set();
  const pathEntries = String(readEnvValue(env, "PATH") ?? "")
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
  const directories = String(readEnvValue(env, "PATH") ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const extensions = process.platform === "win32"
    ? ["", ...(readEnvValue(env, "PATHEXT") ?? ".EXE;.CMD;.BAT")
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

function readEnvValue(env, key) {
  const targetKey = String(key ?? "").trim().toLowerCase();

  for (const [entryKey, entryValue] of Object.entries(env ?? {})) {
    if (String(entryKey).trim().toLowerCase() === targetKey) {
      return entryValue;
    }
  }

  return undefined;
}

function formatCommandToken(value) {
  const text = String(value ?? "").trim() || "codex";

  if (process.platform === "win32" && !/[\\/\s"]/u.test(text)) {
    return text;
  }

  return shellEscape(text);
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
