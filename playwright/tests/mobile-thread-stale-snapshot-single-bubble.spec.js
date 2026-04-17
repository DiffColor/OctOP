const { test, expect } = require('@playwright/test');
const path = require('path');
const { REPO_ROOT, StaticAppServer, buildWorkspace } = require('../helpers/static-app-server');

const MOBILE_DIST_DIR = path.join(REPO_ROOT, 'apps', 'mobile', 'dist');
const SESSION_KEY = 'octop.mobile.session';
const SELECTED_BRIDGE_KEY = 'octop.mobile.selectedBridge';

const loginId = 'playwright-user';
const bridgeId = 'bridge-stale-snapshot';
const projectId = 'project-stale-snapshot';
const threadId = 'thread-stale-snapshot-1';
const issueId = 'issue-stale-snapshot-1';

const session = {
  accessToken: 'playwright-token',
  expiresAt: '2099-01-01T00:00:00.000Z',
  role: 'owner',
  userId: loginId,
  displayName: 'Playwright User',
  permissions: ['*'],
  loginId
};

const thread = {
  id: threadId,
  title: 'stale snapshot 단일 버블 검증',
  name: 'stale snapshot 단일 버블 검증',
  project_id: projectId,
  status: 'running',
  progress: 88,
  last_event: 'item.agentMessage.delta',
  last_message: '[목표]\n- 모바일 실시간 응답 안정화',
  updated_at: '2026-04-17T12:00:00.000Z',
  created_at: '2026-04-17T11:59:00.000Z',
  active_physical_thread_id: 'pt-stale-1'
};

const issue = {
  id: issueId,
  thread_id: threadId,
  title: 'stale snapshot 응답',
  status: 'running',
  created_at: '2026-04-17T12:00:10.000Z',
  updated_at: '2026-04-17T12:00:30.000Z',
  executed_physical_thread_id: 'pt-stale-1'
};

const promptMessage = {
  id: 'prompt-1',
  role: 'user',
  kind: 'prompt',
  content: '응답을 한 버블에서 끝까지 유지해줘',
  timestamp: '2026-04-17T12:00:11.000Z',
  issue_id: issueId
};

function buildSseEvent(eventName, payload) {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function buildMessageEvent(type, payload) {
  return buildSseEvent('message', {
    type,
    payload: {
      threadId,
      projectId,
      issueId,
      ...payload
    }
  });
}

const sseBody = [
  buildSseEvent('ready', { ok: true }),
  buildSseEvent('snapshot', {
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
  }),
  buildMessageEvent('thread.started', { thread }),
  buildMessageEvent('item.agentMessage.delta', {
    delta: [
      '[목표]',
      '- 모바일 실시간 응답 안정화',
      '',
      '[계획]',
      '- 한 버블 누적 유지',
      '',
      '[진행 내역]',
      '- 긴 assistant 응답 유지'
    ].join('\n')
  }),
  buildMessageEvent('logicalThread.timeline.updated', {
    thread_id: threadId,
    entries: [
      promptMessage,
      {
        id: 'assistant-stale',
        role: 'assistant',
        kind: 'message',
        content: '[목표]\n- 모바일 실시간 응답 안정화',
        timestamp: '2026-04-17T12:00:12.000Z',
        issue_id: issueId
      }
    ]
  })
].join('');

test.use({
  serviceWorkers: 'block',
  hasTouch: true,
  isMobile: true,
  viewport: {
    width: 390,
    height: 844
  }
});

async function mockMobileApi(page) {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();

    if (pathname === '/api/events') {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        body: sseBody
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
          projects: [
            {
              id: projectId,
              name: 'Stale Snapshot Project',
              bridge_id: bridgeId
            }
          ]
        })
      });
      return;
    }

    if (pathname === `/api/projects/${projectId}/threads` && method === 'GET') {
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
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          issues: [issue]
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
          issue,
          messages: [promptMessage]
        })
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({})
    });
  });
}

test.describe('모바일 stale snapshot 단일 버블 회귀', () => {
  let server;
  let baseUrl;

  test.beforeAll(async () => {
    await buildWorkspace('@octop/mobile');
    server = new StaticAppServer(MOBILE_DIST_DIR);
    const port = await server.start();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  test.afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  test('늦게 도착한 짧은 timeline snapshot이 와도 assistant 응답은 한 버블에서 줄어들지 않는다', async ({ page }) => {
    await mockMobileApi(page);
    await page.addInitScript(
      ({ sessionKey, sessionValue, selectedBridgeKey, selectedBridgeValue }) => {
        window.localStorage.setItem(sessionKey, JSON.stringify(sessionValue));
        window.localStorage.setItem(selectedBridgeKey, selectedBridgeValue);
        HTMLElement.prototype.setPointerCapture = () => {};
        HTMLElement.prototype.releasePointerCapture = () => {};
      },
      {
        sessionKey: SESSION_KEY,
        sessionValue: session,
        selectedBridgeKey: SELECTED_BRIDGE_KEY,
        selectedBridgeValue: bridgeId
      }
    );

    await page.goto(baseUrl);

    await expect(page.getByTestId(`thread-list-item-${threadId}`)).toBeVisible();
    await page.getByTestId(`thread-list-item-${threadId}`).click();

    await expect(page.getByTestId('thread-detail-panel')).toContainText(thread.title);
    await expect.poll(async () => await page.locator('[data-testid="message-bubble-light"]').count()).toBe(1);
    await expect.poll(async () => await page.locator('[data-scroll-anchor-id^="chat:"]').count()).toBe(2);

    const assistantBubble = page.locator('[data-testid="message-bubble-light"]').first();
    await expect(assistantBubble).toContainText('[목표]');
    await expect(assistantBubble).toContainText('[계획]');
    await expect(assistantBubble).toContainText('[진행 내역]');
    await expect(assistantBubble).toContainText('긴 assistant 응답 유지');

    const assistantText = await assistantBubble.textContent();

    expect((assistantText.match(/\[목표\]/g) || []).length).toBe(1);
    expect((assistantText.match(/\[계획\]/g) || []).length).toBe(1);
    expect((assistantText.match(/\[진행 내역\]/g) || []).length).toBe(1);
  });
});
