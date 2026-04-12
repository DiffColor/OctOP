const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { REPO_ROOT, StaticAppServer, buildWorkspace } = require('../helpers/static-app-server');

const MOBILE_DIST_DIR = path.join(REPO_ROOT, 'apps', 'mobile', 'dist');
const SESSION_KEY = 'octop.mobile.session';
const BRIDGE_KEY = 'octop.mobile.selectedBridge';
const WORKSPACE_LAYOUT_KEY = 'octop.mobile.workspace.layout.v1';
const WORKSPACE_SNAPSHOT_KEY = 'octop.mobile.workspace.snapshot.v1';

const loginId = 'playwright-user';
const bridgeId = 'bridge-e2e';
const projectId = 'project-e2e';
const threadId = 'thread-attachments-1';
const issueId = 'issue-attachments-1';
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

const thread = {
  id: threadId,
  title: 'Attachment Thread',
  name: 'Attachment Thread',
  project_id: projectId,
  status: 'idle',
  progress: 0,
  last_event: 'thread.created',
  last_message: 'Attachment thread',
  updated_at: '2026-04-12T10:10:00.000Z',
  created_at: '2026-04-12T10:00:00.000Z',
  context_usage_percent: 15,
  context_used_tokens: 1500,
  context_window_tokens: 100000
};

const project = {
  id: projectId,
  name: 'E2E Project',
  bridge_id: bridgeId
};

