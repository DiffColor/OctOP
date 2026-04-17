import test from "node:test";
import assert from "node:assert/strict";

import { computeEffectiveAssistantDelta } from "../../services/codex-adapter/src/assistantDelta.js";

test("computeEffectiveAssistantDelta는 반복된 목표/계획 opening chunk를 no-op로 처리한다", () => {
  const previousContent = [
    "[목표]",
    "- 최초 목표",
    "",
    "[계획]",
    "- 영향 범위: 브릿지"
  ].join("\n");

  const duplicateDelta = [
    "",
    "[목표]",
    "- 최초 목표",
    "",
    "[계획]",
    "- 영향 범위: 브릿지"
  ].join("\n");

  const result = computeEffectiveAssistantDelta(previousContent, duplicateDelta);

  assert.equal(result.changed, false);
  assert.equal(result.effectiveDelta, "");
  assert.equal(result.nextContent, previousContent);
});

test("computeEffectiveAssistantDelta는 개행 없이 다시 붙은 중복 opening chunk도 no-op로 처리한다", () => {
  const previousContent = [
    "[목표]",
    "- 최초 목표",
    "",
    "[계획]",
    "- 영향 범위: 브릿지"
  ].join("\n");

  const duplicateDelta = [
    "[목표]",
    "- 최초 목표",
    "",
    "[계획]",
    "- 영향 범위: 브릿지"
  ].join("\n");

  const result = computeEffectiveAssistantDelta(previousContent, duplicateDelta);

  assert.equal(result.changed, false);
  assert.equal(result.effectiveDelta, "");
  assert.equal(result.nextContent, previousContent);
});

test("computeEffectiveAssistantDelta는 진행 내역 이어쓰기만 실제 delta로 남긴다", () => {
  const previousContent = [
    "[목표]",
    "- 최초 목표",
    "",
    "[진행 내역]",
    "- 첫 진행"
  ].join("\n");

  const result = computeEffectiveAssistantDelta(previousContent, "\n[진행 내역]\n- 둘째 진행");

  assert.equal(result.changed, true);
  assert.equal(result.effectiveDelta, "\n\n- 둘째 진행");
  assert.equal(
    result.nextContent,
    [
      "[목표]",
      "- 최초 목표",
      "",
      "[진행 내역]",
      "- 첫 진행",
      "",
      "- 둘째 진행"
    ].join("\n")
  );
});
