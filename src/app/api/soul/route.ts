// GET  /api/soul → { answers: Record<string,string>, completedAt: string | null,
//                     completed: boolean } — the saved Soul Interview answers,
//                    if any, and whether it's ever been completed on this machine.
// POST /api/soul { answers: Record<string,string> } → { ok: true, completedAt,
//                    profileWritten: boolean } — saves (overwrites) the answers
//                    and, if at least one was actually answered, (re)writes
//                    ~/.claude/blubber-profile.md.
//
// Backed by src/server/soul-store.ts's single app_meta row. `answers` is
// validated as a plain object of string -> string with each value capped at
// MAX_ANSWER_LENGTH — anything else is a 400, never silently coerced.
//
// The markdown write is best-effort and reported honestly: a filesystem
// failure there does NOT fail the request (the in-app record already saved
// successfully by that point) — `profileWritten: false` tells the caller the
// truth instead. Zero answers -> zero file write, by design (see
// buildProfileMarkdown below): an entirely-skipped interview leaves no trace
// on disk, only an app_meta row recording that it was offered and skipped.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getSoulAnswers, saveSoulAnswers } from '../../../server/soul-store';
import { SOUL_QUESTIONS } from '../../../lib/soul-questions';

// Touches local SQLite + the filesystem — never statically optimize or edge-bundle.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_ANSWER_LENGTH = 2000;

function profilePath(): string {
  return path.join(os.homedir(), '.claude', 'blubber-profile.md');
}

/** Renders the saved answers as a readable profile doc — one `##` section per
 * ANSWERED question, in the fixed SOUL_QUESTIONS order, using each question's
 * `heading` (not its raw prompt text) as the section title. Skipped questions
 * (absent from `answers`, or present but blank/whitespace-only) are simply
 * omitted — no "not answered" placeholder sections. */
function buildProfileMarkdown(answers: Record<string, string>): string {
  const lines: string[] = [
    '# Blubber Profile',
    '',
    '<!-- Written by Blubber OS from the Soul Interview. Claude Code sessions',
    '     reading this ~/.claude folder can use it for personalization context',
    '     about the person they are working with. Regenerated in full on every',
    "     retake -- this file always reflects the latest answers, it's never a diff. -->",
    '',
  ];
  for (const q of SOUL_QUESTIONS) {
    const answer = answers[q.id]?.trim();
    if (!answer) continue;
    lines.push(`## ${q.heading}`, '', answer, '');
  }
  return lines.join('\n');
}

type AnswersValidation =
  | { ok: true; answers: Record<string, string> }
  | { ok: false; error: string };

/** Object of string -> string only, each value <= MAX_ANSWER_LENGTH. Any
 * other shape (missing, non-object, array, non-string value, oversized
 * value) is rejected with a specific reason, never silently truncated or
 * coerced. */
function validateAnswers(raw: unknown): AnswersValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'answers must be an object of question id -> answer text' };
  }
  const answers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      return { ok: false, error: `answer for "${key}" must be a string` };
    }
    if (value.length > MAX_ANSWER_LENGTH) {
      return { ok: false, error: `answer for "${key}" exceeds ${MAX_ANSWER_LENGTH} characters` };
    }
    answers[key] = value;
  }
  return { ok: true, answers };
}

export async function GET() {
  try {
    const record = getSoulAnswers();
    return NextResponse.json({
      answers: record?.answers ?? {},
      completedAt: record?.completedAt ?? null,
      completed: record !== null,
    });
  } catch (err) {
    console.error('[api/soul] GET failed:', err);
    return NextResponse.json({ error: 'Failed to read soul interview state' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let answers: Record<string, string>;
  try {
    const body = (await request.json()) as { answers?: unknown };
    const validated = validateAnswers(body.answers);
    if (!validated.ok) {
      return NextResponse.json({ ok: false, error: validated.error }, { status: 400 });
    }
    answers = validated.answers;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid request body' }, { status: 400 });
  }

  const completedAt = new Date().toISOString();

  try {
    saveSoulAnswers({ answers, completedAt });
  } catch (err) {
    console.error('[api/soul] failed to save answers:', err);
    return NextResponse.json({ ok: false, error: 'Failed to save answers' }, { status: 500 });
  }

  // Never write the profile file for a fully-skipped interview — only real
  // answers (non-blank after trim) count toward "at least one question answered".
  const hasRealAnswer = Object.values(answers).some((v) => v.trim().length > 0);
  let profileWritten = false;
  if (hasRealAnswer) {
    try {
      const dir = path.join(os.homedir(), '.claude');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(profilePath(), buildProfileMarkdown(answers), 'utf8');
      profileWritten = true;
    } catch (err) {
      console.error('[api/soul] failed to write blubber-profile.md (answers still saved):', err);
    }
  }

  return NextResponse.json({ ok: true, completedAt, profileWritten });
}
