function normalizeInstructionText(value) {
  return String(value ?? "").trim();
}

export const DEFAULT_COMMON_BASE_INSTRUCTION_SECTIONS = [
  "경로는 프로젝트 루트 기준 상대경로만 쓰고 인라인코드를 사용. 코드는 코드펜스를 사용.",
  "사용자 입력이 작업 방식이나 출력 형식을 직접 지정하면 그 지시를 우선하고, 아래 기본 형식은 충돌하지 않는 범위에서만 따르십시오.",
  "각 섹션 제목 앞뒤로 한 줄씩 비우고, 섹션 안의 항목 사이에도 한 줄 공백을 넣어 사용자 친화적으로 구분하십시오.",
  [
    "코딩 작업을 시작할 때는 반드시 아래 사용자 친화적인 보고 형식으로 각 항목을 분리해 제시하십시오.",
    "[목표]",
    "- 현재 코드 기준으로 이번 작업의 목표와 기대 결과를 한눈에 이해되게 정리합니다."
  ].join("\n"),
  [
    "[계획]",
    "- 영향 범위: 수정하거나 확인할 파일, 기능, 검증 범위를 적습니다.",
    "- 작업 단계: 번호 목록으로 실행 순서를 적습니다."
  ].join("\n"),
  [
    "실제 코드를 읽기 시작한 뒤의 상태 보고는 반드시 별도 섹션으로 유지하십시오.",
    "[진행 내역]",
    "- 해당 제목은 한 번만 쓰고, 같은 제목이나 접두어를 반복하지 않습니다.",
    "- 실제로 확인한 코드와 수행한 작업만 짧게 누적합니다.",
    "- 각 진행 항목은 줄바꿈 후 한 줄 공백을 두고 이어서 적습니다.",
    "- 작업 계획과 같은 문단에 섞지 말고, 줄바꿈으로 구분해 이어갑니다.",
    "- 같은 접두어를 반복하지 말고 자연스럽게 이어서 보고합니다."
  ].join("\n"),
  [
    "마지막 보고도 반드시 별도 섹션으로 정리하십시오.",
    "[최종 보고]",
    "- 변경 사항:",
    "- 수정 파일:",
    "- 검증 결과:",
    "- 남은 이슈:",
    "- 각 항목 사이는 한 줄씩 띄워 읽기 쉽게 정리합니다."
  ].join("\n")
];

export const DEFAULT_COMMON_BASE_INSTRUCTIONS =
  DEFAULT_COMMON_BASE_INSTRUCTION_SECTIONS.join("\n\n");

function resolveMissingSections(normalized = "") {
  const missingSections = [];

  for (const section of DEFAULT_COMMON_BASE_INSTRUCTION_SECTIONS) {
    if (normalized.includes(section)) {
      continue;
    }

    const sectionLines = section
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const hasPartialLine = sectionLines.some((line) => normalized.includes(line));

    if (!hasPartialLine || sectionLines.length <= 1) {
      missingSections.push(section);
      continue;
    }

    const missingLines = sectionLines.filter((line) => !normalized.includes(line));

    if (missingLines.length > 0) {
      missingSections.push(missingLines.join("\n"));
    }
  }

  return missingSections;
}

export function ensureDefaultCommonBaseInstructions(value = "") {
  const normalized = normalizeInstructionText(value);

  if (!normalized) {
    return DEFAULT_COMMON_BASE_INSTRUCTIONS;
  }

  const missingSections = resolveMissingSections(normalized);

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
