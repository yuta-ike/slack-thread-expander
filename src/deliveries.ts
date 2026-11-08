import type { ForwardJob } from "./events"
import { forwardReply } from "./slack"
import { SlackApiError } from "./slack-helper"

const LEASE_SECONDS = 120

export function messageKey(job: ForwardJob) {
  // Deduplicate by the original reply, even if Slack assigns a different event_id.
  return `${job.teamId}:${job.channel}:${job.ts}`
}

export async function deliver(job: ForwardJob, env: Env) {
  if (job.teamId !== env.SLACK_TEAM_ID) {
    throw new Error("workspace_mismatch")
  }
  if (!env.SLACK_BOT_TOKEN) {
    throw new Error("missing_bot_token")
  }
  const key = messageKey(job)
  const lease = crypto.randomUUID()
  const now = Math.floor(Date.now() / 1000)
  // A single SQL statement atomically acquires a lease, including on redelivery.
  const claim = await env.DB.prepare(`
    INSERT INTO deliveries (message_key, status, lease_token, lease_until, updated_at)
    VALUES (?, 'processing', ?, ?, ?)
    ON CONFLICT(message_key) DO UPDATE SET
      lease_token = excluded.lease_token,
      lease_until = excluded.lease_until,
      updated_at = excluded.updated_at
    WHERE deliveries.status = 'processing' AND deliveries.lease_until <= ?
    RETURNING message_key
  `)
    .bind(key, lease, now + LEASE_SECONDS, now, now)
    .first<{ message_key: string }>()

  if (claim == null) {
    const row = await env.DB.prepare("SELECT status FROM deliveries WHERE message_key = ?")
      .bind(key)
      .first<{ status: string }>()
    if (row?.status === "sent") {
      return
    } else {
      throw new SlackApiError("delivery_in_progress", LEASE_SECONDS)
    }
  }

  try {
    const ts = await forwardReply(job, env.SLACK_BOT_TOKEN)
    const saved = await env.DB.prepare(`
      UPDATE deliveries SET status = 'sent', sent_ts = ?, updated_at = ?
      WHERE message_key = ? AND lease_token = ?
    `)
      .bind(ts, Math.floor(Date.now() / 1000), key, lease)
      .run()
    if (saved.meta.changes !== 1) {
      throw new Error("delivery_lease_lost")
    }
  } catch (error) {
    // Release only our lease. Completed rows must never become retryable again.
    await env.DB.prepare(`
      UPDATE deliveries SET lease_until = 0 WHERE message_key = ? AND lease_token = ? AND status = 'processing'
    `)
      .bind(key, lease)
      .run()
    throw error
  }
}
