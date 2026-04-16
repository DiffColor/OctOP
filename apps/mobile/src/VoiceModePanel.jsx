import { useMemo, useSyncExternalStore } from "react";
import VoiceOrb from "./VoiceOrb.jsx";

const SUBTITLE_VISIBLE_LINE_COUNT = 3;
const SUBTITLE_MAX_CHARS_PER_LINE = 23;
const EMPTY_AUDIO_METRICS = Object.freeze({
  inputAudioLevel: 0,
  outputAudioLevel: 0,
  audioLevel: 0,
  levelHistory: []
});

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
  const normalizedText = normalizeSubtitleText(text);
  const allLines = wrapSubtitleLines(text);

  if (!normalizedText || allLines.length === 0) {
    return {
      text: "",
      lineCount: 0,
      transitionKey: "subtitle-empty"
    };
  }

  return {
    text: normalizedText,
    lineCount: Math.min(allLines.length, SUBTITLE_VISIBLE_LINE_COUNT),
    transitionKey: `subtitle-0-${allLines.length}`
  };
}

function buildVoiceModeStatus({ mode, connectionState, isResponding, isListening, micState, errorMessage }) {
  if (connectionState === "connecting" || micState === "requesting") {
    return mode === "tts" ? "브라우저 음성 입력과 TTS 보고를 연결하는 중입니다." : "OpenAI Realtime 세션과 마이크를 연결하는 중입니다.";
  }

  if (connectionState === "error" || micState === "error") {
    return errorMessage || (mode === "tts" ? "음성 TTS 세션 연결에 실패했습니다." : "실시간 음성 세션 연결에 실패했습니다.");
  }

  if (isResponding) {
    return mode === "tts"
      ? "app-server 결과를 TTS 음성으로 보고하고 있습니다."
      : "Realtime이 app-server 결과를 자연스럽게 보고하고 있습니다.";
  }

  if (isListening) {
    return mode === "tts"
      ? "현재 사용자의 발화를 STT로 전사해 app-server 작업으로 넘길 준비를 하고 있습니다."
      : "현재 사용자의 발화를 전사하고 있습니다.";
  }

  if (connectionState === "connected") {
    return mode === "tts"
      ? "음성 TTS 세션이 연결되었습니다. 말씀하시면 app-server 작업으로 전달하고 TTS로 짧게 보고합니다."
      : "Realtime 음성 세션이 연결되었습니다. 말씀하시면 app-server 작업으로 전달하고 짧게 보고합니다.";
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

function subscribeEmptyStore() {
  return () => {};
}

function getEmptyAudioMetricsSnapshot() {
  return EMPTY_AUDIO_METRICS;
}

function useVoiceAudioMetrics(audioMetricsStore) {
  const subscribe = audioMetricsStore?.subscribe ?? subscribeEmptyStore;
  const getSnapshot = audioMetricsStore?.getSnapshot ?? getEmptyAudioMetricsSnapshot;
  return useSyncExternalStore(subscribe, getSnapshot, getEmptyAudioMetricsSnapshot);
}

function buildAudioMetricSummary(audioMetricsSnapshot) {
  const audioLevel = clamp(Number(audioMetricsSnapshot?.audioLevel) || 0, 0, 1);
  const levelHistory = Array.isArray(audioMetricsSnapshot?.levelHistory) ? audioMetricsSnapshot.levelHistory : [];
  const normalizedHistory = levelHistory.map((entry) => clamp(Number(entry) || 0, 0, 1));
  const averageLevel =
    normalizedHistory.length > 0
      ? clamp(normalizedHistory.reduce((sum, entry) => sum + entry, 0) / normalizedHistory.length, 0, 1)
      : audioLevel;
  const peakLevel =
    normalizedHistory.length > 0 ? normalizedHistory.reduce((maxValue, entry) => Math.max(maxValue, entry), 0) : audioLevel;

  return {
    inputAudioLevel: clamp(Number(audioMetricsSnapshot?.inputAudioLevel) || 0, 0, 1),
    outputAudioLevel: clamp(Number(audioMetricsSnapshot?.outputAudioLevel) || 0, 0, 1),
    audioLevel,
    levelHistory: normalizedHistory,
    averageLevel,
    peakLevel,
    levelPercent: Math.round(audioLevel * 100),
    averagePercent: Math.round(averageLevel * 100),
    peakPercent: Math.round(peakLevel * 100)
  };
}

function VoiceSessionSummaryCard({ audioMetricsStore }) {
  const audioMetrics = useVoiceAudioMetrics(audioMetricsStore);
  const { averagePercent } = useMemo(() => buildAudioMetricSummary(audioMetrics), [audioMetrics]);

  return (
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
  );
}

function VoicePerformancePanel({ audioMetricsStore, signalNotes = [] }) {
  const audioMetrics = useVoiceAudioMetrics(audioMetricsStore);
  const { averageLevel, levelPercent, peakPercent } = useMemo(() => buildAudioMetricSummary(audioMetrics), [audioMetrics]);

  return (
    <>
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
    </>
  );
}

export default function VoiceModePanel({
  open,
  mode = "realtime",
  latestUserText = "",
  latestAssistantText = "",
  connectionState = "idle",
  micState = "idle",
  isListening = false,
  isResponding = false,
  audioMetricsRef = null,
  audioMetricsStore = null,
  inputDevices = [],
  selectedInputDeviceId = "default",
  errorMessage = "",
  onSelectInputDevice = null,
  onClose = null
}) {
  const statusMessage = useMemo(
    () => buildVoiceModeStatus({ mode, connectionState, isResponding, isListening, micState, errorMessage }),
    [connectionState, errorMessage, isListening, isResponding, micState, mode]
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
  const stateHeadline = buildVoiceModeHeadline({ connectionState, isListening, isResponding, micState });
  const connectionLabel = buildConnectionLabel(connectionState, micState);
  const hasAssistantTranscript = Boolean(String(errorMessage || latestAssistantText || "").trim());
  const hasUserTranscript = Boolean(String(latestUserText ?? "").trim());
  const subtitleFrame = useMemo(() => buildSubtitleFrame(liveTranscript), [liveTranscript]);
  const subtitleLineCountClassName =
    subtitleFrame.lineCount <= 1
      ? "is-single-line"
      : subtitleFrame.lineCount === 2
        ? "is-two-lines"
        : "is-three-lines";
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
      notes.push(mode === "tts" ? "TTS fallback 세션이 app-server 보고와 동기화된 상태입니다." : "Realtime 세션이 app-server와 동기화된 상태입니다.");
    }

    if (isListening) {
      notes.push(mode === "tts" ? "브라우저 STT가 현재 사용자 발화를 안정적으로 수집하고 있습니다." : "현재 사용자 발화를 안정적으로 수집하고 있습니다.");
    }

    if (isResponding) {
      notes.push(mode === "tts" ? "생성된 응답을 TTS로 짧고 자연스럽게 보고 중입니다." : "생성된 응답을 짧고 자연스럽게 음성으로 보고 중입니다.");
    }

    if (!notes.length) {
      notes.push("음성 명령을 기다리는 대기 상태입니다.");
    }

    return notes.slice(0, 3);
  }, [connectionState, isListening, isResponding, mode]);

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
                <p className="voice-mode-panel__system-title">{mode === "tts" ? "Fallback Voice" : "System Online"}</p>
                <p className="voice-mode-panel__system-subtitle">{connectionLabel} {mode === "tts" ? "tts session" : "voice session"}</p>
              </div>
            </div>

            <article className="voice-mode-panel__glass-card">
              <p className="voice-mode-panel__section-label">Recent Transcript</p>
              <p className="voice-mode-panel__glass-copy">{userTranscript}</p>
            </article>

            <VoiceSessionSummaryCard audioMetricsStore={audioMetricsStore} />
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
                  audioMetricsRef={audioMetricsRef}
                  isListening={isListening}
                  isResponding={isResponding}
                  connectionState={connectionState}
                  visualConfig={orbVisualConfig}
                />
              </div>
            </div>

            <div className="voice-mode-panel__transcript-shell is-bottom-zone">
              <div className="voice-mode-panel__transcript-glow" aria-hidden="true" />
              <article className={`voice-mode-panel__prompt-card ${hasUserTranscript ? "" : "is-placeholder"}`.trim()} data-testid="voice-user-bubble" aria-label="최근 사용자 입력">
                <p className="voice-mode-panel__prompt-card-text">{userTranscript}</p>
              </article>

              <div className="voice-mode-panel__subtitle-stage" aria-hidden={false}>
                <div className="voice-mode-panel__subtitle-glow" aria-hidden="true" />
                <article
                  className={subtitleToneClassName}
                  data-testid="voice-assistant-bubble"
                  aria-label="OctOP 자막 응답"
                  aria-live={errorMessage ? "assertive" : "polite"}
                  aria-atomic="true"
                >
                  <div key={subtitleFrame.transitionKey} className="voice-mode-panel__subtitle-window">
                    <div
                      className={`voice-mode-panel__subtitle-text ${
                        subtitleLineCountClassName
                      }`.trim()}
                    >
                      {subtitleFrame.text}
                    </div>
                  </div>
                </article>
              </div>
            </div>
          </div>

          <aside className="voice-mode-panel__side-column is-right" aria-label="음성 모드 성능 지표">
            <h3 className="voice-mode-panel__side-heading">AI Performance</h3>
            <VoicePerformancePanel audioMetricsStore={audioMetricsStore} signalNotes={signalNotes} />
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
