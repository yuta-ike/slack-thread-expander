import type { Block } from "@slack/types"
import { z } from "zod"

const blockSchema = z.looseObject({
  type: z.string().min(1),
  block_id: z.string().max(255).optional(),
}) satisfies z.ZodType<Block>

export const blocksSchema: z.ZodType<Block[]> = z.array(blockSchema).max(50)
