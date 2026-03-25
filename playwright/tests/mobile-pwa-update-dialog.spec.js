const { test, expect } = require('@playwright/test');
const path = require('path');
const { REPO_ROOT, StaticAppServer, buildWorkspace } = require('../helpers/static-app-server');

const MOBILE_DIST_DIR = path.join(REPO_ROOT, 'apps', 'mobile', 'dist');
const SESSION_KEY = 'octop.mobile.session';
const PWA_UPDATE_ACTIVATOR_KEY = '__octopMobilePwaUpdateActivator';
const PWA_UPDATE_READY_EVENT = 'octop.mobile.pwa.update-ready';

const loginId = 'playwright-user';
const bridgeId = 'bridge-pwa';
const projectId = 'project-pwa';
const session = {
  accessToken: 'playwright-token',
  expiresAt: '2099-01-01T00:00:00.000Z',
  role: 'owner',
  userId: loginId,
  displayName: 'Playwright User',
  permissions: ['*'],
  loginId
};

test.use({
  serviceWorkers: 'block',
  hasTouch: true,
  isMobile: true,
  viewport: {
    width: 430,
    height: 932
  }
});

async function mockMobileShellApi(page) {
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
            threads: 0
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
              name: 'PWA Test Project',
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
          threads: []
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

    if (pathname === '/api/workspace-roots') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          roots: []
        })
      });
      return;
    }

    if (pathname === '/api/folders') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          path: '',
          parent_path: null,
          entries: []
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

test.describe('모바일 PWA 업데이트 다이얼로그', () => {
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

  test('업데이트 적용 진행 중에는 뒤늦은 update-ready 이벤트가 와도 다이얼로그를 다시 초기화하지 않는다', async ({ page }) => {
    await mockMobileShellApi(page);
    await page.addInitScript(({ key, value }) => {
      window.localStorage.setItem(key, JSON.stringify(value));
    }, { key: SESSION_KEY, value: session });

    await page.goto(baseUrl, { waitUntil: 'load' });
    await expect(page.getByTestId('thread-create-button')).toBeVisible();
    await page.waitForTimeout(100);

    await page.evaluate(({ eventName, activatorKey }) => {
      window.__octopPwaActivateCalls = [];
      const emitUpdateReady = (label) => {
        const activate = () => {
          window.__octopPwaActivateCalls.push(label);
        };

        window[activatorKey] = activate;
        window.dispatchEvent(
          new CustomEvent(eventName, {
            detail: {
              activate
            }
          })
        );
      };

      window.__octopEmitUpdateReady = emitUpdateReady;
      emitUpdateReady('first');
    }, { eventName: PWA_UPDATE_READY_EVENT, activatorKey: PWA_UPDATE_ACTIVATOR_KEY });

    await expect(page.getByText('업데이트가 준비되었습니다')).toBeVisible();
    await expect(page.getByRole('button', { name: '지금 새로고침' })).toBeVisible();

    await page.getByRole('button', { name: '지금 새로고침' }).click();

    await expect(page.getByRole('button', { name: '새로고침 중...' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__octopPwaActivateCalls)).toEqual(['first']);

    await page.evaluate(() => {
      window.__octopEmitUpdateReady('second');
    });

    await expect(page.getByText('업데이트가 준비되었습니다')).toBeVisible();
    await expect(page.getByRole('button', { name: '새로고침 중...' })).toBeVisible();
    await expect(page.getByRole('button', { name: '새로고침 중...' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '지금 새로고침' })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__octopPwaActivateCalls)).toEqual(['first']);
  });
});
