import { normalizeAssistantMessageContent } from "./assistantMessageNormalization.js";

export function findLatestLiveAssistantMessageIndex(messages = [], issueId = null) {
  const normalizedIssueId = String(issueId ?? "").trim();

  for (let index = (Array.isArray(messages) ? messages.length : 0) - 1; index >= 0; index -= 1) {
    const candidate = messages[index];

    if (!candidate) {
      continue;
    }

    const candidateIssueId = String(candidate.issue_id ?? "").trim();
    const role = String(candidate.role ?? "").trim();
    const kind = String(candidate.kind ?? "message").trim() || "message";

    if (normalizedIssueId && candidateIssueId !== normalizedIssueId) {
      continue;
    }

    if (role === "assistant" && kind === "message") {
      return index;
    }

    if (role === "user" && kind === "prompt" && (!normalizedIssueId || candidateIssueId === normalizedIssueId)) {
      break;
    }
  }

  return -1;
}

export function appendLiveAssistantDelta(messages = [], options = {}) {
  const nextMessages = Array.isArray(messages) ? [...messages] : [];
  const normalizedDelta = String(options?.delta ?? "");

  if (!normalizedDelta) {
    return nextMessages;
  }

  const normalizedIssueId = String(options?.issueId ?? "").trim() || null;
  const timestamp = options?.timestamp ?? new Date().toISOString();
  const targetIndex = findLatestLiveAssistantMessageIndex(nextMessages, normalizedIssueId);

  if (targetIndex >= 0) {
    const currentMessage = nextMessages[targetIndex] ?? {};

    nextMessages[targetIndex] = {
      ...currentMessage,
      content: normalizeAssistantMessageContent(`${currentMessage.content ?? ""}${normalizedDelta}`),
      timestamp,
      issue_id: normalizedIssueId ?? currentMessage.issue_id ?? null,
      issue_title: currentMessage.issue_title ?? options?.issueTitle ?? "",
      issue_status: currentMessage.issue_status ?? options?.issueStatus ?? "running"
    };

    return nextMessages;
  }

  nextMessages.push({
    id: `${normalizedIssueId || "assistant"}-${Date.now()}`,
    role: "assistant",
    kind: "message",
    content: normalizeAssistantMessageContent(normalizedDelta),
    timestamp,
    issue_id: normalizedIssueId,
    issue_title: options?.issueTitle ?? "",
    issue_status: options?.issueStatus ?? "running"
  });

  return nextMessages;
}
