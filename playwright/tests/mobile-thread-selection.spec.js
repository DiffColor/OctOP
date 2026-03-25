const { test, expect } = require('playwright/test');
const path = require('path');
const { REPO_ROOT, StaticAppServer, buildWorkspace } = require('../helpers/static-app-server');

const MOBILE_DIST_DIR = path.join(REPO_ROOT, 'apps', 'mobile', 'dist');
const SESSION_KEY = 'octop.mobile.session';
const WORKSPACE_LAYOUT_KEY = 'octop.mobile.workspace.layout.v1';

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
  const primaryThreadId = String(nextThreads[0]?.id ?? threadId);
  const threadCount = Number.isFinite(options.threadCount) ? options.threadCount : nextThreads.length;
  const requestLog = Array.isArray(options.requestLog) ? options.requestLog : null;
  const deleteRequests = Array.isArray(options.deleteRequests) ? options.deleteRequests : null;
  const issueDetailRequestHandler =
    typeof options.issueDetailRequestHandler === 'function' ? options.issueDetailRequestHandler : null;
  let currentThreads = [...nextThreads];
  let issueDetailRequestCount = 0;
  const threadStateById = new Map(
    nextThreads.map((currentThread) => [
      currentThread.id,
      {
        thread: currentThread,
        issues:
          currentThread.id === primaryThreadId
            ? [...nextIssues]
            : Array.isArray(options.issuesByThreadId?.[currentThread.id])
              ? [...options.issuesByThreadId[currentThread.id]]
              : [],
        issueMessages:
          currentThread.id === primaryThreadId
            ? [...nextIssueMessages]
            : Array.isArray(options.issueMessagesByThreadId?.[currentThread.id])
              ? [...options.issueMessagesByThreadId[currentThread.id]]
              : [],
        createdIssueCount: 0
      }
    ])
  );

  const ensureThreadState = (requestedThreadId) => {
    const normalizedThreadId = String(requestedThreadId ?? '').trim();
    const existing = threadStateById.get(normalizedThreadId);

    if (existing) {
      return existing;
    }

    const fallbackThread =
      currentThreads.find((currentThread) => currentThread.id === normalizedThreadId) ??
      (normalizedThreadId
        ? {
            ...thread,
            id: normalizedThreadId,
            title: normalizedThreadId,
            name: normalizedThreadId,
            status: 'idle'
          }
        : thread);
    const nextState = {
      thread: fallbackThread,
      issues: [],
      issueMessages: [],
      createdIssueCount: 0
    };

    threadStateById.set(normalizedThreadId, nextState);
    return nextState;
  };

  const findIssueState = (requestedIssueId) => {
    const normalizedIssueId = String(requestedIssueId ?? '').trim();

    for (const currentState of threadStateById.values()) {
      if (currentState.issues.some((currentIssue) => currentIssue.id === normalizedIssueId)) {
        return currentState;
      }
    }

    return null;
  };

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

    if (pathname.match(/^\/api\/threads\/[^/]+$/) && method === 'DELETE') {
      const requestedThreadId = pathname.split('/')[3];

      if (deleteRequests) {
        deleteRequests.push(requestedThreadId);
      }

      currentThreads = currentThreads.filter((currentThread) => currentThread.id !== requestedThreadId);
      threadStateById.delete(requestedThreadId);

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          accepted: true,
          deleted_thread_id: requestedThreadId
        })
      });
      return;
    }

    if (pathname.match(/^\/api\/threads\/[^/]+\/issues$/) && method === 'GET') {
      const requestedThreadId = pathname.split('/')[3];
      const currentState = ensureThreadState(requestedThreadId);

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          issues: currentState.issues
        })
      });
      return;
    }

    if (pathname.match(/^\/api\/threads\/[^/]+\/issues$/) && method === 'POST') {
      const requestedThreadId = pathname.split('/')[3];
      const currentState = ensureThreadState(requestedThreadId);
      const payload = JSON.parse(request.postData() ?? '{}');
      const now = '2026-03-18T10:20:00.000Z';
      const createdIssueId = `issue-selection-created-${++currentState.createdIssueCount}`;
      const createdIssue = {
        ...issue,
        thread_id: requestedThreadId,
        id: createdIssueId,
        title: payload.title ?? 'Created Issue',
        status: 'queued',
        prompt: payload.prompt ?? '',
        created_at: now,
        updated_at: now
      };

      currentState.issues = [...currentState.issues, createdIssue];
      currentState.issueMessages = [
        ...currentState.issueMessages,
        {
          id: `message-selection-created-${currentState.createdIssueCount}`,
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
          issues: currentState.issues
        })
      });
      return;
    }

    if (pathname.match(/^\/api\/threads\/[^/]+\/issues\/start$/) && method === 'POST') {
      const requestedThreadId = pathname.split('/')[3];
      const currentState = ensureThreadState(requestedThreadId);
      const payload = JSON.parse(request.postData() ?? '{}');
      const requestedIssueIds = Array.isArray(payload.issue_ids) ? payload.issue_ids : [];
      currentState.issues = currentState.issues.map((currentIssue) => ({
        ...currentIssue,
        status:
          requestedIssueIds.includes(currentIssue.id) && ['queued', 'staged'].includes(currentIssue.status)
            ? 'running'
            : currentIssue.status
      }));

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          issues: currentState.issues
        })
      });
      return;
    }

    if (pathname.match(/^\/api\/issues\/[^/]+\/interrupt$/) && method === 'POST') {
      const targetIssueId = pathname.split('/')[3];
      const payload = JSON.parse(request.postData() ?? '{}');
      const currentState = findIssueState(targetIssueId);

      if (currentState) {
        currentState.issues = currentState.issues.map((currentIssue) =>
          currentIssue.id === targetIssueId
            ? {
                ...currentIssue,
                status: payload.reason === 'drag_to_prep' ? 'staged' : 'interrupted',
                updated_at: '2026-03-18T10:21:00.000Z'
              }
            : currentIssue
        );
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          issue_id: targetIssueId,
          issues: currentState?.issues ?? []
        })
      });
      return;
    }

    if (pathname.startsWith('/api/issues/') && method === 'GET') {
      const requestedIssueId = pathname.split('/').pop();
      const currentState = findIssueState(requestedIssueId);
      issueDetailRequestCount += 1;

      let requestedIssue =
        currentState?.issues.find((currentIssue) => currentIssue.id === requestedIssueId) ?? issue;
      let responseThread = currentState?.thread ?? thread;
      let responseMessages = currentState?.issueMessages ?? nextIssueMessages;

      if (issueDetailRequestHandler) {
        const override = await issueDetailRequestHandler({
          currentState,
          issue: requestedIssue,
          messages: responseMessages,
          requestCount: issueDetailRequestCount,
          requestedIssueId
        });

        if (override?.thread) {
          responseThread = override.thread;

          if (currentState) {
            currentState.thread = override.thread;
          }
        }

        if (override?.issue) {
          requestedIssue = override.issue;

          if (currentState) {
            currentState.issues = currentState.issues.map((currentIssue) =>
              currentIssue.id === requestedIssueId ? override.issue : currentIssue
            );
          }
        }

        if (Array.isArray(override?.messages)) {
          responseMessages = override.messages;

          if (currentState) {
            currentState.issueMessages = override.messages;
          }
        }
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          thread: responseThread,
          issue: requestedIssue,
          messages: responseMessages
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

  test('이동 없이 길게 누른 뒤 손을 떼면 selection mode로 진입하고 텍스트 선택 상태가 생기지 않는다', async ({ page }) => {
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
    await expect(page.getByText('선택 1개 삭제')).toHaveCount(0);
    await card.dispatchEvent('pointerup', {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 120,
      clientY: 220
    });

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

  test('마우스로 길게 클릭한 뒤 손을 떼도 selection mode로 진입한다', async ({ page }) => {
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

    await card.dispatchEvent('pointerdown', {
      pointerId: 3,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      clientX: 140,
      clientY: 220
    });
    await page.waitForTimeout(520);
    await expect(page.getByText('선택 1개 삭제')).toHaveCount(0);

    await card.dispatchEvent('pointerup', {
      pointerId: 3,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      clientX: 140,
      clientY: 220
    });

    await expect(page.getByText('선택 1개 삭제')).toBeVisible();
  });

  test('길게 눌러 selection mode로 들어간 뒤 여러 채팅창을 한 번에 삭제할 수 있다', async ({ page }) => {
    const secondaryThread = {
      ...thread,
      id: 'thread-selection-2',
      title: 'Long Press Selection Thread 2',
      name: 'Long Press Selection Thread 2',
      updated_at: '2026-03-18T10:11:00.000Z',
      created_at: '2026-03-18T10:01:00.000Z',
      last_message: 'Second thread for multi delete.'
    };
    const deleteRequests = [];

    await mockMobileApi(page, {
      threads: [thread, secondaryThread],
      threadCount: 2,
      deleteRequests
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

    const firstCard = page.getByTestId(`thread-list-item-${threadId}`);
    const secondCard = page.getByTestId('thread-list-item-thread-selection-2');

    await expect(firstCard).toBeVisible();
    await expect(secondCard).toBeVisible();

    await firstCard.dispatchEvent('pointerdown', {
      pointerId: 7,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 120,
      clientY: 220
    });
    await page.waitForTimeout(520);
    await firstCard.dispatchEvent('pointerup', {
      pointerId: 7,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 120,
      clientY: 220
    });

    await expect(page.getByText('1개 선택됨')).toBeVisible();

    await secondCard.click();
    await expect(page.getByText('2개 선택됨')).toBeVisible();

    await page.getByRole('button', { name: '선택한 채팅창 삭제' }).click();
    await expect(page.getByRole('heading', { name: '채팅창 여러 개 삭제' })).toBeVisible();
    await page.getByRole('button', { name: '2개 삭제' }).click();

    await expect.poll(() => deleteRequests).toEqual([threadId, 'thread-selection-2']);
    await expect(firstCard).toHaveCount(0);
    await expect(secondCard).toHaveCount(0);
    await expect(page.getByText('조건에 맞는 채팅창이 없습니다. 새 채팅창을 열어 작업을 시작해 주세요.')).toBeVisible();
  });

  test('단일 화면 하단에 +인스턴트와 +채팅 버튼이 2대3 비율로 보인다', async ({ page }) => {
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

    const instantButton = page.getByTestId('thread-create-instant-button');
    const createButton = page.getByTestId('thread-create-button');

    await expect(instantButton).toBeVisible();
    await expect(createButton).toBeVisible();
    await expect(instantButton).toHaveText('+인스턴트');
    await expect(createButton).toHaveText('+채팅');

    const instantBox = await instantButton.boundingBox();
    const createBox = await createButton.boundingBox();

    expect(instantBox).not.toBeNull();
    expect(createBox).not.toBeNull();

    const widthRatio = instantBox.width / createBox.width;
    expect(widthRatio).toBeGreaterThan(0.6);
    expect(widthRatio).toBeLessThan(0.74);
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

  test('실패한 이슈 메시지에서 다시 진행 버튼으로 재대기열에 넣을 수 있다', async ({ page }) => {
    const requestLog = [];

    await mockMobileApi(page, {
      issues: [
        {
          ...issue,
          status: 'failed',
          last_message: 'Retry me'
        }
      ],
      requestLog
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
    await expect(dialog.getByRole('button', { name: '다시 진행' })).toBeVisible();

    await dialog.getByRole('button', { name: '다시 진행' }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: '중단' })).toBeVisible();

    expect(
      requestLog.some(
        ({ method, pathname }) => method === 'POST' && pathname === `/api/issues/${issueId}/interrupt`
      )
    ).toBeTruthy();
    expect(
      requestLog.some(
        ({ method, pathname }) => method === 'POST' && pathname === `/api/threads/${threadId}/issues/start`
      )
    ).toBeTruthy();
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

  test('allows resizing the split panes when the viewport exceeds twice the single-page width', async ({ page }) => {
    await page.setViewportSize({ width: 1700, height: 430 });
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

    const listPane = page.getByTestId('thread-list-pane');
    const detailPane = page.getByTestId('thread-detail-panel');
    const resizer = page.getByTestId('thread-split-resizer');

    await expect(resizer).toBeVisible();

    const listPaneBefore = await listPane.boundingBox();
    const detailPaneBefore = await detailPane.boundingBox();
    const resizerBox = await resizer.boundingBox();

    expect(listPaneBefore).not.toBeNull();
    expect(detailPaneBefore).not.toBeNull();
    expect(resizerBox).not.toBeNull();

    await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + resizerBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(resizerBox.x + resizerBox.width / 2 + 180, resizerBox.y + resizerBox.height / 2, {
      steps: 12
    });
    await page.mouse.up();

    await page.waitForTimeout(100);

    const listPaneAfter = await listPane.boundingBox();
    const detailPaneAfter = await detailPane.boundingBox();

    expect(listPaneAfter).not.toBeNull();
    expect(detailPaneAfter).not.toBeNull();
    expect(listPaneAfter.width - listPaneBefore.width).toBeGreaterThan(120);
    expect(detailPaneBefore.width - detailPaneAfter.width).toBeGreaterThan(120);
  });

  test('응답 스트림 중 위로 스크롤하면 자동 스크롤이 멈췄다가 하단 복귀 시 다시 시작된다', async ({ page }) => {
    const runningThread = {
      ...thread,
      id: 'thread-stream-scroll',
      title: 'Streaming Scroll Thread',
      name: 'Streaming Scroll Thread',
      status: 'running',
      last_event: 'item.agentMessage.delta',
      updated_at: '2026-03-18T10:10:00.000Z',
      active_physical_thread_id: 'physical-stream-scroll'
    };
    const runningIssue = {
      ...issue,
      id: 'issue-stream-scroll',
      thread_id: runningThread.id,
      status: 'running',
      created_at: '2026-03-18T10:05:00.000Z',
      updated_at: '2026-03-18T10:10:00.000Z',
      created_physical_thread_id: 'physical-stream-scroll',
      executed_physical_thread_id: 'physical-stream-scroll'
    };
    const initialMessages = [
      {
        id: 'stream-user-intro',
        role: 'user',
        content: '스트리밍 응답 스크롤 동작을 확인합니다.',
        timestamp: '2026-03-18T10:05:00.000Z'
      },
      ...Array.from({ length: 18 }, (_, index) => ({
        id: `stream-history-${index + 1}`,
        role: index % 2 === 0 ? 'assistant' : 'user',
        content: `긴 히스토리 ${index + 1}\n${`세부 줄 ${index + 1}\n`.repeat(8)}`,
        timestamp: `2026-03-18T10:${String(index + 6).padStart(2, '0')}:00.000Z`
      })),
      {
        id: 'stream-live-message',
        role: 'assistant',
        content: '실시간 응답 시작',
        timestamp: '2026-03-18T10:30:00.000Z'
      }
    ];

    await mockMobileApi(page, {
      threads: [runningThread],
      issues: [runningIssue],
      issueMessages: initialMessages,
      issueDetailRequestHandler: ({ currentState, issue: currentIssue, messages, requestCount }) => {
        if (!currentState || !currentIssue) {
          return null;
        }

        const liveContent =
          requestCount <= 1
            ? '실시간 응답 시작'
            : `실시간 응답 ${requestCount}\n${`추가 스트림 줄 ${requestCount}\n`.repeat(requestCount * 10)}`;
        const nextMessages = messages.map((message) =>
          message.id === 'stream-live-message'
            ? {
                ...message,
                content: liveContent,
                timestamp: `2026-03-18T10:${String(Math.min(59, 30 + requestCount)).padStart(2, '0')}:00.000Z`
              }
            : message
        );
        const nextUpdatedAt = `2026-03-18T10:${String(Math.min(59, 30 + requestCount)).padStart(2, '0')}:00.000Z`;

        return {
          thread: {
            ...currentState.thread,
            status: 'running',
            last_event: 'item.agentMessage.delta',
            updated_at: nextUpdatedAt
          },
          issue: {
            ...currentIssue,
            status: 'running',
            updated_at: nextUpdatedAt
          },
          messages: nextMessages
        };
      }
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

    const detailScroll = page.getByTestId('thread-detail-scroll');
    await expect(detailScroll).toBeVisible();
    await expect(page.getByTestId('thread-detail-panel')).toContainText(runningThread.title);

    await detailScroll.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await page.waitForTimeout(150);

    const initialScrollHeight = await detailScroll.evaluate((node) => node.scrollHeight);
    await expect
      .poll(async () => detailScroll.evaluate((node) => node.scrollHeight), { timeout: 8_000 })
      .toBeGreaterThan(initialScrollHeight);

    const bottomWhileStreaming = await detailScroll.evaluate((node) => ({
      scrollTop: node.scrollTop,
      distanceFromBottom: Math.max(0, node.scrollHeight - node.clientHeight - node.scrollTop),
      scrollHeight: node.scrollHeight
    }));

    expect(bottomWhileStreaming.scrollTop).toBeGreaterThan(0);
    expect(bottomWhileStreaming.distanceFromBottom).toBeLessThanOrEqual(96);

    const pausedBefore = await detailScroll.evaluate((node) => {
      node.scrollTop = Math.max(0, node.scrollTop - 220);
      return {
        scrollTop: node.scrollTop,
        scrollHeight: node.scrollHeight
      };
    });
    await page.waitForTimeout(150);

    expect(pausedBefore.scrollTop).toBeGreaterThan(0);

    await expect
      .poll(async () => detailScroll.evaluate((node) => node.scrollHeight), { timeout: 8_000 })
      .toBeGreaterThan(pausedBefore.scrollHeight);

    const pausedAfter = await detailScroll.evaluate((node) => ({
      scrollTop: node.scrollTop,
      distanceFromBottom: Math.max(0, node.scrollHeight - node.clientHeight - node.scrollTop),
      scrollHeight: node.scrollHeight
    }));

    expect(pausedAfter.scrollHeight).toBeGreaterThan(pausedBefore.scrollHeight);
    expect(Math.abs(pausedAfter.scrollTop - pausedBefore.scrollTop)).toBeLessThanOrEqual(4);
    expect(pausedAfter.distanceFromBottom).toBeGreaterThan(96);

    const resumedBefore = await detailScroll.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      return {
        scrollTop: node.scrollTop,
        scrollHeight: node.scrollHeight
      };
    });
    await page.waitForTimeout(150);

    await expect
      .poll(async () => detailScroll.evaluate((node) => node.scrollHeight), { timeout: 8_000 })
      .toBeGreaterThan(resumedBefore.scrollHeight);

    const resumedAfter = await detailScroll.evaluate((node) => ({
      scrollTop: node.scrollTop,
      distanceFromBottom: Math.max(0, node.scrollHeight - node.clientHeight - node.scrollTop),
      scrollHeight: node.scrollHeight
    }));

    expect(resumedAfter.scrollHeight).toBeGreaterThan(resumedBefore.scrollHeight);
    expect(resumedAfter.scrollTop).toBeGreaterThan(resumedBefore.scrollTop);
    expect(resumedAfter.distanceFromBottom).toBeLessThanOrEqual(96);
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

  test('뷰포트가 줄어든 상태에서는 Enter 입력이 프롬프트를 전송하지 않는다', async ({ page }) => {
    const requestLog = [];

    await mockMobileApi(page, { requestLog });
    await page.addInitScript(
      ({ key, value }) => {
        const viewportListeners = new Map();
        const mockViewport = {
          width: 390,
          height: 844,
          offsetTop: 0,
          offsetLeft: 0,
          pageTop: 0,
          pageLeft: 0,
          scale: 1,
          addEventListener(type, listener) {
            const currentListeners = viewportListeners.get(type) ?? new Set();
            currentListeners.add(listener);
            viewportListeners.set(type, currentListeners);
          },
          removeEventListener(type, listener) {
            const currentListeners = viewportListeners.get(type);

            if (!currentListeners) {
              return;
            }

            currentListeners.delete(listener);
          }
        };

        Object.defineProperty(window, 'visualViewport', {
          configurable: true,
          value: mockViewport
        });

        window.__setMockVisualViewportHeight = (nextHeight) => {
          mockViewport.height = Number(nextHeight) || mockViewport.height;

          for (const listener of viewportListeners.get('resize') ?? []) {
            listener(new Event('resize'));
          }
        };

        window.localStorage.setItem(key, JSON.stringify(value));
        HTMLElement.prototype.setPointerCapture = () => {};
        HTMLElement.prototype.releasePointerCapture = () => {};
      },
      { key: SESSION_KEY, value: session }
    );

    await page.goto(baseUrl);

    const promptInput = page.getByTestId('thread-prompt-input');
    await promptInput.click();
    await promptInput.type('Hardware keyboard send');

    await page.evaluate(() => {
      window.__setMockVisualViewportHeight(540);
    });

    await promptInput.press('Enter');

    await expect(promptInput).toHaveValue('Hardware keyboard send\n');
    expect(
      requestLog.filter(({ method, pathname }) => method === 'POST' && pathname === `/api/threads/${threadId}/issues`).length
    ).toBe(0);
  });

  test('하단 채팅 입력창은 상단 라벨과 여백을 눌러도 입력창이 선택된다', async ({ page }) => {
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

    const composerSurface = page.getByTestId('thread-prompt-surface');
    const promptInput = page.getByTestId('thread-prompt-input');
    const composerSurfaceBox = await composerSurface.boundingBox();

    expect(composerSurfaceBox).not.toBeNull();
    await expect(promptInput).not.toBeFocused();

    await composerSurface.tap({
      position: {
        x: Math.min(28, Math.max(8, composerSurfaceBox.width - 8)),
        y: 8
      }
    });

    await expect(promptInput).toBeFocused();
  });

  test('disables the composer only when the selected thread is running', async ({ page }) => {
    await mockMobileApi(page, {
      threads: [
        {
          ...thread,
          id: 'thread-running',
          status: 'running',
          title: 'Running Thread',
          name: 'Running Thread'
        },
        {
          ...thread,
          id: 'thread-awaiting-input',
          status: 'awaiting_input',
          title: 'Awaiting Input Thread',
          name: 'Awaiting Input Thread',
          updated_at: '2026-03-18T10:09:00.000Z'
        }
      ],
      issues: [],
      issueMessages: []
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

    await expect(page.getByTestId('thread-detail-panel')).toContainText('Running Thread');

    const promptInput = page.getByTestId('thread-prompt-input');
    await expect(promptInput).toBeDisabled();

    await page.getByTestId('thread-list-item-thread-awaiting-input').click();
    await expect(page.getByTestId('thread-detail-panel')).toContainText('Awaiting Input Thread');
    await expect(promptInput).toBeEnabled();
  });

  test('loads the draft once on thread entry and persists it only when leaving the chat', async ({ page }) => {
    const primaryThread = {
      ...thread,
      id: 'thread-draft-1',
      title: 'Draft Thread One',
      name: 'Draft Thread One',
      updated_at: '2026-03-18T10:12:00.000Z'
    };
    const secondaryThread = {
      ...thread,
      id: 'thread-draft-2',
      title: 'Draft Thread Two',
      name: 'Draft Thread Two',
      updated_at: '2026-03-18T10:11:00.000Z'
    };
    const initialWorkspaceLayout = {
      loginId,
      bridgeId,
      selectedScope: { kind: 'project', id: projectId },
      selectedThreadId: primaryThread.id,
      selectedTodoChatId: '',
      draftThreadProjectId: '',
      threadComposerDrafts: {
        [`thread:${primaryThread.id}`]: '저장된 초안'
      },
      activeView: 'thread',
      wideThreadSplitRatio: 0.5
    };

    await mockMobileApi(page, {
      threads: [primaryThread, secondaryThread],
      issues: [],
      issueMessages: [],
      issuesByThreadId: {
        [primaryThread.id]: [],
        [secondaryThread.id]: []
      },
      issueMessagesByThreadId: {
        [primaryThread.id]: [],
        [secondaryThread.id]: []
      }
    });
    await page.addInitScript(
      ({ sessionKey, sessionValue, layoutKey, layoutValue }) => {
        window.localStorage.setItem(sessionKey, JSON.stringify(sessionValue));
        window.localStorage.setItem(layoutKey, JSON.stringify(layoutValue));
        HTMLElement.prototype.setPointerCapture = () => {};
        HTMLElement.prototype.releasePointerCapture = () => {};
      },
      {
        sessionKey: SESSION_KEY,
        sessionValue: session,
        layoutKey: WORKSPACE_LAYOUT_KEY,
        layoutValue: initialWorkspaceLayout
      }
    );

    await page.goto(baseUrl);

    const promptInput = page.getByTestId('thread-prompt-input');
    await expect(page.getByTestId('thread-detail-panel')).toContainText(primaryThread.title);
    await expect(promptInput).toHaveValue('저장된 초안');

    await promptInput.fill('저장 대기 중인 초안');
    await expect(promptInput).toHaveValue('저장 대기 중인 초안');

    const draftWhileEditing = await page.evaluate((layoutKey) => {
      const raw = window.localStorage.getItem(layoutKey);
      return raw ? JSON.parse(raw).threadComposerDrafts ?? {} : {};
    }, WORKSPACE_LAYOUT_KEY);

    expect(draftWhileEditing[`thread:${primaryThread.id}`]).toBe('저장된 초안');

    await page.getByTestId(`thread-list-item-${secondaryThread.id}`).click();
    await expect(page.getByTestId('thread-detail-panel')).toContainText(secondaryThread.title);
    await expect(promptInput).toHaveValue('');

    await expect.poll(
      async () =>
        page.evaluate(
          ({ layoutKey, draftKey }) => {
            const raw = window.localStorage.getItem(layoutKey);
            return raw ? JSON.parse(raw).threadComposerDrafts?.[draftKey] ?? '' : '';
          },
          {
            layoutKey: WORKSPACE_LAYOUT_KEY,
            draftKey: `thread:${primaryThread.id}`
          }
        )
    ).toBe('저장 대기 중인 초안');

    await page.getByTestId(`thread-list-item-${primaryThread.id}`).click();
    await expect(page.getByTestId('thread-detail-panel')).toContainText(primaryThread.title);
    await expect(promptInput).toHaveValue('저장 대기 중인 초안');
  });
});
