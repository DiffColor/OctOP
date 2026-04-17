import test from "node:test";
import assert from "node:assert/strict";

import { resolveRealtimeProgressText } from "../../packages/domain/src/index.js";

test("resolveRealtimeProgressText는 idle 상태의 완료 스레드를 마무리 정리 중으로 표시하지 않는다", () => {
  assert.equal(
    resolveRealtimeProgressText(
      {
        status: "idle",
        last_event: "turn.completed"
      },
      { language: "ko" }
    ),
    "다음 작업 대기 중"
  );
});

test("resolveRealtimeProgressText는 running 상태에서만 turn.completed를 마무리 정리 중으로 표시한다", () => {
  assert.equal(
    resolveRealtimeProgressText(
      {
        status: "running",
        last_event: "turn.completed"
      },
      { language: "ko" }
    ),
    "마무리 정리 중"
  );
});

test("resolveRealtimeProgressText는 영어 idle 완료 스레드를 Waiting for next task로 표시한다", () => {
  assert.equal(
    resolveRealtimeProgressText(
      {
        status: "idle",
        last_event: "turn.completed"
      },
      { language: "en" }
    ),
    "Waiting for next task"
  );
});
