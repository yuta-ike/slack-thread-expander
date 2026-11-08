import type { RichTextBlock, SectionBlock } from "@slack/types"

export const textBlock = {
  type: "section",
  text: { type: "mrkdwn", text: "返信です", verbatim: true },
} satisfies SectionBlock

export const slackFiles = [
  {
    id: "FIMAGE123",
    title: "写真.png",
    name: "photo.png",
    mimetype: "image/png",
    filetype: "png",
    permalink: "https://example.slack.com/files/U123/FIMAGE123/photo.png",
    url_private: "https://files.slack.com/files-pri/T123-FIMAGE123/photo.png",
  },
  {
    id: "FPDF123",
    title: "資料.pdf",
    mimetype: "application/pdf",
    filetype: "pdf",
    permalink: "https://example.slack.com/files/U123/FPDF123/report.pdf",
  },
]

export const richTextBlock = {
  type: "rich_text",
  block_id: "original-block",
  elements: [
    {
      type: "rich_text_section",
      elements: [
        { type: "text", text: "太字と斜体", style: { bold: true, italic: true } },
        { type: "link", url: "https://example.com", text: "リンク" },
        { type: "user", user_id: "U123" },
        { type: "channel", channel_id: "C123" },
        { type: "emoji", name: "wave", unicode: "1f44b" },
      ],
    },
    {
      type: "rich_text_list",
      style: "ordered",
      indent: 1,
      elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "項目" }] }],
    },
    { type: "rich_text_quote", elements: [{ type: "text", text: "引用" }] },
    { type: "rich_text_preformatted", elements: [{ type: "text", text: "const value = 1\n" }] },
  ],
} satisfies RichTextBlock
