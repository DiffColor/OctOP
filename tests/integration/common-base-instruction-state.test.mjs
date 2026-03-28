import test from "node:test";
import assert from "node:assert/strict";

import {
  applyCommonBaseInstructionsToProjects,
  deriveCommonBaseInstructions
} from "../../services/codex-adapter/src/projectInstructionState.js";

test("deriveCommonBaseInstructions는 명시된 공통값을 우선 사용한다", () => {
  const resolved = deriveCommonBaseInstructions(
    [
      { id: "project-1", base_instructions: "예전 값", updated_at: "2026-03-01T00:00:00.000Z" }
    ],
    { explicitValue: "공통 일반지침" }
  );

  assert.equal(resolved, "공통 일반지침");
});

test("deriveCommonBaseInstructions는 legacy 프로젝트 값이 섞여 있으면 가장 최근 값을 공통값으로 선택한다", () => {
  const resolved = deriveCommonBaseInstructions([
    { id: "project-1", base_instructions: "첫 공통값", updated_at: "2026-03-01T00:00:00.000Z" },
    { id: "project-2", base_instructions: "최신 공통값", updated_at: "2026-03-28T12:00:00.000Z" },
    { id: "project-3", base_instructions: "", updated_at: "2026-03-29T12:00:00.000Z" }
  ]);

  assert.equal(resolved, "최신 공통값");
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
    { id: "project-1", base_instructions: "공통 지침", developer_instructions: "A" },
    { id: "project-2", base_instructions: "공통 지침", developer_instructions: "B" }
  ]);
});
