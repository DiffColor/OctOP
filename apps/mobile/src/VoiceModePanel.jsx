import { useMemo } from "react";
import VoiceOrb from "./VoiceOrb.jsx";

const VOICE_ORB_PALETTE = [
  {
    color: "#5ef2ff",
    glowColor: "rgba(94, 242, 255, 0.6)",
    electronColor: "rgba(222, 252, 255, 0.99)"
  },
  {
    color: "#71bdff",
    glowColor: "rgba(113, 189, 255, 0.56)",
    electronColor: "rgba(229, 240, 255, 0.99)"
  },
  {
    color: "#8e8aff",
    glowColor: "rgba(142, 138, 255, 0.52)",
    electronColor: "rgba(236, 234, 255, 0.99)"
  },
  {
    color: "#c66dff",
    glowColor: "rgba(198, 109, 255, 0.48)",
    electronColor: "rgba(245, 233, 255, 0.99)"
  },
  {
    color: "#ff7fcb",
    glowColor: "rgba(255, 127, 203, 0.46)",
    electronColor: "rgba(255, 235, 247, 0.99)"
  },
  {
    color: "#ffb86f",
    glowColor: "rgba(255, 184, 111, 0.4)",
    electronColor: "rgba(255, 244, 227, 0.99)"
  },
  {
    color: "#7dffc2",
    glowColor: "rgba(125, 255, 194, 0.42)",
    electronColor: "rgba(233, 255, 245, 0.99)"
  }
];

const VOICE_ORB_ERROR_PALETTE = [
  {
    color: "#ff99b6",
    glowColor: "rgba(255, 153, 182, 0.58)",
    electronColor: "rgba(255, 240, 244, 0.99)"
  },
  {
    color: "#ff9a79",
    glowColor: "rgba(255, 154, 121, 0.52)",
    electronColor: "rgba(255, 239, 232, 0.99)"
  },
  {
    color: "#ffb36d",
    glowColor: "rgba(255, 179, 109, 0.48)",
    electronColor: "rgba(255, 245, 229, 0.99)"
  },
  {
    color: "#ffd56f",
    glowColor: "rgba(255, 213, 111, 0.42)",
    electronColor: "rgba(255, 249, 229, 0.99)"
  },
  {
    color: "#ff7f9c",
    glowColor: "rgba(255, 127, 156, 0.42)",
    electronColor: "rgba(255, 232, 238, 0.99)"
  },
  {
    color: "#ff9562",
    glowColor: "rgba(255, 149, 98, 0.38)",
    electronColor: "rgba(255, 240, 229, 0.99)"
  },
  {
    color: "#ffc98e",
    glowColor: "rgba(255, 201, 142, 0.36)",
    electronColor: "rgba(255, 248, 233, 0.99)"
  }
];

function buildVoiceModeStatus({ connectionState, isResponding, isListening, micState, errorMessage }) {
  if (connectionState === "connecting" || micState === "requesting") {
    return "OpenAI Realtime 세션과 마이크를 연결하는 중입니다.";
  }

  if (connectionState === "error" || micState === "error") {
    return errorMessage || "실시간 음성 세션 연결에 실패했습니다.";
  }

  if (isResponding) {
    return "실시간 음성 응답을 생성하고 있습니다.";
  }

  if (isListening) {
    return "현재 사용자의 발화를 감지하고 있습니다.";
  }

  if (connectionState === "connected") {
    return "실시간 음성 세션이 연결되었습니다. 바로 말을 시작하시면 됩니다.";
  }

  return "음성 세션이 아직 연결되지 않았습니다.";
}

