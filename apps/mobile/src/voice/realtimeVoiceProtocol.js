export const REALTIME_EVENT_CHANNEL = "oai-events";
export const DEFAULT_VOICE_LEVEL_HISTORY = Object.freeze(Array.from({ length: 24 }, () => 0.08));

const REALTIME_CAPABILITY_BLOCKED_ERROR_HINTS = [
  "insufficient",
  "permission",
  "forbidden",
  "not_authorized",
  "not authorized",
  "access denied",
  "unsupported",
  "unavailable",
  "disabled",
  "quota",
  "rate limit",
  "billing",
  "model_not_found",
  "realtime model",
  "realtime is not enabled"
];

export function parseRealtimeJson(value) {
  try {
    return JSON.parse(String(value ?? ""));
  } catch {
    return null;
  }
}

function extractVoiceErrorFields(error) {
  const message = String(error?.message ?? error?.error?.message ?? "").trim();
  const detail = String(error?.payload?.detail ?? error?.detail ?? error?.error?.detail ?? "").trim();
  const code = String(error?.code ?? error?.payload?.code ?? error?.error?.code ?? "").trim();
  const type = String(error?.type ?? error?.error?.type ?? "").trim();

  return {
    message,
    detail,
    code,
    type,
    normalizedMessage: message.toLowerCase(),
    normalizedCombined: [message, detail, code, type]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
  };
}

export function isBlockedRealtimeCapabilityError(error) {
  const { normalizedCombined } = extractVoiceErrorFields(error);

  if (!normalizedCombined) {
    return false;
  }

  return REALTIME_CAPABILITY_BLOCKED_ERROR_HINTS.some((hint) => normalizedCombined.includes(hint));
}

export function describeRealtimeAvailabilityError(error, fallbackMessage = "실시간 음성 이벤트 처리 중 오류가 발생했습니다.") {
  const { message, detail, code, type, normalizedCombined } = extractVoiceErrorFields(error);

  if (normalizedCombined.includes("permission") || normalizedCombined.includes("forbidden") || normalizedCombined.includes("access denied")) {
    return "OpenAI 실시간 음성 사용 권한이 없어 현재 모드를 계속 사용할 수 없습니다.";
  }

  if (normalizedCombined.includes("quota") || normalizedCombined.includes("rate limit") || normalizedCombined.includes("billing")) {
    return "OpenAI 실시간 음성 사용 한도 또는 결제 상태로 인해 현재 모드를 계속 사용할 수 없습니다.";
  }

  if (
    normalizedCombined.includes("unsupported") ||
    normalizedCombined.includes("unavailable") ||
    normalizedCombined.includes("disabled") ||
    normalizedCombined.includes("model_not_found") ||
    normalizedCombined.includes("realtime model")
  ) {
    return "현재 OpenAI 계정 또는 모델 설정으로는 실시간 음성을 사용할 수 없습니다.";
  }

  if (message && detail) {
    return message.includes(detail) ? message : `${message} ${detail}`.trim();
  }

  if (message || detail) {
    return message || detail;
  }

  if (code || type) {
    return [code, type].filter(Boolean).join(" ").trim();
  }

  return fallbackMessage;
}

export function describeVoiceError(error) {
  const { message, detail, normalizedMessage } = extractVoiceErrorFields(error);

  if (!message) {
    return "음성 세션을 시작하지 못했습니다.";
  }

  if (normalizedMessage.includes("notallowederror") || normalizedMessage.includes("permission")) {
    return "마이크 권한이 없어 음성 세션을 시작할 수 없습니다.";
  }

  if (normalizedMessage.includes("notfounderror")) {
    return "사용 가능한 마이크를 찾지 못했습니다.";
  }

  if (normalizedMessage.includes("openai")) {
    return detail ? `OpenAI 음성 세션을 생성하지 못했습니다. ${detail}` : "OpenAI 음성 세션을 생성하지 못했습니다.";
  }

  return message;
}
