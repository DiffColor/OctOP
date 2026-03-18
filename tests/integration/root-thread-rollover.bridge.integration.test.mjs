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

function encodeWebSocketFrame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const length = body.length;

  if (length < 126) {
    return Buffer.concat([Buffer.from([0x80 | opcode, length]), body]);
  }

  if (length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, body]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, body]);
}

function decodeWebSocketFrames(buffer) {
  const frames = [];
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

    let payload = buffer.subarray(offset + headerLength + maskLength, offset + frameLength);

    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      const unmasked = Buffer.alloc(payloadLength);

      for (let index = 0; index < payloadLength; index += 1) {
        unmasked[index] = payload[index] ^ mask[index % 4];
      }

      payload = unmasked;
    }

    frames.push({
      opcode,
      payload
    });
    offset += frameLength;
  }

  return {
    frames,
    rest: buffer.subarray(offset)
  };
}

class FakeAppServer {
  constructor(options = {}) {
    this.server = null;
    this.socket = null;
    this.sockets = new Set();
    this.bufferBySocket = new Map();
    this.requests = [];
    this.threads = new Map();
    this.threadSequence = 0;
    this.turnSequence = 0;
    this.options = options;
    this.connectionCount = 0;
    this.pingCount = 0;
    this.threadListRequestCount = 0;
    this.idleTimerBySocket = new Map();
    this.pongTimers = new Set();
    this.noResponseOnceMethods = new Set(
      Array.isArray(options.noResponseOnceMethods) ? options.noResponseOnceMethods : []
    );
    this.zombieAfterMethods = new Set(
      Array.isArray(options.zombieAfterMethods) ? options.zombieAfterMethods : []
    );
    this.zombieSockets = new WeakSet();
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
      this.connectionCount += 1;
      socket.unref();
      this.bufferBySocket.set(socket, Buffer.alloc(0));
      this.resetIdleDisconnectTimer(socket);

      socket.on("data", (chunk) => {
        const previous = this.bufferBySocket.get(socket) ?? Buffer.alloc(0);
        const { frames, rest } = decodeWebSocketFrames(Buffer.concat([previous, chunk]));
        this.bufferBySocket.set(socket, rest);

        for (const frame of frames) {
          this.handleFrame(socket, frame);
        }
      });

      socket.on("close", () => {
        this.bufferBySocket.delete(socket);
        this.sockets.delete(socket);
        const idleTimer = this.idleTimerBySocket.get(socket);
        if (idleTimer) {
          clearTimeout(idleTimer);
          this.idleTimerBySocket.delete(socket);
        }
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

    for (const idleTimer of this.idleTimerBySocket.values()) {
      clearTimeout(idleTimer);
    }

    for (const pongTimer of this.pongTimers) {
      clearTimeout(pongTimer);
    }

    this.pongTimers.clear();
    this.idleTimerBySocket.clear();
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

  destroyActiveSocket() {
    assert.ok(this.socket, "fake app-server socket이 연결되어야 합니다.");
    this.socket.destroy();
  }

  notify(method, params) {
    this.recordNotification(method, params);
    this.send({
      jsonrpc: "2.0",
      method,
      params
    });
  }

  recordNotification(method, params) {
    const threadId = String(params?.threadId ?? params?.thread?.id ?? "").trim();
    const thread = threadId ? this.threads.get(threadId) ?? null : null;

    if (!thread) {
      return;
    }

    thread.updatedAt = Math.floor(Date.now() / 1000);

    switch (method) {
      case "item/agentMessage/delta": {
        const currentTurn = this.getCurrentTurn(threadId);

        if (!currentTurn) {
          return;
        }

        const delta = String(params?.delta ?? "");
        const existingMessageItem = currentTurn.items.find((item) => item.agentMessage);

        if (existingMessageItem?.agentMessage) {
          existingMessageItem.agentMessage.text = `${existingMessageItem.agentMessage.text ?? ""}${delta}`;
          return;
        }

        currentTurn.items.push({
          agentMessage: {
            id: `msg-${randomUUID().slice(0, 8)}`,
            text: delta
          }
        });
        return;
      }
      case "turn/completed": {
        const currentTurn = this.getTurn(threadId, params?.turn?.id) ?? this.getCurrentTurn(threadId);

        if (!currentTurn) {
          return;
        }

        currentTurn.status = params?.turn?.status ?? currentTurn.status;
        if (params?.turn?.error) {
          currentTurn.error = params.turn.error;
        }
        return;
      }
      case "thread/status/changed":
        thread.status = params?.status ?? thread.status;
        return;
      case "thread/tokenUsage/updated":
        thread.tokenUsage = params?.tokenUsage ?? params?.token_usage ?? null;
        return;
      case "turn/started": {
        const currentTurn = this.getTurn(threadId, params?.turn?.id) ?? this.getCurrentTurn(threadId);

        if (currentTurn) {
          currentTurn.status = params?.turn?.status ?? currentTurn.status;
        }
        return;
      }
      default:
        return;
    }
  }

  getTurn(threadId, turnId) {
    const thread = this.threads.get(String(threadId ?? "").trim());

    if (!thread) {
      return null;
    }

    const normalizedTurnId = String(turnId ?? "").trim();

    if (!normalizedTurnId) {
      return null;
    }

    return (thread.turns ?? []).find((turn) => turn.id === normalizedTurnId) ?? null;
  }

  getCurrentTurn(threadId) {
    const thread = this.threads.get(String(threadId ?? "").trim());

    if (!thread) {
      return null;
    }

    return this.getTurn(threadId, thread.currentTurnId) ?? thread.turns?.at(-1) ?? null;
  }

  handleFrame(socket, frame) {
    this.resetIdleDisconnectTimer(socket);

    if (frame.opcode === 0x9) {
      this.pingCount += 1;
      const ignorePongCount = Number(this.options.ignorePongCount ?? 0);

      if (ignorePongCount > 0 && this.pingCount <= ignorePongCount) {
        return;
      }

      const pongDelayMs = Number(this.options.pongDelayMs ?? 0);

      if (pongDelayMs > 0) {
        const timer = setTimeout(() => {
          this.pongTimers.delete(timer);

          if (!socket.destroyed) {
            socket.write(encodeWebSocketFrame(frame.payload, 0xA));
          }
        }, pongDelayMs);

        this.pongTimers.add(timer);
      } else {
        socket.write(encodeWebSocketFrame(frame.payload, 0xA));
      }
      return;
    }

    if (frame.opcode === 0xA || frame.opcode === 0x8) {
      return;
    }

    if (frame.opcode !== 0x1) {
      return;
    }

    this.handleMessage(socket, frame.payload.toString("utf8"));
  }

  handleMessage(socket, rawMessage) {
    const message = JSON.parse(rawMessage);

    if (!message.id) {
      return;
    }

    this.requests.push({
      id: message.id,
      method: message.method,
      params: message.params
    });

    if (this.zombieSockets.has(socket)) {
      return;
    }

    const noResponseMethods = Array.isArray(this.options.noResponseMethods)
      ? this.options.noResponseMethods
      : [];
    const noResponseOnceMethods = this.noResponseOnceMethods;
    const zombieAfterMethods = this.zombieAfterMethods;

    const errorMethods = this.options.errorMethods && typeof this.options.errorMethods === "object"
      ? this.options.errorMethods
      : null;
    const errorOnceMethods = this.options.errorOnceMethods && typeof this.options.errorOnceMethods === "object"
      ? this.options.errorOnceMethods
      : null;

    if (noResponseMethods.includes(message.method)) {
      return;
    }

    if (noResponseOnceMethods.has(message.method)) {
      noResponseOnceMethods.delete(message.method);
      return;
    }

    if (zombieAfterMethods.has(message.method)) {
      zombieAfterMethods.delete(message.method);
      this.zombieSockets.add(socket);
      return;
    }

    if (errorOnceMethods && errorOnceMethods[message.method]) {
      const errorMessage = String(errorOnceMethods[message.method]);
      delete errorOnceMethods[message.method];
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: errorMessage
        }
      });
      return;
    }

    if (errorMethods && errorMethods[message.method]) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: String(errorMethods[message.method])
        }
      });
      return;
    }

    switch (message.method) {
      case "initialize":
        this.respond(message.id, {});
        return;
      case "account/read":
        this.respond(
          message.id,
          this.options.accountReadResult ?? {
            account: {
              type: "chatgpt",
              email: "integration@octop.test",
              planType: "pro"
            },
            requiresOpenaiAuth: false,
            rateLimits: null
          }
        );
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
          tokenUsage: null,
          turns: [],
          currentTurnId: null
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
          thread.currentTurnId = turnId;
          thread.turns.push({
            id: turnId,
            status: "inProgress",
            items: []
          });
        }

        this.respond(message.id, {
          turn: {
            id: turnId,
            status: "running"
          }
        });

        if (typeof this.options.onTurnStart === "function") {
          queueMicrotask(() => {
            this.options.onTurnStart({
              server: this,
              message,
              threadId,
              thread,
              turnId
            });
          });
        }
        return;
      }
      case "turn/interrupt": {
        const threadId = String(message.params?.threadId ?? "").trim();
        const thread = this.threads.get(threadId);

        if (thread) {
          thread.status = { type: "idle" };
          thread.updatedAt = Math.floor(Date.now() / 1000);
          const currentTurn = this.getCurrentTurn(threadId);
          if (currentTurn) {
            currentTurn.status = "interrupted";
          }
        }

        this.respond(message.id, { accepted: true });
        return;
      }
      case "thread/realtime/stop":
        this.respond(message.id, { accepted: true });
        return;
      case "thread/list":
        this.threadListRequestCount += 1;
        {
          const allThreads = [...this.threads.values()];
          const threadListOmitCount = Number(this.options.threadListOmitCount ?? 0);
          const threadListOmitRequestNumbers = Array.isArray(this.options.threadListOmitRequestNumbers)
            ? this.options.threadListOmitRequestNumbers.map((value) => Number(value)).filter(Number.isFinite)
            : [];
          const shouldOmitForRequestNumber = threadListOmitRequestNumbers.includes(this.threadListRequestCount);
          const data =
            shouldOmitForRequestNumber || (threadListOmitCount > 0 && this.threadListRequestCount <= threadListOmitCount)
              ? []
              : allThreads;
        this.respond(message.id, {
            data
        });
        }
        return;
      case "thread/read": {
        const threadId = String(message.params?.threadId ?? "").trim();
        const thread = this.threads.get(threadId) ?? null;
        this.respond(message.id, {
          thread: thread
            ? {
                ...thread,
                turns: message.params?.includeTurns ? thread.turns ?? [] : []
              }
            : null
        });
        return;
      }
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

  resetIdleDisconnectTimer(socket) {
    const timeoutMs = Number(this.options.idleDisconnectAfterMs ?? 0);
    const previousTimer = this.idleTimerBySocket.get(socket);

    if (previousTimer) {
      clearTimeout(previousTimer);
      this.idleTimerBySocket.delete(socket);
    }

    if (timeoutMs <= 0) {
      return;
    }

    const timer = setTimeout(() => {
      if (this.sockets.has(socket)) {
        socket.destroy();
      }
    }, timeoutMs);

    timer.unref?.();
    this.idleTimerBySocket.set(socket, timer);
  }
}

