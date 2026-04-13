import { useMemo, useState } from "react";

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
  projectName = "",
  threadTitle = "",
  bridgeLabel = "",
  threadStatusLabel = "",
  latestUserText = "",
  latestAssistantText = "",
  connectionState = "idle",
  micState = "idle",
  isListening = false,
  isResponding = false,
  audioLevel = 0,
  levelHistory = [],
  errorMessage = "",
  onConnect = null,
  onDisconnect = null,
  onCancelResponse = null,
  onClose = null
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const status = useMemo(
    () => buildVoiceModeStatus({ connectionState, isResponding, isListening, micState, errorMessage }),
    [connectionState, errorMessage, isListening, isResponding, micState]
  );
  const levelScale = 1 + audioLevel * 0.28;
  const ringOpacity = 0.28 + audioLevel * 0.4;
  const waveAmplitude = 10 + audioLevel * 20;
  const isConnecting = connectionState === "connecting" || micState === "requesting";
  const isConnected = connectionState === "connected";
  const sessionActionLabel = isConnected ? "세션 종료" : isConnecting ? "연결 중..." : "실시간 음성 연결";
  const liveTranscript = latestAssistantText || latestUserText || status.detail;
  const liveHint =
    isConnected
      ? isResponding
        ? "응답 중"
        : isListening
          ? "청취 중"
          : "대기"
      : isConnecting
        ? "연결 중"
        : connectionState === "error"
          ? "오류"
          : "미연결";

  return (
    <section className="voice-mode-panel sheet-enter" data-testid="voice-mode-panel" aria-hidden={!open}>
      <div className="voice-mode-panel__backdrop" aria-hidden="true" />

      <div className="voice-mode-panel__hud">
        <div className="voice-mode-panel__status-row">
          <span className={`voice-mode-panel__badge ${connectionState === "error" ? "is-error" : ""}`}>{status.label}</span>
          <span className="voice-mode-panel__badge is-muted">{liveHint}</span>
        </div>

        <div className="voice-mode-panel__stage">
          <div className="voice-mode-panel__orbital-shell" style={{ "--voice-orb-scale": levelScale, "--voice-ring-opacity": ringOpacity }}>
            <div className="voice-mode-panel__orbital-ring" />
            <div className="voice-mode-panel__orbital-ring is-secondary" />
            <div className="voice-mode-panel__orbital-ring is-tertiary" />

            <div
              className={`voice-mode-panel__wave-orb ${isResponding ? "is-speaking" : ""} ${isConnected ? "is-live" : ""} ${
                connectionState === "error" ? "is-error" : ""
              }`}
              aria-hidden="true"
            >
              <div className="voice-mode-panel__wave-glow" />

              <svg className="voice-mode-panel__wave-svg" viewBox="0 0 240 240" role="presentation" focusable="false">
                <defs>
                  <linearGradient id="voice-wave-bg" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="rgba(236, 250, 255, 0.95)" />
                    <stop offset="38%" stopColor="rgba(147, 230, 255, 0.98)" />
                    <stop offset="72%" stopColor="rgba(37, 136, 255, 0.98)" />
                    <stop offset="100%" stopColor="rgba(10, 57, 168, 0.98)" />
                  </linearGradient>
                  <radialGradient id="voice-wave-shine" cx="36%" cy="28%" r="58%">
                    <stop offset="0%" stopColor="rgba(255,255,255,0.88)" />
                    <stop offset="52%" stopColor="rgba(180,236,255,0.42)" />
                    <stop offset="100%" stopColor="rgba(255,255,255,0)" />
                  </radialGradient>
                  <clipPath id="voice-wave-clip">
                    <circle cx="120" cy="120" r="88" />
                  </clipPath>
                </defs>

                <g clipPath="url(#voice-wave-clip)">
                  <rect x="26" y="26" width="188" height="188" rx="94" fill="url(#voice-wave-bg)" />
                  <ellipse cx="94" cy="74" rx="64" ry="46" fill="url(#voice-wave-shine)" />

                  {[ 
                    { baseY: 86, amplitude: waveAmplitude * 0.5, width: 12, opacity: 0.28 },
                    { baseY: 108, amplitude: waveAmplitude * 0.72, width: 14, opacity: 0.42 },
                    { baseY: 132, amplitude: waveAmplitude, width: 16, opacity: 0.72 },
                    { baseY: 156, amplitude: waveAmplitude * 0.68, width: 12, opacity: 0.4 }
                  ].map((wave, index) => {
                    const top = wave.baseY;
                    const amp = wave.amplitude;
                    const d = `M 8 ${top} C 36 ${top - amp} 68 ${top - amp} 96 ${top} S 154 ${top + amp} 186 ${top} S 228 ${top - amp} 250 ${top}`;

                    return (
                      <path
                        key={`${index}-${wave.baseY}`}
                        d={d}
                        fill="none"
                        stroke={index === 2 ? "rgba(255,255,255,0.95)" : "rgba(228,246,255,0.74)"}
                        strokeLinecap="round"
                        strokeWidth={wave.width}
                        opacity={wave.opacity}
                      />
                    );
                  })}

                  <ellipse cx="130" cy="162" rx="88" ry="36" fill="rgba(20, 81, 214, 0.2)" />
                </g>
              </svg>
            </div>
          </div>

          <div className="voice-mode-panel__summary">
            <p className="voice-mode-panel__eyebrow">OctOP Realtime Voice</p>
            <h2 className="voice-mode-panel__title">{status.label}</h2>
            <p className="voice-mode-panel__summary-text">{status.detail}</p>
            <p className="voice-mode-panel__live-transcript">{liveTranscript}</p>

            <div className="voice-mode-panel__meters" aria-hidden="true">
              {(Array.isArray(levelHistory) && levelHistory.length > 0 ? levelHistory : Array.from({ length: 24 }, () => 0.08)).map((level, index) => (
                <span
                  key={`${index}-${level}`}
                  className="voice-mode-panel__meter"
                  style={{
                    height: `${Math.max(0.55, Math.min(1.8, Number(level) * 1.8 || 0.55))}rem`,
                    opacity: `${Math.max(0.28, Math.min(1, Number(level) * 1.6 || 0.28))}`
                  }}
                />
              ))}
            </div>
          </div>
        </div>

        <div className={`voice-mode-panel__details ${detailsOpen || Boolean(errorMessage) ? "is-open" : ""}`}>
          <div className="voice-mode-panel__transcript-grid">
            <article className="voice-mode-panel__transcript-card">
              <p className="voice-mode-panel__transcript-label">최근 사용자</p>
              <p className="voice-mode-panel__transcript-text">{latestUserText || "아직 인식된 사용자 발화가 없습니다."}</p>
            </article>

            <article className="voice-mode-panel__transcript-card is-response">
              <p className="voice-mode-panel__transcript-label">최근 OctOP</p>
              <p className="voice-mode-panel__transcript-text">{latestAssistantText || "아직 생성된 음성 응답이 없습니다."}</p>
            </article>
          </div>

          <div className="voice-mode-panel__meta-strip">
            <span>{projectName || "프로젝트 없음"}</span>
            {threadTitle ? <span>{threadTitle}</span> : null}
            {threadStatusLabel ? <span>{threadStatusLabel}</span> : null}
            {bridgeLabel ? <span>{bridgeLabel}</span> : null}
          </div>

          {errorMessage ? <p className="voice-mode-panel__error">{errorMessage}</p> : null}
        </div>

        <div className="voice-mode-panel__actions">
          <button
            type="button"
            onClick={() => setDetailsOpen((current) => !current)}
            className="voice-mode-panel__action-button"
            aria-label={detailsOpen ? "상세 닫기" : "상세 보기"}
          >
            <span className="voice-mode-panel__action-icon" aria-hidden="true">
              ⌂
            </span>
            <span className="voice-mode-panel__sr-only">{detailsOpen ? "상세 닫기" : "상세 보기"}</span>
          </button>

          <button
            type="button"
            onClick={isConnected ? onDisconnect : onConnect}
            className={`voice-mode-panel__action-button is-primary ${isConnected ? "is-live" : ""}`}
            aria-label={sessionActionLabel}
            disabled={isConnecting}
          >
            <span className="voice-mode-panel__action-icon is-mic" aria-hidden="true">
              {isConnected ? "●" : "◎"}
            </span>
            <span className="voice-mode-panel__sr-only">{sessionActionLabel}</span>
          </button>

          <button
            type="button"
            onClick={onCancelResponse}
            className="voice-mode-panel__action-button"
            aria-label="응답 중지"
            disabled={!isResponding}
          >
            <span className="voice-mode-panel__action-icon" aria-hidden="true">
              ⋯
            </span>
            <span className="voice-mode-panel__sr-only">응답 중지</span>
          </button>

          <button type="button" onClick={onClose} className="voice-mode-panel__action-button" aria-label="채팅 모드">
            <span className="voice-mode-panel__action-icon" aria-hidden="true">
              ✕
            </span>
            <span className="voice-mode-panel__sr-only">채팅 모드</span>
          </button>
        </div>
      </div>
    </section>
  );
}
