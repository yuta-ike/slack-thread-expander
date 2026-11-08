import { afterEach, describe, expect, it, vi } from "vitest"
import {
  eventCallbackSchema,
  forwardJobSchema,
  getForwardJob,
  verifySlackSignature,
  type ForwardJob,
} from "../src/events"
import { forwardReply } from "../src/slack"
import { richTextBlock, slackFiles } from "./fixtures"

const job: ForwardJob = {
  eventId: "Ev123",
  teamId: "T123",
  channel: "C123",
  user: "U123",
  ts: "1700000001.000002",
  threadTs: "1700000000.000001",
  text: "返信です",
  blocks: [],
  files: [],
}
const payload = {
  type: "event_callback",
  event_id: job.eventId,
  team_id: job.teamId,
  event: {
    type: "message",
    channel: job.channel,
    user: job.user,
    ts: job.ts,
    thread_ts: job.threadTs,
    text: "返信です",
  },
}
const link = {
  ok: true,
  permalink: "https://example.slack.com/archives/C123/p1700000001000002",
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mockResponses(...responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>(async () => {
    const response = responses.shift()
    if (!response) {
      throw new Error("Unexpected outbound request")
    }
    return response
  })
  vi.stubGlobal("fetch", fetcher)
  return fetcher
}

function selectReply(body: unknown, sourceChannels: string) {
  const parsed = eventCallbackSchema.safeParse(body)
  const channels = sourceChannels
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
  return parsed.success ? getForwardJob(parsed.data, channels) : null
}

describe("event validation", () => {
  it("accepts block-only replies and preserves nested block fields through job validation", () => {
    const blocks = [
      richTextBlock,
      { type: "section", text: { type: "mrkdwn", text: "*装飾*" } },
      {
        type: "future_block",
        block_id: "future-id",
        extra: { nested: ["value", { enabled: true }] },
      },
    ]
    const result = selectReply(
      { ...payload, event: { ...payload.event, text: "", blocks } },
      job.channel,
    )
    expect(result).toMatchObject({ blocks })
    expect(result?.text).toBe("")
    expect(forwardJobSchema.parse(JSON.parse(JSON.stringify(result))).blocks).toEqual(blocks)
  })

  it("accepts text-only queue jobs without blocks", () => {
    expect(forwardJobSchema.parse({ ...job, blocks: undefined }).text).toBe("返信です")
  })

  it("accepts queued jobs from before the text field was added", () => {
    expect(forwardJobSchema.parse({ ...job, text: undefined, blocks: [richTextBlock] }).text).toBe(
      "",
    )
  })

  it.each([
    { blocks: null },
    { blocks: {} },
    { blocks: [null] },
    { blocks: [{}] },
    { blocks: [{ type: 42 }] },
    { blocks: [{ type: "" }] },
    { blocks: [{ type: "rich_text", block_id: 42 }] },
    { blocks: [{ type: "rich_text", block_id: "x".repeat(256) }] },
    { blocks: Array.from({ length: 51 }, () => richTextBlock) },
  ])("rejects invalid block envelopes: %j", ({ blocks }) => {
    expect(selectReply({ ...payload, event: { ...payload.event, blocks } }, job.channel)).toBeNull()
    expect(forwardJobSchema.safeParse({ ...job, blocks }).success).toBe(false)
  })

  it.each(["C123", " C999, C123 ", "G123,C123"])(
    "accepts replies in explicitly configured channels: %s",
    (sourceChannels) => {
      expect(selectReply(payload, sourceChannels)).toEqual(job)
    },
  )

  it.each(["", " , ", "C999", "C1234"])(
    "ignores replies when the channel is not explicitly configured: %j",
    (sourceChannels) => {
      expect(selectReply(payload, sourceChannels)).toBeNull()
    },
  )

  it.each([null, [], {}, { ...payload, event_id: 42 }, { ...payload, event: null }])(
    "ignores malformed event envelopes: %j",
    (body) => {
      expect(selectReply(body, job.channel)).toBeNull()
    },
  )

  it.each([
    { channel: 123 },
    { channel: "C123/other" },
    { user: "B123" },
    { ts: 1700000001 },
    { thread_ts: "not-a-timestamp" },
    { text: " \n\t" },
    { text: null, files: [null, [], "file"] },
    { bot_profile: {} },
    { subtype: null },
  ])("ignores malformed replies: %j", (override) => {
    expect(
      selectReply({ ...payload, event: { ...payload.event, ...override } }, job.channel),
    ).toBeNull()
  })

  it("accepts unknown Slack fields and inactive bot flags", () => {
    expect(
      selectReply(
        {
          ...payload,
          authorizations: [{ team_id: job.teamId }],
          event: { ...payload.event, extra: "ignored", hidden: false, bot_id: null },
        },
        job.channel,
      ),
    ).toEqual(job)
  })

  it("keeps file-only replies and normalizes attachment names", () => {
    expect(
      selectReply(
        {
          ...payload,
          event: {
            ...payload.event,
            text: "",
            files: [
              null,
              [],
              "invalid",
              { id: "F123", title: "report.pdf" },
              { id: "F456", name: "image.png" },
              { id: "F789" },
              {},
            ],
          },
        },
        job.channel,
      ),
    ).toMatchObject({
      blocks: [],
      files: [
        { id: "F123", name: "report.pdf" },
        { id: "F456", name: "image.png" },
        { id: "F789", name: "添付ファイル" },
      ],
    })
  })

  it("retains file IDs and preview metadata through queue serialization without private download URLs", () => {
    const result = selectReply(
      {
        ...payload,
        event: { ...payload.event, text: "", subtype: "file_share", files: slackFiles },
      },
      job.channel,
    )
    const parsed = forwardJobSchema.parse(JSON.parse(JSON.stringify(result)))
    expect(parsed.files).toEqual([
      {
        id: "FIMAGE123",
        name: "写真.png",
        mimetype: "image/png",
        filetype: "png",
        permalink: slackFiles[0]!.permalink,
      },
      {
        id: "FPDF123",
        name: "資料.pdf",
        mimetype: "application/pdf",
        filetype: "pdf",
        permalink: slackFiles[1]!.permalink,
      },
    ])
    expect(parsed.files[0]).not.toHaveProperty("url_private")
  })

  it.each([{ files: ["report.pdf"] }, { files: [{ name: "report.pdf" }] }])(
    "requires file IDs in queue jobs: %j",
    ({ files }) => {
      expect(forwardJobSchema.safeParse({ ...job, files }).success).toBe(false)
    },
  )

  it("drops untrusted file permalinks while preserving file IDs", () => {
    const result = selectReply(
      {
        ...payload,
        event: {
          ...payload.event,
          files: [{ id: "FPDF123", title: "資料.pdf", permalink: "https://other.example/file" }],
        },
      },
      job.channel,
    )
    expect(result?.files[0]).toMatchObject({ id: "FPDF123", name: "資料.pdf" })
    expect(result?.files[0]?.permalink).toBeUndefined()
  })

  it.each([
    { id: 42, name: "file" },
    { id: "invalid", name: "file" },
    { id: "F123", name: 42 },
    { id: "F123", name: "file", mimetype: 42 },
    { id: "F123", name: "file", permalink: "https://other.example/file" },
  ])("rejects malformed file metadata in queue jobs: %j", (file) => {
    expect(forwardJobSchema.safeParse({ ...job, files: [file] }).success).toBe(false)
  })

  it("preserves long text and bounds attachment names and count", () => {
    const longText = "x".repeat(24001)
    const result = selectReply(
      {
        ...payload,
        event: {
          ...payload.event,
          text: longText,
          files: Array.from({ length: 12 }, (_, index) => ({
            id: `F${index}`,
            title: "x".repeat(201),
          })),
        },
      },
      job.channel,
    )
    expect(result?.text).toBe(longText)
    expect(result?.blocks).toEqual([])
    expect(result?.files).toMatchObject(
      Array.from({ length: 10 }, () => ({ name: "x".repeat(200) })),
    )
  })

  it.each([
    { timestamp: "", signature: "" },
    { timestamp: "1700000000", signature: "v0=bad" },
    { timestamp: "1700000000.1", signature: `v0=${"0".repeat(64)}` },
    { timestamp: "1700000301", signature: `v0=${"0".repeat(64)}` },
  ])("rejects invalid signature headers: %j", async ({ timestamp, signature }) => {
    expect(await verifySlackSignature("{}", timestamp, signature, "secret", 1700000000)).toBe(false)
  })
})

describe("Slack response validation", () => {
  it("uses request options supported by the Workers runtime", async () => {
    const responses = [
      Response.json(link),
      Response.json({ ok: true, messages: [] }),
      Response.json({ ok: true, ts: "1700000002.000003" }),
    ]
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      // Exercise the native Request constructor, which rejects redirect: "error" in Workers.
      const request = new Request(input, init)
      expect(request.redirect).toBe("manual")
      const response = responses.shift()
      if (!response) {
        throw new Error("Unexpected outbound request")
      }
      return response
    })
    vi.stubGlobal("fetch", fetcher)
    await expect(forwardReply(job, "token")).resolves.toBe("1700000002.000003")
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it("rejects redirects without following them or forwarding the token", async () => {
    const fetcher = mockResponses(
      new Response(null, { status: 302, headers: { Location: "https://other.example/api" } }),
    )
    await expect(forwardReply(job, "token")).rejects.toMatchObject({ message: "http_302" })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith(
      "https://slack.com/api/chat.getPermalink",
      expect.objectContaining({ redirect: "manual" }),
    )
  })

  it.each([500, 503])("returns HTTP %s errors to the queue without SDK retries", async (status) => {
    const fetcher = mockResponses(new Response("private response body", { status }))
    await expect(forwardReply(job, "token")).rejects.toMatchObject({
      name: "SlackApiError",
      message: `http_${status}`,
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("returns network failures to the queue without SDK retries or private error details", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("private network details"))
    vi.stubGlobal("fetch", fetcher)
    await expect(forwardReply(job, "token")).rejects.toMatchObject({
      name: "SlackApiError",
      message: "request_failed",
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("cancels oversized streamed SDK responses", async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(256 * 1024 + 1))
      },
      cancel,
    })
    const fetcher = mockResponses(new Response(body))
    await expect(forwardReply(job, "token")).rejects.toMatchObject({
      message: "request_failed",
    })
    expect(cancel).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("keeps private response metadata out of SDK logs", async () => {
    const logs = ["debug", "info", "warn", "error"] as const
    const spies = logs.map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
    mockResponses(
      Response.json({
        ...link,
        response_metadata: {
          warnings: ["private warning"],
          messages: ["[ERROR] private message", "[WARN] private message"],
        },
      }),
      Response.json({ ok: true, messages: [] }),
      Response.json({ ok: true, ts: "1700000002.000003" }),
    )
    await expect(forwardReply(job, "token")).resolves.toBe("1700000002.000003")
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled()
    }
  })

  it.each([
    { body: null, code: "invalid_response" },
    { body: [], code: "invalid_response" },
    { body: { ok: "true" }, code: "invalid_permalink" },
    { body: { ok: false, error: "private message content" }, code: "invalid_response" },
  ])("rejects malformed responses without exposing their content: %j", async ({ body, code }) => {
    const fetcher = mockResponses(Response.json(body))
    await expect(forwardReply(job, "token")).rejects.toMatchObject({
      name: "SlackApiError",
      message: code,
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("treats invalid JSON as a retryable Slack API error", async () => {
    mockResponses(new Response("not JSON"))
    await expect(forwardReply(job, "token")).rejects.toMatchObject({
      name: "SlackApiError",
      message: "invalid_response",
    })
  })

  it.each([
    { ok: true },
    { ok: true, permalink: 42 },
    { ok: true, permalink: "not-a-url" },
    { ok: true, permalink: "http://example.slack.com/p1" },
    { ok: true, permalink: "https://slack.com.evil.test/p1" },
  ])("rejects invalid permalinks: %j", async (body) => {
    const fetcher = mockResponses(Response.json(body))
    await expect(forwardReply(job, "token")).rejects.toMatchObject({ message: "invalid_permalink" })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("rejects missing message timestamps", async () => {
    mockResponses(
      Response.json(link),
      Response.json({ ok: true, messages: [] }),
      Response.json({ ok: true }),
    )
    await expect(forwardReply(job, "token")).rejects.toMatchObject({
      message: "missing_message_ts",
    })
  })

  it.each(["invalid", "0", "-1", "Infinity"])(
    "defaults invalid Retry-After values: %s",
    async (retryAfter) => {
      const fetcher = mockResponses(
        new Response(null, { status: 429, headers: { "Retry-After": retryAfter } }),
      )
      await expect(forwardReply(job, "token")).rejects.toMatchObject({
        message: "rate_limited",
        retryAfter: 60,
      })
      expect(fetcher).toHaveBeenCalledTimes(1)
    },
  )
})

it("retries parent lookup failures before posting", async () => {
  const fetcher = mockResponses(
    Response.json(link),
    Response.json({ ok: false, error: "missing_scope" }),
  )
  await expect(forwardReply(job, "token")).rejects.toMatchObject({ message: "missing_scope" })
  expect(fetcher).toHaveBeenCalledTimes(2)
})
