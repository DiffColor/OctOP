const { test, expect } = require('playwright/test');
const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '../..');
const MOBILE_DIST_DIR = path.join(REPO_ROOT, 'apps/mobile/dist');
const TEMP_ROOT = path.join(REPO_ROOT, 'test-results', 'playwright', 'pwa-update');
const OLD_BUILD_ID = 'playwright-old';
const NEW_BUILD_ID = 'playwright-new';
const LATEST_BUILD_ID = 'playwright-latest';
const OLD_BUILD_DIR = path.join(TEMP_ROOT, 'old');
const NEW_BUILD_DIR = path.join(TEMP_ROOT, 'new');
const LATEST_BUILD_DIR = path.join(TEMP_ROOT, 'latest');
const SERVER_PORT = 4178;
const BASE_URL = `http://127.0.0.1:${SERVER_PORT}`;
const NPM_COMMAND = 'npm';
const PWA_UPDATE_ACTIVATOR_KEY = '__octopMobilePwaUpdateActivator';
const PWA_UPDATE_READY_EVENT = 'octop.mobile.pwa.update-ready';
const QUEUED_PWA_UPDATE_BUILD_ID_KEY = '__octopMobileQueuedPwaUpdateBuildId';
const SESSION_KEY = 'octop.mobile.session';
const ASSET_MISMATCH_RECOVERY_HANDLED_KEY = '__octopAssetMismatchRecoveryHandledAt';

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

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

class SwitchableStaticServer {
  constructor(initialRoot) {
    this.root = path.resolve(initialRoot);
    this.server = http.createServer(this.handleRequest.bind(this));
    this.listening = false;
    this.fallbackMissingAssetRequestsToIndexHtml = false;
  }

  async start(port) {
    if (this.listening) {
      return;
    }

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server.off('error', onError);
        reject(error);
      };

      this.server.once('error', onError);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.off('error', onError);
        this.listening = true;
        resolve();
      });
    });
  }

  async stop() {
    if (!this.listening) {
      return;
    }

    await new Promise((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        this.listening = false;
        resolve();
      });
    });
  }

  async setRoot(nextRoot) {
    this.root = path.resolve(nextRoot);
  }

  async setFallbackMissingAssetRequestsToIndexHtml(enabled) {
    this.fallbackMissingAssetRequestsToIndexHtml = enabled === true;
  }

  async handleRequest(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end();
      return;
    }

    try {
      const asset = await this.readAsset(req);
      res.writeHead(200, {
        'Content-Type': asset.contentType,
        'Cache-Control': 'no-store'
      });

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      res.end(asset.body);
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (this.fallbackMissingAssetRequestsToIndexHtml) {
          await this.serveIndex(res, req.method);
          return;
        }

        if (req.headers['accept'] && req.headers['accept'].includes('text/html')) {
          await this.serveIndex(res, req.method);
          return;
        }

        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      res.writeHead(500);
      res.end('Internal Server Error');
    }
  }

  async readAsset(req) {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    let relativePath = decodeURIComponent(requestUrl.pathname);

    if (!relativePath || relativePath === '/') {
      relativePath = '/index.html';
    }

    if (relativePath.endsWith('/')) {
      relativePath = `${relativePath}index.html`;
    }

    const safePath = relativePath.replace(/^\/+/, '');
    const normalized = path.normalize(safePath);
    const absolutePath = path.resolve(this.root, normalized);
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : `${this.root}${path.sep}`;

    if (absolutePath !== this.root && !absolutePath.startsWith(rootWithSep)) {
      const error = new Error('Forbidden');
      error.code = 'EACCES';
      throw error;
    }

    const body = await fs.readFile(absolutePath);
    const extension = path.extname(absolutePath).toLowerCase();
    const contentType = CONTENT_TYPES[extension] ?? 'application/octet-stream';

    return { body, contentType };
  }

  async serveIndex(res, method) {
    try {
      const fallback = await fs.readFile(path.join(this.root, 'index.html'));
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES['.html'],
        'Cache-Control': 'no-store'
      });

      if (method === 'HEAD') {
        res.end();
        return;
      }

      res.end(fallback);
    } catch {
      res.writeHead(404);
      res.end('Not Found');
    }
  }
}

async function runMobileBuild(buildId) {
  await new Promise((resolve, reject) => {
    const child = spawn(NPM_COMMAND, ['run', 'build', '--workspace', '@octop/mobile'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        OCTOP_MOBILE_BUILD_ID: buildId
      },
      shell: process.platform === 'win32',
      stdio: 'inherit'
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`mobile build failed (code ${code})`));
    });
  });
}

async function copyBuildArtifacts(targetDir, buildId, options = {}) {
  const { delaySkipWaitingMs = 0 } = options;

  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });
  await fs.cp(MOBILE_DIST_DIR, targetDir, { recursive: true });
  const swPath = path.join(targetDir, 'sw.js');

  if (delaySkipWaitingMs > 0) {
    const source = await fs.readFile(swPath, 'utf8');
    const patched = source.replace(
      '    self.skipWaiting();',
      `    setTimeout(() => {\n      self.skipWaiting();\n    }, ${delaySkipWaitingMs});`
    );

    await fs.writeFile(swPath, patched);
  }

  await fs.appendFile(swPath, `\n// playwright-build:${buildId}\n`);
}