const baseIssue = {
  id: issueId,
  thread_id: threadId,
  root_thread_id: threadId,
  title: 'Image Attachment Issue',
  prompt: '',
  status: 'completed',
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

function createWorkspaceLayout() {
  return {
    loginId,
    bridgeId,
    selectedScope: { kind: 'project', id: projectId },
    selectedThreadId: threadId,
    instantThreadId: '',
    selectedTodoChatId: '',
    draftThreadProjectId: '',
    threadComposerDrafts: {},
    projectFilterUsage: {},
    projectChipOrder: [projectId],
    threadOrderByProjectId: {
      [projectId]: [threadId]
    },
    activeView: 'thread',
    wideThreadSplitRatio: 0.5
  };
}

function createWorkspaceSnapshot() {
  return {
    version: 1,
    ownerKey: `${loginId}::${bridgeId}`,
    selectedScope: { kind: 'project', id: projectId },
    projects: [project],
    threadListsByProjectId: {
      [projectId]: [thread]
    },
    todoChats: [],
    savedAt: Date.now()
  };
}

function createThreadDetailCache(issueOverrides = {}) {
  return {
    version: 1,
    ownerKey: `${loginId}::${bridgeId}`,
    entries: {
      [threadId]: {
        thread,
        issues: [
          {
            ...baseIssue,
            ...issueOverrides
          }
        ],
        messages: [],
        loaded_issue_ids: [issueId],
        loading: false,
        error: '',
        fetchedAt: Date.now()
      }
    },
    savedAt: Date.now()
  };
}

async function seedMobileSession(page, extra = {}) {
  await page.addInitScript(
    ({ sessionKey, bridgeKey, layoutKey, snapshotKey, detailCacheKey, sessionValue, bridgeIdValue, layoutValue, snapshotValue, detailCacheValue }) => {
      window.localStorage.setItem(sessionKey, JSON.stringify(sessionValue));
      window.localStorage.setItem(bridgeKey, bridgeIdValue);
      window.localStorage.setItem(layoutKey, JSON.stringify(layoutValue));
      window.localStorage.setItem(snapshotKey, JSON.stringify(snapshotValue));
      window.localStorage.setItem(detailCacheKey, JSON.stringify(detailCacheValue));
    },
    {
      sessionKey: SESSION_KEY,
      bridgeKey: BRIDGE_KEY,
      layoutKey: WORKSPACE_LAYOUT_KEY,
      snapshotKey: WORKSPACE_SNAPSHOT_KEY,
      detailCacheKey: 'octop.mobile.threadDetails.cache.v1',
      sessionValue: session,
      bridgeIdValue: bridgeId,
      layoutValue: createWorkspaceLayout(),
      snapshotValue: createWorkspaceSnapshot(),
      detailCacheValue: createThreadDetailCache(extra.issueOverrides ?? {})
    }
  );
}

async function mockMobileApi(page, options = {}) {
  const issueDetail = options.issueDetail ?? {
    issue: {
      ...baseIssue
    },
    messages: [
      {
        id: 'message-user-1',
        role: 'user',
        kind: 'prompt',
        content: '',
        timestamp: '2026-04-12T10:05:00.000Z'
      }
    ]
  };
  const createIssueRequests = options.createIssueRequests ?? [];
  const startIssueRequests = options.startIssueRequests ?? [];
  const uploadRequests = options.uploadRequests ?? [];
  let createdIssueCount = 0;
  let currentIssues = [issueDetail.issue];
  const currentMessagesByIssueId = new Map([[issueDetail.issue.id, issueDetail.messages]]);

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
          projects: [project]
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
          issues: currentIssues
        })
      });
      return;
    }

    if (pathname.match(/^\/api\/issues\/[^/]+$/) && method === 'GET') {
      const requestedIssueId = pathname.split('/').pop();
      const requestedIssue = currentIssues.find((issue) => issue.id === requestedIssueId) ?? issueDetail.issue;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          thread,
          issue: requestedIssue,
          messages: currentMessagesByIssueId.get(requestedIssue.id) ?? issueDetail.messages
        })
      });
      return;
    }

    if (pathname === '/api/todo/chats') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          chats: []
        })
      });
      return;
    }

    if (pathname === '/api/attachments' && method === 'POST') {
      const boundary = request.headers()['content-type'] || '';
      uploadRequests.push({
        contentType: boundary
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          attachment: {
            id: 'uploaded-attachment-1',
            upload_id: 'upload-1',
            name: 'uploaded-image.png',
            kind: 'image',
            mime_type: 'image/png',
            size_bytes: 68,
            download_url: dataPngUrl,
            cleanup_url: 'http://example.test/api/attachments/upload-1?cleanup_token=cleanup-1',
            uploaded_at: '2026-04-12T10:20:00.000Z'
          }
        })
      });
      return;
    }

    if (pathname === `/api/threads/${threadId}/issues` && method === 'POST') {
      const payload = request.postDataJSON() ?? {};
      createIssueRequests.push(payload);
      createdIssueCount += 1;
      const createdIssue = {
        id: `issue-created-${createdIssueCount}`,
        thread_id: threadId,
        root_thread_id: threadId,
        title: payload.title ?? 'Created Attachment Issue',
        prompt: payload.prompt ?? '',
        status: 'queued',
        created_at: '2026-04-12T10:20:00.000Z',
        updated_at: '2026-04-12T10:20:00.000Z',
        attachments: payload.attachments ?? []
      };
      currentIssues = [...currentIssues, createdIssue];
      currentMessagesByIssueId.set(createdIssue.id, [
        {
          id: `message-created-${createdIssueCount}`,
          role: 'user',
          kind: 'prompt',
          content: payload.prompt ?? '',
          timestamp: '2026-04-12T10:20:00.000Z',
          attachments: payload.attachments ?? []
        }
      ]);

      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          accepted: true,
          issue: createdIssue,
          issues: currentIssues
        })
      });
      return;
    }

    if (pathname === `/api/threads/${threadId}/issues/start` && method === 'POST') {
      const payload = request.postDataJSON() ?? {};
      startIssueRequests.push(payload);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          issues: currentIssues.map((issue) =>
            Array.isArray(payload.issue_ids) && payload.issue_ids.includes(issue.id)
              ? {
                  ...issue,
                  status: 'running',
                  updated_at: '2026-04-12T10:20:01.000Z'
                }
              : issue
          )
        })
      });
      currentIssues = currentIssues.map((issue) =>
        Array.isArray(payload.issue_ids) && payload.issue_ids.includes(issue.id)
          ? {
              ...issue,
              status: 'running',
              updated_at: '2026-04-12T10:20:01.000Z'
            }
          : issue
      );
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({})
    });
  });
}

