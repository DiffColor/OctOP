export const REALTIME_EVENT_CHANNEL = "oai-events";
export const DEFAULT_VOICE_LEVEL_HISTORY = Object.freeze(Array.from({ length: 24 }, () => 0.08));

export function parseRealtimeJson(value) {
  try {
    return JSON.parse(String(value ?? ""));
  } catch {
    return null;
  }
}

export function describeVoiceError(error) {
  const message = String(error?.message ?? "").trim();
  const detail = String(error?.payload?.detail ?? "").trim();
  const normalized = message.toLowerCase();

  if (!message) {
    return "음성 세션을 시작하지 못했습니다.";
  }

  if (normalized.includes("notallowederror") || normalized.includes("permission")) {
    return "마이크 권한이 없어 음성 세션을 시작할 수 없습니다.";
  }

  if (normalized.includes("notfounderror")) {
    return "사용 가능한 마이크를 찾지 못했습니다.";
  }

  if (normalized.includes("openai")) {
    return detail ? `OpenAI 음성 세션을 생성하지 못했습니다. ${detail}` : "OpenAI 음성 세션을 생성하지 못했습니다.";
  }

  return message;
}

export function describeRealtimeEventError(error) {
  const message = String(error?.message ?? "").trim();
  const code = String(error?.code ?? error?.type ?? "").trim();
  const detail = String(error?.event_id ?? error?.param ?? "").trim();

  if (message) {
    return message;
  }

  if (code && detail) {
    return `${code}: ${detail}`;
  }

  if (code) {
    return code;
  }

  return "실시간 음성 이벤트 처리 중 오류가 발생했습니다.";
}

export function isRealtimeAvailabilityBlockedError(error) {
  const code = String(error?.code ?? error?.type ?? "")
    .trim()
    .toLowerCase();
  const message = String(error?.message ?? "")
    .trim()
    .toLowerCase();
  const combined = `${code} ${message}`.trim();

  if (!combined) {
    return false;
  }

  return [
    "insufficient_quota",
    "quota",
    "usage limit",
    "rate limit",
    "billing",
    "credit balance",
    "account is not active",
    "organization is not active",
    "organization_deactivated",
    "billing_hard_limit_reached"
  ].some((keyword) => combined.includes(keyword));
}
