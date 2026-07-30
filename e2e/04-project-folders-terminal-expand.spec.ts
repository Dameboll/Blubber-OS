/**
 * Regression coverage for the first customer-reported post-launch issues:
 * custom repository containers must appear without PowerShell path workarounds
 * and persist through the server-side root registry, while Terminal's window
 * maximize affordance must perform a real expand/restore action.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, expect } from 'playwright/test';
import { skipFirstRun } from './helpers';

function runProjectRootStore(
  dataDir: string,
  action: 'add' | 'read' | 'reset' | 'activity',
  selectedPath?: string,
): {
  ok?: boolean;
  roots?: Array<{ id: string; path: string; custom: boolean }>;
  attribution?: { name: string; key: string } | null;
  rollup?: Record<string, { weeklyEventCount: number }>;
} {
  const script = `
    const path = require('node:path');
    const os = require('node:os');
    const store = require('./src/server/project-roots.ts');
    const action = process.env.BLUBBER_PROJECT_ROOT_ACTION;
    let result;
    if (action === 'add') result = store.addProjectRoot(process.env.BLUBBER_PROJECT_ROOT_PATH);
    if (action === 'read') result = { roots: store.getProjectRoots() };
    if (action === 'reset') {
      store.resetProjectRoots();
      result = { roots: store.getProjectRoots() };
    }
    if (action === 'activity') {
      const db = require('./src/server/db.ts');
      const indexer = require('./src/server/log-indexer.ts');
      const added = store.addProjectRoot(process.env.BLUBBER_PROJECT_ROOT_PATH);
      const projectName = 'shared-repo';
      const projectPath = path.join(process.env.BLUBBER_PROJECT_ROOT_PATH, projectName);
      const slug = path.resolve(projectPath).split(/[\\\\/]/).filter(Boolean)
        .map((part) => part.replace(/[^A-Za-z0-9]/g, '-')).join('-');
      const fakeTranscript = path.join(os.homedir(), '.claude', 'projects', 'prefix-' + slug, 'session.jsonl');
      const attribution = indexer.buildProjectResolver()(fakeTranscript);
      db.getStatsBaseline();
      const ts = new Date(Date.now() + 1000).toISOString();
      const base = {
        ts,
        sessionId: 'session',
        tokensIn: 1,
        tokensOut: 1,
        tokensCacheRead: 0,
        tokensCacheCreation: 0,
        project: projectName,
      };
      db.insertUsageEvent({ ...base, sourceId: 'custom-event', projectKey: attribution.key });
      db.insertUsageEvent({ ...base, sourceId: 'default-event', projectKey: 'HOBBY/' + projectName });
      result = { attribution, rollup: Object.fromEntries(db.getProjectActivityRollup(7)) };
    }
    process.stdout.write(JSON.stringify(result));
  `;
  const probeHome = path.join(dataDir, 'home');
  const result = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BLUBBER_DATA_DIR: dataDir,
      BLUBBER_PROJECT_ROOT_ACTION: action,
      BLUBBER_PROJECT_ROOT_PATH: selectedPath ?? '',
      HOME: probeHome,
      USERPROFILE: probeHome,
      TS_NODE_COMPILER_OPTIONS: JSON.stringify({ module: 'CommonJS', moduleResolution: 'Node' }),
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(`project-root store probe failed (${action}): ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as {
    ok?: boolean;
    roots?: Array<{ id: string; path: string; custom: boolean }>;
    attribution?: { name: string; key: string } | null;
    rollup?: Record<string, { weeklyEventCount: number }>;
  };
}

test.beforeEach(async ({ request }) => {
  await skipFirstRun(request);
});

test('custom project folders survive a process restart and master reset clears them', async ({}, testInfo) => {
  const dataDir = testInfo.outputPath('store-data');
  const selectedPath = testInfo.outputPath('persisted-projects');
  fs.mkdirSync(path.join(selectedPath, 'persisted-repo'), { recursive: true });

  expect(runProjectRootStore(dataDir, 'add', selectedPath).ok).toBe(true);

  // A second Node process opens the same SQLite file from scratch. This is
  // the restart boundary the customer report exposed, not an in-memory reread.
  const afterRestart = runProjectRootStore(dataDir, 'read').roots ?? [];
  expect(
    afterRestart.some(
      (root) =>
        root.custom &&
        path.resolve(root.path).toLowerCase() === path.resolve(selectedPath).toLowerCase(),
    ),
  ).toBe(true);

  const afterReset = runProjectRootStore(dataDir, 'reset').roots ?? [];
  expect(afterReset.some((root) => root.custom)).toBe(false);
});

test('custom project activity uses a root-qualified identity when names collide', async ({}, testInfo) => {
  const dataDir = testInfo.outputPath('activity-data');
  const selectedPath = testInfo.outputPath('activity-projects');
  fs.mkdirSync(path.join(selectedPath, 'shared-repo'), { recursive: true });

  const result = runProjectRootStore(dataDir, 'activity', selectedPath);
  expect(result.attribution?.name).toBe('shared-repo');
  expect(result.attribution?.key).toMatch(/^custom-[a-f0-9]{16}\/shared-repo$/);
  expect(result.rollup?.[result.attribution!.key]?.weeklyEventCount).toBe(1);
  expect(result.rollup?.['HOBBY/shared-repo']?.weeklyEventCount).toBe(1);
  expect(result.rollup?.['shared-repo']).toBeUndefined();
});

test('Project actions remain usable while the initial folder scan is still loading', async ({ page }) => {
  let releaseProjects!: () => void;
  const projectsGate = new Promise<void>((resolve) => {
    releaseProjects = resolve;
  });

  await page.route('**/api/projects', async (route) => {
    await projectsGate;
    await route.continue();
  });

  try {
    await page.goto('/');
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('button', { name: 'Projects', exact: true })
      .click();

    await expect(page.getByText('Scanning your project folders…')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add Folder' })).toBeVisible();
    await page.getByRole('button', { name: 'New Project' }).click();
    await expect(page.getByRole('dialog', { name: 'Create a new project' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).last().click();
  } finally {
    releaseProjects();
  }
});

test('Projects can add a real repository container through the native picker bridge', async ({ page }, testInfo) => {
  const selectedPath = testInfo.outputPath('project-container');
  const fixtureRepo = path.join(selectedPath, 'fixture-repo');
  fs.mkdirSync(fixtureRepo, { recursive: true });

  await page.addInitScript((folderPath) => {
    Object.defineProperty(window, 'blubberNative', {
      configurable: true,
      value: {
        isElectron: true,
        pickFolder: async () => folderPath,
        addProjectRoot: async () => {
          const auth = await fetch('/__ws-auth').then((response) => response.json());
          const response = await fetch('/api/project-roots', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-blubber-token': auth.token,
              'x-blubber-picker-token': 'blubber-e2e-picker',
            },
            body: JSON.stringify({ path: folderPath }),
          });
          return response.json();
        },
      },
    });
  }, selectedPath);

  // Compile the new route before the browser opens its long-lived streams.
  // This mirrors 00-warmup for focused runs of this spec.
  await expect((await page.request.get('/api/project-roots')).status()).toBe(200);
  const authResponse = await page.request.get('/__ws-auth');
  const { token } = (await authResponse.json()) as { token: string };
  const invalidBody = await page.request.fetch('/api/project-roots', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-blubber-token': token,
      'x-blubber-picker-token': 'blubber-e2e-picker',
    },
    data: 'null',
  });
  expect(invalidBody.status()).toBe(400);
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('button', { name: 'Projects', exact: true })
    .click();
  await page.getByRole('button', { name: 'Add Folder' }).click();

  let selected: { id: string; path: string; custom: boolean } | undefined;
  await expect
    .poll(
      async () => {
        const roots = (await (await page.request.get('/api/project-roots')).json()) as {
          roots?: Array<{ id: string; path: string; custom: boolean }>;
        };
        selected = roots.roots?.find(
          (root) => root.custom && path.resolve(root.path).toLowerCase() === path.resolve(selectedPath).toLowerCase(),
        );
        return Boolean(selected);
      },
      { timeout: 90_000 },
    )
    .toBe(true);

  try {
    // The selected root contains fixture-repo/ as a real immediate child.
    // Seeing it proves the picker path reached the persisted server allowlist
    // and the Projects screen refreshed from the real API.
    await page.getByRole('textbox', { name: 'Search projects' }).fill('fixture-repo');
    await expect(page.getByRole('heading', { name: 'Fixture Repo', exact: true })).toBeVisible({ timeout: 90_000 });

    const projects = (await (await page.request.get('/api/projects')).json()) as {
      roots?: Array<{ id?: string; projects?: string[] }>;
    };
    expect(projects.roots?.find((root) => root.id === selected!.id)?.projects).toContain('fixture-repo');
  } finally {
    // Keep the shared disposable E2E profile clean for later specs.
    const cleanup = await page.request.delete(`/api/project-roots?id=${encodeURIComponent(selected!.id)}`, {
      headers: { 'x-blubber-token': token },
    });
    expect(cleanup.ok(), 'custom root cleanup').toBe(true);
  }
});

