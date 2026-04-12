const { test, expect } = require('playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { REPO_ROOT, StaticAppServer, buildWorkspace } = require('../helpers/static-app-server');

const DASHBOARD_DIST_DIR = path.join(REPO_ROOT, 'apps', 'dashboard', 'dist');
const SESSION_KEY = 'octop.dashboard.session';

const loginId = 'playwright-user';
const bridgeId = 'bridge-e2e';
const projectId = 'project-e2e';
const threadId = 'thread-attachments-1';
const existingIssueId = 'issue-attachments-1';
const dataPngUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnVY6sAAAAASUVORK5CYII=';

const session = {
  accessToken: 'playwright-token',
  expiresAt: '2099-01-01T00:00:00.000Z',
  role: 'owner',
  userId: loginId,
  displayName: 'Playwright User',
  permissions: ['*'],
  loginId
};

const project = {
  id: projectId,
  name: 'Attachment Project',
  bridge_id: bridgeId
};

const thread = {
  id: threadId,
  project_id: projectId,
  name: 'Attachment Thread',
  title: 'Attachment Thread',
  status: 'idle',
  progress: 0,
  last_event: 'thread.created',
  last_message: 'Attachment thread',
  updated_at: '2026-04-12T10:10:00.000Z',
  created_at: '2026-04-12T10:00:00.000Z'
};

const baseIssue = {
  id: existingIssueId,
  thread_id: threadId,
  root_thread_id: threadId,
  title: 'Image Attachment Issue',
  prompt: '',
  status: 'completed',
  progress: 100,
  created_at: '2026-04-12T10:05:00.000Z',
  updated_at: '2026-04-12T10:06:00.000Z',
  attachments: [
    {
      id: 'attachment-image-1',
      name: 'bubble-image.png',
      kind: 'image',
      mime_type: 'image/png',
      size_bytes: 68,
      download_url: dataPngUrl
    }
  ]
};

test.use({
  serviceWorkers: 'block',
  viewport: {
    width: 1440,
    height: 960
  }
});

async function seedDashboardSession(page) {
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, JSON.stringify(value));
    },
    { key: SESSION_KEY, value: session }
  );
}

async function mockDashboardApi(page, options = {}) {
  const createIssueRequests = options.createIssueRequests ?? [];
  const uploadRequests = options.uploadRequests ?? [];
  let createdIssueCount = 0;
  let currentIssues = Array.isArray(options.initialIssues) ? [...options.initialIssues] : [{ ...baseIssue }];

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();

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
          projects: [project]
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

    if (pathname === '/api/attachments' && method === 'POST') {
      uploadRequests.push({
        url: request.url()
      });

      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          attachment: {
            id: 'uploaded-attachment-1',
            upload_id: 'upload-1',
            name: 'octop-dashboard-upload.png',
            mime_type: 'image/png',
            size_bytes: 68,
            download_url: dataPngUrl,
            cleanup_url: 'http://example.test/api/attachments/upload-1?cleanup_token=cleanup-1',
            uploaded_at: '2026-04-12T10:11:00.000Z'
          }
        })
      });
      return;
    }

    if (pathname === `/api/threads/${threadId}/issues` && method === 'POST') {
      const payload = JSON.parse(request.postData() ?? '{}');
      createIssueRequests.push(payload);
      createdIssueCount += 1;

      const createdIssue = {
        id: `issue-created-${createdIssueCount}`,
        thread_id: threadId,
        root_thread_id: threadId,
        title: payload.title || `Created Issue ${createdIssueCount}`,
        prompt: payload.prompt ?? '',
        status: 'staged',
        progress: 0,
        created_at: '2026-04-12T10:12:00.000Z',
        updated_at: '2026-04-12T10:12:00.000Z',
        attachments: payload.attachments ?? []
      };

      currentIssues = [createdIssue, ...currentIssues];

      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          accepted: true,
          issue: createdIssue
        })
      });
      return;
    }

    if (pathname === `/api/issues/${existingIssueId}` && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          issue: currentIssues.find((issue) => issue.id === existingIssueId) ?? baseIssue,
          messages: [
            {
              id: 'message-user-1',
              role: 'user',
              kind: 'prompt',
              content: '',
              timestamp: '2026-04-12T10:05:00.000Z'
            }
          ]
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

test.describe('대시보드 이슈 첨부', () => {
  let server;
  let baseUrl;

  test.beforeAll(async () => {
    await buildWorkspace('@octop/dashboard');
    server = new StaticAppServer(DASHBOARD_DIST_DIR);
    const port = await server.start(4179);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  test.afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  test('preview_url 없이 download_url만 있어도 상세 버블 안에 이미지가 표시된다', async ({ page }) => {
    await mockDashboardApi(page);
    await seedDashboardSession(page);

    await page.goto(baseUrl);

    const issueCard = page.getByTestId(`issue-card-${existingIssueId}`);
    await expect(issueCard).toBeVisible();

    await issueCard.dblclick();

    const bubbleImage = page.locator('img[alt="bubble-image.png"]').first();
    await expect(bubbleImage).toBeVisible();
  });

  test('첨부만으로 이슈를 생성하면 첨부 payload가 전송된다', async ({ page }) => {
    const createIssueRequests = [];
    const uploadRequests = [];

    await mockDashboardApi(page, {
      createIssueRequests,
      uploadRequests
    });
    await seedDashboardSession(page);

    const tempAttachmentPath = path.join(os.tmpdir(), 'octop-dashboard-upload.png');
    fs.writeFileSync(
      tempAttachmentPath,
      Buffer.from(dataPngUrl.replace(/^data:image\/png;base64,/, ''), 'base64')
    );

    await page.goto(baseUrl);

    await page.getByRole('button', { name: /새 이슈|New Issue/ }).click();

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(tempAttachmentPath);

    await expect(page.getByTitle('octop-dashboard-upload.png')).toBeVisible();

    await page.getByRole('button', { name: /이슈 등록|등록 중|Create issue|Submitting/ }).last().click();

    await expect
      .poll(() => createIssueRequests.length, {
        message: '첨부 이슈 생성 요청이 전송되어야 합니다.'
      })
      .toBe(1);

    expect(uploadRequests).toHaveLength(1);
    expect(createIssueRequests[0].prompt).toBe('');
    expect(Array.isArray(createIssueRequests[0].attachments)).toBeTruthy();
    expect(createIssueRequests[0].attachments).toHaveLength(1);
    expect(createIssueRequests[0].attachments[0].kind).toBe('image');
  });
});
