import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import net from "node:net";
import test from "node:test";

const REPO_ROOT = "/Users/jazzlife/Documents/Workspaces/Products/OctOP";
const BRIDGE_ENTRY = join(REPO_ROOT, "services", "codex-adapter", "src", "index.js");
const PROMPT = "현재 워크스페이스 경로";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

async function waitFor(assertion, { timeoutMs = 30000, intervalMs = 200, label = "condition" } = {}) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await assertion();
    } catch (error) {
      lastError = error;
      await sleep(intervalMs);
    }
  }

  throw new Error(`${label} 대기 시간 초과: ${lastError?.message ?? "unknown error"}`);
}

function encodeWebSocketFrame(payload) {
  const body = Buffer.from(payload, "utf8");
  const length = body.length;

  if (length < 126) {
    return Buffer.concat([Buffer.from([0x81, length]), body]);
  }

  if (length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, body]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, body]);
}

function decodeWebSocketFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7f;
    let headerLength = 2;

    if (payloadLength === 126) {
      if (offset + 4 > buffer.length) {
        break;
      }

      payloadLength = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (offset + 10 > buffer.length) {
        break;
      }

      payloadLength = Number(buffer.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }

    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + payloadLength;

    if (offset + frameLength > buffer.length) {
      break;
    }

    if (opcode === 0x8) {
      offset += frameLength;
      continue;
    }

    let payload = buffer.subarray(offset + headerLength + maskLength, offset + frameLength);

    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      const unmasked = Buffer.alloc(payloadLength);

      for (let index = 0; index < payloadLength; index += 1) {
        unmasked[index] = payload[index] ^ mask[index % 4];
      }

      payload = unmasked;
    }

    messages.push(payload.toString("utf8"));
    offset += frameLength;
  }

  return {
    messages,
    rest: buffer.subarray(offset)
  };
}

class FakeAppServer {
  constructor() {
    this.server = null;
    this.socket = null;
    this.sockets = new Set();
    this.bufferBySocket = new Map();
    this.requests = [];
    this.threads = new Map();
    this.threadSequence = 0;
    this.turnSequence = 0;
  }

