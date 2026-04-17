const { test, expect } = require('@playwright/test');
const path = require('path');
const { REPO_ROOT, StaticAppServer, buildWorkspace } = require('../helpers/static-app-server');

const MOBILE_DIST_DIR = path.join(REPO_ROOT, 'apps', 'mobile', 'dist');
const SESSION_KEY = 'octop.mobile.session';
const BRIDGE_KEY = 'octop.mobile.selectedBridge';
const WORKSPACE_LAYOUT_KEY = 'octop.mobile.workspace.layout.v1';
const WORKSPACE_SNAPSHOT_KEY = 'octop.mobile.workspace.snapshot.v1';
const THREAD_DETAIL_CACHE_KEY = 'octop.mobile.threadDetails.cache.v1';
const VOICE_CAPABILITY_CACHE_KEY = 'octop.mobile.voiceCapability.v1';

const loginId = 'playwright-user';
const bridgeId = 'bridge-voice';
const projectId = 'project-voice';
const threadId = 'thread-voice-1';
const delegatedThreadId = 'thread-voice-2';
const issueId = 'issue-voice-1';
const now = Date.now();
const threadCreatedAt = new Date(now - 15 * 60 * 1000).toISOString();
const threadUpdatedAt = new Date(now - 10 * 60 * 1000).toISOString();
const initialIssueCreatedAt = new Date(now - 9 * 60 * 1000).toISOString();
const initialAssistantAt = new Date(now - 9 * 60 * 1000 + 3000).toISOString();

const session = {
  accessToken: 'playwright-token',
  expiresAt: '2099-01-01T00:00:00.000Z',
  role: 'owner',
  userId: loginId,
  displayName: 'Playwright User',
  permissions: ['*'],
  loginId
};

const project = {
  id: projectId,
  name: 'Voice E2E Project',
  bridge_id: bridgeId,
  workspace_path: '/Users/jazzlife/Documents/Workspaces/Products/OctOP',
  base_instructions: '항상 현재 프로젝트 코드를 기준으로 판단한다.',
  developer_instructions: '추측하지 말고 실제 동작하는 결과를 우선한다.'
};

const thread = {
  id: threadId,
  title: 'Voice Thread',
  name: 'Voice Thread',
  project_id: projectId,
  status: 'idle',
  progress: 0,
  last_event: 'thread.created',
  last_message: '음성 모드 테스트 스레드',
  updated_at: threadUpdatedAt,
  created_at: threadCreatedAt,
  context_usage_percent: 12,
  context_used_tokens: 1200,
  context_window_tokens: 100000
};

const issueDetail = {
  issue: {
    id: issueId,
    thread_id: threadId,
    root_thread_id: threadId,
    title: 'Voice Issue',
    prompt: '현재 상태 알려줘',
    status: 'completed',
    attachments: [
      {
        id: 'attachment-voice-1',
        name: 'apps/mobile/src/App.jsx',
        mime_type: 'text/javascript',
        text_content: 'voice mode status panel summary'
      }
    ],
    created_at: initialIssueCreatedAt,
    updated_at: initialAssistantAt
  },
  messages: [
    {
      id: 'message-user-1',
      role: 'user',
      kind: 'prompt',
      content: '현재 상태 알려줘',
      timestamp: initialIssueCreatedAt
    },
    {
      id: 'message-assistant-1',
      role: 'assistant',
      kind: 'message',
      content: '현재 스레드는 유휴 상태입니다.',
      timestamp: initialAssistantAt
    }
  ]
};

const delegatedThread = {
  id: delegatedThreadId,
  title: '상태 알려줘',
  name: '상태 알려줘',
  project_id: projectId,
  status: 'idle',
  progress: 0,
  last_event: 'thread.created',
  last_message: '',
  updated_at: new Date(now - 2 * 60 * 1000).toISOString(),
  created_at: new Date(now - 2 * 60 * 1000).toISOString(),
  context_usage_percent: 3,
  context_used_tokens: 320,
  context_window_tokens: 100000
};

const authoritativeAssistantContent = `
[요약]
- 현재 상태를 정리했습니다.

[수정 파일]
- apps/mobile/src/App.jsx

[코드]
\`\`\`js
console.log("debug");
\`\`\`

[검증 결과]
- 음성 응답은 app-server 기준으로 정리되었습니다.

[다음 단계]
- 이어서 확인해 주세요.
`.trim();

function buildRealtimeFunctionCallResponse({ responseId = 'resp-function-1', callId = 'call-voice-1', prompt = '상태 알려줘' } = {}) {
  return {
    type: 'response.done',
    response: {
      id: responseId,
      status: 'completed',
      metadata: {
        channel: 'voice_turn'
      },
      output: [
        {
          type: 'function_call',
          status: 'completed',
          name: 'delegate_to_app_server',
          call_id: callId,
          arguments: JSON.stringify({ prompt })
        }
      ]
    }
  };
}

function buildRealtimeAssistantMessageResponse({
  responseId = 'resp-message-1',
  channel = 'voice_turn',
  kind = '',
  text = ''
} = {}) {
  return {
    type: 'response.done',
    response: {
      id: responseId,
      status: 'completed',
      metadata: {
        channel,
        ...(kind ? { kind } : {})
      },
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text
            }
          ]
        }
      ]
    }
  };
}

function buildRealtimeAssistantAudioResponse({
  responseId = 'resp-audio-1',
  channel = 'voice_turn',
  kind = '',
  transcript = ''
} = {}) {
  return {
    type: 'response.done',
    response: {
      id: responseId,
      status: 'completed',
      metadata: {
        channel,
        ...(kind ? { kind } : {})
      },
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_audio',
              transcript
            }
          ]
        }
      ]
    }
  };
}

function buildVoiceSessionResponseBody(payload = {}, sessionId = 'voice-session-1') {
  return {
    ok: true,
    value: 'client-secret-test',
    call_url: 'https://voice.test/mock-realtime-call',
    bridge_id: bridgeId,
    project_id: payload.project_id || projectId,
    thread_id: payload.thread_id || '',
    session: {
      id: sessionId,
      type: 'realtime',
      model: 'gpt-realtime',
      instructions: `당신은 OctOP의 실시간 음성 비서입니다.\n\n현재 프로젝트: ${payload.project_name || project.name}`,
      output_modalities: ['audio'],
      tool_choice: 'auto',
      tools: [
        { type: 'function', name: 'delegate_to_app_server' },
        { type: 'function', name: 'get_thread_status' },
        { type: 'function', name: 'interrupt_active_issue' }
      ],
      audio: {
        input: {
          noise_reduction: {
            type: 'near_field'
          },
          transcription: {
            model: 'gpt-4o-mini-transcribe',
            language: 'ko',
            prompt: `프로젝트: ${payload.project_name || project.name}`
          },
          turn_detection: {
            type: 'server_vad',
            interrupt_response: true,
            create_response: false,
            silence_duration_ms: 550,
            prefix_padding_ms: 250
          }
        },
        output: {
          voice: 'alloy'
        }
      }
    }
  };
}

