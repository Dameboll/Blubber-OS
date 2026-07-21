/**
 * 04-demo-mode.spec.ts — ?demo=1 (src/lib/demo-mode.ts + src/server/
 * demo-dataset.ts): a stranger with zero real Claude Code history still
 * sees a believable, clearly DEMO-badged dashboard instead of empty/real
 * machine state.
 *
 * Verifies against two independently demo-gated real endpoints
 * (GET /api/system, GET /api/recent -- see their own route.ts files) rather
 * than guessing at rendered numbers, so this never depends on what this
 * particular dev machine's real CPU/mem/activity happens to be.
 */

import { test, expect } from 'playwright/test';
import { markIntroSeen, markOnboardingSeen } from './helpers';

test.describe('Demo mode', () => {
  test.beforeEach(async ({ request }) => {
    await markIntroSeen(request);
    await markOnboardingSeen(request);
  });

  test('?demo=1 shows the Demo Mode badge and canned System Status + Activity data', async ({ page }) => {
    await page.goto('/?demo=1');

    await expect(page.getByText('Demo Mode')).toBeVisible();

    // System Status vitals: compare the rendered chip against a fresh call to
    // the same demo-gated endpoint (both driven by the same slow-drifting,
    // deterministic formula in demo-dataset.ts) rather than a real machine
    // reading, which this assertion must never accidentally pass against.
    const stats = (await (await page.request.get('/api/system')).json()) as { cpu: number; mem: number };

    const cpuChip = page.locator('.stat-chip').filter({ has: page.locator('.stat-chip__label', { hasText: 'CPU' }) });
    await expect(cpuChip.locator('.stat-chip__value')).toHaveText(`${stats.cpu}%`);

    const memChip = page.locator('.stat-chip').filter({ has: page.locator('.stat-chip__label', { hasText: 'MEM' }) });
    await expect(memChip.locator('.stat-chip__value')).toHaveText(`${stats.mem}%`);

    // Activity Feed (Agents tab) shows the bundled demo personas (Scout /
    // Patch / Scribe / Herald from public/demo/demo-dataset.json) -- never a
    // real agent/skill name off this machine.
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Agents' }).click();
    await expect(page.getByText(/Agent (Scout|Patch|Scribe|Herald)/).first()).toBeVisible();
  });

  test('?demo=0 turns Demo Mode back off', async ({ page }) => {
    await page.goto('/?demo=1');
    await expect(page.getByText('Demo Mode')).toBeVisible();

    await page.goto('/?demo=0');
    await expect(page.getByText('Demo Mode')).toHaveCount(0);
  });
});
