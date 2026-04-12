const { test, expect } = require("@playwright/test");
const path = require("path");
const { REPO_ROOT, StaticAppServer, buildWorkspace } = require("../helpers/static-app-server");

const MOBILE_DIST_DIR = path.join(REPO_ROOT, "apps", "mobile", "dist");
const SESSION_KEY = "octop.mobile.session";
const WORKSPACE_LAYOUT_KEY = "octop.mobile.workspace.layout.v1";
const WORKSPACE_SNAPSHOT_KEY = "octop.mobile.workspace.snapshot.v1";
const LOGIN_ID = "standalone-user";
const BRIDGE_ID = "bridge-standalone";
const PROJECT_ID = "project-standalone";
const THREAD_ID = "thread-standalone-1";

function installStandaloneModeMock(page) {
  return page.addInitScript(() => {
    const createStandaloneMatchMediaResult = (query, originalMatchMedia) => {
      if (query === "(display-mode: standalone)") {
        return {
          matches: true,
          media: query,
          onchange: null,
          addListener() {},
          removeListener() {},
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent() {
            return false;
          }
        };
      }

      if (typeof originalMatchMedia === "function") {
        return originalMatchMedia(query);
      }

      return {
        matches: false,
        media: query,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {
          return false;
        }
      };
    };

    const originalMatchMedia = window.matchMedia?.bind(window);
    window.matchMedia = (query) => createStandaloneMatchMediaResult(query, originalMatchMedia);
    Object.defineProperty(window.navigator, "standalone", {
      configurable: true,
      get() {
        return true;
      }
    });
  });
}

test.use({
  serviceWorkers: "block",
  hasTouch: true,
  isMobile: true,
  viewport: {
    width: 1024,
    height: 1366
  }
});

