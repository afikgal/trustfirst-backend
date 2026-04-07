/**
 * test_engine.ts
 *
 * Manages the full lifecycle of a clinical test session.
 * Assumes a Supabase client is injected by the caller.
 *
 * The caller (their backend) owns:
 *   - Supabase client creation and auth
 *   - sessions table with a test_state jsonb column
 *   - test_results table
 *   - flag_alerts table
 *
 * This module owns:
 *   - YAML loading and caching
 *   - Question loop state management (reads/writes sessions.test_state)
 *   - Declarative scoring (sum / weighted_sum / subscale_sum)
 *   - Flag evaluation
 *   - All prompt construction for Claude during a test
 *
 * Claude never scores anything. It only receives filled prompts.
 *
 * See SCHEMA_CONTRACT.md for the exact columns this module reads and writes.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Types — mirror the YAML structure
// ---------------------------------------------------------------------------

export interface TestOption {
  label: string;
  value: number;
}

export interface TestQuestion {
  id:      string;
  text:    string;
  note?:   string;
  options: TestOption[];
}

export interface ScoreBand {
  label:          string;
  min:            number;
  max:            number;
  severity:       string;
  interpretation: string;
}

export interface ScoreFlag {
  question_id: string;
  operator:    '>=' | '>' | '==' | '<=' | '<';
  value:       number;
  severity:    string;
  alert:       string;
}

export interface Subscale {
  id:         string;
  name:       string;
  method:     'sum' | 'weighted_sum';
  questions:  string[];
  max_score:  number;
  null_value: 'zero' | 'skip' | 'abort';
  weights?:   Record<string, number>;
  bands:      ScoreBand[];
}

export interface Scoring {
  method:     'sum' | 'weighted_sum' | 'subscale_sum';
  questions?: string[];
  max_score:  number;
  null_value: 'zero' | 'skip' | 'abort';
  weights?:   Record<string, number>;
  subscales?: Subscale[];
  composite?: { method: string; max_score: number; bands: ScoreBand[] };
  bands?:     ScoreBand[];
  flags?:     ScoreFlag[];
}

export interface TestDefinition {
  meta: {
    id:               string;
    name:             string;
    abbreviation:     string;
    estimated_minutes: number;
    source:           string;
    validated_for:    string[];
  };
  triggers: {
    description: string;
    themes:      string[];
  };
  instructions: {
    introduction:     string;
    question_style:   string;
    completion:       string;
    refusal_handling: string;
  };
  questions:       TestQuestion[];
  scoring:         Scoring;
  result_template: { prompt: string };
}

// Stored in sessions.test_state (jsonb)
export interface TestState {
  test_id:        string;
  question_index: number;
  answers:        Record<string, number | null>;
  flags_fired:    string[];
  started_at:     string;
}

export interface ScoredResult {
  score:            number;
  max_score:        number;
  band:             ScoreBand;
  flags_triggered:  Array<{ question_id: string; value: number; severity: string }>;
  subscales?:       Array<{ name: string; score: number; max_score: number; band: ScoreBand }>;
  composite?:       { score: number; max_score: number; band: ScoreBand };
}

// ---------------------------------------------------------------------------
// YAML loader
// ---------------------------------------------------------------------------

const TESTS_DIR = path.resolve(__dirname, '../data/tests');
const _testCache = new Map<string, TestDefinition>();

export function loadTest(testId: string, testsDir = TESTS_DIR): TestDefinition {
  if (_testCache.has(testId)) return _testCache.get(testId)!;

  for (const ext of ['.yaml', '.yml']) {
    const fpath = path.join(testsDir, `${testId}${ext}`);
    if (fs.existsSync(fpath)) {
      const doc = yaml.load(fs.readFileSync(fpath, 'utf8')) as TestDefinition;
      _testCache.set(testId, doc);
      return doc;
    }
  }
  throw new Error(`[test_engine] No YAML found for test: ${testId}`);
}

export function invalidateTestCache(testId?: string): void {
  testId ? _testCache.delete(testId) : _testCache.clear();
}

// ---------------------------------------------------------------------------
// Session state — reads and writes sessions.test_state via injected client
// ---------------------------------------------------------------------------

async function getState(db: SupabaseClient, sessionId: string): Promise<TestState | null> {
  const { data, error } = await db
    .from('sessions')
    .select('test_state')
    .eq('id', sessionId)
    .single();
  if (error) throw error;
  return data?.test_state ?? null;
}

async function setState(
  db: SupabaseClient,
  sessionId: string,
  state: TestState | null
): Promise<void> {
  const { error } = await db
    .from('sessions')
    .update({ test_state: state, last_active_at: new Date().toISOString() })
    .eq('id', sessionId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open a test session. Call when the user confirms a test in the UI.
 * Returns the introduction prompt to send to Claude.
 */
export async function startTest(
  db: SupabaseClient,
  sessionId: string,
  testId: string
): Promise<string> {
  const test = loadTest(testId);

  await setState(db, sessionId, {
    test_id:        testId,
    question_index: 0,
    answers:        {},
    flags_fired:    [],
    started_at:     new Date().toISOString(),
  });

  return buildIntroductionPrompt(test);
}

