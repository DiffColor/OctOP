#!/usr/bin/env node

import { spawn } from "node:child_process";
import process from "node:process";
import { createHash } from "node:crypto";

function parseArgs(argv) {
  const options = {
    codex: "",
    authMode: "chatgpt-login",
    apiKey: "",
    browserBundleId: "",
    logoutFirst: false,
    timeoutMs: 900000
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    switch (token) {
      case "--codex":
        options.codex = String(next ?? "").trim();
        index += 1;
        break;
      case "--auth-mode":
        options.authMode = String(next ?? "").trim().toLowerCase();
        index += 1;
        break;
      case "--api-key":
        options.apiKey = String(next ?? "").trim();
        index += 1;
        break;
      case "--browser-bundle-id":
        options.browserBundleId = String(next ?? "").trim();
        index += 1;
        break;
      case "--logout-first":
        options.logoutFirst = true;
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(next ?? options.timeoutMs) || options.timeoutMs;
        index += 1;
        break;
      default:
        throw new Error(`알 수 없는 옵션입니다: ${token}`);
    }
  }

  if (!options.codex) {
    throw new Error("--codex 값이 필요합니다.");
  }

  const isApiKeyAuth = options.authMode === "api-key";
  if (!isApiKeyAuth && !options.browserBundleId) {
    throw new Error("--browser-bundle-id 값이 필요합니다.");
  }

  if (!options.authMode || !["chatgpt-login", "chatgpt", "api-key"].includes(options.authMode)) {
    throw new Error("--auth-mode 값이 잘못되었습니다.");
  }

  if (isApiKeyAuth && !options.apiKey) {
    throw new Error("--api-key 값이 필요합니다.");
  }

  return options;
}

