#!/usr/bin/env node
/**
 * Annotated listing of the CLI surface.
 *
 * `npm run` with no arguments prints script names against their raw command
 * strings, which for a half-built pipeline reads as a wall of
 * `node scripts/pending.mjs …`. This prints what each script is for and, when it
 * does not exist yet, which milestone it arrives in.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(join(here, 'script-manifest.json'), 'utf8'))

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length))
const nameWidth = Math.max(...manifest.scripts.map((s) => s.name.length)) + 2

const ready = manifest.scripts.filter((s) => s.status === 'implemented')
const pending = manifest.scripts.filter((s) => s.status !== 'implemented')

console.log('\nSentra — pipeline commands\n')

if (ready.length > 0) {
  console.log('  Available:')
  for (const s of ready) {
    console.log(`    npm run ${pad(s.name, nameWidth)}${s.description}`)
  }
  console.log('')
}

if (pending.length > 0) {
  console.log('  Not implemented yet:')
  for (const s of pending) {
    console.log(
      `    npm run ${pad(s.name, nameWidth)}${s.description}  [${s.milestone} · #${s.issue}]`,
    )
  }
  console.log('')
}

console.log('  Development: lint, lint:fix, format, format:check, typecheck\n')
console.log('  Roadmap: https://github.com/AKogut/ai-flaky-test-triage/blob/main/ROADMAP.md\n')
