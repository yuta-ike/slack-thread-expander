import { z } from "zod"
import { blocksSchema } from "./blocks"
import { eventFilesSchema, queuedFilesSchema } from "./files"

const channelSchema = z.string().regex(/^[CG][A-Z0-9]+$/)
const userSchema = z.string().regex(/^[UW][A-Z0-9]+$/)
const timestampSchema = z.string().regex(/^\d+\.\d+$/)

const urlVerificationSchema = z.object({
  type: z.literal("url_verification"),
  challenge: z.string(),
})

const replyEventSchema = z
  .object({
    type: z.literal("message"),
    bot_id: z.literal([null, ""]).optional(),
    bot_profile: z.null().optional(),
    app_id: z.literal([null, ""]).optional(),
    hidden: z.literal(false).optional(),
    subtype: z.enum(["file_share", "me_message"]).optional(),
    channel: channelSchema,
    channel_type: z.enum(["channel", "group"]).optional(),
    user: userSchema,
    ts: timestampSchema,
    thread_ts: timestampSchema,
    text: z.string().default(""),
    blocks: blocksSchema.default([]),
    files: eventFilesSchema,
  })
  .refine((event) => event.ts !== event.thread_ts)
  .refine(
    (event) => event.text.trim().length > 0 || event.blocks.length > 0 || event.files.length > 0,
  )

export const eventCallbackSchema = z.object({
  type: z.literal("event_callback"),
  event_id: z.string().min(1),
  team_id: z.string().min(1),
  event: z.looseObject({ type: z.string().min(1) }),
})

type EventCallback = z.infer<typeof eventCallbackSchema>

export const slackRequestSchema = z.discriminatedUnion("type", [
  urlVerificationSchema,
  eventCallbackSchema,
])

export const forwardJobSchema = z
  .object({
    eventId: z.string(),
    teamId: z.string(),
    channel: channelSchema,
    threadTs: timestampSchema,
    ts: timestampSchema,
    user: userSchema,
    text: z.string().default(""),
    blocks: blocksSchema.default([]),
    files: queuedFilesSchema,
  })
  .refine((job) => job.ts !== job.threadTs)
  .refine((job) => job.text.trim().length > 0 || job.blocks.length > 0 || job.files.length > 0)

export type ForwardJob = z.infer<typeof forwardJobSchema>

export function getForwardJob(
  payload: EventCallback,
  sourceChannelIds: string[],
): ForwardJob | null {
  const parsed = replyEventSchema.safeParse(payload.event)
  if (!parsed.success) {
    return null
  }

  const event = parsed.data
  if (!sourceChannelIds.includes(event.channel)) {
    return null
  }

  return {
    eventId: payload.event_id,
    teamId: payload.team_id,
    channel: event.channel,
    threadTs: event.thread_ts,
    ts: event.ts,
    user: event.user,
    text: event.text,
    files: event.files,
    blocks: event.blocks,
  }
}

export async function verifySlackSignature(
  rawBody: string,
  timestamp: string,
  signature: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  const isRecent = Math.abs(nowSeconds - Number(timestamp)) <= 300
  if (!isRecent) {
    return false
  }

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  )
  const bytes = Uint8Array.from(signature.slice(3).match(/../g)!, (hex) => parseInt(hex, 16))
  return crypto.subtle.verify("HMAC", key, bytes, encoder.encode(`v0:${timestamp}:${rawBody}`))
}
