function normalizeInstructionText(value) {
  return String(value ?? "").trim();
}

function parseProjectUpdatedAt(project = {}) {
  const timestamp = Date.parse(String(project?.updated_at ?? "").trim());
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

export function deriveCommonBaseInstructions(projects = [], options = {}) {
  const hasExplicitValue = Object.prototype.hasOwnProperty.call(options, "explicitValue");

  if (hasExplicitValue) {
    return normalizeInstructionText(options.explicitValue);
  }

  const candidates = (Array.isArray(projects) ? projects : [])
    .map((project) => ({
      baseInstructions: normalizeInstructionText(project?.base_instructions ?? project?.baseInstructions),
      updatedAtMs: parseProjectUpdatedAt(project)
    }))
    .filter((candidate) => candidate.baseInstructions);

  if (candidates.length === 0) {
    return "";
  }

  return candidates.reduce((latest, candidate) => (
    candidate.updatedAtMs >= latest.updatedAtMs ? candidate : latest
  )).baseInstructions;
}

export function applyCommonBaseInstructionsToProjects(projects = [], commonBaseInstructions = "") {
  const normalizedBaseInstructions = normalizeInstructionText(commonBaseInstructions);

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