function createWorkspaceLayout() {
  return {
    loginId,
    bridgeId,
    selectedScope: { kind: 'project', id: projectId },
    selectedThreadId: threadId,
    instantThreadId: '',
    selectedTodoChatId: '',
    draftThreadProjectId: '',
    threadComposerDrafts: {},
    projectFilterUsage: {},
    projectChipOrder: [projectId],
    threadOrderByProjectId: {
      [projectId]: [threadId]
    },
    activeView: 'thread',
    wideThreadSplitRatio: 0.5
  };
}

function createWorkspaceSnapshot() {
  return {
    version: 1,
    ownerKey: `${loginId}::${bridgeId}`,
    selectedScope: { kind: 'project', id: projectId },
    projects: [project],
    threadListsByProjectId: {
      [projectId]: [thread]
    },
    todoChats: [],
    savedAt: Date.now()
  };
}

function createThreadDetailCache() {
  return {
    version: 1,
    ownerKey: `${loginId}::${bridgeId}`,
    entries: {
      [threadId]: {
        thread,
        issues: [issueDetail.issue],
        messages: issueDetail.messages,
        loaded_issue_ids: [issueId],
        loading: false,
        error: '',
        fetchedAt: Date.now()
      }
    },
    savedAt: Date.now()
  };
}

async function seedMobileSession(page) {
  await page.addInitScript(
    ({ sessionKey, bridgeKey, layoutKey, snapshotKey, detailCacheKey, sessionValue, bridgeIdValue, layoutValue, snapshotValue, detailCacheValue }) => {
      window.localStorage.setItem(sessionKey, JSON.stringify(sessionValue));
      window.localStorage.setItem(bridgeKey, bridgeIdValue);
      window.localStorage.setItem(layoutKey, JSON.stringify(layoutValue));
      window.localStorage.setItem(snapshotKey, JSON.stringify(snapshotValue));
      window.localStorage.setItem(detailCacheKey, JSON.stringify(detailCacheValue));
    },
    {
      sessionKey: SESSION_KEY,
      bridgeKey: BRIDGE_KEY,
      layoutKey: WORKSPACE_LAYOUT_KEY,
      snapshotKey: WORKSPACE_SNAPSHOT_KEY,
      detailCacheKey: THREAD_DETAIL_CACHE_KEY,
      sessionValue: session,
      bridgeIdValue: bridgeId,
      layoutValue: createWorkspaceLayout(),
      snapshotValue: createWorkspaceSnapshot(),
      detailCacheValue: createThreadDetailCache()
    }
  );
}

async function openVoiceModeByLongPressingSend(page) {
  const sendButton = page.getByTestId('thread-prompt-send-button');
  await expect(sendButton).toBeVisible();
  await sendButton.dispatchEvent('pointerdown', {
    bubbles: true,
    button: 0,
    clientX: 24,
    clientY: 24,
    pointerId: 1,
    pointerType: 'touch'
  });
  await page.waitForTimeout(450);
}

async function seedVoiceCapabilitySnapshot(page, { realtime = 'unknown', tts = 'unknown', realtimeError = '', ttsError = '' } = {}) {
  const nowIso = new Date().toISOString();
  const dateKey = nowIso.slice(0, 10);

  await page.addInitScript(
    ({ storageKey, ownerKey, nextDateKey, nextNowIso, nextRealtime, nextTts, nextRealtimeError, nextTtsError }) => {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({
          version: 1,
          scopes: {
            [ownerKey]: {
              dateKey: nextDateKey,
              realtime: nextRealtime,
              tts: nextTts,
              realtimeCheckedAt: nextNowIso,
              ttsCheckedAt: nextNowIso,
              realtimeError: nextRealtimeError,
              ttsError: nextTtsError
            }
          }
        })
      );
    },
    {
      storageKey: VOICE_CAPABILITY_CACHE_KEY,
      ownerKey: `${loginId}::${bridgeId}`,
      nextDateKey: dateKey,
      nextNowIso: nowIso,
      nextRealtime: realtime,
      nextTts: tts,
      nextRealtimeError: realtimeError,
      nextTtsError: ttsError
    }
  );
}