class BridgeProcess {
  constructor({ port, token, userId, bridgeId, homeDir, appServerUrl, extraEnv = {} }) {
    this.port = port;
    this.token = token;
    this.userId = userId;
    this.bridgeId = bridgeId;
    this.homeDir = homeDir;
    this.appServerUrl = appServerUrl;
    this.extraEnv = extraEnv;
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
        OCTOP_RUNNING_ISSUE_STALE_MS: "10000",
        ...this.extraEnv
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

async function markThreadContextHigh(bridge, fakeAppServer, { rootThreadId, sourceCodexThreadId }) {
  fakeAppServer.notify("thread/tokenUsage/updated", {
    threadId: sourceCodexThreadId,
    tokenUsage: {
      modelContextWindow: 100000,
      last: {
        inputTokens: 86000,
        outputTokens: 1200,
        totalTokens: 87200
      },
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
    assert.equal(payload.active_physical_thread?.context_used_tokens, 86000);
    assert.equal(payload.active_physical_thread?.context_usage_percent, 86);
    assert.equal(payload.physical_threads.length, 1);
    return payload;
  }, {
    label: "threshold context usage update"
  });
}

function completeIssueOnThread(fakeAppServer, { codexThreadId, delta = REPO_ROOT, turnId = `turn-${randomUUID().slice(0, 8)}` }) {
  fakeAppServer.notify("item/agentMessage/delta", {
    threadId: codexThreadId,
    delta
  });
  fakeAppServer.notify("turn/completed", {
    threadId: codexThreadId,
    turn: {
      id: turnId,
      status: "completed"
    }
  });
  fakeAppServer.notify("thread/status/changed", {
    threadId: codexThreadId,
    status: {
      type: "idle"
    }
  });
}

async function triggerPreflightThresholdRollover(
  bridge,
  fakeAppServer,
  { rootThreadId, sourceCodexThreadId, sourcePhysicalThreadId, nextIssueId }
) {
  await markThreadContextHigh(bridge, fakeAppServer, {
    rootThreadId,
    sourceCodexThreadId
  });

  await sleep(750);
  const continuityBeforeRollover = await bridge.request(`/api/threads/${rootThreadId}/continuity`);
  assert.equal(continuityBeforeRollover.physical_threads.length, 1);
  assert.equal(continuityBeforeRollover.active_physical_thread?.id, sourcePhysicalThreadId);

  completeIssueOnThread(fakeAppServer, {
    codexThreadId: sourceCodexThreadId,
    turnId: "turn-source-final"
  });

  if (nextIssueId) {
    await bridge.request(`/api/threads/${rootThreadId}/issues/start`, {
      method: "POST",
      body: JSON.stringify({
        issue_ids: [nextIssueId]
      })
    });
  }

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

test("브리지 app-server idle websocket heartbeat 유지", { timeout: 60000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-heartbeat-int-"));
  const fakeAppServer = new FakeAppServer({
    idleDisconnectAfterMs: 1200,
    pongDelayMs: 800
  });
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-heartbeat-token",
    userId: "heartbeat-user",
    bridgeId: `heartbeat-bridge-${randomUUID().slice(0, 8)}`,
    homeDir,
    appServerUrl,
    extraEnv: {
      OCTOP_APP_SERVER_HEARTBEAT_INTERVAL_MS: "250",
      OCTOP_APP_SERVER_HEARTBEAT_TIMEOUT_MS: "1000",
      OCTOP_APP_SERVER_RECONNECT_DELAY_MS: "250"
    }
  });

  t.after(async () => {
    await bridge.stop();
    await fakeAppServer.stop();
    await rm(homeDir, { recursive: true, force: true });
  });

  await bridge.start();
  await sleep(3000);

  const health = await bridge.request("/health");
  assert.equal(health.ok, true);
  assert.equal(health.status?.app_server?.initialized, true);
  assert.equal(fakeAppServer.connectionCount >= 1, true);
  assert.equal(fakeAppServer.pingCount >= 2, true);
  assert.equal(fakeAppServer.getRequests("thread/list").length, 0);
});

test("브리지 app-server 느린 pong에도 timeout으로 연결을 강제 종료하지 않는다", { timeout: 60000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-heartbeat-timeout-int-"));
  const fakeAppServer = new FakeAppServer({
    pongDelayMs: 1500
  });
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-heartbeat-timeout-token",
    userId: "heartbeat-timeout-user",
    bridgeId: `heartbeat-timeout-bridge-${randomUUID().slice(0, 8)}`,
    homeDir,
    appServerUrl,
    extraEnv: {
      OCTOP_APP_SERVER_HEARTBEAT_INTERVAL_MS: "250",
      OCTOP_APP_SERVER_HEARTBEAT_TIMEOUT_MS: "500",
      OCTOP_APP_SERVER_RECONNECT_DELAY_MS: "250"
    }
  });

  t.after(async () => {
    await bridge.stop();
    await fakeAppServer.stop();
    await rm(homeDir, { recursive: true, force: true });
  });

  await bridge.start();
  await sleep(2500);

  const health = await bridge.request("/health");
  assert.equal(health.ok, true);
  assert.equal(health.status?.app_server?.initialized, true);
  assert.equal(fakeAppServer.connectionCount, 1);
  assert.equal(fakeAppServer.pingCount >= 1, true);
  assert.equal(fakeAppServer.getRequests("thread/list").length >= 1, true);
});

test("브리지 app-server running issue 동안에도 heartbeat ping을 유지한다", { timeout: 60000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-running-heartbeat-int-"));
  const fakeAppServer = new FakeAppServer();
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-running-heartbeat-token",
    userId: "running-heartbeat-user",
    bridgeId: `running-heartbeat-bridge-${randomUUID().slice(0, 8)}`,
    homeDir,
    appServerUrl,
    extraEnv: {
      OCTOP_APP_SERVER_HEARTBEAT_INTERVAL_MS: "250",
      OCTOP_APP_SERVER_HEARTBEAT_TIMEOUT_MS: "500",
      OCTOP_APP_SERVER_RECONNECT_DELAY_MS: "250"
    }
  });

  t.after(async () => {
    await bridge.stop();
    await fakeAppServer.stop();
    await rm(homeDir, { recursive: true, force: true });
  });

  await bridge.start();
  const project = await getWorkspaceProject(bridge);
  const scenario = await createRunningIssueScenario(bridge, {
    project,
    threadName: "Running heartbeat suppression"
  });
  const pingCountBefore = fakeAppServer.pingCount;

  await sleep(1500);

  const health = await bridge.request("/health");
  const issueDetail = await bridge.request(`/api/issues/${scenario.activeIssueId}`);
  assert.equal(health.ok, true);
  assert.equal(health.status?.app_server?.initialized, true);
  assert.equal(issueDetail.issue?.status, "running");
  assert.equal(fakeAppServer.pingCount > pingCountBefore, true);
});

test("브리지 app-server running issue heartbeat 연속 timeout 시 강제 재연결한다", { timeout: 90000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-running-heartbeat-reconnect-int-"));
  const fakeAppServer = new FakeAppServer({
    ignorePongCount: 4
  });
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-running-heartbeat-reconnect-token",
    userId: "running-heartbeat-reconnect-user",
    bridgeId: `running-heartbeat-reconnect-${randomUUID().slice(0, 8)}`,
    homeDir,
    appServerUrl,
    extraEnv: {
      OCTOP_APP_SERVER_HEARTBEAT_INTERVAL_MS: "250",
      OCTOP_APP_SERVER_HEARTBEAT_TIMEOUT_MS: "500",
      OCTOP_APP_SERVER_RECONNECT_DELAY_MS: "250",
      OCTOP_APP_SERVER_ACTIVE_HEARTBEAT_FORCE_RECONNECT_MISSES: "2"
    }
  });

  t.after(async () => {
    await bridge.stop();
    await fakeAppServer.stop();
    await rm(homeDir, { recursive: true, force: true });
  });

  await bridge.start();
  const project = await getWorkspaceProject(bridge);
  const scenario = await createRunningIssueScenario(bridge, {
    project,
    threadName: "Running heartbeat reconnect"
  });

  await waitFor(async () => {
    assert.equal(fakeAppServer.getRequests("thread/list").length >= 1, true);
    assert.equal(fakeAppServer.connectionCount >= 2, true);
  }, {
    timeoutMs: 20000,
    intervalMs: 250,
    label: "running heartbeat forced reconnect"
  });

  const issueDetail = await bridge.request(`/api/issues/${scenario.activeIssueId}`);
  const health = await bridge.request("/health");
  assert.equal(health.ok, true);
  assert.equal(health.status?.app_server?.initialized, true);
  assert.equal(issueDetail.issue?.status, "running");
});

test("브리지 app-server 1006 close 후 자동 재연결", { timeout: 60000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-reconnect-int-"));
  const fakeAppServer = new FakeAppServer();
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-reconnect-token",
    userId: "reconnect-user",
    bridgeId: `reconnect-bridge-${randomUUID().slice(0, 8)}`,
    homeDir,
    appServerUrl,
    extraEnv: {
      OCTOP_APP_SERVER_HEARTBEAT_INTERVAL_MS: "250",
      OCTOP_APP_SERVER_HEARTBEAT_TIMEOUT_MS: "1000",
      OCTOP_APP_SERVER_RECONNECT_DELAY_MS: "250"
    }
  });

  t.after(async () => {
    await bridge.stop();
    await fakeAppServer.stop();
    await rm(homeDir, { recursive: true, force: true });
  });

  await bridge.start();
  assert.equal(fakeAppServer.connectionCount, 1);

  fakeAppServer.destroyActiveSocket();

  await waitFor(async () => {
    assert.equal(fakeAppServer.connectionCount >= 2, true);
    assert.equal(fakeAppServer.getRequests("initialize").length >= 2, true);
  }, {
    timeoutMs: 15000,
    intervalMs: 250,
    label: "app-server auto reconnect"
  });

  const health = await bridge.request("/health");
  assert.equal(health.ok, true);
  assert.equal(health.status?.app_server?.initialized, true);
});

