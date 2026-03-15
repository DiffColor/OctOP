const { test, expect } = require('playwright/test');
const path = require('path');
const http = require('http');
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
    },
    {
      id: 'issue-closed-second',
      thread_id: rootThreadId,
      root_thread_id: rootThreadId,
      title: 'Closed Second',
      prompt: '현재 워크스페이스 경로',
      status: 'completed',
      progress: 100,
      executed_physical_thread_id: 'pth-1',
      updated_at: '2026-03-15T10:01:30.000Z',
      created_at: '2026-03-15T09:54:00.000Z'
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

async function mockDashboardApi(page, options = {}) {
  let remoteArchives = options.initialArchives ?? {};
  const archivePutEvents = options.archivePutEvents ?? [];

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

    if (pathname === '/api/dashboard/archives') {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            archives: remoteArchives
          })
        });
        return;
      }

      if (route.request().method() === 'PUT') {
        const payload = route.request().postDataJSON() ?? {};
        remoteArchives = payload.archives ?? {};
        archivePutEvents.push(remoteArchives);

        if (typeof options.onArchivePut === 'function') {
          await options.onArchivePut({
            archives: remoteArchives,
            request: route.request()
          });
        }

        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            archives: remoteArchives
          })
        });
        return;
      }
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

  return {
    getRemoteArchives() {
      return remoteArchives;
    }
  };
}

class DashboardApiServer {
  constructor({ cacheArchivesGet = false } = {}) {
    this.cacheArchivesGet = cacheArchivesGet;
    this.remoteArchives = {};
    this.archivePutEvents = [];
    this.server = http.createServer(this.handleRequest.bind(this));
  }

  async start(port = 4000) {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server.off('error', onError);
        reject(error);
      };

