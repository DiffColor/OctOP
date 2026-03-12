import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import dns from "node:dns";
import os from "node:os";
import { connect, StringCodec } from "nats";
import {
  bridgeSubjects,
  sanitizeBridgeId,
  sanitizeUserId
} from "../../../packages/domain/src/index.js";

const HOST = process.env.OCTOP_BRIDGE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.OCTOP_BRIDGE_PORT ?? 4100);
const TOKEN = process.env.OCTOP_BRIDGE_TOKEN ?? "octop-local-bridge";
const NATS_URL = process.env.OCTOP_NATS_URL ?? "nats://127.0.0.1:4222";
const BRIDGE_MODE = process.env.OCTOP_BRIDGE_MODE ?? "app-server";
const APP_SERVER_MODE = process.env.OCTOP_APP_SERVER_MODE ?? "ws-local";
const APP_SERVER_WS_URL = process.env.OCTOP_APP_SERVER_WS_URL ?? "ws://127.0.0.1:4600";
const APP_SERVER_COMMAND =
  process.env.OCTOP_APP_SERVER_COMMAND ?? `codex app-server --listen ${APP_SERVER_WS_URL}`;
const APP_SERVER_AUTOSTART = (process.env.OCTOP_APP_SERVER_AUTOSTART ?? "true") !== "false";
const APP_SERVER_STARTUP_TIMEOUT_MS = Number(
  process.env.OCTOP_APP_SERVER_STARTUP_TIMEOUT_MS ?? 15000
);
const THREAD_LIST_LIMIT = Number(process.env.OCTOP_APP_SERVER_THREAD_LIST_LIMIT ?? 50);
const BRIDGE_ID = sanitizeBridgeId(process.env.OCTOP_BRIDGE_ID ?? os.hostname());
const DEVICE_NAME = process.env.OCTOP_BRIDGE_DEVICE_NAME ?? os.hostname();
const BRIDGE_OWNER_USER_ID = sanitizeUserId(process.env.OCTOP_BRIDGE_OWNER_USER_ID ?? "local-user");

dns.setDefaultResultOrder("ipv4first");

const sc = StringCodec();
const nc = await connect({ servers: NATS_URL });

const users = new Map();
const threadOwners = new Map();
const threadStateById = new Map();
const threadEventsById = new Map();

function now() {
  return new Date().toISOString();
}

function unixSecondsToIso(value) {
  if (!value) {
    return now();
  }

  return new Date(Number(value) * 1000).toISOString();
}

