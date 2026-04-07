/**
 * trigger_matcher.ts
 *
 * Test activation via Claude token interception.
 *
 * Flow:
 *   1. buildTestAwarenessBlock() injects available tests and their
 *      conversational signals into Claude's system prompt on every request.
 *   2. Claude emits [SUGGEST_TESTS: test_id, test_id] at the end of its
 *      response when it detects a strong signal — one or two tests max.
 *   3. parseClaudeSuggestion() strips the token before display and returns
 *      the matched test objects for the UI suggestion panel.
 *   4. The user selects and confirms a test in the UI. Nothing starts automatically.
 *
 * No keyword scanning. No pre-processing of user messages.
 * Claude owns detection; backend owns interception and routing.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestTrigger {
  testId:           string;
  testName:         string;
  abbreviation:     string;
  estimatedMinutes: number;
  description:      string;   // shown to user in the suggestion panel
  themes:           string[]; // injected into Claude's system prompt
}

export interface TriggerMatch {
  testId:           string;
  testName:         string;
  abbreviation:     string;
  estimatedMinutes: number;
  description:      string;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const TESTS_DIR = path.resolve(__dirname, '../data/tests');
let _cache: TestTrigger[] | null = null;

export function loadAllTriggers(testsDir = TESTS_DIR): TestTrigger[] {
  if (_cache) return _cache;

  const triggers: TestTrigger[] = [];
  const files = fs.readdirSync(testsDir)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(testsDir, file), 'utf8');
      const doc  = yaml.load(raw) as any;
      if (!doc?.meta?.id || !doc?.triggers) continue;

      triggers.push({
        testId:           doc.meta.id,
        testName:         doc.meta.name,
        abbreviation:     doc.meta.abbreviation,
        estimatedMinutes: doc.meta.estimated_minutes ?? 5,
        description:      doc.triggers.description ?? doc.meta.name,
        themes:           doc.triggers.themes ?? [],
      });
    } catch (err) {
      console.warn(`[trigger_matcher] Could not load ${file}:`, err);
    }
  }

  _cache = triggers;
  return triggers;
}

/** Invalidate cache when YAML files change (dev / hot-reload) */
export function invalidateCache(): void { _cache = null; }

// ---------------------------------------------------------------------------
// Token parser — called after every Claude response before display
// ---------------------------------------------------------------------------

const SUGGEST_TOKEN_RE = /\[SUGGEST_TESTS:\s*([^\]]+)\]/i;

/**
 * Checks Claude's response for a [SUGGEST_TESTS: ...] token.
 *
 * Returns null if no token found — response passes through unchanged.
 * Returns { cleaned, matches }:
 *   cleaned  — response text with the token stripped, safe to display
 *   matches  — test objects to surface in the UI suggestion panel
 */
export function parseClaudeSuggestion(
  claudeResponse: string
): { cleaned: string; matches: TriggerMatch[] } | null {
  const m = claudeResponse.match(SUGGEST_TOKEN_RE);
  if (!m) return null;

  const triggers = loadAllTriggers();
  const ids      = m[1].split(',').map(s => s.trim().toLowerCase());

  const matches: TriggerMatch[] = ids
    .map(id => triggers.find(t => t.testId === id))
    .filter((t): t is TestTrigger => !!t)
    .map(t => ({
      testId:           t.testId,
      testName:         t.testName,
      abbreviation:     t.abbreviation,
      estimatedMinutes: t.estimatedMinutes,
      description:      t.description,
    }));

  if (matches.length === 0) return null;

  return {
    cleaned: claudeResponse.replace(SUGGEST_TOKEN_RE, '').trim(),
    matches,
  };
}

// ---------------------------------------------------------------------------
// System prompt block — injected on every request
// ---------------------------------------------------------------------------

/**
 * Returns the test-awareness section to append to Claude's system prompt.
 * Tells Claude which tests exist, what conversational signals to watch for,
 * and the exact token format to emit.
 */
export function buildTestAwarenessBlock(testsDir = TESTS_DIR): string {
  const triggers = loadAllTriggers(testsDir);
  if (triggers.length === 0) return '';

  const lines = [
    'CLINICAL ASSESSMENTS',
    '--------------------',
    'The following validated assessments are available to users.',
    'When the conversation strongly suggests one would help, append',
    '[SUGGEST_TESTS: test_id] at the very end of your response.',
    '',
    'Rules:',
    '  • Suggest at most two tests at once.',
    '  • Only suggest when signals are clear — not on vague mentions.',
    '  • Never name or describe a test in your response text. Emit the token only.',
    '  • Never start a test yourself. The user confirms through the interface.',
    '',
    'Available tests and their signals:',
  ];

  for (const t of triggers) {
    if (t.themes.length === 0) continue;
    lines.push('');
    lines.push(`[${t.testId}]  ${t.testName} (${t.abbreviation})`);
    lines.push('Suggest when: ' + t.themes.join('; '));
  }

  return lines.join('\n');
}
