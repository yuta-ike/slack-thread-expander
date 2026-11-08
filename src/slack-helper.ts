import type { SectionBlock } from "@slack/types"
import {
  LogLevel,
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
  WebClient,
  type Logger,
  type WebClientOptions,
} from "@slack/web-api"
import { readTextLimited } from "./body"

export function textToBlocks(text: string): SectionBlock[] {
  const blocks: SectionBlock[] = []
  const characters = Array.from(text)

  for (let i = 0; i < characters.length; i += 1500) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: characters.slice(i, i + 1500).join(""), verbatim: true },
    })
  }

  return blocks
}

// SDK response metadata can contain private content. The queue logs sanitized errors.
const slackLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  setLevel() {},
  getLevel: () => LogLevel.ERROR,
  setName() {},
}

const slackFetch: NonNullable<WebClientOptions["fetch"]> = async (input, init) => {
  // Workers rejects the SDK's redirect: "error". Return redirects as HTTP errors instead.
  const response = await fetch(input, { ...init, redirect: "manual" })
  if (response.status !== 200) {
    await response.body?.cancel()
    const headers = new Headers(response.headers)
    if (response.status === 429) {
      const retryAfter = Number(headers.get("Retry-After"))
      headers.set(
        "Retry-After",
        String(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60),
      )
    }
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
  const body = response.body ? await readTextLimited(response.body, 256 * 1024) : ""
  return new Response(body, {
    headers: response.headers,
  })
}

export class SlackApiError extends Error {
  constructor(
    message: string,
    public readonly retryAfter = 60,
  ) {
    super(message)
    this.name = "SlackApiError"
  }
}

export function normalizeSlackError(error: unknown): SlackApiError {
  if (error instanceof SlackApiError) {
    return error
  }
  if (error instanceof WebAPIRateLimitedError) {
    return new SlackApiError("rate_limited", error.retryAfter)
  }
  if (error instanceof WebAPIHTTPError) {
    return new SlackApiError(`http_${error.statusCode}`)
  }
  if (error instanceof WebAPIPlatformError) {
    // The SDK can put non-JSON response text in error.data.error. Never log it verbatim.
    const code = error.data.error
    return new SlackApiError(
      typeof code === "string" && /^[a-z0-9_]+$/.test(code) ? code : "invalid_response",
    )
  }
  if (error instanceof WebAPIRequestError) {
    return new SlackApiError("request_failed")
  }
  return new SlackApiError("invalid_response")
}

export const getSlackClient = (token: string) => {
  return new WebClient(token, {
    fetch: slackFetch,
    logger: slackLogger,
    timeout: 8000,
    // Queue delivery owns retries, including rate limits and transport failures.
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    allowAbsoluteUrls: false,
  })
}
