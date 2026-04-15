import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_VOICE_LEVEL_HISTORY,
  describeVoiceError,
  parseRealtimeJson,
  REALTIME_EVENT_CHANNEL
} from "./realtimeVoiceProtocol.js";
import { formatAssistantResponseForVoice } from "./voiceResponseFormatter.js";

const REALTIME_OUTPUT_MODALITIES = ["audio"];
const REALTIME_RESPONSE_CHANNEL_VOICE_TURN = "voice_turn";
const REALTIME_RESPONSE_CHANNEL_APP_SERVER_REPORT = "app_server_report";
const AUDIO_LEVEL_UI_COMMIT_INTERVAL_MS = 80;
const AUDIO_LEVEL_FORCE_SYNC_DELTA = 0.035;

function createAudioMetricsSnapshot(overrides = {}) {
  return {
    inputAudioLevel: 0,
    outputAudioLevel: 0,
    audioLevel: 0,
    levelHistory: [...DEFAULT_VOICE_LEVEL_HISTORY],
    ...overrides
  };
}

function createInitialState() {
  return {
    connectionState: "idle",
    micState: "idle",
    isListening: false,
    isResponding: false,
    inputAudioLevel: 0,
    outputAudioLevel: 0,
    audioLevel: 0,
    levelHistory: [...DEFAULT_VOICE_LEVEL_HISTORY],
    inputDevices: [{ deviceId: "default", label: "기본 마이크" }],
    selectedInputDeviceId: "default",
    latestUserTranscript: "",
    latestAssistantTranscript: "",
    latestAssistantSubtitle: "",
    error: "",
    sessionId: ""
  };
}

function normalizeAudioInputDevices(devices) {
  const normalizedDevices = Array.isArray(devices)
    ? devices
        .filter((device) => String(device?.kind ?? "").trim() === "audioinput")
        .map((device, index) => ({
          deviceId: String(device?.deviceId ?? "").trim(),
          label: String(device?.label ?? "").trim() || `마이크 ${index + 1}`
        }))
        .filter((device) => Boolean(device.deviceId))
    : [];

  const uniqueDevices = [];
  const seenIds = new Set(["default"]);

  for (const device of normalizedDevices) {
    if (seenIds.has(device.deviceId)) {
      continue;
    }

    seenIds.add(device.deviceId);
    uniqueDevices.push(device);
  }

  return [{ deviceId: "default", label: "기본 마이크" }, ...uniqueDevices];
}

function isOpenDataChannel(channel) {
  return Boolean(channel) && channel.readyState === "open";
}

function buildVoiceTurnResponseEvent(metadata = {}) {
  return {
    type: "response.create",
    response: {
      metadata: {
        channel: REALTIME_RESPONSE_CHANNEL_VOICE_TURN,
        ...metadata
      },
      output_modalities: REALTIME_OUTPUT_MODALITIES
    }
  };
}

function buildAppServerReportPrompt({ kind = "progress", text = "", latestPrompt = "" }) {
  const normalizedKind = kind === "final" ? "확정 응답" : "진행 리포트";
  const normalizedText = String(text ?? "").trim();
  const normalizedPrompt = String(latestPrompt ?? "").trim();
  const promptParts = [
    `다음 app-server ${normalizedKind}를 바탕으로 사용자에게 한국어로 한두 문장만 자연스럽게 보고하세요.`,
    "추측하지 말고 제공된 내용만 사용하세요.",
    "파일 경로, 코드, 명령어는 그대로 읽지 말고 핵심만 말하세요."
  ];

  if (normalizedPrompt) {
    promptParts.push(`최근 사용자 요청: ${normalizedPrompt}`);
  }

  promptParts.push(`app-server ${normalizedKind}: ${normalizedText}`);
  return promptParts.join(" ");
}

function buildAppServerReportEvent({ kind = "progress", text = "", latestPrompt = "" }) {
  return {
    type: "response.create",
    response: {
      conversation: "none",
      metadata: {
        channel: REALTIME_RESPONSE_CHANNEL_APP_SERVER_REPORT,
        kind
      },
      output_modalities: REALTIME_OUTPUT_MODALITIES,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: buildAppServerReportPrompt({ kind, text, latestPrompt })
            }
          ]
        }
      ]
    }
  };
}

function buildFunctionCallOutputEvent(callId, result) {
  return {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(result ?? {})
    }
  };
}

function parseFunctionCallArguments(value) {
  if (typeof value === "string") {
    return parseRealtimeJson(value) ?? {};
  }

  if (value && typeof value === "object") {
    return value;
  }

  return {};
}

function extractClientSecret(sessionPayload) {
  const directValue = String(sessionPayload?.value ?? "").trim();

  if (directValue) {
    return directValue;
  }

  const nestedValue = String(sessionPayload?.client_secret?.value ?? sessionPayload?.client_secret ?? "").trim();
  return nestedValue;
}

function extractRealtimeCallUrl(sessionPayload) {
  const directCallUrl = String(sessionPayload?.call_url ?? "").trim();

  if (directCallUrl) {
    return directCallUrl;
  }

  const nestedCallUrl = String(sessionPayload?.session?.call_url ?? "").trim();
  return nestedCallUrl || "https://api.openai.com/v1/realtime/calls";
}

function extractFunctionCallsFromResponse(response) {
  const outputItems = Array.isArray(response?.output) ? response.output : [];

  return outputItems
    .filter((item) => String(item?.type ?? "").trim() === "function_call")
    .map((item) => ({
      callId: String(item?.call_id ?? "").trim(),
      name: String(item?.name ?? "").trim(),
      arguments: parseFunctionCallArguments(item?.arguments)
    }))
    .filter((item) => item.callId && item.name);
}

