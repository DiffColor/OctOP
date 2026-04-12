function normalizeInstructionText(value) {
  return String(value ?? "").trim();
}

export const DEFAULT_COMMON_BASE_INSTRUCTION_SECTIONS = [
  "경로는 프로젝트 루트 기준 상대경로만 쓰고 인라인코드를 사용. 코드는 코드펜스를 사용.",
  "사용자 입력이 작업 방식이나 출력 형식을 직접 지정하면 그 지시를 우선하고, 아래 기본 형식은 충돌하지 않는 범위에서만 따르십시오.",
  "코딩 작업을 시작할 때는 먼저 현재 코드 기준으로 사용자가 이해하기 쉬운 목표 요약, 영향 범위, 작업 계획을 제시하십시오.",
  "이후에는 실제 코드를 읽으며 단계별 진행 상황을 짧고 자연스럽게 계속 보고하고, 같은 접두어를 반복하지 말고 줄바꿈으로 이어가십시오.",
  "마지막에는 변경 사항, 수정 파일, 검증 결과, 남은 이슈를 정리하십시오."
];

export const DEFAULT_COMMON_BASE_INSTRUCTIONS =
  DEFAULT_COMMON_BASE_INSTRUCTION_SECTIONS.join("\n\n");

export function ensureDefaultCommonBaseInstructions(value = "") {
  const normalized = normalizeInstructionText(value);

  if (!normalized) {
    return DEFAULT_COMMON_BASE_INSTRUCTIONS;
  }

  const missingSections = DEFAULT_COMMON_BASE_INSTRUCTION_SECTIONS
    .filter((section) => !normalized.includes(section));

  if (missingSections.length === 0) {
    return normalized;
  }

  return `${normalized}\n\n${missingSections.join("\n\n")}`;
}

function parseProjectUpdatedAt(project = {}) {
  const timestamp = Date.parse(String(project?.updated_at ?? "").trim());
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

export function deriveCommonBaseInstructions(projects = [], options = {}) {
  const hasExplicitValue = Object.prototype.hasOwnProperty.call(options, "explicitValue");

  if (hasExplicitValue) {
    return ensureDefaultCommonBaseInstructions(options.explicitValue);
  }

  const candidates = (Array.isArray(projects) ? projects : [])
    .map((project) => ({
      baseInstructions: normalizeInstructionText(project?.base_instructions ?? project?.baseInstructions),
      updatedAtMs: parseProjectUpdatedAt(project)
    }))
    .filter((candidate) => candidate.baseInstructions);

  if (candidates.length === 0) {
    return ensureDefaultCommonBaseInstructions("");
  }

  return ensureDefaultCommonBaseInstructions(candidates.reduce((latest, candidate) => (
    candidate.updatedAtMs >= latest.updatedAtMs ? candidate : latest
  )).baseInstructions);
}

export function applyCommonBaseInstructionsToProjects(projects = [], commonBaseInstructions = "") {
  const normalizedBaseInstructions = ensureDefaultCommonBaseInstructions(commonBaseInstructions);

  return (Array.isArray(projects) ? projects : []).map((project) => {
    if (!project || typeof project !== "object") {
      return project;
    }

    return {
      ...project,
      base_instructions: normalizedBaseInstructions
    };
  });
}