test("브리지 app-server reconnect 후 thread/read로 누락된 출력과 완료 상태를 복구한다", { timeout: 90000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-backfill-int-"));
  const fakeAppServer = new FakeAppServer();
  let reconnectScenario = null;
  fakeAppServer.options.onTurnStart = ({ server, threadId, turnId }) => {
    reconnectScenario = { threadId, turnId };
    server.notify("item/agentMessage/delta", {
      threadId,
      delta: "첫 문장"
    });
    setTimeout(() => {
      server.destroyActiveSocket();
    }, 150);
    setTimeout(() => {
      server.recordNotification("item/agentMessage/delta", {
        threadId,
        delta: " 이후 복구된 문장"
      });
      server.recordNotification("turn/completed", {
        threadId,
        turn: {
          id: turnId,
          status: "completed"
        }
      });
      server.recordNotification("thread/status/changed", {
        threadId,
        status: {
          type: "idle"
        }
      });
    }, 1200);
  };
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-backfill-token",
    userId: "backfill-user",
    bridgeId: `backfill-bridge-${randomUUID().slice(0, 8)}`,
    homeDir,
    appServerUrl,
    extraEnv: {
      OCTOP_APP_SERVER_HEARTBEAT_INTERVAL_MS: "250",
      OCTOP_APP_SERVER_HEARTBEAT_TIMEOUT_MS: "1000",
      OCTOP_APP_SERVER_RECONNECT_DELAY_MS: "200",
      OCTOP_RUNNING_ISSUE_BACKFILL_INTERVAL_MS: "300"
    }
  });

  t.after(async () => {
    await bridge.stop();
    await fakeAppServer.stop();
    await rm(homeDir, { recursive: true, force: true });
  });

  await bridge.start();
  const project = await getWorkspaceProject(bridge);
  const scenario = await createRunningIssueScenario(bridge, {
    project,
    threadName: "Reconnect Backfill Thread"
  });

  await waitFor(async () => {
    assert.ok(reconnectScenario?.threadId);
    assert.ok(reconnectScenario?.turnId);
  }, {
    timeoutMs: 10000,
    intervalMs: 100,
    label: "backfill scenario start"
  });

  const issueDetail = await waitFor(async () => {
    const payload = await bridge.request(`/api/issues/${scenario.activeIssueId}`);
    const assistantMessages = payload.messages.filter((message) => message.role === "assistant");
    assert.equal(payload.issue?.status, "completed");
    assert.equal(assistantMessages.length >= 1, true);
    assert.equal(assistantMessages.at(-1)?.content, "첫 문장 이후 복구된 문장");
    return payload;
  }, {
    timeoutMs: 30000,
    intervalMs: 300,
    label: "backfilled issue completion"
  });

  assert.equal(issueDetail.issue?.last_event, "turn.completed");
  assert.equal(fakeAppServer.connectionCount >= 2, true);
});

test("app-server RPC timeout zombie 상태에서도 강제 reconnect 후 backfill로 메시지와 상태를 복구한다", { timeout: 90000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-timeout-backfill-int-"));
  const fakeAppServer = new FakeAppServer({
    zombieAfterMethods: ["thread/list"]
  });
  fakeAppServer.options.onTurnStart = ({ server, threadId, turnId }) => {
    server.notify("item/agentMessage/delta", {
      threadId,
      delta: "첫 문장"
    });
    setTimeout(() => {
      server.recordNotification("thread/tokenUsage/updated", {
        threadId,
        tokenUsage: {
          modelContextWindow: 100000,
          last: {
            inputTokens: 86000,
            outputTokens: 1200,
            totalTokens: 87200
          },
          total: {
            inputTokens: 86000,
            outputTokens: 1200,
            totalTokens: 87200
          }
        }
      });
      server.recordNotification("item/agentMessage/delta", {
        threadId,
        delta: " 이후 복구된 문장"
      });
      server.recordNotification("turn/completed", {
        threadId,
        turn: {
          id: turnId,
          status: "completed"
        }
      });
      server.recordNotification("thread/status/changed", {
        threadId,
        status: {
          type: "idle"
        }
      });
    }, 900);
  };
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-timeout-backfill-token",
    userId: "timeout-backfill-user",
    bridgeId: `timeout-backfill-bridge-${randomUUID().slice(0, 8)}`,
    homeDir,
    appServerUrl,
    extraEnv: {
      OCTOP_APP_SERVER_REQUEST_TIMEOUT_MS: "500",
      OCTOP_APP_SERVER_RECONNECT_DELAY_MS: "200",
      OCTOP_RUNNING_ISSUE_WATCHDOG_INTERVAL_MS: "200",
      OCTOP_RUNNING_ISSUE_STALE_MS: "600",
      OCTOP_RUNNING_ISSUE_BACKFILL_INTERVAL_MS: "200"
    }
  });

  t.after(async () => {
    await bridge.stop();
    await fakeAppServer.stop();
    await rm(homeDir, { recursive: true, force: true });
  });

  await bridge.start();
  const project = await getWorkspaceProject(bridge);
  const scenario = await createRunningIssueScenario(bridge, {
    project,
    threadName: "RPC timeout backfill thread"
  });

  const issueDetail = await waitFor(async () => {
    const payload = await bridge.request(`/api/issues/${scenario.activeIssueId}`);
    const assistantMessages = payload.messages.filter((message) => message.role === "assistant");
    assert.equal(payload.issue?.status, "completed");
    assert.equal(assistantMessages.at(-1)?.content, "첫 문장 이후 복구된 문장");
    return payload;
  }, {
    timeoutMs: 30000,
    intervalMs: 300,
    label: "timeout backfill completion"
  });

  const continuity = await waitFor(async () => {
    const payload = await bridge.request(`/api/threads/${scenario.rootThreadId}/continuity`);
    assert.equal(payload.active_physical_thread?.context_used_tokens, 86000);
    assert.equal(payload.active_physical_thread?.context_usage_percent, 86);
    return payload;
  }, {
    timeoutMs: 30000,
    intervalMs: 300,
    label: "timeout backfill token usage sync"
  });

  assert.equal(issueDetail.issue?.last_event, "turn.completed");
  assert.equal(continuity.root_thread?.continuity_status, "healthy");
  assert.equal(fakeAppServer.getRequests("thread/read").length >= 1, true);
  assert.equal(fakeAppServer.connectionCount >= 2, true);
});

test("실패한 issue 이후 다음 issue는 새 codex thread로 이어서 실행된다", { timeout: 120000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-failed-issue-recovery-int-"));
  const fakeAppServer = new FakeAppServer();
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-failed-issue-recovery-token",
    userId: "integration-user",
    bridgeId: `failed-issue-bridge-${randomUUID().slice(0, 8)}`,
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
      sourceCodexThreadId
    } = await createRunningIssueScenario(bridge, {
      project,
      threadName: "Failed Issue Recovery Thread"
    });

    await bridge.request(`/api/threads/${rootThreadId}/issues/start`, {
      method: "POST",
      body: JSON.stringify({
        issue_ids: [stagedIssueId]
      })
    });

    fakeAppServer.notify("thread/status/changed", {
      threadId: sourceCodexThreadId,
      status: {
        type: "error"
      }
    });

    const recoveryContinuity = await waitFor(async () => {
      const issueDetail = await bridge.request(`/api/issues/${stagedIssueId}`);
      const failedIssueDetail = await bridge.request(`/api/issues/${activeIssueId}`);
      const continuity = await bridge.request(`/api/threads/${rootThreadId}/continuity`);

      assert.equal(failedIssueDetail.issue?.status, "failed");
      assert.equal(issueDetail.issue?.status, "running");
      assert.ok(continuity.active_physical_thread?.codex_thread_id);
      assert.notEqual(continuity.active_physical_thread.codex_thread_id, sourceCodexThreadId);
      return continuity;
    }, {
      timeoutMs: 45000,
      intervalMs: 300,
      label: "failed issue recovery"
    });

    assert.equal(fakeAppServer.getRequests("thread/start").length, 2);
    assert.equal(fakeAppServer.getRequests("turn/start").length, 2);

    completeIssueOnThread(fakeAppServer, {
      codexThreadId: recoveryContinuity.active_physical_thread.codex_thread_id,
      turnId: "turn-recovered-completed"
    });

    await waitFor(async () => {
      const payload = await bridge.request(`/api/issues/${stagedIssueId}`);
      assert.equal(payload.issue?.status, "completed");
      return payload;
    }, {
      timeoutMs: 45000,
      intervalMs: 300,
      label: "recovered issue completed"
    });
  } catch (error) {
    error.message = `${error.message}\n\n[bridge stdout]\n${bridge.debugOutput().stdout}\n[bridge stderr]\n${bridge.debugOutput().stderr}`;
    throw error;
  }
});

