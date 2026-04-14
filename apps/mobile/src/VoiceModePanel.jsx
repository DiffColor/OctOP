import { useMemo } from "react";
import VoiceOrb from "./VoiceOrb.jsx";

const SUBTITLE_VISIBLE_LINE_COUNT = 2;
const SUBTITLE_MAX_CHARS_PER_LINE = 23;

const VOICE_ORB_PALETTE = [
  {
    color: "#6ef8ff",
    glowColor: "rgba(110, 248, 255, 0.72)",
    electronColor: "rgba(237, 253, 255, 0.98)"
  },
  {
    color: "#3fe6ff",
    glowColor: "rgba(63, 230, 255, 0.64)",
    electronColor: "rgba(232, 252, 255, 0.96)"
  },
  {
    color: "#19c8ff",
    glowColor: "rgba(25, 200, 255, 0.54)",
    electronColor: "rgba(224, 245, 255, 0.94)"
  },
  {
    color: "#ff5af4",
    glowColor: "rgba(255, 90, 244, 0.58)",
    electronColor: "rgba(255, 236, 252, 0.96)"
  },
  {
    color: "#ff38cd",
    glowColor: "rgba(255, 56, 205, 0.52)",
    electronColor: "rgba(255, 231, 246, 0.94)"
  },
  {
    color: "#b55dff",
    glowColor: "rgba(181, 93, 255, 0.44)",
    electronColor: "rgba(244, 232, 255, 0.92)"
  }
];

