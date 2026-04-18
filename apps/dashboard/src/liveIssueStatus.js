function normalizeTerminalThreadIssueStatus(statusType = "") {
  switch (String(statusType ?? "").trim()) {
    case "waitingForInput":
      return "awaiting_input";
    case "error":
      return "failed";
    case "idle":
    case "completed":
      return "completed";
    case "interrupted":
    case "cancelled":
    case "canceled":
      return "interrupted";
    default:
      return "";
  }
}

export function resolveLiveIssueStatusUpdate(event, activeIssueId = "") {
  const payload = event?.payload ?? {};
  const issueId = String(payload.issue_id ?? payload.issueId ?? activeIssueId ?? "").trim();

  if (event?.type === "turn.completed") {
    return {
      issueId,
      status: payload.turn?.status === "completed" ? "completed" : "failed"
    };
  }

  if (event?.type !== "thread.status.changed") {
    return null;
  }

  const nextStatus = normalizeTerminalThreadIssueStatus(payload.status?.type ?? "");

  if (!nextStatus) {
    return null;
  }

  return {
    issueId,
    status: nextStatus
  };
}

export function applyLiveIssueStatusUpdate(issues = [], update = null, updatedAt = new Date().toISOString()) {
  const normalizedIssueId = String(update?.issueId ?? "").trim();
  const normalizedStatus = String(update?.status ?? "").trim();

  if (!normalizedIssueId || !normalizedStatus || !Array.isArray(issues) || issues.length === 0) {
    return issues;
  }

  let changed = false;
  const nextIssues = issues.map((issue) => {
    if (String(issue?.id ?? "").trim() !== normalizedIssueId) {
      return issue;
    }

    const currentStatus = String(issue?.status ?? "").trim();

    if (currentStatus === normalizedStatus) {
      return issue;
    }

    changed = true;
    return {
      ...issue,
      status: normalizedStatus,
      updated_at: issue?.updated_at ?? updatedAt
    };
  });

  return changed ? nextIssues : issues;
}

export function applyLiveMessageIssueStatusUpdate(messages = [], update = null) {
  const normalizedIssueId = String(update?.issueId ?? "").trim();
  const normalizedStatus = String(update?.status ?? "").trim();

  if (!normalizedIssueId || !normalizedStatus || !Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  let changed = false;
  const nextMessages = messages.map((message) => {
    if (String(message?.issue_id ?? "").trim() !== normalizedIssueId) {
      return message;
    }

    const currentStatus = String(message?.issue_status ?? "").trim();

    if (currentStatus === normalizedStatus) {
      return message;
    }

    changed = true;
    return {
      ...message,
      issue_status: normalizedStatus
    };
  });

  return changed ? nextMessages : messages;
}