test("thread/list 누락이 반복되어도 stale running issue는 degraded로 유지되며 후속 이벤트 추적을 잃지 않는다", { timeout: 120000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-missing-remote-thread-int-"));
  const fakeAppServer = new FakeAppServer({
    threadListOmitCount: 4
  });
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-missing-remote-thread-token",
    userId: "integration-user",
    bridgeId: `missing-remote-thread-bridge-${randomUUID().slice(0, 8)}`,
    homeDir,
    appServerUrl,
    extraEnv: {
      OCTOP_RUNNING_ISSUE_WATCHDOG_INTERVAL_MS: "200",
      OCTOP_RUNNING_ISSUE_STALE_MS: "600",
      OCTOP_RUNNING_ISSUE_MISSING_REMOTE_RETRY_COUNT: "2"
    }
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
      sourceCodexThreadId
    } = await createRunningIssueScenario(bridge, {
      project,
      threadName: "Missing Remote Thread Reconcile Thread"
    });

    await waitFor(async () => {
      const issueDetail = await bridge.request(`/api/issues/${activeIssueId}`);
      const continuity = await bridge.request(`/api/threads/${rootThreadId}/continuity`);
      const health = await bridge.request("/health");

      assert.equal(issueDetail.issue?.status, "running");
      assert.equal(issueDetail.issue?.last_event, "watchdog.degraded");
      assert.equal(continuity.root_thread?.continuity_status, "degraded");
      assert.equal(continuity.active_physical_thread?.codex_thread_id, sourceCodexThreadId);
      assert.equal(continuity.active_physical_thread?.status, "active");
      assert.notEqual(continuity.active_physical_thread?.turn_id ?? null, null);
      assert.equal(health.status?.app_server?.initialized, true);
      assert.equal(health.status?.app_server?.idle, false);
      return { issueDetail, continuity, health };
    }, {
      timeoutMs: 5000,
      intervalMs: 250,
      label: "running issue degraded after missing remote thread"
    });

    completeIssueOnThread(fakeAppServer, {
      codexThreadId: sourceCodexThreadId,
      turnId: "turn-missing-remote-thread-completed"
    });

    await waitFor(async () => {
      const payload = await bridge.request(`/api/issues/${activeIssueId}`);
      const continuity = await bridge.request(`/api/threads/${rootThreadId}/continuity`);
      assert.equal(payload.issue?.status, "completed");
      assert.equal(payload.issue?.last_event, "turn.completed");
      assert.equal(continuity.root_thread?.continuity_status, "healthy");
      return payload;
    }, {
      timeoutMs: 45000,
      intervalMs: 300,
      label: "issue keeps tracking after degraded state"
    });
  } catch (error) {
    error.message = `${error.message}\n\n[bridge stdout]\n${bridge.debugOutput().stdout}\n[bridge stderr]\n${bridge.debugOutput().stderr}`;
    throw error;
  }
});

