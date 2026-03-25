const { test, expect } = require("@playwright/test");
const path = require("path");
const { REPO_ROOT, StaticAppServer, buildWorkspace } = require("../helpers/static-app-server");

const MOBILE_DIST_DIR = path.join(REPO_ROOT, "apps", "mobile", "dist");

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
    await page.addInitScript(() => {
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
});