async function installVoiceBrowserMocks(page) {
  await page.addInitScript(() => {
    window.__voiceTest = {
      getUserMediaCalls: [],
      realtimeFetchCalls: [],
      narrationRequests: [],
      sentEvents: [],
      failingExactDeviceIds: [],
      audioInputDevices: [
        { deviceId: 'default', kind: 'audioinput', label: '기본 마이크' },
        { deviceId: 'usb-mic', kind: 'audioinput', label: 'USB 마이크' },
        { deviceId: 'bt-mic', kind: 'audioinput', label: 'Bluetooth 마이크' }
      ]
    };

    class FakeTrack {
      constructor() {
        this.kind = 'audio';
        this.enabled = true;
        this.readyState = 'live';
      }
      stop() {
        this.readyState = 'ended';
      }
    }

    class FakeMediaStream {
      constructor() {
        this._tracks = [new FakeTrack()];
      }
      getTracks() {
        return this._tracks;
      }
    }

    const mediaDevices = navigator.mediaDevices ?? {};
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: mediaDevices
    });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      writable: true,
      value: async (constraints) => {
        window.__voiceTest.getUserMediaCalls.push(constraints);
        const exactDeviceId = String(constraints?.audio?.deviceId?.exact ?? '').trim();
        if (exactDeviceId && window.__voiceTest.failingExactDeviceIds.includes(exactDeviceId)) {
          const error = new Error(`requested device unavailable: ${exactDeviceId}`);
          error.name = 'NotFoundError';
          throw error;
        }
        return new FakeMediaStream();
      }
    });
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
      configurable: true,
      writable: true,
      value: async () => window.__voiceTest.audioInputDevices
    });

    class FakeAnalyserNode {
      constructor() {
        this.frequencyBinCount = 32;
        this.fftSize = 256;
        this.smoothingTimeConstant = 0.82;
      }
      getByteFrequencyData(array) {
        for (let index = 0; index < array.length; index += 1) {
          array[index] = index % 3 === 0 ? 180 : 72;
        }
      }
    }

    class FakeMediaStreamSource {
      connect() {}
      disconnect() {}
    }

    class FakeAudioContext {
      constructor() {
        this.state = 'running';
      }
      createAnalyser() {
        return new FakeAnalyserNode();
      }
      createMediaStreamSource() {
        return new FakeMediaStreamSource();
      }
      async close() {
        this.state = 'closed';
      }
    }

    window.AudioContext = FakeAudioContext;
    window.webkitAudioContext = FakeAudioContext;

    window.Audio = class FakeAudio {
      constructor() {
        this.autoplay = true;
        this.playsInline = true;
        this.srcObject = null;
        this._listeners = new Map();
      }
      addEventListener(type, listener, options = {}) {
        const normalizedType = String(type ?? '').trim();
        if (!normalizedType || typeof listener !== 'function') {
          return;
        }

        const listeners = this._listeners.get(normalizedType) ?? [];
        listeners.push({
          listener,
          once: options === true || Boolean(options?.once)
        });
        this._listeners.set(normalizedType, listeners);
      }
      removeEventListener(type, listener) {
        const normalizedType = String(type ?? '').trim();
        const listeners = this._listeners.get(normalizedType) ?? [];
        this._listeners.set(
          normalizedType,
          listeners.filter((entry) => entry.listener !== listener)
        );
      }
      _emit(type) {
        const normalizedType = String(type ?? '').trim();
        const listeners = [...(this._listeners.get(normalizedType) ?? [])];

        listeners.forEach((entry) => {
          entry.listener.call(this);
          if (entry.once) {
            this.removeEventListener(normalizedType, entry.listener);
          }
        });
      }
      play() {
        setTimeout(() => {
          this._emit('ended');
        }, 0);
        return Promise.resolve();
      }
      pause() {}
    };

    class FakeSpeechRecognition {
      constructor() {
        this.lang = 'ko-KR';
        this.continuous = true;
        this.interimResults = true;
        this.maxAlternatives = 1;
        this.onstart = null;
        this.onresult = null;
        this.onerror = null;
        this.onend = null;
        this._started = false;
        window.__voiceTest.speechRecognition = this;
      }
      start() {
        if (this._started) {
          throw new Error('recognition has already started');
        }

        this._started = true;
        this.onstart?.();
      }
      stop() {
        if (!this._started) {
          return;
        }

        this._started = false;
        this.onend?.();
      }
      abort() {
        this.stop();
      }
      emitResult({ resultIndex = 0, results = [] } = {}) {
        const normalizedResults = results.map(({ transcript = '', isFinal = false } = {}) => {
          const alternative = { transcript: String(transcript ?? '') };
          const result = [alternative];
          result.isFinal = Boolean(isFinal);
          return result;
        });

        this.onresult?.({
          resultIndex,
          results: normalizedResults
        });
      }
      emitError(error = 'network') {
        this.onerror?.({ error });
      }
      emitEnd() {
        this._started = false;
        this.onend?.();
      }
    }

    window.SpeechRecognition = FakeSpeechRecognition;
    window.webkitSpeechRecognition = FakeSpeechRecognition;
    window.__voiceTest.emitSpeechRecognitionResult = (payload) => {
      window.__voiceTest.speechRecognition?.emitResult(payload);
    };
    window.__voiceTest.emitSpeechRecognitionError = (error) => {
      window.__voiceTest.speechRecognition?.emitError(error);
    };
    window.__voiceTest.emitSpeechRecognitionEnd = () => {
      window.__voiceTest.speechRecognition?.emitEnd();
    };

    class FakeDataChannel {
      constructor() {
        this.readyState = 'connecting';
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
      }
      send(message) {
        try {
          window.__voiceTest.sentEvents.push(JSON.parse(String(message)));
        } catch {
          window.__voiceTest.sentEvents.push(message);
        }
      }
      open() {
        this.readyState = 'open';
        if (typeof this.onopen === 'function') {
          this.onopen();
        }
      }
      emit(payload) {
        if (typeof this.onmessage === 'function') {
          this.onmessage({ data: JSON.stringify(payload) });
        }
      }
      close() {
        this.readyState = 'closed';
        if (typeof this.onclose === 'function') {
          this.onclose();
        }
      }
    }

    class FakeRTCPeerConnection {
      constructor() {
        this.connectionState = 'new';
        this.localDescription = null;
        this.remoteDescription = null;
        this.ontrack = null;
        this.onconnectionstatechange = null;
        this._senders = [];
        this._dataChannel = null;
        window.__voiceTest.peerConnection = this;
      }
      addTrack(track) {
        this._senders.push({ track });
      }
      getSenders() {
        return this._senders;
      }
      createDataChannel() {
        this._dataChannel = new FakeDataChannel();
        window.__voiceTest.dataChannel = this._dataChannel;
        return this._dataChannel;
      }
      async createOffer() {
        return { type: 'offer', sdp: 'fake-offer-sdp' };
      }
      async setLocalDescription(description) {
        this.localDescription = description;
      }
      async setRemoteDescription(description) {
        this.remoteDescription = description;
        this.connectionState = 'connected';
        if (typeof this.onconnectionstatechange === 'function') {
          this.onconnectionstatechange();
        }
        if (typeof this.ontrack === 'function') {
          this.ontrack({ streams: [{}] });
        }
        setTimeout(() => {
          this._dataChannel?.open();
        }, 0);
      }
      close() {
        this.connectionState = 'closed';
        if (typeof this.onconnectionstatechange === 'function') {
          this.onconnectionstatechange();
        }
      }
    }

    window.RTCPeerConnection = FakeRTCPeerConnection;

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = String(typeof input === 'string' ? input : input?.url ?? '');

      if (url.includes('/mock-realtime-call')) {
        window.__voiceTest.realtimeFetchCalls.push({ url, body: String(init?.body ?? '') });
        return new Response('v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=OctOP Voice Test\r\n', {
          status: 200,
          headers: {
            'Content-Type': 'application/sdp'
          }
        });
      }

      return originalFetch(input, init);
    };
  });
}

