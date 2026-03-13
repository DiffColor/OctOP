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
    projectCreate: `${base}.project.create`,
    workspaceRootsGet: `${base}.workspace.roots.get`,
    folderListGet: `${base}.folder.list.get`,
    threadsGet: `${base}.threads.get`,
    pingStart: `${base}.command.ping`,
    events: `octop.user.${uid}.bridge.${bid}.events`
  };
}
