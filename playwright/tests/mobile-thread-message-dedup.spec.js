const { test, expect } = require('@playwright/test');
const path = require('path');
const { REPO_ROOT, StaticAppServer, buildWorkspace } = require('../helpers/static-app-server');

const MOBILE_DIST_DIR = path.join(REPO_ROOT, 'apps', 'mobile', 'dist');
const SESSION_KEY = 'octop.mobile.session';
const SELECTED_BRIDGE_KEY = 'octop.mobile.selectedBridge';

const loginId = 'playwright-user';
const bridgeId = 'bridge-e2e';
const projectId = 'project-dedup-e2e';
const threadId = 'thread-dedup-1';
const issueId = 'issue-dedup-1';

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
  title: '중복 응답 검증 쓰레드',
  name: '중복 응답 검증 쓰레드',
  project_id: projectId,
  status: 'idle',
  progress: 0,
  last_event: 'thread.created',
  last_message: '중복 응답 검증',
  updated_at: '2026-04-17T12:00:00.000Z',
  created_at: '2026-04-17T11:59:00.000Z',
  context_usage_percent: 10,
  context_used_tokens: 1000,
  context_window_tokens: 100000
};

const issue = {
  id: issueId,
  thread_id: threadId,
  title: '중복 응답 이슈',
  status: 'completed',
  created_at: '2026-04-17T12:00:30.000Z',
  updated_at: '2026-04-17T12:01:00.000Z'
};

const duplicateMessages = [
  {
    id: 'prompt-optimistic',
    role: 'user',
    kind: 'prompt',
    content: '응답 카드 중복을 고쳐줘',
    timestamp: '2026-04-17T12:00:31.000Z',
    issue_id: issueId
  },
  {
    id: 'prompt-final',
    role: 'user',
    kind: 'prompt',
    content: '응답 카드 중복을 고쳐줘',
    timestamp: '2026-04-17T12:00:32.000Z',
    issue_id: issueId
  },
  {
    id: 'assistant-partial',
    role: 'assistant',
    kind: 'message',
    content: '[목표]\n- 모바일 중복 원인 확인',
    timestamp: '2026-04-17T12:00:40.000Z',
    issue_id: issueId
  },
  {
    id: 'assistant-final',
    role: 'assistant',
    kind: 'message',
    content: '[목표]\n- 모바일 중복 원인 확인\n\n[계획]\n- assistant snapshot 병합\n\n[진행 내역]\n- 실제 코드 수정',
    timestamp: '2026-04-17T12:00:45.000Z',
    issue_id: issueId
  }
];

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
        body: ['event: ready', 'data: {"ok":true}', '', ''].join('\n')
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
              name: 'Dedup Project',
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
          messages: duplicateMessages
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

test.describe('모바일 응답 카드 중복 회귀', () => {
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

  test('같은 이슈의 중복 prompt/assistant snapshot이 하나의 대화 흐름으로 보인다', async ({ page }) => {
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
    await expect.poll(async () => await page.locator('[data-scroll-anchor-id^="chat:"]').count()).toBe(2);

    await expect(page.getByText('[계획]')).toBeVisible();
    await expect(page.getByText('assistant snapshot 병합')).toBeVisible();

    const bubbleTexts = await page.locator('[data-scroll-anchor-id^="chat:"]').evaluateAll((nodes) =>
      nodes.map((node) => node.textContent || '')
    );

    expect(bubbleTexts).toHaveLength(2);
    expect(bubbleTexts[0]).toContain('응답 카드 중복을 고쳐줘');
    expect(bubbleTexts[1]).toContain('[목표]');
    expect(bubbleTexts[1]).toContain('[계획]');
    expect(bubbleTexts[1]).toContain('[진행 내역]');
  });
});
