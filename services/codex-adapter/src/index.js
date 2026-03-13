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
const issueCardsById = new Map();
const issueMessagesById = new Map();
const threadIssueIdsById = new Map();
const activeIssueByThreadId = new Map();
const codexThreadToThreadId = new Map();

function now() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createThreadEntityId() {
  return sanitizeBridgeId(`thread-${randomUUID()}`);
}

function createIssueCardId() {
  return sanitizeBridgeId(`issue-${randomUUID()}`);
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
    const projectEntry = loadProjectEntry(normalized);
    const restoredThreads = loadThreadsForUser(normalized);
    users.set(normalized, {
      projects: loadProjectsForUser(normalized, projectEntry),
      deletedWorkspacePaths: projectEntry.deletedWorkspacePaths,
      threadIds: restoredThreads,
      updated_at: now()
    });
  }

  const state = users.get(normalized);
  const discoveredProjects = discoverProjectsForUser(normalized, state.deletedWorkspacePaths);
  const mergedProjects = mergeProjects(state.projects, discoveredProjects);

  if (hasProjectSetChanged(state.projects, mergedProjects)) {
    state.projects = mergedProjects;
    persistUserProjects(normalized, state.projects, state.deletedWorkspacePaths);
  }

  ensureDefaultThreadsForProjects(normalized, state.projects);

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

  if (!stored || typeof stored !== "object") {
    return new Set();
  }

  if (Array.isArray(stored.project_thread_ids)) {
    return restoreThreadCentricState(loginId, stored);
  }

  return migrateLegacyThreadState(loginId, stored);
}

