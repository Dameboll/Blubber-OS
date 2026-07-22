/**
 * GET /api/system
 *
 * Real machine vitals for the dashboard's System Status panel, read straight
 * from the Node process this local app already runs in — no OS-metrics service,
 * no fabrication. Replaces the old Math.random() CPU/MEM/NET drift.
 *
 *   cpu  — whole-machine CPU busy %, sampled over a short window from
 *          os.cpus() idle-vs-total deltas.
 *   mem  — system memory used %, (totalmem - freemem) / totalmem.
 *   proc — this dashboard process's resident memory as a % of system RAM
 *          (a real, always-moving "our footprint" number in place of NET,
 *          which has no dependency-free per-second reading).
 *
 * Node runtime (os.cpus / process.memoryUsage are unavailable on the edge).
 *
 * Placeholder until connected: before the user's real ~/.claude workspace has
 * ever been connected (see src/server/connected-store.ts — flipped by the
 * onboarding inject flow), this returns hand-picked plausible vitals instead
 * of reading the real machine — a fresh install's laptop isn't the thing
 * being demonstrated on the free-tier raw shell's default screen.
 */

import os from "node:os";
import { NextResponse } from "next/server";
import { isWorkspaceConnected } from "../../../server/connected-store";
import { getDemoSystemStats } from "../../../server/demo-dataset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CpuSnapshot {
  idle: number;
  total: number;
}

function cpuSnapshot(): CpuSnapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const t of Object.values(cpu.times)) total += t;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET() {
  if (!isWorkspaceConnected()) {
    return NextResponse.json(getDemoSystemStats(), { headers: { "Cache-Control": "no-store" } });
  }

  const a = cpuSnapshot();
  await delay(120);
  const b = cpuSnapshot();

  const idleDelta = b.idle - a.idle;
  const totalDelta = b.total - a.total;
  const cpu = totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 100) : 0;

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const mem = totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 100) : 0;

  const rss = process.memoryUsage().rss;
  const proc = totalMem > 0 ? Math.round((rss / totalMem) * 100) : 0;

  return NextResponse.json(
    {
      cpu: Math.min(100, Math.max(0, cpu)),
      mem: Math.min(100, Math.max(0, mem)),
      proc: Math.min(100, Math.max(0, proc)),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
