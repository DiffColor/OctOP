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
