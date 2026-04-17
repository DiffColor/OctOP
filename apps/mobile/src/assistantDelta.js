import { normalizeAssistantMessageContent } from "./assistantMessageNormalization.js";

const OVERLAP_BOUNDARY_PATTERN = /[\s.,!?;:()[\]{}"'`“”‘’\-]/u;
const MIN_ASSISTANT_DELTA_OVERLAP_LENGTH = 2;
const ASSISTANT_SECTION_HEADING_START_PATTERN =
  /^\s*\[(목표|계획|작업 계획|진행 내역|최종 보고|최종 정리)\](?:\s|$)/;

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

export function mergeAssistantDeltaContent(previousContent = "", delta = "") {
  const normalizedPreviousContent = normalizeAssistantMessageContent(String(previousContent ?? ""));
  const effectiveRawDelta = trimOverlappingAssistantDelta(normalizedPreviousContent, delta);

  return normalizeAssistantMessageContent(
    normalizeAssistantDeltaJoin(normalizedPreviousContent, effectiveRawDelta)
  );
}