test("stale degraded thread가 있어도 다른 thread issue는 바로 실행된다", { timeout: 120000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-degraded-thread-does-not-block-int-"));
  const fakeAppServer = new FakeAppServer({
    threadListOmitCount: 4
  });
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-degraded-thread-does-not-block-token",
    userId: "integration-user",
    bridgeId: `degraded-thread-does-not-block-bridge-${randomUUID().slice(0, 8)}`,
    homeDir,
    appServerUrl,
    extraEnv: {
      OCTOP_RUNNING_ISSUE_WATCHDOG_INTERVAL_MS: "200",
      OCTOP_RUNNING_ISSUE_STALE_MS: "600",
      OCTOP_RUNNING_ISSUE_MISSING_REMOTE_RETRY_COUNT: "2"
    }
  });

  t.after(async () => {
    await bridge.stop();
    await fakeAppServer.stop();
    await rm(homeDir, { recursive: true, force: true });
  });

  try {
    await bridge.start();

    const project = await getWorkspaceProject(bridge);
    const staleScenario = await createRunningIssueScenario(bridge, {
      project,
      threadName: "Degraded Source Thread"
    });

    await waitFor(async () => {
      const issueDetail = await bridge.request(`/api/issues/${staleScenario.activeIssueId}`);
      const health = await bridge.request("/health");
      assert.equal(issueDetail.issue?.last_event, "watchdog.degraded");
      assert.equal(issueDetail.issue?.status, "running");
      assert.equal(health.status?.app_server?.idle, false);
      return { issueDetail, health };
    }, {
      timeoutMs: 5000,
      intervalMs: 250,
      label: "source thread degraded"
    });

    const createdThread = await bridge.request(`/api/projects/${project.id}/threads`, {
      method: "POST",
      body: JSON.stringify({
        name: "Follower Running Thread"
      })
    });
    const nextThreadId = createdThread.thread.id;
    const createdIssue = await bridge.request(`/api/threads/${nextThreadId}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: "Follower Running Issue",
        prompt: PROMPT
      })
    });
    const nextIssueId = createdIssue.issue.id;

    await bridge.request(`/api/threads/${nextThreadId}/issues/start`, {
      method: "POST",
      body: JSON.stringify({
        issue_ids: [nextIssueId]
      })
    });

    await waitFor(async () => {
      const issueDetail = await bridge.request(`/api/issues/${nextIssueId}`);
      const health = await bridge.request("/health");
      assert.equal(issueDetail.issue?.status, "running");
      assert.equal(fakeAppServer.getRequests("turn/start").length, 2);
      assert.equal(health.status?.app_server?.idle, false);
      return { issueDetail, health };
    }, {
      timeoutMs: 15000,
      intervalMs: 250,
      label: "other thread keeps running while degraded thread exists"
    });
  } catch (error) {
    error.message = `${error.message}\n\n[bridge stdout]\n${bridge.debugOutput().stdout}\n[bridge stderr]\n${bridge.debugOutput().stderr}`;
    throw error;
  }
});

test("degraded thread는 후속 정상 이벤트를 받으면 continuity를 자동 회복한다", { timeout: 120000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-degraded-auto-recover-int-"));
  const fakeAppServer = new FakeAppServer({
    threadListOmitCount: 4
  });
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-degraded-auto-recover-token",
    userId: "integration-user",
    bridgeId: `degraded-auto-recover-bridge-${randomUUID().slice(0, 8)}`,
    homeDir,
    appServerUrl,
    extraEnv: {
      OCTOP_RUNNING_ISSUE_WATCHDOG_INTERVAL_MS: "200",
      OCTOP_RUNNING_ISSUE_STALE_MS: "600",
      OCTOP_RUNNING_ISSUE_MISSING_REMOTE_RETRY_COUNT: "2"
    }
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
      sourceCodexThreadId
    } = await createRunningIssueScenario(bridge, {
      project,
      threadName: "Degraded Auto Recover Thread"
    });

    await waitFor(async () => {
      const issueDetail = await bridge.request(`/api/issues/${activeIssueId}`);
      const continuity = await bridge.request(`/api/threads/${rootThreadId}/continuity`);
      assert.equal(issueDetail.issue?.last_event, "watchdog.degraded");
      assert.equal(continuity.root_thread?.continuity_status, "degraded");
      return { issueDetail, continuity };
    }, {
      timeoutMs: 5000,
      intervalMs: 250,
      label: "thread enters degraded continuity"
    });

    fakeAppServer.notify("turn/plan/updated", {
      threadId: sourceCodexThreadId
    });

    await waitFor(async () => {
      const issueDetail = await bridge.request(`/api/issues/${activeIssueId}`);
      const continuity = await bridge.request(`/api/threads/${rootThreadId}/continuity`);
      assert.equal(issueDetail.issue?.status, "running");
      assert.equal(issueDetail.issue?.last_event, "turn.plan.updated");
      assert.equal(continuity.root_thread?.continuity_status, "healthy");
      assert.equal(continuity.root_thread?.last_event, "turn.plan.updated");
      return { issueDetail, continuity };
    }, {
      timeoutMs: 10000,
      intervalMs: 250,
      label: "degraded continuity auto recovery"
    });

    completeIssueOnThread(fakeAppServer, {
      codexThreadId: sourceCodexThreadId,
      turnId: "turn-degraded-auto-recover-completed"
    });

    await waitFor(async () => {
      const payload = await bridge.request(`/api/issues/${activeIssueId}`);
      const continuity = await bridge.request(`/api/threads/${rootThreadId}/continuity`);
      assert.equal(payload.issue?.status, "completed");
      assert.equal(continuity.root_thread?.continuity_status, "healthy");
      return { payload, continuity };
    }, {
      timeoutMs: 45000,
      intervalMs: 300,
      label: "recovered degraded issue completion"
    });
  } catch (error) {
    error.message = `${error.message}\n\n[bridge stdout]\n${bridge.debugOutput().stdout}\n[bridge stderr]\n${bridge.debugOutput().stderr}`;
    throw error;
  }
});

test("긴 응답 공백 중 thread/list가 한 번 비어도 running issue를 중단하지 않는다", { timeout: 120000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-long-gap-running-int-"));
  const fakeAppServer = new FakeAppServer({
    threadListOmitRequestNumbers: [2]
  });
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-long-gap-running-token",
    userId: "integration-user",
    bridgeId: `long-gap-running-bridge-${randomUUID().slice(0, 8)}`,
    homeDir,
    appServerUrl,
    extraEnv: {
      OCTOP_RUNNING_ISSUE_WATCHDOG_INTERVAL_MS: "200",
      OCTOP_RUNNING_ISSUE_STALE_MS: "600",
      OCTOP_RUNNING_ISSUE_MISSING_REMOTE_RETRY_COUNT: "2"
    }
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
      sourceCodexThreadId
    } = await createRunningIssueScenario(bridge, {
      project,
      threadName: "Long Gap Running Thread"
    });

    await waitFor(async () => {
      assert.equal(fakeAppServer.getRequests("thread/list").length >= 3, true);
      const issueDetail = await bridge.request(`/api/issues/${activeIssueId}`);
      const continuity = await bridge.request(`/api/threads/${rootThreadId}/continuity`);
      const health = await bridge.request("/health");

      assert.equal(issueDetail.issue?.status, "running");
      assert.equal(["healthy", "degraded"].includes(continuity.root_thread?.continuity_status), true);
      assert.equal(health.status?.app_server?.idle, false);
      return { issueDetail, continuity, health };
    }, {
      timeoutMs: 10000,
      intervalMs: 250,
      label: "running issue survives single missing thread/list during long gap"
    });

    completeIssueOnThread(fakeAppServer, {
      codexThreadId: sourceCodexThreadId,
      turnId: "turn-long-gap-running-completed"
    });

    await waitFor(async () => {
      const payload = await bridge.request(`/api/issues/${activeIssueId}`);
      assert.equal(payload.issue?.status, "completed");
      assert.equal(payload.issue?.last_event, "turn.completed");
      return payload;
    }, {
      timeoutMs: 45000,
      intervalMs: 300,
      label: "running issue completes after long silent gap"
    });
  } catch (error) {
    error.message = `${error.message}\n\n[bridge stdout]\n${bridge.debugOutput().stdout}\n[bridge stderr]\n${bridge.debugOutput().stderr}`;
    throw error;
  }
});

test("실시간 delta가 끊겨도 thread/list가 running이면 즉시 thread/read backfill로 running 상태를 복구한다", { timeout: 120000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-running-thread-read-backfill-int-"));
  const fakeAppServer = new FakeAppServer();
  fakeAppServer.options.onTurnStart = ({ server, threadId }) => {
    server.notify("item/agentMessage/delta", {
      threadId,
      delta: "첫 문장"
    });

    setTimeout(() => {
      server.recordNotification("thread/tokenUsage/updated", {
        threadId,
        tokenUsage: {
          modelContextWindow: 100000,
          last: {
            inputTokens: 91000,
            outputTokens: 1800,
            totalTokens: 92800
          },
          total: {
            inputTokens: 91000,
            outputTokens: 1800,
            totalTokens: 92800
          }
        }
      });
      server.recordNotification("item/agentMessage/delta", {
        threadId,
        delta: " 이후 RPC 복구 문장"
      });
    }, 1200);
  };
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-running-thread-read-backfill-token",
    userId: "integration-user",
    bridgeId: `running-thread-read-backfill-${randomUUID().slice(0, 8)}`,
    homeDir,
    appServerUrl,
    extraEnv: {
      OCTOP_RUNNING_ISSUE_WATCHDOG_INTERVAL_MS: "200",
      OCTOP_RUNNING_ISSUE_STALE_MS: "600",
      OCTOP_RUNNING_ISSUE_BACKFILL_INTERVAL_MS: "200"
    }
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
      activeIssueId
    } = await createRunningIssueScenario(bridge, {
      project,
      threadName: "Running Thread Read Backfill"
    });

    await waitFor(async () => {
      const issuePayload = await bridge.request(`/api/issues/${activeIssueId}`);
      const continuityPayload = await bridge.request(`/api/threads/${rootThreadId}/continuity`);
      const assistantMessages = issuePayload.messages.filter((message) => message.role === "assistant");

      assert.equal(issuePayload.issue?.status, "running");
      assert.equal(assistantMessages.at(-1)?.content, "첫 문장 이후 RPC 복구 문장");
      assert.equal(continuityPayload.active_physical_thread?.context_used_tokens, 91000);
      assert.equal(continuityPayload.active_physical_thread?.context_usage_percent, 91);
      assert.equal(continuityPayload.root_thread?.continuity_status, "healthy");
      assert.equal(fakeAppServer.getRequests("thread/read").length >= 1, true);
      return { issuePayload, continuityPayload };
    }, {
      timeoutMs: 15000,
      intervalMs: 250,
      label: "running thread/read backfill while remote stays active"
    });
  } catch (error) {
    error.message = `${error.message}\n\n[bridge stdout]\n${bridge.debugOutput().stdout}\n[bridge stderr]\n${bridge.debugOutput().stderr}`;
    throw error;
  }
});

test("running backfill은 새 delta가 없어도 기존 item.agentMessage.delta 상태를 turn.started로 되돌리지 않는다", { timeout: 120000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-running-backfill-preserve-last-event-int-"));
  const fakeAppServer = new FakeAppServer();
  fakeAppServer.options.onTurnStart = ({ server, threadId }) => {
    server.notify("item/agentMessage/delta", {
      threadId,
      delta: "첫 문장"
    });
  };
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-running-backfill-preserve-last-event-token",
    userId: "integration-user",
    bridgeId: `running-backfill-preserve-last-event-${randomUUID().slice(0, 8)}`,
    homeDir,
    appServerUrl,
    extraEnv: {
      OCTOP_RUNNING_ISSUE_WATCHDOG_INTERVAL_MS: "200",
      OCTOP_RUNNING_ISSUE_STALE_MS: "600",
      OCTOP_RUNNING_ISSUE_BACKFILL_INTERVAL_MS: "200"
    }
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
      activeIssueId
    } = await createRunningIssueScenario(bridge, {
      project,
      threadName: "Running Backfill Preserve Last Event"
    });

    await waitFor(async () => {
      const issuePayload = await bridge.request(`/api/issues/${activeIssueId}`);
      const continuityPayload = await bridge.request(`/api/threads/${rootThreadId}/continuity`);

      assert.equal(fakeAppServer.getRequests("thread/read").length >= 2, true);
      assert.equal(issuePayload.issue?.status, "running");
      assert.notEqual(issuePayload.issue?.last_event, "turn.started");
      assert.equal(continuityPayload.active_physical_thread?.last_event, "item.agentMessage.delta");
      assert.notEqual(continuityPayload.root_thread?.last_event, "turn.started");
      assert.equal(continuityPayload.root_thread?.continuity_status, "healthy");
      return { issuePayload, continuityPayload };
    }, {
      timeoutMs: 15000,
      intervalMs: 250,
      label: "running backfill preserves item delta event"
    });
  } catch (error) {
    error.message = `${error.message}\n\n[bridge stdout]\n${bridge.debugOutput().stdout}\n[bridge stderr]\n${bridge.debugOutput().stderr}`;
    throw error;
  }
});

test("연속 무진전 running backfill은 websocket 강제 재연결로 승격된다", { timeout: 120000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-running-backfill-force-reconnect-int-"));
  const fakeAppServer = new FakeAppServer();
  fakeAppServer.options.onTurnStart = ({ server, threadId }) => {
    server.notify("item/agentMessage/delta", {
      threadId,
      delta: "첫 문장"
    });

    const currentTurn = server.getCurrentTurn(threadId);
    if (currentTurn) {
      currentTurn.items = [];
    }
  };
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-running-backfill-force-reconnect-token",
    userId: "integration-user",
    bridgeId: `running-backfill-force-reconnect-${randomUUID().slice(0, 8)}`,
    homeDir,
    appServerUrl,
    extraEnv: {
      OCTOP_RUNNING_ISSUE_WATCHDOG_INTERVAL_MS: "200",
      OCTOP_RUNNING_ISSUE_STALE_MS: "600",
      OCTOP_RUNNING_ISSUE_BACKFILL_INTERVAL_MS: "200",
      OCTOP_RUNNING_ISSUE_BACKFILL_NO_PROGRESS_FORCE_RECONNECT_COUNT: "2"
    }
  });

  t.after(async () => {
    await bridge.stop();
    await fakeAppServer.stop();
    await rm(homeDir, { recursive: true, force: true });
  });

  try {
    await bridge.start();

    const project = await getWorkspaceProject(bridge);
    const { rootThreadId, activeIssueId } = await createRunningIssueScenario(bridge, {
      project,
      threadName: "Running Backfill Force Reconnect"
    });

    await waitFor(async () => {
      const issuePayload = await bridge.request(`/api/issues/${activeIssueId}`);
      const continuityPayload = await bridge.request(`/api/threads/${rootThreadId}/continuity`);

      assert.equal(fakeAppServer.connectionCount >= 2, true);
      assert.equal(fakeAppServer.getRequests("thread/read").length >= 2, true);
      assert.equal(issuePayload.issue?.status, "running");
      assert.equal(issuePayload.issue?.last_event, "watchdog.degraded");
      assert.equal(continuityPayload.root_thread?.continuity_status, "degraded");
      assert.equal(continuityPayload.active_physical_thread?.last_event, "watchdog.degraded");
      return { issuePayload, continuityPayload };
    }, {
      timeoutMs: 20000,
      intervalMs: 250,
      label: "running backfill forces reconnect after repeated no-progress polls"
    });
  } catch (error) {
    error.message = `${error.message}\n\n[bridge stdout]\n${bridge.debugOutput().stdout}\n[bridge stderr]\n${bridge.debugOutput().stderr}`;
    throw error;
  }
});

test("thread/list 종료 상태만으로 running issue를 terminal 처리하지 않는다", { timeout: 120000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-remote-terminal-observation-int-"));
  const fakeAppServer = new FakeAppServer();
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-remote-terminal-observation-token",
    userId: "integration-user",
    bridgeId: `remote-terminal-observation-${randomUUID().slice(0, 8)}`,
    homeDir,
    appServerUrl,
    extraEnv: {
      OCTOP_RUNNING_ISSUE_WATCHDOG_INTERVAL_MS: "200",
      OCTOP_RUNNING_ISSUE_STALE_MS: "600",
      OCTOP_RUNNING_ISSUE_MISSING_REMOTE_RETRY_COUNT: "2"
    }
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
      sourceCodexThreadId
    } = await createRunningIssueScenario(bridge, {
      project,
      threadName: "Remote Terminal Observation Thread"
    });

    const remoteThread = fakeAppServer.threads.get(sourceCodexThreadId);
    assert.ok(remoteThread, "fake app-server remote thread를 찾지 못했습니다.");
    remoteThread.status = { type: "idle" };
    remoteThread.updatedAt = Math.floor(Date.now() / 1000);

    await waitFor(async () => {
      assert.equal(fakeAppServer.getRequests("thread/list").length >= 1, true);
      const issueDetail = await bridge.request(`/api/issues/${activeIssueId}`);
      const continuity = await bridge.request(`/api/threads/${rootThreadId}/continuity`);

      assert.equal(issueDetail.issue?.status, "running");
      assert.equal(issueDetail.issue?.last_event, "watchdog.degraded");
      assert.equal(continuity.root_thread?.continuity_status, "degraded");
      assert.equal(continuity.active_physical_thread?.codex_thread_id, sourceCodexThreadId);
      assert.equal(continuity.active_physical_thread?.status, "active");
      return { issueDetail, continuity };
    }, {
      timeoutMs: 10000,
      intervalMs: 250,
      label: "remote terminal observation keeps running issue intact"
    });

    completeIssueOnThread(fakeAppServer, {
      codexThreadId: sourceCodexThreadId,
      turnId: "turn-remote-terminal-observed-completed"
    });

    await waitFor(async () => {
      const payload = await bridge.request(`/api/issues/${activeIssueId}`);
      const continuity = await bridge.request(`/api/threads/${rootThreadId}/continuity`);
      assert.equal(payload.issue?.status, "completed");
      assert.equal(payload.issue?.last_event, "turn.completed");
      assert.equal(continuity.root_thread?.continuity_status, "healthy");
      return { payload, continuity };
    }, {
      timeoutMs: 45000,
      intervalMs: 300,
      label: "authoritative completion event recovers degraded observation"
    });
  } catch (error) {
    error.message = `${error.message}\n\n[bridge stdout]\n${bridge.debugOutput().stdout}\n[bridge stderr]\n${bridge.debugOutput().stderr}`;
    throw error;
  }
});

test("다른 thread issue 시작은 현재 running issue와 동시에 실행된다", { timeout: 120000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-cross-thread-queue-int-"));
  const fakeAppServer = new FakeAppServer();
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-cross-thread-queue-token",
    userId: "integration-user",
    bridgeId: `cross-thread-queue-bridge-${randomUUID().slice(0, 8)}`,
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
    const runningScenario = await createRunningIssueScenario(bridge, {
      project,
      threadName: "Primary Running Thread"
    });

    const createdThread = await bridge.request(`/api/projects/${project.id}/threads`, {
      method: "POST",
      body: JSON.stringify({
        name: "Secondary Queued Thread"
      })
    });
    const secondaryThreadId = createdThread.thread.id;
    const createdIssue = await bridge.request(`/api/threads/${secondaryThreadId}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: "Secondary Queued Issue",
        prompt: PROMPT
      })
    });
    const secondaryIssueId = createdIssue.issue.id;

    const startPayload = await bridge.request(`/api/threads/${secondaryThreadId}/issues/start`, {
      method: "POST",
      body: JSON.stringify({
        issue_ids: [secondaryIssueId]
      })
    });

    assert.equal(startPayload.blocked_by_thread_id, null);

    await waitFor(async () => {
      const primaryIssue = await bridge.request(`/api/issues/${runningScenario.activeIssueId}`);
      const secondaryIssue = await bridge.request(`/api/issues/${secondaryIssueId}`);
      assert.equal(primaryIssue.issue?.status, "running");
      assert.equal(secondaryIssue.issue?.status, "running");
      assert.equal(fakeAppServer.getRequests("turn/start").length, 2);
      return { primaryIssue, secondaryIssue };
    }, {
      timeoutMs: 15000,
      intervalMs: 250,
      label: "secondary thread starts while primary thread runs"
    });
  } catch (error) {
    error.message = `${error.message}\n\n[bridge stdout]\n${bridge.debugOutput().stdout}\n[bridge stderr]\n${bridge.debugOutput().stderr}`;
    throw error;
  }
});

