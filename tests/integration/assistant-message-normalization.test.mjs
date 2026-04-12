import test from "node:test";
import assert from "node:assert/strict";

import {
  PROGRESS_HISTORY_HEADING,
  normalizeAssistantMessageContent
} from "../../services/codex-adapter/src/assistantMessageNormalization.js";

test("normalizeAssistantMessageContent는 반복된 진행 내역 제목을 한 번만 남긴다", () => {
  const input = [
    "[목표]",
    "- 요약",
    "",
    PROGRESS_HISTORY_HEADING,
    "- 첫 번째 진행",
    "",
    PROGRESS_HISTORY_HEADING,
    "- 두 번째 진행"
  ].join("\n");

  const normalized = normalizeAssistantMessageContent(input);

  assert.equal(
    normalized
      .split("\n")
      .filter((line) => line.trim() === PROGRESS_HISTORY_HEADING).length,
    1
  );
  assert.equal(normalized.includes("- 첫 번째 진행"), true);
  assert.equal(normalized.includes("- 두 번째 진행"), true);
});

test("normalizeAssistantMessageContent는 문장 안의 진행 내역 텍스트는 유지한다", () => {
  const input = `설명 문장 안의 ${PROGRESS_HISTORY_HEADING} 표기는 유지합니다.`;

  assert.equal(normalizeAssistantMessageContent(input), input);
});
