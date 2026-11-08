import z from "zod"
import { BodyTooLargeError, readTextLimited } from "./body"
import { deliver } from "./deliveries"
import {
  forwardJobSchema,
  getForwardJob,
  slackRequestSchema,
  verifySlackSignature,
  type ForwardJob,
} from "./events"
import { SlackApiError } from "./slack-helper"

const TIMESTAMP_HEADER = "X-Slack-Request-Timestamp"
const SIGNATURE_HEADER = "X-Slack-Signature"

const timestampSchema = z.string().regex(/^\d+$/)
const sigunatureSchema = z.string().regex(/^v0=[0-9a-f]{64}$/)

async function handleEvent(request: Request, env: Env): Promise<Response> {
  const { SLACK_SIGNING_SECRET, SLACK_TEAM_ID, SOURCE_CHANNEL_IDS } = env
  if (!SLACK_SIGNING_SECRET || !SLACK_TEAM_ID || SOURCE_CHANNEL_IDS == null) {
    return new Response("Slack is not configured", { status: 503 })
  }

  const path = new URL(request.url).pathname
  if (path === "/health" && request.method === "GET") {
    return Response.json({ ok: true })
  }
  if (path !== "/slack/events") {
    return new Response("Not found", { status: 404 })
  }
  if (request.method !== "POST") {
    return new Response("ok")
  }

  const timestamp = timestampSchema.safeParse(request.headers.get(TIMESTAMP_HEADER))
  if (!timestamp.success) {
    return new Response("Missing timestamp", { status: 400 })
  }

  const signature = sigunatureSchema.safeParse(request.headers.get(SIGNATURE_HEADER))
  if (!signature.success) {
    return new Response("Missing signature", { status: 400 })
  }

  const body = request.body
  if (body === null) {
    return new Response("Request body is missing", { status: 400 })
  }

  const rawBody = await readTextLimited(body, 1024 * 1024)
  const valid = await verifySlackSignature(
    rawBody,
    timestamp.data,
    signature.data,
    SLACK_SIGNING_SECRET,
  )
  if (!valid) {
    return new Response("Unauthorized", { status: 401 })
  }

  const parsed = slackRequestSchema.safeParse(JSON.parse(rawBody))
  if (!parsed.success) {
    return new Response("Invalid payload", { status: 400 })
  }
  if (parsed.data.type === "url_verification") {
    return Response.json({ challenge: parsed.data.challenge })
  } else {
    if (parsed.data.team_id !== SLACK_TEAM_ID) {
      return new Response("Forbidden workspace", { status: 403 })
    }

    const job = getForwardJob(
      parsed.data,
      SOURCE_CHANNEL_IDS.split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    )
    if (job != null) {
      // Acknowledge only after durable enqueue. Failed enqueue yields 503 for Slack retry.
      await env.FORWARD_QUEUE.send(job, { contentType: "json" })
    } else {
      console.error(
        JSON.stringify({ event: "slack_ingress_ignored", eventId: parsed.data.event_id }),
      )
    }

    return new Response("ok")
  }
}

export default {
  async fetch(request: Request, env: Env) {
    try {
      return await handleEvent(request, env)
    } catch (error) {
      if (error instanceof SyntaxError) {
        return new Response("Invalid JSON", { status: 400 })
      }
      if (error instanceof BodyTooLargeError) {
        return new Response("Payload too large", { status: 413 })
      }
      console.error(JSON.stringify({ event: "slack_ingress_failed", error: "internal_error" }))
      return new Response("Temporarily unavailable", { status: 503 })
    }
  },

  async queue(batch: MessageBatch<unknown>, env) {
    for (const message of batch.messages) {
      const job = forwardJobSchema.safeParse(message.body)
      try {
        if (!job.success) {
          throw new Error("invalid_job")
        }
        await deliver(job.data, env)
        message.ack()
      } catch (error) {
        const delaySeconds = Math.min(
          43200,
          Math.ceil(Math.max(1, error instanceof SlackApiError ? error.retryAfter : 60)),
        )
        console.error(
          JSON.stringify({
            event: "forward_failed",
            eventId: job.success ? job.data.eventId : undefined,
            attempt: message.attempts,
            error: error instanceof SlackApiError ? error.message : "internal_error",
            retryAfter: delaySeconds,
          }),
        )
        message.retry({ delaySeconds })
      }
    }
  },

  async scheduled(_controller, env) {
    // Keep completed IDs for 30 days; never remove pending/failed jobs automatically.
    await env.DB.prepare("DELETE FROM deliveries WHERE status = 'sent' AND updated_at < ?")
      .bind(Math.floor(Date.now() / 1000) - 30 * 86400)
      .run()
  },
} satisfies ExportedHandler<Env, ForwardJob>