function persistThreadsForUser(loginId) {
  const normalized = sanitizeUserId(loginId);
  const state = users.get(normalized);

  if (!state) {
    return;
  }

  const storage = readThreadStorage();
  const threadIds = [...state.threadIds].filter((threadId) => threadStateById.has(threadId));
  const issueIds = threadIds.flatMap((threadId) => getThreadIssueIds(threadId));
  const queueIds = Object.fromEntries(
    threadIds.map((threadId) => [threadId, ensurePendingQueue(threadId)])
  );
  const activeIssueIds = Object.fromEntries(
    threadIds
      .filter((threadId) => activeIssueByThreadId.has(threadId))
      .map((threadId) => [threadId, activeIssueByThreadId.get(threadId)])
  );
  const codexThreadIds = Object.fromEntries(
    threadIds
      .map((threadId) => [threadId, threadStateById.get(threadId)?.codex_thread_id ?? null])
  );

  storage[normalized] = {
    project_thread_ids: threadIds,
    project_threads: Object.fromEntries(
      threadIds.map((threadId) => [threadId, threadStateById.get(threadId)])
    ),
    issue_ids: issueIds,
    issues: Object.fromEntries(
      issueIds.map((issueId) => [issueId, issueCardsById.get(issueId)])
    ),
    thread_issue_ids: Object.fromEntries(
      threadIds.map((threadId) => [threadId, getThreadIssueIds(threadId)])
    ),
    issue_queue_ids: queueIds,
    active_issue_ids: activeIssueIds,
    codex_thread_ids: codexThreadIds,
    issue_messages: Object.fromEntries(
      issueIds
        .filter((issueId) => issueMessagesById.has(issueId))
        .map((issueId) => [issueId, issueMessagesById.get(issueId)])
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

function restoreThreadCentricState(loginId, stored) {
  const threadIds = new Set();

  for (const threadId of stored.project_thread_ids ?? []) {
    if (!threadId) {
      continue;
    }

    const thread = stored.project_threads?.[threadId];

    if (!thread) {
      continue;
    }

    const normalizedThread = normalizeProjectThread(loginId, thread);
    threadStateById.set(threadId, normalizedThread);
    threadOwners.set(threadId, loginId);
    threadIds.add(threadId);

    if (normalizedThread.codex_thread_id) {
      codexThreadToThreadId.set(normalizedThread.codex_thread_id, threadId);
    }
  }

  for (const issueId of stored.issue_ids ?? []) {
    if (!issueId) {
      continue;
    }

    const issue = stored.issues?.[issueId];

    if (!issue) {
      continue;
    }

    issueCardsById.set(issueId, normalizeIssueCard(issue));

    const messages = stored.issue_messages?.[issueId];

    if (Array.isArray(messages) && messages.length > 0) {
      issueMessagesById.set(issueId, messages);
    }
  }

  for (const [threadId, issueIds] of Object.entries(stored.thread_issue_ids ?? {})) {
    threadIssueIdsById.set(
      threadId,
      Array.isArray(issueIds) ? issueIds.filter((issueId) => issueCardsById.has(issueId)) : []
    );
  }

  for (const [threadId, issueIds] of Object.entries(stored.issue_queue_ids ?? {})) {
    pendingStartQueues.set(
      threadId,
      Array.isArray(issueIds) ? issueIds.filter((issueId) => issueCardsById.has(issueId)) : []
    );
  }

  for (const [threadId, issueId] of Object.entries(stored.active_issue_ids ?? {})) {
    if (issueCardsById.has(issueId)) {
      activeIssueByThreadId.set(threadId, issueId);
    }
  }

  return threadIds;
}

function migrateLegacyThreadState(loginId, stored) {
  const migratedThreadIds = new Set();
  const legacyThreads = Array.isArray(stored.thread_ids) ? stored.thread_ids : [];

  for (const legacyThreadId of legacyThreads) {
    const legacyThread = stored.threads?.[legacyThreadId];

    if (!legacyThread) {
      continue;
    }

    const projectId = legacyThread.project_id ?? buildDefaultProject(loginId).id;
    const migratedThreadId = ensureDefaultProjectThread(loginId, projectId, "Legacy");
    const cardId = createIssueCardId();
    const issue = normalizeIssueCard({
      id: cardId,
      project_id: projectId,
      thread_id: migratedThreadId,
      title: legacyThread.title ?? legacyThread.name ?? "Legacy issue",
      prompt: legacyThread.prompt ?? "",
      status: legacyThread.status ?? "completed",
      progress: legacyThread.progress ?? 100,
      last_event: legacyThread.last_event ?? "legacy.migrated",
      last_message: legacyThread.last_message ?? "",
      created_at: legacyThread.created_at ?? now(),
      updated_at: legacyThread.updated_at ?? now(),
      source: "legacy"
    });

    issueCardsById.set(cardId, issue);
    setThreadIssueIds(migratedThreadId, [...getThreadIssueIds(migratedThreadId), cardId]);

    const legacyMessages = stored.messages?.[legacyThreadId];

    if (Array.isArray(legacyMessages) && legacyMessages.length > 0) {
      issueMessagesById.set(cardId, legacyMessages);
    }

    migratedThreadIds.add(migratedThreadId);
    updateProjectThreadSnapshot(migratedThreadId);
  }

  return migratedThreadIds;
}

function loadProjectEntry(loginId) {
  const persisted = readProjectStorage();
  const stored = persisted[loginId];

  if (Array.isArray(stored)) {
    return {
      projects: stored,
      deletedWorkspacePaths: []
    };
  }

  if (stored && typeof stored === "object") {
    return {
      projects: Array.isArray(stored.projects) ? stored.projects : [],
      deletedWorkspacePaths: Array.isArray(stored.deleted_workspace_paths)
        ? stored.deleted_workspace_paths.map((value) => resolve(String(value)))
        : []
    };
  }

  return {
    projects: [],
    deletedWorkspacePaths: []
  };
}

function loadProjectsForUser(loginId, projectEntry = loadProjectEntry(loginId)) {
  const persisted = readProjectStorage();
  const storedProjects = projectEntry.projects;
  const discoveredProjects = discoverProjectsForUser(loginId, projectEntry.deletedWorkspacePaths);

  if (Array.isArray(storedProjects) && storedProjects.length > 0) {
    return mergeProjects(
      storedProjects.map((project) => normalizeProject(loginId, project)),
      discoveredProjects
    );
  }

  const project = discoveredProjects[0] ?? buildDefaultProject(loginId);
  persisted[loginId] = {
    projects: mergeProjects([project], discoveredProjects),
    deleted_workspace_paths: projectEntry.deletedWorkspacePaths,
    updated_at: now()
  };
  writeProjectStorage(persisted);
  return persisted[loginId].projects;
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

function normalizeProjectThread(loginId, thread = {}) {
  return {
    id: sanitizeBridgeId(thread.id ?? createThreadEntityId()),
    project_id: String(thread.project_id ?? "").trim(),
    name: String(thread.name ?? thread.title ?? "Main").trim() || "Main",
    description: String(thread.description ?? "").trim(),
    bridge_id: BRIDGE_ID,
    login_id: sanitizeUserId(loginId),
    codex_thread_id: thread.codex_thread_id ? String(thread.codex_thread_id).trim() : null,
    status: String(thread.status ?? "idle").trim() || "idle",
    progress: Number.isFinite(Number(thread.progress)) ? Number(thread.progress) : 0,
    last_event: String(thread.last_event ?? "thread.ready").trim(),
    last_message: String(thread.last_message ?? "").trim(),
    created_at: thread.created_at ?? now(),
    updated_at: thread.updated_at ?? now()
  };
}

function normalizeIssueCard(issue = {}) {
  return {
    id: sanitizeBridgeId(issue.id ?? createIssueCardId()),
    project_id: String(issue.project_id ?? "").trim(),
    thread_id: String(issue.thread_id ?? "").trim(),
    title: String(issue.title ?? "").trim() || "Untitled issue",
    prompt: String(issue.prompt ?? "").trim(),
    status: String(issue.status ?? "staged").trim() || "staged",
    progress: Number.isFinite(Number(issue.progress)) ? Number(issue.progress) : 0,
    last_event: String(issue.last_event ?? "issue.created").trim(),
    last_message: String(issue.last_message ?? "").trim(),
    queue_position: Number.isFinite(Number(issue.queue_position)) ? Number(issue.queue_position) : null,
    created_at: issue.created_at ?? now(),
    updated_at: issue.updated_at ?? now(),
    source: issue.source ?? "bridge"
  };
}

function getThreadIssueIds(threadId) {
  if (!threadIssueIdsById.has(threadId)) {
    threadIssueIdsById.set(threadId, []);
  }

  return threadIssueIdsById.get(threadId);
}

function setThreadIssueIds(threadId, issueIds) {
  threadIssueIdsById.set(threadId, issueIds);
  persistThreadById(threadId);
}

function ensurePendingQueue(threadId) {
  const normalized = sanitizeBridgeId(threadId);

  if (!pendingStartQueues.has(normalized)) {
    pendingStartQueues.set(normalized, []);
  }

  return pendingStartQueues.get(normalized);
}

function ensureIssueMessages(issueId) {
  if (!issueMessagesById.has(issueId)) {
    issueMessagesById.set(issueId, []);
  }

  return issueMessagesById.get(issueId);
}

function pushIssueMessage(issueId, message) {
  const messages = ensureIssueMessages(issueId);
  messages.push({
    id: randomUUID(),
    timestamp: now(),
    ...message
  });
  return messages;
}

function appendAssistantDeltaToIssue(issueId, delta = "") {
  const messages = ensureIssueMessages(issueId);
  const lastMessage = messages.at(-1);

  if (lastMessage?.role === "assistant") {
    lastMessage.content = `${lastMessage.content ?? ""}${delta}`;
    lastMessage.timestamp = now();
    return;
  }

  messages.push({
    id: randomUUID(),
    role: "assistant",
    kind: "message",
    content: String(delta ?? ""),
    timestamp: now()
  });
}

function listIssueMessages(issueId) {
  return [...(issueMessagesById.get(issueId) ?? [])];
}

function updateProjectThreadSnapshot(threadId) {
  const thread = threadStateById.get(threadId);

  if (!thread) {
    return null;
  }

  const issueIds = getThreadIssueIds(threadId);
  const issues = issueIds
    .map((issueId) => issueCardsById.get(issueId))
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
  const activeIssueId = activeIssueByThreadId.get(threadId);
  const activeIssue = activeIssueId ? issueCardsById.get(activeIssueId) : null;
  const queuedCount = ensurePendingQueue(threadId).length;
  const latestIssue = issues[0] ?? null;

  const nextStatus = activeIssue
    ? activeIssue.status
    : queuedCount > 0
      ? "queued"
      : latestIssue?.status === "completed"
        ? "completed"
        : latestIssue?.status === "failed"
          ? "failed"
          : latestIssue?.status === "awaiting_input"
            ? "awaiting_input"
            : "idle";

  const nextThread = {
    ...thread,
    status: nextStatus,
    progress: activeIssue?.progress ?? latestIssue?.progress ?? 0,
    last_event: activeIssue?.last_event ?? latestIssue?.last_event ?? thread.last_event,
    last_message: activeIssue?.last_message ?? latestIssue?.last_message ?? thread.last_message,
    updated_at: latestIssue?.updated_at ?? thread.updated_at
  };

  threadStateById.set(threadId, nextThread);
  return nextThread;
}

function ensureDefaultProjectThread(loginId, projectId, preferredName = "Main") {
  const normalized = sanitizeUserId(loginId);
  const state = users.get(normalized);
  const existing = [...(state?.threadIds ?? [])]
    .map((threadId) => threadStateById.get(threadId))
    .find((thread) => thread?.project_id === projectId);

  if (existing?.id) {
    return existing.id;
  }

  const threadId = createThreadEntityId();
  const thread = normalizeProjectThread(normalized, {
    id: threadId,
    project_id: projectId,
    name: preferredName,
    status: "idle",
    last_event: "thread.created",
    created_at: now(),
    updated_at: now()
  });

  threadStateById.set(threadId, thread);
  threadOwners.set(threadId, normalized);
  state?.threadIds.add(threadId);
  getThreadIssueIds(threadId);
  persistThreadById(threadId);
  return threadId;
}

function ensureDefaultThreadsForProjects(loginId, projects = []) {
  const normalized = sanitizeUserId(loginId);
  const state = users.get(normalized);

  if (!state) {
    return;
  }

  let changed = false;

  for (const project of projects) {
    const exists = [...state.threadIds].some((threadId) => threadStateById.get(threadId)?.project_id === project.id);

    if (exists) {
      continue;
    }

    ensureDefaultProjectThread(normalized, project.id, "Main");
    changed = true;
  }

  if (changed) {
    persistThreadsForUser(normalized);
  }
}

function listProjectThreads(userId, projectId = "") {
  const state = ensureUserState(userId);
  const items = [...state.threadIds]
    .map((threadId) => updateProjectThreadSnapshot(threadId) ?? threadStateById.get(threadId))
    .filter(Boolean)
    .filter((thread) => !projectId || thread.project_id === projectId)
    .map((thread) => ({
      ...thread,
      issue_count: getThreadIssueIds(thread.id).length,
      queued_count: ensurePendingQueue(thread.id).length
    }))
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));

  return items;
}

function listThreadIssues(threadId) {
  return getThreadIssueIds(threadId)
    .map((issueId) => issueCardsById.get(issueId))
    .filter(Boolean)
    .sort((left, right) => {
      const leftOrder = left.queue_position ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = right.queue_position ?? Number.MAX_SAFE_INTEGER;

      if (left.status === "queued" && right.status === "queued" && leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }

      return Date.parse(right.updated_at) - Date.parse(left.updated_at);
    });
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

function discoverProjectsForUser(loginId, deletedWorkspacePaths = []) {
  const blockedPaths = new Set(
    deletedWorkspacePaths
      .map((value) => resolve(String(value)))
  );
  const discovered = [];

  for (const root of WORKSPACE_ROOTS) {
    const candidates = [root, ...safeListDirectories(root)];

    for (const candidate of candidates) {
      if (blockedPaths.has(candidate)) {
        continue;
      }

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

function persistUserProjects(loginId, projects, deletedWorkspacePaths = []) {
  const storage = readProjectStorage();
  storage[loginId] = {
    projects,
    deleted_workspace_paths: [...new Set(deletedWorkspacePaths.map((value) => resolve(String(value))))],
    updated_at: now()
  };
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
  state.deletedWorkspacePaths = state.deletedWorkspacePaths.filter((value) => value !== project.workspace_path);
  state.updated_at = now();
  persistUserProjects(loginId, state.projects, state.deletedWorkspacePaths);
  await publishEvent(loginId, "bridge.projects.updated", { projects: state.projects });

  return {
    accepted: true,
    project,
    projects: state.projects
  };
}

async function updateProject(loginId, payload = {}) {
  const state = ensureUserState(loginId);
  const projectId = String(payload.project_id ?? payload.projectId ?? "").trim();
  const name = String(payload.name ?? "").trim();

  if (!projectId) {
    throw new Error("변경할 프로젝트 id가 필요합니다.");
  }

  if (!name) {
    throw new Error("프로젝트 이름이 필요합니다.");
  }

  const projectIndex = state.projects.findIndex((item) => item.id === projectId);

  if (projectIndex === -1) {
    throw new Error("프로젝트를 찾을 수 없습니다.");
  }

  const duplicateName = state.projects.some(
    (item, index) => index !== projectIndex && item.name.trim().toLowerCase() === name.toLowerCase()
  );

  if (duplicateName) {
    throw new Error("같은 이름의 프로젝트가 이미 있습니다.");
  }

  const currentProject = state.projects[projectIndex];
  const updatedProject = {
    ...currentProject,
    name,
    updated_at: now()
  };

  state.projects = state.projects.map((project) => (project.id === projectId ? updatedProject : project));
  state.updated_at = now();
  persistUserProjects(loginId, state.projects, state.deletedWorkspacePaths);
  await publishEvent(loginId, "project.updated", { project: updatedProject, project_id: projectId });
  await publishEvent(loginId, "bridge.projects.updated", { projects: state.projects });

  return {
    accepted: true,
    project: updatedProject,
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

async function createProjectThread(userId, payload = {}) {
  const state = ensureUserState(userId);
  const projectId = String(payload.project_id ?? payload.projectId ?? "").trim();
  const name = String(payload.name ?? "").trim() || "New Thread";

  if (!projectId) {
    throw new Error("thread를 생성할 프로젝트 id가 필요합니다.");
  }

  const project = state.projects.find((item) => item.id === projectId);

  if (!project) {
    throw new Error("프로젝트를 찾을 수 없습니다.");
  }

  const threadId = createThreadEntityId();
  const thread = normalizeProjectThread(userId, {
    id: threadId,
    project_id: projectId,
    name,
    description: payload.description ?? "",
    status: "idle",
    last_event: "thread.created"
  });

  threadStateById.set(threadId, thread);
  threadOwners.set(threadId, sanitizeUserId(userId));
  state.threadIds.add(threadId);
  getThreadIssueIds(threadId);
  persistThreadsForUser(userId);
  await publishEvent(userId, "thread.created", { thread });
  await publishEvent(userId, "bridge.projectThreads.updated", {
    project_id: projectId,
    threads: listProjectThreads(userId, projectId)
  });

  return {
    accepted: true,
    thread,
    threads: listProjectThreads(userId, projectId)
  };
}

async function updateProjectThread(userId, payload = {}) {
  const threadId = String(payload.thread_id ?? payload.threadId ?? "").trim();
  const name = String(payload.name ?? "").trim();

  if (!threadId) {
    throw new Error("변경할 thread id가 필요합니다.");
  }

  if (!name) {
    throw new Error("thread 이름이 필요합니다.");
  }

  const current = threadStateById.get(threadId);

  if (!current || threadOwners.get(threadId) !== sanitizeUserId(userId)) {
    throw new Error("thread를 찾을 수 없습니다.");
  }

  const next = {
    ...current,
    name,
    updated_at: now()
  };

  threadStateById.set(threadId, next);
  persistThreadById(threadId);
  await publishEvent(userId, "thread.updated", { thread: next });
  await publishEvent(userId, "bridge.projectThreads.updated", {
    project_id: next.project_id,
    threads: listProjectThreads(userId, next.project_id)
  });

  return {
    accepted: true,
    thread: next,
    threads: listProjectThreads(userId, next.project_id)
  };
}

async function deleteProjectThread(userId, payload = {}) {
  const threadId = String(payload.thread_id ?? payload.threadId ?? "").trim();

  if (!threadId) {
    throw new Error("삭제할 thread id가 필요합니다.");
  }

  const current = threadStateById.get(threadId);

  if (!current || threadOwners.get(threadId) !== sanitizeUserId(userId)) {
    throw new Error("thread를 찾을 수 없습니다.");
  }

  if (activeIssueByThreadId.has(threadId)) {
    throw new Error("실행 중인 thread는 삭제할 수 없습니다.");
  }

  for (const issueId of getThreadIssueIds(threadId)) {
    issueCardsById.delete(issueId);
    issueMessagesById.delete(issueId);
  }

  threadIssueIdsById.delete(threadId);
  pendingStartQueues.delete(threadId);
  activeIssueByThreadId.delete(threadId);

  const codexThreadId = current.codex_thread_id;
  if (codexThreadId) {
    codexThreadToThreadId.delete(codexThreadId);
  }

  const state = ensureUserState(userId);
  state.threadIds.delete(threadId);
  threadStateById.delete(threadId);
  threadOwners.delete(threadId);
  persistThreadsForUser(userId);
  await publishEvent(userId, "thread.deleted", {
    thread_id: threadId,
    project_id: current.project_id
  });
  await publishEvent(userId, "bridge.projectThreads.updated", {
    project_id: current.project_id,
    threads: listProjectThreads(userId, current.project_id)
  });

  return {
    accepted: true,
    thread_id: threadId,
    threads: listProjectThreads(userId, current.project_id)
  };
}

function getIssueDetail(userId, issueId) {
  const issue = issueCardsById.get(issueId);

  if (!issue) {
    return {
      issue: null,
      messages: []
    };
  }

  const thread = threadStateById.get(issue.thread_id);

  if (!thread || threadOwners.get(thread.id) !== sanitizeUserId(userId)) {
    return {
      issue: null,
      messages: []
    };
  }

  return {
    issue,
    thread,
    messages: listIssueMessages(issueId)
  };
}

async function createThreadIssue(userId, payload = {}) {
  const threadId = String(payload.thread_id ?? payload.threadId ?? "").trim();
  const prompt = String(payload.prompt ?? "").trim();

  if (!threadId) {
    throw new Error("이슈를 등록할 thread가 필요합니다.");
  }

  if (!prompt) {
    throw new Error("프롬프트를 입력해 주세요.");
  }

  const thread = threadStateById.get(threadId);

  if (!thread || threadOwners.get(threadId) !== sanitizeUserId(userId)) {
    throw new Error("thread를 찾을 수 없습니다.");
  }

  const issue = normalizeIssueCard({
    id: createIssueCardId(),
    project_id: thread.project_id,
    thread_id: threadId,
    title: createIssueTitle(payload),
    prompt,
    status: "staged",
    progress: 0,
    last_event: "issue.created",
    last_message: ""
  });

  issueCardsById.set(issue.id, issue);
  setThreadIssueIds(threadId, [...getThreadIssueIds(threadId), issue.id]);
  pushIssueMessage(issue.id, {
    role: "user",
    kind: "prompt",
    content: prompt
  });
  updateProjectThreadSnapshot(threadId);
  persistThreadById(threadId);
  await publishEvent(userId, "issue.created", { issue, thread_id: threadId });
  await publishEvent(userId, "bridge.threadIssues.updated", {
    thread_id: threadId,
    issues: listThreadIssues(threadId)
  });
  await publishEvent(userId, "bridge.projectThreads.updated", {
    project_id: thread.project_id,
    threads: listProjectThreads(userId, thread.project_id)
  });

  return {
    accepted: true,
    issue,
    issues: listThreadIssues(threadId)
  };
}

async function ensureCodexThreadForProjectThread(userId, threadId) {
  const thread = threadStateById.get(threadId);

  if (!thread) {
    throw new Error("thread를 찾을 수 없습니다.");
  }

  if (thread.codex_thread_id) {
    return thread.codex_thread_id;
  }

  const cwd = resolveProjectWorkspace(userId, thread.project_id);
  await appServer.ensureReady();
  const threadResponse = await appServer.request("thread/start", {
    cwd,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    model: "gpt-5-codex",
    personality: "pragmatic"
  });
  const codexThread = threadResponse.result?.thread;

  if (!codexThread?.id) {
    throw new Error("app-server thread/start 응답에 thread id가 없습니다.");
  }

  const next = {
    ...thread,
    codex_thread_id: codexThread.id,
    updated_at: now(),
    last_event: "thread.bound"
  };

  threadStateById.set(threadId, next);
  codexThreadToThreadId.set(codexThread.id, threadId);
  persistThreadById(threadId);
  await publishEvent(userId, "thread.bound", {
    thread: next
  });
  await publishEvent(userId, "bridge.projectThreads.updated", {
    project_id: next.project_id,
    threads: listProjectThreads(userId, next.project_id)
  });

  return codexThread.id;
}

function updateIssueCard(issueId, patch = {}) {
  const current = issueCardsById.get(issueId);

  if (!current) {
    return null;
  }

  const next = {
    ...current,
    ...patch,
    id: issueId,
    updated_at: patch.updated_at ?? now()
  };

  issueCardsById.set(issueId, next);
  updateProjectThreadSnapshot(next.thread_id);
  persistThreadById(next.thread_id);
  return next;
}

async function startIssueTurn(userId, threadId, issueId) {
  const thread = threadStateById.get(threadId);
  const issue = issueCardsById.get(issueId);

  if (!thread || !issue) {
    throw new Error("실행할 작업을 찾을 수 없습니다.");
  }

  const codexThreadId = await ensureCodexThreadForProjectThread(userId, threadId);
  const cwd = resolveProjectWorkspace(userId, thread.project_id);
  activeIssueByThreadId.set(threadId, issueId);

  try {
    const turnResponse = await appServer.request("turn/start", {
      threadId: codexThreadId,
      cwd,
      approvalPolicy: "never",
      input: [
        {
          type: "text",
          text: buildExecutionPrompt(issue.prompt)
        }
      ]
    });

    const turn = turnResponse.result?.turn ?? null;
    updateIssueCard(issueId, {
      status: "running",
      progress: 20,
      last_event: "turn.started"
    });
    updateProjectThreadSnapshot(threadId);
    await publishEvent(userId, "turn.started", {
      thread_id: threadId,
      issue_id: issueId,
      turn
    });
    await publishEvent(userId, "bridge.threadIssues.updated", {
      thread_id: threadId,
      issues: listThreadIssues(threadId)
    });
    await publishEvent(userId, "bridge.projectThreads.updated", {
      project_id: thread.project_id,
      threads: listProjectThreads(userId, thread.project_id)
    });
  } catch (error) {
    activeIssueByThreadId.delete(threadId);
    updateIssueCard(issueId, {
      status: "failed",
      progress: 0,
      last_event: "turn.start.failed",
      last_message: error.message
    });
    await publishEvent(userId, "turn.start.failed", {
      thread_id: threadId,
      issue_id: issueId,
      error: error.message
    });
    await publishEvent(userId, "bridge.threadIssues.updated", {
      thread_id: threadId,
      issues: listThreadIssues(threadId)
    });
    void processIssueQueue(userId, threadId);
  }
}

async function processIssueQueue(userId, threadId) {
  if (activeIssueByThreadId.has(threadId)) {
    return;
  }

  const queue = ensurePendingQueue(threadId);
  const nextIssueId = queue.shift();

  if (!nextIssueId) {
    updateProjectThreadSnapshot(threadId);
    persistThreadById(threadId);
    return;
  }

  refreshIssueQueuePositions(threadId);
  await startIssueTurn(userId, threadId, nextIssueId);
}

function refreshIssueQueuePositions(threadId) {
  const queue = ensurePendingQueue(threadId);

  for (const issueId of getThreadIssueIds(threadId)) {
    const issue = issueCardsById.get(issueId);

    if (!issue) {
      continue;
    }

    const queueIndex = queue.indexOf(issueId);
    issueCardsById.set(issueId, {
      ...issue,
      queue_position: queueIndex >= 0 ? queueIndex + 1 : null,
      updated_at: queueIndex >= 0 ? now() : issue.updated_at
    });
  }

  updateProjectThreadSnapshot(threadId);
  persistThreadById(threadId);
}

async function startThreadIssues(userId, payload = {}) {
  const threadId = String(payload.thread_id ?? payload.threadId ?? "").trim();
  const requestedIssueIds = Array.isArray(payload.issue_ids) ? payload.issue_ids.map((value) => String(value)) : [];

  if (!threadId) {
    throw new Error("시작할 thread가 필요합니다.");
  }

  const eligibleIssueIds = requestedIssueIds.filter((issueId) => {
    const issue = issueCardsById.get(issueId);
    return issue && issue.thread_id === threadId && issue.status === "staged";
  });

  if (eligibleIssueIds.length === 0) {
    return {
      accepted: true,
      issues: listThreadIssues(threadId)
    };
  }

  for (const issueId of eligibleIssueIds) {
    updateIssueCard(issueId, {
      status: "queued",
      progress: 10,
      last_event: "issue.queued"
    });
  }

  const queue = ensurePendingQueue(threadId);
  for (const issueId of eligibleIssueIds) {
    if (!queue.includes(issueId)) {
      queue.push(issueId);
    }
  }

  refreshIssueQueuePositions(threadId);
  await publishEvent(userId, "thread.issues.queued", {
    thread_id: threadId,
    issue_ids: eligibleIssueIds
  });
  await publishEvent(userId, "bridge.threadIssues.updated", {
    thread_id: threadId,
    issues: listThreadIssues(threadId)
  });
  await publishEvent(userId, "bridge.projectThreads.updated", {
    project_id: threadStateById.get(threadId)?.project_id ?? null,
    threads: listProjectThreads(userId, threadStateById.get(threadId)?.project_id ?? "")
  });
  await processIssueQueue(userId, threadId);

  return {
    accepted: true,
    issues: listThreadIssues(threadId)
  };
}

async function reorderThreadIssues(userId, payload = {}) {
  const threadId = String(payload.thread_id ?? payload.threadId ?? "").trim();
  const issueIds = Array.isArray(payload.issue_ids) ? payload.issue_ids.map((value) => String(value)) : [];

  if (!threadId) {
    throw new Error("정렬할 thread가 필요합니다.");
  }

  const queue = ensurePendingQueue(threadId);
  const reordered = issueIds.filter((issueId) => queue.includes(issueId));
  const remaining = queue.filter((issueId) => !reordered.includes(issueId));
  pendingStartQueues.set(threadId, [...reordered, ...remaining]);
  refreshIssueQueuePositions(threadId);
  await publishEvent(userId, "thread.issues.reordered", {
    thread_id: threadId,
    issue_ids: ensurePendingQueue(threadId)
  });
  await publishEvent(userId, "bridge.threadIssues.updated", {
    thread_id: threadId,
    issues: listThreadIssues(threadId)
  });

  return {
    accepted: true,
    issues: listThreadIssues(threadId)
  };
}

async function deleteThreadIssue(userId, payload = {}) {
  const issueId = String(payload.issue_id ?? payload.issueId ?? "").trim();

  if (!issueId) {
    throw new Error("삭제할 이슈 id가 필요합니다.");
  }

  const issue = issueCardsById.get(issueId);

  if (!issue) {
    throw new Error("이슈를 찾을 수 없습니다.");
  }

  const thread = threadStateById.get(issue.thread_id);

  if (!thread || threadOwners.get(thread.id) !== sanitizeUserId(userId)) {
    throw new Error("이슈를 찾을 수 없습니다.");
  }

  if (activeIssueByThreadId.get(issue.thread_id) === issueId) {
    throw new Error("실행 중인 이슈는 삭제할 수 없습니다.");
  }

  issueCardsById.delete(issueId);
  issueMessagesById.delete(issueId);
  setThreadIssueIds(
    issue.thread_id,
    getThreadIssueIds(issue.thread_id).filter((item) => item !== issueId)
  );
  pendingStartQueues.set(
    issue.thread_id,
    ensurePendingQueue(issue.thread_id).filter((item) => item !== issueId)
  );
  refreshIssueQueuePositions(issue.thread_id);
  await publishEvent(userId, "issue.deleted", {
    issue_id: issueId,
    thread_id: issue.thread_id
  });
  await publishEvent(userId, "bridge.threadIssues.updated", {
    thread_id: issue.thread_id,
    issues: listThreadIssues(issue.thread_id)
  });
  await publishEvent(userId, "bridge.projectThreads.updated", {
    project_id: issue.project_id,
    threads: listProjectThreads(userId, issue.project_id)
  });

  return {
    accepted: true,
    issues: listThreadIssues(issue.thread_id)
  };
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

  if (
    currentStatus === "staged" &&
    ["queued", "idle"].includes(nextStatus)
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
  await publishEvent(loginId, "bridge.projectThreads.updated", {
    threads: listProjectThreads(loginId)
  });
}

function resolveOwnerFromParams(params = {}) {
  const codexThreadId = params.threadId ?? params.thread?.id ?? params.conversationId ?? params.thread_id;

  if (!codexThreadId) {
    return null;
  }

  const threadId = codexThreadToThreadId.get(codexThreadId);

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
    const codexThreadId = params.thread?.id ?? params.threadId ?? params.conversationId ?? null;
    const threadId = codexThreadId ? codexThreadToThreadId.get(codexThreadId) ?? null : null;

    if (threadId) {
      const eventPatch = buildThreadPatch(method, params);

      if (eventPatch) {
        const current = threadStateById.get(threadId);

        if (current) {
          threadStateById.set(threadId, {
            ...current,
            ...eventPatch,
            updated_at: eventPatch.updated_at ?? now()
          });
        }
      }

      const activeIssueId = activeIssueByThreadId.get(threadId);

      if (activeIssueId) {
        const issuePatch = buildIssuePatch(method, params, activeIssueId);

        if (issuePatch) {
          updateIssueCard(activeIssueId, issuePatch);
        }
      }

      if (method === "item/agentMessage/delta" && params.delta) {
        const activeIssueId = activeIssueByThreadId.get(threadId);

        if (activeIssueId) {
          appendAssistantDeltaToIssue(activeIssueId, params.delta);
        }
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
      const projectId = threadId ? threadStateById.get(threadId)?.project_id ?? "" : "";
      await publishEvent(owner, "bridge.projectThreads.updated", {
        project_id: projectId,
        threads: listProjectThreads(owner, projectId)
      });
      if (threadId) {
        await publishEvent(owner, "bridge.threadIssues.updated", {
          thread_id: threadId,
          issues: listThreadIssues(threadId)
        });
      }
    }

    if (
      method === "turn/completed" ||
      (method === "thread/status/changed" &&
        ["idle", "error", "waitingForInput"].includes(params.status?.type ?? ""))
    ) {
      if (threadId) {
        activeIssueByThreadId.delete(threadId);
        void processIssueQueue(owner, threadId);
      }
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
  const codexThreadId = params.thread?.id ?? params.threadId ?? params.conversationId ?? null;
  const threadId = codexThreadId ? codexThreadToThreadId.get(codexThreadId) ?? null : null;
  const currentStatus = threadId ? threadStateById.get(threadId)?.status ?? "idle" : "idle";

  switch (method) {
    case "thread/started":
      return {
        codex_thread_id: params.thread?.id ?? codexThreadId ?? null,
        progress: Math.max(5, threadStateById.get(threadId)?.progress ?? 0),
        status: currentStatus,
        last_event: "thread.started"
      };
    case "thread/status/changed":
      return {
        status: normalizeThreadStatus(params.status, currentStatus),
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
        last_message: `${threadStateById.get(threadId)?.last_message ?? ""}${params.delta ?? ""}`
      };
    case "turn/completed":
      return {
        status: params.turn?.status === "completed" ? "idle" : "failed",
        progress: params.turn?.status === "completed" ? 100 : 0,
        last_event: "turn.completed"
      };
    default:
      return null;
  }
}

function buildIssuePatch(method, params, issueId) {
  const current = issueCardsById.get(issueId);

  if (!current) {
    return null;
  }

  switch (method) {
    case "turn/started":
      return {
        status: "running",
        progress: Math.max(current.progress ?? 0, 20),
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
        last_message: `${current.last_message ?? ""}${params.delta ?? ""}`
      };
    case "thread/status/changed":
      if ((params.status?.type ?? "") === "waitingForInput") {
        return {
          status: "awaiting_input",
          last_event: "thread.status.changed"
        };
      }

      if ((params.status?.type ?? "") === "error") {
        return {
          status: "failed",
          progress: 0,
          last_event: "thread.status.changed"
        };
      }

      return null;
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
    messages: []
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
    const codexThreadId = threadStateById.get(threadId)?.codex_thread_id;

    if (codexThreadId) {
      codexThreadToThreadId.delete(codexThreadId);
    }

    for (const issueId of getThreadIssueIds(threadId)) {
      issueCardsById.delete(issueId);
      issueMessagesById.delete(issueId);
    }

    threadIssueIdsById.delete(threadId);
    pendingStartQueues.delete(threadId);
    activeIssueByThreadId.delete(threadId);
    deleteThreadState(normalized, threadId);
  }

  state.projects = state.projects.filter((item) => item.id !== projectId);
  if (project.workspace_path) {
    state.deletedWorkspacePaths = [...new Set([...state.deletedWorkspacePaths, project.workspace_path])];
  }
  state.updated_at = now();
  persistUserProjects(normalized, state.projects, state.deletedWorkspacePaths);

  await publishEvent(normalized, "project.deleted", { project_id: projectId });
  await publishEvent(normalized, "bridge.projects.updated", { projects: state.projects });
  await publishEvent(normalized, "bridge.projectThreads.updated", { threads: listProjectThreads(normalized) });

  return {
    accepted: true,
    project_id: projectId,
    projects: state.projects,
    threads: listProjectThreads(normalized)
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
      subject: "octop.user.*.bridge.*.project.threads.get",
      handler: async (userId, body) => ({
        threads: listProjectThreads(userId, String(body.project_id ?? ""))
      })
    },
    {
      subject: "octop.user.*.bridge.*.thread.issues.get",
      handler: async (_userId, body) => ({
        issues: listThreadIssues(String(body.thread_id ?? body.threadId ?? ""))
      })
    },
    {
      subject: "octop.user.*.bridge.*.thread.issue.detail.get",
      handler: (userId, body) => getIssueDetail(userId, body.issue_id ?? body.issueId ?? "")
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

  const projectUpdateSubscription = nc.subscribe("octop.user.*.bridge.*.project.update");

  (async () => {
    for await (const message of projectUpdateSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.login_id ?? body.user_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await updateProject(userId, body);
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

  const projectThreadCreateSubscription = nc.subscribe("octop.user.*.bridge.*.project.thread.create");

  (async () => {
    for await (const message of projectThreadCreateSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await createProjectThread(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const projectThreadDeleteSubscription = nc.subscribe("octop.user.*.bridge.*.project.thread.delete");

  (async () => {
    for await (const message of projectThreadDeleteSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await deleteProjectThread(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const projectThreadUpdateSubscription = nc.subscribe("octop.user.*.bridge.*.project.thread.update");

  (async () => {
    for await (const message of projectThreadUpdateSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await updateProjectThread(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const threadIssueCreateSubscription = nc.subscribe("octop.user.*.bridge.*.thread.issue.create");

  (async () => {
    for await (const message of threadIssueCreateSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await createThreadIssue(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const threadIssueDeleteSubscription = nc.subscribe("octop.user.*.bridge.*.thread.issue.delete");

  (async () => {
    for await (const message of threadIssueDeleteSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await deleteThreadIssue(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const threadIssuesStartSubscription = nc.subscribe("octop.user.*.bridge.*.thread.issues.start");

  (async () => {
    for await (const message of threadIssuesStartSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await startThreadIssues(userId, body);
        await respond(message, result);
      } catch (error) {
        await respond(message, { accepted: false, error: error.message });
      }
    }
  })();

  const threadIssuesReorderSubscription = nc.subscribe("octop.user.*.bridge.*.thread.issues.reorder");

  (async () => {
    for await (const message of threadIssuesReorderSubscription) {
      try {
        const body = parseJson(message.data);
        const userId = sanitizeUserId(body.user_id ?? body.login_id ?? message.subject.split(".")[2]);
        const bridgeId = sanitizeBridgeId(body.bridge_id ?? message.subject.split(".")[4]);

        if (bridgeId !== BRIDGE_ID) {
          continue;
        }

        const result = await reorderThreadIssues(userId, body);
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

        const projectId = String(body.project_id ?? ensureUserState(userId).projects[0]?.id ?? "").trim();
        const threadId = ensureDefaultProjectThread(userId, projectId, "Main");
        const created = await createThreadIssue(userId, {
          ...body,
          thread_id: threadId,
          project_id: projectId
        });
        const started = await startThreadIssues(userId, {
          thread_id: threadId,
          issue_ids: [created.issue.id]
        });
        const result = {
          accepted: true,
          issue: created.issue,
          issues: started.issues
        };
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

  if (request.method === "PATCH" && url.pathname.startsWith("/api/projects/")) {
    try {
      const projectId = url.pathname.split("/").at(-1);
      const payload = await readJsonBody(request);
      const result = await updateProject(userId, {
        ...payload,
        project_id: projectId
      });
      return sendJson(response, 200, result);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "GET" && /^\/api\/projects\/[^/]+\/threads$/.test(url.pathname)) {
    const projectId = url.pathname.split("/")[3];
    return sendJson(response, 200, {
      threads: listProjectThreads(userId, projectId)
    });
  }

  if (request.method === "POST" && /^\/api\/projects\/[^/]+\/threads$/.test(url.pathname)) {
    try {
      const projectId = url.pathname.split("/")[3];
      const body = await readJsonBody(request);
      const payload = await createProjectThread(userId, {
        ...body,
        project_id: projectId
      });
      return sendJson(response, 201, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "PATCH" && /^\/api\/threads\/[^/]+$/.test(url.pathname)) {
    try {
      const threadId = url.pathname.split("/").at(-1);
      const body = await readJsonBody(request);
      const payload = await updateProjectThread(userId, {
        ...body,
        thread_id: threadId
      });
      return sendJson(response, 200, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "DELETE" && /^\/api\/threads\/[^/]+$/.test(url.pathname)) {
    try {
      const threadId = url.pathname.split("/").at(-1);
      const payload = await deleteProjectThread(userId, { thread_id: threadId });
      return sendJson(response, 200, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "GET" && /^\/api\/threads\/[^/]+\/issues$/.test(url.pathname)) {
    const threadId = url.pathname.split("/")[3];
    return sendJson(response, 200, {
      issues: listThreadIssues(threadId)
    });
  }

  if (request.method === "POST" && /^\/api\/threads\/[^/]+\/issues$/.test(url.pathname)) {
    try {
      const threadId = url.pathname.split("/")[3];
      const body = await readJsonBody(request);
      const payload = await createThreadIssue(userId, {
        ...body,
        thread_id: threadId
      });
      return sendJson(response, 201, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "POST" && /^\/api\/threads\/[^/]+\/issues\/start$/.test(url.pathname)) {
    try {
      const threadId = url.pathname.split("/")[3];
      const body = await readJsonBody(request);
      const payload = await startThreadIssues(userId, {
        ...body,
        thread_id: threadId
      });
      return sendJson(response, 202, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "POST" && /^\/api\/threads\/[^/]+\/issues\/reorder$/.test(url.pathname)) {
    try {
      const threadId = url.pathname.split("/")[3];
      const body = await readJsonBody(request);
      const payload = await reorderThreadIssues(userId, {
        ...body,
        thread_id: threadId
      });
      return sendJson(response, 202, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "GET" && /^\/api\/issues\/[^/]+$/.test(url.pathname)) {
    const issueId = url.pathname.split("/").at(-1);
    return sendJson(response, 200, getIssueDetail(userId, issueId));
  }

  if (request.method === "DELETE" && /^\/api\/issues\/[^/]+$/.test(url.pathname)) {
    try {
      const issueId = url.pathname.split("/").at(-1);
      const payload = await deleteThreadIssue(userId, {
        issue_id: issueId
      });
      return sendJson(response, 200, payload);
    } catch (error) {
      return sendJson(response, 400, { accepted: false, error: error.message });
    }
  }

  if (request.method === "POST" && url.pathname === "/api/commands/ping") {
    try {
      const body = await readJsonBody(request);
      const projectId = String(body.project_id ?? ensureUserState(userId).projects[0]?.id ?? "").trim();
      const threadId = ensureDefaultProjectThread(userId, projectId, "Main");
      const created = await createThreadIssue(userId, {
        ...body,
        thread_id: threadId,
        project_id: projectId
      });
      const started = await startThreadIssues(userId, {
        thread_id: threadId,
        issue_ids: [created.issue.id]
      });
      return sendJson(response, 202, {
        accepted: true,
        issue: created.issue,
        issues: started.issues
      });
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }

  return sendJson(response, 404, { error: "Not found" });
}).listen(PORT, HOST, () => {
  console.log(`OctOP bridge listening on http://${HOST}:${PORT}`);
});
