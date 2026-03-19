#!/usr/bin/env node

import { spawn } from "node:child_process";
import process from "node:process";

const DEFAULT_CODEX =
  process.env.OCTOP_CODEX_PATH ||
  process.env.CODEX_PATH ||
  "/Users/jazzlife/Library/Application Support/OctOPAgentMenu/runtime/bin/codex";

function printUsage() {
  console.log(`
Usage:
  node scripts/test-app-server-login.mjs [options]

Options:
  --codex <path>        codex 실행 파일 경로
  --code-home <path>    CODEX_HOME 경로 (default: ~/.codex 또는 현재 환경값)
  --browser <name>      macOS에서 open -a 로 열 브라우저 이름 (예: "Google Chrome")
  --print-only          브라우저를 열지 않고 authUrl만 출력
  --timeout-ms <ms>     요청 타임아웃 (default: 15000)
  --help                도움말 출력
`);
}

function parseArgs(argv) {
  const options = {
    codex: DEFAULT_CODEX,
    codexHome: process.env.CODEX_HOME || `${process.env.HOME}/.codex`,
    browser: "",
    printOnly: false,
    timeoutMs: 15000
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    switch (token) {
      case "--codex":
        options.codex = String(next ?? "").trim() || options.codex;
        index += 1;
        break;
      case "--code-home":
        options.codexHome = String(next ?? "").trim() || options.codexHome;
        index += 1;
        break;
      case "--browser":
        options.browser = String(next ?? "").trim();
        index += 1;
        break;
      case "--print-only":
        options.printOnly = true;
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(next ?? options.timeoutMs) || options.timeoutMs;
        index += 1;
        break;
      case "--help":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`알 수 없는 옵션입니다: ${token}`);
    }
  }

  return options;
}

function createJsonRpcSession({ codex, codexHome }) {
  const child = spawn(codex, ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CODEX_HOME: codexHome
    }
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
        console.error("[stdout-parse-failed]", rawLine);
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
      } else if (message.method === "account/login/completed") {
        const params = message.params ?? {};
        const loginId = String(params.loginId ?? "").trim();
        const result = {
          loginId,
          success: params.success === true,
          error: params.error ? String(params.error) : ""
        };

        if (loginId && loginWaiters.has(loginId)) {
          const deferred = loginWaiters.get(loginId);
          loginWaiters.delete(loginId);
          deferred.resolve(result);
        } else if (loginId) {
          bufferedLoginResults.set(loginId, result);
        } else {
          console.log("[notify]", rawLine);
        }
      } else if (message.method === "account/updated") {
        const params = message.params ?? {};
        const authMode = typeof params.authMode === "string" ? params.authMode.trim() : null;
        const result = { authMode };
        const waiterIndex = accountUpdateWaiters.findIndex(
          (waiter) => waiter.expectedAuthMode === authMode
        );

        if (waiterIndex >= 0) {
          const [waiter] = accountUpdateWaiters.splice(waiterIndex, 1);
          waiter.resolve(result);
        } else {
          bufferedAccountUpdates.push(result);
        }
      } else {
        console.log("[notify]", rawLine);
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) {
      console.error("[stderr]", text);
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
    const bufferedIndex = bufferedAccountUpdates.findIndex(
      (result) => result.authMode === expectedAuthMode
    );
    if (bufferedIndex >= 0) {
      const [result] = bufferedAccountUpdates.splice(bufferedIndex, 1);
      return Promise.resolve(result);
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        expectedAuthMode,
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

async function openInBrowser(browserName, authUrl) {
  if (!browserName) {
    return;
  }

  const open = spawn("/usr/bin/open", ["-a", browserName, authUrl], {
    stdio: "inherit"
  });

  await new Promise((resolve, reject) => {
    open.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`open 명령 실패: ${code}`));
      }
    });
    open.on("error", reject);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const session = createJsonRpcSession({
    codex: options.codex,
    codexHome: options.codexHome
  });

  try {
    await session.request("initialize", {
      clientInfo: {
        name: "octop-app-server-login-test",
        version: "1.0.0"
      },
      capabilities: {
        experimentalApi: true
      }
    }, options.timeoutMs);

    const result = await session.request("account/login/start", {
      type: "chatgpt"
    }, options.timeoutMs);

    const loginId = String(result?.loginId ?? "").trim();
    const authUrl = String(result?.authUrl ?? "").trim();

    if (!loginId || !authUrl) {
      throw new Error("account/login/start 응답에 loginId 또는 authUrl 이 없습니다.");
    }

    console.log(`loginId=${loginId}`);
    console.log(`authUrl=${authUrl}`);

    if (!options.printOnly && options.browser) {
      await openInBrowser(options.browser, authUrl);
      console.log(`openedBrowser=${options.browser}`);
      const completed = await session.waitForLoginCompleted(loginId, options.timeoutMs);
      console.log(`loginCompleted=${completed.success}`);
      if (!completed.success) {
        throw new Error(completed.error || "로그인 완료 알림이 실패로 돌아왔습니다.");
      }
      const updated = await session.waitForAccountUpdated("chatgpt", options.timeoutMs);
      console.log(`accountUpdated=${updated.authMode ?? "null"}`);
    }
  } finally {
    await session.shutdown();
  }
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
