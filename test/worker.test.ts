import { env } from "cloudflare:workers"
import {
  createMessageBatch,
  createExecutionContext,
  getQueueResult,
  applyD1Migrations,
} from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import worker from "../src/index"
import {
  eventCallbackSchema,
  getForwardJob,
  verifySlackSignature,
  type ForwardJob,
} from "../src/events"
import { deliver, messageKey } from "../src/deliveries"
import { forwardReply, SlackApiError } from "../src/slack"
import { richTextBlock, slackFiles } from "./fixtures"
import migration from "../migrations/0001_deliveries.sql?raw"

const job: ForwardJob = {
  teamId: "T123",
  eventId: "Ev123",
  channel: "C123",
  user: "U123",
  threadTs: "1700000000.000001",
  ts: "1700000001.000002",
  text: "返信です",
  blocks: [],
  files: [],
}
const payload = {
  type: "event_callback",
  team_id: job.teamId,
  event_id: job.eventId,
  event: {
    type: "message",
    channel: job.channel,
    channel_type: "channel",
    user: job.user,
    ts: job.ts,
    thread_ts: job.threadTs,
    text: "返信です",
  },
}

async function signedRequest(body: unknown, timestamp = String(Math.floor(Date.now() / 1000))) {
  const raw = typeof body === "string" ? body : JSON.stringify(body)
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.SLACK_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${raw}`))
  const hex = Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")
  return new Request("https://worker.test/slack/events", {
    method: "POST",
    body: raw,
    headers: {
      "Content-Type": "application/json",
      "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": `v0=${hex}`,
    },
  })
}

function mockSlack(
  postResult: { status?: number; data?: unknown; headers?: Record<string, string> } = {},
  parent: { ts?: string; text?: string } | null = {
    ts: job.threadTs,
    text: "スレッドの先頭メッセージです",
  },
) {
  const posted: Record<string, string>[] = []
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    // oxlint-disable-next-line typescript/no-base-to-string
    const url = String(input)
    if (url.endsWith("/chat.getPermalink")) {
      return Response.json({
        ok: true,
        permalink: "https://example.slack.com/archives/C123/p1700000001000002",
      })
    }
    if (url.endsWith("/conversations.history")) {
      return Response.json({ ok: true, messages: parent ? [parent] : [] })
    }
    if (url.endsWith("/chat.postMessage")) {
      // oxlint-disable-next-line typescript/no-base-to-string
      posted.push(Object.fromEntries(new URLSearchParams(String(init?.body))))
      return Response.json(postResult.data ?? { ok: true, ts: "1700000002.000003" }, {
        status: postResult.status ?? 200,
        headers: postResult.headers,
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  vi.stubGlobal("fetch", fetcher)
  return { fetcher, posted }
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, [
    {
      name: "0001",
      queries: migration
        .split(";")
        .map((query) => query.trim())
        .filter(Boolean),
    },
  ])
  await env.DB.prepare("DELETE FROM deliveries").run()
  // Ensure an unmocked Slack request can never escape these tests.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected outbound request")
    }),
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("Slack ingress", () => {
  it("answers only authenticated URL verification", async () => {
    const request = await signedRequest({ type: "url_verification", challenge: "challenge-value" })
    const response = await worker.fetch(request, env)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ challenge: "challenge-value" })
    const unsigned = new Request("https://worker.test/slack/events", {
      method: "POST",
      body: "{}",
    })
    expect((await worker.fetch(unsigned, env)).status).toBe(400)
  })

  it("rejects stale timestamps and tampered bodies", async () => {
    expect(
      (
        await worker.fetch(
          await signedRequest(payload, String(Math.floor(Date.now() / 1000) - 301)),
          env,
        )
      ).status,
    ).toBe(401)
    const request = await signedRequest(payload)
    const tampered = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: "{}",
    })
    expect((await worker.fetch(tampered, env)).status).toBe(401)
    expect(await verifySlackSignature("{}", "not-a-time", "v0=bad", "secret")).toBe(false)
  })

  it("durably queues replies before acknowledging", async () => {
    const send = vi
      .spyOn(env.FORWARD_QUEUE, "send")
      .mockResolvedValue({ metadata: { metrics: { backlogCount: 1, backlogBytes: 100 } } })
    expect((await worker.fetch(await signedRequest(payload), env)).status).toBe(200)
    expect(send).toHaveBeenCalledWith(job, { contentType: "json" })
  })

  it("posts the reply preview from signed ingress through the queue", async () => {
    const send = vi
      .spyOn(env.FORWARD_QUEUE, "send")
      .mockResolvedValue({ metadata: { metrics: { backlogCount: 1, backlogBytes: 100 } } })
    const { posted } = mockSlack()
    const blocks = [richTextBlock]
    const request = await signedRequest({ ...payload, event: { ...payload.event, blocks } })
    expect((await worker.fetch(request, env)).status).toBe(200)
    const body: unknown = JSON.parse(JSON.stringify(send.mock.calls[0]?.[0]))
    expect(body).toMatchObject({ blocks })
    const batch = createMessageBatch("thread-expander", [
      { id: "block-message", timestamp: new Date(), body, attempts: 1 },
    ])
    const ctx = createExecutionContext()
    await worker.queue(batch, env)
    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(["block-message"])
    expect(posted[0]).not.toHaveProperty("text")
    const sentBlocks = JSON.parse(posted[0]!.blocks!)
    expect(sentBlocks).toHaveLength(2)
    expect(sentBlocks[0]).toMatchObject({
      type: "context",
      elements: [{ type: "mrkdwn", text: "返信です", verbatim: true }],
    })
    expect(sentBlocks[1]).toMatchObject({ type: "section" })
    expect(sentBlocks).not.toContainEqual(richTextBlock)
    expect(posted[0]).not.toHaveProperty("thread_ts")
  })

  it.each(["C123", "G123"])(
    "keeps the Block Kit layout for image/file-only replies: %s",
    async (channel) => {
      const send = vi
        .spyOn(env.FORWARD_QUEUE, "send")
        .mockResolvedValue({ metadata: { metrics: { backlogCount: 1, backlogBytes: 100 } } })
      const { posted, fetcher } = mockSlack()
      const request = await signedRequest({
        ...payload,
        event: {
          ...payload.event,
          channel,
          channel_type: channel.startsWith("G") ? "group" : "channel",
          text: "",
          subtype: "file_share",
          files: slackFiles,
        },
      })
      expect((await worker.fetch(request, env)).status).toBe(200)
      const body: unknown = JSON.parse(JSON.stringify(send.mock.calls[0]?.[0]))
      const batch = createMessageBatch("thread-expander", [
        { id: "file-message", timestamp: new Date(), body, attempts: 1 },
      ])
      const ctx = createExecutionContext()
      await worker.queue(batch, env)
      expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(["file-message"])
      expect(fetcher).toHaveBeenCalledTimes(3)
      expect(posted).toHaveLength(1)
      expect(posted[0]?.channel).toBe(channel)
      expect(posted[0]).not.toHaveProperty("thread_ts")
      expect(posted[0]).not.toHaveProperty("text")
      expect(JSON.parse(posted[0]!.blocks!)).toMatchObject([
        { type: "context", elements: [{ text: "元のメッセージ" }] },
        {
          type: "section",
          text: {
            text: "スレッドに返信済み: <https://example.slack.com/archives/C123/p1700000001000002|スレッドの先頭メッセージです>",
          },
        },
      ])
      expect(posted[0]).not.toHaveProperty("attachments")
      expect(posted[0]).not.toHaveProperty("metadata")
      await deliver(
        getForwardJob(
          eventCallbackSchema.parse({
            ...payload,
            event: { ...payload.event, channel, files: slackFiles },
          }),
          [channel],
        )!,
        env,
      )
      expect(posted).toHaveLength(1)
    },
  )

  it("returns a retryable failure if enqueue fails", async () => {
    vi.spyOn(env.FORWARD_QUEUE, "send").mockRejectedValue(new Error("queue unavailable"))
    expect((await worker.fetch(await signedRequest(payload), env)).status).toBe(503)
  })

  it("rejects a different workspace and ignores filtered channels", async () => {
    const send = vi
      .spyOn(env.FORWARD_QUEUE, "send")
      .mockResolvedValue({ metadata: { metrics: { backlogCount: 1, backlogBytes: 100 } } })
    expect(
      (await worker.fetch(await signedRequest({ ...payload, team_id: "T999" }), env)).status,
    ).toBe(403)
    expect(
      (await worker.fetch(await signedRequest(payload), { ...env, SOURCE_CHANNEL_IDS: "C999" }))
        .status,
    ).toBe(200)
    expect(send).not.toHaveBeenCalled()
  })

  it.each(["", " , ", "C999", "C1234"])(
    "does not enqueue replies outside the configured channels: %j",
    async (sourceChannels) => {
      const send = vi.spyOn(env.FORWARD_QUEUE, "send")
      const response = await worker.fetch(await signedRequest(payload), {
        ...env,
        SOURCE_CHANNEL_IDS: sourceChannels,
      })
      expect(response.status).toBe(200)
      expect(send).not.toHaveBeenCalled()
    },
  )

  it("handles malformed JSON and oversized streamed input", async () => {
    expect((await worker.fetch(await signedRequest("{broken"), env)).status).toBe(400)
    const large = await signedRequest("x".repeat(1024 * 1024 + 1))
    expect((await worker.fetch(large, env)).status).toBe(413)
  })

  it.each([null, [], 42, true])("rejects non-object JSON payloads: %j", async (body) => {
    const send = vi.spyOn(env.FORWARD_QUEUE, "send")
    const response = await worker.fetch(await signedRequest(body), env)
    expect(response.status).toBe(400)
    expect(await response.text()).toBe("Invalid payload")
    expect(send).not.toHaveBeenCalled()
  })

  it.each([
    {},
    { type: "unknown", team_id: job.teamId },
    { type: "url_verification", challenge: 42 },
    { ...payload, event_id: undefined },
    { ...payload, event_id: "" },
    { ...payload, team_id: 42 },
    { ...payload, event: null },
    { ...payload, event: {} },
  ])("rejects malformed event callbacks before queueing: %j", async (body) => {
    const send = vi.spyOn(env.FORWARD_QUEUE, "send")
    const response = await worker.fetch(await signedRequest(body), env)
    expect(response.status).toBe(400)
    expect(await response.text()).toBe("Invalid payload")
    expect(send).not.toHaveBeenCalled()
  })

  it.each([
    { ...payload.event, thread_ts: undefined },
    { ...payload.event, bot_id: "B123" },
    { ...payload.event, bot_profile: { id: "B123" } },
    { ...payload.event, subtype: "bot_message", user: undefined, bot_id: "B123" },
    { ...payload.event, subtype: "thread_broadcast" },
    { ...payload.event, subtype: "reply_broadcast" },
    { ...payload.event, channel: "D123", channel_type: "im" },
    { type: "message", subtype: "message_changed", channel: job.channel },
    { type: "reaction_added", user: job.user, reaction: "thumbsup" },
    { ...payload.event, user: 42 },
    { ...payload.event, files: {} },
  ])("acknowledges events that do not match the reply schema: %j", async (event) => {
    const send = vi.spyOn(env.FORWARD_QUEUE, "send")
    const response = await worker.fetch(await signedRequest({ ...payload, event }), env)
    expect(response.status).toBe(200)
    expect(send).not.toHaveBeenCalled()
  })
})

describe("reply selection", () => {
  it.each([
    { thread_ts: undefined },
    { ts: job.threadTs },
    { bot_id: "B123" },
    { app_id: "A123" },
    { subtype: "bot_message" },
    { bot_profile: { id: "B123" } },
    { subtype: "thread_broadcast" },
    { subtype: "reply_broadcast" },
    { subtype: "message_changed" },
    { subtype: "message_deleted" },
    { subtype: "message_replied" },
    { channel: "D123", channel_type: "im" },
    { hidden: true },
  ])("ignores parent, bot, broadcast, mutation and DM events: %j", (override) => {
    expect(
      getForwardJob(
        eventCallbackSchema.parse({ ...payload, event: { ...payload.event, ...override } }),
        [job.channel],
      ),
    ).toBeNull()
  })

  it("accepts private-channel and file-only replies", () => {
    const result = getForwardJob(
      eventCallbackSchema.parse({
        ...payload,
        event: {
          ...payload.event,
          channel: "G123",
          channel_type: "group",
          subtype: "file_share",
          text: "",
          files: [{ id: "FPDF123", title: "report.pdf" }],
        },
      }),
      ["C999", "G123"],
    )
    expect(result).toMatchObject({
      channel: "G123",
      blocks: [],
      files: [{ id: "FPDF123", name: "report.pdf" }],
    })
  })
})

describe("delivery with real D1", () => {
  it("posts to the channel root and deduplicates redelivery and new event IDs", async () => {
    const { posted, fetcher } = mockSlack()
    await deliver(job, env)
    await deliver({ ...job, eventId: "EvOther" }, env)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({ channel: "C123" })
    expect(JSON.parse(posted[0]!.blocks!)[0].elements[0].text).toBe("返信です")
    expect(posted[0]).not.toHaveProperty("thread_ts")
    expect(await env.DB.prepare("SELECT status, sent_ts FROM deliveries").first()).toMatchObject({
      status: "sent",
      sent_ts: "1700000002.000003",
    })
  })

  it("posts private-channel replies back to the same private channel", async () => {
    const { posted } = mockSlack()
    await deliver({ ...job, channel: "G123" }, env)
    expect(posted[0]?.channel).toBe("G123")
    expect(posted[0]).not.toHaveProperty("thread_ts")
  })

  it("prevents concurrent delivery of the same reply", async () => {
    const { posted } = mockSlack()
    const results = await Promise.allSettled([deliver(job, env), deliver(job, env)])
    expect(results.some((result) => result.status === "fulfilled")).toBe(true)
    expect(posted).toHaveLength(1)
  })

  it("recovers an abandoned lease", async () => {
    await env.DB.prepare("INSERT INTO deliveries VALUES (?, 'processing', 'old-lease', 1, NULL, 1)")
      .bind(messageKey(job))
      .run()
    const { posted } = mockSlack()
    await deliver(job, env)
    expect(posted).toHaveLength(1)
  })

  it("retries on HTTP-200 Slack errors without losing the reply", async () => {
    mockSlack({ data: { ok: false, error: "internal_error" } })
    await expect(deliver(job, env)).rejects.toBeInstanceOf(SlackApiError)
    expect(
      await env.DB.prepare("SELECT status, lease_until FROM deliveries").first(),
    ).toMatchObject({ status: "processing", lease_until: 0 })
    const { posted } = mockSlack()
    await deliver(job, env)
    expect(posted).toHaveLength(1)
  })

  it("honors Retry-After in the queue consumer", async () => {
    mockSlack({ status: 429, headers: { "Retry-After": "123" } })
    const batch = createMessageBatch("thread-expander", [
      { id: "message-1", timestamp: new Date(), body: job, attempts: 1 },
    ])
    const retry = vi.spyOn(batch.messages[0]!, "retry")
    const ctx = createExecutionContext()
    await worker.queue(batch as MessageBatch<ForwardJob>, env)
    const result = await getQueueResult(batch, ctx)
    expect(result.explicitAcks).toEqual([])
    expect(result.retryMessages).toEqual([{ msgId: "message-1" }])
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 123 })
  })

  it("acknowledges successful queue deliveries", async () => {
    mockSlack()
    const batch = createMessageBatch("thread-expander", [
      { id: "message-1", timestamp: new Date(), body: job, attempts: 1 },
    ])
    const ctx = createExecutionContext()
    await worker.queue(batch as MessageBatch<ForwardJob>, env)
    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(["message-1"])
  })

  it.each([null, { ...job, files: [42] }])("retries malformed queue jobs: %j", async (body) => {
    const { fetcher } = mockSlack()
    const batch = createMessageBatch("thread-expander", [
      { id: "invalid-job", timestamp: new Date(), body, attempts: 1 },
    ])
    const ctx = createExecutionContext()
    await worker.queue(batch, env)
    const result = await getQueueResult(batch, ctx)
    expect(result.explicitAcks).toEqual([])
    expect(result.retryMessages).toEqual([{ msgId: "invalid-job" }])
    expect(fetcher).not.toHaveBeenCalled()
    expect((await env.DB.prepare("SELECT * FROM deliveries").all()).results).toEqual([])
  })

  it("cleans up old completed IDs while keeping pending deliveries", async () => {
    await env.DB.prepare(
      "INSERT INTO deliveries VALUES ('old', 'sent', 'x', 0, '1.0', 1), ('pending', 'processing', 'y', 0, NULL, 1)",
    ).run()
    await worker.scheduled({ scheduledTime: Date.now(), cron: "0 3 * * *", noRetry() {} }, env)
    expect((await env.DB.prepare("SELECT message_key FROM deliveries").all()).results).toEqual([
      { message_key: "pending" },
    ])
  })
})

it.each([
  ["短い返信", "短い返信"],
  ["123456789012345678901234567890続き", "123456789012345678901234567890"],
  ["あ".repeat(31), "あ".repeat(30)],
  ["😀".repeat(31), "😀".repeat(30)],
  ["先頭\n次の行", "先頭\n次の行"],
  ["*装飾* _本文_", "*装飾* _本文_"],
  ["記号|を含む本文", "記号｜を含む本文"],
  ["&lt;本文&gt; &amp; 続き", "&lt;本文&gt; &amp; 続き"],
  ["<https://example.com|リンク>の本文", "リンクの本文"],
  ["<https://example.com>", "https://example.com"],
  ["<@U123> <!channel>", "&lt;@U123&gt; &lt;!channel&gt;"],
  ["x".repeat(100000), "x".repeat(30)],
])(
  "preserves the context and section design with a 30-character reply preview (%#)",
  async (text, preview) => {
    const { posted, fetcher } = mockSlack()
    const normalized = getForwardJob(
      eventCallbackSchema.parse({
        ...payload,
        event: { ...payload.event, text, blocks: [richTextBlock], files: slackFiles },
      }),
      [job.channel],
    )!
    await forwardReply(normalized, "token")
    expect(posted).toHaveLength(1)
    expect(posted[0]).not.toHaveProperty("text")
    expect(posted[0]).not.toHaveProperty("attachments")
    expect(posted[0]).not.toHaveProperty("metadata")
    expect(posted[0]).toMatchObject({
      channel: job.channel,
      unfurl_links: "true",
      unfurl_media: "false",
    })
    expect(JSON.parse(posted[0]!.blocks!)).toEqual([
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: preview, verbatim: true }],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "スレッドに返信済み: <https://example.slack.com/archives/C123/p1700000001000002|スレッドの先頭メッセージです>",
          verbatim: false,
        },
      },
    ])
    expect(fetcher).toHaveBeenCalledTimes(3)
  },
)

it.each([
  ["12345678901234567890続き", "12345678901234567890"],
  ["😀".repeat(21), "😀".repeat(20)],
])("uses the first 20 characters of the thread parent in the link (%#)", async (text, preview) => {
  const { posted, fetcher } = mockSlack({}, { ts: job.threadTs, text })
  await forwardReply(job, "token")
  const blocks = JSON.parse(posted[0]!.blocks!)
  expect(blocks[0].elements[0].text).toBe("返信です")
  expect(blocks[1].text.text).toBe(
    `スレッドに返信済み: <https://example.slack.com/archives/C123/p1700000001000002|${preview}>`,
  )
  const historyCall = fetcher.mock.calls[1]!
  expect(historyCall[0]).toBe("https://slack.com/api/conversations.history")
  // oxlint-disable-next-line typescript/no-base-to-string
  expect(Object.fromEntries(new URLSearchParams(String(historyCall[1]?.body)))).toMatchObject({
    channel: job.channel,
    oldest: job.threadTs,
    latest: job.threadTs,
    inclusive: "true",
    limit: "1",
  })
})

it.each([null, { ts: job.threadTs }, { ts: job.ts, text: "別のメッセージ" }])(
  "uses the existing fallback when the parent text is unavailable: %j",
  async (parent) => {
    const { posted } = mockSlack({}, parent)
    await forwardReply(job, "token")
    const blocks = JSON.parse(posted[0]!.blocks!)
    expect(blocks[0].elements[0].text).toBe("返信です")
    expect(blocks[1].text.text).toBe(
      "スレッドに返信済み: <https://example.slack.com/archives/C123/p1700000001000002|元のメッセージ>",
    )
  },
)