  async start() {
    const port = await getFreePort();
    this.server = createHttpServer();
    this.server.on("upgrade", (request, socket) => {
      const key = request.headers["sec-websocket-key"];

      if (!key) {
        socket.destroy();
        return;
      }

      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");

      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${accept}`,
          "",
          ""
        ].join("\r\n")
      );

      this.socket = socket;
      this.sockets.add(socket);
      socket.unref();
      this.bufferBySocket.set(socket, Buffer.alloc(0));

      socket.on("data", (chunk) => {
        const previous = this.bufferBySocket.get(socket) ?? Buffer.alloc(0);
        const { messages, rest } = decodeWebSocketFrames(Buffer.concat([previous, chunk]));
        this.bufferBySocket.set(socket, rest);

        for (const message of messages) {
          this.handleMessage(message);
        }
      });

      socket.on("close", () => {
        this.bufferBySocket.delete(socket);
        this.sockets.delete(socket);
        if (this.socket === socket) {
          this.socket = null;
        }
      });

      socket.on("error", () => {});
    });

    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => {
        this.server.off("error", reject);
        this.server.unref();
        resolve();
      });
    });

    this.port = port;
    this.url = `ws://127.0.0.1:${port}`;
    return this.url;
  }

  async stop() {
    for (const socket of this.sockets) {
      socket.destroy();
    }

    this.sockets.clear();
    this.socket = null;

    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;
    server.close();
  }

  send(payload) {
    assert.ok(this.socket, "fake app-server socket이 연결되어야 합니다.");
    this.socket.write(encodeWebSocketFrame(JSON.stringify(payload)));
  }

  notify(method, params) {
    this.send({
      jsonrpc: "2.0",
      method,
      params
    });
  }

  handleMessage(rawMessage) {
    const message = JSON.parse(rawMessage);

    if (!message.id) {
      return;
    }

    this.requests.push({
      id: message.id,
      method: message.method,
      params: message.params
    });

    switch (message.method) {
      case "initialize":
        this.respond(message.id, {});
        return;
      case "account/read":
        this.respond(message.id, {
          account: {
            type: "chatgpt",
            email: "integration@octop.test",
            planType: "pro"
          },
          requiresOpenaiAuth: false,
          rateLimits: null
        });
        return;
      case "thread/start": {
        this.threadSequence += 1;
        const threadId = `codex-thread-${this.threadSequence}`;
        const record = {
          id: threadId,
          createdAt: Math.floor(Date.now() / 1000),
          updatedAt: Math.floor(Date.now() / 1000),
          name: `Fake Thread ${this.threadSequence}`,
          preview: "",
          status: { type: "idle" },
          tokenUsage: null
        };
        this.threads.set(threadId, record);
        this.respond(message.id, {
          thread: {
            id: threadId
          }
        });
        return;
      }
      case "turn/start": {
        this.turnSequence += 1;
        const turnId = `turn-${this.turnSequence}`;
        const threadId = String(message.params?.threadId ?? "").trim();
        const thread = this.threads.get(threadId);

        if (thread) {
          thread.status = { type: "active" };
          thread.updatedAt = Math.floor(Date.now() / 1000);
        }

        this.respond(message.id, {
          turn: {
            id: turnId,
            status: "running"
          }
        });
        return;
      }
      case "turn/interrupt": {
        const threadId = String(message.params?.threadId ?? "").trim();
        const thread = this.threads.get(threadId);

        if (thread) {
          thread.status = { type: "idle" };
          thread.updatedAt = Math.floor(Date.now() / 1000);
        }

        this.respond(message.id, { accepted: true });
        return;
      }
      case "thread/realtime/stop":
        this.respond(message.id, { accepted: true });
        return;
      case "thread/list":
        this.respond(message.id, {
          data: [...this.threads.values()]
        });
        return;
      default:
        this.respond(message.id, {});
    }
  }

  respond(id, result) {
    this.send({
      jsonrpc: "2.0",
      id,
      result
    });
  }

  getRequests(method) {
    return this.requests.filter((entry) => entry.method === method);
  }
}

class BridgeProcess {
  constructor({ port, token, userId, bridgeId, homeDir, appServerUrl }) {
    this.port = port;
    this.token = token;
    this.userId = userId;
    this.bridgeId = bridgeId;
    this.homeDir = homeDir;
    this.appServerUrl = appServerUrl;
    this.stdout = [];
    this.stderr = [];
    this.child = null;
  }

  async start() {
    this.child = spawn(process.execPath, [BRIDGE_ENTRY], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: this.homeDir,
        OCTOP_BRIDGE_HOST: "127.0.0.1",
        OCTOP_BRIDGE_PORT: String(this.port),
        OCTOP_BRIDGE_TOKEN: this.token,
        OCTOP_BRIDGE_ID: this.bridgeId,
        OCTOP_BRIDGE_OWNER_LOGIN_ID: this.userId,
        OCTOP_WORKSPACE_ROOTS: REPO_ROOT,
        OCTOP_APP_SERVER_AUTOSTART: "false",
        OCTOP_APP_SERVER_WS_URL: this.appServerUrl,
        OCTOP_RUNNING_ISSUE_WATCHDOG_INTERVAL_MS: "1000",
        OCTOP_RUNNING_ISSUE_STALE_MS: "10000"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    this.child.stdout.on("data", (chunk) => {
      this.stdout.push(chunk.toString("utf8"));
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr.push(chunk.toString("utf8"));
    });

    await waitFor(async () => {
      const health = await this.request("/health");
      assert.equal(health.ok, true);
      assert.equal(health.status?.app_server?.initialized, true);
      return health;
    }, {
      timeoutMs: 45000,
      intervalMs: 500,
      label: "bridge health"
    });
  }

  async stop() {
    if (!this.child || this.child.exitCode !== null) {
      return;
    }

    const child = this.child;
    const exitPromise = new Promise((resolve) => {
      child.once("exit", resolve);
    });

    child.kill("SIGTERM");
    const exitedBySigterm = await Promise.race([
      exitPromise.then(() => true),
      sleep(5000).then(() => false)
    ]);

    if (exitedBySigterm || child.exitCode !== null) {
      await exitPromise;
      return;
    }

    child.kill("SIGKILL");
    await exitPromise;
  }

  async request(pathname, options = {}) {
    const url = new URL(`http://127.0.0.1:${this.port}${pathname}`);
    url.searchParams.set("user_id", this.userId);

    const response = await fetch(url, {
      ...options,
      headers: {
        "content-type": "application/json",
        "x-bridge-token": this.token,
        ...(options.headers ?? {})
      }
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;

    if (!response.ok) {
      throw new Error(`bridge 요청 실패 ${response.status}: ${JSON.stringify(body)}`);
    }

    return body;
  }

  debugOutput() {
    return {
      stdout: this.stdout.join(""),
      stderr: this.stderr.join("")
    };
  }

  dispose() {
    if (this.child && this.child.exitCode === null) {
      this.child.kill("SIGKILL");
    }
  }
}

async function getWorkspaceProject(bridge) {
  const projectsPayload = await bridge.request("/api/projects");
  const project = projectsPayload.projects.find((item) => item.workspace_path === REPO_ROOT) ?? projectsPayload.projects[0];
  assert.ok(project?.id, "통합 테스트용 프로젝트를 찾지 못했습니다.");
  return project;
}

async function createRunningIssueScenario(bridge, { project, threadName }) {
  const createThreadPayload = await bridge.request(`/api/projects/${project.id}/threads`, {
    method: "POST",
    body: JSON.stringify({
      name: threadName
    })
  });
  const rootThreadId = createThreadPayload.thread.id;

  const issueOnePayload = await bridge.request(`/api/threads/${rootThreadId}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: "Active Issue",
      prompt: PROMPT
    })
  });
  const issueTwoPayload = await bridge.request(`/api/threads/${rootThreadId}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: "Second Issue",
      prompt: PROMPT
    })
  });
  const activeIssueId = issueOnePayload.issue.id;
  const stagedIssueId = issueTwoPayload.issue.id;

  await bridge.request(`/api/threads/${rootThreadId}/issues/start`, {
    method: "POST",
    body: JSON.stringify({
      issue_ids: [activeIssueId]
    })
  });

  await waitFor(async () => {
    const payload = await bridge.request(`/api/issues/${activeIssueId}`);
    assert.equal(payload.issue?.status, "running");
    assert.ok(payload.issue?.executed_physical_thread_id);
    return payload;
  }, {
    label: "issue running"
  });

  const sourceContinuity = await bridge.request(`/api/threads/${rootThreadId}/continuity`);

  return {
    rootThreadId,
    activeIssueId,
    stagedIssueId,
    sourcePhysicalThreadId: sourceContinuity.active_physical_thread.id,
    sourceCodexThreadId: sourceContinuity.active_physical_thread.codex_thread_id
  };
}

async function triggerThresholdRollover(bridge, fakeAppServer, { rootThreadId, sourceCodexThreadId, sourcePhysicalThreadId }) {
  fakeAppServer.notify("thread/tokenUsage/updated", {
    threadId: sourceCodexThreadId,
    tokenUsage: {
      modelContextWindow: 100000,
      total: {
        inputTokens: 86000,
        outputTokens: 1200,
        totalTokens: 87200
      }
    }
  });

  await waitFor(async () => {
    const payload = await bridge.request(`/api/threads/${rootThreadId}/continuity`);
    assert.equal(Number(payload.active_physical_thread?.context_usage_percent ?? 0) >= 85, true);
    return payload;
  }, {
    label: "threshold context usage update"
  });

  const rolloverContinuity = await waitFor(async () => {
    const payload = await bridge.request(`/api/threads/${rootThreadId}/continuity`);
    assert.equal(payload.physical_threads.length, 2);
    assert.equal(payload.handoff_summaries.length, 1);
    assert.notEqual(payload.active_physical_thread.id, sourcePhysicalThreadId);
    assert.equal(payload.recently_closed_physical_threads.some((item) => item.physical_thread_id === sourcePhysicalThreadId), true);
    return payload;
  }, {
    timeoutMs: 45000,
    intervalMs: 300,
    label: "automatic rollover"
  });

  return {
    rolloverContinuity,
    targetPhysicalThreadId: rolloverContinuity.active_physical_thread.id,
    targetCodexThreadId: rolloverContinuity.active_physical_thread.codex_thread_id
  };
}

test("브리지 root thread rollover 통합 검증", { timeout: 120000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-rollover-int-"));
  const fakeAppServer = new FakeAppServer();
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-integration-token",
    userId: "integration-user",
    bridgeId: `integration-bridge-${randomUUID().slice(0, 8)}`,
    homeDir,
    appServerUrl
  });

  t.after(async () => {
    await bridge.stop();
    await fakeAppServer.stop();
    await rm(homeDir, { recursive: true, force: true });
  });

  try {
    await bridge.start();

    const project = await getWorkspaceProject(bridge);
    const {
      rootThreadId,
      activeIssueId,
      stagedIssueId,
      sourcePhysicalThreadId,
      sourceCodexThreadId
    } = await createRunningIssueScenario(bridge, {
      project,
      threadName: "Integration Root Thread"
    });

    let issuesResponse = await bridge.request(`/api/threads/${rootThreadId}/issues`);
    assert.equal(issuesResponse.issues.length, 2);
    assert.equal(issuesResponse.issues.find((issue) => issue.id === activeIssueId)?.created_physical_thread_id !== null, true);
    assert.equal(issuesResponse.issues.find((issue) => issue.id === stagedIssueId)?.status, "staged");
    assert.ok(sourcePhysicalThreadId);
    assert.ok(sourceCodexThreadId);

    const {
      rolloverContinuity,
      targetPhysicalThreadId,
      targetCodexThreadId
    } = await triggerThresholdRollover(bridge, fakeAppServer, {
      rootThreadId,
      sourceCodexThreadId,
      sourcePhysicalThreadId
    });
    assert.ok(targetCodexThreadId);

    issuesResponse = await bridge.request(`/api/threads/${rootThreadId}/issues`);
    assert.equal(issuesResponse.issues.length, 2);
    assert.equal(issuesResponse.issues.find((issue) => issue.id === activeIssueId)?.executed_physical_thread_id, targetPhysicalThreadId);

    const timelineAfterRollover = await bridge.request(`/api/threads/${rootThreadId}/timeline`);
    assert.equal(
      timelineAfterRollover.entries.some((entry) => entry.kind === "handoff_summary" && entry.physical_thread_id === targetPhysicalThreadId),
      true
    );

    const threadStoragePath = resolve(homeDir, ".octop", `${bridge.bridgeId}-threads.json`);
    const persistedBeforeDelete = JSON.parse(await readFile(threadStoragePath, "utf8"));
    const storedUserState = persistedBeforeDelete[bridge.userId];
    assert.equal(storedUserState.project_thread_ids.includes(rootThreadId), true);
    assert.equal(storedUserState.physical_thread_ids.length, 2);
    assert.equal(storedUserState.handoff_summary_ids.length, 1);
    assert.equal(storedUserState.active_issue_ids[rootThreadId], activeIssueId);

    const healthBeforeLateDrop = await bridge.request("/health");
    const lateDropBefore = Number(healthBeforeLateDrop.metrics.late_event_drop_total ?? 0);

    fakeAppServer.notify("item/agentMessage/delta", {
      threadId: sourceCodexThreadId,
      delta: "stale-source-event"
    });

    await waitFor(async () => {
      const health = await bridge.request("/health");
      assert.equal(Number(health.metrics.late_event_drop_total ?? 0), lateDropBefore + 1);
      return health;
    }, {
      label: "closed source late-event drop"
    });

    fakeAppServer.notify("item/agentMessage/delta", {
      threadId: targetCodexThreadId,
      delta: REPO_ROOT
    });
    fakeAppServer.notify("turn/completed", {
      threadId: targetCodexThreadId,
      turn: {
        id: "turn-final",
        status: "completed"
      }
    });
    fakeAppServer.notify("thread/status/changed", {
      threadId: targetCodexThreadId,
      status: {
        type: "idle"
      }
    });

    const completedIssueDetail = await waitFor(async () => {
      const payload = await bridge.request(`/api/issues/${activeIssueId}`);
      assert.equal(payload.issue?.status, "completed");
      assert.equal(
        payload.messages.some((message) => message.kind === "handoff_summary"),
        true
      );
      assert.equal(
        payload.messages.some((message) => message.role === "assistant" && String(message.content ?? "").includes(REPO_ROOT)),
        true
      );
      return payload;
    }, {
      label: "issue completed after rollover"
    });

    assert.equal(completedIssueDetail.issue.executed_physical_thread_id, targetPhysicalThreadId);
    assert.equal(fakeAppServer.getRequests("thread/start").length, 2);
    assert.equal(fakeAppServer.getRequests("turn/start").length, 2);
    assert.equal(fakeAppServer.getRequests("turn/interrupt").length >= 1, true);

    const deletePayload = await bridge.request(`/api/threads/${rootThreadId}`, {
      method: "DELETE"
    });
    assert.equal(deletePayload.accepted, true);
    assert.equal(deletePayload.deleted_physical_thread_count, 2);
    assert.equal(deletePayload.deleted_issue_count, 2);

    const projectThreadsAfterDelete = await bridge.request(`/api/projects/${project.id}/threads`);
    assert.equal(projectThreadsAfterDelete.threads.some((thread) => thread.id === rootThreadId), false);

    const continuityAfterDelete = await bridge.request(`/api/threads/${rootThreadId}/continuity`);
    assert.equal(continuityAfterDelete.root_thread, null);

    fakeAppServer.notify("item/agentMessage/delta", {
      threadId: targetCodexThreadId,
      delta: "stale-after-delete"
    });

    await waitFor(async () => {
      const health = await bridge.request("/health");
      assert.equal(Number(health.metrics.late_event_drop_total ?? 0), lateDropBefore + 2);
      return health;
    }, {
      label: "deleted root late-event drop"
    });

    const issueDetailAfterDelete = await bridge.request(`/api/issues/${activeIssueId}`);
    assert.equal(issueDetailAfterDelete.issue, null);
    assert.deepEqual(issueDetailAfterDelete.messages, []);

    const persistedAfterDelete = JSON.parse(await readFile(threadStoragePath, "utf8"));
    const deletedRootThread = persistedAfterDelete[bridge.userId].project_threads[rootThreadId];
    const storedPhysicalThreads = persistedAfterDelete[bridge.userId].physical_threads;
    assert.ok(deletedRootThread.deleted_at);
    assert.equal(
      Object.values(storedPhysicalThreads).every((physicalThread) => Boolean(physicalThread.deleted_at)),
      true
    );
  } catch (error) {
    error.message = `${error.message}\n\n[bridge stdout]\n${bridge.debugOutput().stdout}\n[bridge stderr]\n${bridge.debugOutput().stderr}`;
    throw error;
  }
});