test("manual refresh normalize는 현재 thread의 staged issue를 다시 실행한다", { timeout: 120000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-normalize-current-thread-int-"));
  const fakeAppServer = new FakeAppServer();
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-normalize-current-thread-token",
    userId: "integration-user",
    bridgeId: `normalize-current-thread-bridge-${randomUUID().slice(0, 8)}`,
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
    const createdThread = await bridge.request(`/api/projects/${project.id}/threads`, {
      method: "POST",
      body: JSON.stringify({
        name: "Normalize Current Thread Recovery"
      })
    });
    const rootThreadId = createdThread.thread.id;
    const createdIssue = await bridge.request(`/api/threads/${rootThreadId}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: "Recover Current Issue",
        prompt: PROMPT
      })
    });
    const issueId = createdIssue.issue.id;

    const normalized = await bridge.request(`/api/threads/${rootThreadId}/normalize`, {
      method: "POST",
      body: JSON.stringify({
        reason: "manual_refresh"
      })
    });

    assert.equal(normalized.accepted, true);
    assert.equal(normalized.action, "resumed_issue_queue");
    assert.equal(normalized.queued_issue_ids.length, 0);
    assert.equal(Array.isArray(normalized.recovery_steps), true);
    assert.equal(normalized.recovery_steps.includes("promoted_staged_issue"), true);
    assert.equal(normalized.recovery_steps.includes("resumed_issue_queue"), true);

    await waitFor(async () => {
      const payload = await bridge.request(`/api/issues/${issueId}`);
      assert.equal(payload.issue?.status, "running");
      assert.equal(payload.issue?.last_event, "turn.started");
      return payload;
    }, {
      timeoutMs: 15000,
      intervalMs: 250,
      label: "manual refresh normalize current issue resume"
    });

    assert.equal(fakeAppServer.getRequests("thread/start").length, 1);
    assert.equal(fakeAppServer.getRequests("turn/start").length, 1);
  } catch (error) {
    error.message = `${error.message}\n\n[bridge stdout]\n${bridge.debugOutput().stdout}\n[bridge stderr]\n${bridge.debugOutput().stderr}`;
    throw error;
  }
});

test("thread unlock은 마지막 running issue 락을 해제하고 다음 queued issue를 재개한다", { timeout: 120000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-thread-unlock-int-"));
  const fakeAppServer = new FakeAppServer();
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-thread-unlock-token",
    userId: "integration-user",
    bridgeId: `thread-unlock-bridge-${randomUUID().slice(0, 8)}`,
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
    const { rootThreadId, activeIssueId, stagedIssueId } = await createRunningIssueScenario(bridge, {
      project,
      threadName: "Thread Unlock Recovery"
    });

    await bridge.request(`/api/threads/${rootThreadId}/issues/start`, {
      method: "POST",
      body: JSON.stringify({
        issue_ids: [stagedIssueId]
      })
    });

    await waitFor(async () => {
      const queuedPayload = await bridge.request(`/api/issues/${stagedIssueId}`);
      assert.equal(queuedPayload.issue?.status, "queued");
      return queuedPayload;
    }, {
      timeoutMs: 10000,
      intervalMs: 250,
      label: "queued issue before unlock"
    });

    const unlockPayload = await bridge.request(`/api/threads/${rootThreadId}/unlock`, {
      method: "POST",
      body: JSON.stringify({
        reason: "manual_refresh"
      })
    });

    assert.equal(unlockPayload.accepted, true);
    assert.equal(unlockPayload.action, "unlocked");
    assert.equal(unlockPayload.unlocked_issue_id, activeIssueId);
    assert.equal(unlockPayload.recovery_steps.includes("released_last_issue_lock"), true);

    await waitFor(async () => {
      const failedIssuePayload = await bridge.request(`/api/issues/${activeIssueId}`);
      const resumedIssuePayload = await bridge.request(`/api/issues/${stagedIssueId}`);
      const continuityPayload = await bridge.request(`/api/threads/${rootThreadId}/continuity`);
      assert.equal(failedIssuePayload.issue?.status, "failed");
      assert.equal(failedIssuePayload.issue?.last_event, "issue.unlocked");
      assert.equal(resumedIssuePayload.issue?.status, "running");
      assert.equal(continuityPayload.active_physical_thread?.status, "active");
      assert.ok(continuityPayload.active_physical_thread?.turn_id);
      return { failedIssuePayload, resumedIssuePayload, continuityPayload };
    }, {
      timeoutMs: 15000,
      intervalMs: 250,
      label: "unlock resumed queued issue"
    });
  } catch (error) {
    error.message = `${error.message}\n\n[bridge stdout]\n${bridge.debugOutput().stdout}\n[bridge stderr]\n${bridge.debugOutput().stderr}`;
    throw error;
  }
});

test("진행 중인 issue 삭제는 강제 중단 후 바로 삭제하고 다음 queued issue를 재개한다", { timeout: 120000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-delete-running-issue-int-"));
  const fakeAppServer = new FakeAppServer({
    errorMethods: {
      "thread/realtime/stop": "thread not found: missing-codex-thread"
    }
  });
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-delete-running-issue-token",
    userId: "integration-user",
    bridgeId: `delete-running-issue-bridge-${randomUUID().slice(0, 8)}`,
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
    const { rootThreadId, activeIssueId, stagedIssueId } = await createRunningIssueScenario(bridge, {
      project,
      threadName: "Delete Running Issue Thread"
    });

    await bridge.request(`/api/threads/${rootThreadId}/issues/start`, {
      method: "POST",
      body: JSON.stringify({
        issue_ids: [stagedIssueId]
      })
    });

    await waitFor(async () => {
      const queuedIssue = await bridge.request(`/api/issues/${stagedIssueId}`);
      assert.equal(queuedIssue.issue?.status, "queued");
      return queuedIssue;
    }, {
      timeoutMs: 5000,
      intervalMs: 250,
      label: "next issue queued before deleting active issue"
    });

    const deletePayload = await bridge.request(`/api/issues/${activeIssueId}`, {
      method: "DELETE"
    });

    assert.equal(deletePayload.accepted, true);
    assert.equal(deletePayload.deleted_issue_id, activeIssueId);
    assert.equal(deletePayload.recovery_steps.includes("forced_release_after_delete_stop_failed"), true);

    await waitFor(async () => {
      const deletedIssue = await bridge.request(`/api/issues/${activeIssueId}`);
      const nextIssue = await bridge.request(`/api/issues/${stagedIssueId}`);
      const continuity = await bridge.request(`/api/threads/${rootThreadId}/continuity`);
      assert.equal(deletedIssue.issue, null);
      assert.equal(nextIssue.issue?.status, "running");
      assert.ok(continuity.active_physical_thread?.codex_thread_id);
      return { deletedIssue, nextIssue, continuity };
    }, {
      timeoutMs: 15000,
      intervalMs: 250,
      label: "running issue deleted and next queued issue resumed"
    });
  } catch (error) {
    error.message = `${error.message}\n\n[bridge stdout]\n${bridge.debugOutput().stdout}\n[bridge stderr]\n${bridge.debugOutput().stderr}`;
    throw error;
  }
});

test("todo issue를 preparation으로 되돌리면 queued issue가 staged로 이동한다", { timeout: 120000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-issue-interrupt-int-"));
  const fakeAppServer = new FakeAppServer();
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-issue-interrupt-token",
    userId: "integration-user",
    bridgeId: `issue-interrupt-bridge-${randomUUID().slice(0, 8)}`,
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
    const { rootThreadId, activeIssueId, stagedIssueId } = await createRunningIssueScenario(bridge, {
      project,
      threadName: "Todo To Prep Interrupt"
    });

    await bridge.request(`/api/threads/${rootThreadId}/issues/start`, {
      method: "POST",
      body: JSON.stringify({
        issue_ids: [stagedIssueId]
      })
    });

    await waitFor(async () => {
      const queuedPayload = await bridge.request(`/api/issues/${stagedIssueId}`);
      assert.equal(queuedPayload.issue?.status, "queued");
      assert.equal(Number.isFinite(queuedPayload.issue?.queue_position), true);
      return queuedPayload;
    }, {
      timeoutMs: 10000,
      intervalMs: 250,
      label: "queued issue before interrupt"
    });

    const interruptPayload = await bridge.request(`/api/issues/${stagedIssueId}/interrupt`, {
      method: "POST",
      body: JSON.stringify({
        reason: "drag_to_prep"
      })
    });

    assert.equal(interruptPayload.accepted, true);
    assert.equal(interruptPayload.action, "interrupted");

    await waitFor(async () => {
      const interruptedIssuePayload = await bridge.request(`/api/issues/${stagedIssueId}`);
      const activeIssuePayload = await bridge.request(`/api/issues/${activeIssueId}`);
      assert.equal(interruptedIssuePayload.issue?.status, "staged");
      assert.equal(interruptedIssuePayload.issue?.last_event, "issue.interrupted");
      assert.equal(interruptedIssuePayload.issue?.queue_position ?? null, null);
      assert.equal(Number.isFinite(interruptedIssuePayload.issue?.prep_position), true);
      assert.equal(activeIssuePayload.issue?.status, "running");
      return { interruptedIssuePayload, activeIssuePayload };
    }, {
      timeoutMs: 10000,
      intervalMs: 250,
      label: "todo issue returned to prep"
    });
  } catch (error) {
    error.message = `${error.message}\n\n[bridge stdout]\n${bridge.debugOutput().stdout}\n[bridge stderr]\n${bridge.debugOutput().stderr}`;
    throw error;
  }
});

test("thread unlock manual_refresh는 stop timeout이어도 stale running 락을 강제 해제하고 queued issue를 재개한다", { timeout: 120000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-thread-unlock-stop-failed-int-"));
  const fakeAppServer = new FakeAppServer({
    noResponseMethods: ["thread/realtime/stop"]
  });
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-thread-unlock-stop-failed-token",
    userId: "integration-user",
    bridgeId: `thread-unlock-stop-failed-${randomUUID().slice(0, 8)}`,
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
    const { rootThreadId, activeIssueId, stagedIssueId } = await createRunningIssueScenario(bridge, {
      project,
      threadName: "Thread Unlock Stop Failure"
    });

    await bridge.request(`/api/threads/${rootThreadId}/issues/start`, {
      method: "POST",
      body: JSON.stringify({
        issue_ids: [stagedIssueId]
      })
    });

    await waitFor(async () => {
      const queuedPayload = await bridge.request(`/api/issues/${stagedIssueId}`);
      assert.equal(queuedPayload.issue?.status, "queued");
      return queuedPayload;
    }, {
      timeoutMs: 10000,
      intervalMs: 250,
      label: "queued issue before forced unlock recovery"
    });

    const unlockPayload = await bridge.request(`/api/threads/${rootThreadId}/unlock`, {
      method: "POST",
      body: JSON.stringify({
        reason: "manual_refresh"
      })
    });

    assert.equal(unlockPayload.accepted, true);
    assert.equal(unlockPayload.action, "forced_unlock");
    assert.equal(unlockPayload.unlocked_issue_id, activeIssueId);
    assert.equal(unlockPayload.recovery_steps.includes("forced_release_after_stop_failed"), true);
    assert.equal(unlockPayload.recovery_steps.includes("released_last_issue_lock"), true);
    assert.equal(unlockPayload.recovery_steps.includes("resumed_issue_queue"), true);

    await waitFor(async () => {
      const failedIssuePayload = await bridge.request(`/api/issues/${activeIssueId}`);
      const resumedIssuePayload = await bridge.request(`/api/issues/${stagedIssueId}`);
      const continuityPayload = await bridge.request(`/api/threads/${rootThreadId}/continuity`);
      const health = await bridge.request("/health");
      assert.equal(failedIssuePayload.issue?.status, "failed");
      assert.equal(failedIssuePayload.issue?.last_event, "issue.unlocked");
      assert.equal(resumedIssuePayload.issue?.status, "running");
      assert.equal(continuityPayload.active_physical_thread?.status, "active");
      assert.ok(continuityPayload.active_physical_thread?.codex_thread_id);
      assert.ok(continuityPayload.active_physical_thread?.turn_id);
      assert.equal(health.status?.app_server?.idle, false);
      return { failedIssuePayload, resumedIssuePayload, continuityPayload, health };
    }, {
      timeoutMs: 15000,
      intervalMs: 250,
      label: "forced unlock recovery resumed queued issue after stop timeout"
    });
  } catch (error) {
    error.message = `${error.message}\n\n[bridge stdout]\n${bridge.debugOutput().stdout}\n[bridge stderr]\n${bridge.debugOutput().stderr}`;
    throw error;
  }
});

test("한 thread의 강제 unlock recovery가 다른 thread의 issue 시작을 막지 않는다", { timeout: 120000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-cross-thread-isolation-int-"));
  const fakeAppServer = new FakeAppServer({
    noResponseMethods: ["thread/realtime/stop"]
  });
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-cross-thread-isolation-token",
    userId: "integration-user",
    bridgeId: `cross-thread-isolation-${randomUUID().slice(0, 8)}`,
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
    const firstScenario = await createRunningIssueScenario(bridge, {
      project,
      threadName: "Primary Thread With Stop Failure"
    });

    const unlockPayload = await bridge.request(`/api/threads/${firstScenario.rootThreadId}/unlock`, {
      method: "POST",
      body: JSON.stringify({
        reason: "manual_refresh"
      })
    });

    assert.equal(unlockPayload.accepted, true);
    assert.equal(unlockPayload.action, "forced_unlock");

    const secondThreadPayload = await bridge.request(`/api/projects/${project.id}/threads`, {
      method: "POST",
      body: JSON.stringify({
        name: "Independent Secondary Thread"
      })
    });
    const secondThreadId = secondThreadPayload.thread.id;
    const secondIssuePayload = await bridge.request(`/api/threads/${secondThreadId}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: "Independent Issue",
        prompt: PROMPT
      })
    });
    const secondIssueId = secondIssuePayload.issue.id;

    const startPayload = await bridge.request(`/api/threads/${secondThreadId}/issues/start`, {
      method: "POST",
      body: JSON.stringify({
        issue_ids: [secondIssueId]
      })
    });

    assert.equal(startPayload.accepted, true);

    await waitFor(async () => {
      const issuePayload = await bridge.request(`/api/issues/${secondIssueId}`);
      assert.equal(issuePayload.issue?.status, "running");
      assert.equal(issuePayload.issue?.thread_id, secondThreadId);
      return issuePayload;
    }, {
      timeoutMs: 15000,
      intervalMs: 250,
      label: "secondary thread issue started despite primary thread error"
    });
  } catch (error) {
    error.message = `${error.message}\n\n[bridge stdout]\n${bridge.debugOutput().stdout}\n[bridge stderr]\n${bridge.debugOutput().stderr}`;
    throw error;
  }
});