const VOICE_ORB_ERROR_PALETTE = [
  {
    color: "#ff9fb4",
    glowColor: "rgba(255, 159, 180, 0.66)",
    electronColor: "rgba(255, 240, 244, 0.98)"
  },
  {
    color: "#ff9073",
    glowColor: "rgba(255, 144, 115, 0.56)",
    electronColor: "rgba(255, 239, 230, 0.96)"
  },
  {
    color: "#ffcf73",
    glowColor: "rgba(255, 207, 115, 0.48)",
    electronColor: "rgba(255, 248, 231, 0.94)"
  },
  {
    color: "#ff6fcf",
    glowColor: "rgba(255, 111, 207, 0.46)",
    electronColor: "rgba(255, 235, 246, 0.94)"
  }
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeSubtitleText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSubtitleToken(token, maxCharsPerLine) {
  const normalizedToken = String(token ?? "").trim();

  if (!normalizedToken) {
    return [];
  }

  if (normalizedToken.length <= maxCharsPerLine) {
    return [normalizedToken];
  }

  const chunks = [];

  for (let start = 0; start < normalizedToken.length; start += maxCharsPerLine) {
    chunks.push(normalizedToken.slice(start, start + maxCharsPerLine));
  }

  return chunks;
}

function wrapSubtitleLines(text, maxCharsPerLine = SUBTITLE_MAX_CHARS_PER_LINE) {
  const normalizedText = normalizeSubtitleText(text);

  if (!normalizedText) {
    return [];
  }

  const tokens = normalizedText
    .split(" ")
    .flatMap((token) => splitSubtitleToken(token, maxCharsPerLine))
    .filter(Boolean);

  if (tokens.length === 0) {
    return [];
  }

  const lines = [];
  let currentLine = "";

  tokens.forEach((token) => {
    if (!currentLine) {
      currentLine = token;
      return;
    }

    const nextLine = `${currentLine} ${token}`;

    if (nextLine.length <= maxCharsPerLine) {
      currentLine = nextLine;
      return;
    }

    lines.push(currentLine);
    currentLine = token;
  });

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}

function buildSubtitleFrame(text) {
  const allLines = wrapSubtitleLines(text);

  if (allLines.length === 0) {
    return {
      lines: [],
      transitionKey: "subtitle-empty"
    };
  }

  const visibleStartIndex = Math.max(0, allLines.length - SUBTITLE_VISIBLE_LINE_COUNT);
  const visibleLines = allLines.slice(visibleStartIndex);

  return {
    lines: visibleLines,
    transitionKey: `subtitle-${visibleStartIndex}-${allLines.length}`
  };
}

function buildVoiceModeStatus({ connectionState, isResponding, isListening, micState, errorMessage }) {
  if (connectionState === "connecting" || micState === "requesting") {
    return "OpenAI Realtime 세션과 마이크를 연결하는 중입니다.";
  }

  if (connectionState === "error" || micState === "error") {
    return errorMessage || "실시간 음성 세션 연결에 실패했습니다.";
  }

  if (isResponding) {
    return "Realtime이 app-server 결과를 자연스럽게 보고하고 있습니다.";
  }

  if (isListening) {
    return "현재 사용자의 발화를 전사하고 있습니다.";
  }

  if (connectionState === "connected") {
    return "Realtime 음성 세션이 연결되었습니다. 말씀하시면 app-server 작업으로 전달하고 짧게 보고합니다.";
  }

  return "음성 세션이 아직 연결되지 않았습니다.";
}

function buildVoiceModeHeadline({ connectionState, isListening, isResponding, micState }) {
  if (connectionState === "error" || micState === "error") {
    return "Link unstable";
  }

  if (connectionState === "connecting" || micState === "requesting") {
    return "Connecting...";
  }

  if (isResponding) {
    return "Responding...";
  }

  if (isListening) {
    return "Listening...";
  }

  if (connectionState === "connected") {
    return "Voice ready";
  }

  return "Session idle";
}

function buildConnectionLabel(connectionState, micState) {
  if (connectionState === "error" || micState === "error") {
    return "unstable";
  }

  if (connectionState === "connecting" || micState === "requesting") {
    return "syncing";
  }

  if (connectionState === "connected") {
    return "live";
  }

  return "standby";
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
      orbitCount: isResponding ? 6 : isListening ? 5 : 4,
      nucleusScale: connectionState === "error" ? 1.06 : isResponding ? 1.1 : 1.04,
      electronSpeedScale: isResponding ? 1.24 : isListening ? 1.14 : 1,
      perspective: 1,
      orbitPrecessionScale: 1,
      orbitAxisSpread: 0.2,
      orbitRadiusScale: 1,
      palette: VOICE_ORB_PALETTE,
      errorPalette: VOICE_ORB_ERROR_PALETTE
    }),
    [connectionState, isListening, isResponding]
  );

  const liveTranscript = errorMessage || latestAssistantText || statusMessage;
  const userTranscript = latestUserText || "말씀하시면 여기에 사용자 입력이 표시됩니다.";
  const resolvedInputDevices = Array.isArray(inputDevices) && inputDevices.length > 0 ? inputDevices : [{ deviceId: "default", label: "기본 마이크" }];

  const averageLevel = useMemo(() => {
    if (!Array.isArray(levelHistory) || levelHistory.length === 0) {
      return clamp(Number(audioLevel) || 0, 0, 1);
    }

    const sum = levelHistory.reduce((accumulator, entry) => accumulator + clamp(Number(entry) || 0, 0, 1), 0);
    return clamp(sum / levelHistory.length, 0, 1);
  }, [audioLevel, levelHistory]);

  const peakLevel = useMemo(() => {
    if (!Array.isArray(levelHistory) || levelHistory.length === 0) {
      return clamp(Number(audioLevel) || 0, 0, 1);
    }

    return levelHistory.reduce((maxValue, entry) => Math.max(maxValue, clamp(Number(entry) || 0, 0, 1)), 0);
  }, [audioLevel, levelHistory]);

  const levelPercent = Math.round(clamp(Number(audioLevel) || 0, 0, 1) * 100);
  const averagePercent = Math.round(averageLevel * 100);
  const peakPercent = Math.round(peakLevel * 100);
  const stateHeadline = buildVoiceModeHeadline({ connectionState, isListening, isResponding, micState });
  const connectionLabel = buildConnectionLabel(connectionState, micState);
  const hasAssistantTranscript = Boolean(String(errorMessage || latestAssistantText || "").trim());
  const hasUserTranscript = Boolean(String(latestUserText ?? "").trim());
  const subtitleFrame = useMemo(() => buildSubtitleFrame(liveTranscript), [liveTranscript]);
  const subtitleToneClassName = [
    "voice-mode-panel__subtitle-bubble",
    hasAssistantTranscript ? "" : "is-placeholder",
    isResponding ? "is-speaking" : "",
    connectionState === "error" || micState === "error" ? "is-error" : ""
  ]
    .filter(Boolean)
    .join(" ");

  const signalNotes = useMemo(() => {
    const notes = [];

    if (connectionState === "connected") {
      notes.push("Realtime 세션이 app-server와 동기화된 상태입니다.");
    }

    if (isListening) {
      notes.push("현재 사용자 발화를 안정적으로 수집하고 있습니다.");
    }

    if (isResponding) {
      notes.push("생성된 응답을 짧고 자연스럽게 음성으로 보고 중입니다.");
    }

    if (!notes.length) {
      notes.push("음성 명령을 기다리는 대기 상태입니다.");
    }

    return notes.slice(0, 3);
  }, [connectionState, isListening, isResponding]);

  return (
    <section className="voice-mode-panel" data-testid="voice-mode-panel" aria-hidden={!open}>
      <div className="voice-mode-panel__backdrop" aria-hidden="true" />
      <div className="voice-mode-panel__atmosphere" aria-hidden="true" />

      <div className="voice-mode-panel__hud voice-mode-panel__hud--aura">
        <div className="voice-mode-panel__layout">
          <aside className="voice-mode-panel__side-column is-left" aria-label="음성 모드 컨텍스트">
            <div className="voice-mode-panel__system-card">
              <div className="voice-mode-panel__system-icon" aria-hidden="true">
                ✦
              </div>
              <div>
                <p className="voice-mode-panel__system-title">System Online</p>
                <p className="voice-mode-panel__system-subtitle">{connectionLabel} voice session</p>
              </div>
            </div>

            <article className="voice-mode-panel__glass-card">
              <p className="voice-mode-panel__section-label">Recent Transcript</p>
              <p className="voice-mode-panel__glass-copy">{userTranscript}</p>
            </article>

            <article className="voice-mode-panel__glass-card">
              <p className="voice-mode-panel__section-label">Session Summary</p>
              <div className="voice-mode-panel__metric-row">
                <span className="voice-mode-panel__metric-value is-secondary">{averagePercent}%</span>
                <span className="voice-mode-panel__metric-caption">audio resonance</span>
              </div>
              <div className="voice-mode-panel__meter" aria-hidden="true">
                <span style={{ width: `${Math.max(12, averagePercent)}%` }} />
              </div>
            </article>
          </aside>

          <div className="voice-mode-panel__main-column">
            <div className="voice-mode-panel__topbar">
              <div className={`voice-mode-panel__status-pill ${connectionState === "error" ? "is-error" : ""}`}>
                <span className="voice-mode-panel__status-dot" aria-hidden="true" />
                <span className="voice-mode-panel__status-pill-text">{stateHeadline}</span>
              </div>

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
            >
              <div className="voice-mode-panel__orb-shell" aria-hidden="true">
                <VoiceOrb
                  audioLevel={audioLevel}
                  levelHistory={levelHistory}
                  isListening={isListening}
                  isResponding={isResponding}
                  connectionState={connectionState}
                  visualConfig={orbVisualConfig}
                />
              </div>

              <div className="voice-mode-panel__subtitle-stage" aria-hidden={false}>
                <div className="voice-mode-panel__subtitle-glow" aria-hidden="true" />
                <article
                  className={subtitleToneClassName}
                  data-testid="voice-assistant-bubble"
                  aria-label="OctOP 자막 응답"
                  aria-live={errorMessage ? "assertive" : "polite"}
                  aria-atomic="true"
                >
                  <span className="voice-mode-panel__sr-only">OctOP AI 자막</span>
                  <div key={subtitleFrame.transitionKey} className="voice-mode-panel__subtitle-window">
                    <div
                      className={`voice-mode-panel__subtitle-text ${
                        subtitleFrame.lines.length === 1 ? "is-single-line" : ""
                      }`.trim()}
                    >
                      {subtitleFrame.lines.map((line, index) => (
                        <span key={`${subtitleFrame.transitionKey}-${index}`} className="voice-mode-panel__subtitle-line">
                          {line}
                        </span>
                      ))}
                    </div>
                  </div>
                </article>
              </div>
            </div>

            <div className="voice-mode-panel__transcript-shell is-bottom-zone">
              <div className="voice-mode-panel__transcript-glow" aria-hidden="true" />
              <article className={`voice-mode-panel__prompt-card ${hasUserTranscript ? "" : "is-placeholder"}`.trim()} data-testid="voice-user-bubble" aria-label="최근 사용자 입력">
                <span className="voice-mode-panel__prompt-card-label">Recent Prompt</span>
                <p className="voice-mode-panel__prompt-card-text">{userTranscript}</p>
              </article>
            </div>
          </div>

          <aside className="voice-mode-panel__side-column is-right" aria-label="음성 모드 성능 지표">
            <h3 className="voice-mode-panel__side-heading">AI Performance</h3>

            <article className="voice-mode-panel__glass-card is-compact">
              <div className="voice-mode-panel__card-headline-row">
                <span className="voice-mode-panel__section-label">Input Level</span>
                <span className="voice-mode-panel__metric-value">{levelPercent}%</span>
              </div>
              <div className="voice-mode-panel__bars" aria-hidden="true">
                {Array.from({ length: 7 }, (_, index) => {
                  const ratio = (index + 1) / 7;
                  const active = ratio <= Math.max(0.18, averageLevel + 0.08);
                  return <span key={`voice-bar-${index}`} className={`voice-mode-panel__bar ${active ? "is-active" : ""}`} />;
                })}
              </div>
            </article>

            <article className="voice-mode-panel__glass-card is-compact">
              <div className="voice-mode-panel__card-headline-row">
                <span className="voice-mode-panel__section-label">Peak Presence</span>
                <span className="voice-mode-panel__metric-value is-secondary">{peakPercent}%</span>
              </div>
              <div className="voice-mode-panel__meter is-magenta" aria-hidden="true">
                <span style={{ width: `${Math.max(14, peakPercent)}%` }} />
              </div>
            </article>

            <ul className="voice-mode-panel__signal-list">
              {signalNotes.map((note) => (
                <li key={note} className="voice-mode-panel__signal-item">
                  <span className="voice-mode-panel__signal-dot" aria-hidden="true" />
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          </aside>
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
