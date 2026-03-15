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
          status: {
            bridge_id: bridgeId,
            counts: {
              projects: 1,
              threads: 1
            }
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
          threads: [rootThread]
        })
      });
      return;
    }

    if (pathname === `/api/threads/${rootThreadId}/issues`) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(issuesPayload)
      });
      return;
    }

    if (pathname.startsWith('/api/issues/')) {
      const issueId = pathname.split('/').at(-1);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(issueDetails[issueId] ?? { issue: null, messages: [] })
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
});