      this.server.once('error', onError);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.off('error', onError);
        resolve();
      });
    });
  }

  async stop() {
    if (!this.server.listening) {
      return;
    }

    await new Promise((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  async handleRequest(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1:4000');
    const pathname = url.pathname;
    const defaultHeaders = {
      'Access-Control-Allow-Origin': req.headers.origin ?? '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
      'Access-Control-Allow-Headers': 'content-type,authorization'
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, defaultHeaders);
      res.end();
      return;
    }

    if (pathname === '/api/events') {
      res.writeHead(200, {
        ...defaultHeaders,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end('event: ready\ndata: {"ok":true}\n\n');
      return;
    }

    if (pathname === '/api/bridges') {
      this.writeJson(res, defaultHeaders, {
        bridges: [
          {
            bridge_id: bridgeId,
            device_name: 'Playwright Bridge',
            status: 'online'
          }
        ]
      });
      return;
    }

    if (pathname === '/api/bridge/status') {
      this.writeJson(res, defaultHeaders, {
        status: {
          bridge_id: bridgeId,
          counts: {
            projects: 1,
            threads: 1
          }
        }
      });
      return;
    }

    if (pathname === '/api/dashboard/archives') {
      if (req.method === 'GET') {
        this.writeJson(
          res,
          {
            ...defaultHeaders,
            'Cache-Control': this.cacheArchivesGet ? 'public, max-age=600' : 'no-store'
          },
          {
            archives: this.remoteArchives
          }
        );
        return;
      }

      if (req.method === 'PUT') {
        const body = await this.readJsonBody(req);
        this.remoteArchives = body.archives ?? {};
        this.archivePutEvents.push(this.remoteArchives);
        this.writeJson(res, defaultHeaders, {
          ok: true,
          archives: this.remoteArchives
        });
        return;
      }
    }

    if (pathname === '/api/projects') {
      this.writeJson(res, defaultHeaders, {
        projects: [
          {
            id: projectId,
            name: 'E2E Project',
            bridge_id: bridgeId
          }
        ]
      });
      return;
    }

    if (pathname === `/api/projects/${projectId}/threads`) {
      this.writeJson(res, defaultHeaders, {
        threads: [rootThread]
      });
      return;
    }

    if (pathname === `/api/threads/${rootThreadId}/issues`) {
      this.writeJson(res, defaultHeaders, mergedIssuesPayload);
      return;
    }

    if (pathname.startsWith('/api/issues/')) {
      const issueId = pathname.split('/').at(-1);
      const issue = mergedIssuesPayload.issues.find((item) => item.id === issueId);
      this.writeJson(res, defaultHeaders, {
        issue,
        messages: []
      });
      return;
    }

    this.writeJson(res, defaultHeaders, {});
  }

  writeJson(res, headers, payload) {
    res.writeHead(200, {
      ...headers,
      'Content-Type': 'application/json; charset=utf-8'
    });
    res.end(JSON.stringify(payload));
  }

  async readJsonBody(req) {
    const chunks = [];

    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    if (chunks.length === 0) {
      return {};
    }

    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
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

  test('보관 후 로컬 아카이브 데이터를 지워도 새로고침 시 서버 보관 상태를 유지한다', async ({ page }) => {
    const archivePutEvents = [];
    const api = await mockDashboardApi(page, { archivePutEvents });

    await page.addInitScript(({ key, value }) => {
      window.sessionStorage.setItem(key, JSON.stringify(value));
    }, { key: SESSION_KEY, value: session });

    await page.goto(baseUrl);

    const doneColumn = page.locator('[data-testid="board-column-done"]');
    const completedCard = doneColumn.getByTestId('issue-card-issue-closed');
    const archiveButton = doneColumn.getByTitle('보관함');

    await expect(completedCard).toBeVisible();
    await completedCard.dragTo(archiveButton);
    await expect(completedCard).toHaveCount(0);
    await expect(archivePutEvents.length).toBeGreaterThan(0);

    await page.evaluate(() => {
      window.localStorage.removeItem('octop.dashboard.archives');
    });

    await page.reload();

    await expect(doneColumn.getByTestId('issue-card-issue-closed')).toHaveCount(0);
    await expect(api.getRemoteArchives()).toEqual({
      [bridgeId]: {
        [rootThreadId]: {
          issueIds: ['issue-closed'],
          updatedAt: expect.any(String)
        }
      }
    });
  });


  test('보관 직후 바로 로컬 데이터를 지우고 새로고침해도 서버 보관 상태를 잃지 않는다', async ({ page }) => {
    const archivePutEvents = [];
    const api = await mockDashboardApi(page, {
      archivePutEvents,
      onArchivePut: async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    });

    await page.addInitScript(({ key, value }) => {
      window.sessionStorage.setItem(key, JSON.stringify(value));
    }, { key: SESSION_KEY, value: session });

    await page.goto(baseUrl);

    const doneColumn = page.locator('[data-testid="board-column-done"]');
    const completedCard = doneColumn.getByTestId('issue-card-issue-closed');
    const archiveButton = doneColumn.getByTitle('보관함');

    await expect(completedCard).toBeVisible();
    await doneColumn.evaluate((column, payload) => {
      const observer = new MutationObserver(() => {
        if (column.querySelector('[data-testid="issue-card-issue-closed"]')) {
          return;
        }

        observer.disconnect();
        window.localStorage.clear();
        window.sessionStorage.clear();
        window.sessionStorage.setItem(payload.key, JSON.stringify(payload.value));
        window.location.reload();
      });

      observer.observe(column, {
        childList: true,
        subtree: true
      });
    }, { key: SESSION_KEY, value: session });
    await completedCard.dragTo(archiveButton);
    await page.waitForLoadState('domcontentloaded');

    await expect(doneColumn.getByTestId('issue-card-issue-closed')).toHaveCount(0);
    await expect(archivePutEvents.length).toBeGreaterThan(0);
    await expect(api.getRemoteArchives()).toEqual({
      [bridgeId]: {
        [rootThreadId]: {
          issueIds: ['issue-closed'],
          updatedAt: expect.any(String)
        }
      }
    });
  });

  test('보관 상태 조회는 캐시 응답이 아닌 최신 서버 상태를 사용한다', async ({ page }) => {
    const apiServer = new DashboardApiServer({ cacheArchivesGet: true });
    await apiServer.start();

    try {
      await page.addInitScript(({ key, value }) => {
        window.sessionStorage.setItem(key, JSON.stringify(value));
      }, { key: SESSION_KEY, value: session });

      await page.goto(baseUrl);

      const doneColumn = page.locator('[data-testid="board-column-done"]');
      const completedCard = doneColumn.getByTestId('issue-card-issue-closed');
      const archiveButton = doneColumn.getByTitle('보관함');

      await expect(completedCard).toBeVisible();
      await completedCard.dragTo(archiveButton);
      await expect(completedCard).toHaveCount(0);
      await expect(apiServer.archivePutEvents.length).toBeGreaterThan(0);

      await page.evaluate(() => {
        window.localStorage.removeItem('octop.dashboard.archives');
      });
      await page.reload();

      await expect(doneColumn.getByTestId('issue-card-issue-closed')).toHaveCount(0);
    } finally {
      await apiServer.stop();
    }
  });

});
