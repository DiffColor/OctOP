import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import dns from "node:dns";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { basename, dirname, resolve } from "node:path";
import { connect, StringCodec } from "nats";
import {
  bridgeSubjects,
  sanitizeBridgeId,
  sanitizeUserId
} from "../../../packages/domain/src/index.js";

const HOST = process.env.OCTOP_BRIDGE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.OCTOP_BRIDGE_PORT ?? 4100);
const TOKEN = process.env.OCTOP_BRIDGE_TOKEN ?? "octop-local-bridge";
const NATS_URL = process.env.OCTOP_NATS_URL ?? "nats://ilysrv.ddns.net:4222";
const NATS_CONNECT_TIMEOUT_MS = Number(process.env.OCTOP_NATS_CONNECT_TIMEOUT_MS ?? 5000);
const NATS_RETRY_DELAY_MS = Number(process.env.OCTOP_NATS_RETRY_DELAY_MS ?? 2000);
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
const BRIDGE_OWNER_LOGIN_ID = sanitizeUserId(
  process.env.OCTOP_BRIDGE_OWNER_LOGIN_ID ?? process.env.OCTOP_BRIDGE_OWNER_USER_ID ?? "local-user"
);
const BRIDGE_STORAGE_DIR = resolve(os.homedir(), ".octop");
const PROJECT_STATE_PATH = resolve(BRIDGE_STORAGE_DIR, `${BRIDGE_ID}-projects.json`);
const THREAD_STATE_PATH = resolve(BRIDGE_STORAGE_DIR, `${BRIDGE_ID}-threads.json`);
const WORKSPACE_ROOTS = resolveWorkspaceRoots();

dns.setDefaultResultOrder("ipv4first");

const sc = StringCodec();
const nc = await connectToNats();

const users = new Map();
const threadOwners = new Map();
const threadStateById = new Map();
const threadEventsById = new Map();
const threadMessagesById = new Map();
const pendingStartQueues = new Map();

function now() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectToNats() {
  let attempt = 0;

  while (true) {
    attempt += 1;

    try {
      console.log(`[bridge] NATS 연결 시도 ${attempt}: ${NATS_URL}`);
      const connection = await connect({
        servers: NATS_URL,
        timeout: NATS_CONNECT_TIMEOUT_MS
      });

      void connection.closed().then((error) => {
        if (error) {
          console.error(`[bridge] NATS 연결 종료: ${error.message}`);
          return;
        }

        console.warn("[bridge] NATS 연결이 종료되었습니다.");
      });

      console.log("[bridge] NATS 연결 성공");
      return connection;
    } catch (error) {
      console.error(
        `[bridge] NATS 연결 실패 (${attempt}회): ${error.message}. ${Math.round(NATS_RETRY_DELAY_MS / 1000)}초 후 재시도합니다.`
      );
      await sleep(NATS_RETRY_DELAY_MS);
    }
  }
}

function createIssueTitle(payload = {}) {
  const title = String(payload.title ?? "").trim();

  if (title) {
    return title;
  }

  const prompt = String(payload.prompt ?? "").trim();

  if (!prompt) {
    return "새 이슈";
  }

  const singleLine = prompt.replace(/\s+/g, " ").trim();
  return singleLine.slice(0, 42) + (singleLine.length > 42 ? "..." : "");
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
    const restoredThreads = loadThreadsForUser(normalized);
    users.set(normalized, {
      projects: loadProjectsForUser(normalized),
      threadIds: restoredThreads,
      updated_at: now()
    });
  }

  const state = users.get(normalized);
  const discoveredProjects = discoverProjectsForUser(normalized);
  const mergedProjects = mergeProjects(state.projects, discoveredProjects);

  if (hasProjectSetChanged(state.projects, mergedProjects)) {
    state.projects = mergedProjects;
    persistUserProjects(normalized, state.projects);
  }

  return state;
}

