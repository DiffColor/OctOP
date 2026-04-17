import { normalizeAssistantMessageContent } from "./assistantMessageNormalization.js";

const ASSISTANT_SECTION_HEADING_START_PATTERN =
  /^\s*\[(목표|계획|작업 계획|진행 내역|최종 보고|최종 정리)\](?:\s|$)/;
const COMPARABLE_SECTION_HEADING_PATTERN = /^\[[^\]]+\]$/;
const COMPARABLE_PROGRESS_HISTORY_HEADING = "[진행 내역]";
const COMPARABLE_REPEATED_PROGRESS_PREFIX_PATTERN =
  /^(\s*[-*]\s*)?\[진행 내역\](?:\s*[:：-]\s*)?(.*)$/;
const COMPARABLE_SINGLE_INSTANCE_SECTION_HEADINGS = new Set([
  "[목표]",
  "[계획]",
  "[작업 계획]",
  "[최종 보고]",
  "[최종 정리]"
]);
const OVERLAP_BOUNDARY_PATTERN = /[\s.,!?;:()[\]{}"'`“”‘’\-]/u;
const MIN_ASSISTANT_DELTA_OVERLAP_LENGTH = 2;

function normalizeAssistantDeltaJoin(previousContent = "", delta = "") {
  const normalizedPreviousContent = String(previousContent ?? "");
  const rawDelta = String(delta ?? "");

  if (!normalizedPreviousContent || !rawDelta) {
    return `${normalizedPreviousContent}${rawDelta}`;
  }

  if (
    !normalizedPreviousContent.endsWith("\n") &&
    ASSISTANT_SECTION_HEADING_START_PATTERN.test(rawDelta)
  ) {
    return `${normalizedPreviousContent}\n${rawDelta}`;
  }

  return `${normalizedPreviousContent}${rawDelta}`;
}

function normalizeComparableProgressHistoryLine(line = "", insideProgressHistorySection = false) {
  if (!insideProgressHistorySection) {
    return String(line ?? "");
  }

  const normalizedLine = String(line ?? "");
  const match = normalizedLine.match(COMPARABLE_REPEATED_PROGRESS_PREFIX_PATTERN);

  if (!match) {
    return normalizedLine;
  }

  const [, bullet = "", rest = ""] = match;
  const normalizedRest = String(rest ?? "").replace(/^\s+/, "");

  if (!normalizedRest.trim()) {
    return "";
  }

  return `${bullet}${normalizedRest}`;
}

function normalizeComparableAssistantContent(content = "") {
  const normalized = String(content ?? "");

  if (!normalized) {
    return "";
  }

  const lines = normalized.split("\n");
  const result = [];
  const seenSingleInstanceSectionHeadings = new Set();
  let seenProgressHistoryHeading = false;
  let skippedDuplicateHeading = false;
  let insideProgressHistorySection = false;
  let insideSkippedSingleInstanceSection = false;

  for (const line of lines) {
    const trimmed = String(line ?? "").trim();
    const isSectionHeading = COMPARABLE_SECTION_HEADING_PATTERN.test(trimmed);

    if (isSectionHeading && COMPARABLE_SINGLE_INSTANCE_SECTION_HEADINGS.has(trimmed)) {
      insideProgressHistorySection = false;
      skippedDuplicateHeading = false;

      if (seenSingleInstanceSectionHeadings.has(trimmed)) {
        insideSkippedSingleInstanceSection = true;
        continue;
      }

      seenSingleInstanceSectionHeadings.add(trimmed);
      insideSkippedSingleInstanceSection = false;
      result.push(trimmed);
      continue;
    }

    if (trimmed === COMPARABLE_PROGRESS_HISTORY_HEADING) {
      if (seenProgressHistoryHeading) {
        skippedDuplicateHeading = true;
        insideSkippedSingleInstanceSection = false;
        continue;
      }

      seenProgressHistoryHeading = true;
      skippedDuplicateHeading = false;
      insideProgressHistorySection = true;
      insideSkippedSingleInstanceSection = false;
      result.push(COMPARABLE_PROGRESS_HISTORY_HEADING);
      continue;
    }

    if (isSectionHeading) {
      insideProgressHistorySection = false;
      insideSkippedSingleInstanceSection = false;
    }

    if (insideSkippedSingleInstanceSection) {
      continue;
    }

    const normalizedLine = normalizeComparableProgressHistoryLine(line, insideProgressHistorySection);
    const normalizedTrimmed = normalizedLine.trim();

    if (skippedDuplicateHeading && normalizedTrimmed === "" && String(result.at(-1) ?? "").trim() === "") {
      continue;
    }

    skippedDuplicateHeading = false;
    result.push(normalizedLine);
  }

  return result.join("\n");
}

function isOverlapBoundaryCharacter(character = "") {
  return OVERLAP_BOUNDARY_PATTERN.test(String(character ?? ""));
}

function hasSafeAssistantDeltaOverlap(previousContent = "", delta = "", overlapLength = 0) {
  if (overlapLength < MIN_ASSISTANT_DELTA_OVERLAP_LENGTH) {
    return false;
  }

  const normalizedPreviousContent = String(previousContent ?? "");
  const rawDelta = String(delta ?? "");
  const overlapStartIndex = normalizedPreviousContent.length - overlapLength;
  const overlapEndIndex = overlapLength;
  const previousBoundaryCharacter =
    overlapStartIndex > 0 ? normalizedPreviousContent.charAt(overlapStartIndex - 1) : "";
  const deltaBoundaryCharacter =
    overlapEndIndex < rawDelta.length ? rawDelta.charAt(overlapEndIndex) : "";

  return (
    overlapStartIndex === 0 ||
    overlapEndIndex === rawDelta.length ||
    isOverlapBoundaryCharacter(previousBoundaryCharacter) ||
    isOverlapBoundaryCharacter(deltaBoundaryCharacter)
  );
}

function trimOverlappingAssistantDelta(previousContent = "", delta = "") {
  const normalizedPreviousContent = String(previousContent ?? "");
  const rawDelta = String(delta ?? "");
  const maxOverlapLength = Math.min(normalizedPreviousContent.length, rawDelta.length);

  if (!normalizedPreviousContent || !rawDelta || maxOverlapLength < MIN_ASSISTANT_DELTA_OVERLAP_LENGTH) {
    return rawDelta;
  }

  for (let overlapLength = maxOverlapLength; overlapLength >= MIN_ASSISTANT_DELTA_OVERLAP_LENGTH; overlapLength -= 1) {
    const deltaPrefix = rawDelta.slice(0, overlapLength);

    if (!normalizedPreviousContent.endsWith(deltaPrefix)) {
      continue;
    }

    if (!hasSafeAssistantDeltaOverlap(normalizedPreviousContent, rawDelta, overlapLength)) {
      continue;
    }

    return rawDelta.slice(overlapLength);
  }

  return rawDelta;
}

function collapseAdjacentDuplicateAssistantLines(content = "") {
  const lines = String(content ?? "").split("\n");
  const result = [];
  let lastNonEmptyIndex = -1;

  for (const rawLine of lines) {
    const line = String(rawLine ?? "");
    const trimmed = line.trim();

    if (!trimmed) {
      result.push(line);
      continue;
    }

    if (lastNonEmptyIndex >= 0 && String(result[lastNonEmptyIndex] ?? "").trim() === trimmed) {
      while (result.length > lastNonEmptyIndex + 1 && String(result.at(-1) ?? "").trim() === "") {
        result.pop();
      }

      continue;
    }

    result.push(line);
    lastNonEmptyIndex = result.length - 1;
  }

  return result.join("\n");
}

function trimLeadingBlankLines(content = "") {
  return String(content ?? "").replace(/^(?:\s*\n)+/u, "");
}

function getAssistantReplacementMode(previousContent = "", delta = "") {
  const comparablePreviousContent = normalizeComparableAssistantContent(previousContent).trim();
  const comparableDelta = normalizeComparableAssistantContent(delta).trim();

  if (!comparablePreviousContent || !comparableDelta) {
    return "";
  }

  if (comparableDelta === comparablePreviousContent) {
    return "same";
  }

  if (comparableDelta.startsWith(comparablePreviousContent)) {
    return "expanded";
  }

  return "";
}

export function mergeAssistantDeltaContent(previousContent = "", delta = "") {
  const normalizedPreviousContent = normalizeAssistantMessageContent(String(previousContent ?? ""));
  const normalizedDelta = normalizeAssistantMessageContent(String(delta ?? ""));
  const replacementMode = getAssistantReplacementMode(normalizedPreviousContent, normalizedDelta);

  if (replacementMode === "same") {
    return normalizedPreviousContent;
  }

  if (replacementMode === "expanded") {
    return collapseAdjacentDuplicateAssistantLines(trimLeadingBlankLines(normalizedDelta));
  }

  const effectiveRawDelta = trimOverlappingAssistantDelta(normalizedPreviousContent, delta);

  return collapseAdjacentDuplicateAssistantLines(
    normalizeAssistantMessageContent(
    normalizeAssistantDeltaJoin(normalizedPreviousContent, effectiveRawDelta)
    )
  );
}

export function computeEffectiveAssistantDelta(previousContent = "", delta = "") {
  const normalizedPreviousContent = normalizeAssistantMessageContent(String(previousContent ?? ""));
  const rawDelta = String(delta ?? "");

  if (!rawDelta) {
    return {
      changed: false,
      effectiveDelta: "",
      previousContent: normalizedPreviousContent,
      nextContent: normalizedPreviousContent
    };
  }

  const effectiveRawDelta = trimOverlappingAssistantDelta(normalizedPreviousContent, rawDelta);
  const normalizedNextContent = mergeAssistantDeltaContent(normalizedPreviousContent, rawDelta);
  const comparablePreviousContent = normalizeComparableAssistantContent(normalizedPreviousContent).replace(/\s+$/u, "");
  const comparableNextContent = normalizeComparableAssistantContent(normalizedNextContent).replace(/\s+$/u, "");

  if (!normalizedNextContent || comparableNextContent === comparablePreviousContent) {
    return {
      changed: false,
      effectiveDelta: "",
      previousContent: normalizedPreviousContent,
      nextContent: normalizedPreviousContent
    };
  }

  if (normalizedNextContent.startsWith(normalizedPreviousContent)) {
    return {
      changed: true,
      effectiveDelta: normalizedNextContent.slice(normalizedPreviousContent.length),
      previousContent: normalizedPreviousContent,
      nextContent: normalizedNextContent
    };
  }

  return {
    changed: true,
    effectiveDelta: effectiveRawDelta,
    previousContent: normalizedPreviousContent,
    nextContent: normalizedNextContent
  };
}
