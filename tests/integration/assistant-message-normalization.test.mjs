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

test("normalizeAssistantMessageContent는 반복된 목표와 계획 섹션을 뒤쪽 중복부터 제거한다", () => {
  const input = [
    "[목표]",
    "- 최초 목표",
    "",
    "[계획]",
    "- 영향 범위: 최초 범위",
    "- 작업 단계:",
    "  1. 최초 단계",
    "",
    "[목표]",
    "- 중복 목표",
    "",
    "[계획]",
    "- 영향 범위: 중복 범위",
    "- 작업 단계:",
    "  1. 중복 단계",
    "",
    PROGRESS_HISTORY_HEADING,
    "- 실제 진행"
  ].join("\n");

  const normalized = normalizeAssistantMessageContent(input);

  assert.equal(normalized.split("\n").filter((line) => line.trim() === "[목표]").length, 1);
  assert.equal(normalized.split("\n").filter((line) => line.trim() === "[계획]").length, 1);
  assert.equal(normalized.includes("- 최초 목표"), true);
  assert.equal(normalized.includes("- 중복 목표"), false);
  assert.equal(normalized.includes("- 영향 범위: 최초 범위"), true);
  assert.equal(normalized.includes("- 영향 범위: 중복 범위"), false);
  assert.equal(normalized.includes("- 실제 진행"), true);
});

test("normalizeAssistantMessageContent는 반복된 최종 보고 섹션을 유지한다", () => {
  const input = [
    "[최종 보고]",
    "- 변경 사항: 첫 보고",
    "",
    "[최종 보고]",
    "- 변경 사항: 중복 보고",
    "- 수정 파일: duplicate.js"
  ].join("\n");

  const normalized = normalizeAssistantMessageContent(input);

  assert.equal(normalized.split("\n").filter((line) => line.trim() === "[최종 보고]").length, 2);
  assert.equal(normalized.includes("- 변경 사항: 첫 보고"), true);
  assert.equal(normalized.includes("- 변경 사항: 중복 보고"), true);
  assert.equal(normalized.includes("duplicate.js"), true);
});