/**
 * Process one user answer and advance the test.
 * Returns either:
 *   { type: 'next_question' | 'flag_alert',  prompt }
 *   { type: 'result', prompt, scored }   — test is done, state cleared
 */
export async function processAnswer(
  db:          SupabaseClient,
  sessionId:   string,
  userId:      string,
  userMessage: string,
): Promise<
  | { type: 'next_question' | 'flag_alert'; prompt: string }
  | { type: 'result'; prompt: string; scored: ScoredResult }
> {
  const state = await getState(db, sessionId);
  if (!state) throw new Error('[test_engine] No active test state');

  const test     = loadTest(state.test_id);
  const currentQ = test.questions[state.question_index];

  // Map user response → numeric value
  state.answers[currentQ.id] = matchAnswer(userMessage, currentQ.options);

  // Check flags
  const allFired = evaluateFlags(test.scoring.flags ?? [], state.answers);
  const newFlags = allFired.filter(f => !state.flags_fired.includes(f.question_id));
  state.flags_fired.push(...newFlags.map(f => f.question_id));

  state.question_index += 1;
  const done = state.question_index >= test.questions.length;

  if (!done) {
    await setState(db, sessionId, state);

    if (newFlags.length > 0) {
      const flagDef = test.scoring.flags!.find(f => f.question_id === newFlags[0].question_id)!;
      return {
        type:   'flag_alert',
        prompt: buildFlagAlertPrompt(flagDef.alert, test.questions[state.question_index]),
      };
    }

    return {
      type:   'next_question',
      prompt: buildQuestionPrompt(test, test.questions[state.question_index]),
    };
  }

  // ── Complete ──
  const scored = scoreTest(test, state.answers);

  // Clear test state atomically, write result
  await setState(db, sessionId, null);

  const { data: resultRow, error: resultErr } = await db
    .from('test_results')
    .insert({
      user_id:        userId,
      session_id:     sessionId,
      test_id:        state.test_id,
      band_label:     scored.band.label,
      severity:       scored.band.severity,
      score:          scored.score,
      max_score:      scored.max_score,
      answers:        state.answers,   // caller's Supabase handles encryption/RLS
      flags_triggered: scored.flags_triggered,
    })
    .select('id')
    .single();

  if (resultErr) console.error('[test_engine] test_results insert error:', resultErr);

  // Write flag alerts
  for (const f of scored.flags_triggered) {
    await db.from('flag_alerts').insert({
      user_id:       userId,
      test_result_id: resultRow?.id ?? null,
      question_id:   f.question_id,
      severity:      f.severity,
    });
  }

  return {
    type:   'result',
    prompt: buildResultPrompt(test, scored),
    scored,
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export function scoreTest(
  test:    TestDefinition,
  answers: Record<string, number | null>
): ScoredResult {
  const flags_triggered = evaluateFlags(test.scoring.flags ?? [], answers);

  if (test.scoring.method === 'subscale_sum') {
    return scoreSubscales(test.scoring, answers, flags_triggered);
  }

  const { score, effectiveMax } = computeScore(test.scoring, answers);
  const band = findBand(test.scoring.bands!, score);
  return { score, max_score: effectiveMax, band, flags_triggered };
}

function computeScore(
  scoring: Pick<Scoring, 'method' | 'questions' | 'max_score' | 'null_value' | 'weights'>,
  answers: Record<string, number | null>
): { score: number; effectiveMax: number } {
  const ids = scoring.questions ?? Object.keys(answers);
  let score = 0, skipped = 0;

  for (const qid of ids) {
    const raw = answers[qid] ?? null;
    if (raw === null) {
      if (scoring.null_value === 'abort')
        throw new Error(`[test_engine] null answer on ${qid} with null_value=abort`);
      if (scoring.null_value === 'skip') skipped++;
      // zero: add nothing
    } else {
      const w = scoring.method === 'weighted_sum' ? (scoring.weights?.[qid] ?? 1) : 1;
      score += raw * w;
    }
  }

  const effectiveMax = scoring.null_value === 'skip'
    ? Math.round(scoring.max_score * (ids.length - skipped) / ids.length)
    : scoring.max_score;

  return { score, effectiveMax };
}

function scoreSubscales(
  scoring:         Scoring,
  answers:         Record<string, number | null>,
  flags_triggered: ScoredResult['flags_triggered']
): ScoredResult {
  const subscaleResults = (scoring.subscales ?? []).map(sub => {
    const { score, effectiveMax } = computeScore(sub, answers);
    return { name: sub.name, score, max_score: effectiveMax, band: findBand(sub.bands, score) };
  });

  let composite: ScoredResult['composite'];
  if (scoring.composite) {
    const total = subscaleResults.reduce((s, r) => s + r.score, 0);
    composite = { score: total, max_score: scoring.composite.max_score, band: findBand(scoring.composite.bands, total) };
  }

  const primary = composite ?? subscaleResults[0];
  return { score: primary.score, max_score: primary.max_score, band: primary.band, flags_triggered, subscales: subscaleResults, composite };
}

function findBand(bands: ScoreBand[], score: number): ScoreBand {
  const b = bands.find(b => score >= b.min && score <= b.max);
  if (!b) throw new Error(`[test_engine] No band for score ${score}`);
  return b;
}

function evaluateFlags(
  flags:   ScoreFlag[],
  answers: Record<string, number | null>
): Array<{ question_id: string; value: number; severity: string }> {
  return flags.flatMap(f => {
    const a = answers[f.question_id];
    if (a == null) return [];
    return compare(a, f.operator, f.value) ? [{ question_id: f.question_id, value: a, severity: f.severity }] : [];
  });
}

function compare(a: number, op: ScoreFlag['operator'], b: number): boolean {
  return op === '>=' ? a >= b : op === '>' ? a > b : op === '==' ? a === b : op === '<=' ? a <= b : a < b;
}

// ---------------------------------------------------------------------------
// Answer matching — free text → nearest option value
// ---------------------------------------------------------------------------

function matchAnswer(msg: string, options: TestOption[]): number | null {
  const lower = msg.trim().toLowerCase();

  // Exact label
  for (const o of options) if (o.label.toLowerCase() === lower) return o.value;

  // Numeric: by value then by 1-based index
  const n = parseInt(lower, 10);
  if (!isNaN(n)) {
    const byVal = options.find(o => o.value === n);
    if (byVal) return byVal.value;
    if (options[n - 1]) return options[n - 1].value;
  }

  // Partial label
  for (const o of options)
    if (lower.includes(o.label.toLowerCase()) || o.label.toLowerCase().includes(lower))
      return o.value;

  return null;
}

// ---------------------------------------------------------------------------
// Prompt builders — everything Claude receives during a test
// ---------------------------------------------------------------------------

function buildIntroductionPrompt(test: TestDefinition): string {
  return [
    `You are administering the ${test.meta.name} (${test.meta.abbreviation}).`,
    '',
    'Conduct this test according to these rules:',
    test.instructions.question_style,
    '',
    'If the user declines to answer a question:',
    test.instructions.refusal_handling,
    '',
    'Deliver this introduction now:',
    '---',
    test.instructions.introduction,
  ].join('\n');
}

function buildQuestionPrompt(test: TestDefinition, q: TestQuestion): string {
  const opts = q.options.map((o, i) => `  ${i + 1}. ${o.label}`).join('\n');
  return [
    `[TEST: ${test.meta.abbreviation}]`,
    '',
    'Ask this question exactly as written, then present the options:',
    '',
    `Question: ${q.text}`,
    '',
    'Options:',
    opts,
    q.note ? `\nInternal note (do not read aloud): ${q.note}` : '',
  ].join('\n');
}

function buildFlagAlertPrompt(alertText: string, nextQ?: TestQuestion): string {
  return [
    '[FLAG — follow these instructions before continuing]',
    '',
    alertText,
    '',
    nextQ
      ? 'After responding, ask the user if they would like to continue with the assessment.'
      : 'Do not proceed to scoring until the user has responded.',
  ].join('\n');
}

function buildResultPrompt(test: TestDefinition, scored: ScoredResult): string {
  let summary: string;

  if (scored.subscales?.length) {
    const lines = scored.subscales.map(
      s => `${s.name}: ${s.score}/${s.max_score} — ${s.band.label}\n${s.band.interpretation}`
    );
    if (scored.composite)
      lines.push(`Overall: ${scored.composite.score}/${scored.composite.max_score} — ${scored.composite.band.label}\n${scored.composite.band.interpretation}`);
    summary = lines.join('\n\n');
  } else {
    summary = [
      `Score: ${scored.score}/${scored.max_score}`,
      `Band: ${scored.band.label} (${scored.band.severity})`,
      scored.band.interpretation,
    ].join('\n');
  }

  const flags = scored.flags_triggered.length
    ? `\n⚠ FLAGS — address before presenting results:\n${scored.flags_triggered.map(f => `  Q${f.question_id}: answer ${f.value} (${f.severity})`).join('\n')}`
    : '';

  const prompt = test.result_template.prompt
    .replace(/\{\{meta\.name\}\}/g,          test.meta.name)
    .replace(/\{\{meta\.abbreviation\}\}/g,  test.meta.abbreviation)
    .replace(/\{\{score\}\}/g,               String(scored.score))
    .replace(/\{\{scoring\.max_score\}\}/g,  String(scored.max_score))
    .replace(/\{\{band\.label\}\}/g,         scored.band.label)
    .replace(/\{\{band\.severity\}\}/g,      scored.band.severity)
    .replace(/\{\{band\.interpretation\}\}/g, scored.band.interpretation);

  return [prompt, '', '--- Scoring (do not read aloud) ---', summary, flags].join('\n');
}
