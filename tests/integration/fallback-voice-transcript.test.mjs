import test from "node:test";
import assert from "node:assert/strict";
import { collapseFinalTranscriptEntries } from "../../apps/mobile/src/voice/useFallbackVoiceSession.js";

test("같은 발화의 누적 final index 체인은 마지막 확정 문장만 남긴다", () => {
  const collapsedEntries = collapseFinalTranscriptEntries([
    [0, "중복이 좀"],
    [1, "중복이 좀 처리"],
    [2, "중복이 좀 처리 안 돼"]
  ]);

  assert.deepEqual(collapsedEntries, [[2, "중복이 좀 처리 안 돼"]]);
});

test("같은 final result가 새 index로 반복되면 마지막 index 하나만 남긴다", () => {
  const collapsedEntries = collapseFinalTranscriptEntries([
    [0, "반복 발화"],
    [1, "반복 발화"]
  ]);

  assert.deepEqual(collapsedEntries, [[1, "반복 발화"]]);
});

test("겹치지 않는 별도 final 결과는 그대로 유지한다", () => {
  const collapsedEntries = collapseFinalTranscriptEntries([
    [0, "첫 번째 문장"],
    [1, "두 번째 문장"]
  ]);

  assert.deepEqual(collapsedEntries, [
    [0, "첫 번째 문장"],
    [1, "두 번째 문장"]
  ]);
});
