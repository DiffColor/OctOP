import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_VOICE_LEVEL_HISTORY } from "./realtimeVoiceProtocol.js";

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
    inputDevices: [{ deviceId: "default", label: "브라우저 음성 입력" }],
    selectedInputDeviceId: "default",
    latestUserTranscript: "",
    latestAssistantTranscript: "",
    latestAssistantSubtitle: "",
    error: ""
  };
}

function normalizeTranscript(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function joinTranscriptParts(parts, { mergeStrategy = "prefix" } = {}) {
  const normalizedParts = parts
    .map((part) => normalizeTranscript(part))
    .filter(Boolean);
  const combinedParts = [];

  for (const part of normalizedParts) {
    const latestPart = combinedParts.at(-1) ?? "";

    if (!latestPart) {
      combinedParts.push(part);
      continue;
    }

    if (part === latestPart) {
      continue;
    }

    if (mergeStrategy === "prefix") {
      if (part.startsWith(latestPart)) {
        combinedParts[combinedParts.length - 1] = part;
        continue;
      }

      if (latestPart.startsWith(part)) {
        continue;
      }
    }

    combinedParts.push(part);
  }

  return normalizeTranscript(combinedParts.join(" "));
}

function buildFinalTranscriptFromEntries(entries, resultIndex = 0) {
  const normalizedResultIndex = Number.isInteger(resultIndex) ? resultIndex : 0;
  const stableParts = [];
  const changedParts = [];

  for (const entry of Array.isArray(entries) ? entries : []) {
    const [index, text] = Array.isArray(entry) ? entry : [];

    if (!normalizeTranscript(text)) {
      continue;
    }

    if (Number(index) < normalizedResultIndex) {
      stableParts.push(text);
      continue;
    }

    changedParts.push(text);
  }

  const stableTranscript = joinTranscriptParts(stableParts, {
    mergeStrategy: "exact"
  });
  const changedTranscript = joinTranscriptParts(changedParts, {
    mergeStrategy: "prefix"
  });

  return joinTranscriptParts([stableTranscript, changedTranscript], {
    mergeStrategy: "exact"
  });
}

function extractTranscriptDelta(previousTranscript, nextTranscript) {
  const normalizedPreviousTranscript = normalizeTranscript(previousTranscript);
  const normalizedNextTranscript = normalizeTranscript(nextTranscript);

  if (!normalizedNextTranscript) {
    return "";
  }

  if (!normalizedPreviousTranscript) {
    return normalizedNextTranscript;
  }

  if (normalizedNextTranscript === normalizedPreviousTranscript) {
    return "";
  }

  if (!normalizedNextTranscript.startsWith(normalizedPreviousTranscript)) {
    return "";
  }

  return normalizeTranscript(normalizedNextTranscript.slice(normalizedPreviousTranscript.length));
}

function describeSpeechRecognitionError(event) {
  const errorCode = String(event?.error ?? "").trim().toLowerCase();

  switch (errorCode) {
    case "not-allowed":
    case "service-not-allowed":
      return "브라우저 음성 입력 권한이 없어 STT를 시작할 수 없습니다.";
    case "audio-capture":
      return "마이크를 사용할 수 없어 STT를 시작할 수 없습니다.";
    case "network":
      return "브라우저 음성 입력 네트워크 상태가 불안정합니다.";
    case "no-speech":
      return "";
    case "language-not-supported":
      return "현재 브라우저가 한국어 음성 입력을 지원하지 않습니다.";
    default:
      return "브라우저 음성 입력을 계속할 수 없습니다.";
  }
}

function describeNarrationError(error) {
  const message = String(error?.message ?? "").trim();
  const code = String(error?.code ?? error?.payload?.code ?? "").trim();

  if (code === "voice_narration_disabled" || code === "voice_session_api_key_missing") {
    return "음성 TTS를 사용할 수 없습니다.";
  }

  return message || "음성 TTS 응답을 생성하지 못했습니다.";
}

function decodeBase64ToBlob(base64, contentType = "audio/mpeg") {
  const binary = atob(String(base64 ?? "").trim());
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: contentType });
}

