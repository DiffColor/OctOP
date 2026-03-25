const { test, expect } = require('playwright/test');
const path = require('path');
const { REPO_ROOT, StaticAppServer, buildWorkspace } = require('../helpers/static-app-server');

const MOBILE_DIST_DIR = path.join(REPO_ROOT, 'apps', 'mobile', 'dist');
const SESSION_KEY = 'octop.mobile.session';

const loginId = 'playwright-user';
const bridgeId = 'bridge-e2e';
const projectId = 'project-e2e';
const rootThreadId = 'thread-root-1';

const session = {
  accessToken: 'playwright-token',
  expiresAt: '2099-01-01T00:00:00.000Z',
  role: 'owner',
  userId: loginId,
  displayName: 'Playwright User',
  permissions: ['*'],
  loginId
};

const rootThread = {
  id: rootThreadId,
  title: 'Root Thread Mobile',
  name: 'Root Thread Mobile',
  project_id: projectId,
  status: 'running',
  progress: 35,
  last_event: 'rootThread.rollover.completed',
  last_message: '현재 워크스페이스 경로',
  updated_at: '2026-03-15T10:10:00.000Z',
  created_at: '2026-03-15T09:30:00.000Z',
  context_usage_percent: 82,
  context_used_tokens: 82000,
  context_window_tokens: 100000
};

const issuesPayload = {
  thread: rootThread,
  issues: [
    {
      id: 'issue-old',
      thread_id: rootThreadId,
      root_thread_id: rootThreadId,
      title: 'Closed From Projection',
      prompt: '현재 워크스페이스 경로',
      status: 'completed',
      executed_physical_thread_id: 'pth-1',
      updated_at: '2026-03-15T10:00:00.000Z',
      created_at: '2026-03-15T09:40:00.000Z'
    },
    {
      id: 'issue-active',
      thread_id: rootThreadId,
      root_thread_id: rootThreadId,
      title: 'Active From Bridge',
      prompt: '현재 워크스페이스 경로',
      status: 'running',
      executed_physical_thread_id: 'pth-2',
      updated_at: '2026-03-15T10:10:00.000Z',
      created_at: '2026-03-15T10:01:00.000Z'
    }
  ],
  continuity: {
    root_thread: {
      id: rootThreadId
    },
    active_physical_thread: {
      id: 'pth-2'
    },
    recently_closed_physical_threads: [
      {
        physical_thread_id: 'pth-1',
        closed_at: '2026-03-15T09:59:00.000Z'
      }
    ],
    read_split: {
      active_source: 'bridge',
      closed_history_source: 'projection'
    }
  }
};

const issueDetails = {
  'issue-old': {
    issue: issuesPayload.issues[0],
    messages: [
      {
        id: 'msg-old-user',
        role: 'user',
        kind: 'message',
        content: '현재 워크스페이스 경로',
        timestamp: '2026-03-15T09:40:00.000Z'
      },
      {
        id: 'msg-old-assistant',
        role: 'assistant',
        kind: 'message',
        content: '/workspace/octop',
        timestamp: '2026-03-15T09:40:02.000Z'
      }
    ]
  },
  'issue-active': {
    issue: issuesPayload.issues[1],
    messages: [
      {
        id: 'msg-active-user',
        role: 'user',
        kind: 'message',
        content: '현재 워크스페이스 경로',
        timestamp: '2026-03-15T10:01:00.000Z'
      },
      {
        id: 'msg-handoff',
        role: 'system',
        kind: 'handoff_summary',
        content: '이전 컨텍스트 요약\n- 최근 응답: /workspace/octop',
        timestamp: '2026-03-15T10:01:01.000Z'
      },
      {
        id: 'msg-active-assistant',
        role: 'assistant',
        kind: 'message',
        content: '/workspace/octop',
        timestamp: '2026-03-15T10:01:02.000Z'
      }
    ]
  }
};

test.use({
  serviceWorkers: 'block'
});