function parseJson(data) {
  return JSON.parse(sc.decode(data));
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function ensureUserState(userId) {
  const normalized = sanitizeUserId(userId);

  if (!users.has(normalized)) {
    const project = {
      id: `${BRIDGE_ID}-${normalized}-project-1`,
      key: normalized.toUpperCase().replace(/-/g, "_"),
      name: `${normalized} project`,
      description: "OctOP bridge와 app-server 연결 점검용 기본 프로젝트",
      bridge_id: BRIDGE_ID,
      created_at: now()
    };

    users.set(normalized, {
      projects: [project],
      threadIds: new Set(),
      updated_at: now()
    });
  }

  return users.get(normalized);
}

function listProjectState(userId) {
  return ensureUserState(userId).projects;
}

function normalizeThreadStatus(rawStatus, currentStatus = "queued") {
  if (!rawStatus || typeof rawStatus !== "object") {
    return currentStatus;
  }

  switch (rawStatus.type) {
    case "active":
      return "running";
    case "idle":
      return currentStatus === "completed" ? "completed" : "idle";
    case "waitingForInput":
      return "awaiting_input";
    case "error":
      return "failed";
    default:
      return rawStatus.type ?? currentStatus;
  }
}

function normalizeThreadRecord(thread, fallback = {}) {
  const current = threadStateById.get(thread.id) ?? {};
  const lastEvent = threadEventsById.get(thread.id);

  return {
    id: thread.id,
    bridge_id: fallback.bridge_id ?? current.bridge_id ?? BRIDGE_ID,
    project_id: fallback.project_id ?? current.project_id ?? fallback.projectId ?? null,
    title:
      fallback.title ??
      current.title ??
      thread.name ??
      thread.preview ??
      "OctOP app-server command",
    status: normalizeThreadStatus(thread.status, fallback.status ?? current.status ?? "queued"),
    progress: fallback.progress ?? current.progress ?? 0,
    last_event: fallback.last_event ?? current.last_event ?? lastEvent?.type ?? "thread.synced",
    last_message: fallback.last_message ?? current.last_message ?? "",
    created_at: fallback.created_at ?? current.created_at ?? unixSecondsToIso(thread.createdAt),
    updated_at: fallback.updated_at ?? current.updated_at ?? unixSecondsToIso(thread.updatedAt),
    source: thread.source ?? current.source ?? "appServer"
  };
}

function upsertThreadState(threadId, patch) {
  const current = threadStateById.get(threadId) ?? {
    id: threadId,
    progress: 0,
    status: "queued",
    last_event: "thread.created",
    last_message: "",
    created_at: now(),
    updated_at: now(),
    source: "appServer"
  };
  const next = {
    ...current,
    ...patch,
    id: threadId,
    updated_at: patch.updated_at ?? now()
  };

  threadStateById.set(threadId, next);
  return next;
}

async function publishEvent(userId, type, payload) {
  const subjects = bridgeSubjects(userId, BRIDGE_ID);
  const event = {
    user_id: userId,
    bridge_id: BRIDGE_ID,
    device_name: DEVICE_NAME,
    type,
    payload,
    timestamp: now()
  };
  ensureUserState(userId).updated_at = event.timestamp;
  nc.publish(subjects.events, sc.encode(JSON.stringify(event)));
  const threadId =
    payload?.thread?.id ?? payload?.threadId ?? payload?.thread_id ?? payload?.conversationId;

  if (threadId) {
    threadEventsById.set(threadId, event);
  }
}

async function publishSnapshots(userId) {
  const state = ensureUserState(userId);
  state.updated_at = now();

  await publishEvent(userId, "bridge.status.updated", await bridgeStatus(userId));
  await publishEvent(userId, "bridge.projects.updated", { projects: state.projects });
  await publishEvent(userId, "bridge.threads.updated", { threads: listLocalThreads(userId) });
}

function resolveOwnerFromParams(params = {}) {
  const threadId = params.threadId ?? params.thread?.id ?? params.conversationId ?? params.thread_id;

  if (!threadId) {
    return null;
  }

  return threadOwners.get(threadId) ?? null;
}

function formatAccount(accountInfo) {
  if (!accountInfo?.account) {
    return null;
  }

  return {
    type: accountInfo.account.type ?? null,
    email: accountInfo.account.email ?? null,
    plan_type: accountInfo.account.planType ?? null,
    requires_openai_auth: Boolean(accountInfo.requiresOpenaiAuth)
  };
}

class AppServerClient {
  constructor() {
    this.child = null;
    this.socket = null;
    this.requests = new Map();
    this.connected = false;
    this.initialized = false;
    this.lastError = null;
    this.lastStartedAt = null;
    this.account = null;
    this.readyPromise = null;
  }

  async ensureReady() {
    if (this.connected && this.initialized && this.socket?.readyState === WebSocket.OPEN) {
      return this;
    }

    if (this.readyPromise) {
      return this.readyPromise;
    }

    this.readyPromise = this.start().finally(() => {
      this.readyPromise = null;
    });

    return this.readyPromise;
  }

  async start() {
    await this.startProcess();
    await this.connectSocket();
    await this.requestInternal("initialize", {
      clientInfo: {
        name: "octop-bridge",
        version: "0.1.0"
      },
      capabilities: {}
    });
    this.notify("initialized", {});
    const accountInfo = await this.requestInternal("account/read", { refreshToken: false });
    this.account = formatAccount(accountInfo.result ?? accountInfo);
    this.initialized = true;
    this.lastError = null;
    this.lastStartedAt = now();
    return this;
  }

  async startProcess() {
    if (!APP_SERVER_AUTOSTART) {
      return;
    }

    if (this.child && this.child.exitCode === null) {
      return;
    }

    this.child = spawn(APP_SERVER_COMMAND, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    this.child.stdout.on("data", (chunk) => {
      process.stdout.write(`[app-server] ${chunk.toString()}`);
    });
    this.child.stderr.on("data", (chunk) => {
      process.stderr.write(`[app-server] ${chunk.toString()}`);
    });
    this.child.on("exit", (code, signal) => {
      this.connected = false;
      this.initialized = false;
      this.socket = null;
      this.lastError = code === 0 ? null : `app-server exited (${code ?? signal ?? "unknown"})`;
    });
    this.child.on("error", (error) => {
      this.lastError = error.message;
    });
  }

  async connectSocket() {
    const startedAt = Date.now();

    while (Date.now() - startedAt < APP_SERVER_STARTUP_TIMEOUT_MS) {
      try {
        await this.openWebSocket();
        return;
      } catch (error) {
        this.lastError = error.message;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    throw new Error(`app-server 연결에 실패했습니다: ${this.lastError ?? "timeout"}`);
  }

  async openWebSocket() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(APP_SERVER_WS_URL);
      let settled = false;

      const cleanup = () => {
        ws.removeEventListener("open", handleOpen);
        ws.removeEventListener("error", handleError);
      };
      const handleOpen = () => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        this.socket = ws;
        this.connected = true;
        ws.addEventListener("message", (event) => this.handleMessage(event));
        ws.addEventListener("close", () => {
          this.connected = false;
          this.initialized = false;
          this.socket = null;
          for (const [id, pending] of this.requests) {
            pending.reject(new Error("app-server socket closed"));
            this.requests.delete(id);
          }
        });
        ws.addEventListener("error", () => {
          this.connected = false;
        });
        resolve();
      };
      const handleError = () => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        reject(new Error("WebSocket open failed"));
      };

      ws.addEventListener("open", handleOpen, { once: true });
      ws.addEventListener("error", handleError, { once: true });
    });
  }

  handleMessage(event) {
    const data = JSON.parse(String(event.data));

    if (data.id) {
      const pending = this.requests.get(String(data.id));

      if (!pending) {
        return;
      }

      this.requests.delete(String(data.id));

      if (data.error) {
        pending.reject(new Error(data.error.message ?? "app-server request failed"));
        return;
      }

      pending.resolve(data);
      return;
    }

    if (!data.method) {
      return;
    }

    void this.handleNotification(data.method, data.params ?? {});
  }

  async handleNotification(method, params) {
    const owner = resolveOwnerFromParams(params);
    const threadId = params.thread?.id ?? params.threadId ?? params.conversationId ?? null;

    if (threadId) {
      const eventPatch = buildThreadPatch(method, params);

      if (eventPatch) {
        upsertThreadState(threadId, eventPatch);
      }
    }

    if (!owner) {
      return;
    }

    await publishEvent(owner, method.replaceAll("/", "."), params);

    if (
      method === "thread/started" ||
      method === "thread/status/changed" ||
      method === "turn/started" ||
      method === "turn/completed" ||
      method === "item/agentMessage/delta"
    ) {
      await publishEvent(owner, "bridge.threads.updated", { threads: listLocalThreads(owner) });
    }
  }

  notify(method, params) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method,
        params
      })
    );
  }

  requestInternal(method, params) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("app-server socket is not connected");
    }

    const id = randomUUID();
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
      setTimeout(() => {
        if (!this.requests.has(id)) {
          return;
        }

        this.requests.delete(id);
        reject(new Error(`app-server request timeout: ${method}`));
      }, 20000);
    });
  }

  async request(method, params) {
    await this.ensureReady();
    return this.requestInternal(method, params);
  }
}

