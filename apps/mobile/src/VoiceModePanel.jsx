import { useMemo } from "react";

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

  const liveTranscript = errorMessage || latestAssistantText || statusMessage;
  const userTranscript = latestUserText || "말씀하시면 여기에 사용자 입력이 표시됩니다.";
  const glowEnergy = Math.min(1.25, Math.max(0, audioLevel + (isResponding ? 0.34 : 0) + (isListening ? 0.12 : 0)));
  const glowScale = 1 + glowEnergy * 0.26;
  const blobScale = 1 + glowEnergy * 0.15;
  const blobGlowOpacity = 0.42 + glowEnergy * 0.46;
  const blobRotation = `${-12 + glowEnergy * 28}deg`;
  const blobLift = `${glowEnergy * -10}px`;
  const glowDriftX = `${(glowEnergy - 0.28) * 26}px`;
  const glowDriftY = `${glowEnergy * -20}px`;
  const glowSpread = `${1 + glowEnergy * 0.34}`;
  const glowSpinDuration = `${Math.max(2.6, 5.6 - glowEnergy * 2.4)}s`;

  return (
    <section className="voice-mode-panel sheet-enter" data-testid="voice-mode-panel" aria-hidden={!open}>
      <div className="voice-mode-panel__backdrop" aria-hidden="true" />

      <div className="voice-mode-panel__hud">
        <div className="voice-mode-panel__content">
          <div
            className={`voice-mode-panel__blob-stage ${isResponding ? "is-speaking" : ""} ${connectionState === "error" ? "is-error" : ""}`}
            style={{
              "--voice-blob-scale": blobScale,
              "--voice-blob-glow-opacity": blobGlowOpacity,
              "--voice-blob-glow-scale": glowScale,
              "--voice-blob-rotation": blobRotation,
              "--voice-blob-lift": blobLift,
              "--voice-blob-drift-x": glowDriftX,
              "--voice-blob-drift-y": glowDriftY,
              "--voice-blob-spread": glowSpread,
              "--voice-blob-spin-duration": glowSpinDuration
            }}
            aria-hidden="true"
          >
            <div className="voice-mode-panel__blob-shadow" />
            <div className="voice-mode-panel__blob-glow is-back" />
            <div className="voice-mode-panel__blob-glow is-front" />
            <div className="voice-mode-panel__blob-glow is-side" />
            <div className="voice-mode-panel__blob-wave is-one" />
            <div className="voice-mode-panel__blob-wave is-two" />

            <div className="voice-mode-panel__blob-core">
              <div className="voice-mode-panel__blob-gradient" />
              <div className="voice-mode-panel__blob-highlight" />
              <div className="voice-mode-panel__blob-sheen" />
              <div className="voice-mode-panel__blob-ribbon is-one" />
              <div className="voice-mode-panel__blob-ribbon is-two" />
              <div className="voice-mode-panel__blob-ribbon is-three" />
            </div>
          </div>

          <div className="voice-mode-panel__transcript-shell">
            <div className="voice-mode-panel__chat-stack">
              <article className="voice-mode-panel__bubble is-assistant" data-testid="voice-assistant-bubble" aria-label="OctOP 응답">
                <p className="voice-mode-panel__bubble-text">{liveTranscript}</p>
              </article>

              <article className="voice-mode-panel__bubble is-user" data-testid="voice-user-bubble" aria-label="사용자 입력">
                <p className="voice-mode-panel__bubble-text">{userTranscript}</p>
              </article>
            </div>
          </div>
        </div>

        <footer className="voice-mode-panel__footer" data-testid="voice-mode-footer">
          <div className="voice-mode-panel__actions">
            <label className="voice-mode-panel__device-select" aria-label="마이크 입력 선택">
              <span className="voice-mode-panel__device-select-label">마이크 입력</span>
              <select
                className="voice-mode-panel__device-select-control"
                aria-label="마이크 입력 선택"
                value={selectedInputDeviceId}
                onChange={(event) => onSelectInputDevice?.(event.target.value)}
              >
                {(Array.isArray(inputDevices) && inputDevices.length > 0 ? inputDevices : [{ deviceId: "default", label: "기본 마이크" }]).map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
              <span className="voice-mode-panel__device-select-caret" aria-hidden="true">
                ▾
              </span>
            </label>

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