function readThreadStorage() {
  if (!existsSync(THREAD_STATE_PATH)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(THREAD_STATE_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeThreadStorage(payload) {
  mkdirSync(dirname(THREAD_STATE_PATH), { recursive: true });
  writeFileSync(THREAD_STATE_PATH, JSON.stringify(payload, null, 2), "utf8");
}

function loadThreadsForUser(loginId) {
  const storage = readThreadStorage();
  const stored = storage[loginId];

  if (!stored || !Array.isArray(stored.thread_ids)) {
    return new Set();
  }

  const threadIds = new Set();

  for (const threadId of stored.thread_ids) {
    if (!threadId) {
      continue;
    }

    const thread = stored.threads?.[threadId];

    if (thread) {
      threadStateById.set(threadId, thread);
      threadOwners.set(threadId, loginId);
      threadIds.add(threadId);
    }

    const messages = stored.messages?.[threadId];

    if (Array.isArray(messages) && messages.length > 0) {
      threadMessagesById.set(threadId, messages);
    }
  }

  const restoredQueueIds = Array.isArray(stored.queue_ids)
    ? stored.queue_ids.filter((threadId) => threadIds.has(threadId))
    : [...threadIds]
        .map((threadId) => threadStateById.get(threadId))
        .filter((thread) => thread?.status === "queued")
        .sort((left, right) => {
          const leftOrder = left.queue_position ?? Number.MAX_SAFE_INTEGER;
          const rightOrder = right.queue_position ?? Number.MAX_SAFE_INTEGER;

          if (leftOrder !== rightOrder) {
            return leftOrder - rightOrder;
          }

          return Date.parse(left.updated_at) - Date.parse(right.updated_at);
        })
        .map((thread) => thread.id);

  if (restoredQueueIds.length > 0) {
    pendingStartQueues.set(loginId, [...restoredQueueIds]);
  }

  return threadIds;
}

function persistThreadsForUser(loginId) {
  const normalized = sanitizeUserId(loginId);
  const state = users.get(normalized);

  if (!state) {
    return;
  }

  const storage = readThreadStorage();
  const threadIds = [...state.threadIds].filter((threadId) => threadStateById.has(threadId));

  storage[normalized] = {
    thread_ids: threadIds,
    queue_ids: ensurePendingQueue(normalized).filter((threadId) => threadIds.includes(threadId)),
    threads: Object.fromEntries(
      threadIds.map((threadId) => [threadId, threadStateById.get(threadId)])
    ),
    messages: Object.fromEntries(
      threadIds
        .filter((threadId) => threadMessagesById.has(threadId))
        .map((threadId) => [threadId, threadMessagesById.get(threadId)])
    ),
    updated_at: now()
  };

  writeThreadStorage(storage);
}

function persistThreadById(threadId) {
  const owner = threadOwners.get(threadId);

  if (!owner) {
    return;
  }

  persistThreadsForUser(owner);
}

function loadProjectsForUser(loginId) {
  const persisted = readProjectStorage();
  const stored = persisted[loginId];
  const discoveredProjects = discoverProjectsForUser(loginId);

  if (Array.isArray(stored) && stored.length > 0) {
    return mergeProjects(
      stored.map((project) => normalizeProject(loginId, project)),
      discoveredProjects
    );
  }

  const project = discoveredProjects[0] ?? buildDefaultProject(loginId);
  persisted[loginId] = mergeProjects([project], discoveredProjects);
  writeProjectStorage(persisted);
  return persisted[loginId];
}

function buildDefaultProject(loginId) {
  return normalizeProject(loginId, {
    id: buildProjectId(loginId, process.cwd()),
    key: loginId.toUpperCase().replace(/-/g, "_"),
    name: `${loginId} project`,
    description: "OctOP bridge와 app-server 연결 점검용 기본 프로젝트",
    workspace_path: process.cwd(),
    source: "default"
  });
}

function normalizeProject(loginId, project = {}) {
  const sanitizedLoginId = sanitizeUserId(loginId);
  const resolvedWorkspacePath = project.workspace_path
    ? resolve(String(project.workspace_path))
    : "";
  const fallbackId = resolvedWorkspacePath
    ? buildProjectId(sanitizedLoginId, resolvedWorkspacePath)
    : `${BRIDGE_ID}-${sanitizedLoginId}-${randomUUID().slice(0, 8)}`;
  const fallbackName = `${sanitizedLoginId} project`;

  return {
    id: sanitizeBridgeId(project.id ?? fallbackId),
    key: String(project.key ?? fallbackName).trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_"),
    name: String(project.name ?? fallbackName).trim() || fallbackName,
    description: String(project.description ?? "").trim(),
    bridge_id: BRIDGE_ID,
    workspace_path: resolvedWorkspacePath || null,
    source: project.source ?? (resolvedWorkspacePath ? "workspace" : "manual"),
    created_at: project.created_at ?? now(),
    updated_at: project.updated_at ?? now()
  };
}

function resolveWorkspaceRoots() {
  const configured = String(process.env.OCTOP_WORKSPACE_ROOTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => resolve(value));

  const roots = configured.length > 0 ? configured : [process.cwd()];
  return [...new Set(roots)];
}

function listWorkspaceRoots(userId) {
  const state = ensureUserState(userId);

  return WORKSPACE_ROOTS.map((rootPath) => {
    const registeredProject = state.projects.find((project) => project.workspace_path === rootPath);

    return {
      name: basename(rootPath) || rootPath,
      path: rootPath,
      is_workspace: canUseAsWorkspace(rootPath),
      is_registered: Boolean(registeredProject),
      project_id: registeredProject?.id ?? null
    };
  });
}

function isAllowedWorkspacePath(targetPath) {
  return WORKSPACE_ROOTS.some((rootPath) => {
    const normalizedRoot = `${rootPath}${rootPath.endsWith("/") ? "" : "/"}`;
    const normalizedTarget = `${targetPath}${targetPath.endsWith("/") ? "" : "/"}`;

    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot);
  });
}

function resolveBrowsePath(rawPath = "") {
  const targetPath = rawPath ? resolve(String(rawPath)) : WORKSPACE_ROOTS[0];

  if (!isAllowedWorkspacePath(targetPath)) {
    throw new Error("허용되지 않은 경로입니다.");
  }

  if (!existsSync(targetPath)) {
    throw new Error("경로를 찾을 수 없습니다.");
  }

  return targetPath;
}

function listFoldersForUser(userId, rawPath = "") {
  const state = ensureUserState(userId);
  const path = resolveBrowsePath(rawPath);
  const entries = safeListDirectories(path).map((entryPath) => {
    const registeredProject = state.projects.find((project) => project.workspace_path === entryPath);

    return {
      name: basename(entryPath) || entryPath,
      path: entryPath,
      is_workspace: canUseAsWorkspace(entryPath),
      is_registered: Boolean(registeredProject),
      project_id: registeredProject?.id ?? null
    };
  });
  const parentPath = WORKSPACE_ROOTS.find((rootPath) => rootPath === path)
    ? null
    : dirname(path);

  return {
    path,
    parent_path: parentPath && isAllowedWorkspacePath(parentPath) ? parentPath : null,
    entries
  };
}

function buildProjectId(loginId, workspacePath) {
  const digest = createHash("sha1")
    .update(`${sanitizeUserId(loginId)}:${workspacePath}`)
    .digest("hex")
    .slice(0, 10);

  return sanitizeBridgeId(`${BRIDGE_ID}-${digest}`);
}

function canUseAsWorkspace(path) {
  return (
    existsSync(resolve(path, ".git")) ||
    existsSync(resolve(path, "package.json")) ||
    existsSync(resolve(path, "pnpm-workspace.yaml")) ||
    hasSolutionFile(path) ||
    existsSync(resolve(path, "AGENTS.md"))
  );
}

function safeListDirectories(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => resolve(path, entry.name));
  } catch {
    return [];
  }
}