function buildThreadPatch(method, params) {
  switch (method) {
    case "thread/started":
      return normalizeThreadRecord(params.thread, {
        progress: 5,
        status: "queued",
        last_event: "thread.started"
      });
    case "thread/status/changed":
      return {
        status: normalizeThreadStatus(params.status),
        last_event: "thread.status.changed"
      };
    case "turn/started":
      return {
        status: "running",
        progress: 20,
        last_event: "turn.started"
      };
    case "turn/plan/updated":
      return {
        status: "running",
        progress: 45,
        last_event: "turn.plan.updated"
      };
    case "turn/diff/updated":
      return {
        status: "running",
        progress: 75,
        last_event: "turn.diff.updated"
      };
    case "item/agentMessage/delta":
      return {
        status: "running",
        progress: 90,
        last_event: "item.agentMessage.delta",
        last_message: `${threadStateById.get(params.threadId)?.last_message ?? ""}${params.delta ?? ""}`
      };
    case "turn/completed":
      return {
        status: params.turn?.status === "completed" ? "completed" : "failed",
        progress: params.turn?.status === "completed" ? 100 : 0,
        last_event: "turn.completed"
      };
    default:
      return null;
  }
}

const appServer = new AppServerClient();

async function bridgeStatus(userId) {
  const state = ensureUserState(userId);

  try {
    await appServer.ensureReady();
  } catch (error) {
    appServer.lastError = error.message;
  }

  const threads = await listThreads(userId);

  return {
    bridge_mode: BRIDGE_MODE,
    bridge_id: BRIDGE_ID,
    device_name: DEVICE_NAME,
    app_server: {
      mode: APP_SERVER_MODE,
      connected: appServer.connected,
      initialized: appServer.initialized,
      account: appServer.account,
      last_started_at: appServer.lastStartedAt,
      last_error: appServer.lastError
    },
    nats: {
      connected: !nc.isClosed()
    },
    counts: {
      projects: state.projects.length,
      threads: threads.length
    },
    updated_at: state.updated_at
  };
}