function extractAssistantTextFromResponse(response) {
  const outputItems = Array.isArray(response?.output) ? response.output : [];
  const textParts = [];

  for (const item of outputItems) {
    if (String(item?.type ?? "").trim() !== "message") {
      continue;
    }

    const contentParts = Array.isArray(item?.content) ? item.content : [];

    for (const contentPart of contentParts) {
      const partType = String(contentPart?.type ?? "").trim();
      const value =
        partType === "output_text" || partType === "text"
          ? String(contentPart?.text ?? "").trim()
          : partType === "audio" || partType === "output_audio"
            ? String(contentPart?.transcript ?? "").trim()
            : "";

      if (value) {
        textParts.push(value);
      }
    }
  }

  return textParts.join(" ").replace(/\s+/g, " ").trim();
}

function normalizeToolResponse(result, fallback = {}) {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return {
      ...fallback,
      ...result,
      ok: result.ok ?? result.accepted ?? fallback.ok ?? false
    };
  }

  return {
    ...fallback,
    ok: Boolean(result ?? fallback.ok)
  };
}

function extractLatestAssistantMessageContent(messages) {
  const safeMessages = Array.isArray(messages) ? messages : [];

  for (let index = safeMessages.length - 1; index >= 0; index -= 1) {
    const message = safeMessages[index];

    if (String(message?.role ?? "").trim() !== "assistant") {
      continue;
    }

    const content = String(message?.content ?? "").trim();

    if (content) {
      return content;
    }
  }

  return "";
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function computeAnalyserLevel(analyser, frequencyData) {
  if (!analyser || !frequencyData) {
    return 0;
  }

  analyser.getByteFrequencyData(frequencyData);
  let sum = 0;
  let peak = 0;

  for (let index = 0; index < frequencyData.length; index += 1) {
    const normalized = frequencyData[index] / 255;
    sum += normalized;
    peak = Math.max(peak, normalized);
  }

  const average = frequencyData.length > 0 ? sum / frequencyData.length : 0;
  return Math.min(1, average * 1.35 + peak * 0.55);
}

export default function useRealtimeVoiceSession({
  enabled = false,
  sessionContextKey = "",
  apiRequest,
  loginId = "",
  bridgeId = "",
  project = null,
  thread = null,
  latestUserText = "",
  latestAssistantText = "",
  appServerFinalText = "",
  appServerProgressText = "",
  projectWorkspacePath = "",
  projectBaseInstructions = "",
  projectDeveloperInstructions = "",
  threadDeveloperInstructions = "",
  threadContinuitySummary = "",
  latestHandoffSummary = "",
  recentConversationSummary = "",
  projectProgramSummary = "",
  threadFileContextSummary = "",
  onSubmitPrompt = null
}) {
  const [state, setState] = useState(createInitialState);
  const peerConnectionRef = useRef(null);
  const dataChannelRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const inputAudioContextRef = useRef(null);
  const outputAudioContextRef = useRef(null);
  const inputAnalyserRef = useRef(null);
  const outputAnalyserRef = useRef(null);
  const inputAnalyserDataRef = useRef(null);
  const outputAnalyserDataRef = useRef(null);
  const animationFrameRef = useRef(0);
  const meterHistoryRef = useRef([...DEFAULT_VOICE_LEVEL_HISTORY]);
  const audioMetricsRef = useRef(createAudioMetricsSnapshot());
  const audioMetricsUiSnapshotRef = useRef(createAudioMetricsSnapshot());
  const audioMetricsUiListenersRef = useRef(new Set());
  const lastMeterUiCommitTimeRef = useRef(0);
  const lastCommittedMeterLevelsRef = useRef({
    inputAudioLevel: 0,
    outputAudioLevel: 0,
    audioLevel: 0
  });
  const assistantTranscriptBufferRef = useRef("");
  const assistantSubtitleBufferRef = useRef("");
  const userTranscriptBufferRef = useRef("");
  const connectInFlightRef = useRef(null);
  const disconnectingRef = useRef(false);
  const sessionVersionRef = useRef(0);
  const preferredInputDeviceIdRef = useRef("default");
  const hasSubmittedCurrentSpeechRef = useRef(false);
  const processedFunctionCallIdsRef = useRef(new Set());
  const queuedAppServerReportRef = useRef(null);
  const appServerReportInFlightRef = useRef(false);
  const lastProgressReportSourceRef = useRef("");
  const lastFinalReportSourceRef = useRef("");
  const issuePollSequenceRef = useRef(0);
  const activeSessionContextKeyRef = useRef("");

  const publishAudioMetricsUiSnapshot = useCallback((snapshot) => {
    audioMetricsUiSnapshotRef.current = snapshot;
    audioMetricsUiListenersRef.current.forEach((listener) => {
      try {
        listener();
      } catch {
        // ignore
      }
    });
  }, []);

  const getAudioMetricsSnapshot = useCallback(() => audioMetricsUiSnapshotRef.current, []);

  const subscribeAudioMetrics = useCallback((listener) => {
    if (typeof listener !== "function") {
      return () => {};
    }

    audioMetricsUiListenersRef.current.add(listener);
    return () => {
      audioMetricsUiListenersRef.current.delete(listener);
    };
  }, []);

  const audioMetricsStore = useMemo(
    () => ({
      getSnapshot: getAudioMetricsSnapshot,
      subscribe: subscribeAudioMetrics
    }),
    [getAudioMetricsSnapshot, subscribeAudioMetrics]
  );

  useEffect(() => {
    setState((current) => {
      const nextUserTranscript = current.latestUserTranscript || String(latestUserText ?? "").trim();
      const nextAssistantTranscript = current.latestAssistantTranscript || String(latestAssistantText ?? "").trim();
      const nextAssistantSubtitle = current.latestAssistantSubtitle || nextAssistantTranscript;

      if (
        nextUserTranscript === current.latestUserTranscript &&
        nextAssistantTranscript === current.latestAssistantTranscript &&
        nextAssistantSubtitle === current.latestAssistantSubtitle
      ) {
        return current;
      }

      return {
        ...current,
        latestUserTranscript: nextUserTranscript,
        latestAssistantTranscript: nextAssistantTranscript,
        latestAssistantSubtitle: nextAssistantSubtitle
      };
    });
  }, [latestAssistantText, latestUserText]);

  const refreshInputDevices = useCallback(async (preferredDeviceId = "") => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setState((current) => ({
        ...current,
        inputDevices: [{ deviceId: "default", label: "기본 마이크" }],
        selectedInputDeviceId: "default"
      }));
      preferredInputDeviceIdRef.current = "default";
      return [{ deviceId: "default", label: "기본 마이크" }];
    }

    try {
      const devices = normalizeAudioInputDevices(await navigator.mediaDevices.enumerateDevices());
      setState((current) => {
        const requestedDeviceId = String(
          preferredDeviceId || preferredInputDeviceIdRef.current || current.selectedInputDeviceId || "default"
        ).trim();
        const nextSelectedInputDeviceId = devices.some((device) => device.deviceId === requestedDeviceId)
          ? requestedDeviceId
          : devices[0]?.deviceId ?? "default";

        preferredInputDeviceIdRef.current = nextSelectedInputDeviceId;

        return {
          ...current,
          inputDevices: devices,
          selectedInputDeviceId: nextSelectedInputDeviceId
        };
      });

      return devices;
    } catch {
      setState((current) => ({
        ...current,
        inputDevices: [{ deviceId: "default", label: "기본 마이크" }]
      }));
      return [{ deviceId: "default", label: "기본 마이크" }];
    }
  }, []);

  useEffect(() => {
    void refreshInputDevices();

    if (!navigator.mediaDevices?.addEventListener) {
      return undefined;
    }

    const handleDeviceChange = () => {
      void refreshInputDevices();
    };

    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener?.("devicechange", handleDeviceChange);
    };
  }, [refreshInputDevices]);

  const disconnectSession = useCallback(async ({ preserveTranscript = true, preservePendingIssuePoll = false } = {}) => {
    disconnectingRef.current = true;
    sessionVersionRef.current += 1;
    processedFunctionCallIdsRef.current = new Set();
    queuedAppServerReportRef.current = null;
    appServerReportInFlightRef.current = false;
    const resetAudioMetrics = createAudioMetricsSnapshot();
    meterHistoryRef.current = [...DEFAULT_VOICE_LEVEL_HISTORY];
    audioMetricsRef.current = resetAudioMetrics;
    lastMeterUiCommitTimeRef.current = 0;
    lastCommittedMeterLevelsRef.current = {
      inputAudioLevel: 0,
      outputAudioLevel: 0,
      audioLevel: 0
    };
    publishAudioMetricsUiSnapshot(resetAudioMetrics);
    if (!preservePendingIssuePoll) {
      issuePollSequenceRef.current += 1;
    }
    activeSessionContextKeyRef.current = "";

    const activePeerConnection = peerConnectionRef.current;
    const activeDataChannel = dataChannelRef.current;

    if (animationFrameRef.current) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = 0;
    }

    try {
      inputAnalyserRef.current?.disconnect?.();
    } catch {
      // ignore
    }

    try {
      outputAnalyserRef.current?.disconnect?.();
    } catch {
      // ignore
    }

    try {
      if (inputAudioContextRef.current && inputAudioContextRef.current.state !== "closed") {
        await inputAudioContextRef.current.close();
      }
    } catch {
      // ignore
    }

    try {
      if (outputAudioContextRef.current && outputAudioContextRef.current.state !== "closed") {
        await outputAudioContextRef.current.close();
      }
    } catch {
      // ignore
    }

    if (activeDataChannel) {
      activeDataChannel.onopen = null;
      activeDataChannel.onmessage = null;
      activeDataChannel.onclose = null;
    }

    try {
      activeDataChannel?.close?.();
    } catch {
      // ignore
    }

    if (activePeerConnection) {
      activePeerConnection.ontrack = null;
      activePeerConnection.onconnectionstatechange = null;
    }

    try {
      activePeerConnection?.getSenders?.().forEach((sender) => sender.track?.stop?.());
    } catch {
      // ignore
    }

    try {
      localStreamRef.current?.getTracks?.().forEach((track) => track.stop());
    } catch {
      // ignore
    }

    try {
      activePeerConnection?.close?.();
    } catch {
      // ignore
    }

    if (remoteAudioRef.current) {
      remoteAudioRef.current.pause?.();
      remoteAudioRef.current.srcObject = null;
    }

    peerConnectionRef.current = null;
    dataChannelRef.current = null;
    localStreamRef.current = null;
    inputAudioContextRef.current = null;
    outputAudioContextRef.current = null;
    inputAnalyserRef.current = null;
    outputAnalyserRef.current = null;
    inputAnalyserDataRef.current = null;
    outputAnalyserDataRef.current = null;
    connectInFlightRef.current = null;
    assistantTranscriptBufferRef.current = preserveTranscript ? assistantTranscriptBufferRef.current : "";
    assistantSubtitleBufferRef.current = preserveTranscript ? assistantSubtitleBufferRef.current : "";
    userTranscriptBufferRef.current = preserveTranscript ? userTranscriptBufferRef.current : "";
    publishAudioMetricsUiSnapshot(createAudioMetricsSnapshot());

    setState((current) => ({
      ...current,
      connectionState: "idle",
      micState: "idle",
      isListening: false,
      isResponding: false,
      inputAudioLevel: 0,
      outputAudioLevel: 0,
      audioLevel: 0,
      levelHistory: [...DEFAULT_VOICE_LEVEL_HISTORY],
      error: "",
      sessionId: "",
      latestUserTranscript: preserveTranscript ? current.latestUserTranscript : "",
      latestAssistantTranscript: preserveTranscript ? current.latestAssistantTranscript : "",
      latestAssistantSubtitle: preserveTranscript ? current.latestAssistantSubtitle : ""
    }));

    disconnectingRef.current = false;
  }, [publishAudioMetricsUiSnapshot]);

  useEffect(() => {
    if (!enabled) {
      void disconnectSession();
    }
  }, [disconnectSession, enabled]);

  useEffect(
    () => () => {
      void disconnectSession({ preserveTranscript: true });
    },
    [disconnectSession]
  );

  const startAudioLevelMeter = useCallback((stream, kind = "input") => {
    if (typeof window === "undefined" || !stream) {
      return;
    }

    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;

    if (!AudioContextConstructor) {
      return;
    }

    const isOutputMeter = kind === "output";
    const audioContextRef = isOutputMeter ? outputAudioContextRef : inputAudioContextRef;
    const analyserRef = isOutputMeter ? outputAnalyserRef : inputAnalyserRef;
    const analyserDataRef = isOutputMeter ? outputAnalyserDataRef : inputAnalyserDataRef;

    try {
      analyserRef.current?.disconnect?.();
    } catch {
      // ignore
    }

    try {
      if (audioContextRef.current && audioContextRef.current.state !== "closed") {
        void audioContextRef.current.close();
      }
    } catch {
      // ignore
    }

    const audioContext = new AudioContextConstructor();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = isOutputMeter ? 0.9 : 0.86;

    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    audioContextRef.current = audioContext;
    analyserRef.current = analyser;
    analyserDataRef.current = new Uint8Array(analyser.frequencyBinCount);
    void audioContext.resume?.().catch(() => {});

    if (animationFrameRef.current) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = 0;
    }

    const resetAudioMetrics = createAudioMetricsSnapshot();
    meterHistoryRef.current = [...DEFAULT_VOICE_LEVEL_HISTORY];
    audioMetricsRef.current = resetAudioMetrics;
    audioMetricsUiSnapshotRef.current = resetAudioMetrics;
    lastMeterUiCommitTimeRef.current = 0;
    lastCommittedMeterLevelsRef.current = {
      inputAudioLevel: 0,
      outputAudioLevel: 0,
      audioLevel: 0
    };

    const tick = () => {
      const nextInputLevel = computeAnalyserLevel(inputAnalyserRef.current, inputAnalyserDataRef.current);
      const nextOutputLevel = computeAnalyserLevel(outputAnalyserRef.current, outputAnalyserDataRef.current);
      const combinedLevel = clamp(
        Math.max(nextInputLevel * 0.92, nextOutputLevel * 1.04, nextInputLevel * 0.42 + nextOutputLevel * 0.78),
        0,
        1
      );
      const nextHistory = [...meterHistoryRef.current.slice(-23), Math.max(0.04, combinedLevel)];
      const nextAudioMetricsSnapshot = createAudioMetricsSnapshot({
        inputAudioLevel: nextInputLevel,
        outputAudioLevel: nextOutputLevel,
        audioLevel: combinedLevel,
        levelHistory: nextHistory
      });
      meterHistoryRef.current = nextHistory;
      audioMetricsRef.current = nextAudioMetricsSnapshot;

      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      const lastCommitted = lastCommittedMeterLevelsRef.current;
      const shouldCommitUiState =
        now - lastMeterUiCommitTimeRef.current >= AUDIO_LEVEL_UI_COMMIT_INTERVAL_MS ||
        Math.abs(nextInputLevel - lastCommitted.inputAudioLevel) >= AUDIO_LEVEL_FORCE_SYNC_DELTA ||
        Math.abs(nextOutputLevel - lastCommitted.outputAudioLevel) >= AUDIO_LEVEL_FORCE_SYNC_DELTA ||
        Math.abs(combinedLevel - lastCommitted.audioLevel) >= AUDIO_LEVEL_FORCE_SYNC_DELTA;

      if (shouldCommitUiState) {
        lastMeterUiCommitTimeRef.current = now;
        lastCommittedMeterLevelsRef.current = {
          inputAudioLevel: nextInputLevel,
          outputAudioLevel: nextOutputLevel,
          audioLevel: combinedLevel
        };
        publishAudioMetricsUiSnapshot(nextAudioMetricsSnapshot);
      }

      if (!inputAnalyserRef.current && !outputAnalyserRef.current) {
        animationFrameRef.current = 0;
        return;
      }

      animationFrameRef.current = window.requestAnimationFrame(tick);
    };

    animationFrameRef.current = window.requestAnimationFrame(tick);
  }, [publishAudioMetricsUiSnapshot]);

  const sendRealtimeClientEvent = useCallback((event) => {
    const dataChannel = dataChannelRef.current;

    if (!isOpenDataChannel(dataChannel)) {
      return false;
    }

    dataChannel.send(JSON.stringify(event));
    return true;
  }, []);

  const requestVoiceTurnResponse = useCallback(
    (metadata = {}) => {
      const accepted = sendRealtimeClientEvent(buildVoiceTurnResponseEvent(metadata));

      if (accepted) {
        assistantTranscriptBufferRef.current = "";
        assistantSubtitleBufferRef.current = "";
        setState((current) => ({
          ...current,
          isResponding: true,
          error: "",
          latestAssistantSubtitle: ""
        }));
      }

      return accepted;
    },
    [sendRealtimeClientEvent]
  );

  const flushQueuedAppServerReport = useCallback(() => {
    if (appServerReportInFlightRef.current || !queuedAppServerReportRef.current) {
      return false;
    }

    const nextReport = queuedAppServerReportRef.current;
    const accepted = sendRealtimeClientEvent(buildAppServerReportEvent(nextReport));

    if (!accepted) {
      return false;
    }

    queuedAppServerReportRef.current = null;
    appServerReportInFlightRef.current = true;
    assistantTranscriptBufferRef.current = "";
    assistantSubtitleBufferRef.current = "";
    setState((current) => ({
      ...current,
      isResponding: true,
      error: "",
      latestAssistantSubtitle: ""
    }));
    return true;
  }, [sendRealtimeClientEvent]);

  const queueAppServerReport = useCallback(
    ({ kind = "progress", text = "", latestPrompt = "" }) => {
      const normalizedText = String(text ?? "").trim();

      if (!normalizedText) {
        return false;
      }

      if (kind === "final") {
        if (lastFinalReportSourceRef.current === normalizedText) {
          return false;
        }

        lastFinalReportSourceRef.current = normalizedText;
      } else {
        if (lastProgressReportSourceRef.current === normalizedText) {
          return false;
        }

        if (lastFinalReportSourceRef.current || queuedAppServerReportRef.current?.kind === "final") {
          return true;
        }

        lastProgressReportSourceRef.current = normalizedText;
      }

      queuedAppServerReportRef.current = {
        kind,
        text: normalizedText,
        latestPrompt: String(latestPrompt ?? "").trim()
      };

      if (state.connectionState !== "connected") {
        return true;
      }

      return flushQueuedAppServerReport();
    },
    [flushQueuedAppServerReport, state.connectionState]
  );

  useEffect(() => {
    if (!enabled || state.connectionState !== "connected") {
      return;
    }

    flushQueuedAppServerReport();
  }, [enabled, flushQueuedAppServerReport, state.connectionState]);

  const invokeRemoteVoiceTool = useCallback(
    async (toolName, argumentsPayload = {}) => {
      if (!loginId || !bridgeId || typeof apiRequest !== "function") {
        return {
          ok: false,
          error: "voice tool 호출 준비가 완료되지 않았습니다."
        };
      }

      try {
        return await apiRequest(
          `/api/voice/tools?login_id=${encodeURIComponent(loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`,
          {
            method: "POST",
            body: JSON.stringify({
              tool_name: toolName,
              project_id: String(project?.id ?? "").trim(),
              thread_id: String(thread?.id ?? "").trim(),
              arguments: argumentsPayload
            })
          }
        );
      } catch (error) {
        return {
          ok: false,
          error: describeVoiceError(error)
        };
      }
    },
    [apiRequest, bridgeId, loginId, project?.id, thread?.id]
  );

  const pollIssueForFinalReport = useCallback(
    (issueId, latestPrompt = "") => {
      const normalizedIssueId = String(issueId ?? "").trim();

      if (!normalizedIssueId || !loginId || !bridgeId || typeof apiRequest !== "function") {
        return false;
      }

      const pollSequence = issuePollSequenceRef.current + 1;
      issuePollSequenceRef.current = pollSequence;

      void (async () => {
        for (let attempt = 0; attempt < 12; attempt += 1) {
          if (issuePollSequenceRef.current !== pollSequence) {
            return;
          }

          if (attempt > 0) {
            await new Promise((resolve) => window.setTimeout(resolve, 1200));
          }

          try {
            const detail = await apiRequest(
              `/api/issues/${encodeURIComponent(normalizedIssueId)}?login_id=${encodeURIComponent(loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`
            );
            const assistantContent = extractLatestAssistantMessageContent(detail?.messages);
            const summarizedAssistantContent = formatAssistantResponseForVoice(assistantContent) || assistantContent;

            if (summarizedAssistantContent) {
              queueAppServerReport({
                kind: "final",
                text: summarizedAssistantContent,
                latestPrompt
              });
              return;
            }
          } catch {
            // ignore and retry
          }
        }
      })();

      return true;
    },
    [apiRequest, bridgeId, loginId, queueAppServerReport]
  );

  const executeVoiceTool = useCallback(
    async (toolName, argumentsPayload = {}) => {
      if (toolName === "delegate_to_app_server") {
        const prompt = String(argumentsPayload?.prompt ?? userTranscriptBufferRef.current ?? "").trim();

        if (!prompt) {
          return {
            ok: false,
            error: "전달할 요청 프롬프트가 비어 있습니다."
          };
        }

        if (typeof onSubmitPrompt !== "function") {
          return {
            ok: false,
            error: "app-server 작업 전달 함수를 찾지 못했습니다.",
            prompt
          };
        }

        try {
          const result = await onSubmitPrompt(prompt);
          const normalizedResult = normalizeToolResponse(result, {
            accepted: false,
            prompt,
            thread_id: String(thread?.id ?? "").trim(),
            project_id: String(project?.id ?? "").trim()
          });
          const issueId = String(normalizedResult?.issue_id ?? "").trim();

          if (normalizedResult.ok && issueId) {
            pollIssueForFinalReport(issueId, prompt);
          }

          return normalizedResult;
        } catch (error) {
          return {
            ok: false,
            accepted: false,
            prompt,
            error: describeVoiceError(error),
            thread_id: String(thread?.id ?? "").trim(),
            project_id: String(project?.id ?? "").trim()
          };
        }
      }

      return invokeRemoteVoiceTool(toolName, argumentsPayload);
    },
    [invokeRemoteVoiceTool, onSubmitPrompt, pollIssueForFinalReport, project?.id, thread?.id]
  );

  const handleRealtimeResponseDone = useCallback(
    async (response) => {
      const responseChannel = String(response?.metadata?.channel ?? "").trim();
      const functionCalls = extractFunctionCallsFromResponse(response);

      if (functionCalls.length > 0) {
        let handoffToNewThread = false;

        for (const functionCall of functionCalls) {
          if (processedFunctionCallIdsRef.current.has(functionCall.callId)) {
            continue;
          }

          processedFunctionCallIdsRef.current.add(functionCall.callId);
          const result = await executeVoiceTool(functionCall.name, functionCall.arguments);

          if (String(result?.switch_to_thread_id ?? "").trim()) {
            handoffToNewThread = true;
          }

          sendRealtimeClientEvent(buildFunctionCallOutputEvent(functionCall.callId, result));
        }

        if (handoffToNewThread) {
          assistantTranscriptBufferRef.current = "";
          assistantSubtitleBufferRef.current = "";
          queuedAppServerReportRef.current = null;
          appServerReportInFlightRef.current = false;
          lastProgressReportSourceRef.current = "";
          lastFinalReportSourceRef.current = "";
          setState((current) => ({
            ...current,
            latestAssistantTranscript: "",
            latestAssistantSubtitle: "",
            isResponding: false,
            error: ""
          }));
          return;
        }

        requestVoiceTurnResponse({
          source: "function_call_output"
        });
        return;
      }

      const assistantText = extractAssistantTextFromResponse(response);

      if (assistantText) {
        assistantTranscriptBufferRef.current = assistantText;
        setState((current) => ({
          ...current,
          latestAssistantTranscript: assistantText,
          latestAssistantSubtitle: current.latestAssistantSubtitle || assistantText,
          error: ""
        }));
      }

      if (responseChannel === REALTIME_RESPONSE_CHANNEL_APP_SERVER_REPORT) {
        appServerReportInFlightRef.current = false;
        flushQueuedAppServerReport();
      }

      setState((current) => ({
        ...current,
        isResponding: false
      }));
    },
    [executeVoiceTool, flushQueuedAppServerReport, requestVoiceTurnResponse, sendRealtimeClientEvent]
  );

  const handleRealtimeEvent = useCallback(
    async (event) => {
      const type = String(event?.type ?? "").trim();

      if (!type) {
        return;
      }

      switch (type) {
        case "session.created": {
          setState((current) => ({
            ...current,
            sessionId: String(event?.session?.id ?? current.sessionId ?? "").trim()
          }));
          return;
        }

        case "session.updated": {
          setState((current) => ({
            ...current,
            sessionId: String(event?.session?.id ?? current.sessionId ?? "").trim()
          }));
          return;
        }

        case "response.created": {
          assistantTranscriptBufferRef.current = "";
          assistantSubtitleBufferRef.current = "";
          setState((current) => ({
            ...current,
            isResponding: true,
            error: "",
            latestAssistantSubtitle: ""
          }));
          return;
        }

        case "response.output_text.delta": {
          const delta = String(event?.delta ?? "");

          if (!delta) {
            return;
          }

          assistantTranscriptBufferRef.current += delta;
          setState((current) => ({
            ...current,
            latestAssistantTranscript: assistantTranscriptBufferRef.current.trim()
          }));
          return;
        }

        case "response.output_text.done": {
          const transcript = String(event?.text ?? assistantTranscriptBufferRef.current ?? "").trim();

          if (!transcript) {
            return;
          }

          assistantTranscriptBufferRef.current = transcript;
          setState((current) => ({
            ...current,
            latestAssistantTranscript: transcript
          }));
          return;
        }

        case "response.output_audio_transcript.delta": {
          const delta = String(event?.delta ?? "");

          if (!delta) {
            return;
          }

          assistantTranscriptBufferRef.current += delta;
          assistantSubtitleBufferRef.current += delta;
          setState((current) => ({
            ...current,
            latestAssistantTranscript: assistantTranscriptBufferRef.current.trim(),
            latestAssistantSubtitle: assistantSubtitleBufferRef.current.trim()
          }));
          return;
        }

        case "response.output_audio_transcript.done": {
          const transcript = String(event?.transcript ?? assistantTranscriptBufferRef.current ?? "").trim();

          if (!transcript) {
            return;
          }

          assistantTranscriptBufferRef.current = transcript;
          assistantSubtitleBufferRef.current = transcript;
          setState((current) => ({
            ...current,
            latestAssistantTranscript: transcript,
            latestAssistantSubtitle: transcript
          }));
          return;
        }

        case "response.done": {
          await handleRealtimeResponseDone(event?.response ?? null);
          return;
        }

        case "input_audio_buffer.speech_started": {
          hasSubmittedCurrentSpeechRef.current = false;
          setState((current) => ({
            ...current,
            isListening: true
          }));
          return;
        }

        case "input_audio_buffer.speech_stopped":
        case "input_audio_buffer.committed": {
          setState((current) => ({
            ...current,
            isListening: false
          }));
          return;
        }

        case "conversation.item.input_audio_transcription.delta": {
          const delta = String(event?.delta ?? "").trim();

          if (!delta) {
            return;
          }

          userTranscriptBufferRef.current += delta;
          setState((current) => ({
            ...current,
            latestUserTranscript: userTranscriptBufferRef.current
          }));
          return;
        }

        case "conversation.item.input_audio_transcription.completed": {
          const transcript = String(event?.transcript ?? "").trim();
          userTranscriptBufferRef.current = transcript || userTranscriptBufferRef.current;
          const committedTranscript = transcript || userTranscriptBufferRef.current;
          setState((current) => ({
            ...current,
            latestUserTranscript: committedTranscript || current.latestUserTranscript
          }));

          if (!committedTranscript || hasSubmittedCurrentSpeechRef.current) {
            return;
          }

          hasSubmittedCurrentSpeechRef.current = true;

          if (!requestVoiceTurnResponse({ source: "input_audio_transcription_completed" })) {
            setState((current) => ({
              ...current,
              error: "Realtime 응답 생성을 시작하지 못했습니다."
            }));
          }
          return;
        }

        case "error": {
          appServerReportInFlightRef.current = false;
          setState((current) => ({
            ...current,
            error: String(event?.error?.message ?? "실시간 음성 이벤트 처리 중 오류가 발생했습니다."),
            isResponding: false,
            isListening: false
          }));
          return;
        }

        default:
          return;
      }
    },
    [handleRealtimeResponseDone, requestVoiceTurnResponse]
  );

  useEffect(() => {
    if (!enabled || state.connectionState !== "connected") {
      return;
    }

    const normalizedFinalText = String(appServerFinalText ?? "").trim();

    if (normalizedFinalText) {
      queueAppServerReport({
        kind: "final",
        text: normalizedFinalText,
        latestPrompt: userTranscriptBufferRef.current
      });
      return;
    }

    const normalizedProgressText = String(appServerProgressText ?? "").trim();

    if (!normalizedProgressText) {
      return;
    }

    queueAppServerReport({
      kind: "progress",
      text: normalizedProgressText,
      latestPrompt: userTranscriptBufferRef.current
    });
  }, [appServerFinalText, appServerProgressText, enabled, queueAppServerReport, state.connectionState]);

  const startSession = useCallback(async () => {
    if (!loginId || !bridgeId || !project?.id || typeof apiRequest !== "function") {
      return false;
    }

    if (connectInFlightRef.current) {
      return connectInFlightRef.current;
    }

    const connectPromise = (async () => {
      const sessionVersion = sessionVersionRef.current + 1;
      const normalizedSessionContextKey =
        String(sessionContextKey ?? "").trim() || `${String(project?.id ?? "").trim()}:${String(thread?.id ?? "").trim() || "project-intake"}`;

      try {
        activeSessionContextKeyRef.current = normalizedSessionContextKey;
        await disconnectSession({ preserveTranscript: true, preservePendingIssuePoll: true });
        activeSessionContextKeyRef.current = normalizedSessionContextKey;
        sessionVersionRef.current = sessionVersion;
        processedFunctionCallIdsRef.current = new Set();
        queuedAppServerReportRef.current = null;
        appServerReportInFlightRef.current = false;
        lastProgressReportSourceRef.current = "";
        lastFinalReportSourceRef.current = "";

        setState((current) => ({
          ...current,
          connectionState: "connecting",
          micState: "requesting",
          error: ""
        }));

        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("이 브라우저는 마이크 입력을 지원하지 않습니다.");
        }

        await refreshInputDevices(preferredInputDeviceIdRef.current);

        const selectedInputDeviceId = String(preferredInputDeviceIdRef.current || "default").trim() || "default";

        const localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            ...(selectedInputDeviceId !== "default"
              ? {
                  deviceId: {
                    exact: selectedInputDeviceId
                  }
                }
              : {})
          }
        });

        if (sessionVersionRef.current !== sessionVersion) {
          localStream.getTracks().forEach((track) => track.stop());
          return false;
        }

        localStreamRef.current = localStream;
        await refreshInputDevices(selectedInputDeviceId);
        startAudioLevelMeter(localStream, "input");

        const sessionPayload = await apiRequest(
          `/api/voice/realtime-token?login_id=${encodeURIComponent(loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`,
          {
            method: "POST",
            body: JSON.stringify({
              project_id: String(project?.id ?? "").trim(),
              thread_id: String(thread?.id ?? "").trim(),
              project_name: String(project?.name ?? "").trim(),
              thread_title: String(thread?.title ?? "").trim(),
              thread_status_label: String(thread?.status ?? "").trim(),
              latest_user_text: String(latestUserText ?? "").trim(),
              latest_assistant_text: String(latestAssistantText ?? "").trim(),
              project_workspace_path: String(projectWorkspacePath ?? "").trim(),
              project_base_instructions: String(projectBaseInstructions ?? "").trim(),
              project_developer_instructions: String(projectDeveloperInstructions ?? "").trim(),
              thread_developer_instructions: String(threadDeveloperInstructions ?? "").trim(),
              thread_continuity_summary: String(threadContinuitySummary ?? "").trim(),
              latest_handoff_summary: String(latestHandoffSummary ?? "").trim(),
              recent_conversation_summary: String(recentConversationSummary ?? "").trim(),
              project_program_summary: String(projectProgramSummary ?? "").trim(),
              thread_file_context_summary: String(threadFileContextSummary ?? "").trim()
            })
          }
        );

        const clientSecret = extractClientSecret(sessionPayload);
        const callUrl = extractRealtimeCallUrl(sessionPayload);

        if (!clientSecret) {
          throw new Error("OpenAI realtime client secret이 비어 있습니다.");
        }

        const peerConnection = new RTCPeerConnection();
        const remoteAudio = new Audio();
        remoteAudio.autoplay = true;
        remoteAudio.playsInline = true;
        remoteAudioRef.current = remoteAudio;

        peerConnection.ontrack = (event) => {
          if (disconnectingRef.current || sessionVersionRef.current !== sessionVersion) {
            return;
          }

          const remoteStream = event.streams[0];

          if (remoteStream) {
            remoteAudio.srcObject = remoteStream;
            startAudioLevelMeter(remoteStream, "output");
          }

          void remoteAudio.play().catch(() => {});
        };

        peerConnection.onconnectionstatechange = () => {
          if (disconnectingRef.current || sessionVersionRef.current !== sessionVersion) {
            return;
          }

          const nextState = peerConnection.connectionState;

          setState((current) => ({
            ...current,
            connectionState:
              nextState === "connected"
                ? "connected"
                : nextState === "failed" || nextState === "disconnected" || nextState === "closed"
                  ? "error"
                  : current.connectionState,
            micState:
              nextState === "connected"
                ? "listening"
                : nextState === "failed" || nextState === "disconnected" || nextState === "closed"
                  ? "error"
                  : current.micState
          }));
        };

        localStream.getTracks().forEach((track) => {
          peerConnection.addTrack(track, localStream);
        });

        const dataChannel = peerConnection.createDataChannel(REALTIME_EVENT_CHANNEL);
        dataChannel.onopen = () => {
          if (disconnectingRef.current || sessionVersionRef.current !== sessionVersion) {
            return;
          }

          setState((current) => ({
            ...current,
            connectionState: "connected",
            micState: "listening"
          }));
        };
        dataChannel.onmessage = (rawEvent) => {
          if (disconnectingRef.current || sessionVersionRef.current !== sessionVersion) {
            return;
          }

          const payload = parseRealtimeJson(rawEvent?.data);

          if (!payload) {
            return;
          }

          void handleRealtimeEvent(payload);
        };
        dataChannel.onclose = () => {
          if (disconnectingRef.current || sessionVersionRef.current !== sessionVersion) {
            return;
          }

          setState((current) => ({
            ...current,
            connectionState: enabled ? "error" : "idle",
            micState: enabled ? "error" : "idle",
            isListening: false,
            isResponding: false
          }));
        };

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        const sdpResponse = await fetch(callUrl, {
          method: "POST",
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${clientSecret}`,
            "Content-Type": "application/sdp"
          }
        });

        if (!sdpResponse.ok) {
          const detail = await sdpResponse.text();
          throw new Error(`OpenAI realtime call 연결에 실패했습니다. ${detail}`);
        }

        const answerSdp = await sdpResponse.text();
        await peerConnection.setRemoteDescription({
          type: "answer",
          sdp: answerSdp
        });

        if (sessionVersionRef.current !== sessionVersion) {
          dataChannel.close?.();
          peerConnection.getSenders?.().forEach((sender) => sender.track?.stop?.());
          peerConnection.close?.();
          remoteAudio.pause?.();
          remoteAudio.srcObject = null;
          return false;
        }

        peerConnectionRef.current = peerConnection;
        dataChannelRef.current = dataChannel;
        activeSessionContextKeyRef.current = normalizedSessionContextKey;

        setState((current) => ({
          ...current,
          connectionState: "connected",
          micState: "listening",
          sessionId: String(sessionPayload?.session?.id ?? "").trim(),
          error: ""
        }));

        return true;
      } catch (error) {
        if (disconnectingRef.current || sessionVersionRef.current !== sessionVersion) {
          return false;
        }

        await disconnectSession({ preserveTranscript: true, preservePendingIssuePoll: true });
        activeSessionContextKeyRef.current = normalizedSessionContextKey;
        setState((current) => ({
          ...current,
          connectionState: "error",
          micState: "error",
          error: describeVoiceError(error)
        }));
        return false;
      } finally {
        connectInFlightRef.current = null;
      }
    })();

    connectInFlightRef.current = connectPromise;
    return connectPromise;
  }, [
    apiRequest,
    bridgeId,
    disconnectSession,
    handleRealtimeEvent,
    latestAssistantText,
    latestUserText,
    loginId,
    project?.id,
    project?.name,
    sessionContextKey,
    projectBaseInstructions,
    projectDeveloperInstructions,
    projectProgramSummary,
    projectWorkspacePath,
    recentConversationSummary,
    refreshInputDevices,
    startAudioLevelMeter,
    latestHandoffSummary,
    threadFileContextSummary,
    thread?.id,
    thread?.status,
    thread?.title,
    threadContinuitySummary,
    threadDeveloperInstructions
  ]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (state.connectionState !== "idle" || connectInFlightRef.current || peerConnectionRef.current || dataChannelRef.current) {
      return;
    }

    void startSession();
  }, [enabled, startSession, state.connectionState]);

  const cancelResponse = useCallback(() => {
    const accepted = sendRealtimeClientEvent({
      type: "response.cancel"
    });

    if (accepted) {
      setState((current) => ({
        ...current,
        isResponding: false
      }));
    }

    return accepted;
  }, [sendRealtimeClientEvent]);

  const selectInputDevice = useCallback(
    async (deviceId) => {
      const normalizedDeviceId = String(deviceId ?? "").trim() || "default";
      preferredInputDeviceIdRef.current = normalizedDeviceId;

      setState((current) => ({
        ...current,
        selectedInputDeviceId: normalizedDeviceId
      }));

      await refreshInputDevices(normalizedDeviceId);

      if (state.connectionState === "connected" || state.connectionState === "connecting") {
        await startSession();
      }

      return true;
    },
    [refreshInputDevices, startSession, state.connectionState]
  );

  const summary = useMemo(
    () => ({
      ...state,
      ready: state.connectionState === "connected",
      statusLabel:
        state.connectionState === "connected"
          ? state.isResponding
            ? "OCTOP RESPONDING"
            : state.isListening
              ? "VOICE ACTIVE"
              : "VOICE STANDBY"
          : state.connectionState === "connecting"
            ? "VOICE LINKING"
            : state.connectionState === "error"
              ? "VOICE DEGRADED"
              : "VOICE IDLE"
    }),
    [state]
  );

  return {
    ...summary,
    audioMetricsRef,
    audioMetricsStore,
    startSession,
    stopSession: disconnectSession,
    cancelResponse,
    refreshInputDevices,
    selectInputDevice
  };
}