async function mockMobileApi(page, options = {}) {
  const voiceSessionRequests = options.voiceSessionRequests ?? [];
  const createdThreads = options.createdThreads ?? [];
  const createdIssues = options.createdIssues ?? [];
  const startedIssueRequests = options.startedIssueRequests ?? [];
  const narrationRequests = options.narrationRequests ?? [];
  const voiceSessionFailure = options.voiceSessionFailure ?? null;
  const voiceSessionResponseBody = options.voiceSessionResponseBody ?? null;
  const authoritativeResponseText = String(options.authoritativeAssistantContent ?? "").trim();
  let voiceIssueSequence = 0;
  let latestCreatedIssue = null;
  let latestCreatedThread = null;
  let voiceSessionSequence = 0;

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();

    if (pathname === '/api/events') {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        body: 'event: ready\ndata: {"ok":true}\n\n'
      });
      return;
    }

    if (pathname === '/api/bridges') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          bridges: [
            {
              bridge_id: bridgeId,
              device_name: 'Playwright Bridge',
              status: 'online'
            }
          ]
        })
      });
      return;
    }

    if (pathname === '/api/bridge/status') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          bridge_id: bridgeId,
          app_server: {
            connected: true,
            initialized: true,
            account: {
              login_id: loginId
            }
          },
          counts: {
            projects: 1,
            threads: 1
          }
        })
      });
      return;
    }

    if (pathname === '/api/projects') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          projects: [project]
        })
      });
      return;
    }

    if (pathname === `/api/projects/${projectId}/threads` && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          threads: latestCreatedThread ? [latestCreatedThread, thread] : [thread]
        })
      });
      return;
    }

    if (pathname === `/api/projects/${projectId}/threads` && method === 'POST') {
      const payload = request.postDataJSON() ?? {};
      latestCreatedThread = {
        ...delegatedThread,
        title: payload.name || delegatedThread.title,
        name: payload.name || delegatedThread.name,
        updated_at: new Date(Date.now() + 120).toISOString(),
        created_at: new Date(Date.now() + 120).toISOString()
      };
      createdThreads.push(payload);
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          accepted: true,
          thread: latestCreatedThread,
          threads: [latestCreatedThread, thread]
        })
      });
      return;
    }

    if (pathname === `/api/threads/${threadId}/issues` && method === 'GET') {
      const issues = latestCreatedIssue ? [issueDetail.issue, latestCreatedIssue] : [issueDetail.issue];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          thread,
          issues
        })
      });
      return;
    }

    if (pathname === `/api/threads/${delegatedThreadId}/issues` && method === 'GET') {
      const issues = latestCreatedIssue ? [latestCreatedIssue] : [];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          thread: latestCreatedThread ?? delegatedThread,
          issues
        })
      });
      return;
    }

    if (latestCreatedIssue && pathname === `/api/issues/${latestCreatedIssue.id}` && method === 'GET') {
      const completedAt = new Date(Date.now() + 1500).toISOString();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          thread: {
            ...(latestCreatedThread ?? delegatedThread),
            status: 'idle',
            progress: 100,
            last_event: 'turn.completed',
            updated_at: completedAt
          },
          issue: {
            ...latestCreatedIssue,
            status: 'completed',
            progress: 100,
            last_event: 'turn.completed',
            updated_at: completedAt
          },
          messages: [
            {
              id: `${latestCreatedIssue.id}-user`,
              role: 'user',
              kind: 'prompt',
              content: latestCreatedIssue.prompt,
              timestamp: latestCreatedIssue.created_at
            },
            {
              id: `${latestCreatedIssue.id}-assistant`,
              role: 'assistant',
              kind: 'message',
              content: authoritativeResponseText,
              timestamp: completedAt
            }
          ]
        })
      });
      return;
    }

    if (pathname === `/api/issues/${issueId}` && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          thread,
          issue: issueDetail.issue,
          messages: issueDetail.messages
        })
      });
      return;
    }

    if (pathname === `/api/threads/${threadId}/issues` && method === 'POST') {
      const payload = request.postDataJSON() ?? {};
      voiceIssueSequence += 1;
      const createdAt = new Date(Date.now() + voiceIssueSequence * 250).toISOString();
      const createdIssue = {
        id: `voice-created-issue-${voiceIssueSequence}`,
        thread_id: threadId,
        root_thread_id: threadId,
        project_id: projectId,
        title: payload.title || 'Voice Prompt',
        prompt: payload.prompt || '',
        status: 'queued',
        progress: 0,
        last_event: 'issue.created',
        last_message: '',
        attachments: payload.attachments || [],
        created_at: createdAt,
        updated_at: createdAt
      };
      latestCreatedIssue = createdIssue;
      createdIssues.push({ ...payload, thread_id: threadId });
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          accepted: true,
          issue: createdIssue
        })
      });
      return;
    }

    if (pathname === `/api/threads/${delegatedThreadId}/issues` && method === 'POST') {
      const payload = request.postDataJSON() ?? {};
      voiceIssueSequence += 1;
      const createdAt = new Date(Date.now() + voiceIssueSequence * 250).toISOString();
      const createdIssue = {
        id: `voice-created-issue-${voiceIssueSequence}`,
        thread_id: delegatedThreadId,
        root_thread_id: delegatedThreadId,
        project_id: projectId,
        title: payload.title || 'Voice Prompt',
        prompt: payload.prompt || '',
        status: 'queued',
        progress: 0,
        last_event: 'issue.created',
        last_message: '',
        attachments: payload.attachments || [],
        created_at: createdAt,
        updated_at: createdAt
      };
      latestCreatedIssue = createdIssue;
      createdIssues.push({ ...payload, thread_id: delegatedThreadId });
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          accepted: true,
          issue: createdIssue
        })
      });
      return;
    }

    if (pathname === `/api/threads/${threadId}/issues/start` && method === 'POST') {
      const payload = request.postDataJSON() ?? {};
      startedIssueRequests.push({ ...payload, thread_id: threadId });
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          accepted: true,
          thread_id: threadId,
          issue_ids: payload.issue_ids || []
        })
      });
      return;
    }

    if (pathname === `/api/threads/${delegatedThreadId}/issues/start` && method === 'POST') {
      const payload = request.postDataJSON() ?? {};
      startedIssueRequests.push({ ...payload, thread_id: delegatedThreadId });
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          accepted: true,
          thread_id: delegatedThreadId,
          issue_ids: payload.issue_ids || []
        })
      });
      return;
    }

    if ((pathname === '/api/voice/sessions' || pathname === '/api/voice/realtime-token') && method === 'POST') {
      const payload = request.postDataJSON() ?? {};
      voiceSessionRequests.push(payload);

      if (voiceSessionFailure) {
        await route.fulfill({
          status: voiceSessionFailure.status ?? 503,
          contentType: 'application/json',
          body: JSON.stringify(voiceSessionFailure.body)
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          voiceSessionResponseBody ?? {
            ...buildVoiceSessionResponseBody(payload, `voice-session-${++voiceSessionSequence}`)
          }
        )
      });
      return;
    }

    if (pathname === '/api/voice/narrations' && method === 'POST') {
      const payload = request.postDataJSON() ?? {};
      narrationRequests.push(payload);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          audio_base64: 'SUQzAwAAAAAA',
          content_type: 'audio/mpeg',
          voice: 'alloy',
          model: 'gpt-4o-mini-tts'
        })
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true })
    });
  });
}

