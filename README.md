# TrustFirst — Backend Engine

AI Life Navigation Coach for aging adults. This repo contains the backend logic scripts that complement the chat UI and Supabase project owned by the frontend team.

## What lives here

```
scripts/
  trigger_matcher.ts      Claude token detection for clinical test suggestions
  test_engine.ts          YAML-driven clinical test session management and scoring
  action_plan_engine.ts   Life event action plan seeding and sync from YAML
  notify_flag.ts          Flag-triggered email notifications via Resend
  SCHEMA_CONTRACT.md      Exact table/column spec for the Supabase team

data/
  tests/                  Clinical test definitions (one YAML per test)
  action_plans/           Action plan definitions (one YAML per life event)
```

## Handoff boundary

The frontend team owns:
- Supabase project (auth, all tables, schema, RLS)
- Chat UI

This repo owns:
- All backend logic modules (TypeScript)
- YAML content definitions (tests + action plans)

See `scripts/SCHEMA_CONTRACT.md` for the exact tables and columns these scripts read and write.

## Setup

```bash
npm install
npm run typecheck
```

## Environment variables

These are consumed by the **calling backend** and passed in as injected clients. No script creates its own connections.

```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
RESEND_API_KEY
ANTHROPIC_API_KEY
```

## Adding a clinical test

1. Copy `data/tests/_template.yaml` to `data/tests/{test_id}.yaml`
2. Fill in all sections — `meta`, `triggers`, `instructions`, `questions`, `scoring`, `result_template`
3. The test is automatically picked up by `trigger_matcher.ts` and `test_engine.ts` on next load

## Adding an action plan

1. Copy any file in `data/action_plans/` as a starting point
2. Save as `data/action_plans/{life_event_id}.yaml`
3. Call `seedActionPlan(db, userId, lifeEventDbId, eventId)` when the life event is confirmed