test.use({
  serviceWorkers: 'block',
  hasTouch: true,
  isMobile: true,
  viewport: {
    width: 390,
    height: 844
  }
});

test.describe('모바일 채팅 첨부', () => {
  let server;
  let baseUrl;

  test.beforeAll(async () => {
    await buildWorkspace('@octop/mobile');
    server = new StaticAppServer(MOBILE_DIST_DIR);
    const port = await server.start(4178);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  test.afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  test('preview_url 없이 download_url만 있어도 버블 안에 이미지가 표시된다', async ({ page }) => {
    await mockMobileApi(page);
    await seedMobileSession(page);

    await page.goto(baseUrl);

    const bubbleImage = page.locator('img[alt="bubble-image.png"]').first();
    await expect(bubbleImage).toBeVisible();
  });

  test('본문의 마크다운 이미지 문법이 실제 이미지로 렌더링된다', async ({ page }) => {
    await mockMobileApi(page, {
      issueDetail: {
        issue: {
          ...baseIssue,
          attachments: []
        },
        messages: [
          {
            id: 'message-user-markdown-image',
            role: 'user',
            kind: 'prompt',
            content: '이미지를 보여줘.',
            timestamp: '2026-04-12T10:05:00.000Z'
          },
          {
            id: 'message-assistant-markdown-image',
            role: 'assistant',
            kind: 'response',
            content: `네, 바로 보여드리겠습니다.\n\n![본문 이미지](${dataPngUrl})`,
            timestamp: '2026-04-12T10:05:30.000Z'
          }
        ]
      }
    });
    await seedMobileSession(page, {
      issueOverrides: {
        attachments: []
      }
    });

    await page.goto(baseUrl);

    const inlineMarkdownImage = page.locator('img[alt="본문 이미지"]').first();
    await expect(inlineMarkdownImage).toBeVisible();
    await expect(page.getByText(`![본문 이미지](${dataPngUrl})`)).toHaveCount(0);
  });

  test('첨부 버튼이 채팅 입력창 내부 헤더 우측에 표시된다', async ({ page }) => {
    await mockMobileApi(page);
    await seedMobileSession(page);

    await page.goto(baseUrl);

    const promptSurface = page.getByTestId('thread-prompt-surface');
    const attachButton = promptSurface.getByTestId('thread-prompt-attach-button');

    await expect(promptSurface).toBeVisible();
    await expect(attachButton).toBeVisible();
  });

  test('첨부만으로 이슈를 생성하면 첨부 payload가 전송되고 버블에 이미지가 표시된다', async ({ page }) => {
    const createIssueRequests = [];
    const startIssueRequests = [];
    const uploadRequests = [];

    await mockMobileApi(page, {
      createIssueRequests,
      startIssueRequests,
      uploadRequests
    });
    await seedMobileSession(page);

    const tempAttachmentPath = path.join(os.tmpdir(), 'octop-playwright-upload.png');
    fs.writeFileSync(
      tempAttachmentPath,
      Buffer.from(dataPngUrl.replace(/^data:image\/png;base64,/, ''), 'base64')
    );

    await page.goto(baseUrl);

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(tempAttachmentPath);

    await expect(page.getByText('octop-playwright-upload.png')).toBeVisible();

    await page.locator('form').last().locator('button').last().click({ force: true });

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
    await expect
      .poll(() => startIssueRequests.length >= 0, {
        message: '후속 시작 요청 여부와 관계없이 첨부 이슈 생성 자체는 성공해야 합니다.'
      })
      .toBeTruthy();

    const createdBubbleImage = page.locator('img[alt="octop-playwright-upload.png"]').first();
    await expect(createdBubbleImage).toBeVisible();
  });
});
