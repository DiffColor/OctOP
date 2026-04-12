import test from "node:test";
import assert from "node:assert/strict";

import {
  applyCommonBaseInstructionsToProjects,
  DEFAULT_COMMON_BASE_INSTRUCTIONS,
  DEFAULT_COMMON_BASE_INSTRUCTION_SECTIONS,
  deriveCommonBaseInstructions,
  ensureDefaultCommonBaseInstructions
} from "../../services/codex-adapter/src/projectInstructionState.js";

const LEGACY_DEFAULT_COMMON_BASE_INSTRUCTION_SECTIONS = [
  "경로는 프로젝트 루트 기준 상대경로만 쓰고 인라인코드를 사용. 코드는 코드펜스를 사용.",
  "사용자 입력이 작업 방식이나 출력 형식을 직접 지정하면 그 지시를 우선하고, 아래 기본 형식은 충돌하지 않는 범위에서만 따르십시오.",
  "코딩 작업을 시작할 때는 먼저 현재 코드 기준으로 사용자가 이해하기 쉬운 목표 요약, 영향 범위, 작업 계획을 제시하십시오.",
  "이후에는 실제 코드를 읽으며 단계별 진행 상황을 짧고 자연스럽게 계속 보고하고, 같은 접두어를 반복하지 말고 줄바꿈으로 이어가십시오.",
  "마지막에는 변경 사항, 수정 파일, 검증 결과, 남은 이슈를 정리하십시오."
];

const LEGACY_DEFAULT_COMMON_BASE_INSTRUCTIONS =
  LEGACY_DEFAULT_COMMON_BASE_INSTRUCTION_SECTIONS.join("\n\n");

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

test("ensureDefaultCommonBaseInstructions는 구버전 기본 지침만 저장돼 있어도 새 포맷 섹션을 추가한다", () => {
  const resolved = ensureDefaultCommonBaseInstructions(LEGACY_DEFAULT_COMMON_BASE_INSTRUCTIONS);

  assert.equal(resolved.includes("[작업 계획]"), true);
  assert.equal(resolved.includes("[진행 내역]"), true);
  assert.equal(resolved.includes("[최종 정리]"), true);
});
