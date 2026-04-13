export const REALTIME_EVENT_CHANNEL = "oai-events";
export const DEFAULT_VOICE_LEVEL_HISTORY = Object.freeze(Array.from({ length: 24 }, () => 0.08));

export function createRealtimeResponseEvent() {
  return {
    type: "response.create"
  };
}

export function createRealtimeNarrationEvent(text) {
  const narration = String(text ?? "").trim();

  return {
    type: "response.create",
    response: {
      conversation: "none",
      output_modalities: ["audio"],
      tools: [],
      metadata: {
        source: "app_server_authoritative_response"
      },
      instructions: [
        "당신은 OctOP의 음성 낭독기입니다.",
        "아래 응답만 한국어로 그대로 읽으세요.",
        "내용을 추가하거나 바꾸거나 요약하거나 코드와 경로 설명을 덧붙이지 마세요.",
        narration
      ].join("\n\n")
    }
  };
}

export function createFunctionCallOutputEvent(callId, output) {
  return {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(output ?? {})
    }
  };
}

export function parseRealtimeJson(value) {
  try {
    return JSON.parse(String(value ?? ""));
  } catch {
    return null;
  }
}

export function parseFunctionArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }

  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function describeVoiceError(error) {
  const message = String(error?.message ?? "").trim();
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
    return "OpenAI 음성 세션을 생성하지 못했습니다.";
  }

  return message;
}
