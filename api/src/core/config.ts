import { z } from 'zod'

const onaraConfigSchema = z
  .object({
    version: z.literal(1),
    policies: z.array(z.unknown()).min(1),
  })
  .strict()

export type OnaraConfig = z.infer<typeof onaraConfigSchema>

export function parseOnaraConfig(input: unknown): OnaraConfig {
  const parsed = onaraConfigSchema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.length ? `${issue.path.join('.')}: ` : ''
    throw new Error(
      `Invalid Onara configuration: ${path}${issue?.message ?? 'unknown error'}`,
    )
  }
  return parsed.data
}

export function parseOnaraConfigText(text: string): OnaraConfig {
  try {
    return parseOnaraConfig(JSON.parse(text))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid Onara configuration JSON: ${error.message}`)
    }
    throw error
  }
}
