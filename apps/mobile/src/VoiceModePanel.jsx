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
  const status = useMemo(
    () => buildVoiceModeStatus({ connectionState, isResponding, isListening, micState, errorMessage }),
    [connectionState, errorMessage, isListening, isResponding, micState]
  );
  const levelScale = 1 + audioLevel * 0.55;
  const ringOpacity = 0.38 + audioLevel * 0.5;
  const liveHint =
    connectionState === "connected"
      ? isResponding
        ? "응답 중"
        : isListening
          ? "청취 중"
          : "대기"
      : connectionState === "connecting"
        ? "연결 중"
        : connectionState === "error"
          ? "오류"
          : "미연결";

  return (
    <section className="voice-mode-panel sheet-enter" data-testid="voice-mode-panel" aria-hidden={!open}>
      <div className="voice-mode-panel__backdrop" aria-hidden="true" />

      <div className="voice-mode-panel__hud">
        <div className="voice-mode-panel__header">
          <div>
            <p className="voice-mode-panel__eyebrow">OctOP Realtime Voice</p>
            <h2 className="voice-mode-panel__title">{threadTitle || "음성 세션"}</h2>
            <p className="voice-mode-panel__subtitle">
              {projectName || "프로젝트 없음"}
              {threadStatusLabel ? ` · ${threadStatusLabel}` : ""}
              {bridgeLabel ? ` · ${bridgeLabel}` : ""}
            </p>
          </div>

          <button type="button" onClick={onClose} className="voice-mode-panel__ghost-button">
            채팅 모드
          </button>
        </div>

        <div className="voice-mode-panel__status-row">
          <span className={`voice-mode-panel__badge ${connectionState === "error" ? "is-error" : ""}`}>{status.label}</span>
          <span className="voice-mode-panel__badge is-muted">{liveHint}</span>
        </div>

        <div className="voice-mode-panel__core">
          <div className="voice-mode-panel__orbital-shell">
            <div
              className={`voice-mode-panel__orbital-ring ${isResponding ? "is-speaking" : ""}`}
              style={{ transform: `scale(${levelScale})`, opacity: ringOpacity }}
            />
            <div className="voice-mode-panel__orbital-ring is-secondary" />
            <div className="voice-mode-panel__orbital-grid" />
            <div className="voice-mode-panel__core-node">
              <span>{connectionState === "connected" ? (isResponding ? "RESPOND" : "LIVE") : connectionState === "connecting" ? "SYNC" : "IDLE"}</span>
            </div>
          </div>

          <div className="voice-mode-panel__metrics">
            <div className="voice-mode-panel__metric-card">
              <p className="voice-mode-panel__metric-label">Status</p>
              <p className="voice-mode-panel__metric-value">{status.label}</p>
              <p className="voice-mode-panel__metric-note">{status.detail}</p>
            </div>

            <div className="voice-mode-panel__metric-card">
              <p className="voice-mode-panel__metric-label">Mic level</p>
              <div className="voice-mode-panel__bars" aria-hidden="true">
                {(Array.isArray(levelHistory) && levelHistory.length > 0 ? levelHistory : Array.from({ length: 24 }, () => 0.08)).map(
                  (level, index) => (
                    <span
                      key={`${index}-${level}`}
                      className="voice-mode-panel__bar"
                      style={{ transform: `scaleY(${Math.max(0.18, Math.min(1, Number(level) || 0.08))})` }}
                    />
                  )
                )}
              </div>
              <p className="voice-mode-panel__metric-note">실시간 마이크 캡처 레벨을 시각화합니다.</p>
            </div>
          </div>
        </div>

        <div className="voice-mode-panel__transcript-grid">
          <article className="voice-mode-panel__transcript-card">
            <p className="voice-mode-panel__transcript-label">Latest user</p>
            <p className="voice-mode-panel__transcript-text">
              {latestUserText || "아직 인식된 최근 사용자 발화가 없습니다."}
            </p>
          </article>

          <article className="voice-mode-panel__transcript-card">
            <p className="voice-mode-panel__transcript-label">Latest OctOP</p>
            <p className="voice-mode-panel__transcript-text">
              {latestAssistantText || "아직 생성된 최근 음성 응답이 없습니다."}
            </p>
          </article>
        </div>

        {errorMessage ? <p className="voice-mode-panel__error">{errorMessage}</p> : null}

        <div className="voice-mode-panel__actions">
          {connectionState !== "connected" ? (
            <button type="button" onClick={onConnect} className="voice-mode-panel__action-button is-primary">
              {connectionState === "connecting" ? "연결 중..." : "실시간 음성 연결"}
            </button>
          ) : (
            <>
              <button type="button" onClick={onDisconnect} className="voice-mode-panel__action-button">
                세션 종료
              </button>

              <button
                type="button"
                onClick={onCancelResponse}
                className="voice-mode-panel__action-button is-primary"
                disabled={!isResponding}
              >
                응답 중지
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
