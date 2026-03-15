export const WORKFLOW_STATUSES = {
  BACKLOG: "backlog",
  READY: "ready",
  IN_PROGRESS: "in_progress",
  BLOCKED: "blocked",
  IN_REVIEW: "in_review",
  DONE: "done",
  ARCHIVED: "archived"
};

export const EXECUTION_STATUSES = {
  QUEUED: "queued",
  DISPATCHING: "dispatching",
  RUNNING: "running",
  AWAITING_APPROVAL: "awaiting_approval",
  PAUSED: "paused",
  FAILED: "failed",
  CANCELLED: "cancelled",
  COMPLETED: "completed"
};

export const ISSUE_TRANSITIONS = {
  [WORKFLOW_STATUSES.BACKLOG]: [WORKFLOW_STATUSES.READY],
  [WORKFLOW_STATUSES.READY]: [WORKFLOW_STATUSES.IN_PROGRESS],
  [WORKFLOW_STATUSES.IN_PROGRESS]: [
    WORKFLOW_STATUSES.BLOCKED,
    WORKFLOW_STATUSES.IN_REVIEW
  ],
  [WORKFLOW_STATUSES.BLOCKED]: [WORKFLOW_STATUSES.READY],
  [WORKFLOW_STATUSES.IN_REVIEW]: [
    WORKFLOW_STATUSES.IN_PROGRESS,
    WORKFLOW_STATUSES.DONE
  ],
  [WORKFLOW_STATUSES.DONE]: [WORKFLOW_STATUSES.ARCHIVED],
  [WORKFLOW_STATUSES.ARCHIVED]: []
};

export function isAllowedIssueTransition(fromStatus, toStatus) {
  return ISSUE_TRANSITIONS[fromStatus]?.includes(toStatus) ?? false;
}

export function sanitizeUserId(userId = "local-user") {
  const normalized = String(userId).trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  return normalized || "local-user";
}

export function sanitizeBridgeId(bridgeId = "local-bridge") {
  const normalized = String(bridgeId).trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  return normalized || "local-bridge";
}

export function bridgeSubjects(userId, bridgeId = "local-bridge") {
  const uid = sanitizeUserId(userId);
  const bid = sanitizeBridgeId(bridgeId);
  const base = `octop.user.${uid}.bridge.${bid}`;

  return {
    bridgeId: bid,
    statusGet: `${base}.status.get`,
    projectsGet: `${base}.projects.get`,
    todoChatsGet: `${base}.todo.chats.get`,
    todoChatCreate: `${base}.todo.chat.create`,
    todoChatUpdate: `${base}.todo.chat.update`,
    todoChatDelete: `${base}.todo.chat.delete`,
    todoMessagesGet: `${base}.todo.messages.get`,
    todoMessageCreate: `${base}.todo.message.create`,
    todoMessageUpdate: `${base}.todo.message.update`,
    todoMessageDelete: `${base}.todo.message.delete`,
    todoMessageTransfer: `${base}.todo.message.transfer`,
    projectCreate: `${base}.project.create`,
    projectUpdate: `${base}.project.update`,
    projectDelete: `${base}.project.delete`,
    workspaceRootsGet: `${base}.workspace.roots.get`,
    folderListGet: `${base}.folder.list.get`,
    projectThreadsGet: `${base}.project.threads.get`,
    projectThreadCreate: `${base}.project.thread.create`,
    projectThreadUpdate: `${base}.project.thread.update`,
    projectThreadDelete: `${base}.project.thread.delete`,
    projectThreadRollover: `${base}.project.thread.rollover`,
    threadTimelineGet: `${base}.thread.timeline.get`,
    threadContinuityGet: `${base}.thread.continuity.get`,
    threadIssuesGet: `${base}.thread.issues.get`,
    threadIssueCreate: `${base}.thread.issue.create`,
    threadIssueDetailGet: `${base}.thread.issue.detail.get`,
    threadIssueDelete: `${base}.thread.issue.delete`,
    threadIssuesStart: `${base}.thread.issues.start`,
    threadIssuesReorder: `${base}.thread.issues.reorder`,
    pingStart: `${base}.command.ping`,
    events: `octop.user.${uid}.bridge.${bid}.events`
  };
}