async function syncThreadListFromAppServer() {
  const response = await appServer.request("thread/list", { limit: THREAD_LIST_LIMIT });
  return response.result?.data ?? [];
}

function listLocalThreads(userId) {
  const state = ensureUserState(userId);
  const knownIds = [...state.threadIds];

  return knownIds
    .map((threadId) => threadStateById.get(threadId) ?? null)
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
}

async function listThreads(userId) {
  const state = ensureUserState(userId);
  const knownIds = [...state.threadIds];

  if (knownIds.length === 0) {
    return [];
  }

  let remoteThreads = [];

  try {
    remoteThreads = await syncThreadListFromAppServer();
  } catch (error) {
    appServer.lastError = error.message;
  }

  const remoteById = new Map(remoteThreads.map((thread) => [thread.id, thread]));

  return knownIds
    .map((threadId) => {
      const remoteThread = remoteById.get(threadId);
      const localThread = threadStateById.get(threadId);

      if (remoteThread) {
        const merged = normalizeThreadRecord(remoteThread, localThread ?? {});
        threadStateById.set(threadId, merged);
        return merged;
      }

      return localThread ?? null;
    })
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
}

async function startTurnInBackground(userId, threadId, payload = {}) {
  try {
    const turnResponse = await appServer.request("turn/start", {
      threadId,
      cwd: process.cwd(),
      approvalPolicy: "never",
      input: [
        {
          type: "text",
          text:
            payload.prompt ??
            '연결 상태 점검입니다. "pong" 또는 현재 상태를 짧게 답해 주세요.'
        }
      ]
    });

    const turn = turnResponse.result?.turn ?? null;
    const current = threadStateById.get(threadId);

    if (!turn?.id) {
      return;
    }

    upsertThreadState(threadId, {
      ...current,
      status: "running",
      progress: Math.max(current?.progress ?? 0, 20),
      last_event: "turn.started",
      turn_id: turn.id
    });

    await publishEvent(userId, "turn.started", {
      threadId,
      turn
    });
    await publishEvent(userId, "bridge.threads.updated", { threads: listLocalThreads(userId) });
  } catch (error) {
    const current = threadStateById.get(threadId);

    upsertThreadState(threadId, {
      ...current,
      status: "failed",
      last_event: "turn.start.failed",
      last_message: error.message
    });

    await publishEvent(userId, "turn.start.failed", {
      threadId,
      error: error.message
    });
    await publishEvent(userId, "bridge.threads.updated", { threads: listLocalThreads(userId) });
  }
}

