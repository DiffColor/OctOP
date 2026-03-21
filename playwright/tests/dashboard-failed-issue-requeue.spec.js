const { test, expect } = require('playwright/test');
const path = require('path');
const { REPO_ROOT, StaticAppServer, buildWorkspace } = require('../helpers/static-app-server');

const DASHBOARD_DIST_DIR = path.join(REPO_ROOT, 'apps', 'dashboard', 'dist');
const SESSION_KEY = 'octop.dashboard.session';

const loginId = 'playwright-user';
const bridgeId = 'bridge-e2e';
const projectId = 'project-e2e';
const threadId = 'thread-review-retry-1';

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
  project_id: projectId,
  name: 'Retry Root Thread',
  title: 'Retry Root Thread',
  status: 'idle',
  progress: 0,
  last_event: 'thread.created',
  last_message: 'retry dashboard failures',
  updated_at: '2026-03-21T10:00:00.000Z',
  created_at: '2026-03-21T09:55:00.000Z'
};

test.use({
  serviceWorkers: 'block',
  viewport: {
    width: 1440,
    height: 960
  }
});

async function mockDashboardApi(page, options = {}) {
  const requestLog = Array.isArray(options.requestLog) ? options.requestLog : null;
  let currentIssues = Array.isArray(options.issues)
    ? [...options.issues]
    : [
        {
          id: 'issue-failed-1',
          thread_id: threadId,
          root_thread_id: threadId,
          title: 'Failed issue A',
          prompt: 'Retry issue A',
          status: 'failed',
          progress: 0,
          updated_at: '2026-03-21T10:02:00.000Z',
          created_at: '2026-03-21T10:00:00.000Z'
        },
        {
          id: 'issue-failed-2',
          thread_id: threadId,
          root_thread_id: threadId,
          title: 'Failed issue B',
          prompt: 'Retry issue B',
          status: 'failed',
          progress: 0,
          updated_at: '2026-03-21T10:03:00.000Z',
          created_at: '2026-03-21T10:01:00.000Z'
        }
      ];

  const syncQueuedPositions = () => {
    let prepPosition = 1;
    let queuePosition = 1;
    currentIssues = currentIssues.map((issue) => {
      if (issue.status === 'staged') {
        return {
          ...issue,
          prep_position: prepPosition++,
          queue_position: null
        };
      }

      if (issue.status === 'queued') {
        return {
          ...issue,
          prep_position: null,
          queue_position: queuePosition++
        };
      }

      return {
        ...issue,
        prep_position: null,
        queue_position: null
      };
    });
  };

  syncQueuedPositions();

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();

    if (requestLog) {
      requestLog.push({
        method,
        pathname,
        body: request.postData() ? JSON.parse(request.postData()) : null
      });
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

    if (pathname === '/api/dashboard/archives') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          archives: {}
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
              name: 'Retry Project'
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

    if (pathname === `/api/threads/${threadId}/issues` && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          thread,
          issues: currentIssues
        })
      });
      return;
    }

    if (pathname.match(/^\/api\/issues\/[^/]+\/interrupt$/) && method === 'POST') {
      const targetIssueId = pathname.split('/')[3];
      currentIssues = currentIssues.map((issue) =>
        issue.id === targetIssueId
          ? {
              ...issue,
              status: 'staged',
              progress: 0,
              last_event: 'issue.interrupted',
              updated_at: '2026-03-21T10:05:00.000Z'
            }
          : issue
      );
      syncQueuedPositions();

      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          accepted: true,
          issue_id: targetIssueId,
          issues: currentIssues
        })
      });
      return;
    }

    if (pathname === `/api/threads/${threadId}/issues/start` && method === 'POST') {
      const payload = JSON.parse(request.postData() ?? '{}');
      const issueIds = Array.isArray(payload.issue_ids) ? payload.issue_ids : [];
      currentIssues = currentIssues.map((issue) =>
        issueIds.includes(issue.id)
          ? {
              ...issue,
              status: 'queued',
              progress: 10,
              last_event: 'issue.queued',
              updated_at: '2026-03-21T10:06:00.000Z'
            }
          : issue
      );
      syncQueuedPositions();

      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          accepted: true,
          issues: currentIssues
        })
      });
      return;
    }

    if (pathname === `/api/threads/${threadId}/issues/reorder` && method === 'POST') {
      const payload = JSON.parse(request.postData() ?? '{}');
      const issueIds = Array.isArray(payload.issue_ids) ? payload.issue_ids : [];
      const queuedById = new Map(currentIssues.filter((issue) => issue.status === 'queued').map((issue) => [issue.id, issue]));
      const reorderedIds = issueIds.filter((issueId) => queuedById.has(issueId));
      const remainingIds = [...queuedById.keys()].filter((issueId) => !reorderedIds.includes(issueId));
      const finalOrder = [...reorderedIds, ...remainingIds];

      currentIssues = currentIssues.map((issue) => {
        if (issue.status !== 'queued') {
          return issue;
        }

        const queuePosition = finalOrder.indexOf(issue.id);
        return {
          ...issue,
          queue_position: queuePosition >= 0 ? queuePosition + 1 : issue.queue_position
        };
      });

      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          accepted: true,
          issues: currentIssues
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

test.describe('대시보드 실패 이슈 재대기열 이동', () => {
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

  test('검토 컬럼의 실패 이슈를 다중선택 드래그로 To Do로 다시 보낼 수 있다', async ({ page }) => {
    const requestLog = [];
    await mockDashboardApi(page, { requestLog });
    await page.addInitScript(
      ({ key, value }) => {
        window.localStorage.setItem(key, JSON.stringify(value));
      },
      { key: SESSION_KEY, value: session }
    );

    await page.goto(baseUrl);

    const firstIssueCard = page.getByTestId('issue-card-issue-failed-1');
    const secondIssueCard = page.getByTestId('issue-card-issue-failed-2');
    const todoColumn = page.getByTestId('board-column-todo');

    await expect(firstIssueCard).toBeVisible();
    await expect(secondIssueCard).toBeVisible();

    await secondIssueCard.locator('button').first().click();
    await firstIssueCard.locator('button').first().click({ modifiers: ['Shift'] });

    await firstIssueCard.dragTo(todoColumn);

    await expect(todoColumn).toContainText('Failed issue A');
    await expect(todoColumn).toContainText('Failed issue B');

    const interruptRequests = requestLog.filter(
      ({ method, pathname }) => method === 'POST' && pathname.startsWith('/api/issues/') && pathname.endsWith('/interrupt')
    );
    expect(interruptRequests).toHaveLength(2);
    expect(interruptRequests.map(({ pathname }) => pathname.split('/')[3]).sort()).toEqual(['issue-failed-1', 'issue-failed-2']);

    const startRequest = requestLog.find(
      ({ method, pathname }) => method === 'POST' && pathname === `/api/threads/${threadId}/issues/start`
    );

    expect(startRequest).toBeTruthy();
    expect([...(startRequest.body?.issue_ids ?? [])].sort()).toEqual(['issue-failed-1', 'issue-failed-2']);
  });
});
