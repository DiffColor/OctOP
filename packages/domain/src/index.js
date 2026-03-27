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
    projectThreadUnlock: `${base}.project.thread.unlock`,
    threadTimelineGet: `${base}.thread.timeline.get`,
    threadContinuityGet: `${base}.thread.continuity.get`,
    threadIssuesGet: `${base}.thread.issues.get`,
    threadIssueCreate: `${base}.thread.issue.create`,
    threadIssueDetailGet: `${base}.thread.issue.detail.get`,
    threadIssueDelete: `${base}.thread.issue.delete`,
    threadIssueInterrupt: `${base}.thread.issue.interrupt`,
    threadIssuesStart: `${base}.thread.issues.start`,
    threadIssuesReorder: `${base}.thread.issues.reorder`,
    pingStart: `${base}.command.ping`,
    events: `octop.user.${uid}.bridge.${bid}.events`
  };
}

export function createBridgeDisconnectEvidence() {
  return {
    socketDisconnectedAt: 0,
    transportFailureAt: 0,
    confirmedAt: 0,
    lastError: ""
  };
}

export function normalizeBridgeDisconnectEvidence(evidence) {
  const resolved = evidence && typeof evidence === "object" ? evidence : {};

  return {
    socketDisconnectedAt: Number.isFinite(Number(resolved.socketDisconnectedAt))
      ? Number(resolved.socketDisconnectedAt)
      : 0,
    transportFailureAt: Number.isFinite(Number(resolved.transportFailureAt))
      ? Number(resolved.transportFailureAt)
      : 0,
    confirmedAt: Number.isFinite(Number(resolved.confirmedAt))
      ? Number(resolved.confirmedAt)
      : 0,
    lastError: String(resolved.lastError ?? "").trim()
  };
}

export function reduceBridgeDisconnectEvidence(currentEvidence, event = {}) {
  const current = normalizeBridgeDisconnectEvidence(currentEvidence);
  const at = Number.isFinite(Number(event?.at)) ? Number(event.at) : Date.now();
  const message = String(event?.message ?? "").trim();

  if (
    event?.type === "socket_connected" ||
    event?.type === "transport_success" ||
    event?.type === "status_connected"
  ) {
    return createBridgeDisconnectEvidence();
  }

  if (event?.type === "status_disconnected") {
    return {
      ...current,
      socketDisconnectedAt: at,
      confirmedAt: current.transportFailureAt > 0 ? at : current.confirmedAt,
      lastError: message || current.lastError
    };
  }

  if (event?.type === "socket_disconnected") {
    return {
      ...current,
      socketDisconnectedAt: at,
      confirmedAt: current.transportFailureAt > 0 ? at : current.confirmedAt,
      lastError: message || current.lastError
    };
  }

  if (event?.type === "transport_failure") {
    return {
      ...current,
      transportFailureAt: at,
      confirmedAt: current.socketDisconnectedAt > 0 ? at : current.confirmedAt,
      lastError: message || current.lastError
    };
  }

  return current;
}

export function isBridgeDisconnectConfirmed(evidence) {
  return normalizeBridgeDisconnectEvidence(evidence).confirmedAt > 0;
}

export function mergeProjectSnapshots(currentProjects = [], incomingProjects = []) {
  const currentById = new Map();
  const currentByWorkspacePath = new Map();

  for (const project of Array.isArray(currentProjects) ? currentProjects : []) {
    const currentProject = project && typeof project === "object" ? project : null;
    const projectId = String(currentProject?.id ?? "").trim();
    const workspacePath = String(currentProject?.workspace_path ?? "").trim();

    if (projectId) {
      currentById.set(projectId, currentProject);
    }

    if (workspacePath) {
      currentByWorkspacePath.set(workspacePath, currentProject);
    }
  }

  return (Array.isArray(incomingProjects) ? incomingProjects : []).map((project) => {
    const incomingProject = project && typeof project === "object" ? project : {};
    const projectId = String(incomingProject?.id ?? "").trim();
    const workspacePath = String(incomingProject?.workspace_path ?? "").trim();
    const currentProject =
      (projectId ? currentById.get(projectId) : null) ??
      (workspacePath ? currentByWorkspacePath.get(workspacePath) : null) ??
      null;

    if (!currentProject) {
      return incomingProject;
    }

    const mergedProject = {
      ...currentProject,
      ...incomingProject
    };

    for (const fieldName of ["base_instructions", "developer_instructions"]) {
      if (
        !Object.prototype.hasOwnProperty.call(incomingProject, fieldName) &&
        Object.prototype.hasOwnProperty.call(currentProject, fieldName)
      ) {
        mergedProject[fieldName] = currentProject[fieldName];
      }
    }

    return mergedProject;
  });
}