export default function useFallbackVoiceSession({
  active = false,
  ttsEnabled = false,
  apiRequest = null,
  loginId = "",
  bridgeId = "",
  latestAssistantText = "",
  appServerFinalText = "",
  appServerProgressText = "",
  onSubmitPrompt = null,
  onDraftTranscript = null,
  onTtsAvailabilityChange = null
}) {
  const [state, setState] = useState(createInitialState);
  const recognitionRef = useRef(null);
  const recognitionRestartTimerRef = useRef(null);
  const manualStopRef = useRef(false);
  const activeRef = useRef(active);
  const audioMetricsRef = useRef(createAudioMetricsSnapshot());
  const audioMetricsUiSnapshotRef = useRef(createAudioMetricsSnapshot());
  const audioMetricsUiListenersRef = useRef(new Set());
  const audioAnimationTimerRef = useRef(null);
  const latestDeliveredTranscriptRef = useRef("");
  const latestDeliveredTranscriptAtRef = useRef(0);
  const finalResultTranscriptMapRef = useRef(new Map());
  const committedFinalTranscriptRef = useRef("");
  const narrationAudioRef = useRef(null);
  const narrationObjectUrlRef = useRef("");
  const narrationRequestIdRef = useRef(0);
  const lastNarratedTextRef = useRef("");
  const lastAssistantTextRef = useRef("");

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

  const resetAudioMetrics = useCallback(() => {
    const snapshot = createAudioMetricsSnapshot();
    audioMetricsRef.current = snapshot;
    publishAudioMetricsUiSnapshot(snapshot);
  }, [publishAudioMetricsUiSnapshot]);

  const stopNarrationPlayback = useCallback(() => {
    const audio = narrationAudioRef.current;

    if (audio) {
      audio.pause?.();
      narrationAudioRef.current = null;
    }

    if (narrationObjectUrlRef.current) {
      URL.revokeObjectURL(narrationObjectUrlRef.current);
      narrationObjectUrlRef.current = "";
    }
  }, []);

  const stopListening = useCallback(() => {
    manualStopRef.current = true;

    if (recognitionRestartTimerRef.current) {
      window.clearTimeout(recognitionRestartTimerRef.current);
      recognitionRestartTimerRef.current = null;
    }

    try {
      recognitionRef.current?.stop?.();
    } catch {
      // ignore
    }

    setState((current) => ({
      ...current,
      micState: "idle",
      isListening: false
    }));
  }, []);

  const cleanupRecognition = useCallback(() => {
    stopListening();

    if (recognitionRef.current) {
      recognitionRef.current.onstart = null;
      recognitionRef.current.onresult = null;
      recognitionRef.current.onerror = null;
      recognitionRef.current.onend = null;
      recognitionRef.current = null;
    }
  }, [stopListening]);

  const deliverTranscript = useCallback(
    (transcript, { dedupeKey } = {}) => {
      const normalizedTranscript = normalizeTranscript(transcript);
      const normalizedDedupeKey = normalizeTranscript(dedupeKey || normalizedTranscript);

      if (!normalizedTranscript || !normalizedDedupeKey) {
        return;
      }

      const now = Date.now();

      if (
        latestDeliveredTranscriptRef.current === normalizedDedupeKey &&
        now - latestDeliveredTranscriptAtRef.current < 1800
      ) {
        return;
      }

      latestDeliveredTranscriptRef.current = normalizedDedupeKey;
      latestDeliveredTranscriptAtRef.current = now;

      if (ttsEnabled) {
        onSubmitPrompt?.(normalizedTranscript);
        return;
      }

      onDraftTranscript?.(normalizedTranscript);
    },
    [onDraftTranscript, onSubmitPrompt, ttsEnabled]
  );

  const ensureRecognitionInstance = useCallback(() => {
    if (recognitionRef.current) {
      return recognitionRef.current;
    }

    if (typeof window === "undefined") {
      return null;
    }

    const SpeechRecognitionConstructor = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognitionConstructor) {
      setState((current) => ({
        ...current,
        connectionState: activeRef.current ? "error" : "idle",
        micState: activeRef.current ? "error" : "idle",
        error: activeRef.current ? "이 브라우저는 음성 입력(STT)을 지원하지 않습니다." : current.error
      }));
      return null;
    }

    const recognition = new SpeechRecognitionConstructor();
    recognition.lang = "ko-KR";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      finalResultTranscriptMapRef.current = new Map();
      committedFinalTranscriptRef.current = "";

      setState((current) => ({
        ...current,
        connectionState: "connected",
        micState: "listening",
        isListening: true,
        error: ""
      }));
    };

    recognition.onresult = (event) => {
      const nextFinalResultTranscriptMap = new Map(finalResultTranscriptMapRef.current);
      const interimTranscripts = [];
      const speechResults = Array.from(event?.results ?? []);

      for (let index = 0; index < speechResults.length; index += 1) {
        const result = speechResults[index];
        const text = normalizeTranscript(result?.[0]?.transcript ?? "");

        if (!text) {
          continue;
        }

        if (result.isFinal) {
          nextFinalResultTranscriptMap.set(index, text);
        } else {
          nextFinalResultTranscriptMap.delete(index);
          interimTranscripts.push(text);
        }
      }

      finalResultTranscriptMapRef.current = nextFinalResultTranscriptMap;

      const latestFinalTranscript = buildFinalTranscriptFromEntries(
        [...nextFinalResultTranscriptMap.entries()].sort(
          ([leftIndex], [rightIndex]) => leftIndex - rightIndex
        ),
        event?.resultIndex ?? 0
      );
      const interimTranscript = joinTranscriptParts(interimTranscripts);
      const nextPreviewText = joinTranscriptParts([latestFinalTranscript, interimTranscript]);

      if (nextPreviewText) {
        setState((current) => ({
          ...current,
          latestUserTranscript: nextPreviewText
        }));
      }

      const transcriptDelta = extractTranscriptDelta(committedFinalTranscriptRef.current, latestFinalTranscript);

      if (ttsEnabled && transcriptDelta) {
        deliverTranscript(transcriptDelta, {
          dedupeKey: latestFinalTranscript
        });
      }

      if (!ttsEnabled && latestFinalTranscript && latestFinalTranscript !== committedFinalTranscriptRef.current) {
        onDraftTranscript?.(latestFinalTranscript);
      }

      committedFinalTranscriptRef.current = latestFinalTranscript;
    };

    recognition.onerror = (event) => {
      const nextError = describeSpeechRecognitionError(event);
      const shouldKeepListening = activeRef.current && !manualStopRef.current && !nextError;

      setState((current) => ({
        ...current,
        connectionState: activeRef.current ? "connected" : "idle",
        micState: nextError ? "error" : shouldKeepListening ? "listening" : "idle",
        isListening: shouldKeepListening ? current.isListening : false,
        error: nextError
      }));
    };

    recognition.onend = () => {
      const shouldRestart = activeRef.current && !manualStopRef.current;

      setState((current) => ({
        ...current,
        isListening: shouldRestart ? true : false,
        micState: shouldRestart
          ? current.micState === "error"
            ? "error"
            : "listening"
          : current.micState
      }));

      if (!shouldRestart) {
        return;
      }

      recognitionRestartTimerRef.current = window.setTimeout(() => {
        recognitionRestartTimerRef.current = null;

        try {
          recognition.start();
        } catch {
          // ignore repeated start race
        }
      }, 240);
    };

    recognitionRef.current = recognition;
    return recognition;
  }, [deliverTranscript, onDraftTranscript, ttsEnabled]);

  const startListening = useCallback(() => {
    if (!activeRef.current) {
      return false;
    }

    const recognition = ensureRecognitionInstance();

    if (!recognition) {
      return false;
    }

    manualStopRef.current = false;

    if (recognitionRestartTimerRef.current) {
      window.clearTimeout(recognitionRestartTimerRef.current);
      recognitionRestartTimerRef.current = null;
    }

    setState((current) => ({
      ...current,
      connectionState: "connecting",
      micState: "requesting",
      error: ""
    }));

    try {
      recognition.start();
      return true;
    } catch (error) {
      const message = String(error?.message ?? "").toLowerCase();

      if (message.includes("already started")) {
        return true;
      }

      setState((current) => ({
        ...current,
        connectionState: "error",
        micState: "error",
        isListening: false,
        error: "브라우저 음성 입력을 시작하지 못했습니다."
      }));
      return false;
    }
  }, [ensureRecognitionInstance]);

  const stopSession = useCallback(
    ({ preserveTranscript = true } = {}) => {
      activeRef.current = false;
      cleanupRecognition();
      stopNarrationPlayback();
      lastNarratedTextRef.current = "";
      lastAssistantTextRef.current = "";
      latestDeliveredTranscriptRef.current = "";
      latestDeliveredTranscriptAtRef.current = 0;
      finalResultTranscriptMapRef.current = new Map();
      committedFinalTranscriptRef.current = "";
      narrationRequestIdRef.current += 1;
      resetAudioMetrics();

      setState((current) => ({
        ...createInitialState(),
        latestUserTranscript: preserveTranscript ? current.latestUserTranscript : "",
        latestAssistantTranscript: preserveTranscript ? current.latestAssistantTranscript : "",
        latestAssistantSubtitle: preserveTranscript ? current.latestAssistantSubtitle : "",
        error: preserveTranscript ? current.error : ""
      }));
    },
    [cleanupRecognition, resetAudioMetrics, stopNarrationPlayback]
  );

  const toggleListening = useCallback(() => {
    if (state.isListening) {
      stopListening();
      return false;
    }

    return startListening();
  }, [startListening, state.isListening, stopListening]);

  useEffect(() => {
    activeRef.current = active;

    if (!active) {
      stopSession();
      return;
    }

    startListening();
  }, [active, startListening, stopSession]);

  useEffect(() => {
    if (!active) {
      return undefined;
    }

    if (audioAnimationTimerRef.current) {
      window.clearInterval(audioAnimationTimerRef.current);
      audioAnimationTimerRef.current = null;
    }

    audioAnimationTimerRef.current = window.setInterval(() => {
      const timestamp = Date.now() / 220;
      const inputLevel = state.isListening ? 0.22 + (Math.sin(timestamp) + 1) * 0.16 : 0.05;
      const outputLevel = state.isResponding ? 0.28 + (Math.cos(timestamp * 1.12) + 1) * 0.2 : 0.05;
      const audioLevel = Math.max(inputLevel, outputLevel);
      const history = [...audioMetricsRef.current.levelHistory.slice(-23), audioLevel];
      const snapshot = createAudioMetricsSnapshot({
        inputAudioLevel: inputLevel,
        outputAudioLevel: outputLevel,
        audioLevel,
        levelHistory: history
      });

      audioMetricsRef.current = snapshot;
      publishAudioMetricsUiSnapshot(snapshot);
    }, 90);

    return () => {
      if (audioAnimationTimerRef.current) {
        window.clearInterval(audioAnimationTimerRef.current);
        audioAnimationTimerRef.current = null;
      }
    };
  }, [active, publishAudioMetricsUiSnapshot, state.isListening, state.isResponding]);

  const requestNarration = useCallback(
    async (text) => {
      const normalizedText = normalizeTranscript(text);

      if (
        !ttsEnabled ||
        !normalizedText ||
        !loginId ||
        !bridgeId ||
        typeof apiRequest !== "function"
      ) {
        return false;
      }

      const requestId = narrationRequestIdRef.current + 1;
      narrationRequestIdRef.current = requestId;

      setState((current) => ({
        ...current,
        isResponding: true,
        latestAssistantTranscript: normalizedText,
        latestAssistantSubtitle: normalizedText,
        error: ""
      }));

      try {
        const payload = await apiRequest(
          `/api/voice/narrations?login_id=${encodeURIComponent(loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`,
          {
            method: "POST",
            body: JSON.stringify({
              text: normalizedText
            })
          }
        );

        if (narrationRequestIdRef.current !== requestId) {
          return false;
        }

        onTtsAvailabilityChange?.({
          status: "available",
          error: ""
        });

        const audioBase64 = String(payload?.audio_base64 ?? "").trim();

        if (!audioBase64) {
          throw new Error("음성 TTS 응답 오디오가 비어 있습니다.");
        }

        const contentType = String(payload?.content_type ?? "audio/mpeg").trim() || "audio/mpeg";
        stopNarrationPlayback();

        const objectUrl = URL.createObjectURL(decodeBase64ToBlob(audioBase64, contentType));
        narrationObjectUrlRef.current = objectUrl;

        const audio = new Audio(objectUrl);
        narrationAudioRef.current = audio;

        const finishPlayback = () => {
          if (narrationAudioRef.current === audio) {
            narrationAudioRef.current = null;
          }

          if (narrationObjectUrlRef.current === objectUrl) {
            URL.revokeObjectURL(objectUrl);
            narrationObjectUrlRef.current = "";
          }

          setState((current) => ({
            ...current,
            isResponding: false
          }));
        };

        audio.addEventListener("ended", finishPlayback, { once: true });
        audio.addEventListener("error", finishPlayback, { once: true });

        await audio.play();
        return true;
      } catch (error) {
        if (narrationRequestIdRef.current === requestId) {
          setState((current) => ({
            ...current,
            isResponding: false,
            error: describeNarrationError(error)
          }));

          onTtsAvailabilityChange?.({
            status: "blocked",
            error: describeNarrationError(error)
          });
        }

        return false;
      }
    },
    [apiRequest, bridgeId, loginId, onTtsAvailabilityChange, stopNarrationPlayback, ttsEnabled]
  );

  useEffect(() => {
    const preferredAssistantText = normalizeTranscript(appServerFinalText || appServerProgressText || latestAssistantText);

    if (!preferredAssistantText) {
      return;
    }

    lastAssistantTextRef.current = preferredAssistantText;
    setState((current) => ({
      ...current,
      latestAssistantTranscript: preferredAssistantText,
      latestAssistantSubtitle: preferredAssistantText
    }));

    if (!active || !ttsEnabled || preferredAssistantText === lastNarratedTextRef.current) {
      return;
    }

    lastNarratedTextRef.current = preferredAssistantText;
    void requestNarration(preferredAssistantText);
  }, [active, appServerFinalText, appServerProgressText, latestAssistantText, requestNarration, ttsEnabled]);

  useEffect(
    () => () => {
      stopSession({
        preserveTranscript: false
      });
    },
    [stopSession]
  );

  return {
    ...state,
    ready: active && state.connectionState === "connected",
    statusLabel:
      state.connectionState === "error"
        ? "VOICE DEGRADED"
        : state.isResponding
          ? "VOICE REPORTING"
          : state.isListening
            ? "VOICE LISTENING"
            : active
              ? "VOICE READY"
              : "VOICE IDLE",
    audioMetricsRef,
    audioMetricsStore,
    startListening,
    stopSession,
    stopListening,
    toggleListening,
    speechRecognitionSupported: Boolean(
      typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition)
    )
  };
}
