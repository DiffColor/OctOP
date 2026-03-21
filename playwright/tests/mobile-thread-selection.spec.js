const { test, expect } = require('playwright/test');
const path = require('path');
const { REPO_ROOT, StaticAppServer, buildWorkspace } = require('../helpers/static-app-server');

const MOBILE_DIST_DIR = path.join(REPO_ROOT, 'apps', 'mobile', 'dist');
const SESSION_KEY = 'octop.mobile.session';

const loginId = 'playwright-user';
const bridgeId = 'bridge-e2e';
const projectId = 'project-e2e';
const threadId = 'thread-selection-1';
const issueId = 'issue-selection-1';

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
  title: 'Long Press Selection Thread',
  name: 'Long Press Selection Thread',
  project_id: projectId,
  status: 'idle',
  progress: 0,
  last_event: 'thread.created',
  last_message: 'Verify mobile long press selection behavior.',
  updated_at: '2026-03-18T10:10:00.000Z',
  created_at: '2026-03-18T10:00:00.000Z',
  context_usage_percent: 10,
  context_used_tokens: 1000,
  context_window_tokens: 100000
};

const issue = {
  id: issueId,
  thread_id: threadId,
  title: 'Split Layout Issue',
  status: 'completed',
  created_at: '2026-03-18T10:05:00.000Z',
  updated_at: '2026-03-18T10:12:00.000Z'
};

const issueMessages = [
  {
    id: 'message-selection-1',
    role: 'assistant',
    content: 'Split layout assistant message.',
    timestamp: '2026-03-18T10:12:00.000Z'
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
    const url = new URL(route.request().url());
    const pathname = url.pathname;

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
          projects: [
            {
              id: projectId,
              name: 'E2E Project',
              bridge_id: bridgeId
            }
          ]
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

    if (pathname === `/api/threads/${threadId}/issues`) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          issues: [issue]
        })
      });
      return;
    }

    if (pathname === `/api/issues/${issueId}`) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          thread,
          issue,
          messages: issueMessages
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

test.describe('모바일 스레드 멀티 선택 길게 누름', () => {
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

  test('길게 누르면 selection mode로 진입하고 텍스트 선택 상태가 생기지 않는다', async ({ page }) => {
    await mockMobileApi(page);
    await page.addInitScript(
      ({ key, value }) => {
        window.localStorage.setItem(key, JSON.stringify(value));
        HTMLElement.prototype.setPointerCapture = () => {};
        HTMLElement.prototype.releasePointerCapture = () => {};
      },
      { key: SESSION_KEY, value: session }
    );

    await page.goto(baseUrl);

    const card = page.getByTestId(`thread-list-item-${threadId}`);
    await expect(card).toBeVisible();
    await expect(page.getByText(thread.title)).toBeVisible();

    const selectionTargetStyle = await card.evaluate((node) => {
      const title = node.querySelector('.thread-title');
      const targetStyle = window.getComputedStyle(node);
      const titleStyle = title ? window.getComputedStyle(title) : null;

      return {
        targetUserSelect: targetStyle.userSelect,
        titleUserSelect: titleStyle?.userSelect ?? null
      };
    });

    expect(selectionTargetStyle.targetUserSelect).toBe('none');
    expect(selectionTargetStyle.titleUserSelect).toBe('none');

    await card.dispatchEvent('pointerdown', {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 120,
      clientY: 220
    });
    await page.waitForTimeout(520);

    await expect(page.getByText('선택 1개 삭제')).toBeVisible();

    const selectionState = await page.evaluate(() => {
      const selection = window.getSelection();

      return {
        text: selection?.toString() ?? '',
        rangeCount: selection?.rangeCount ?? 0,
        isCollapsed: selection?.isCollapsed ?? true
      };
    });

    expect(selectionState.text).toBe('');
    expect(selectionState.isCollapsed).toBeTruthy();
  });
});

test.describe('wide mobile split layout', () => {
  let server;
  let baseUrl;

  test.use({
    serviceWorkers: 'block',
    hasTouch: true,
    isMobile: true,
    viewport: {
      width: 900,
      height: 430
    }
  });

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

  test('keeps the thread list visible beside the current chat on wide landscape screens', async ({ page }) => {
    await mockMobileApi(page);
    await page.addInitScript(
      ({ key, value }) => {
        window.localStorage.setItem(key, JSON.stringify(value));
        HTMLElement.prototype.setPointerCapture = () => {};
        HTMLElement.prototype.releasePointerCapture = () => {};
      },
      { key: SESSION_KEY, value: session }
    );

    await page.goto(baseUrl);

    await expect(page.getByTestId('thread-split-layout')).toBeVisible();
    await expect(page.getByTestId('thread-list-pane').getByTestId(`thread-list-item-${threadId}`)).toBeVisible();
    await expect(page.getByTestId('thread-detail-panel')).toBeVisible();
    await expect(page.getByTestId('thread-detail-panel').getByText('Split layout assistant message.')).toBeVisible();
  });
});