export default function VoiceModePanel({
  open,
  latestUserText = "",
  latestAssistantText = "",
  connectionState = "idle",
  micState = "idle",
  isListening = false,
  isResponding = false,
  audioLevel = 0,
  levelHistory = [],
  inputDevices = [],
  selectedInputDeviceId = "default",
  errorMessage = "",
  onSelectInputDevice = null,
  onClose = null
}) {
  const statusMessage = useMemo(
    () => buildVoiceModeStatus({ connectionState, isResponding, isListening, micState, errorMessage }),
    [connectionState, errorMessage, isListening, isResponding, micState]
  );
  const orbVisualConfig = useMemo(
    () => ({
      orbitCount: isResponding ? 7 : isListening ? 6 : 5,
      nucleusScale: connectionState === "error" ? 1.14 : isResponding ? 1.2 : 1.16,
      electronSpeedScale: isResponding ? 1.32 : isListening ? 1.18 : 1.06,
      perspective: isResponding ? 1.24 : isListening ? 1.18 : 1.1,
      orbitPrecessionScale: isResponding ? 1.3 : isListening ? 1.22 : 1.12,
      orbitAxisSpread: connectionState === "error" ? 0.76 : isResponding ? 0.68 : 0.58,
      orbitRadiusScale: 0.98,
      palette: VOICE_ORB_PALETTE,
      errorPalette: VOICE_ORB_ERROR_PALETTE
    }),
    [connectionState, isListening, isResponding]
  );

  const liveTranscript = errorMessage || latestAssistantText || statusMessage;
  const userTranscript = latestUserText || "말씀하시면 여기에 사용자 입력이 표시됩니다.";
  const resolvedInputDevices = Array.isArray(inputDevices) && inputDevices.length > 0 ? inputDevices : [{ deviceId: "default", label: "기본 마이크" }];

  return (
    <section className="voice-mode-panel" data-testid="voice-mode-panel" aria-hidden={!open}>
      <div className="voice-mode-panel__backdrop" aria-hidden="true" />

      <div className="voice-mode-panel__hud">
        <div className="voice-mode-panel__content">
          <div className="voice-mode-panel__topbar">
            <label className="voice-mode-panel__device-select" aria-label="마이크 입력 선택">
              <select
                className="voice-mode-panel__device-select-control"
                aria-label="마이크 입력 선택"
                value={selectedInputDeviceId}
                onChange={(event) => onSelectInputDevice?.(event.target.value)}
              >
                {resolvedInputDevices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
              <span className="voice-mode-panel__device-select-caret" aria-hidden="true">
                ▾
              </span>
            </label>
          </div>

          <div
            className={`voice-mode-panel__blob-stage ${isResponding ? "is-speaking" : ""} ${connectionState === "error" ? "is-error" : ""}`}
            aria-hidden="true"
          >
            <div className="voice-mode-panel__orb-shell">
              <VoiceOrb
                audioLevel={audioLevel}
                levelHistory={levelHistory}
                isListening={isListening}
                isResponding={isResponding}
                connectionState={connectionState}
                visualConfig={orbVisualConfig}
              />
            </div>
          </div>

          <div className="voice-mode-panel__transcript-shell is-bottom-zone">
            <div className="voice-mode-panel__chat-stack">
              <article className="voice-mode-panel__bubble is-user" data-testid="voice-user-bubble" aria-label="사용자 입력">
                <p className="voice-mode-panel__bubble-text">{userTranscript}</p>
              </article>

              <article className="voice-mode-panel__bubble is-assistant" data-testid="voice-assistant-bubble" aria-label="OctOP 응답">
                <p className="voice-mode-panel__bubble-text">{liveTranscript}</p>
              </article>
            </div>
          </div>
        </div>

        <footer className="voice-mode-panel__footer" data-testid="voice-mode-footer">
          <div className="voice-mode-panel__actions">
            <button type="button" onClick={onClose} className="voice-mode-panel__action-button is-primary" aria-label="음성입력 종료">
              <span className="voice-mode-panel__action-icon" aria-hidden="true">
                ✕
              </span>
              <span className="voice-mode-panel__action-text">음성입력 종료</span>
            </button>
          </div>
        </footer>
      </div>
    </section>
  );
}