let server;
let baseUrl = '';

test.use({
  serviceWorkers: 'block',
  hasTouch: true,
  isMobile: true,
  viewport: {
    width: 390,
    height: 844
  }
});

test.beforeAll(async () => {
  await buildWorkspace('@octop/mobile');
  server = new StaticAppServer(MOBILE_DIST_DIR);
  const port = await server.start(0);
  baseUrl = `http://127.0.0.1:${port}`;
});

test.afterAll(async () => {
  await server?.stop();
});

test('음성 모드 성공 경로 실테스트', async ({ page }) => {
  const voiceSessionRequests = [];
  const createdThreads = [];
  const narrationRequests = [];
  const createdIssues = [];
  const startedIssueRequests = [];
  const expectedVoiceText = '현재 상태 정리를 마쳤고 음성 응답도 app-server 기준으로 확인되었습니다. 이어서 필요한 확인을 진행하시면 됩니다.';

  await seedMobileSession(page);
  await installVoiceBrowserMocks(page);
  await mockMobileApi(page, {
    voiceSessionRequests,
    createdThreads,
    narrationRequests,
    createdIssues,
    startedIssueRequests,
    authoritativeAssistantContent
  });

  await page.goto(baseUrl);
  await expect(page.getByTestId('thread-detail-panel')).toBeVisible();
  await expect(page.getByText('Voice Thread')).toBeVisible();
  await expect(page.getByRole('button', { name: '음성 모드 열기' })).toHaveCount(0);

  await openVoiceModeByLongPressingSend(page);

  await expect(page.getByTestId('voice-mode-panel')).toBeVisible();
  await expect(page.getByTestId('voice-mode-footer')).toBeVisible();
  await expect(page.getByTestId('thread-detail-header-filters')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByRole('combobox', { name: '마이크 입력 선택' })).toBeVisible();
  await expect(page.getByRole('button', { name: '음성입력 종료' })).toBeVisible();
  await expect(page.getByTestId('voice-user-bubble')).not.toHaveText('현재 상태 알려줘');
  await expect(page.getByTestId('voice-assistant-bubble')).not.toHaveText('현재 스레드는 유휴 상태입니다.');
  const panelBox = await page.getByTestId('voice-mode-panel').boundingBox();
  const footerBox = await page.getByTestId('voice-mode-footer').boundingBox();
  const comboboxBox = await page.getByRole('combobox', { name: '마이크 입력 선택' }).boundingBox();
  const userBubbleBox = await page.getByTestId('voice-user-bubble').boundingBox();
  const assistantBubbleBox = await page.getByTestId('voice-assistant-bubble').boundingBox();
  expect(panelBox).not.toBeNull();
  expect(footerBox).not.toBeNull();
  expect(comboboxBox).not.toBeNull();
  expect(userBubbleBox).not.toBeNull();
  expect(assistantBubbleBox).not.toBeNull();
  expect(Math.abs(panelBox.y + panelBox.height - (footerBox.y + footerBox.height))).toBeLessThanOrEqual(2);
  expect(comboboxBox.y - panelBox.y).toBeLessThanOrEqual(32);
  expect(panelBox.x + panelBox.width - (comboboxBox.x + comboboxBox.width)).toBeLessThanOrEqual(28);
  expect(userBubbleBox.y + userBubbleBox.height).toBeLessThan(assistantBubbleBox.y);
  expect(userBubbleBox.y).toBeGreaterThan(panelBox.y + panelBox.height * 0.45);
  expect(assistantBubbleBox.y).toBeGreaterThan(panelBox.y + panelBox.height * 0.5);
  expect(comboboxBox.height).toBeLessThanOrEqual(40);
  expect(comboboxBox.width).toBeLessThanOrEqual(176);

  const actionButton = page.getByRole('button', { name: '음성입력 종료' });
  const deviceSelect = page.getByRole('combobox', { name: '마이크 입력 선택' });
  await actionButton.focus();
  const actionButtonStyles = await actionButton.evaluate((node) => {
    const style = window.getComputedStyle(node);
    return {
      userSelect: style.userSelect,
      outlineWidth: style.outlineWidth
    };
  });
  const actionTextStyles = await page.locator('.voice-mode-panel__action-text').evaluate((node) => {
    const style = window.getComputedStyle(node);
    return {
      userSelect: style.userSelect
    };
  });
  await deviceSelect.focus();
  const deviceSelectStyles = await deviceSelect.evaluate((node) => {
    const style = window.getComputedStyle(node);
    return {
      userSelect: style.userSelect,
      outlineWidth: style.outlineWidth
    };
  });
  expect(actionButtonStyles.userSelect).toBe('none');
  expect(actionTextStyles.userSelect).toBe('none');
  expect(actionButtonStyles.outlineWidth).toBe('0px');
  expect(deviceSelectStyles.userSelect).toBe('none');
  expect(deviceSelectStyles.outlineWidth).toBe('0px');

  await expect(page.getByTestId('voice-mode-footer').getByRole('combobox', { name: '마이크 입력 선택' })).toHaveCount(0);
  await expect.poll(() => voiceSessionRequests.length).toBe(1);
  expect(voiceSessionRequests[0].thread_id).toBe('');
  expect(voiceSessionRequests[0].project_id).toBe(projectId);
  expect(voiceSessionRequests[0].project_workspace_path).toBe(project.workspace_path);
  expect(voiceSessionRequests[0].project_base_instructions).toContain('현재 프로젝트 코드를 기준');
  expect(voiceSessionRequests[0].project_developer_instructions).toContain('실제 동작하는 결과');
  expect(voiceSessionRequests[0].project_program_summary).toContain('Voice E2E Project');
  expect(voiceSessionRequests[0].project_program_summary).toContain(project.workspace_path);
  expect(voiceSessionRequests[0].recent_conversation_summary).toBe('');
  expect(voiceSessionRequests[0].thread_file_context_summary).toBe('');

  const browserMetrics = await page.evaluate(() => ({
    getUserMediaCalls: window.__voiceTest.getUserMediaCalls.length,
    realtimeFetchCalls: window.__voiceTest.realtimeFetchCalls.length
  }));

  expect(browserMetrics.getUserMediaCalls).toBe(1);
  expect(browserMetrics.realtimeFetchCalls).toBe(1);

  const initialRealtimeEvents = await page.evaluate(() => window.__voiceTest.sentEvents);
  expect(initialRealtimeEvents.find((event) => event?.type === 'session.update') ?? null).toBeNull();

  await page.getByRole('combobox', { name: '마이크 입력 선택' }).selectOption('usb-mic');
  await expect.poll(async () => {
    return page.evaluate(() => window.__voiceTest.getUserMediaCalls.length);
  }).toBeGreaterThanOrEqual(2);

  const deviceSwitchMetrics = await page.evaluate(() => {
    const calls = window.__voiceTest.getUserMediaCalls;
    return calls[calls.length - 1];
  });

  expect(deviceSwitchMetrics.audio.deviceId.exact).toBe('usb-mic');

  await page.evaluate(() => {
    const channel = window.__voiceTest.dataChannel;
    channel.emit({ type: 'input_audio_buffer.speech_started' });
    channel.emit({ type: 'conversation.item.input_audio_transcription.delta', delta: '상태 ' });
    channel.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: '상태 알려줘' });
  });

  await expect(page.getByTestId('voice-user-bubble')).toHaveText('상태 알려줘');
  await expect.poll(async () => {
    const sentEvents = await page.evaluate(() => window.__voiceTest.sentEvents);
    return sentEvents.filter((event) => event?.type === 'response.create').length;
  }).toBeGreaterThan(0);

  const firstVoiceResponseCreateEvent = await page.evaluate(() => {
    return window.__voiceTest.sentEvents.find((event) => event?.type === 'response.create');
  });
  expect(firstVoiceResponseCreateEvent?.response?.output_modalities).toEqual(['audio']);

  await page.evaluate((payload) => {
    window.__voiceTest.dataChannel.emit(payload);
  }, buildRealtimeFunctionCallResponse({ prompt: '상태 알려줘' }));

  await expect.poll(() => createdThreads.length).toBe(1);
  await expect.poll(() => createdIssues.length).toBe(1);
  await expect.poll(() => startedIssueRequests.length).toBe(1);
  expect(createdThreads[0].name).toContain('상태 알려줘');
  expect(createdIssues[0].prompt).toBe('상태 알려줘');
  expect(createdIssues[0].thread_id).toBe(delegatedThreadId);
  expect(startedIssueRequests[0].thread_id).toBe(delegatedThreadId);

  await expect.poll(async () => {
    const sentEvents = await page.evaluate(() => window.__voiceTest.sentEvents);
    return sentEvents.filter((event) => event?.item?.type === 'function_call_output').length;
  }).toBe(1);

  await expect.poll(() => voiceSessionRequests.some((payload) => payload.thread_id === delegatedThreadId)).toBeTruthy();
  const delegatedSessionRequest = [...voiceSessionRequests].reverse().find((payload) => payload.thread_id === delegatedThreadId);
  expect(delegatedSessionRequest.thread_id).toBe(delegatedThreadId);
  expect(delegatedSessionRequest.recent_conversation_summary).toContain('user: 상태 알려줘');

  await expect.poll(async () => {
    const sentEvents = await page.evaluate(() => window.__voiceTest.sentEvents);
    return sentEvents.some(
      (event) =>
        event?.type === 'response.create' &&
        event?.response?.metadata?.channel === 'app_server_report' &&
        event?.response?.metadata?.kind === 'progress'
    );
  }).toBeTruthy();

  await page.evaluate((payload) => {
    window.__voiceTest.dataChannel.emit(payload);
  }, buildRealtimeAssistantMessageResponse({
    responseId: 'resp-progress-1',
    channel: 'app_server_report',
    kind: 'progress',
    text: '요청을 전달했고 현재 app-server가 진행 중입니다.'
  }));

  await expect.poll(async () => {
    const sentEvents = await page.evaluate(() => window.__voiceTest.sentEvents);
    return sentEvents.some(
      (event) =>
        event?.type === 'response.create' &&
        event?.response?.metadata?.channel === 'app_server_report' &&
        event?.response?.metadata?.kind === 'final'
    );
  }, { timeout: 12000 }).toBeTruthy();

  await page.evaluate((payload) => {
    window.__voiceTest.dataChannel.emit(payload);
  }, buildRealtimeAssistantMessageResponse({
    responseId: 'resp-final-1',
    channel: 'app_server_report',
    kind: 'final',
    text: expectedVoiceText
  }));

  await expect(page.getByTestId('voice-assistant-bubble')).toHaveText(expectedVoiceText);
  await expect(page.getByTestId('voice-assistant-bubble')).not.toContainText('apps/mobile/src/App.jsx');
  await expect(page.getByTestId('voice-assistant-bubble')).not.toContainText('console.log');
  await expect.poll(() => narrationRequests.length).toBe(0);

  const sentEvents = await page.evaluate(() => window.__voiceTest.sentEvents);
  const functionCallOutputs = sentEvents.filter((event) => event?.type === 'conversation.item.create');
  expect(functionCallOutputs).toHaveLength(1);
  expect(functionCallOutputs[0].item.call_id).toBe('call-voice-1');
  expect(sentEvents.filter((event) => event?.type === 'response.create').length).toBeGreaterThanOrEqual(2);

  await page.getByRole('button', { name: '음성입력 종료' }).click();
  await expect(page.getByTestId('voice-mode-panel')).toHaveCount(0);
  await expect(page.getByTestId('thread-detail-panel')).toContainText('상태 알려줘');
});

