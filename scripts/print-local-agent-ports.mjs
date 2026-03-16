import { loadOctopEnv } from "./shared-env.mjs";

const env = loadOctopEnv(process.cwd());
const ports = [
  normalizePort(env.OCTOP_BRIDGE_PORT),
  resolvePortFromUrl(env.OCTOP_APP_SERVER_WS_URL)
].filter((value, index, values) => value !== null && values.indexOf(value) === index);

for (const port of ports) {
  console.log(String(port));
}

function normalizePort(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);

  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return null;
  }

  return parsed;
}

function resolvePortFromUrl(value) {
  try {
    const url = new URL(String(value ?? "").trim());

    if (url.port) {
      return normalizePort(url.port);
    }

    if (url.protocol === "ws:") {
      return 80;
    }

    if (url.protocol === "wss:") {
      return 443;
    }

    return null;
  } catch {
    return null;
  }
}
