/**
 * action_plan_engine.ts
 *
 * Loads action plan definitions from YAML files and seeds the database
 * when a life event is confirmed.
 *
 * The caller (their backend) owns the Supabase client and these tables:
 *   action_plans      (id, user_id, life_event_id, plan_file_id, generated_at, dismissed)
 *   action_plan_items (id, plan_id, item_key, title, explanation, priority,
 *                      resource_url, completed_at, dismissed, user_note, sort_order)
 *
 * This module owns:
 *   - YAML loading and caching (data/action_plans/{event_id}.yaml)
 *   - Seeding items on life event confirmation
 *   - Non-destructive re-sync when YAML is edited
 *   - Building the plan summary block for Claude's system prompt
 *
 * See SCHEMA_CONTRACT.md for full column specifications.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Types — mirror the YAML structure
// ---------------------------------------------------------------------------

export interface ActionPlanItem {
  key:          string;                       // stable identifier — used for re-sync
  title:        string;
  explanation?: string;
  priority:     'high' | 'medium' | 'low';
  resource_url?: string;
  sort_order?:  number;
}

export interface ActionPlanDefinition {
  meta: {
    id:           string;                     // matches life_event_id enum
    title:        string;                     // displayed as plan heading in the UI
    life_event:   string;                     // human label
    description?: string;                     // shown above the checklist
  };
  items: ActionPlanItem[];
}

export interface HydratedPlan {
  planId:       string;
  title:        string;
  description?: string;
  lifeEvent:    string;
  items: Array<{
    id:           string;
    key:          string;
    title:        string;
    explanation?: string;
    priority:     string;
    resource_url?: string;
    completed:    boolean;
    dismissed:    boolean;
    user_note?:   string;
    sort_order:   number;
  }>;
}

// ---------------------------------------------------------------------------
// YAML loader
// ---------------------------------------------------------------------------

const PLANS_DIR = path.resolve(__dirname, '../data/action_plans');
const _cache    = new Map<string, ActionPlanDefinition>();

export function loadPlanDefinition(
  eventId:  string,
  plansDir = PLANS_DIR
): ActionPlanDefinition {
  if (_cache.has(eventId)) return _cache.get(eventId)!;

  for (const ext of ['.yaml', '.yml']) {
    const fpath = path.join(plansDir, `${eventId}${ext}`);
    if (fs.existsSync(fpath)) {
      const doc = yaml.load(fs.readFileSync(fpath, 'utf8')) as ActionPlanDefinition;
      _cache.set(eventId, doc);
      return doc;
    }
  }
  throw new Error(`[action_plan_engine] No YAML for life event: ${eventId}`);
}

export function invalidatePlanCache(eventId?: string): void {
  eventId ? _cache.delete(eventId) : _cache.clear();
}

// ---------------------------------------------------------------------------
// Seed on life event confirmation
// ---------------------------------------------------------------------------

/**
 * Creates one action_plans row and seeds action_plan_items from YAML.
 * Call when a life event is confirmed in the conversation.
 * Returns the hydrated plan ready for display.
 */
export async function seedActionPlan(
  db:            SupabaseClient,
  userId:        string,
  lifeEventDbId: string,    // UUID from life_events table
  eventId:       string     // matches YAML meta.id
): Promise<HydratedPlan> {
  const def = loadPlanDefinition(eventId);

  const { data: plan, error: planErr } = await db
    .from('action_plans')
    .insert({
      user_id:       userId,
      life_event_id: lifeEventDbId,
      plan_file_id:  eventId,
    })
    .select('id')
    .single();

  if (planErr) throw planErr;

  const planId  = plan.id as string;
  const itemRows = def.items.map((item, i) => ({
    plan_id:      planId,
    item_key:     item.key,
    title:        item.title,
    explanation:  item.explanation ?? null,
    priority:     item.priority,
    resource_url: item.resource_url ?? null,
    sort_order:   item.sort_order ?? i,
  }));

  const { error: itemsErr } = await db.from('action_plan_items').insert(itemRows);
  if (itemsErr) throw itemsErr;

  return fetchHydratedPlan(db, planId, def);
}

// ---------------------------------------------------------------------------
// Fetch hydrated plan (for display or context injection)
// ---------------------------------------------------------------------------

