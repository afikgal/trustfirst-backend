# SCHEMA_CONTRACT.md
# TrustFirst — Backend Schema Contract
# Version 1.0

This document specifies exactly what tables, columns, and column types the
TrustFirst backend scripts expect to find in Supabase.

The chat UI team owns the Supabase project and is responsible for creating
these tables. The backend scripts (trigger_matcher.ts, test_engine.ts,
action_plan_engine.ts, notify_flag.ts) read and write only what is listed here.

---

## Table: profiles

| Column              | Type      | Notes                                                         |
|---------------------|-----------|---------------------------------------------------------------|
| id                  | uuid      | Primary key. Must match auth.users.id.                        |
| display_name        | text      | Nullable. Used in notification emails.                        |
| notification_prefs  | jsonb     | Shape: `{ flag_triggered: { enabled: boolean, email: string } }` |

**Read by:** notify_flag.ts  
**Written by:** not written by backend scripts — managed by the UI.

---

## Table: sessions

| Column          | Type        | Notes                                                              |
|-----------------|-------------|--------------------------------------------------------------------|
| id              | uuid        | Primary key.                                                       |
| user_id         | uuid        | Foreign key → profiles.id                                         |
| last_active_at  | timestamptz | Updated by test_engine on every state write.                       |
| test_state      | jsonb       | **Null when no test is active.** Shape when active — see below.    |

### test_state shape (while a test is in progress)

```json
{
  "test_id":        "phq9",
  "question_index": 3,
  "answers":        { "q1": 2, "q2": 0, "q3": null },
  "flags_fired":    ["q9"],
  "started_at":     "2025-01-15T10:30:00Z"
}
```

`test_state` is set to `null` by test_engine when a test completes or is abandoned.

**Read by:** test_engine.ts  
**Written by:** test_engine.ts

---

## Table: test_results

| Column           | Type        | Notes                                                         |
|------------------|-------------|---------------------------------------------------------------|
| id               | uuid        | Primary key. Returned after insert.                           |
| user_id          | uuid        | Foreign key → profiles.id                                     |
| session_id       | uuid        | Foreign key → sessions.id (nullable)                          |
| test_id          | text        | Matches YAML meta.id (e.g. "phq9")                            |
| completed_at     | timestamptz | Default: now()                                                |
| band_label       | text        | e.g. "Mild", "Moderate"                                       |
| severity         | text        | One of: low, mild, moderate, high, very_high                  |
| score            | integer     |                                                               |
| max_score        | integer     |                                                               |
| answers          | jsonb       | Raw answers `{ q_id: value }`. Encrypt at rest recommended.   |
| flags_triggered  | jsonb       | Array of `{ question_id, value, severity }`                   |

**Written by:** test_engine.ts  
**Read by:** not read by backend scripts (UI reads this for display).

---

## Table: flag_alerts

| Column             | Type        | Notes                                                     |
|--------------------|-------------|-----------------------------------------------------------|
| id                 | uuid        | Primary key.                                              |
| user_id            | uuid        | Foreign key → profiles.id                                 |
| test_result_id     | uuid        | Foreign key → test_results.id (nullable)                  |
| question_id        | text        | The question that triggered the flag                      |
| severity           | text        | From the YAML flag definition                             |
| fired_at           | timestamptz | Default: now()                                            |
| notification_sent  | boolean     | Default: false. Set to true by notify_flag.ts after send. |

**Written by:** test_engine.ts (insert), notify_flag.ts (update notification_sent)  
**Read by:** notify_flag.ts

---

## Table: connections

| Column             | Type        | Notes                                                                 |
|--------------------|-------------|-----------------------------------------------------------------------|
| inviting_user_id   | uuid        | The user whose data can be shared.                                    |
| connected_user_id  | uuid        | The user receiving access.                                            |
| accepted_at        | timestamptz | Null = pending invitation. Non-null = active.                         |
| revoked_at         | timestamptz | Null = active. Non-null = revoked.                                    |

**Read by:** notify_flag.ts (to find opted-in connected users)  
**Written by:** not written by backend scripts — managed by the UI.

---

## Table: action_plans

| Column         | Type        | Notes                                    |
|----------------|-------------|------------------------------------------|
| id             | uuid        | Primary key. Returned after insert.      |
| user_id        | uuid        | Foreign key → profiles.id                |
| life_event_id  | uuid        | Foreign key → life_events.id (nullable)  |
| plan_file_id   | text        | Matches YAML meta.id (e.g. "retirement") |
| generated_at   | timestamptz | Default: now()                           |
| dismissed      | boolean     | Default: false                           |

**Written by:** action_plan_engine.ts  
**Read by:** action_plan_engine.ts

---

## Table: action_plan_items

| Column       | Type        | Notes                                                           |
|--------------|-------------|-----------------------------------------------------------------|
| id           | uuid        | Primary key.                                                    |
| plan_id      | uuid        | Foreign key → action_plans.id                                   |
| item_key     | text        | Stable key from YAML. Used for re-sync matching.                |
| title        | text        |                                                                 |
| explanation  | text        | Nullable.                                                       |
| priority     | text        | One of: high, medium, low                                       |
| resource_url | text        | Nullable.                                                       |
| completed_at | timestamptz | Null = incomplete. Set by user via UI.                          |
| dismissed    | boolean     | Default: false. Set by user via UI.                             |
| user_note    | text        | Nullable. Free text added by user.                              |
| sort_order   | integer     | Default: 0.                                                     |

**Written by:** action_plan_engine.ts (insert on seed; update on resync)  
**Read by:** action_plan_engine.ts  
**Important:** action_plan_engine.ts never writes completed_at, dismissed, or user_note —
these are exclusively set by the UI. The resync function only updates title, explanation,
resource_url, and sort_order.

---

## Table: notifications_log

| Column             | Type        | Notes                                              |
|--------------------|-------------|----------------------------------------------------|
| id                 | uuid        | Primary key.                                       |
| recipient_user_id  | uuid        | Foreign key → profiles.id                          |
| event_type         | text        | Always "flag_triggered" in v1.                     |
| source_id          | uuid        | The flag_alerts.id that triggered this send.       |
| sent_at            | timestamptz | Default: now()                                     |
| status             | text        | One of: sent, failed, suppressed                   |
| error_detail       | text        | Nullable. Populated when status = failed.          |

**Written by:** notify_flag.ts  
**Read by:** not read by backend scripts — for audit / UI display.

---

## Table: life_events (referenced but not written by backend scripts)

action_plan_engine.ts receives the `life_event_id` UUID as a parameter from the caller.
It does not insert into life_events. The caller (their backend) owns life event detection
and confirmation and passes the resulting UUID when triggering a plan seed.

---

## npm dependencies required

```
npm install js-yaml @supabase/supabase-js resend
npm install -D @types/js-yaml typescript
```

## Environment variables expected by the scripts

```
ANTHROPIC_API_KEY        — used by the calling backend, not directly by these scripts
RESEND_API_KEY           — used by notify_flag.ts via the injected Resend client
SUPABASE_URL             — used by the injected Supabase client
SUPABASE_SERVICE_ROLE_KEY — used by the injected Supabase client (bypasses RLS)
```

All clients are injected by the caller — none of these scripts create their own
database or API connections.