test('실시간 사용자 전사 delta가 겹쳐 와도 최근 transcript는 중복 없이 병합된다', async ({ page }) => {
  await seedMobileSession(page);
  await installVoiceBrowserMocks(page);
  await mockMobileApi(page);

  await page.goto(baseUrl);
  await expect(page.getByTestId('thread-detail-panel')).toBeVisible();
  await openVoiceModeByLongPressingSend(page);
  await expect(page.getByTestId('voice-mode-panel')).toBeVisible();

  await page.evaluate(() => {
    const channel = window.__voiceTest.dataChannel;
    channel.emit({ type: 'input_audio_buffer.speech_started' });
    channel.emit({ type: 'conversation.item.input_audio_transcription.delta', delta: '상태 알려' });
    channel.emit({ type: 'conversation.item.input_audio_transcription.delta', delta: '알려줘' });
  });

  await expect(page.getByTestId('voice-user-bubble')).toHaveText('상태 알려줘');
  await expect(page.getByTestId('voice-user-bubble')).not.toHaveText('상태 알려알려줘');
});

test('선택한 마이크 장치가 데스크탑 PWA에서 무효하면 기본 마이크로 자동 복구한다', async ({ page }) => {
  await seedMobileSession(page);
  await installVoiceBrowserMocks(page);
  await mockMobileApi(page, {
    authoritativeAssistantContent
  });

  await page.goto(baseUrl);
  await expect(page.getByTestId('thread-detail-panel')).toBeVisible();
  await openVoiceModeByLongPressingSend(page);
  await expect(page.getByTestId('voice-mode-panel')).toBeVisible();

  await page.evaluate(() => {
    window.__voiceTest.failingExactDeviceIds = ['usb-mic'];
  });

  await page.getByRole('combobox', { name: '마이크 입력 선택' }).selectOption('usb-mic');

  await expect.poll(async () => {
    return page.evaluate(() => window.__voiceTest.getUserMediaCalls.length);
  }).toBeGreaterThanOrEqual(3);

  await expect(page.getByRole('combobox', { name: '마이크 입력 선택' })).toHaveValue('default');
  await expect(page.getByTestId('voice-assistant-bubble')).not.toContainText('requested device unavailable');

  const getUserMediaCalls = await page.evaluate(() => window.__voiceTest.getUserMediaCalls);
  const retryCall = getUserMediaCalls[getUserMediaCalls.length - 1];
  const failedCall = getUserMediaCalls[getUserMediaCalls.length - 2];

  expect(failedCall?.audio?.deviceId?.exact).toBe('usb-mic');
  expect(retryCall?.audio?.deviceId).toBeUndefined();
});

