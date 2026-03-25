const { test, expect } = require('playwright/test');
const path = require('path');
const { REPO_ROOT, StaticAppServer, buildWorkspace } = require('../helpers/static-app-server');

const MOBILE_DIST_DIR = path.join(REPO_ROOT, 'apps', 'mobile', 'dist');
const SESSION_KEY = 'octop.mobile.session';
const SELECTED_BRIDGE_KEY = 'octop.mobile.selectedBridge';
const WORKSPACE_LAYOUT_KEY = 'octop.mobile.workspace.layout.v1';

const loginId = 'playwright-user';
const bridgeId = 'bridge-reorder';
const projectAlphaId = 'project-alpha';
const projectBetaId = 'project-beta';
const projectGammaId = 'project-gamma';
const projectAlphaName = 'Alpha Workspace';
const projectBetaName = 'Beta Project With An Extremely Long Title For Drag Reorder Regression';
const projectGammaName = 'Gamma';

const session = {
  accessToken: 'playwright-token',
  expiresAt: '2099-01-01T00:00:00.000Z',
  role: 'owner',
  userId: loginId,
  displayName: 'Playwright User',
  permissions: ['*'],
  loginId
};

const projects = [
  {
    id: projectAlphaId,
    name: projectAlphaName,
    bridge_id: bridgeId
  },
  {
    id: projectBetaId,
    name: projectBetaName,
    bridge_id: bridgeId
  },
  {
    id: projectGammaId,
    name: projectGammaName,
    bridge_id: bridgeId
  }
];

const threadsByProjectId = {
  [projectAlphaId]: [
    {
      id: 'thread-alpha-1',
      title: 'Alpha First',
      name: 'Alpha First',
      project_id: projectAlphaId,
      status: 'idle',
      progress: 0,
      last_event: 'thread.created',
      last_message: 'first thread preview',
      updated_at: '2026-03-23T09:00:00.000Z',
      created_at: '2026-03-23T08:50:00.000Z',
      context_usage_percent: 5,
      context_used_tokens: 500,
      context_window_tokens: 100000
    },
    {
      id: 'thread-alpha-2',
      title: 'Alpha Second',
      name: 'Alpha Second',
      project_id: projectAlphaId,
      status: 'idle',
      progress: 0,
      last_event: 'thread.created',
      last_message: 'second thread preview',
      updated_at: '2026-03-23T09:01:00.000Z',
      created_at: '2026-03-23T08:51:00.000Z',
      context_usage_percent: 8,
      context_used_tokens: 800,
      context_window_tokens: 100000
    },
    {
      id: 'thread-alpha-3',
      title: 'Alpha Third',
      name: 'Alpha Third',
      project_id: projectAlphaId,
      status: 'running',
      progress: 45,
      last_event: 'turn.running',
      last_message: 'third thread preview with enough text to keep the card comfortably tall',
      updated_at: '2026-03-23T09:02:00.000Z',
      created_at: '2026-03-23T08:52:00.000Z',
      context_usage_percent: 13,
      context_used_tokens: 1300,
      context_window_tokens: 100000
    }
  ],
  [projectBetaId]: [
    {
      id: 'thread-beta-1',
      title: 'Beta Only',
      name: 'Beta Only',
      project_id: projectBetaId,
      status: 'idle',
      progress: 0,
      last_event: 'thread.created',
      last_message: 'beta thread preview',
      updated_at: '2026-03-23T09:03:00.000Z',
      created_at: '2026-03-23T08:53:00.000Z',
      context_usage_percent: 3,
      context_used_tokens: 300,
      context_window_tokens: 100000
    }
  ],
  [projectGammaId]: []
};

test.use({
  serviceWorkers: 'block',
  hasTouch: true,
  isMobile: true,
  viewport: {
    width: 390,
    height: 844
  }
});

