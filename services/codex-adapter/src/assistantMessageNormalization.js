export const PROGRESS_HISTORY_HEADING = "[진행 내역]";

export function normalizeAssistantMessageContent(content = "") {
  const normalized = String(content ?? "");

  if (!normalized) {
    return "";
  }

  const lines = normalized.split("\n");
  const result = [];
  let seenProgressHistoryHeading = false;
  let skippedDuplicateHeading = false;

  for (const line of lines) {
    const trimmed = String(line ?? "").trim();

    if (trimmed === PROGRESS_HISTORY_HEADING) {
      if (seenProgressHistoryHeading) {
        skippedDuplicateHeading = true;
        continue;
      }

      seenProgressHistoryHeading = true;
      skippedDuplicateHeading = false;
      result.push(PROGRESS_HISTORY_HEADING);
      continue;
    }

    if (skippedDuplicateHeading && trimmed === "" && String(result.at(-1) ?? "").trim() === "") {
      continue;
    }

    skippedDuplicateHeading = false;
    result.push(line);
  }

  return result.join("\n");
}