export async function getHydratedPlan(
  db:     SupabaseClient,
  planId: string
): Promise<HydratedPlan> {
  const { data: plan, error } = await db
    .from('action_plans')
    .select('plan_file_id')
    .eq('id', planId)
    .single();
  if (error) throw error;

  const def = loadPlanDefinition(plan.plan_file_id);
  return fetchHydratedPlan(db, planId, def);
}

async function fetchHydratedPlan(
  db:     SupabaseClient,
  planId: string,
  def:    ActionPlanDefinition
): Promise<HydratedPlan> {
  const { data: rows, error } = await db
    .from('action_plan_items')
    .select('id, item_key, title, explanation, priority, resource_url, completed_at, dismissed, user_note, sort_order')
    .eq('plan_id', planId)
    .eq('dismissed', false)
    .order('sort_order', { ascending: true });

  if (error) throw error;

  return {
    planId,
    title:       def.meta.title,
    description: def.meta.description,
    lifeEvent:   def.meta.life_event,
    items: (rows ?? []).map(r => ({
      id:          r.id,
      key:         r.item_key,
      title:       r.title,
      explanation: r.explanation,
      priority:    r.priority,
      resource_url: r.resource_url,
      completed:   !!r.completed_at,
      dismissed:   r.dismissed,
      user_note:   r.user_note,
      sort_order:  r.sort_order,
    })),
  };
}

// ---------------------------------------------------------------------------
// Re-sync after YAML edits (non-destructive)
// ---------------------------------------------------------------------------

/**
 * Syncs YAML changes into an existing plan without touching user state.
 *   - New items (by key) → inserted
 *   - Existing items     → title / explanation / resource_url updated
 *   - Removed items      → left in DB (user may have notes)
 *   - completed_at, dismissed, user_note → never touched
 */
export async function resyncPlan(
  db:      SupabaseClient,
  planId:  string,
  eventId: string
): Promise<{ added: number; updated: number }> {
  invalidatePlanCache(eventId);
  const def = loadPlanDefinition(eventId);

  const { data: existing } = await db
    .from('action_plan_items')
    .select('item_key')
    .eq('plan_id', planId);

  const existingKeys = new Set((existing ?? []).map((r: any) => r.item_key as string));
  let added = 0, updated = 0;

  for (const [i, item] of def.items.entries()) {
    if (!existingKeys.has(item.key)) {
      await db.from('action_plan_items').insert({
        plan_id:      planId,
        item_key:     item.key,
        title:        item.title,
        explanation:  item.explanation ?? null,
        priority:     item.priority,
        resource_url: item.resource_url ?? null,
        sort_order:   item.sort_order ?? i,
      });
      added++;
    } else {
      await db.from('action_plan_items')
        .update({
          title:        item.title,
          explanation:  item.explanation ?? null,
          resource_url: item.resource_url ?? null,
          sort_order:   item.sort_order ?? i,
        })
        .eq('plan_id', planId)
        .eq('item_key', item.key);
      updated++;
    }
  }

  return { added, updated };
}

// ---------------------------------------------------------------------------
// Claude system prompt context block
// ---------------------------------------------------------------------------

/**
 * Builds a compact summary of the user's active plans for Claude's system prompt.
 * Only high-priority pending items are listed — Claude uses this to reference
 * the user's to-do list naturally, not to recite the full list.
 */
export function buildPlanContextBlock(plans: HydratedPlan[]): string {
  if (plans.length === 0) return '';

  const lines = ['ACTIVE ACTION PLANS', '-------------------'];

  for (const plan of plans) {
    const pending  = plan.items.filter(i => !i.completed && !i.dismissed);
    const doneCount = plan.items.filter(i => i.completed).length;
    lines.push(`\n${plan.title} — ${doneCount}/${plan.items.length} items completed`);

    const top = pending.filter(i => i.priority === 'high').slice(0, 3);
    if (top.length > 0) {
      lines.push('Top pending items:');
      top.forEach(i => lines.push(`  • ${i.title}`));
    }
  }

  lines.push('\nReference these when relevant. Do not recite the full list unprompted.');
  return lines.join('\n');
}