async function mockMobileApi(page) {
  let currentProjects = projects.map((project) => ({ ...project }));
  let currentThreadsByProjectId = Object.fromEntries(
    Object.entries(threadsByProjectId).map(([projectId, threads]) => [projectId, threads.map((thread) => ({ ...thread }))])
  );

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const method = route.request().method();

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
      const threadCount = Object.values(currentThreadsByProjectId).reduce((count, threads) => count + threads.length, 0);

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
            projects: currentProjects.length,
            threads: threadCount
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
          projects: currentProjects
        })
      });
      return;
    }

    const projectDeleteMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (projectDeleteMatch && method === 'DELETE') {
      const projectId = decodeURIComponent(projectDeleteMatch[1]);

      currentProjects = currentProjects.filter((project) => project.id !== projectId);
      delete currentThreadsByProjectId[projectId];
      const remainingThreads = Object.values(currentThreadsByProjectId).flat();

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          projects: currentProjects,
          threads: remainingThreads
        })
      });
      return;
    }

    const threadListMatch = pathname.match(/^\/api\/projects\/([^/]+)\/threads$/);
    if (threadListMatch) {
      const projectId = decodeURIComponent(threadListMatch[1]);

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          threads: currentThreadsByProjectId[projectId] ?? []
        })
      });
      return;
    }

    if (pathname.match(/^\/api\/threads\/[^/]+\/issues$/) && route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          issues: []
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

async function seedMobileSession(page) {
  await page.addInitScript(
    ({ sessionKey, bridgeKey, layoutKey, sessionValue, bridgeIdValue, layoutValue }) => {
      window.localStorage.setItem(sessionKey, JSON.stringify(sessionValue));
      window.localStorage.setItem(bridgeKey, bridgeIdValue);
      window.localStorage.setItem(layoutKey, JSON.stringify(layoutValue));
      HTMLElement.prototype.setPointerCapture = () => {};
      HTMLElement.prototype.releasePointerCapture = () => {};
    },
    {
      sessionKey: SESSION_KEY,
      bridgeKey: SELECTED_BRIDGE_KEY,
      layoutKey: WORKSPACE_LAYOUT_KEY,
      sessionValue: session,
      bridgeIdValue: bridgeId,
      layoutValue: {
        loginId,
        bridgeId,
        selectedScope: {
          kind: 'project',
          id: projectAlphaId
        },
        selectedThreadId: '',
        selectedTodoChatId: '',
        draftThreadProjectId: '',
        threadComposerDrafts: {},
        projectFilterUsage: {},
        projectChipOrder: [projectAlphaId, projectBetaId, projectGammaId],
        threadOrderByProjectId: {
          [projectAlphaId]: ['thread-alpha-1', 'thread-alpha-2', 'thread-alpha-3'],
          [projectBetaId]: ['thread-beta-1']
        },
        activeView: 'inbox',
        wideThreadSplitRatio: 0.5
      }
    }
  );
}

async function collectProjectChipPositionFrames(page, labels, frameCount = 6) {
  return page.evaluate(
    async ({ nextLabels, nextFrameCount }) => {
      const readPositions = () => {
        const nodes = Array.from(document.querySelectorAll('button')).filter((node) =>
          nextLabels.includes(node.textContent?.trim() ?? '')
        );

        return nodes
          .map((node) => {
            const label = node.textContent?.trim() ?? '';
            const rect = node.getBoundingClientRect();
            return {
              label,
              x: rect.left,
              y: rect.top
            };
          })
          .sort((left, right) => left.x - right.x);
      };

      const frames = [];
      await new Promise((resolve) => window.requestAnimationFrame(resolve));

      for (let index = 0; index < nextFrameCount; index += 1) {
        frames.push(readPositions());
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
      }

      return frames;
    },
    { nextLabels: labels, nextFrameCount: frameCount }
  );
}

async function readProjectChipVisualPositions(page, labels) {
  return page.evaluate((nextLabels) => {
    return Array.from(document.querySelectorAll('button'))
      .filter((node) => nextLabels.includes(node.textContent?.trim() ?? ''))
      .map((node) => {
        const label = node.textContent?.trim() ?? '';
        const rect = node.getBoundingClientRect();
        return {
          label,
          x: rect.left,
          centerX: rect.left + rect.width / 2
        };
      })
      .sort((left, right) => left.x - right.x);
  }, labels);
}

async function readTranslateX(locator) {
  return locator.evaluate((node) => {
    const rawTransform = node instanceof HTMLElement ? node.style.transform : '';
    const matched = rawTransform.match(/translateX\(([-0-9.]+)px\)/);
    return matched ? Number.parseFloat(matched[1]) : 0;
  });
}

async function readTranslateY(locator) {
  return locator.evaluate((node) => {
    const rawTransform = node instanceof HTMLElement ? node.style.transform : '';
    const translate3dMatched = rawTransform.match(/translate3d\([^,]+,\s*([-0-9.]+)px,\s*0(?:px)?\)/);

    if (translate3dMatched) {
      return Number.parseFloat(translate3dMatched[1]);
    }

    const translateYMatched = rawTransform.match(/translateY\(([-0-9.]+)px\)/);
    return translateYMatched ? Number.parseFloat(translateYMatched[1]) : 0;
  });
}

async function collectThreadItemPositionFrames(page, threadIds, frameCount = 6) {
  return page.evaluate(
    async ({ nextThreadIds, nextFrameCount }) => {
      const readPositions = () =>
        nextThreadIds
          .map((threadId) => {
            const node = document.querySelector(`[data-testid="thread-list-item-${threadId}"]`);

            if (!(node instanceof HTMLElement)) {
              return null;
            }

            const titleNode = node.querySelector('.thread-title');
            const rect = node.getBoundingClientRect();

            return {
              threadId,
              title: titleNode?.textContent?.trim() ?? '',
              x: rect.left,
              y: rect.top
            };
          })
          .filter(Boolean)
          .sort((left, right) => left.y - right.y);

      const frames = [];
      await new Promise((resolve) => window.requestAnimationFrame(resolve));

      for (let index = 0; index < nextFrameCount; index += 1) {
        frames.push(readPositions());
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
      }

      return frames;
    },
    { nextThreadIds: threadIds, nextFrameCount: frameCount }
  );
}

test.describe('mobile reorder interactions', () => {
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

  test('프로젝트 칩은 칩 중심 기준으로 드롭 위치를 계산한다', async ({ page }) => {
    await mockMobileApi(page);
    await seedMobileSession(page);
    await page.goto(baseUrl);

    const alphaChip = page.getByTestId(`project-chip-item-${projectAlphaId}`).locator('button');
    const betaChip = page.getByTestId(`project-chip-item-${projectBetaId}`).locator('button');

    await expect(alphaChip).toBeVisible();
    await expect(betaChip).toBeVisible();

    const alphaBox = await alphaChip.boundingBox();
    const betaBox = await betaChip.boundingBox();

    expect(alphaBox).not.toBeNull();
    expect(betaBox).not.toBeNull();

    const pointerId = 11;
    const pressX = betaBox.x + betaBox.width - 6;
    const pressY = betaBox.y + betaBox.height / 2;
    const desiredDraggedCenterX = alphaBox.x + alphaBox.width / 2 - 4;
    const currentDraggedCenterX = betaBox.x + betaBox.width / 2;
    const releaseX = pressX + (desiredDraggedCenterX - currentDraggedCenterX);

    await betaChip.dispatchEvent('pointerdown', {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: pressX,
      clientY: pressY
    });
    await page.waitForTimeout(720);
    await betaChip.dispatchEvent('pointermove', {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: releaseX,
      clientY: pressY
    });
    await betaChip.dispatchEvent('pointerup', {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: releaseX,
      clientY: pressY
    });

    const chipFrames = await collectProjectChipPositionFrames(page, [projectAlphaName, projectBetaName]);

    await expect.poll(async () => {
      return page.evaluate((labels) =>
        Array.from(document.querySelectorAll('button'))
          .map((node) => node.textContent?.trim())
          .filter((text) => labels.includes(text))
      , [projectAlphaName, projectBetaName]);
    }).toEqual([projectBetaName, projectAlphaName]);

    const storedOrder = await page.evaluate(() => {
      const layout = JSON.parse(window.localStorage.getItem('octop.mobile.workspace.layout.v1') || '{}');
      return layout.projectChipOrder ?? [];
    });

    expect(storedOrder).toEqual([projectBetaId, projectAlphaId, projectGammaId]);
    expect(chipFrames[0].map((entry) => entry.label)).toEqual([projectBetaName, projectAlphaName]);

    const baselineChipFrame = chipFrames[0];
    chipFrames.slice(1).forEach((frame) => {
      expect(frame.map((entry) => entry.label)).toEqual([projectBetaName, projectAlphaName]);
      frame.forEach((entry, index) => {
        expect(Math.abs(entry.x - baselineChipFrame[index].x)).toBeLessThanOrEqual(1);
      });
    });
  });

  test('프로젝트 칩은 롱터치 입력을 받아 손을 떼면 편집 다이얼로그를 연다', async ({ page }) => {
    await mockMobileApi(page);
    await seedMobileSession(page);
    await page.goto(baseUrl);

    const betaChip = page.getByTestId(`project-chip-item-${projectBetaId}`).locator('button');

    await expect(betaChip).toBeVisible();

    const betaBox = await betaChip.boundingBox();

    expect(betaBox).not.toBeNull();

    const pointerId = 17;
    const pressX = betaBox.x + betaBox.width / 2;
    const pressY = betaBox.y + betaBox.height / 2;

    await betaChip.dispatchEvent('pointerdown', {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: pressX,
      clientY: pressY
    });
    await page.waitForTimeout(720);

    const dragFeedback = await betaChip.evaluate((node) => ({
      transform: node.style.transform,
      zIndex: node.style.zIndex,
      position: node.style.position
    }));

    expect(dragFeedback.transform).toContain('scale(1.02)');
    expect(dragFeedback.zIndex).toBe('20');
    expect(dragFeedback.position).toBe('absolute');

    await betaChip.dispatchEvent('pointerup', {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: pressX,
      clientY: pressY
    });

    await expect(page.getByText('프로젝트 편집')).toBeVisible();
    await expect(page.locator('#project-edit-name')).toHaveValue(projectBetaName);

    const storedSelectedScope = await page.evaluate(() => {
      const layout = JSON.parse(window.localStorage.getItem('octop.mobile.workspace.layout.v1') || '{}');
      return layout.selectedScope ?? null;
    });

    expect(storedSelectedScope).toEqual({
      kind: 'project',
      id: projectAlphaId
    });
  });

  test('프로젝트 편집창에서 프로젝트 삭제 버튼을 노출하고 삭제 확인 후 실제 제거한다', async ({ page }) => {
    await mockMobileApi(page);
    await seedMobileSession(page);
    await page.goto(baseUrl);

    const betaChip = page.getByTestId(`project-chip-item-${projectBetaId}`).locator('button');
    await expect(betaChip).toBeVisible();

    const betaBox = await betaChip.boundingBox();
    expect(betaBox).not.toBeNull();

    const pointerId = 31;
    const pressX = betaBox.x + betaBox.width / 2;
    const pressY = betaBox.y + betaBox.height / 2;

    await betaChip.dispatchEvent('pointerdown', {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: pressX,
      clientY: pressY
    });
    await page.waitForTimeout(720);
    await betaChip.dispatchEvent('pointerup', {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: pressX,
      clientY: pressY
    });

    await expect(page.getByText('프로젝트 편집')).toBeVisible();

    const deleteButton = page.getByRole('button', { name: '프로젝트 삭제' });
    await expect(deleteButton).toBeVisible();
    await deleteButton.click();

    const confirmDialog = page.getByTestId('mobile-confirm-dialog');
    await expect(confirmDialog).toBeVisible();
    await expect(confirmDialog).toContainText(`"${projectBetaName}" 프로젝트를 삭제하시겠습니까?`);
    await confirmDialog.getByRole('button', { name: '삭제' }).click();

    await expect(page.getByTestId(`project-chip-item-${projectBetaId}`)).toHaveCount(0);
    await expect(page.getByText('프로젝트 편집')).toHaveCount(0);
  });

  test('프로젝트 칩은 마우스 드래그에서 다른 칩 중심을 넘기면 밀려나기 시작한다', async ({ page }) => {
    await mockMobileApi(page);
    await seedMobileSession(page);
    await page.goto(baseUrl);

    const alphaChip = page.getByTestId(`project-chip-item-${projectAlphaId}`).locator('button');
    const betaChip = page.getByTestId(`project-chip-item-${projectBetaId}`).locator('button');
    const gammaChip = page.getByTestId(`project-chip-item-${projectGammaId}`).locator('button');
    const alphaChipItem = page.getByTestId(`project-chip-item-${projectAlphaId}`);

    await expect(alphaChip).toBeVisible();
    await expect(betaChip).toBeVisible();
    await expect(gammaChip).toBeVisible();

    const alphaBox = await alphaChip.boundingBox();
    const betaBox = await betaChip.boundingBox();

    expect(alphaBox).not.toBeNull();
    expect(betaBox).not.toBeNull();

    const pointerId = 18;
    const pressX = betaBox.x + betaBox.width / 2;
    const pressY = betaBox.y + betaBox.height / 2;
    const betaCenterX = betaBox.x + betaBox.width / 2;
    const alphaTriggerX = alphaBox.x + alphaBox.width / 2;
    const beforeAlphaTriggerClientX = pressX + (alphaTriggerX + 2 - betaCenterX);
    const afterAlphaTriggerClientX = pressX + (alphaTriggerX - 2 - betaCenterX);

    await betaChip.dispatchEvent('pointerdown', {
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      clientX: pressX,
      clientY: pressY
    });
    await page.waitForTimeout(720);

    await betaChip.dispatchEvent('pointermove', {
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      clientX: beforeAlphaTriggerClientX,
      clientY: pressY
    });

    await expect.poll(async () => Math.abs(await readTranslateX(alphaChipItem))).toBeLessThan(1);

    await betaChip.dispatchEvent('pointermove', {
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      clientX: afterAlphaTriggerClientX,
      clientY: pressY
    });

    await expect.poll(async () => await readTranslateX(alphaChipItem)).toBeGreaterThan(8);

    await betaChip.dispatchEvent('pointerup', {
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      clientX: afterAlphaTriggerClientX,
      clientY: pressY
    });
  });

  test('프로젝트 칩은 터치 드래그에서도 다른 칩 중심을 넘기면 밀려나기 시작한다', async ({ page }) => {
    await mockMobileApi(page);
    await seedMobileSession(page);
    await page.goto(baseUrl);

    const alphaChip = page.getByTestId(`project-chip-item-${projectAlphaId}`).locator('button');
    const betaChip = page.getByTestId(`project-chip-item-${projectBetaId}`).locator('button');
    const alphaChipItem = page.getByTestId(`project-chip-item-${projectAlphaId}`);

    await expect(alphaChip).toBeVisible();
    await expect(betaChip).toBeVisible();

    const alphaBox = await alphaChip.boundingBox();
    const betaBox = await betaChip.boundingBox();

    expect(alphaBox).not.toBeNull();
    expect(betaBox).not.toBeNull();

    const pointerId = 26;
    const pressX = betaBox.x + betaBox.width / 2;
    const pressY = betaBox.y + betaBox.height / 2;
    const betaCenterX = betaBox.x + betaBox.width / 2;
    const alphaTriggerX = alphaBox.x + alphaBox.width / 2;
    const beforeAlphaTriggerClientX = pressX + (alphaTriggerX + 2 - betaCenterX);
    const afterAlphaTriggerClientX = pressX + (alphaTriggerX - 2 - betaCenterX);

    await betaChip.dispatchEvent('pointerdown', {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: pressX,
      clientY: pressY
    });
    await page.waitForTimeout(720);

    await betaChip.dispatchEvent('pointermove', {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: beforeAlphaTriggerClientX,
      clientY: pressY
    });

    await expect.poll(async () => Math.abs(await readTranslateX(alphaChipItem))).toBeLessThan(1);

    await betaChip.dispatchEvent('pointermove', {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: afterAlphaTriggerClientX,
      clientY: pressY
    });

    await expect.poll(async () => await readTranslateX(alphaChipItem)).toBeGreaterThan(8);

    await betaChip.dispatchEvent('pointerup', {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: afterAlphaTriggerClientX,
      clientY: pressY
    });
  });

  test('프로젝트 칩은 우측 이동 시 다음 칩 중심 전에는 빈 슬롯으로 밀어내지 않는다', async ({ page }) => {
    await mockMobileApi(page);
    await seedMobileSession(page);
    await page.goto(baseUrl);

    const alphaChip = page.getByTestId(`project-chip-item-${projectAlphaId}`).locator('button');
    const betaChip = page.getByTestId(`project-chip-item-${projectBetaId}`).locator('button');
    const alphaChipItem = page.getByTestId(`project-chip-item-${projectAlphaId}`);
    const betaChipItem = page.getByTestId(`project-chip-item-${projectBetaId}`);

    await expect(alphaChip).toBeVisible();
    await expect(betaChip).toBeVisible();

    const alphaBox = await alphaChip.boundingBox();
    const betaBox = await betaChip.boundingBox();

    expect(alphaBox).not.toBeNull();
    expect(betaBox).not.toBeNull();

    const pointerId = 24;
    const pressX = alphaBox.x + alphaBox.width / 2;
    const pressY = alphaBox.y + alphaBox.height / 2;
    const alphaCenterX = alphaBox.x + alphaBox.width / 2;
    const projectGap = Math.max(0, betaBox.x - (alphaBox.x + alphaBox.width));
    const betaTriggerX = betaBox.x - (alphaBox.width + projectGap) + betaBox.width / 2;
    const beforeBetaTriggerClientX = pressX + (betaTriggerX - 2 - alphaCenterX);
    const afterBetaTriggerClientX = pressX + (betaTriggerX + 2 - alphaCenterX);

    await alphaChip.dispatchEvent('pointerdown', {
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      clientX: pressX,
      clientY: pressY
    });
    await page.waitForTimeout(720);

    await alphaChip.dispatchEvent('pointermove', {
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      clientX: beforeBetaTriggerClientX,
      clientY: pressY
    });

    await expect.poll(async () => Math.abs(await readTranslateX(betaChipItem))).toBeLessThan(1);

    await alphaChip.dispatchEvent('pointermove', {
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      clientX: afterBetaTriggerClientX,
      clientY: pressY
    });

    await expect.poll(async () => await readTranslateX(betaChipItem)).toBeLessThan(-8);
    await expect.poll(async () => await readTranslateX(alphaChipItem)).toBe(0);

    await alphaChip.dispatchEvent('pointerup', {
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      clientX: afterBetaTriggerClientX,
      clientY: pressY
    });
  });

  test('프로젝트 칩은 롱터치 중 contextmenu가 발생해도 편집 롱프레스를 유지한다', async ({ page }) => {
    await mockMobileApi(page);
    await seedMobileSession(page);
    await page.goto(baseUrl);

    const betaChip = page.getByTestId(`project-chip-item-${projectBetaId}`).locator('button');

    await expect(betaChip).toBeVisible();

    const betaBox = await betaChip.boundingBox();

    expect(betaBox).not.toBeNull();

    const pointerId = 19;
    const pressX = betaBox.x + betaBox.width / 2;
    const pressY = betaBox.y + betaBox.height / 2;

    await betaChip.dispatchEvent('pointerdown', {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: pressX,
      clientY: pressY
    });
    await page.waitForTimeout(240);
    await betaChip.dispatchEvent('contextmenu', {
      button: 2,
      clientX: pressX,
      clientY: pressY
    });
    await page.waitForTimeout(520);

    const dragFeedback = await betaChip.evaluate((node) => ({
      transform: node.style.transform,
      zIndex: node.style.zIndex,
      position: node.style.position
    }));

    expect(dragFeedback.transform).toContain('scale(1.02)');
    expect(dragFeedback.zIndex).toBe('20');
    expect(dragFeedback.position).toBe('absolute');

    await betaChip.dispatchEvent('pointerup', {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: pressX,
      clientY: pressY
    });

    await expect(page.getByText('프로젝트 편집')).toBeVisible();
  });

  test('프로젝트 칩은 드래그 중 원래 레이아웃 슬롯을 비우고 형제 칩을 밀어낸다', async ({ page }) => {
    await mockMobileApi(page);
    await seedMobileSession(page);
    await page.goto(baseUrl);

    const alphaChip = page.getByTestId(`project-chip-item-${projectAlphaId}`).locator('button');
    const betaChip = page.getByTestId(`project-chip-item-${projectBetaId}`).locator('button');
    const gammaChip = page.getByTestId(`project-chip-item-${projectGammaId}`).locator('button');

    await expect(alphaChip).toBeVisible();
    await expect(betaChip).toBeVisible();
    await expect(gammaChip).toBeVisible();

    const alphaBox = await alphaChip.boundingBox();
    const betaBox = await betaChip.boundingBox();
    const gammaBox = await gammaChip.boundingBox();

    expect(alphaBox).not.toBeNull();
    expect(betaBox).not.toBeNull();
    expect(gammaBox).not.toBeNull();

    const pointerId = 23;
    const pressX = betaBox.x + betaBox.width - 6;
    const pressY = betaBox.y + betaBox.height / 2;
    const desiredDraggedCenterX = alphaBox.x + alphaBox.width / 2 - 4;
    const currentDraggedCenterX = betaBox.x + betaBox.width / 2;
    const releaseX = pressX + (desiredDraggedCenterX - currentDraggedCenterX);

    await betaChip.dispatchEvent('pointerdown', {
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      clientX: pressX,
      clientY: pressY
    });
    await page.waitForTimeout(720);

    await betaChip.dispatchEvent('pointermove', {
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      clientX: releaseX,
      clientY: pressY
    });

    const dragFeedback = await betaChip.evaluate((node) => ({
      transform: node.style.transform,
      zIndex: node.style.zIndex,
      position: node.style.position
    }));
    const alphaDuringBox = await alphaChip.boundingBox();
    const betaDuringBox = await betaChip.boundingBox();
    const gammaDuringBox = await gammaChip.boundingBox();

    expect(dragFeedback.transform).toContain('scale(1.02)');
    expect(dragFeedback.zIndex).toBe('20');
    expect(dragFeedback.position).toBe('absolute');
    expect(betaDuringBox.x).toBeLessThan(alphaDuringBox.x);
    expect(alphaDuringBox.x).toBeLessThan(gammaDuringBox.x);
    expect(gammaDuringBox.x - alphaDuringBox.x).toBeGreaterThan(24);

    await betaChip.dispatchEvent('pointerup', {
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      clientX: releaseX,
      clientY: pressY
    });

    await expect.poll(async () => {
      return page.evaluate((labels) =>
        Array.from(document.querySelectorAll('button'))
          .map((node) => node.textContent?.trim())
          .filter((text) => labels.includes(text))
      , [projectAlphaName, projectBetaName, projectGammaName]);
    }).toEqual([projectBetaName, projectAlphaName, projectGammaName]);

    const storedOrder = await page.evaluate(() => {
      const layout = JSON.parse(window.localStorage.getItem('octop.mobile.workspace.layout.v1') || '{}');
      return layout.projectChipOrder ?? [];
    });

    expect(storedOrder).toEqual([projectBetaId, projectAlphaId, projectGammaId]);
  });

  test('쓰레드 리스트는 터치 드래그에서 카드 중심 기준으로 드롭 위치를 계산한다', async ({ page }) => {
    await mockMobileApi(page);
    await seedMobileSession(page);
    await page.goto(baseUrl);

    const firstItem = page.getByTestId('thread-list-item-thread-alpha-1');
    const secondItem = page.getByTestId('thread-list-item-thread-alpha-2');
    const thirdItem = page.getByTestId('thread-list-item-thread-alpha-3');

    await expect(firstItem).toBeVisible();
    await expect(secondItem).toBeVisible();
    await expect(thirdItem).toBeVisible();

    const secondBox = await secondItem.boundingBox();
    const thirdBox = await thirdItem.boundingBox();

    expect(secondBox).not.toBeNull();
    expect(thirdBox).not.toBeNull();

    const pointerId = 21;
    const pressX = thirdBox.x + thirdBox.width / 2;
    const pressY = thirdBox.y + thirdBox.height - 6;
    const desiredDraggedCenterY = secondBox.y + secondBox.height / 2 - 4;
    const currentDraggedCenterY = thirdBox.y + thirdBox.height / 2;
    const releaseY = pressY + (desiredDraggedCenterY - currentDraggedCenterY);

    await thirdItem.dispatchEvent('pointerdown', {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: pressX,
      clientY: pressY
    });
    await page.waitForTimeout(460);
    await thirdItem.dispatchEvent('pointermove', {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: pressX,
      clientY: releaseY
    });
    await thirdItem.dispatchEvent('pointerup', {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: pressX,
      clientY: releaseY
    });

    const threadFrames = await collectThreadItemPositionFrames(page, [
      'thread-alpha-1',
      'thread-alpha-2',
      'thread-alpha-3'
    ]);

    await expect.poll(async () => {
      return page.locator('[data-testid^="thread-list-item-"] .thread-title').evaluateAll((nodes) =>
        nodes.map((node) => node.textContent?.trim()).filter(Boolean)
      );
    }).toEqual(['Alpha First', 'Alpha Third', 'Alpha Second']);

    const storedThreadOrder = await page.evaluate((nextProjectId) => {
      const layout = JSON.parse(window.localStorage.getItem('octop.mobile.workspace.layout.v1') || '{}');
      return layout.threadOrderByProjectId?.[nextProjectId] ?? [];
    }, projectAlphaId);

    expect(storedThreadOrder).toEqual(['thread-alpha-1', 'thread-alpha-3', 'thread-alpha-2']);
    expect(threadFrames[0].map((entry) => entry.title)).toEqual(['Alpha First', 'Alpha Third', 'Alpha Second']);

    const baselineThreadFrame = threadFrames[0];
    threadFrames.slice(1).forEach((frame) => {
      expect(frame.map((entry) => entry.title)).toEqual(['Alpha First', 'Alpha Third', 'Alpha Second']);
      frame.forEach((entry, index) => {
        expect(Math.abs(entry.y - baselineThreadFrame[index].y)).toBeLessThanOrEqual(1);
      });
    });
  });

  test('쓰레드 리스트는 마우스 드래그에서도 카드 중심을 넘기면 같은 포지션으로 반응한다', async ({ page }) => {
    await mockMobileApi(page);
    await seedMobileSession(page);
    await page.goto(baseUrl);

    const secondItem = page.getByTestId('thread-list-item-thread-alpha-2');
    const thirdItem = page.getByTestId('thread-list-item-thread-alpha-3');

    await expect(secondItem).toBeVisible();
    await expect(thirdItem).toBeVisible();

    const secondBox = await secondItem.boundingBox();
    const thirdBox = await thirdItem.boundingBox();

    expect(secondBox).not.toBeNull();
    expect(thirdBox).not.toBeNull();

    const pointerId = 27;
    const pressX = thirdBox.x + thirdBox.width / 2;
    const pressY = thirdBox.y + thirdBox.height / 2;
    const thirdCenterY = thirdBox.y + thirdBox.height / 2;
    const secondTriggerY = secondBox.y + secondBox.height / 2;
    const beforeSecondTriggerClientY = pressY + (secondTriggerY + 2 - thirdCenterY);
    const afterSecondTriggerClientY = pressY + (secondTriggerY - 2 - thirdCenterY);

    await thirdItem.dispatchEvent('pointerdown', {
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      clientX: pressX,
      clientY: pressY
    });
    await page.waitForTimeout(460);

    await thirdItem.dispatchEvent('pointermove', {
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      clientX: pressX,
      clientY: beforeSecondTriggerClientY
    });

    await expect.poll(async () => Math.abs(await readTranslateY(secondItem))).toBeLessThan(1);

    await thirdItem.dispatchEvent('pointermove', {
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      clientX: pressX,
      clientY: afterSecondTriggerClientY
    });

    await expect.poll(async () => await readTranslateY(secondItem)).toBeGreaterThan(8);

    await thirdItem.dispatchEvent('pointerup', {
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      clientX: pressX,
      clientY: afterSecondTriggerClientY
    });
  });

  test('쓰레드 리스트는 하단 이동 시 다음 카드 중심 전에는 빈 슬롯으로 밀어내지 않는다', async ({ page }) => {
    await mockMobileApi(page);
    await seedMobileSession(page);
    await page.goto(baseUrl);

    const firstItem = page.getByTestId('thread-list-item-thread-alpha-1');
    const secondItem = page.getByTestId('thread-list-item-thread-alpha-2');

    await expect(firstItem).toBeVisible();
    await expect(secondItem).toBeVisible();

    const firstBox = await firstItem.boundingBox();
    const secondBox = await secondItem.boundingBox();

    expect(firstBox).not.toBeNull();
    expect(secondBox).not.toBeNull();

    const pointerId = 25;
    const pressX = firstBox.x + firstBox.width / 2;
    const pressY = firstBox.y + firstBox.height / 2;
    const firstCenterY = firstBox.y + firstBox.height / 2;
    const secondTriggerY = secondBox.y - firstBox.height + secondBox.height / 2;
    const beforeSecondTriggerClientY = pressY + (secondTriggerY - 8 - firstCenterY);
    const afterSecondTriggerClientY = pressY + (secondTriggerY + 12 - firstCenterY);

    await firstItem.dispatchEvent('pointerdown', {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: pressX,
      clientY: pressY
    });
    await page.waitForTimeout(460);

    await firstItem.dispatchEvent('pointermove', {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: pressX,
      clientY: beforeSecondTriggerClientY
    });

    await expect.poll(async () => Math.abs(await readTranslateY(secondItem))).toBeLessThan(1);

    await firstItem.dispatchEvent('pointermove', {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: pressX,
      clientY: afterSecondTriggerClientY
    });

    await expect.poll(async () => await readTranslateY(secondItem)).toBeLessThan(-8);

    await firstItem.dispatchEvent('pointerup', {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: pressX,
      clientY: afterSecondTriggerClientY
    });
  });
});
