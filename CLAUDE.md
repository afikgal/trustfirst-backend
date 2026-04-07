# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies
npm run typecheck    # Type-check without emitting (tsc --noEmit)
npm run build        # Alias for typecheck
```

No test runner or linter is configured. Type correctness is enforced via `strict: true` TypeScript.

## Environment Variables

Required at runtime (never hardcoded):

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `RESEND_API_KEY` | Email delivery via Resend |
| `ANTHROPIC_API_KEY` | Claude API (injected by caller) |

## Architecture

TrustFirst is a TypeScript backend engine for an AI life-navigation coach targeting aging adults. It is **not a web server** — it's a set of modules that a host application imports and drives. All Supabase and API clients are injected by the caller; nothing self-initializes.

### The Four Modules (`scripts/`)

**`trigger_matcher.ts`** — Test suggestion via Claude token interception
- `buildTestAwarenessBlock()` generates a system prompt section listing available clinical tests and the conversational themes that signal each one.
- Claude appends `[SUGGEST_TESTS: id, id]` to its response when it detects a strong signal.
- `parseClaudeSuggestion()` intercepts the response, strips the token, and returns matched test objects for the UI to surface. Nothing auto-starts; the user confirms.

**`test_engine.ts`** — Clinical test session lifecycle
- `startTest()` creates session state in `sessions.test_state` (JSONB) and returns an introduction prompt for Claude to deliver.
- `processAnswer()` records the answer, runs scoring, checks flags, and returns the next question prompt or a final result prompt.
- All scoring logic is data-driven from YAML (methods: `sum`, `weighted_sum`, `subscale_sum`). Claude only asks questions; the engine does all math.
- On completion, writes to `test_results` and `flag_alerts`; clears session state.

**`action_plan_engine.ts`** — Life-event checklist seeding and sync
- `seedActionPlan()` creates an `action_plans` row and seeds `action_plan_items` from a YAML definition when a life event is confirmed.
- `resyncPlan()` is non-destructive: new items (by `key`) are inserted, existing items have metadata updated, removed items are left intact, and user state (`completed`, `dismissed`, `user_note`) is never touched.
- `buildPlanContextBlock()` generates a system prompt block listing the top 3 pending high-priority items so Claude can reference the user's active checklist.

**`notify_flag.ts`** — Caregiver alert email dispatch
- `dispatchFlagNotification()` is called after a `flag_alerts` row is inserted.
- Queries `connections` for active caregivers, checks each caregiver's `notification_prefs.flag_triggered.enabled`, sends via Resend, logs to `notifications_log`.
- Emails are plain-language and supportive — no clinical scores, no conversation text.

### Content (`data/`)

All clinical test definitions and action plans are YAML files — the engine code is purely mechanical.

- `data/tests/_template.yaml` — Schema template for adding new clinical tests (questions, options, scoring bands, flag thresholds, result prompt template).
- `data/action_plans/*.yaml` — One file per life event (`retirement`, `new_diagnosis`, `care_transition`), each with a list of keyed action items.

### Database Ownership

Defined authoritatively in `SCHEMA_CONTRACT.md`. Key boundary: scripts **own** `sessions`, `test_results`, `flag_alerts`, `action_plans`, `action_plan_items`, `notifications_log`. Scripts **read only** `profiles`, `connections`, `life_events`. The UI owns user-facing state (`completed`, `dismissed`, `user_note` on items).

### Key Design Constraints

- No keyword scanning for test triggers — Claude detects semantically and emits a structured token; the engine intercepts it.
- Test scoring is fully declarative YAML; never hardcode scoring logic in TypeScript.
- `resyncPlan()` must remain non-destructive — never delete items or overwrite user state fields.
- Caregiver notifications must not include clinical data or conversation content.
