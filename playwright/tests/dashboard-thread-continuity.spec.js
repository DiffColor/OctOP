const { test, expect } = require('playwright/test');
const path = require('path');
const { REPO_ROOT, StaticAppServer, buildWorkspace } = require('../helpers/static-app-server');

const DASHBOARD_DIST_DIR = path.join(REPO_ROOT, 'apps', 'dashboard', 'dist');
const SESSION_KEY = 'octop.dashboard.session';

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
  project_id: projectId,
  name: 'Root Thread Alpha',
  title: 'Root Thread Alpha',
  status: 'running',
  progress: 55,
  last_event: 'rootThread.rollover.completed',
  last_message: '현재 워크스페이스 경로',
  updated_at: '2026-03-15T10:00:00.000Z',
  created_at: '2026-03-15T09:00:00.000Z',
  context_usage_percent: 78,
  context_used_tokens: 78000,
  context_window_tokens: 100000
};

const mergedIssuesPayload = {
  thread: rootThread,
  issues: [
    {
      id: 'issue-prep-second',
      thread_id: rootThreadId,
      root_thread_id: rootThreadId,
      title: 'Prep Second',
      prompt: '현재 워크스페이스 경로',
      status: 'staged',
      prep_position: 2,
      updated_at: '2026-03-15T10:04:00.000Z',
      created_at: '2026-03-15T10:00:00.000Z'
    },
    {
      id: 'issue-prep-first',
      thread_id: rootThreadId,
      root_thread_id: rootThreadId,
      title: 'Prep First',
      prompt: '현재 워크스페이스 경로',
      status: 'staged',
      prep_position: 1,
      updated_at: '2026-03-15T10:03:00.000Z',
      created_at: '2026-03-15T10:00:00.000Z'
    },
    {
      id: 'issue-active',
      thread_id: rootThreadId,
      root_thread_id: rootThreadId,
      title: 'Active From Bridge',
      prompt: '현재 워크스페이스 경로',
      status: 'running',
      progress: 40,
      executed_physical_thread_id: 'pth-2',
      updated_at: '2026-03-15T10:05:00.000Z',
      created_at: '2026-03-15T10:01:00.000Z'
    },
    {
      id: 'issue-closed',
      thread_id: rootThreadId,
      root_thread_id: rootThreadId,
      title: 'Closed From Projection',
      prompt: '현재 워크스페이스 경로',
      status: 'completed',
      progress: 100,
      executed_physical_thread_id: 'pth-1',
      updated_at: '2026-03-15T10:02:00.000Z',
      created_at: '2026-03-15T09:55:00.000Z'
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

test.use({
  serviceWorkers: 'block'
});

async function mockDashboardApi(page) {
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
        body: JSON.stringify(mergedIssuesPayload)
      });
      return;
    }

    if (pathname.startsWith('/api/issues/')) {
      const issueId = pathname.split('/').at(-1);
      const issue = mergedIssuesPayload.issues.find((item) => item.id === issueId);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          issue,
          messages: []
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

test.describe('대시보드 continuity UI', () => {
  let server;
  let baseUrl;

  test.beforeAll(async () => {
    await buildWorkspace('@octop/dashboard');
    server = new StaticAppServer(DASHBOARD_DIST_DIR);
    const port = await server.start();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  test.afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  test('root thread 기준 merged issue board와 prep 정렬을 유지한다', async ({ page }) => {
    await mockDashboardApi(page);
    await page.addInitScript(({ key, value }) => {
      window.localStorage.setItem(key, JSON.stringify(value));
    }, { key: SESSION_KEY, value: session });

    await page.goto(baseUrl);

    await expect(page.getByRole('button', { name: /Root Thread Alpha/ }).first()).toBeVisible();
    await expect(page.getByText('Active From Bridge')).toBeVisible();
    await expect(page.getByText('Closed From Projection')).toBeVisible();

    const prepCards = page.locator('[data-testid="board-column-prep"] [data-testid^="issue-card-"]');
    await expect(prepCards).toHaveCount(2);
    await expect(prepCards.nth(0)).toContainText('Prep First');
    await expect(prepCards.nth(1)).toContainText('Prep Second');

    await expect(page.locator('[data-testid="board-column-running"]')).toContainText('Active From Bridge');
    await expect(page.locator('[data-testid="board-column-done"]')).toContainText('Closed From Projection');
  });
});