async function prepareBuildVariant(buildId, targetDir, options = {}) {
  console.info(`\n[playwright] building mobile workspace (${buildId})...`);
  await runMobileBuild(buildId);
  await copyBuildArtifacts(targetDir, buildId, options);
}

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

async function prepareMobileShell(page) {
  await mockMobileShellApi(page);
  await page.addInitScript(({ key, value }) => {
    window.localStorage.setItem(key, JSON.stringify(value));
  }, { key: SESSION_KEY, value: session });
}

async function waitForMobileShell(page) {
  await page.getByTestId('thread-create-button').waitFor({ timeout: 30_000 });
}

async function waitForServiceWorkerReady(page) {
  await page.waitForFunction(async () => {
    if (!('serviceWorker' in navigator)) {
      return false;
    }

    const registration = await navigator.serviceWorker.getRegistration();
    return Boolean(registration && (registration.active || registration.waiting));
  }, null, { timeout: 60_000 });
}

test.describe('모바일 PWA 업데이트 통보', () => {
  let server;

  test.beforeAll(async () => {
    await fs.mkdir(TEMP_ROOT, { recursive: true });
    await prepareBuildVariant(OLD_BUILD_ID, OLD_BUILD_DIR);
    await prepareBuildVariant(NEW_BUILD_ID, NEW_BUILD_DIR, { delaySkipWaitingMs: 2500 });
    await prepareBuildVariant(LATEST_BUILD_ID, LATEST_BUILD_DIR);
    server = new SwitchableStaticServer(OLD_BUILD_DIR);
    await server.start(SERVER_PORT);
  });

  test.afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  test('페이지가 열린 상태에서도 업데이트 준비 알림을 띄운다', async ({ page }) => {
    await prepareMobileShell(page);
    await page.goto(BASE_URL, { waitUntil: 'load' });
    await waitForMobileShell(page);
    await waitForServiceWorkerReady(page);

    await page.reload({ waitUntil: 'load' });
    await waitForMobileShell(page);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 30_000 });

    await page.evaluate((eventName) => {
      window.__playwrightUpdatePromise = new Promise((resolve) => {
        window.addEventListener(eventName, resolve, { once: true });
      });
    }, PWA_UPDATE_READY_EVENT);

    await server.setRoot(LATEST_BUILD_DIR);

    await page.evaluate((activatorKey) => {
      window[activatorKey] = null;
    }, PWA_UPDATE_ACTIVATOR_KEY);

    await page.evaluate(async (latestBuildId) => {
      const registration = await navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(latestBuildId)}`);
      await registration?.update?.();
    }, LATEST_BUILD_ID);

    await page.waitForFunction(
      (expectedBuildId) => {
        const scriptUrl = navigator.serviceWorker.controller?.scriptURL ?? '';
        return !scriptUrl.includes(`v=${expectedBuildId}`);
      },
      LATEST_BUILD_ID,
      { timeout: 30_000 }
    );

    await page.waitForFunction(async (expectedBuildId) => {
      const registration = await navigator.serviceWorker.getRegistration();
      return registration?.waiting?.scriptURL?.includes(`v=${expectedBuildId}`) ?? false;
    }, LATEST_BUILD_ID, { timeout: 60_000 });

    await page.evaluate(() => window.__playwrightUpdatePromise);

    const registrationSnapshot = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return {
        activeScript: registration?.active?.scriptURL ?? null,
        waitingScript: registration?.waiting?.scriptURL ?? null
      };
    });
    const activatorDetected = await page.evaluate(
      (activatorKey) => typeof window[activatorKey] === 'function',
      PWA_UPDATE_ACTIVATOR_KEY
    );
    // eslint-disable-next-line no-console
    console.info('[playwright] service worker snapshot', registrationSnapshot);
    // eslint-disable-next-line no-console
    console.info('[playwright] pending activator ready', activatorDetected);

    expect(activatorDetected).toBeTruthy();

    await page.evaluate((activatorKey) => {
      const activate = window[activatorKey];

      if (typeof activate === 'function') {
        activate();
      } else {
        throw new Error('no activator');
      }
    }, PWA_UPDATE_ACTIVATOR_KEY);

    await page.waitForLoadState('load');
    await page.waitForFunction(
      (expectedBuildId) => navigator.serviceWorker.controller?.scriptURL?.includes(`v=${expectedBuildId}`) ?? false,
      LATEST_BUILD_ID,
      { timeout: 30_000 }
    );
    await page.waitForLoadState('load');
    await waitForMobileShell(page);
    await expect
      .poll(async () => {
        try {
          return await page.evaluate(async (expectedBuildId) => {
            const registration = await navigator.serviceWorker.getRegistration();
            return {
              hasLatestController: navigator.serviceWorker.controller?.scriptURL?.includes(`v=${expectedBuildId}`) ?? false,
              hasLatestActive: registration?.active?.scriptURL?.includes(`v=${expectedBuildId}`) ?? false,
              waitingScript: registration?.waiting?.scriptURL ?? null
            };
          }, LATEST_BUILD_ID);
        } catch {
          return {
            hasLatestController: false,
            hasLatestActive: false,
            waitingScript: '__navigation_in_progress__'
          };
        }
      }, { timeout: 30_000 })
      .toEqual({
        hasLatestController: true,
        hasLatestActive: true,
        waitingScript: null
      });
    await expect(page.getByText('업데이트가 준비되었습니다')).toHaveCount(0);
  });

  test('업데이트 중 새 업데이트가 들어오면 마지막 업데이트만 예약해서 새로고침 뒤 이어서 적용한다', async ({ page }) => {
    await prepareMobileShell(page);
    await page.goto(BASE_URL, { waitUntil: 'load' });
    await waitForMobileShell(page);
    await waitForServiceWorkerReady(page);

    await page.reload({ waitUntil: 'load' });
    await waitForMobileShell(page);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 30_000 });

    await page.evaluate((eventName) => {
      window.__playwrightUpdatePromise = new Promise((resolve) => {
        window.addEventListener(eventName, resolve, { once: true });
      });
    }, PWA_UPDATE_READY_EVENT);

    await server.setRoot(NEW_BUILD_DIR);

    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration?.update();
    });

    await page.waitForFunction(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return Boolean(registration?.waiting);
    }, null, { timeout: 60_000 });

    await page.evaluate(() => window.__playwrightUpdatePromise);

    await expect(page.getByText('업데이트가 준비되었습니다')).toBeVisible();
    await expect(page.getByRole('button', { name: '지금 새로고침' })).toBeVisible();

    await server.setRoot(LATEST_BUILD_DIR);
    await page.getByRole('button', { name: '지금 새로고침' }).click();
    await expect(page.getByRole('button', { name: '새로고침 중...' })).toBeVisible();

    await page.evaluate(async (latestBuildId) => {
      const registration = await navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(latestBuildId)}`);
      await registration?.update?.();
    }, LATEST_BUILD_ID);

    await page.waitForFunction(
      ({ storageKey, latestBuildId }) => window.sessionStorage.getItem(storageKey) === latestBuildId,
      { storageKey: QUEUED_PWA_UPDATE_BUILD_ID_KEY, latestBuildId: LATEST_BUILD_ID },
      { timeout: 30_000 }
    );

    await page.waitForFunction(
      (expectedBuildId) => navigator.serviceWorker.controller?.scriptURL?.includes(`v=${expectedBuildId}`) ?? false,
      LATEST_BUILD_ID,
      { timeout: 60_000 }
    );

    await page.waitForFunction(
      (storageKey) => window.sessionStorage.getItem(storageKey) === null,
      QUEUED_PWA_UPDATE_BUILD_ID_KEY,
      { timeout: 30_000 }
    );

    await expect(page.getByText('업데이트가 준비되었습니다')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '지금 새로고침' })).toHaveCount(0);
  });

  test('누락된 JS asset 요청에 index.html이 잘못 반환돼도 서비스워커가 자동 복구한다', async ({ page }) => {
    const consoleErrors = [];

    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });

    await prepareMobileShell(page);
    await page.goto(BASE_URL, { waitUntil: 'load' });
    await waitForMobileShell(page);
    await waitForServiceWorkerReady(page);

    await page.reload({ waitUntil: 'load' });
    await waitForMobileShell(page);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 30_000 });

    const entryAssetPath = await page.evaluate(() => {
      const entryScript = [...document.querySelectorAll('script[type="module"][src]')].find((element) =>
        element.getAttribute('src')?.includes('/assets/')
      );

      if (!entryScript?.src) {
        throw new Error('entry asset script not found');
      }

      return new URL(entryScript.src, window.location.href).pathname;
    });

    const missingAssetProbePath = `${entryAssetPath}?playwright-missing-asset=1`;

    await page.evaluate(async (assetPath) => {
      const cacheKeys = await caches.keys();

      await Promise.all(
        cacheKeys.map(async (cacheKey) => {
          const cache = await caches.open(cacheKey);
          await cache.delete(assetPath);
        })
      );
    }, missingAssetProbePath);

    await server.setRoot(LATEST_BUILD_DIR);
    await server.setFallbackMissingAssetRequestsToIndexHtml(true);

    await page.evaluate((assetPath) => {
      const script = document.createElement('script');
      script.type = 'module';
      script.src = assetPath;
      script.dataset.playwrightMissingAssetProbe = 'true';
      document.body.appendChild(script);
    }, missingAssetProbePath);

    await page.waitForFunction(
      (storageKey) => window.sessionStorage.getItem(storageKey) !== null,
      ASSET_MISMATCH_RECOVERY_HANDLED_KEY,
      { timeout: 30_000 }
    );
    await waitForMobileShell(page);

    expect(consoleErrors.find((entry) => entry.includes('Expected a JavaScript-or-Wasm module script')) ?? null).toBeNull();

    await server.setFallbackMissingAssetRequestsToIndexHtml(false);
  });
});
