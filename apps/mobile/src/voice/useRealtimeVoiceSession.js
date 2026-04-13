import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_VOICE_LEVEL_HISTORY,
  describeVoiceError,
  parseRealtimeJson,
  REALTIME_EVENT_CHANNEL
} from "./realtimeVoiceProtocol.js";

function createInitialState() {
  return {
    connectionState: "idle",
    micState: "idle",
    isListening: false,
    isResponding: false,
    audioLevel: 0,
    levelHistory: [...DEFAULT_VOICE_LEVEL_HISTORY],
    inputDevices: [{ deviceId: "default", label: "기본 마이크" }],
    selectedInputDeviceId: "default",
    latestUserTranscript: "",
    latestAssistantTranscript: "",
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

export default function useRealtimeVoiceSession({
  enabled = false,
  apiRequest,
  loginId = "",
  bridgeId = "",
  project = null,
  thread = null,
  latestUserText = "",
  latestAssistantText = "",
  authoritativeAssistantText = "",
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
  const narrationAudioRef = useRef(null);
  const narrationObjectUrlRef = useRef("");
  const narrationAbortControllerRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const analyserDataRef = useRef(null);
  const animationFrameRef = useRef(0);
  const assistantTranscriptBufferRef = useRef("");
  const userTranscriptBufferRef = useRef("");
  const connectInFlightRef = useRef(null);
  const disconnectingRef = useRef(false);
  const sessionVersionRef = useRef(0);
  const preferredInputDeviceIdRef = useRef("default");
  const hasSubmittedCurrentSpeechRef = useRef(false);
  const lastNarratedAssistantTextRef = useRef("");
  const pendingNarrationTextRef = useRef("");

  useEffect(() => {
    setState((current) => {
      const nextUserTranscript = current.latestUserTranscript || String(latestUserText ?? "").trim();
      const nextAssistantTranscript = current.latestAssistantTranscript || String(latestAssistantText ?? "").trim();

      if (
        nextUserTranscript === current.latestUserTranscript &&
        nextAssistantTranscript === current.latestAssistantTranscript
      ) {
        return current;
      }

      return {
        ...current,
        latestUserTranscript: nextUserTranscript,
        latestAssistantTranscript: nextAssistantTranscript
      };
    });
  }, [latestAssistantText, latestUserText]);

  const stopNarrationPlayback = useCallback(() => {
    narrationAbortControllerRef.current?.abort?.();
    narrationAbortControllerRef.current = null;

    const narrationAudio = narrationAudioRef.current;

    if (narrationAudio) {
      narrationAudio.onended = null;
      narrationAudio.onerror = null;
      narrationAudio.pause?.();
      narrationAudio.src = "";
    }

    if (narrationObjectUrlRef.current && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(narrationObjectUrlRef.current);
    }

    narrationObjectUrlRef.current = "";
  }, []);

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

  const disconnectSession = useCallback(async ({ preserveTranscript = true } = {}) => {
    disconnectingRef.current = true;
    sessionVersionRef.current += 1;

    const activePeerConnection = peerConnectionRef.current;
    const activeDataChannel = dataChannelRef.current;

    if (animationFrameRef.current) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = 0;
    }

    try {
      analyserRef.current?.disconnect?.();
    } catch {
      // ignore
    }

    try {
      if (audioContextRef.current && audioContextRef.current.state !== "closed") {
        await audioContextRef.current.close();
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

    stopNarrationPlayback();

    peerConnectionRef.current = null;
    dataChannelRef.current = null;
    localStreamRef.current = null;
    audioContextRef.current = null;
    analyserRef.current = null;
    analyserDataRef.current = null;
    connectInFlightRef.current = null;
    assistantTranscriptBufferRef.current = preserveTranscript ? assistantTranscriptBufferRef.current : "";
    userTranscriptBufferRef.current = preserveTranscript ? userTranscriptBufferRef.current : "";

    setState((current) => ({
      ...current,
      connectionState: "idle",
      micState: "idle",
      isListening: false,
      isResponding: false,
      audioLevel: 0,
      levelHistory: [...DEFAULT_VOICE_LEVEL_HISTORY],
      error: "",
      sessionId: "",
      latestUserTranscript: preserveTranscript ? current.latestUserTranscript : "",
      latestAssistantTranscript: preserveTranscript ? current.latestAssistantTranscript : ""
    }));

    disconnectingRef.current = false;
  }, [stopNarrationPlayback]);

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

  const startAudioLevelMeter = useCallback((stream) => {
    if (typeof window === "undefined") {
      return;
    }

    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;

    if (!AudioContextConstructor) {
      return;
    }

    const audioContext = new AudioContextConstructor();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.82;

    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    const frequencyData = new Uint8Array(analyser.frequencyBinCount);
    audioContextRef.current = audioContext;
    analyserRef.current = source;
    analyserDataRef.current = frequencyData;

    const tick = () => {
      const activeAnalyser = analyser;
      const activeData = analyserDataRef.current;

      if (!activeAnalyser || !activeData) {
        return;
      }

      activeAnalyser.getByteFrequencyData(activeData);
      let sum = 0;
      let peak = 0;

      for (let index = 0; index < activeData.length; index += 1) {
        const normalized = activeData[index] / 255;
        sum += normalized;
        peak = Math.max(peak, normalized);
      }

      const average = activeData.length > 0 ? sum / activeData.length : 0;
      const nextLevel = Math.min(1, average * 1.35 + peak * 0.55);

      setState((current) => ({
        ...current,
        audioLevel: nextLevel,
        levelHistory: [...current.levelHistory.slice(-23), Math.max(0.08, nextLevel)]
      }));

      animationFrameRef.current = window.requestAnimationFrame(tick);
    };

    animationFrameRef.current = window.requestAnimationFrame(tick);
  }, []);

  const narrateAssistantText = useCallback(async (text) => {
    const narration = String(text ?? "").trim();

    if (!narration || !loginId || !bridgeId) {
      return false;
    }

    stopNarrationPlayback();

    assistantTranscriptBufferRef.current = narration;
    setState((current) => ({
      ...current,
      latestAssistantTranscript: narration,
      isResponding: true,
      error: ""
    }));

    const abortController = new AbortController();
    narrationAbortControllerRef.current = abortController;
    let payload = null;

    try {
      payload = await apiRequest(
        `/api/voice/narrations?login_id=${encodeURIComponent(loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`,
        {
          method: "POST",
          signal: abortController.signal,
          body: JSON.stringify({
            text: narration
          })
        }
      );
    } catch (error) {
      if (abortController.signal.aborted) {
        const abortError = new Error("voice narration aborted");
        abortError.name = "AbortError";
        throw abortError;
      }

      throw error;
    }

    const audioBase64 = String(payload?.audio_base64 ?? "").trim();

    if (!audioBase64) {
      throw new Error("음성 응답 오디오 데이터가 비어 있습니다.");
    }

    const contentType = String(payload?.content_type ?? "audio/mpeg").trim() || "audio/mpeg";
    const binary = typeof window !== "undefined" && typeof window.atob === "function" ? window.atob(audioBase64) : atob(audioBase64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: contentType }));
    narrationObjectUrlRef.current = objectUrl;

    const narrationAudio = narrationAudioRef.current ?? new Audio();
    narrationAudio.autoplay = true;
    narrationAudio.playsInline = true;
    narrationAudioRef.current = narrationAudio;
    narrationAudio.onended = () => {
      setState((current) => ({
        ...current,
        isResponding: false
      }));
    };
    narrationAudio.onerror = () => {
      setState((current) => ({
        ...current,
        isResponding: false,
        error: "음성 응답 오디오를 재생하지 못했습니다."
      }));
    };
    narrationAudio.src = objectUrl;
    await narrationAudio.play();
    setState((current) => ({
      ...current,
      isResponding: false
    }));
    return true;
  }, [apiRequest, bridgeId, loginId, stopNarrationPlayback]);

  const handleRealtimeEvent = useCallback(
    async (event) => {
      const type = String(event?.type ?? "").trim();

      if (!type) {
        return;
      }

      switch (type) {
        case "session.created":
        case "session.updated": {
          setState((current) => ({
            ...current,
            sessionId: String(event?.session?.id ?? current.sessionId ?? "").trim()
          }));
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

          if (!committedTranscript || hasSubmittedCurrentSpeechRef.current || typeof onSubmitPrompt !== "function") {
            return;
          }

          hasSubmittedCurrentSpeechRef.current = true;

          try {
            const accepted = await onSubmitPrompt(committedTranscript);

            if (accepted === false) {
              setState((current) => ({
                ...current,
                error: "음성 요청을 현재 채팅 작업에 반영하지 못했습니다."
              }));
            }
          } catch (error) {
            setState((current) => ({
              ...current,
              error: describeVoiceError(error)
            }));
          }
          return;
        }

        case "error": {
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
    [onSubmitPrompt]
  );

  useEffect(() => {
    const narration = String(authoritativeAssistantText ?? "").trim();

    if (!enabled || state.connectionState !== "connected" || !narration) {
      return;
    }

    if (narration === lastNarratedAssistantTextRef.current || narration === pendingNarrationTextRef.current) {
      return;
    }

    pendingNarrationTextRef.current = narration;

    void narrateAssistantText(narration)
      .then((accepted) => {
        if (accepted) {
          lastNarratedAssistantTextRef.current = narration;
        }
      })
      .catch((error) => {
        if (String(error?.name ?? "").trim() === "AbortError") {
          return;
        }

        setState((current) => ({
          ...current,
          error: describeVoiceError(error)
        }));
      })
      .finally(() => {
        if (pendingNarrationTextRef.current === narration) {
          pendingNarrationTextRef.current = "";
        }
      });
  }, [authoritativeAssistantText, enabled, narrateAssistantText, state.connectionState]);

  const startSession = useCallback(async () => {
    if (!loginId || !bridgeId || !thread?.id || typeof apiRequest !== "function") {
      return false;
    }

    if (connectInFlightRef.current) {
      return connectInFlightRef.current;
    }

    const connectPromise = (async () => {
      const sessionVersion = sessionVersionRef.current + 1;

      try {
        await disconnectSession({ preserveTranscript: true });
        sessionVersionRef.current = sessionVersion;
        lastNarratedAssistantTextRef.current = "";
        pendingNarrationTextRef.current = "";

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
        startAudioLevelMeter(localStream);

        const sessionPayload = await apiRequest(
          `/api/voice/sessions?login_id=${encodeURIComponent(loginId)}&bridge_id=${encodeURIComponent(bridgeId)}`,
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

        const clientSecret = String(sessionPayload?.value ?? "").trim();
        const callUrl = String(sessionPayload?.call_url ?? "https://api.openai.com/v1/realtime/calls").trim();

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

          remoteAudio.srcObject = event.streams[0];
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

        await disconnectSession({ preserveTranscript: true });
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
    threadDeveloperInstructions,
    onSubmitPrompt
  ]);

  const cancelResponse = useCallback(() => {
    const dataChannel = dataChannelRef.current;

    if (!dataChannel || dataChannel.readyState !== "open") {
      return false;
    }

    dataChannel.send(
      JSON.stringify({
        type: "response.cancel"
      })
    );

    setState((current) => ({
      ...current,
      isResponding: false
    }));
    return true;
  }, []);

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
    startSession,
    stopSession: disconnectSession,
    cancelResponse,
    refreshInputDevices,
    selectInputDevice
  };
}