function emit(event, payload = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...payload })}\n`);
}

function summarizeAccount(result) {
  const requiresOpenAIAuth = result?.requiresOpenaiAuth === true;
  const account = result?.account;
  if (!account || typeof account !== "object") {
    return {
      loggedIn: false,
      summary: requiresOpenAIAuth ? "미로그인" : "계정 정보 없음"
    };
  }

  const email = typeof account.email === "string" ? account.email.trim() : "";
  const type = typeof account.type === "string" ? account.type.trim() : "";

  if (email) {
    return { loggedIn: true, summary: email };
  }

  if (type === "apiKey") {
    return { loggedIn: true, summary: "API Key 로그인됨" };
  }

  return { loggedIn: true, summary: "로그인됨" };
}

function buildKeyFingerprint(rawKey) {
  const key = typeof rawKey === "string" ? rawKey.trim() : "";
  if (!key) {
    return null;
  }

  return createHash("sha256").update(key).digest("hex");
}

function summarizeAccountForLog(result) {
  const requiresOpenAIAuth = result?.requiresOpenaiAuth === true;
  const account = result?.account;
  const type = typeof account?.type === "string" ? account.type.trim() : "";
  const hasEmail = typeof account?.email === "string" && account.email.trim().length > 0;

  return {
    loggedIn: !(!hasEmail && !type),
    requiresOpenAiAuth: requiresOpenAIAuth,
    accountType: type,
    hasEmail
  };
}

function createJsonRpcSession({ codex }) {
  const child = spawn(codex, ["app-server", "--listen", "stdio://"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"]
  });

  let nextId = 1;
  let stdoutBuffer = "";
  const pending = new Map();
  const loginWaiters = new Map();
  const bufferedLoginResults = new Map();
  const accountUpdateWaiters = [];
  const bufferedAccountUpdates = [];

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;

    while (true) {
      const newlineIndex = stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }

      const rawLine = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (!rawLine) {
        continue;
      }

      let message;
      try {
        message = JSON.parse(rawLine);
      } catch {
        emit("stderr", { message: rawLine });
        continue;
      }

      if (message.id && pending.has(String(message.id))) {
        const deferred = pending.get(String(message.id));
        pending.delete(String(message.id));
        if (message.error) {
          deferred.reject(new Error(message.error.message ?? "app-server 요청 실패"));
        } else {
          deferred.resolve(message.result);
        }
        continue;
      }

      if (message.method === "account/login/completed") {
        const params = message.params ?? {};
        const loginId = typeof params.loginId === "string" ? params.loginId.trim() : "";
        const result = {
          loginId,
          success: params.success === true,
          error: typeof params.error === "string" ? params.error : ""
        };

        if (loginId && loginWaiters.has(loginId)) {
          const deferred = loginWaiters.get(loginId);
          loginWaiters.delete(loginId);
          deferred.resolve(result);
        } else if (loginId) {
          bufferedLoginResults.set(loginId, result);
        }
        continue;
      }

      if (message.method === "account/updated") {
        const params = message.params ?? {};
        const authMode = typeof params.authMode === "string" ? params.authMode.trim() : null;
        const result = { authMode };
        const waiterIndex = accountUpdateWaiters.findIndex(
          (waiter) => waiter.expectedAuthMode === normalizeAuthMode(authMode)
        );

        if (waiterIndex >= 0) {
          const [waiter] = accountUpdateWaiters.splice(waiterIndex, 1);
          waiter.resolve(result);
        } else {
          bufferedAccountUpdates.push(result);
        }
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) {
      emit("stderr", { message: text });
    }
  });

  child.on("exit", (code, signal) => {
    const error = new Error(`app-server 종료됨 (code=${code ?? "null"}, signal=${signal ?? "null"})`);
    for (const deferred of pending.values()) {
      deferred.reject(error);
    }
    pending.clear();
    for (const deferred of loginWaiters.values()) {
      deferred.reject(error);
    }
    loginWaiters.clear();
    while (accountUpdateWaiters.length > 0) {
      const waiter = accountUpdateWaiters.pop();
      waiter?.reject(error);
    }
  });

  function request(method, params, timeoutMs) {
    const id = String(nextId++);
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`요청 타임아웃: ${method}`));
      }, timeoutMs);

      pending.set(id, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        }
      });

      child.stdin.write(`${payload}\n`);
    });
  }

  async function shutdown() {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }

  function waitForLoginCompleted(loginId, timeoutMs) {
    if (bufferedLoginResults.has(loginId)) {
      const result = bufferedLoginResults.get(loginId);
      bufferedLoginResults.delete(loginId);
      return Promise.resolve(result);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        loginWaiters.delete(loginId);
        reject(new Error(`로그인 완료 대기 타임아웃: ${loginId}`));
      }, timeoutMs);

      loginWaiters.set(loginId, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  function waitForAccountUpdated(expectedAuthMode, timeoutMs) {
    const normalizedExpectedAuthMode = normalizeAuthMode(expectedAuthMode);
    const bufferedIndex = bufferedAccountUpdates.findIndex(
      (result) => normalizeAuthMode(result.authMode) === normalizedExpectedAuthMode
    );
    if (bufferedIndex >= 0) {
      const [result] = bufferedAccountUpdates.splice(bufferedIndex, 1);
      return Promise.resolve(result);
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        expectedAuthMode: normalizedExpectedAuthMode,
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        }
      };

      const timer = setTimeout(() => {
        const waiterIndex = accountUpdateWaiters.indexOf(waiter);
        if (waiterIndex >= 0) {
          accountUpdateWaiters.splice(waiterIndex, 1);
        }
        reject(new Error(`계정 갱신 대기 타임아웃: authMode=${expectedAuthMode ?? "null"}`));
      }, timeoutMs);

      accountUpdateWaiters.push(waiter);
    });
  }

  return { request, shutdown, waitForLoginCompleted, waitForAccountUpdated };
}

function normalizeAuthMode(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.toLowerCase().replace(/[-_]/g, "");
}

async function openInBrowser(browserBundleId, authUrl) {
  const open = spawn("/usr/bin/open", ["-b", browserBundleId, authUrl], {
    stdio: "ignore"
  });

  await new Promise((resolve, reject) => {
    open.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`브라우저 실행 실패 (종료 코드: ${code ?? "null"})`));
      }
    });
    open.on("error", reject);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const isApiKeyAuth = options.authMode === "api-key";
  const session = createJsonRpcSession({ codex: options.codex });

  try {
    const keyFingerprint = isApiKeyAuth ? buildKeyFingerprint(options.apiKey) : null;
    const keyLength = keyFingerprint ? options.apiKey.trim().length : 0;

    await session.request("initialize", {
      clientInfo: {
        name: "octop-agent-menu-login-helper",
        version: "v0.0.0-dev"
      },
      capabilities: {
        experimentalApi: true
      }
    }, options.timeoutMs);

    if (options.logoutFirst) {
      await session.request("account/logout", null, options.timeoutMs);
      emit("logout");
    }

    const loginStart = await session.request("account/login/start", isApiKeyAuth ? {
      type: "apiKey",
      apiKey: options.apiKey
    } : {
      type: "chatgpt"
    }, options.timeoutMs);

    const loginId = typeof loginStart?.loginId === "string" ? loginStart.loginId.trim() : "";
    const authUrl = typeof loginStart?.authUrl === "string" ? loginStart.authUrl.trim() : "";
    const loginStartEventPayload = {
      loginId,
      authUrl,
      browserBundleId: options.browserBundleId,
      keyLength,
      keyFingerprint
    };

    if (isApiKeyAuth) {
      emit("loginStart", loginStartEventPayload);
      if (loginId) {
        emit("waitingForCompletion", { loginId });
      } else {
        emit("waitingForCompletion", { loginId: "api-key" });
      }
      if (loginId) {
        const loginCompleted = await session.waitForLoginCompleted(loginId, options.timeoutMs);
        emit("loginCompleted", {
          loginId,
          success: loginCompleted.success,
          error: typeof loginCompleted.error === "string" ? loginCompleted.error : ""
        });
        if (!loginCompleted.success) {
          throw new Error(loginCompleted.error || "로그인에 실패했습니다.");
        }
      }
      await session.waitForAccountUpdated("apiKey", options.timeoutMs).catch(() => {});
      const accountResult = await session.request("account/read", { refreshToken: false }, options.timeoutMs);
      emit("accountRead", summarizeAccountForLog(accountResult));
      const accountStatus = summarizeAccount(accountResult);
      emit("loginComplete", accountStatus);
      await session.shutdown();
      return;
    }

    if (!loginId || !authUrl) {
      throw new Error("로그인 URL을 받지 못했습니다.");
    }

    emit("loginStart", {
      ...loginStartEventPayload,
      keyLength: 0,
      keyFingerprint: null
    });
    await openInBrowser(options.browserBundleId, authUrl);
    emit("browserOpened", { browserBundleId: options.browserBundleId });
    emit("waitingForCompletion", { loginId });

    const loginCompleted = await session.waitForLoginCompleted(loginId, options.timeoutMs);
    emit("loginCompleted", {
      loginId,
      success: loginCompleted.success,
      error: typeof loginCompleted.error === "string" ? loginCompleted.error : ""
    });
    if (!loginCompleted.success) {
      throw new Error(loginCompleted.error || "로그인에 실패했습니다.");
    }

    await session.waitForAccountUpdated("chatgpt", options.timeoutMs);
    const accountResult = await session.request("account/read", { refreshToken: false }, options.timeoutMs);
    emit("accountRead", summarizeAccountForLog(accountResult));
    const accountStatus = summarizeAccount(accountResult);
    emit("loginComplete", accountStatus);
    await session.shutdown();
  } catch (error) {
    emit("error", {
      message: error instanceof Error ? error.message : String(error)
    });
    await session.shutdown();
    process.exit(1);
  }
}

await main();