test('음성 세션 발급 실패 시 오류를 노출한다', async ({ page }) => {
  await seedMobileSession(page);
  await installVoiceBrowserMocks(page);
  await mockMobileApi(page, {
    voiceSessionFailure: {
      status: 503,
      body: {
        ok: false,
        code: 'voice_session_api_key_missing',
        error: 'OPENAI_API_KEY is required'
      }
    }
  });

  await page.goto(baseUrl);
  await expect(page.getByTestId('thread-detail-panel')).toBeVisible();
  await expect(page.getByRole('button', { name: '음성 모드 열기' })).toHaveCount(0);
  await openVoiceModeByLongPressingSend(page);

  const voicePanel = page.getByTestId('voice-mode-panel').last();
  const inputSelect = voicePanel.getByRole('combobox', { name: '마이크 입력 선택' });
  await expect(voicePanel).toBeVisible();
  await expect(inputSelect).toBeVisible();
  await expect(inputSelect.locator('option')).toHaveCount(1);
  await expect(inputSelect.locator('option:checked')).toHaveText('브라우저 음성 입력');
});

test('채팅 입력의 stt 버튼으로 언제든 음성 인식을 켜고 끌 수 있다', async ({ page }) => {
  await seedMobileSession(page);
  await installVoiceBrowserMocks(page);
  await mockMobileApi(page);

  await page.goto(baseUrl);
  await expect(page.getByTestId('thread-detail-panel')).toBeVisible();

  const speechButton = page.getByTestId('thread-prompt-speech-button');
  const promptInput = page.getByTestId('thread-prompt-input');

  await expect(speechButton).toHaveText('STT');

  await speechButton.click();
  await expect(speechButton).toContainText('STT 중');

  await page.evaluate(() => {
    window.__voiceTest.emitSpeechRecognitionResult({
      resultIndex: 0,
      results: [
        { transcript: '수동 stt 토글 테스트', isFinal: true }
      ]
    });
  });

  await expect(promptInput).toHaveValue('수동 stt 토글 테스트');

  await speechButton.click();
  await expect(speechButton).toHaveText('STT');
});

test('자동 재시작되는 stt는 버튼 상태가 꺼졌다 켜지는 것처럼 흔들리지 않는다', async ({ page }) => {
  await seedMobileSession(page);
  await installVoiceBrowserMocks(page);
  await mockMobileApi(page);

  await page.goto(baseUrl);
  await expect(page.getByTestId('thread-detail-panel')).toBeVisible();

  const speechButton = page.getByTestId('thread-prompt-speech-button');

  await speechButton.click();
  await expect(speechButton).toContainText('STT 중');

  await page.evaluate(() => {
    window.__voiceTest.emitSpeechRecognitionEnd();
  });

  await expect(speechButton).toContainText('STT 중');
  await page.waitForTimeout(320);
  await expect(speechButton).toContainText('STT 중');
});

test('stt 전용 모드에서는 누적 final transcript가 다시 와도 입력창에 중복으로 붙지 않는다', async ({ page }) => {
  await seedMobileSession(page);
  await seedVoiceCapabilitySnapshot(page, {
    realtime: 'blocked',
    tts: 'blocked',
    realtimeError: '실시간 음성을 사용할 수 없습니다.',
    ttsError: '음성 TTS를 사용할 수 없습니다.'
  });
  await installVoiceBrowserMocks(page);
  await mockMobileApi(page);

  await page.goto(baseUrl);
  await expect(page.getByTestId('thread-detail-panel')).toBeVisible();

  await openVoiceModeByLongPressingSend(page);

  await expect(page.getByText('STT 모드로 전환했습니다.')).toBeVisible();
  await expect(page.getByTestId('voice-mode-panel')).toHaveCount(0);
  await expect(page.getByTestId('thread-prompt-speech-button')).toContainText('STT 중');

  const promptInput = page.getByTestId('thread-prompt-input');
  await expect(promptInput).toHaveValue('');

  await page.evaluate(() => {
    window.__voiceTest.emitSpeechRecognitionResult({
      resultIndex: 0,
      results: [
        { transcript: 'stt 모드에서 음성이', isFinal: true }
      ]
    });
  });

  await expect(promptInput).toHaveValue('stt 모드에서 음성이');

  await page.evaluate(() => {
    window.__voiceTest.emitSpeechRecognitionResult({
      resultIndex: 0,
      results: [
        { transcript: 'stt 모드에서 음성이', isFinal: true },
        { transcript: '중복 입력되는 부분을', isFinal: true }
      ]
    });
  });

  await expect(promptInput).toHaveValue('stt 모드에서 음성이 중복 입력되는 부분을');

  await page.evaluate(() => {
    window.__voiceTest.emitSpeechRecognitionResult({
      resultIndex: 0,
      results: [
        { transcript: 'stt 모드에서 음성이', isFinal: true },
        { transcript: '중복 입력되는 부분을', isFinal: true }
      ]
    });
  });

  await expect(promptInput).toHaveValue('stt 모드에서 음성이 중복 입력되는 부분을');
  await expect(promptInput).not.toHaveValue('stt 모드에서 음성이 stt 모드에서 음성이 중복 입력되는 부분을');
});