test.describe("모바일 PWA standalone 히스토리 안정성", () => {
  let server;
  let baseUrl;

  test.beforeAll(async () => {
    await buildWorkspace("@octop/mobile");
    server = new StaticAppServer(MOBILE_DIST_DIR);
    const port = await server.start();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  test.afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  test("standalone 모드에서는 동일 URL 히스토리를 강제로 누적하지 않는다", async ({ page }) => {
    await installStandaloneModeMock(page);
    await page.addInitScript(() => {
      const originalPushState = window.history.pushState.bind(window.history);
      window.__octopPushStateCalls = [];
      window.history.pushState = (...args) => {
        window.__octopPushStateCalls.push(args);
        return originalPushState(...args);
      };
    });

    await page.goto(baseUrl, { waitUntil: "load" });
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__octopPushStateCalls.length)).toBe(0);
  });

  test("wide split 쓰레드리스트에서는 뒤로 가기 시 종료 팝업이 열린다", async ({ page }) => {
    await installStandaloneModeMock(page);
    await page.addInitScript(
      ({ sessionKey, workspaceLayoutKey, workspaceSnapshotKey, loginId, bridgeId, projectId, threadId }) => {
        const session = {
          accessToken: "playwright-token",
          expiresAt: "2099-01-01T00:00:00.000Z",
          role: "owner",
          userId: loginId,
          displayName: "Standalone User",
          permissions: ["*"],
          loginId
        };
        const workspaceLayout = {
          loginId,
          bridgeId,
          selectedScope: { kind: "project", id: projectId },
          selectedThreadId: threadId,
          instantThreadId: "",
          selectedTodoChatId: "",
          draftThreadProjectId: "",
          threadComposerDrafts: {},
          projectFilterUsage: {},
          projectChipOrder: [],
          threadOrderByProjectId: {},
          activeView: "inbox",
          wideThreadSplitRatio: 0.5
        };
        const workspaceSnapshot = {
          version: 1,
          scopes: {
            [`${loginId}::${bridgeId}`]: {
              updatedAt: "2026-04-13T00:00:00.000Z",
              snapshot: {
                projects: [
                  {
                    id: projectId,
                    name: "Standalone Project",
                    created_at: "2026-04-13T00:00:00.000Z",
                    updated_at: "2026-04-13T00:00:00.000Z"
                  }
                ],
                todoChats: [],
                threadListsByProjectId: {
                  [projectId]: [
                    {
                      id: threadId,
                      title: "Standalone Thread",
                      name: "Standalone Thread",
                      project_id: projectId,
                      status: "idle",
                      progress: 0,
                      last_event: "thread.created",
                      last_message: "뒤로 가기 종료 팝업 검증",
                      updated_at: "2026-04-13T00:00:00.000Z",
                      created_at: "2026-04-13T00:00:00.000Z",
                      context_usage_percent: 12,
                      context_used_tokens: 1200,
                      context_window_tokens: 100000
                    }
                  ]
                }
              }
            }
          }
        };

        window.localStorage.setItem(sessionKey, JSON.stringify(session));
        window.localStorage.setItem(workspaceLayoutKey, JSON.stringify(workspaceLayout));
        window.localStorage.setItem(workspaceSnapshotKey, JSON.stringify(workspaceSnapshot));
      },
      {
        sessionKey: SESSION_KEY,
        workspaceLayoutKey: WORKSPACE_LAYOUT_KEY,
        workspaceSnapshotKey: WORKSPACE_SNAPSHOT_KEY,
        loginId: LOGIN_ID,
        bridgeId: BRIDGE_ID,
        projectId: PROJECT_ID,
        threadId: THREAD_ID
      }
    );

    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const pathname = url.pathname;

      if (pathname === "/api/bridges") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            bridges: [
              {
                bridge_id: BRIDGE_ID,
                device_name: "Standalone Bridge",
                status: "online"
              }
            ]
          })
        });
        return;
      }

      if (pathname === "/api/bridge/status") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            bridge_id: BRIDGE_ID,
            app_server: {
              connected: true,
              initialized: true,
              account: { login_id: LOGIN_ID },
              last_error: null,
              last_socket_activity_at: "2026-04-13T00:00:00.000Z"
            },
            capabilities: {
              thread_developer_instructions: true
            },
            counts: {
              projects: 1,
              threads: 1
            },
            updated_at: "2026-04-13T00:00:00.000Z"
          })
        });
        return;
      }

      if (pathname === "/api/projects") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            projects: [
              {
                id: PROJECT_ID,
                name: "Standalone Project",
                created_at: "2026-04-13T00:00:00.000Z",
                updated_at: "2026-04-13T00:00:00.000Z"
              }
            ]
          })
        });
        return;
      }

      if (pathname === `/api/projects/${PROJECT_ID}/threads`) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            threads: [
              {
                id: THREAD_ID,
                title: "Standalone Thread",
                name: "Standalone Thread",
                project_id: PROJECT_ID,
                status: "idle",
                progress: 0,
                last_event: "thread.created",
                last_message: "뒤로 가기 종료 팝업 검증",
                updated_at: "2026-04-13T00:00:00.000Z",
                created_at: "2026-04-13T00:00:00.000Z",
                context_usage_percent: 12,
                context_used_tokens: 1200,
                context_window_tokens: 100000
              }
            ]
          })
        });
        return;
      }

      if (pathname === "/api/todo/chats") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            chats: []
          })
        });
        return;
      }

      if (pathname === "/api/events") {
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream; charset=utf-8",
          body: "event: ready\ndata: {\"ok\":true}\n\n"
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({})
      });
    });

    await page.goto(baseUrl, { waitUntil: "load" });
    await expect(page.getByRole("heading", { name: "Standalone Project" })).toBeVisible();
    await expect(page.getByTestId(`thread-list-item-${THREAD_ID}`)).toBeVisible();

    await page.evaluate(() => {
      window.history.back();
    });

    const confirmDialog = page.getByTestId("mobile-confirm-dialog");
    await expect(confirmDialog.getByText("OctOP 앱을 종료하시겠습니까?")).toBeVisible();
    await expect(confirmDialog.getByRole("button", { name: "종료" })).toBeVisible();
  });
});
