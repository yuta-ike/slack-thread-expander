import { type ChatPostMessageArguments } from "@slack/web-api"
import type { ContextBlock, SectionBlock } from "@slack/types"
import { z } from "zod"
import type { ForwardJob } from "./events"
import { getSlackClient, normalizeSlackError, SlackApiError } from "./slack-helper"

function messagePreview(text: string, limit: number) {
  const plainText = text
    .replace(/<[^<>|]+\|([^<>]*)>/g, "$1")
    .replace(/<(https?:\/\/[^<>]+)>/g, "$1")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("\n", " ")
  return Array.from(plainText)
    .slice(0, limit)
    .join("")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "｜")
}

function buildForwardMessage(job: ForwardJob, permalink: string, threadText: string) {
  const preview = messagePreview(job.text, 30)
  const threadPreview = messagePreview(threadText, 20)

  const header: SectionBlock = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `スレッドに返信済み: <${permalink}|${threadPreview || "元のメッセージ"}>`,
      verbatim: false,
    },
  }

  return {
    channel: job.channel,
    unfurl_links: true,
    unfurl_media: false,
    blocks: [
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: preview || "元のメッセージ",
            verbatim: true,
          },
        ],
      } satisfies ContextBlock,
      header,
    ],
  } satisfies ChatPostMessageArguments
}

const permalinkSchema = z.url({ protocol: /^https$/, hostname: /\.slack\.com$/ })

export async function forwardReply(job: ForwardJob, token: string): Promise<string> {
  const client = getSlackClient(token)
  try {
    const link = await client.chat.getPermalink({ channel: job.channel, message_ts: job.ts })
    const permalink = permalinkSchema.safeParse(link.permalink)
    if (!permalink.success) {
      throw new SlackApiError("invalid_permalink")
    }

    const { messages } = await client.conversations.history({
      channel: job.channel,
      oldest: job.threadTs,
      latest: job.threadTs,
      inclusive: true,
      limit: 1,
    })
    const threadText = messages?.find((message) => message.ts === job.threadTs)?.text ?? ""

    const { ts } = await client.chat.postMessage(
      buildForwardMessage(job, permalink.data, threadText),
    )

    if (ts == null || ts === "") {
      throw new SlackApiError("missing_message_ts")
    }
    return ts
  } catch (error) {
    throw normalizeSlackError(error)
  }
}