async function mockMobileApi(page, options = {}) {
  let currentThread = options.thread ?? rootThread;
  let currentThreads = options.threads ?? [currentThread];
  let currentIssuesPayload = options.issuesPayload ?? {
    ...issuesPayload,
    thread: currentThread
  };
  let currentIssueDetails = options.issueDetails ?? issueDetails;
  const normalizeRequests = options.normalizeRequests ?? [];
  const unlockRequests = options.unlockRequests ?? [];
  const normalizedThread = options.normalizedThread ?? null;
  const deleteRequests = options.deleteRequests ?? [];

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
            threads: currentThreads.length
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

    if (pathname.startsWith('/api/threads/') && route.request().method() === 'DELETE') {
      const threadId = pathname.split('/').at(-1);
      deleteRequests.push(threadId);
      currentThreads = currentThreads.filter((thread) => thread.id !== threadId);

      if (currentThread?.id === threadId) {
        currentThread = currentThreads[0] ?? null;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          accepted: true,
          deleted_thread_id: threadId
        })
      });
      return;
    }

    if (pathname === `/api/threads/${rootThreadId}/issues`) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(currentIssuesPayload)
      });
      return;
    }

    if (pathname === `/api/threads/${rootThreadId}/normalize` && route.request().method() === 'POST') {
      normalizeRequests.push(route.request().postDataJSON() ?? {});

      if (normalizedThread) {
        currentThread = normalizedThread;
        currentIssuesPayload = {
          ...currentIssuesPayload,
          thread: normalizedThread,
          continuity: {
            ...(currentIssuesPayload.continuity ?? {}),
            root_thread: {
              ...(currentIssuesPayload.continuity?.root_thread ?? {}),
              continuity_status: normalizedThread.continuity_status ?? 'healthy'
            }
          }
        };
      }

      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          accepted: true,
          action: normalizedThread ? 'rollover' : 'reconciled',
          recovered: Boolean(normalizedThread),
          thread: currentThread,
          continuity: currentIssuesPayload.continuity ?? null
        })
      });
      return;
    }

    if (pathname === `/api/threads/${rootThreadId}/unlock` && route.request().method() === 'POST') {
      unlockRequests.push(route.request().postDataJSON() ?? {});

      if (normalizedThread) {
        currentThread = normalizedThread;
        currentThreads = currentThreads.map((thread) => (thread.id === normalizedThread.id ? normalizedThread : thread));
        currentIssuesPayload = {
          ...currentIssuesPayload,
          thread: normalizedThread,
          continuity: {
            ...(currentIssuesPayload.continuity ?? {}),
            root_thread: {
              ...(currentIssuesPayload.continuity?.root_thread ?? {}),
              continuity_status: normalizedThread.continuity_status ?? 'healthy'
            }
          }
        };
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          accepted: true,
          thread: currentThread,
          continuity: currentIssuesPayload.continuity ?? null
        })
      });
      return;
    }

    if (pathname.startsWith('/api/issues/')) {
      const issueId = pathname.split('/').at(-1);
      const detail = currentIssueDetails[issueId] ?? { issue: null, messages: [] };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...detail,
          thread: currentThread
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

test.describe('모바일 handoff timeline UI', () => {
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

  test('root thread를 유지하고 handoff summary를 system message로 렌더링한다', async ({ page }) => {
    await mockMobileApi(page);
    await page.addInitScript(({ key, value }) => {
      window.localStorage.setItem(key, JSON.stringify(value));
    }, { key: SESSION_KEY, value: session });

    await page.goto(baseUrl);

    await expect(page.locator('.thread-title')).toHaveCount(1);
    await expect(page.getByText('Root Thread Mobile')).toBeVisible();

    await page.getByText('Root Thread Mobile').click();

    await expect(page.getByText('핸드오프 요약')).toBeVisible();
    await expect(page.locator('[data-testid="message-bubble-system"]')).toContainText('이전 컨텍스트 요약');
    await expect(page.locator('[data-testid="message-bubble-system"]')).toContainText('/workspace/octop');
  });

  test('채팅 상단 리프레시 버튼이 normalize를 호출하고 정상화된 thread 상태를 다시 그린다', async ({ page }) => {
    const unlockRequests = [];
    const stalledThread = {
      ...rootThread,
      last_event: 'item.agentMessage.delta',
      updated_at: '2026-03-15T07:00:00.000Z',
      context_usage_percent: 92,
      continuity_status: 'degraded'
    };
    const recoveredThread = {
      ...stalledThread,
      last_event: 'rootThread.rollover.completed',
      updated_at: '2026-03-15T10:12:00.000Z',
      context_usage_percent: 12,
      continuity_status: 'healthy'
    };

    await mockMobileApi(page, {
      thread: stalledThread,
      issuesPayload: {
        ...issuesPayload,
        thread: stalledThread
      },
      normalizedThread: recoveredThread,
      unlockRequests
    });
    await page.addInitScript(({ key, value }) => {
      window.localStorage.setItem(key, JSON.stringify(value));
    }, { key: SESSION_KEY, value: session });

    await page.goto(baseUrl);

    await page.getByText('Root Thread Mobile').click();
    await expect(page.getByText('사용률 92%')).toBeVisible();

    await page.getByRole('button', { name: '마지막 이슈 락 해제 및 새로고침' }).click();

    await expect.poll(() => unlockRequests.length).toBe(1);
    await expect(page.getByText('사용률 12%', { exact: true })).toBeVisible();
  });

  test('모바일 쓰레드 목록에서 여러 채팅창을 롱프레스로 선택해 한 번에 삭제할 수 있다', async ({ page }) => {
    const secondaryThread = {
      ...rootThread,
      id: 'thread-root-2',
      title: 'Root Thread Mobile 2',
      name: 'Root Thread Mobile 2',
      updated_at: '2026-03-15T10:11:00.000Z',
      last_message: '두 번째 쓰레드'
    };
    const deleteRequests = [];

    await mockMobileApi(page, {
      threads: [rootThread, secondaryThread],
      deleteRequests
    });
    await page.addInitScript(({ key, value }) => {
      window.localStorage.setItem(key, JSON.stringify(value));
      HTMLElement.prototype.setPointerCapture = () => {};
      HTMLElement.prototype.releasePointerCapture = () => {};
    }, { key: SESSION_KEY, value: session });

    await page.goto(baseUrl);

    const firstCard = page.getByTestId(`thread-list-item-${rootThreadId}`);
    const secondCard = page.getByTestId('thread-list-item-thread-root-2');

    await expect(firstCard).toBeVisible();
    await expect(secondCard).toBeVisible();

    await firstCard.dispatchEvent('pointerdown', {
      pointerId: 11,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 140,
      clientY: 240
    });
    await page.waitForTimeout(520);
    await firstCard.dispatchEvent('pointerup', {
      pointerId: 11,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 140,
      clientY: 240
    });

    await expect(page.getByRole('button', { name: '선택한 채팅창 삭제' })).toHaveText('선택 1개 삭제');
    await expect(page.getByText('1개 선택됨')).toHaveCount(0);

    await secondCard.click();
    await expect(page.getByRole('button', { name: '선택한 채팅창 삭제' })).toHaveText('선택 2개 삭제');
    await expect(page.getByText('2개 선택됨')).toHaveCount(0);

    await page.getByRole('button', { name: '선택한 채팅창 삭제' }).click();
    await expect(page.getByRole('heading', { name: '채팅창 여러 개 삭제' })).toBeVisible();
    await page.getByRole('button', { name: '2개 삭제' }).click();

    await expect.poll(() => deleteRequests).toEqual([rootThreadId, 'thread-root-2']);
    await expect(firstCard).toHaveCount(0);
    await expect(secondCard).toHaveCount(0);
    await expect(page.getByText('조건에 맞는 채팅창이 없습니다. 새 채팅창을 열어 작업을 시작해 주세요.')).toBeVisible();
  });
});