test('stt 전용 모드에서는 같은 final result가 누적 확장돼도 입력창에 중복으로 붙지 않는다', async ({ page }) => {
  await seedMobileSession(page);
  await seedVoiceCapabilitySnapshot(page, {
    realtime: 'blocked',
    tts: 'blocked',
    realtimeError: '실시간 음성을 사용할 수 없습니다.',
    ttsError: '음성 TTS를 사용할 수 없습니다.'
  });
  await installVoiceBrowserMocks(page);
  await mockMobileApi(page);

  await page.goto(baseUrl);
  await expect(page.getByTestId('thread-detail-panel')).toBeVisible();

  await openVoiceModeByLongPressingSend(page);

  await expect(page.getByText('STT 모드로 전환했습니다.')).toBeVisible();
  await expect(page.getByTestId('voice-mode-panel')).toHaveCount(0);
  await expect(page.getByTestId('thread-prompt-speech-button')).toContainText('STT 중');

  const promptInput = page.getByTestId('thread-prompt-input');
  const cumulativeTranscripts = [
    'stt의',
    'stt의 음성',
    'stt의 음성 입력이',
    'stt의 음성 입력이 아직도',
    'stt의 음성 입력이 아직도 중복으로',
    'stt의 음성 입력이 아직도 중복으로 처리되고',
    'stt의 음성 입력이 아직도 중복으로 처리되고 있어'
  ];

  for (const transcript of cumulativeTranscripts) {
    await page.evaluate((nextTranscript) => {
      window.__voiceTest.emitSpeechRecognitionResult({
        resultIndex: 0,
        results: [{ transcript: nextTranscript, isFinal: true }]
      });
    }, transcript);

    await expect(promptInput).toHaveValue(transcript);
  }

  await expect(promptInput).not.toHaveValue(
    'stt의 stt의 음성 stt의 음성 입력이 stt의 음성 입력이 아직도 stt의 음성 입력이 아직도 중복으로 stt의 음성 입력이 아직도 중복으로 처리되고 stt의 음성 입력이 아직도 중복으로 처리되고 있어'
  );
});

test('stt 전용 모드에서는 바로 전과 같은 final result가 다시 오면 이전 결과를 교체해 중복 표시하지 않는다', async ({ page }) => {
  await seedMobileSession(page);
  await seedVoiceCapabilitySnapshot(page, {
    realtime: 'blocked',
    tts: 'blocked',
    realtimeError: '실시간 음성을 사용할 수 없습니다.',
    ttsError: '음성 TTS를 사용할 수 없습니다.'
  });
  await installVoiceBrowserMocks(page);
  await mockMobileApi(page);

  await page.goto(baseUrl);
  await expect(page.getByTestId('thread-detail-panel')).toBeVisible();

  await openVoiceModeByLongPressingSend(page);

  await expect(page.getByText('STT 모드로 전환했습니다.')).toBeVisible();
  await expect(page.getByTestId('voice-mode-panel')).toHaveCount(0);
  await expect(page.getByTestId('thread-prompt-speech-button')).toContainText('STT 중');

  const promptInput = page.getByTestId('thread-prompt-input');

  await page.evaluate(() => {
    window.__voiceTest.emitSpeechRecognitionResult({
      resultIndex: 0,
      results: [{ transcript: '반복 발화', isFinal: true }]
    });
  });

  await expect(promptInput).toHaveValue('반복 발화');

  await page.evaluate(() => {
    window.__voiceTest.emitSpeechRecognitionResult({
      resultIndex: 1,
      results: [
        { transcript: '반복 발화', isFinal: true },
        { transcript: '반복 발화', isFinal: true }
      ]
    });
  });

  await expect(promptInput).toHaveValue('반복 발화');
});

test('실시간 제약 error 이벤트를 받으면 사유를 알리고 TTS 모드로 자동 전환한다', async ({ page }) => {
  await seedMobileSession(page);
  await installVoiceBrowserMocks(page);
  await mockMobileApi(page);

  await page.goto(baseUrl);
  await expect(page.getByTestId('thread-detail-panel')).toBeVisible();
  await openVoiceModeByLongPressingSend(page);
  await expect(page.getByTestId('voice-mode-panel')).toBeVisible();

  await page.evaluate(() => {
    window.__voiceTest.dataChannel.emit({
      type: 'error',
      error: {
        code: 'insufficient_quota',
        message: 'You exceeded your current quota, please check your plan and billing details.'
      }
    });
  });

  await expect(page.getByText('원인: OpenAI 실시간 음성 사용 한도 또는 결제 상태로 인해 현재 모드를 계속 사용할 수 없습니다.')).toBeVisible();

  const voicePanel = page.getByTestId('voice-mode-panel').last();
  const inputSelect = voicePanel.getByRole('combobox', { name: '마이크 입력 선택' });
  await expect(voicePanel).toBeVisible();
  await expect(inputSelect).toBeVisible();
  await expect(inputSelect.locator('option')).toHaveCount(1);
  await expect(inputSelect.locator('option:checked')).toHaveText('브라우저 음성 입력');
});

test('중첩된 client secret과 output_audio transcript 응답을 처리한다', async ({ page }) => {
  await seedMobileSession(page);
  await installVoiceBrowserMocks(page);
  await mockMobileApi(page, {
    voiceSessionResponseBody: {
      ok: true,
      client_secret: {
        value: 'client-secret-test'
      },
      call_url: 'https://voice.test/mock-realtime-call',
      bridge_id: bridgeId,
      project_id: projectId,
      thread_id: '',
      session: {
        id: 'voice-session-nested'
      }
    }
  });

  await page.goto(baseUrl);
  await expect(page.getByTestId('thread-detail-panel')).toBeVisible();
  await openVoiceModeByLongPressingSend(page);
  await expect(page.getByTestId('voice-mode-panel')).toBeVisible();

  await page.evaluate((payload) => {
    window.__voiceTest.dataChannel.emit(payload);
  }, buildRealtimeAssistantAudioResponse({
    transcript: 'output_audio transcript도 정상 반영됩니다.'
  }));

  await expect(page.getByTestId('voice-assistant-bubble')).toHaveText('output_audio transcript도 정상 반영됩니다.');
});
