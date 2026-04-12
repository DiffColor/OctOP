import test from "node:test";
import assert from "node:assert/strict";

import {
  applyCommonBaseInstructionsToProjects,
  DEFAULT_COMMON_BASE_INSTRUCTIONS,
  DEFAULT_COMMON_BASE_INSTRUCTION_SECTIONS,
  deriveCommonBaseInstructions,
  ensureDefaultCommonBaseInstructions
} from "../../services/codex-adapter/src/projectInstructionState.js";

test("deriveCommonBaseInstructions는 명시된 공통값을 우선 사용한다", () => {
  const resolved = deriveCommonBaseInstructions(
    [
      { id: "project-1", base_instructions: "예전 값", updated_at: "2026-03-01T00:00:00.000Z" }
    ],
    { explicitValue: "공통 일반지침" }
  );

  assert.equal(resolved, `공통 일반지침\n\n${DEFAULT_COMMON_BASE_INSTRUCTIONS}`);
});

test("deriveCommonBaseInstructions는 legacy 프로젝트 값이 섞여 있으면 가장 최근 값을 공통값으로 선택한다", () => {
  const resolved = deriveCommonBaseInstructions([
    { id: "project-1", base_instructions: "첫 공통값", updated_at: "2026-03-01T00:00:00.000Z" },
    { id: "project-2", base_instructions: "최신 공통값", updated_at: "2026-03-28T12:00:00.000Z" },
    { id: "project-3", base_instructions: "", updated_at: "2026-03-29T12:00:00.000Z" }
  ]);

  assert.equal(resolved, `최신 공통값\n\n${DEFAULT_COMMON_BASE_INSTRUCTIONS}`);
});

test("applyCommonBaseInstructionsToProjects는 모든 프로젝트에 같은 일반지침을 반영한다", () => {
  const projects = applyCommonBaseInstructionsToProjects(
    [
      { id: "project-1", base_instructions: "", developer_instructions: "A" },
      { id: "project-2", base_instructions: "로컬 값", developer_instructions: "B" }
    ],
    "공통 지침"
  );

  assert.deepEqual(projects, [
    {
      id: "project-1",
      base_instructions: `공통 지침\n\n${DEFAULT_COMMON_BASE_INSTRUCTIONS}`,
      developer_instructions: "A"
    },
    {
      id: "project-2",
      base_instructions: `공통 지침\n\n${DEFAULT_COMMON_BASE_INSTRUCTIONS}`,
      developer_instructions: "B"
    }
  ]);
});

test("ensureDefaultCommonBaseInstructions는 값이 비어 있어도 기본 일반지침을 반환한다", () => {
  assert.equal(ensureDefaultCommonBaseInstructions(""), DEFAULT_COMMON_BASE_INSTRUCTIONS);
});

test("ensureDefaultCommonBaseInstructions는 기본 일반지침이 이미 있으면 중복 추가하지 않는다", () => {
  const existing = `공통 지침\n\n${DEFAULT_COMMON_BASE_INSTRUCTIONS}`;
  assert.equal(ensureDefaultCommonBaseInstructions(existing), existing);
});

test("ensureDefaultCommonBaseInstructions는 기존 값에 누락된 기본 섹션만 추가한다", () => {
  const partial = [
    "사용자 맞춤 일반지침",
    DEFAULT_COMMON_BASE_INSTRUCTION_SECTIONS[0]
  ].join("\n\n");
  const resolved = ensureDefaultCommonBaseInstructions(partial);

  assert.match(resolved, /사용자 맞춤 일반지침/);
  assert.equal(
    resolved.includes(DEFAULT_COMMON_BASE_INSTRUCTION_SECTIONS[0]),
    true
  );
  assert.equal(
    resolved.split(DEFAULT_COMMON_BASE_INSTRUCTION_SECTIONS[0]).length - 1,
    1
  );

  for (const section of DEFAULT_COMMON_BASE_INSTRUCTION_SECTIONS.slice(1)) {
    assert.equal(resolved.includes(section), true);
  }
});
