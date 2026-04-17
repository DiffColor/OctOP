function normalizeStatus(value) {
  return String(value ?? "").trim();
}

function normalizeLastEvent(value) {
  return String(value ?? "").trim();
}

function isKoreanLanguage(language = "ko") {
  return String(language ?? "ko").trim().toLowerCase() !== "en";
}

export function resolveRealtimeProgressText(entity = {}, options = {}) {
  const isKorean = isKoreanLanguage(options.language);
  const status = normalizeStatus(entity?.status ?? "queued") || "queued";
  const lastEvent = normalizeLastEvent(entity?.last_event ?? entity?.lastEvent);

  if (status === "awaiting_input") {
    return isKorean ? "입력 대기 중" : "Waiting for input";
  }

  if (status === "failed") {
    return isKorean ? "실패 확인 필요" : "Needs attention";
  }

  if (status === "interrupted") {
    return isKorean ? "중단됨" : "Interrupted";
  }

  if (status === "completed") {
    return isKorean ? "완료됨" : "Completed";
  }

  if (status === "idle") {
    return isKorean ? "다음 작업 대기 중" : "Waiting for next task";
  }

  if (lastEvent === "turn.starting") {
    return isKorean ? "Codex 실행 요청 중" : "Sending to Codex";
  }

  if (lastEvent === "turn.started") {
    return isKorean ? "작업 시작됨" : "Task started";
  }

  if (lastEvent === "turn.plan.updated") {
    return isKorean ? "계획 수립 중" : "Planning next steps";
  }

  if (lastEvent === "turn.diff.updated") {
    return isKorean ? "변경 적용 중" : "Applying edits";
  }

  if (lastEvent === "item.agentMessage.delta") {
    return isKorean ? "응답 생성 중" : "Streaming response";
  }

  if (lastEvent === "turn.completed") {
    return isKorean ? "마무리 정리 중" : "Wrapping up";
  }

  if (status === "running") {
    return isKorean ? "실행 중" : "Running";
  }

  if (status === "queued") {
    return isKorean ? "대기열에서 대기 중" : "Waiting in queue";
  }

  if (status === "staged") {
    return isKorean ? "준비 단계" : "Ready to queue";
  }

  return isKorean ? "상태 동기화 중" : "Syncing status";
}