test("thread not found stop error 후 manual_refresh recovery 뒤에도 같은 thread와 새 thread는 동시에 실행된다", { timeout: 120000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-thread-unlock-thread-not-found-int-"));
  const fakeAppServer = new FakeAppServer({
    errorMethods: {
      "thread/realtime/stop": "thread not found: missing-codex-thread"
    }
  });
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-thread-unlock-thread-not-found-token",
    userId: "integration-user",
    bridgeId: `thread-unlock-thread-not-found-${randomUUID().slice(0, 8)}`,
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
    const { rootThreadId, activeIssueId } = await createRunningIssueScenario(bridge, {
      project,
      threadName: "Thread Unlock Thread Not Found"
    });

    const unlockPayload = await bridge.request(`/api/threads/${rootThreadId}/unlock`, {
      method: "POST",
      body: JSON.stringify({
        reason: "manual_refresh"
      })
    });

    assert.equal(unlockPayload.accepted, true);
    assert.equal(unlockPayload.action, "forced_unlock");
    assert.equal(unlockPayload.unlocked_issue_id, activeIssueId);

    await waitFor(async () => {
      const continuityPayload = await bridge.request(`/api/threads/${rootThreadId}/continuity`);
      const failedIssuePayload = await bridge.request(`/api/issues/${activeIssueId}`);
      assert.equal(failedIssuePayload.issue?.status, "failed");
      assert.equal(continuityPayload.active_physical_thread?.codex_thread_id ?? null, null);
      assert.equal(continuityPayload.active_physical_thread?.turn_id ?? null, null);
      return { continuityPayload, failedIssuePayload };
    }, {
      timeoutMs: 10000,
      intervalMs: 250,
      label: "forced unlock cleared missing-thread binding"
    });

    const nextIssuePayload = await bridge.request(`/api/threads/${rootThreadId}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: "Restart On Same Thread",
        prompt: PROMPT
      })
    });
    const nextIssueId = nextIssuePayload.issue.id;

    const sameThreadStartPayload = await bridge.request(`/api/threads/${rootThreadId}/issues/start`, {
      method: "POST",
      body: JSON.stringify({
        issue_ids: [nextIssueId]
      })
    });

    assert.equal(sameThreadStartPayload.accepted, true);

    await waitFor(async () => {
      const issuePayload = await bridge.request(`/api/issues/${nextIssueId}`);
      const continuityPayload = await bridge.request(`/api/threads/${rootThreadId}/continuity`);
      assert.equal(issuePayload.issue?.status, "running");
      assert.ok(continuityPayload.active_physical_thread?.codex_thread_id);
      assert.ok(continuityPayload.active_physical_thread?.turn_id);
      return { issuePayload, continuityPayload };
    }, {
      timeoutMs: 15000,
      intervalMs: 250,
      label: "same thread issue restarted after forced unlock recovery"
    });

    const secondThreadPayload = await bridge.request(`/api/projects/${project.id}/threads`, {
      method: "POST",
      body: JSON.stringify({
        name: "Fresh Thread After Forced Unlock"
      })
    });
    const secondThreadId = secondThreadPayload.thread.id;
    const secondIssuePayload = await bridge.request(`/api/threads/${secondThreadId}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: "Fresh Thread Issue",
        prompt: PROMPT
      })
    });
    const secondIssueId = secondIssuePayload.issue.id;

    const secondStartPayload = await bridge.request(`/api/threads/${secondThreadId}/issues/start`, {
      method: "POST",
      body: JSON.stringify({
        issue_ids: [secondIssueId]
      })
    });

    assert.equal(secondStartPayload.accepted, true);
    assert.equal(secondStartPayload.blocked_by_thread_id, null);

    await waitFor(async () => {
      const issuePayload = await bridge.request(`/api/issues/${secondIssueId}`);
      assert.equal(issuePayload.issue?.status, "running");
      assert.equal(fakeAppServer.getRequests("turn/start").length >= 2, true);
      return issuePayload;
    }, {
      timeoutMs: 15000,
      intervalMs: 250,
      label: "new thread issue starts while restarted thread runs"
    });
  } catch (error) {
    error.message = `${error.message}\n\n[bridge stdout]\n${bridge.debugOutput().stdout}\n[bridge stderr]\n${bridge.debugOutput().stderr}`;
    throw error;
  }
});

