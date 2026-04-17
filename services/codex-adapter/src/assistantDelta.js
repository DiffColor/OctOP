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

  const normalizedNextContent = normalizeAssistantMessageContent(
    normalizeAssistantDeltaJoin(normalizedPreviousContent, rawDelta)
  );
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
    effectiveDelta: rawDelta,
    previousContent: normalizedPreviousContent,
    nextContent: normalizedNextContent
  };
}