test('Terminal expand and restore controls reclaim the surrounding dashboard space', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('button', { name: 'Terminal', exact: true })
    .click();

  const terminal = page.locator('.terminal-screen').first();
  const terminalCard = page.locator('.terminal-screen__terminal-card');
  const expand = page.getByRole('button', { name: 'Expand terminal' });
  await expect(expand).toBeVisible({ timeout: 90_000 });
  const collapsedBox = await terminalCard.boundingBox();
  expect(collapsedBox).not.toBeNull();

  await expand.click();
  await expect(terminal).toHaveClass(/terminal-screen--expanded/);
  await expect(page.getByRole('button', { name: 'Restore terminal layout' })).toBeVisible();
  await expect(page.locator('.terminal-screen__sidebar')).toBeHidden();
  const expandedBox = await terminalCard.boundingBox();
  expect(expandedBox).not.toBeNull();
  expect(expandedBox!.width).toBeGreaterThan(collapsedBox!.width + 200);
  expect(expandedBox!.height).toBeGreaterThan(collapsedBox!.height + 100);

  await page.getByRole('button', { name: 'Restore terminal layout' }).click();
  await expect(terminal).not.toHaveClass(/terminal-screen--expanded/);
  await expect(page.locator('.terminal-screen__sidebar')).toBeVisible();
});
