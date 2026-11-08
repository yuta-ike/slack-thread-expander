import { z } from "zod"

const fileIdSchema = z.string().regex(/^F[A-Z0-9]+$/)
const fileLinkSchema = z.url({ protocol: /^https$/, hostname: /\.slack\.com$/ })
const optionalNameSchema = z.string().trim().min(1).optional().catch(undefined)

const forwardFileSchema = z.object({
  id: fileIdSchema,
  name: z.string().min(1).max(200),
  mimetype: z.string().optional(),
  filetype: z.string().optional(),
  permalink: fileLinkSchema.optional(),
})
export type ForwardFile = z.infer<typeof forwardFileSchema>

const eventFileSchema = z
  .object({
    id: fileIdSchema,
    title: optionalNameSchema,
    name: optionalNameSchema,
    mimetype: z.string().optional(),
    filetype: z.string().optional(),
    permalink: fileLinkSchema.optional().catch(undefined),
  })
  .transform((file) => ({
    id: file.id,
    name: (file.title ?? file.name ?? "添付ファイル").slice(0, 200),
    mimetype: file.mimetype,
    filetype: file.filetype,
    permalink: file.permalink,
  }))

export const eventFilesSchema = z
  .array(eventFileSchema.optional().catch(undefined))
  .default([])
  .transform((files) => files.filter((file) => file !== undefined).slice(0, 10))

export const queuedFilesSchema = z.array(forwardFileSchema).max(10)
