#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { parseOnaraConfigText } from '../core/config'
import { computePolicyDigest } from '../core/policy-digest'

try {
  const [command, path, ...extra] = process.argv.slice(2)
  if (command !== 'policy-digest' || !path || extra.length) {
    throw new Error('Usage: onara policy-digest <config.json>')
  }
  const config = parseOnaraConfigText(readFileSync(path, 'utf8'))
  console.log(computePolicyDigest(config))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
