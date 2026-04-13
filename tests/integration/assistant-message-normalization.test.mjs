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

test("normalizeAssistantMessageContent는 진행 내역 섹션 안에서 반복된 제목 접두어를 제거한다", () => {
  const input = [
    "[목표]",
    "- 요약",
    "",
    PROGRESS_HISTORY_HEADING,
    "- [진행 내역] 코드 확인 완료",
    "[진행 내역] 테스트 준비",
    "",
    "[최종 보고]",
    "- [진행 내역] 문구는 다른 섹션에서 유지"
  ].join("\n");

  const normalized = normalizeAssistantMessageContent(input);

  assert.equal(normalized.includes("- 코드 확인 완료"), true);
  assert.equal(normalized.includes("테스트 준비"), true);
  assert.equal(normalized.includes("- [진행 내역] 문구는 다른 섹션에서 유지"), true);
  assert.equal(normalized.includes("- [진행 내역] 코드 확인 완료"), false);
});