test("브리지 재시작 후 closed/deleted late event 차단 유지", { timeout: 120000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-rollover-restart-int-"));
  const fakeAppServer = new FakeAppServer();
  const appServerUrl = await fakeAppServer.start();
  const bridgeId = `integration-bridge-${randomUUID().slice(0, 8)}`;
  const token = "octop-restart-integration-token";
  const userId = "integration-user";
  const debugBridges = [];
  let bridge = null;
  let restartedBridge = null;
  let restartedAfterDeleteBridge = null;

  try {
    bridge = new BridgeProcess({
      port: await getFreePort(),
      token,
      userId,
      bridgeId,
      homeDir,
      appServerUrl
    });
    debugBridges.push(bridge);
    await bridge.start();

    const project = await getWorkspaceProject(bridge);
    const scenario = await createRunningIssueScenario(bridge, {
      project,
      threadName: "Restart Validation Thread"
    });
    const rolloverResult = await triggerThresholdRollover(bridge, fakeAppServer, scenario);

    await bridge.stop();

    restartedBridge = new BridgeProcess({
      port: await getFreePort(),
      token,
      userId,
      bridgeId,
      homeDir,
      appServerUrl
    });
    debugBridges.push(restartedBridge);
    await restartedBridge.start();

    await waitFor(async () => {
      const continuity = await restartedBridge.request(`/api/threads/${scenario.rootThreadId}/continuity`);
      assert.equal(continuity.physical_threads.length, 2);
      assert.equal(continuity.active_physical_thread.id, rolloverResult.targetPhysicalThreadId);
      assert.equal(
        continuity.physical_threads.some((item) => item.id === scenario.sourcePhysicalThreadId && Boolean(item.closed_at)),
        true
      );
      return continuity;
    }, {
      label: "restart continuity restore"
    });

    const healthAfterRestart = await restartedBridge.request("/health");
    const lateDropBeforeClosedReplay = Number(healthAfterRestart.metrics.late_event_drop_total ?? 0);

    fakeAppServer.notify("item/agentMessage/delta", {
      threadId: scenario.sourceCodexThreadId,
      delta: "stale-after-restart"
    });

    await waitFor(async () => {
      const health = await restartedBridge.request("/health");
      assert.equal(Number(health.metrics.late_event_drop_total ?? 0), lateDropBeforeClosedReplay + 1);
      return health;
    }, {
      label: "closed source late-event drop after restart"
    });

    const deletePayload = await restartedBridge.request(`/api/threads/${scenario.rootThreadId}`, {
      method: "DELETE"
    });
    assert.equal(deletePayload.accepted, true);

    await restartedBridge.stop();

    restartedAfterDeleteBridge = new BridgeProcess({
      port: await getFreePort(),
      token,
      userId,
      bridgeId,
      homeDir,
      appServerUrl
    });
    debugBridges.push(restartedAfterDeleteBridge);
    await restartedAfterDeleteBridge.start();

    const continuityAfterDeleteRestart = await restartedAfterDeleteBridge.request(`/api/threads/${scenario.rootThreadId}/continuity`);
    assert.equal(continuityAfterDeleteRestart.root_thread, null);

    const healthAfterDeleteRestart = await restartedAfterDeleteBridge.request("/health");
    const lateDropBeforeDeletedReplay = Number(healthAfterDeleteRestart.metrics.late_event_drop_total ?? 0);

    fakeAppServer.notify("item/agentMessage/delta", {
      threadId: rolloverResult.targetCodexThreadId,
      delta: "stale-after-delete-restart"
    });

    await waitFor(async () => {
      const health = await restartedAfterDeleteBridge.request("/health");
      assert.equal(Number(health.metrics.late_event_drop_total ?? 0), lateDropBeforeDeletedReplay + 1);
      return health;
    }, {
      label: "deleted root late-event drop after restart"
    });

    const deletedIssueDetail = await restartedAfterDeleteBridge.request(`/api/issues/${scenario.activeIssueId}`);
    assert.equal(deletedIssueDetail.issue, null);
    assert.deepEqual(deletedIssueDetail.messages, []);
  } catch (error) {
    const debugOutput = debugBridges
      .map((item, index) => {
        const output = item.debugOutput();
        return `[bridge ${index + 1} stdout]\n${output.stdout}\n[bridge ${index + 1} stderr]\n${output.stderr}`;
      })
      .join("\n\n");
    error.message = `${error.message}\n\n${debugOutput}`;
    throw error;
  } finally {
    restartedAfterDeleteBridge?.dispose();
    restartedBridge?.dispose();
    bridge?.dispose();
    void fakeAppServer.stop();
    void rm(homeDir, { recursive: true, force: true });
  }
});
