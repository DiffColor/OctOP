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
const OLD_BUILD_DIR = path.join(TEMP_ROOT, 'old');
const NEW_BUILD_DIR = path.join(TEMP_ROOT, 'new');
const SERVER_PORT = 4178;
const BASE_URL = `http://127.0.0.1:${SERVER_PORT}`;
const NPM_COMMAND = 'npm';
const PWA_UPDATE_ACTIVATOR_KEY = '__octopMobilePwaUpdateActivator';
const PWA_UPDATE_READY_EVENT = 'octop.mobile.pwa.update-ready';

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

async function copyBuildArtifacts(targetDir, buildId) {
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });
  await fs.cp(MOBILE_DIST_DIR, targetDir, { recursive: true });
  const swPath = path.join(targetDir, 'sw.js');
  await fs.appendFile(swPath, `\n// playwright-build:${buildId}\n`);
}

async function prepareBuildVariant(buildId, targetDir) {
  console.info(`\n[playwright] building mobile workspace (${buildId})...`);
  await runMobileBuild(buildId);
  await copyBuildArtifacts(targetDir, buildId);
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
    await prepareBuildVariant(NEW_BUILD_ID, NEW_BUILD_DIR);
    server = new SwitchableStaticServer(OLD_BUILD_DIR);
    await server.start(SERVER_PORT);
  });

  test.afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  test('페이지가 열린 상태에서도 업데이트 준비 알림을 띄운다', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'load' });
    await page.getByRole('button', { name: '접속하기' }).waitFor({ timeout: 30_000 });
    await waitForServiceWorkerReady(page);

    await page.reload({ waitUntil: 'load' });
    await page.getByRole('button', { name: '접속하기' }).waitFor({ timeout: 30_000 });
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
    await page.waitForFunction(() => Boolean(navigator?.serviceWorker), null, { timeout: 30_000 });
    const controllerScript = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null);
    expect(controllerScript).toContain('sw.js');
  });
});
