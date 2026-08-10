#!/usr/bin/env node
/**
 * Placeholder for a script whose milestone has not landed.
 *
 * The alternative is leaving the script out of package.json entirely, which
 * produces `npm ERR! Missing script: "eval"` — accurate, but it tells a reader
 * nothing about whether the script is misspelled, removed, or not written yet.
 * This says which, and where the work is tracked.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(join(here, 'script-manifest.json'), 'utf8'))

const name = process.argv[2]
const entry = manifest.scripts.find((s) => s.name === name)

if (!entry) {
  console.error(`sentra: "${name}" is not in scripts/script-manifest.json.`)
  process.exit(1)
}

const repo = 'https://github.com/AKogut/ai-flaky-test-triage'

console.error(
  [
    ``,
    `  npm run ${entry.name} is not implemented yet.`,
    ``,
    `  ${entry.description}`,
    ``,
    `  Lands in milestone ${entry.milestone}, tracked in ${repo}/issues/${entry.issue}`,
    ``,
    `  What works today: npm run help`,
    ``,
  ].join('\n'),
)

process.exit(1)