test("issue start 준비 단계 예외가 발생해도 queued issue를 복구하고 재개한다", { timeout: 120000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-queue-recovery-on-start-error-int-"));
  const fakeAppServer = new FakeAppServer();
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-queue-recovery-on-start-error-token",
    userId: "integration-user",
    bridgeId: `queue-recovery-on-start-error-${randomUUID().slice(0, 8)}`,
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
    const threadPayload = await bridge.request(`/api/projects/${project.id}/threads`, {
      method: "POST",
      body: JSON.stringify({
        name: "Queue Recovery Thread"
      })
    });
    const threadId = threadPayload.thread.id;

    const issuePayload = await bridge.request(`/api/threads/${threadId}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: "Queue Recovery Issue",
        prompt: PROMPT
      })
    });
    const issueId = issuePayload.issue.id;

    fakeAppServer.options.errorOnceMethods = {
      "thread/start": "temporary thread/start failure"
    };

    const startPayload = await bridge.request(`/api/threads/${threadId}/issues/start`, {
      method: "POST",
      body: JSON.stringify({
        issue_ids: [issueId]
      })
    });

    assert.equal(startPayload.accepted, true);

    await waitFor(async () => {
      const currentIssuePayload = await bridge.request(`/api/issues/${issueId}`);
      const continuityPayload = await bridge.request(`/api/threads/${threadId}/continuity`);
      assert.equal(currentIssuePayload.issue?.status, "running");
      assert.equal(currentIssuePayload.issue?.queue_position ?? null, null);
      assert.ok(continuityPayload.active_physical_thread?.codex_thread_id);
      assert.ok(continuityPayload.active_physical_thread?.turn_id);
      return { currentIssuePayload, continuityPayload };
    }, {
      timeoutMs: 15000,
      intervalMs: 250,
      label: "queued issue resumed after thread/start preparation failure"
    });
  } catch (error) {
    error.message = `${error.message}\n\n[bridge stdout]\n${bridge.debugOutput().stdout}\n[bridge stderr]\n${bridge.debugOutput().stderr}`;
    throw error;
  }
});

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
    } = await triggerPreflightThresholdRollover(bridge, fakeAppServer, {
      rootThreadId,
      sourceCodexThreadId,
      sourcePhysicalThreadId,
      nextIssueId: stagedIssueId
    });
    assert.ok(targetCodexThreadId);

    issuesResponse = await bridge.request(`/api/threads/${rootThreadId}/issues`);
    assert.equal(issuesResponse.issues.length, 2);
    assert.equal(issuesResponse.issues.find((issue) => issue.id === activeIssueId)?.status, "completed");
    assert.equal(issuesResponse.issues.find((issue) => issue.id === activeIssueId)?.executed_physical_thread_id, sourcePhysicalThreadId);
    assert.equal(issuesResponse.issues.find((issue) => issue.id === stagedIssueId)?.executed_physical_thread_id, targetPhysicalThreadId);

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
    assert.equal(storedUserState.active_issue_ids[rootThreadId], stagedIssueId);

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

    completeIssueOnThread(fakeAppServer, {
      codexThreadId: targetCodexThreadId,
      turnId: "turn-final"
    });

    const completedIssueDetail = await waitFor(async () => {
      const payload = await bridge.request(`/api/issues/${stagedIssueId}`);
      assert.equal(payload.issue?.status, "completed");
      assert.equal(
        payload.messages.some((message) => message.kind === "handoff_summary"),
        false
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
    assert.equal(fakeAppServer.getRequests("turn/interrupt").length, 0);

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

test("프로젝트 생성은 빈 key 요청이어도 workspace별로 연속 성공해야 한다", { timeout: 60000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-project-create-int-"));
  const fakeAppServer = new FakeAppServer();
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-project-create-token",
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

    const firstPayload = await bridge.request("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "Dashboard Workspace",
        key: "",
        workspace_path: join(REPO_ROOT, "apps", "dashboard")
      })
    });
    const secondPayload = await bridge.request("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "Mobile Workspace",
        key: "",
        workspace_path: join(REPO_ROOT, "apps", "mobile")
      })
    });

    assert.equal(firstPayload.accepted, true);
    assert.equal(secondPayload.accepted, true);
    assert.equal(firstPayload.project.key, "DASHBOARD_WORKSPACE");
    assert.equal(secondPayload.project.key, "MOBILE_WORKSPACE");
    assert.notEqual(firstPayload.project.id, secondPayload.project.id);
  } catch (error) {
    error.message = `${error.message}\n\n[bridge stdout]\n${bridge.debugOutput().stdout}\n[bridge stderr]\n${bridge.debugOutput().stderr}`;
    throw error;
  }
});

test("높은 tokenUsage가 누적된 root thread에서 다음 issue 시작 전에 사전 rollover가 발생한다", { timeout: 120000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-immediate-rollover-int-"));
  const fakeAppServer = new FakeAppServer();
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-immediate-rollover-token",
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
    const createThreadPayload = await bridge.request(`/api/projects/${project.id}/threads`, {
      method: "POST",
      body: JSON.stringify({
        name: "Immediate Rollover Thread"
      })
    });
    const rootThreadId = createThreadPayload.thread.id;

    const firstIssuePayload = await bridge.request(`/api/threads/${rootThreadId}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: "Initial Issue",
        prompt: PROMPT
      })
    });
    const firstIssueId = firstIssuePayload.issue.id;

    await bridge.request(`/api/threads/${rootThreadId}/issues/start`, {
      method: "POST",
      body: JSON.stringify({
        issue_ids: [firstIssueId]
      })
    });

    await waitFor(async () => {
      const payload = await bridge.request(`/api/issues/${firstIssueId}`);
      assert.equal(payload.issue?.status, "running");
      assert.ok(payload.issue?.executed_physical_thread_id);
      return payload;
    }, {
      label: "first issue running"
    });

    const sourceContinuity = await bridge.request(`/api/threads/${rootThreadId}/continuity`);
    const sourcePhysicalThreadId = sourceContinuity.active_physical_thread.id;
    const sourceCodexThreadId = sourceContinuity.active_physical_thread.codex_thread_id;

    await markThreadContextHigh(bridge, fakeAppServer, {
      rootThreadId,
      sourceCodexThreadId
    });

    await sleep(750);
    const continuityBeforeSecondIssue = await bridge.request(`/api/threads/${rootThreadId}/continuity`);
    assert.equal(continuityBeforeSecondIssue.physical_threads.length, 1);
    assert.equal(continuityBeforeSecondIssue.active_physical_thread?.id, sourcePhysicalThreadId);

    completeIssueOnThread(fakeAppServer, {
      codexThreadId: sourceCodexThreadId,
      turnId: "turn-first-completed"
    });

    await waitFor(async () => {
      const payload = await bridge.request(`/api/issues/${firstIssueId}`);
      assert.equal(payload.issue?.status, "completed");
      return payload;
    }, {
      label: "first issue completed"
    });

    const secondIssuePayload = await bridge.request(`/api/threads/${rootThreadId}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: "Preflight Rollover Issue",
        prompt: PROMPT
      })
    });
    const secondIssueId = secondIssuePayload.issue.id;

    await bridge.request(`/api/threads/${rootThreadId}/issues/start`, {
      method: "POST",
      body: JSON.stringify({
        issue_ids: [secondIssueId]
      })
    });

    const rolloverContinuity = await waitFor(async () => {
      const payload = await bridge.request(`/api/threads/${rootThreadId}/continuity`);
      assert.equal(payload.physical_threads.length, 2);
      assert.equal(payload.handoff_summaries.length, 1);
      assert.ok(payload.active_physical_thread?.id);
      assert.equal(
        payload.recently_closed_physical_threads.length >= 1,
        true
      );
      return payload;
    }, {
      timeoutMs: 45000,
      intervalMs: 300,
      label: "preflight rollover before second issue start"
    });

    const issueDetail = await bridge.request(`/api/issues/${secondIssueId}`);
    const health = await bridge.request("/health");
    const sourcePhysicalThread = rolloverContinuity.physical_threads.find(
      (physicalThread) => physicalThread.id !== rolloverContinuity.active_physical_thread.id
    );

    assert.ok(sourcePhysicalThread?.id);
    assert.equal(sourcePhysicalThread?.opened_reason, "initial");
    assert.equal(rolloverContinuity.active_physical_thread.opened_reason, "context_rollover");
    assert.equal(issueDetail.issue?.status, "running");
    assert.equal(issueDetail.issue?.executed_physical_thread_id, rolloverContinuity.active_physical_thread.id);
    assert.equal(Number(health.metrics.root_thread_rollover_total ?? 0) >= 1, true);
    assert.equal(fakeAppServer.getRequests("thread/start").length, 2);
    assert.equal(fakeAppServer.getRequests("turn/start").length, 2);
    assert.equal(fakeAppServer.getRequests("turn/interrupt").length, 0);
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
    const rolloverResult = await triggerPreflightThresholdRollover(bridge, fakeAppServer, {
      ...scenario,
      nextIssueId: scenario.stagedIssueId
    });

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

test("account/read가 signed-in account와 requiresOpenaiAuth를 함께 반환해도 실행을 차단하지 않는다", { timeout: 120000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "octop-auth-flag-with-account-int-"));
  const fakeAppServer = new FakeAppServer({
    accountReadResult: {
      account: {
        type: "chatgpt",
        email: "integration@octop.test",
        planType: "pro"
      },
      requiresOpenaiAuth: true,
      rateLimits: null
    }
  });
  const appServerUrl = await fakeAppServer.start();
  const bridgePort = await getFreePort();
  const bridge = new BridgeProcess({
    port: bridgePort,
    token: "octop-auth-flag-with-account-token",
    userId: "integration-user",
    bridgeId: `auth-flag-with-account-${randomUUID().slice(0, 8)}`,
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
    const createdThread = await bridge.request(`/api/projects/${project.id}/threads`, {
      method: "POST",
      body: JSON.stringify({
        name: "Auth Flag With Account Thread"
      })
    });
    const threadId = createdThread.thread.id;

    const createdIssue = await bridge.request(`/api/threads/${threadId}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: "Auth Flag With Account Issue",
        prompt: PROMPT
      })
    });
    const issueId = createdIssue.issue.id;

    const startPayload = await bridge.request(`/api/threads/${threadId}/issues/start`, {
      method: "POST",
      body: JSON.stringify({
        issue_ids: [issueId]
      })
    });
    assert.equal(startPayload.accepted, true);

    await waitFor(async () => {
      const issuePayload = await bridge.request(`/api/issues/${issueId}`);
      assert.equal(issuePayload.issue?.status, "running");
      return issuePayload;
    }, {
      timeoutMs: 15000,
      intervalMs: 250,
      label: "signed-in account bypasses false auth-required gate"
    });
  } catch (error) {
    error.message = `${error.message}\n\n[bridge stdout]\n${bridge.debugOutput().stdout}\n[bridge stderr]\n${bridge.debugOutput().stderr}`;
    throw error;
  }
});
