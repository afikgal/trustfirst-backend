/**
 * notify_flag.ts
 *
 * Sends the flag_triggered notification to connected users who have opted in.
 * This is the only notification type in v1.
 *
 * Call this immediately after inserting a flag_alerts row.
 * Requires an initialised Resend client and a Supabase client injected by the caller.
 *
 * What is sent:
 *   A plain-language alert that a sensitive topic arose in a session and TrustFirst
 *   provided appropriate resources. No clinical content, no test scores,
 *   no conversation text is included.
 *
 * See SCHEMA_CONTRACT.md for the columns this module reads.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function dispatchFlagNotification(
  db:          SupabaseClient,
  resend:      Resend,
  flagAlertId: string
): Promise<void> {
  // Load the flag
  const { data: flag, error: flagErr } = await db
    .from('flag_alerts')
    .select('id, user_id, severity, fired_at')
    .eq('id', flagAlertId)
    .single();

  if (flagErr || !flag) {
    console.error('[notify_flag] Could not load flag alert:', flagAlertId, flagErr);
    return;
  }

  // Load the subject user's name
  const { data: subject } = await db
    .from('profiles')
    .select('display_name')
    .eq('id', flag.user_id)
    .single();

  const subjectName = subject?.display_name ?? 'your contact';

  // Find active connections
  const { data: connections } = await db
    .from('connections')
    .select('connected_user_id')
    .eq('inviting_user_id', flag.user_id)
    .not('accepted_at', 'is', null)
    .is('revoked_at', null);

  if (!connections?.length) {
    await logNotification(db, null, flagAlertId, 'suppressed', 'No active connections');
    return;
  }

  // Send to each opted-in connected user
  for (const { connected_user_id } of connections) {
    await sendToRecipient(db, resend, connected_user_id, subjectName, flagAlertId);
  }

  // Mark alert as dispatched
  await db.from('flag_alerts').update({ notification_sent: true }).eq('id', flagAlertId);
}

// ---------------------------------------------------------------------------
// Per-recipient logic
// ---------------------------------------------------------------------------

async function sendToRecipient(
  db:           SupabaseClient,
  resend:       Resend,
  recipientId:  string,
  subjectName:  string,
  flagAlertId:  string
): Promise<void> {
  const { data: recipient } = await db
    .from('profiles')
    .select('display_name, notification_prefs')
    .eq('id', recipientId)
    .single();

  const prefs    = recipient?.notification_prefs ?? {};
  const flagPref = prefs?.flag_triggered;

  if (!flagPref?.enabled || !flagPref?.email) {
    await logNotification(db, recipientId, flagAlertId, 'suppressed', 'Opt-out or no email set');
    return;
  }

  const recipientName = recipient?.display_name ?? 'there';
  const toEmail       = flagPref.email as string;

  try {
    await resend.emails.send({
      from:    'TrustFirst <noreply@yourdomain.com>',   // replace with verified sender
      to:      toEmail,
      subject: `TrustFirst: A sensitive topic came up in ${subjectName}'s session`,
      html:    buildEmailHtml(recipientName, subjectName),
    });
    await logNotification(db, recipientId, flagAlertId, 'sent');
  } catch (err: any) {
    console.error('[notify_flag] Resend error:', err);
    await logNotification(db, recipientId, flagAlertId, 'failed', err?.message ?? 'Unknown error');
  }
}

// ---------------------------------------------------------------------------
// Email template
// ---------------------------------------------------------------------------

function buildEmailHtml(recipientName: string, subjectName: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body{font-family:Georgia,serif;font-size:18px;color:#1a1a1a;max-width:600px;margin:40px auto;padding:0 24px;line-height:1.7}
    .logo{font-size:28px;font-weight:bold;color:#1A4F7A;letter-spacing:2px;padding-bottom:16px;border-bottom:2px solid #1A4F7A;margin-bottom:32px}
    .footer{border-top:1px solid #ccc;margin-top:40px;padding-top:16px;font-size:14px;color:#666}
  </style>
</head>
<body>
  <div class="logo">TRUSTFIRST</div>

  <p>Hi ${recipientName},</p>

  <p>
    During a recent TrustFirst session, ${subjectName} brought up a sensitive topic.
    TrustFirst responded with appropriate support and provided relevant resources,
    including crisis contact information where applicable.
  </p>

  <p>
    We're letting you know because you've chosen to receive these notifications.
    No details about the conversation are included — that information belongs to ${subjectName}.
  </p>

  <p>
    If you're concerned, the best step is to reach out to ${subjectName} directly.
  </p>

  <p>
    If you believe there is an immediate safety concern, call <strong>911</strong>
    or the <strong>988 Suicide &amp; Crisis Lifeline</strong> (call or text 988).
  </p>

  <div class="footer">
    <p>
      You received this because you are connected to ${subjectName} on TrustFirst
      and have enabled flag notifications. Change this in your account settings.
    </p>
    <p>TrustFirst is not a medical service and does not provide emergency response.</p>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Notification log
// ---------------------------------------------------------------------------

async function logNotification(
  db:           SupabaseClient,
  recipientId:  string | null,
  flagAlertId:  string,
  status:       'sent' | 'failed' | 'suppressed',
  errorDetail?: string
): Promise<void> {
  if (!recipientId) {
    // No recipient to log against — just update the flag row
    return;
  }
  await db.from('notifications_log').insert({
    recipient_user_id: recipientId,
    event_type:        'flag_triggered',
    source_id:         flagAlertId,
    status,
    error_detail:      errorDetail ?? null,
  });
}