function hasSolutionFile(path) {
  try {
    return readdirSync(path).some((entry) => entry.endsWith(".sln"));
  } catch {
    return false;
  }
}

function discoverProjectsForUser(loginId) {
  const discovered = [];

  for (const root of WORKSPACE_ROOTS) {
    const candidates = [root, ...safeListDirectories(root)];

    for (const candidate of candidates) {
      if (!canUseAsWorkspace(candidate)) {
        continue;
      }

      const name = basename(candidate) || `${sanitizeUserId(loginId)} project`;
      discovered.push(
        normalizeProject(loginId, {
          id: buildProjectId(loginId, candidate),
          key: name,
          name,
          description: `${candidate} 워크스페이스`,
          workspace_path: candidate,
          source: "workspace"
        })
      );
    }
  }

  return dedupeProjects(discovered);
}

function dedupeProjects(projects) {
  const seen = new Set();
  const result = [];

  for (const project of projects) {
    const key = project.workspace_path
      ? `path:${project.workspace_path}`
      : `id:${project.id}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(project);
  }

  return result;
}

function mergeProjects(currentProjects, discoveredProjects) {
  const mergedById = new Map();
  const discoveredByPath = new Map(
    discoveredProjects
      .filter((project) => project.workspace_path)
      .map((project) => [project.workspace_path, project])
  );

  for (const project of currentProjects) {
    const normalized = normalizeProject(project.owner_login_id ?? BRIDGE_OWNER_LOGIN_ID, project);
    const discovered = normalized.workspace_path
      ? discoveredByPath.get(normalized.workspace_path)
      : null;

    mergedById.set(normalized.id, {
      ...normalized,
      ...(discovered
        ? {
            key: normalized.key || discovered.key,
            name: normalized.name || discovered.name,
            description: normalized.description || discovered.description,
            source: discovered.source,
            updated_at: discovered.updated_at
          }
        : {})
    });
  }

  for (const project of discoveredProjects) {
    if (![...mergedById.values()].some((current) => current.workspace_path === project.workspace_path)) {
      mergedById.set(project.id, project);
    }
  }

  return [...mergedById.values()].sort((left, right) => left.name.localeCompare(right.name, "ko-KR"));
}

function hasProjectSetChanged(left, right) {
  return JSON.stringify(left) !== JSON.stringify(right);
}

function readProjectStorage() {
  if (!existsSync(PROJECT_STATE_PATH)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(PROJECT_STATE_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeProjectStorage(payload) {
  mkdirSync(dirname(PROJECT_STATE_PATH), { recursive: true });
  writeFileSync(PROJECT_STATE_PATH, JSON.stringify(payload, null, 2), "utf8");
}

function persistUserProjects(loginId, projects) {
  const storage = readProjectStorage();
  storage[loginId] = projects;
  writeProjectStorage(storage);
}

async function createProject(loginId, payload = {}) {
  const state = ensureUserState(loginId);
  const name = String(payload.name ?? "").trim();

  if (!name) {
    throw new Error("프로젝트 이름이 필요합니다.");
  }

  const workspacePath = resolveWorkspaceFromPayload(loginId, payload);

  const project = normalizeProject(loginId, {
    id:
      payload.id ??
      (workspacePath
        ? buildProjectId(loginId, workspacePath)
        : `${BRIDGE_ID}-${sanitizeUserId(loginId)}-${randomUUID().slice(0, 8)}`),
    key: payload.key ?? name,
    name,
    description: payload.description ?? "",
    workspace_path: workspacePath,
    source: "workspace"
  });

  const keyExists = state.projects.some((item) => item.key === project.key);
  const nameExists = state.projects.some((item) => item.name === project.name);
  const pathExists = state.projects.some((item) => item.workspace_path === project.workspace_path);

  if (pathExists) {
    throw new Error("선택한 workspace는 이미 프로젝트로 등록되어 있습니다.");
  }

  if (keyExists || nameExists) {
    throw new Error("같은 이름 또는 key의 프로젝트가 이미 있습니다.");
  }

  state.projects = [project, ...state.projects];
  state.updated_at = now();
  persistUserProjects(loginId, state.projects);
  await publishEvent(loginId, "bridge.projects.updated", { projects: state.projects });

  return {
    accepted: true,
    project,
    projects: state.projects
  };
}

function resolveWorkspaceFromPayload(loginId, payload = {}) {
  if (payload.workspace_path) {
    return resolve(String(payload.workspace_path));
  }

  const discoveredProjects = discoverProjectsForUser(loginId);
  const requestedName = String(payload.name ?? "").trim().toLowerCase();
  const requestedKey = String(payload.key ?? payload.name ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_");
  const matchedProject = discoveredProjects.find((project) => {
    return (
      project.name.toLowerCase() === requestedName ||
      project.key === requestedKey
    );
  });

  if (matchedProject?.workspace_path) {
    return matchedProject.workspace_path;
  }

  throw new Error(
    "로컬 workspace를 찾을 수 없습니다. bridge를 workspace 루트에서 실행하거나 OCTOP_WORKSPACE_ROOTS를 설정해 주세요."
  );
}

function listProjectState(userId) {
  return ensureUserState(userId).projects;
}

function normalizeThreadStatus(rawStatus, currentStatus = "queued") {
  if (!rawStatus || typeof rawStatus !== "object") {
    return currentStatus;
  }

  let nextStatus;

  switch (rawStatus.type) {
    case "active":
      nextStatus = "running";
      break;
    case "idle":
      nextStatus = "idle";
      break;
    case "waitingForInput":
      nextStatus = "awaiting_input";
      break;
    case "error":
      nextStatus = "failed";
      break;
    default:
      nextStatus = rawStatus.type ?? currentStatus;
      break;
  }

  if (
    ["completed", "failed"].includes(currentStatus) &&
    !["completed", "failed"].includes(nextStatus)
  ) {
    return currentStatus;
  }

  return nextStatus;
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
    prompt: fallback.prompt ?? current.prompt ?? "",
    created_at: fallback.created_at ?? current.created_at ?? unixSecondsToIso(thread.createdAt),
    updated_at: fallback.updated_at ?? current.updated_at ?? unixSecondsToIso(thread.updatedAt),
    source: thread.source ?? current.source ?? "appServer",
    queue_position: fallback.queue_position ?? current.queue_position ?? null
  };
}

function upsertThreadState(threadId, patch) {
  const current = threadStateById.get(threadId) ?? {
    id: threadId,
    progress: 0,
    status: "queued",
    last_event: "thread.created",
    last_message: "",
    prompt: "",
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
  persistThreadById(threadId);
  return next;
}

async function publishEvent(loginId, type, payload) {
  const subjects = bridgeSubjects(loginId, BRIDGE_ID);
  const event = {
    user_id: loginId,
    login_id: loginId,
    bridge_id: BRIDGE_ID,
    device_name: DEVICE_NAME,
    type,
    payload,
    timestamp: now()
  };
  ensureUserState(loginId).updated_at = event.timestamp;
  nc.publish(subjects.events, sc.encode(JSON.stringify(event)));
  const threadId =
    payload?.thread?.id ?? payload?.threadId ?? payload?.thread_id ?? payload?.conversationId;

  if (threadId) {
    threadEventsById.set(threadId, event);
  }
}

function ensureThreadMessages(threadId) {
  if (!threadMessagesById.has(threadId)) {
    threadMessagesById.set(threadId, []);
  }

  return threadMessagesById.get(threadId);
}

function pushThreadMessage(threadId, message) {
  const messages = ensureThreadMessages(threadId);
  messages.push({
    id: randomUUID(),
    timestamp: now(),
    ...message
  });
  persistThreadById(threadId);
  return messages;
}

function appendAssistantDelta(threadId, delta = "") {
  const messages = ensureThreadMessages(threadId);
  const lastMessage = messages.at(-1);

  if (lastMessage?.role === "assistant") {
    lastMessage.content = `${lastMessage.content ?? ""}${delta}`;
    lastMessage.timestamp = now();
    persistThreadById(threadId);
    return;
  }

  messages.push({
    id: randomUUID(),
    role: "assistant",
    kind: "message",
    content: String(delta ?? ""),
    timestamp: now()
  });
  persistThreadById(threadId);
}

function listThreadMessages(threadId) {
  return [...(threadMessagesById.get(threadId) ?? [])];
}

function buildExecutionPrompt(prompt = "") {
  const normalizedPrompt = String(prompt ?? "").trim();
  const instruction = [
    "아래 프롬프트를 최우선 지시로 따르십시오.",
    "질문 없이 작업을 순차적으로 끝까지 진행하십시오.",
    "판단이 필요한 부분은 스스로 가장 합리적인 방법을 선택하십시오.",
    "중간 확인 요청보다 실제 결과를 만드는 데 집중하십시오."
  ].join(" ");

  if (!normalizedPrompt) {
    return instruction;
  }

  return `${instruction}\n\n[사용자 프롬프트]\n${normalizedPrompt}`;
}

function ensurePendingQueue(userId) {
  const normalized = sanitizeUserId(userId);

  if (!pendingStartQueues.has(normalized)) {
    pendingStartQueues.set(normalized, []);
  }

  return pendingStartQueues.get(normalized);
}

function refreshQueuePositions(userId) {
  const state = ensureUserState(userId);
  const queue = ensurePendingQueue(userId);

  for (const threadId of state.threadIds) {
    const current = threadStateById.get(threadId);

    if (!current) {
      continue;
    }

    const queueIndex = queue.indexOf(threadId);
    const nextPosition = queueIndex >= 0 ? queueIndex + 1 : null;

    if ((current.queue_position ?? null) === nextPosition) {
      continue;
    }

    upsertThreadState(threadId, {
      ...current,
      queue_position: nextPosition
    });
  }
}

async function publishSnapshots(loginId) {
  const state = ensureUserState(loginId);
  state.updated_at = now();

  await publishEvent(loginId, "bridge.status.updated", await bridgeStatus(loginId));
  await publishEvent(loginId, "bridge.projects.updated", { projects: state.projects });
  await publishEvent(loginId, "bridge.threads.updated", { threads: listLocalThreads(loginId) });
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

      if (method === "item/agentMessage/delta" && params.delta) {
        appendAssistantDelta(threadId, params.delta);
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

    if (
      method === "turn/completed" ||
      (method === "thread/status/changed" &&
        ["idle", "error", "waitingForInput"].includes(params.status?.type ?? ""))
    ) {
      void processStartQueue(owner);
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

function getThreadDetail(userId, threadId) {
  const normalizedUserId = sanitizeUserId(userId);
  const thread = threadStateById.get(threadId);

  if (!thread || threadOwners.get(threadId) !== normalizedUserId) {
    return {
      thread: null,
      messages: []
    };
  }

  return {
    thread,
    messages: listThreadMessages(threadId)
  };
}

function enqueueThreadsForStart(userId, threadIds = []) {
  const queue = ensurePendingQueue(userId);

  for (const threadId of threadIds) {
    if (!threadId || queue.includes(threadId)) {
      continue;
    }

    queue.push(threadId);
  }

  return queue;
}

function removeThreadFromQueue(userId, threadId) {
  const queue = ensurePendingQueue(userId);
  const index = queue.indexOf(threadId);

  if (index >= 0) {
    queue.splice(index, 1);
  }
}

function deleteThreadState(userId, threadId) {
  const normalized = sanitizeUserId(userId);
  const state = ensureUserState(normalized);
  state.threadIds.delete(threadId);
  removeThreadFromQueue(normalized, threadId);
  threadOwners.delete(threadId);
  threadStateById.delete(threadId);
  threadEventsById.delete(threadId);
  threadMessagesById.delete(threadId);
  persistThreadsForUser(normalized);
}

function hasRunningThread(userId) {
  return listLocalThreads(userId).some((thread) => thread.status === "running");
}

const appServer = new AppServerClient();

async function bridgeStatus(userId) {
  const state = ensureUserState(userId);

  try {
    await appServer.ensureReady();
  } catch (error) {
    appServer.lastError = error.message;
  }

  const threads = listLocalThreads(userId);

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

function listVisibleThreads(userId, projectId = "") {
  const threads = listLocalThreads(userId);

  if (!projectId) {
    return threads;
  }

  return threads.filter((thread) => thread.project_id === projectId);
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

async function startThreadTurn(userId, threadId) {
  const current = threadStateById.get(threadId);

  if (!current) {
    throw new Error("시작할 thread를 찾을 수 없습니다.");
  }

  const cwd = resolveProjectWorkspace(userId, current.project_id);

  try {
    const turnResponse = await appServer.request("turn/start", {
      threadId,
      cwd,
      approvalPolicy: "never",
      input: [
        {
          type: "text",
          text: buildExecutionPrompt(
            current.prompt ?? '연결 상태 점검입니다. "pong" 또는 현재 상태를 짧게 답해 주세요.'
          )
        }
      ]
    });

    const turn = turnResponse.result?.turn ?? null;

    upsertThreadState(threadId, {
      ...current,
      status: "running",
      progress: Math.max(current.progress ?? 0, 20),
      last_event: "turn.started",
      turn_id: turn?.id ?? null,
      queue_position: null
    });

    await publishEvent(userId, "turn.started", {
      threadId,
      turn
    });
    await publishEvent(userId, "bridge.threads.updated", { threads: listLocalThreads(userId) });
  } catch (error) {
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
    void processStartQueue(userId);
  }
}

async function processStartQueue(userId) {
  const queue = ensurePendingQueue(userId);

  if (queue.length === 0 || hasRunningThread(userId)) {
    return;
  }

  const nextThreadId = queue.shift();
  refreshQueuePositions(userId);

  if (!nextThreadId) {
    return;
  }

  const nextThread = threadStateById.get(nextThreadId);

  if (!nextThread || ["running", "completed"].includes(nextThread.status)) {
    void processStartQueue(userId);
    return;
  }

  await startThreadTurn(userId, nextThreadId);
}

async function createQueuedIssue(userId, payload = {}) {
  const state = ensureUserState(userId);
  const projectId = payload.project_id ?? state.projects[0]?.id ?? null;
  const cwd = resolveProjectWorkspace(userId, projectId);
  const issueTitle = createIssueTitle(payload);
  const prompt = String(payload.prompt ?? "").trim();
  await appServer.ensureReady();

  const threadResponse = await appServer.request("thread/start", {
    cwd,
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
      title: issueTitle,
      project_id: projectId,
      prompt,
      progress: 5,
      status: "staged",
      last_event: "issue.created"
    })
  );
  pushThreadMessage(thread.id, {
    role: "user",
    kind: "prompt",
    content: prompt
  });

  await publishEvent(userId, "issue.created", {
    thread: threadStateById.get(thread.id)
  });
  await publishEvent(userId, "bridge.threads.updated", { threads: listLocalThreads(userId) });

  return {
    accepted: true,
    thread: threadStateById.get(thread.id),
    queue: ensurePendingQueue(userId)
  };
}

async function startQueuedThreads(userId, payload = {}) {
  const requestedThreadIds = Array.isArray(payload.thread_ids) ? payload.thread_ids : [];
  const state = ensureUserState(userId);
  const eligibleThreadIds = requestedThreadIds
    .map((threadId) => String(threadId))
    .filter((threadId) => {
      const thread = threadStateById.get(threadId);
      return Boolean(
        thread &&
          state.threadIds.has(threadId) &&
          !["running", "completed", "failed"].includes(thread.status)
      );
    });

  for (const threadId of eligibleThreadIds) {
    const thread = threadStateById.get(threadId);

    if (!thread || thread.status !== "staged") {
      continue;
    }

    upsertThreadState(threadId, {
      ...thread,
      status: "queued",
      progress: Math.max(thread.progress ?? 0, 10),
      last_event: "thread.queued"
    });
  }

  enqueueThreadsForStart(userId, eligibleThreadIds);
  refreshQueuePositions(userId);
  await publishEvent(userId, "threads.start.queued", {
    thread_ids: eligibleThreadIds
  });
  await publishEvent(userId, "bridge.threads.updated", { threads: listLocalThreads(userId) });
  await processStartQueue(userId);

  return {
    accepted: true,
    queued_thread_ids: ensurePendingQueue(userId),
    threads: listLocalThreads(userId)
  };
}

async function reorderQueuedThreads(userId, payload = {}) {
  const normalized = sanitizeUserId(userId);
  const queue = ensurePendingQueue(normalized);
  const requestedThreadIds = Array.isArray(payload.thread_ids)
    ? payload.thread_ids.map((threadId) => String(threadId))
    : [];
  const reorderedIds = requestedThreadIds.filter((threadId) => queue.includes(threadId));
  const remainingIds = queue.filter((threadId) => !reorderedIds.includes(threadId));

  pendingStartQueues.set(normalized, [...reorderedIds, ...remainingIds]);
  refreshQueuePositions(normalized);
  await publishEvent(normalized, "threads.reordered", {
    thread_ids: reorderedIds
  });
  await publishEvent(normalized, "bridge.threads.updated", { threads: listLocalThreads(normalized) });

  return {
    accepted: true,
    queued_thread_ids: ensurePendingQueue(normalized),
    threads: listLocalThreads(normalized)
  };
}

async function deleteThread(userId, payload = {}) {
  const threadId = String(payload.thread_id ?? payload.threadId ?? "").trim();

  if (!threadId) {
    throw new Error("삭제할 이슈 id가 필요합니다.");
  }

  const thread = threadStateById.get(threadId);

  if (!thread || threadOwners.get(threadId) !== sanitizeUserId(userId)) {
    throw new Error("이슈를 찾을 수 없습니다.");
  }

  if (!["staged", "queued", "idle", "awaiting_input", "failed"].includes(thread.status)) {
    throw new Error("준비 또는 보류 상태의 이슈만 삭제할 수 있습니다.");
  }

  deleteThreadState(userId, threadId);
  refreshQueuePositions(userId);
  await publishEvent(userId, "thread.deleted", {
    thread_id: threadId,
    project_id: thread.project_id
  });
  await publishEvent(userId, "bridge.threads.updated", { threads: listLocalThreads(userId) });

  return {
    accepted: true,
    thread_id: threadId,
    threads: listLocalThreads(userId)
  };
}

async function deleteProject(userId, payload = {}) {
  const projectId = String(payload.project_id ?? payload.projectId ?? "").trim();

  if (!projectId) {
    throw new Error("삭제할 프로젝트 id가 필요합니다.");
  }

  const normalized = sanitizeUserId(userId);
  const state = ensureUserState(normalized);
  const project = state.projects.find((item) => item.id === projectId);

  if (!project) {
    throw new Error("프로젝트를 찾을 수 없습니다.");
  }

  const runningThread = [...state.threadIds]
    .map((threadId) => threadStateById.get(threadId))
    .find((thread) => thread?.project_id === projectId && thread.status === "running");

  if (runningThread) {
    throw new Error("실행 중인 이슈가 있어 프로젝트를 삭제할 수 없습니다.");
  }

  const projectThreadIds = [...state.threadIds].filter(
    (threadId) => threadStateById.get(threadId)?.project_id === projectId
  );

  for (const threadId of projectThreadIds) {
    deleteThreadState(normalized, threadId);
  }

  state.projects = state.projects.filter((item) => item.id !== projectId);
  state.updated_at = now();
  persistUserProjects(normalized, state.projects);
  refreshQueuePositions(normalized);

  await publishEvent(normalized, "project.deleted", { project_id: projectId });
  await publishEvent(normalized, "bridge.projects.updated", { projects: state.projects });
  await publishEvent(normalized, "bridge.threads.updated", { threads: listLocalThreads(normalized) });

  return {
    accepted: true,
    project_id: projectId,
    projects: state.projects,
    threads: listLocalThreads(normalized)
  };
}

function resolveProjectWorkspace(userId, projectId) {
  const state = ensureUserState(userId);
  const project =
    state.projects.find((item) => item.id === projectId) ??
    state.projects.find((item) => item.workspace_path) ??
    null;

  return project?.workspace_path ?? process.cwd();
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
      subject: "octop.user.*.bridge.*.workspace.roots.get",
      handler: (userId) => ({ roots: listWorkspaceRoots(userId) })
    },
    {
      subject: "octop.user.*.bridge.*.threads.get",
      handler: async (userId, body) => ({
        threads: listVisibleThreads(userId, String(body.project_id ?? ""))
      })
    },
    {
      subject: "octop.user.*.bridge.*.threads.reorder",
      handler: async (userId, body) => reorderQueuedThreads(userId, body)
    },
    {
      subject: "octop.user.*.bridge.*.thread.detail.get",
      handler: (userId, body) => getThreadDetail(userId, body.thread_id ?? body.threadId ?? "")
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
          const body = message.data?.length ? parseJson(message.data) : {};
          await respond(message, await entry.handler(userId, body));
        } catch (error) {
          await respond(message, { error: error.message });
        }
      }
    })();
  }

  const projectCreateSubscription = nc.subscribe("octop.user.*.bridge.*.project.create");

  (async () => {
    for await (const message of projectCreateSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.login_id ?? body.user_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await createProject(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const projectDeleteSubscription = nc.subscribe("octop.user.*.bridge.*.project.delete");

  (async () => {
    for await (const message of projectDeleteSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.login_id ?? body.user_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await deleteProject(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const folderListSubscription = nc.subscribe("octop.user.*.bridge.*.folder.list.get");

  (async () => {
    for await (const message of folderListSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.login_id ?? body.user_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        await respond(message, listFoldersForUser(userId, body.path ?? ""));
      } catch (error) {
        await respond(message, { error: error.message });
      }
    }
  })();

  const issueCreateSubscription = nc.subscribe("octop.user.*.bridge.*.issue.create");

  (async () => {
    for await (const message of issueCreateSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await createQueuedIssue(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const threadDeleteSubscription = nc.subscribe("octop.user.*.bridge.*.thread.delete");

  (async () => {
    for await (const message of threadDeleteSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await deleteThread(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const threadsStartSubscription = nc.subscribe("octop.user.*.bridge.*.threads.start");

  (async () => {
    for await (const message of threadsStartSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await startQueuedThreads(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const threadsReorderSubscription = nc.subscribe("octop.user.*.bridge.*.threads.reorder");

  (async () => {
    for await (const message of threadsReorderSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await reorderQueuedThreads(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const pingSubscription = nc.subscribe("octop.user.*.bridge.*.command.ping");

  (async () => {
    for await (const message of pingSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await createQueuedIssue(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();
}

await subscribeRequests();

setInterval(() => {
  void publishSnapshots(BRIDGE_OWNER_LOGIN_ID);
}, 30000).unref();

await publishSnapshots(BRIDGE_OWNER_LOGIN_ID);

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

  if (request.method === "GET" && url.pathname === "/api/workspace-roots") {
    return sendJson(response, 200, { roots: listWorkspaceRoots(userId) });
  }

  if (request.method === "GET" && url.pathname === "/api/folders") {
    try {
      return sendJson(response, 200, listFoldersForUser(userId, url.searchParams.get("path") ?? ""));
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }

  if (request.method === "POST" && url.pathname === "/api/projects") {
    try {
      const body = await readJsonBody(request);
      const payload = await createProject(userId, body);
      return sendJson(response, 201, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "DELETE" && url.pathname.startsWith("/api/projects/")) {
    try {
      const projectId = url.pathname.split("/").at(-1);
      const payload = await deleteProject(userId, { project_id: projectId });
      return sendJson(response, 200, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "GET" && url.pathname === "/api/threads") {
    return sendJson(response, 200, {
      threads: listVisibleThreads(userId, url.searchParams.get("project_id") ?? "")
    });
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/threads/")) {
    const threadId = url.pathname.split("/").at(-1);
    return sendJson(response, 200, getThreadDetail(userId, threadId));
  }

  if (request.method === "DELETE" && url.pathname.startsWith("/api/threads/")) {
    try {
      const threadId = url.pathname.split("/").at(-1);
      const payload = await deleteThread(userId, { thread_id: threadId });
      return sendJson(response, 200, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "POST" && url.pathname === "/api/issues") {
    try {
      const body = await readJsonBody(request);
      const payload = await createQueuedIssue(userId, body);
      return sendJson(response, 202, payload);
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }

  if (request.method === "POST" && url.pathname === "/api/threads/start") {
    try {
      const body = await readJsonBody(request);
      const payload = await startQueuedThreads(userId, body);
      return sendJson(response, 202, payload);
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }

  if (request.method === "POST" && url.pathname === "/api/threads/reorder") {
    try {
      const body = await readJsonBody(request);
      const payload = await reorderQueuedThreads(userId, body);
      return sendJson(response, 202, payload);
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }

  if (request.method === "POST" && url.pathname === "/api/commands/ping") {
    try {
      const body = await readJsonBody(request);
      const payload = await createQueuedIssue(userId, body);
      return sendJson(response, 202, payload);
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }

  return sendJson(response, 404, { error: "Not found" });
}).listen(PORT, HOST, () => {
  console.log(`OctOP bridge listening on http://${HOST}:${PORT}`);
});
