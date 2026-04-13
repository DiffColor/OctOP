const { test, expect } = require('@playwright/test');
const path = require('path');
const { REPO_ROOT, StaticAppServer, buildWorkspace } = require('../helpers/static-app-server');

const MOBILE_DIST_DIR = path.join(REPO_ROOT, 'apps', 'mobile', 'dist');
const SESSION_KEY = 'octop.mobile.session';
const BRIDGE_KEY = 'octop.mobile.selectedBridge';
const WORKSPACE_LAYOUT_KEY = 'octop.mobile.workspace.layout.v1';
const WORKSPACE_SNAPSHOT_KEY = 'octop.mobile.workspace.snapshot.v1';
const THREAD_DETAIL_CACHE_KEY = 'octop.mobile.threadDetails.cache.v1';

const loginId = 'playwright-user';
const bridgeId = 'bridge-voice';
const projectId = 'project-voice';
const threadId = 'thread-voice-1';
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

async function installVoiceBrowserMocks(page) {
  await page.addInitScript(() => {
    window.__voiceTest = {
      getUserMediaCalls: [],
      realtimeFetchCalls: [],
      narrationRequests: [],
      sentEvents: [],
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
      }
      play() {
        return Promise.resolve();
      }
      pause() {}
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
  const createdIssues = options.createdIssues ?? [];
  const startedIssueRequests = options.startedIssueRequests ?? [];
  const narrationRequests = options.narrationRequests ?? [];
  const voiceSessionFailure = options.voiceSessionFailure ?? null;
  const authoritativeResponseText = String(options.authoritativeAssistantContent ?? "").trim();
  let voiceIssueSequence = 0;
  let latestCreatedIssue = null;

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

    if (pathname === `/api/projects/${projectId}/threads`) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          threads: [thread]
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

    if (latestCreatedIssue && pathname === `/api/issues/${latestCreatedIssue.id}` && method === 'GET') {
      const completedAt = new Date(Date.now() + 1500).toISOString();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          thread: {
            ...thread,
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
      createdIssues.push(payload);
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
      startedIssueRequests.push(payload);
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

    if (pathname === '/api/voice/sessions' && method === 'POST') {
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
        body: JSON.stringify({
          ok: true,
          value: 'client-secret-test',
          call_url: 'https://voice.test/mock-realtime-call',
          bridge_id: bridgeId,
          project_id: projectId,
          thread_id: threadId,
          session: {
            id: 'voice-session-1'
          }
        })
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
  const narrationRequests = [];
  const createdIssues = [];
  const startedIssueRequests = [];
  const expectedVoiceText = '요약. 현재 상태를 정리했습니다. 검증 결과. 음성 응답은 app-server 기준으로 정리되었습니다. 다음 단계. 이어서 확인해 주세요.';

  await seedMobileSession(page);
  await installVoiceBrowserMocks(page);
  await mockMobileApi(page, {
    voiceSessionRequests,
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
  expect(voiceSessionRequests[0].thread_id).toBe(threadId);
  expect(voiceSessionRequests[0].project_id).toBe(projectId);
  expect(voiceSessionRequests[0].project_workspace_path).toBe(project.workspace_path);
  expect(voiceSessionRequests[0].project_base_instructions).toContain('현재 프로젝트 코드를 기준');
  expect(voiceSessionRequests[0].project_developer_instructions).toContain('실제 동작하는 결과');
  expect(voiceSessionRequests[0].recent_conversation_summary).toContain('user: 현재 상태 알려줘');
  expect(voiceSessionRequests[0].recent_conversation_summary).toContain('assistant: 현재 스레드는 유휴 상태입니다.');
  expect(voiceSessionRequests[0].project_program_summary).toContain('Voice E2E Project');
  expect(voiceSessionRequests[0].project_program_summary).toContain(project.workspace_path);
  expect(voiceSessionRequests[0].thread_file_context_summary).toContain('apps/mobile/src/App.jsx');
  expect(voiceSessionRequests[0].thread_file_context_summary).toContain('voice mode status panel summary');

  const browserMetrics = await page.evaluate(() => ({
    getUserMediaCalls: window.__voiceTest.getUserMediaCalls.length,
    realtimeFetchCalls: window.__voiceTest.realtimeFetchCalls.length
  }));

  expect(browserMetrics.getUserMediaCalls).toBe(1);
  expect(browserMetrics.realtimeFetchCalls).toBe(1);

  await page.getByRole('combobox', { name: '마이크 입력 선택' }).selectOption('usb-mic');
  await expect.poll(async () => {
    return page.evaluate(() => window.__voiceTest.getUserMediaCalls.length);
  }).toBe(2);

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
  await expect.poll(() => createdIssues.length).toBe(1);
  await expect.poll(() => startedIssueRequests.length).toBe(1);
  expect(createdIssues[0].prompt).toBe('상태 알려줘');
  await expect(page.getByTestId('voice-assistant-bubble')).toHaveText(expectedVoiceText);
  await expect(page.getByTestId('voice-assistant-bubble')).not.toContainText('apps/mobile/src/App.jsx');
  await expect(page.getByTestId('voice-assistant-bubble')).not.toContainText('console.log');
  await expect.poll(() => narrationRequests.length).toBe(1);
  expect(narrationRequests[0].text).toBe(expectedVoiceText);

  const sentEvents = await page.evaluate(() => window.__voiceTest.sentEvents);
  const functionCallOutputs = sentEvents.filter((event) => event?.type === 'conversation.item.create');
  expect(functionCallOutputs).toHaveLength(0);
  expect(sentEvents.filter((event) => event?.type === 'response.create')).toHaveLength(0);

  await page.getByRole('button', { name: '음성입력 종료' }).click();
  await expect(page.getByTestId('voice-mode-panel')).toHaveCount(0);
  await expect(page.getByTestId('thread-detail-panel')).toContainText('상태 알려줘');
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

  await expect(page.getByRole('combobox', { name: '마이크 입력 선택' })).toBeVisible();
  await expect(page.getByTestId('voice-assistant-bubble')).toHaveText('OpenAI 음성 세션을 생성하지 못했습니다.');
});
