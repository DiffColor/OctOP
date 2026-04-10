import test from "node:test";
import assert from "node:assert/strict";

import {
  describeBridgeAppServerHealth,
  evaluateBridgeAppServerRecovery,
  isBridgeAppServerAuthenticationError
} from "../../scripts/local-agent-health.mjs";

test("브릿지 헬스에서 app-server 연결이 끊겨도 런처가 즉시 프로세스를 재시작하지는 않는다", () => {
  const evaluation = evaluateBridgeAppServerRecovery({
    health: {
      status: {
        app_server: {
          connected: false,
          initialized: false,
          last_error: "app-server socket closed"
        }
      }
    },
    consecutiveFailures: 1,
    failureThreshold: 3
  });

  assert.equal(evaluation.usable, true);
  assert.equal(evaluation.healthy, false);
  assert.equal(evaluation.recoverable, false);
  assert.equal(evaluation.nextConsecutiveFailures, 0);
  assert.equal(evaluation.shouldRestart, false);
  assert.match(evaluation.summary, /connected=false/);
});

test("연속 실패 임계치에 도달하면 app-server 제어 재시작을 요청한다", () => {
  const evaluation = evaluateBridgeAppServerRecovery({
    health: {
      status: {
        app_server: {
          connected: true,
          initialized: true,
          last_silent_state_check_error: "thread/list request timeout"
        }
      }
    },
    consecutiveFailures: 2,
    failureThreshold: 3
  });

  assert.equal(evaluation.recoverable, true);
  assert.equal(evaluation.nextConsecutiveFailures, 3);
  assert.equal(evaluation.shouldRestart, true);
  assert.equal(evaluation.reason, "thread/list request timeout");
});

test("작업 실패로 last_error만 남은 경우에는 app-server 제어 재시작을 요청하지 않는다", () => {
  const evaluation = evaluateBridgeAppServerRecovery({
    health: {
      status: {
        app_server: {
          connected: true,
          initialized: true,
          last_error: "running issue backfill failed"
        }
      }
    },
    consecutiveFailures: 2,
    failureThreshold: 3
  });

  assert.equal(evaluation.healthy, true);
  assert.equal(evaluation.recoverable, false);
  assert.equal(evaluation.nextConsecutiveFailures, 0);
  assert.equal(evaluation.shouldRestart, false);
  assert.match(evaluation.summary, /last_error=running issue backfill failed/);
});

test("인증 오류는 재시작 대상에서 제외한다", () => {
  assert.equal(
    isBridgeAppServerAuthenticationError(
      "codex app-server 인증이 필요합니다. WSL에서 `codex login`을 완료한 뒤 bridge와 app-server를 다시 시작하세요."
    ),
    true
  );

  const evaluation = evaluateBridgeAppServerRecovery({
    health: {
      status: {
        app_server: {
          connected: true,
          initialized: true,
          last_error: "codex app-server 인증이 필요합니다."
        }
      }
    },
    consecutiveFailures: 2,
    failureThreshold: 3
  });

  assert.equal(evaluation.recoverable, false);
  assert.equal(evaluation.nextConsecutiveFailures, 0);
  assert.equal(evaluation.shouldRestart, false);
});

test("정상 헬스 상태는 실패 누적을 즉시 해제한다", () => {
  const evaluation = evaluateBridgeAppServerRecovery({
    health: {
      status: {
        app_server: {
          connected: true,
          initialized: true,
          last_error: "",
          last_silent_state_check_error: ""
        }
      }
    },
    consecutiveFailures: 5,
    failureThreshold: 3
  });

  assert.equal(evaluation.healthy, true);
  assert.equal(evaluation.nextConsecutiveFailures, 0);
  assert.equal(evaluation.shouldRestart, false);
  assert.equal(
    describeBridgeAppServerHealth({
      status: {
        app_server: {
          connected: true,
          initialized: true
        }
      }
    }),
    "connected=true, initialized=true"
  );
});