async function startPingThread(userId, payload = {}) {
  const state = ensureUserState(userId);
  await appServer.ensureReady();

  const threadResponse = await appServer.request("thread/start", {
    cwd: process.cwd(),
    approvalPolicy: "never",
    sandbox: "workspace-write",
    model: "gpt-5-codex",
    personality: "pragmatic"
  });
  const thread = threadResponse.result?.thread;

  if (!thread?.id) {
    throw new Error("app-server thread/start 응답에 thread id가 없습니다.");
  }

  state.threadIds.add(thread.id);
  threadOwners.set(thread.id, userId);
  upsertThreadState(
    thread.id,
    normalizeThreadRecord(thread, {
      title: payload.title ?? payload.prompt ?? "OctOP bridge ping",
      project_id: payload.project_id ?? state.projects[0]?.id ?? null,
      progress: 5,
      status: "queued",
      last_event: "thread.started"
    })
  );

  await publishEvent(userId, "thread.started", {
    thread: threadStateById.get(thread.id)
  });
  await publishEvent(userId, "bridge.threads.updated", { threads: listLocalThreads(userId) });

  void startTurnInBackground(userId, thread.id, payload);

  return {
    accepted: true,
    thread: threadStateById.get(thread.id),
    turn: null
  };
}

async function respond(message, payload) {
  if (!message.reply) {
    return;
  }

  nc.publish(message.reply, sc.encode(JSON.stringify(payload)));
}

async function subscribeRequests() {
  const patterns = [
    { subject: "octop.user.*.bridge.*.status.get", handler: (userId) => bridgeStatus(userId) },
    {
      subject: "octop.user.*.bridge.*.projects.get",
      handler: (userId) => ({ projects: listProjectState(userId) })
    },
    {
      subject: "octop.user.*.bridge.*.threads.get",
      handler: async (userId) => ({ threads: await listThreads(userId) })
    }
  ];

  for (const entry of patterns) {
    const subscription = nc.subscribe(entry.subject);

    (async () => {
      for await (const message of subscription) {
        const userId = sanitizeUserId(message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }
        try {
          await respond(message, await entry.handler(userId));
        } catch (error) {
          await respond(message, { error: error.message });
        }
      }
    })();
  }

  const pingSubscription = nc.subscribe("octop.user.*.bridge.*.command.ping");

  (async () => {
    for await (const message of pingSubscription) {
      try {
      const body = parseJson(message.data);
      const userId = sanitizeUserId(body.user_id ?? message.subject.split(".")[2]);
      const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

      if (bridgeId !== BRIDGE_ID) {
        continue;
      }

      const result = await startPingThread(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();
}

await subscribeRequests();

setInterval(() => {
  void publishSnapshots(BRIDGE_OWNER_USER_ID);
}, 30000).unref();

await publishSnapshots(BRIDGE_OWNER_USER_ID);

createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
  const token = request.headers["x-bridge-token"];
  const userId = sanitizeUserId(url.searchParams.get("user_id") ?? "local-user");

  if (token !== TOKEN) {
    return sendJson(response, 401, { error: "Unauthorized bridge access" });
  }

  if (request.method === "GET" && url.pathname === "/health") {
    return sendJson(response, 200, {
      ok: true,
      status: await bridgeStatus(userId)
    });
  }

  if (request.method === "GET" && url.pathname === "/api/projects") {
    return sendJson(response, 200, { projects: listProjectState(userId) });
  }

  if (request.method === "GET" && url.pathname === "/api/threads") {
    return sendJson(response, 200, { threads: await listThreads(userId) });
  }

  if (request.method === "POST" && url.pathname === "/api/commands/ping") {
    try {
      const body = await readJsonBody(request);
      const payload = await startPingThread(userId, body);
      return sendJson(response, 202, payload);
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }

  return sendJson(response, 404, { error: "Not found" });
}).listen(PORT, HOST, () => {
  console.log(`OctOP bridge listening on http://${HOST}:${PORT}`);
});
