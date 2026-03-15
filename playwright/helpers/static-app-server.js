const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';

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

class StaticAppServer {
  constructor(rootDir) {
    this.root = path.resolve(rootDir);
    this.server = http.createServer(this.handleRequest.bind(this));
    this.listening = false;
    this.port = null;
  }

  async start(port = 0) {
    if (this.listening) {
      return this.port;
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
        this.port = this.server.address()?.port ?? null;
        resolve();
      });
    });

    return this.port;
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
        this.port = null;
        resolve();
      });
    });
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
        if (req.headers.accept && req.headers.accept.includes('text/html')) {
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

async function buildWorkspace(workspaceName, extraEnv = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(NPM_COMMAND, ['run', 'build', '--workspace', workspaceName], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...extraEnv
      },
      stdio: 'inherit'
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${workspaceName} build failed (code ${code})`));
    });
  });
}

module.exports = {
  REPO_ROOT,
  StaticAppServer,
  buildWorkspace
};
