import { useMemo } from "react";

function buildVoiceModeStatus({ connectionState, isResponding, isListening, micState, errorMessage }) {
  if (connectionState === "connecting" || micState === "requesting") {
    return {
      label: "VOICE LINKING",
      detail: "OpenAI Realtime 세션과 마이크를 연결하는 중입니다."
    };
  }

  if (connectionState === "error" || micState === "error") {
    return {
      label: "VOICE DEGRADED",
      detail: errorMessage || "실시간 음성 세션 연결에 실패했습니다."
    };
  }

  if (isResponding) {
    return {
      label: "OCTOP RESPONDING",
      detail: "실시간 음성 응답을 생성하고 있습니다."
    };
  }

  if (isListening) {
    return {
      label: "JARVIS LISTENING",
      detail: "현재 사용자의 발화를 감지하고 있습니다."
    };
  }

  if (connectionState === "connected") {
    return {
      label: "VOICE STANDBY",
      detail: "실시간 음성 세션이 연결되었습니다. 바로 말을 시작하시면 됩니다."
    };
  }

  return {
    label: "VOICE IDLE",
    detail: "음성 세션이 아직 연결되지 않았습니다."
  };
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
  const status = useMemo(
    () => buildVoiceModeStatus({ connectionState, isResponding, isListening, micState, errorMessage }),
    [connectionState, errorMessage, isListening, isResponding, micState]
  );

  const liveTranscript = latestAssistantText || latestUserText || status.detail;
  const liveLevels = Array.isArray(levelHistory) && levelHistory.length > 0 ? levelHistory : Array.from({ length: 24 }, () => 0.08);
  const glowScale = 1 + audioLevel * 0.18;
  const blobScale = 1 + audioLevel * 0.16;
  const blobGlowOpacity = 0.46 + audioLevel * 0.44;
  const blobRotation = `${-10 + audioLevel * 24}deg`;
  const blobLift = `${audioLevel * -8}px`;

  return (
    <section className="voice-mode-panel sheet-enter" data-testid="voice-mode-panel" aria-hidden={!open}>
      <div className="voice-mode-panel__backdrop" aria-hidden="true" />

      <div className="voice-mode-panel__hud">
        <div
          className={`voice-mode-panel__blob-stage ${isResponding ? "is-speaking" : ""} ${connectionState === "error" ? "is-error" : ""}`}
          style={{
            "--voice-blob-scale": blobScale,
            "--voice-blob-glow-opacity": blobGlowOpacity,
            "--voice-blob-glow-scale": glowScale,
            "--voice-blob-rotation": blobRotation,
            "--voice-blob-lift": blobLift
          }}
          aria-hidden="true"
        >
          <div className="voice-mode-panel__blob-shadow" />
          <div className="voice-mode-panel__blob-glow is-back" />
          <div className="voice-mode-panel__blob-glow is-front" />
          <div className="voice-mode-panel__blob-glow is-side" />

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
          <div className="voice-mode-panel__meters" aria-hidden="true">
            {liveLevels.map((level, index) => (
              <span
                key={`${index}-${level}`}
                className="voice-mode-panel__meter"
                style={{
                  height: `${Math.max(0.48, Math.min(1.7, Number(level) * 1.9 || 0.48))}rem`,
                  opacity: `${Math.max(0.24, Math.min(1, Number(level) * 1.6 || 0.24))}`
                }}
              />
            ))}
          </div>

          <div className="voice-mode-panel__transcript-grid">
            <article className="voice-mode-panel__transcript-card">
              <p className="voice-mode-panel__transcript-label">최근 사용자</p>
              <p className="voice-mode-panel__transcript-text">{latestUserText || "아직 인식된 사용자 발화가 없습니다."}</p>
            </article>

            <article className="voice-mode-panel__transcript-card is-response">
              <p className="voice-mode-panel__transcript-label">최근 OctOP</p>
              <p className="voice-mode-panel__transcript-text">{liveTranscript}</p>
            </article>
          </div>

          {errorMessage ? <p className="voice-mode-panel__error">{errorMessage}</p> : null}
        </div>

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
      </div>
    </section>
  );
}
