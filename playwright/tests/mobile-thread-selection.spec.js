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

async function mockMobileApi(page, options = {}) {
  const nextThreads = Array.isArray(options.threads) ? options.threads : [thread];
  const nextIssues = Array.isArray(options.issues) ? options.issues : [issue];
  const nextIssueMessages = Array.isArray(options.issueMessages) ? options.issueMessages : issueMessages;
  const threadCount = Number.isFinite(options.threadCount) ? options.threadCount : nextThreads.length;
  const requestLog = Array.isArray(options.requestLog) ? options.requestLog : null;
  let currentThreads = [...nextThreads];
  let currentIssues = [...nextIssues];
  let currentIssueMessages = [...nextIssueMessages];
  let createdIssueCount = 0;

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();

    if (requestLog) {
      requestLog.push({ method, pathname });
    }

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
            threads: threadCount
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
          threads: currentThreads
        })
      });
      return;
    }

    if (pathname === `/api/threads/${threadId}/issues` && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          issues: currentIssues
        })
      });
      return;
    }

    if (pathname === `/api/threads/${threadId}/issues` && method === 'POST') {
      const payload = JSON.parse(request.postData() ?? '{}');
      const now = '2026-03-18T10:20:00.000Z';
      const createdIssueId = `issue-selection-created-${++createdIssueCount}`;
      const createdIssue = {
        ...issue,
        id: createdIssueId,
        title: payload.title ?? 'Created Issue',
        status: 'queued',
        prompt: payload.prompt ?? '',
        created_at: now,
        updated_at: now
      };

      currentIssues = [...currentIssues, createdIssue];
      currentIssueMessages = [
        ...currentIssueMessages,
        {
          id: `message-selection-created-${createdIssueCount}`,
          role: 'user',
          content: payload.prompt ?? '',
          timestamp: now,
          issue_id: createdIssueId
        }
      ];

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          issue: createdIssue,
          issues: currentIssues
        })
      });
      return;
    }

    if (pathname === `/api/threads/${threadId}/issues/start` && method === 'POST') {
      currentIssues = currentIssues.map((currentIssue) => ({
        ...currentIssue,
        status: currentIssue.status === 'queued' ? 'running' : currentIssue.status
      }));

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          issues: currentIssues
        })
      });
      return;
    }

    if (pathname.startsWith('/api/issues/') && method === 'GET') {
      const requestedIssueId = pathname.split('/').pop();
      const requestedIssue = currentIssues.find((currentIssue) => currentIssue.id === requestedIssueId) ?? issue;

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          thread,
          issue: requestedIssue,
          messages: currentIssueMessages
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

  test('opens the message action dialog in the center of the screen', async ({ page }) => {
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

    const message = page.getByTestId('message-bubble-light').getByText('Split layout assistant message.').first();
    await message.dispatchEvent('pointerdown', {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 640,
      clientY: 200
    });
    await page.waitForTimeout(700);
    await message.dispatchEvent('pointerup', {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 640,
      clientY: 200
    });

    const dialog = page.getByTestId('thread-message-action-dialog');
    await expect(dialog).toBeVisible();

    const dialogBox = await dialog.boundingBox();
    const viewport = page.viewportSize();

    expect(dialogBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(Math.abs(dialogBox.x + dialogBox.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(40);
    expect(Math.abs(dialogBox.y + dialogBox.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(40);
  });

  test('shows an empty chat panel beside the thread list when no threads exist', async ({ page }) => {
    await mockMobileApi(page, {
      threads: [],
      issues: [],
      issueMessages: [],
      threadCount: 0
    });
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
    await expect(page.getByTestId('thread-list-pane')).toBeVisible();
    await expect(page.getByTestId('thread-detail-panel')).toBeVisible();
    await expect(page.getByTestId('thread-detail-panel')).toContainText(
      '채팅창이 없습니다. 좌측 쓰레드를 선택하거나 새 채팅창을 시작해 주세요.'
    );
    await expect(page.getByTestId('thread-detail-footer')).toBeVisible();
  });

  test('keeps both split footers fixed while each pane scrolls', async ({ page }) => {
    const manyThreads = [
      thread,
      ...Array.from({ length: 18 }, (_, index) => ({
        ...thread,
        id: `thread-selection-${index + 2}`,
        title: `Extra Thread ${index + 2}`,
        name: `Extra Thread ${index + 2}`,
        updated_at: `2026-03-18T10:${String(index + 11).padStart(2, '0')}:00.000Z`
      }))
    ];
    const manyMessages = Array.from({ length: 24 }, (_, index) => ({
      id: `message-selection-${index + 1}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `Split layout message ${index + 1}`,
      timestamp: `2026-03-18T10:${String(index).padStart(2, '0')}:00.000Z`
    }));

    await mockMobileApi(page, {
      threads: manyThreads,
      issueMessages: manyMessages
    });
    await page.addInitScript(
      ({ key, value }) => {
        window.localStorage.setItem(key, JSON.stringify(value));
        HTMLElement.prototype.setPointerCapture = () => {};
        HTMLElement.prototype.releasePointerCapture = () => {};
      },
      { key: SESSION_KEY, value: session }
    );

    await page.goto(baseUrl);

    const listScroll = page.getByTestId('thread-list-scroll');
    const listFooter = page.getByTestId('thread-list-footer');
    const detailScroll = page.getByTestId('thread-detail-scroll');
    const detailFooter = page.getByTestId('thread-detail-footer');

    await expect(listFooter).toBeVisible();
    await expect(detailFooter).toBeVisible();

    const listFooterBefore = await listFooter.boundingBox();
    const detailFooterBefore = await detailFooter.boundingBox();

    expect(listFooterBefore).not.toBeNull();
    expect(detailFooterBefore).not.toBeNull();

    const listScrollTop = await listScroll.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      return node.scrollTop;
    });
    const detailScrollTop = await detailScroll.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      return node.scrollTop;
    });

    expect(listScrollTop).toBeGreaterThan(0);
    expect(detailScrollTop).toBeGreaterThan(0);

    await page.waitForTimeout(100);

    const listFooterAfter = await listFooter.boundingBox();
    const detailFooterAfter = await detailFooter.boundingBox();

    expect(listFooterAfter).not.toBeNull();
    expect(detailFooterAfter).not.toBeNull();
    expect(Math.abs(listFooterAfter.y - listFooterBefore.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(detailFooterAfter.y - detailFooterBefore.y)).toBeLessThanOrEqual(1);
  });

  test('sends on Enter and preserves line breaks on Shift+Enter in the prompt composer', async ({ page }) => {
    const requestLog = [];

    await mockMobileApi(page, { requestLog });
    await page.addInitScript(
      ({ key, value }) => {
        window.localStorage.setItem(key, JSON.stringify(value));
        HTMLElement.prototype.setPointerCapture = () => {};
        HTMLElement.prototype.releasePointerCapture = () => {};
      },
      { key: SESSION_KEY, value: session }
    );

    await page.goto(baseUrl);

    const promptInput = page.getByTestId('thread-prompt-input');
    await promptInput.click();
    await promptInput.type('Line 1');
    await promptInput.press('Shift+Enter');
    await promptInput.type('Line 2');

    await expect(promptInput).toHaveValue('Line 1\nLine 2');
    expect(
      requestLog.filter(({ method, pathname }) => method === 'POST' && pathname === `/api/threads/${threadId}/issues`).length
    ).toBe(0);

    await promptInput.press('Enter');

    await expect.poll(() =>
      requestLog.filter(({ method, pathname }) => method === 'POST' && pathname === `/api/threads/${threadId}/issues`).length
    ).toBe(1);
    await expect(promptInput).toHaveValue('');
    await expect(page.getByTestId('thread-detail-panel')).toContainText('Line 1');
    await expect(page.getByTestId('thread-detail-panel')).toContainText('Line 2');
  });
});
