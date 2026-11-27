import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import load from '@commitlint/load'
import lint from '@commitlint/lint'
import { RuleConfigSeverity, type LintOptions, type QualifiedRules } from '@commitlint/types'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * The PR title check, run against titles rather than read off the config.
 *
 * #271 failed `PR title convention` on a title Dependabot wrote: 82 characters
 * of subject, nearly all of it a package name, two versions and a group. The
 * config now lets that exact shape off the two length limits and off nothing
 * else, and both halves of that are asserted here. Every bump title Dependabot
 * has written in this repository passes, at any length. Every other title,
 * including one dressed up as a bump, is held to every rule, and so is a bump
 * whose type or scope has left the lists.
 *
 * `@commitlint/load` and `@commitlint/lint` are the modules the CLI is built
 * from, installed with it, and they are given what the CLI gives them
 * (`@commitlint/cli/lib/cli.js`). The last block runs the CLI itself, the way
 * the CI job and the commit-msg hook do, so the two cannot quietly part.
 */

const root = new URL('../..', import.meta.url).pathname

let rules: QualifiedRules
const options: LintOptions = {}

beforeAll(async () => {
  const config = await load({}, { cwd: root })
  rules = config.rules
  options.plugins = config.plugins
  options.defaultIgnores = config.defaultIgnores !== false
  if (config.ignores) options.ignores = config.ignores
  const parserOpts = config.parserPreset?.parserOpts
  if (typeof parserOpts === 'object' && parserOpts !== null) options.parserOpts = parserOpts
})

/** The rules a title fails, sorted, because commitlint's order is the config's. */
async function failures(title: string, ruleSet: QualifiedRules = rules): Promise<string[]> {
  const outcome = await lint(title, ruleSet, options)
  return outcome.errors.map((error) => error.name).sort()
}

const subject = (title: string): string => title.slice(title.indexOf(': ') + 2)

const SUBJECT = 'subject-max-length-except-bumps'
const HEADER = 'header-max-length-except-bumps'

/** The title #271 failed on. Dependabot added `across 1 directory` on a rebase. */
const PR_271 =
  'chore(deps-dev): bump lint-staged from 17.6.0 to 17.6.1 in the dev-tooling group across 1 directory'

const LONG_HUMAN_TITLE =
  'feat(triage): classify on owner and determinism axes, and stop guessing when the diff is empty'

/**
 * Every title Dependabot has written here, once each: the titles of its pull
 * requests (`gh pr list --state all --author app/dependabot`) and the ones it
 * replaced on a rebase, read off each pull request's `renamed` events. #271's
 * final title is the owner's edit and is left out.
 */
const WRITTEN_BY_DEPENDABOT = [
  'chore(deps): bump the otel group across 1 directory with 3 updates', // #274
  'chore(deps): bump the otel group with 3 updates', // #274, before the rebase
  'chore(deps-dev): bump jsdom from 31.0.0 to 31.0.1', // #272
  PR_271,
  'chore(deps-dev): bump lint-staged from 17.6.0 to 17.6.1 in the dev-tooling group', // #271, before the rebase
  'chore(deps-dev): bump fast-check from 4.10.2 to 4.10.3', // #268
  'ci(deps): bump ossf/scorecard-action from 2.5.0 to 2.6.0', // #267
  'ci(deps): bump github/codeql-action/init from 4.39.3 to 4.39.4', // #266
  'ci(deps): bump github/codeql-action/upload-sarif from 4.39.3 to 4.39.4', // #265
  'ci(deps): bump github/codeql-action/analyze from 4.39.3 to 4.39.4', // #264
  'chore(deps-dev): bump @testing-library/user-event from 14.6.10 to 14.6.13', // #242
  'chore(deps): bump simple-git from 4.0.2 to 4.1.0', // #241
  'chore(deps): bump better-sqlite3 from 13.1.1 to 13.2.0 in the taskflow group', // #240
  'chore(deps): bump @opentelemetry/api from 1.9.1 to 1.10.0 in the otel group', // #239
  'chore(deps-dev): bump the testing group across 1 directory with 3 updates', // #238, #216, #203
  'chore(deps-dev): bump the dev-tooling group across 1 directory with 3 updates', // #226
  'chore(deps-dev): bump @testing-library/user-event from 14.6.8 to 14.6.10', // #224
  'chore(deps-dev): bump vite from 8.3.6 to 8.3.8', // #223
  'chore(deps-dev): bump @vitejs/plugin-react from 6.2.1 to 6.3.0', // #222
  'chore(deps): bump better-sqlite3 from 13.0.3 to 13.1.1 in the taskflow group', // #221
  'chore(deps-dev): bump the dev-tooling group with 2 updates', // #220, #214, #126
  'chore(deps-dev): bump @vitejs/plugin-react from 6.1.2 to 6.2.1', // #218
  'chore(deps-dev): bump vite from 8.3.5 to 8.3.6', // #217
  'chore(deps-dev): bump the testing group with 3 updates', // #209, and #238 and #216 before the rebase
  'chore(deps-dev): bump globals from 17.13.0 to 17.14.0 in the dev-tooling group', // #215
  'chore(deps): bump body-parser from 2.3.0 to 2.4.0', // #212
  'chore(deps-dev): bump vite from 8.3.4 to 8.3.5', // #210
  'chore(deps-dev): bump the dev-tooling group across 1 directory with 6 updates', // #204
  'chore(deps-dev): bump @vitejs/plugin-react from 6.0.5 to 6.1.2', // #202
  'chore(deps-dev): bump @vitejs/plugin-react from 6.0.5 to 6.1.0', // #202, before the rebase
  'chore(deps-dev): bump vite from 8.2.1 to 8.2.2', // #201
  'chore(deps-dev): bump the testing group with 2 updates', // #200
  'chore(deps-dev): bump jsdom from 29.1.1 to 30.0.1', // #180
  'chore(deps-dev): bump the dev-tooling group across 1 directory with 5 updates', // #153
  'chore(deps-dev): bump the dev-tooling group with 5 updates', // #153, before the rebase
  'chore(deps-dev): bump @types/node from 22.20.1 to 26.1.2', // #127
  'chore(deps-dev): bump @eslint/js from 9.39.5 to 10.0.1', // #96
  'chore(deps-dev): bump globals from 15.14.0 to 17.9.0', // #95
  'chore(deps-dev): bump typescript-eslint from 8.46.4 to 8.66.0', // #94
  'chore(deps-dev): bump typescript from 5.7.3 to 7.0.2', // #93
  'chore(deps-dev): bump the dev-tooling group across 1 directory with 4 updates', // #92
  'chore(deps-dev): bump the dev-tooling group with 4 updates', // #92, before the rebase
  'ci(deps): bump actions/checkout from 4 to 7', // #89
  'ci(deps): bump actions/setup-node from 4 to 7', // #5
  'ci(deps): bump actions/cache from 4 to 6', // #4
  'ci(deps): bump actions/upload-artifact from 4 to 7', // #3
  'ci(deps): bump actions/github-script from 7 to 9', // #2
  'ci(deps): bump actions/download-artifact from 4 to 8', // #1
]

/**
 * Each shape the matcher accepts, long enough to fail the subject limit if a
 * person had written it, and the first three the header limit too. Of the real
 * titles above, only #271 is past a limit, and its 99-character header was two
 * characters short of the other one.
 */
const LONG_BUMPS = [
  'chore(deps-dev): bump @typescript-eslint/eslint-plugin from 8.46.4 to 8.73.0 in the dev-tooling group across 1 directory',
  'chore(deps): bump @opentelemetry/exporter-trace-otlp-proto from 0.208.0 to 0.209.0 in the otel group across 1 directory',
  'ci(deps): bump github/codeql-action/upload-sarif from 4.39.3 to 4.39.4 in the codeql-action group across 1 directory',
  'chore(deps): bump @opentelemetry/exporter-trace-otlp-proto from 0.208.0 to 0.209.0 in the otel group',
  'chore(deps-dev): bump @typescript-eslint/eslint-plugin-tslint from 8.46.4-alpha.12 to 8.73.0-alpha.3',
  'chore(deps-dev): bump the end-to-end-and-browser-testing group across 2 directories with 12 updates',
  'chore(deps-dev): bump the end-to-end-and-browser-testing-and-coverage group with 12 updates',
  // The Codespace image, which Dependabot updates from /.devcontainer (#292).
  'chore(deps-dev): bump mcr.microsoft.com/devcontainers/javascript-node from 24-bookworm to 24-bookworm in /.devcontainer',
]

describe('a Dependabot bump title', () => {
  it.each(WRITTEN_BY_DEPENDABOT)('passes, as written here: %s', async (title) => {
    expect(await failures(title)).toEqual([])
  })

  it.each(LONG_BUMPS)('passes at any length: %s', async (title) => {
    expect(subject(title).length).toBeGreaterThan(72)
    expect(await failures(title)).toEqual([])
  })

  it('is still held to every rule but length', async () => {
    expect(await failures('chore(deps): bump lint-staged from 17.6.0 to 17.6.1.')).toEqual([
      'subject-full-stop',
    ])
  })

  it('fails when its type or scope leaves the lists, which an ignores entry would not', async () => {
    const without = (name: 'type-enum' | 'scope-enum', kept: string[]): QualifiedRules => ({
      ...rules,
      [name]: [RuleConfigSeverity.Error, 'always', kept],
    })
    expect(await failures(PR_271, without('scope-enum', ['deps']))).toEqual(['scope-enum'])
    expect(await failures(PR_271, without('type-enum', ['ci']))).toEqual(['type-enum'])
  })
})

describe('every other title', () => {
  it('fails on its length when a person writes it long', async () => {
    expect(await failures(LONG_HUMAN_TITLE)).toEqual([SUBJECT])
  })

  it.each([
    // The opening of a bump, the rest a person's.
    'chore(deps): bump lint-staged and rewrite the pre-commit hook while the config is open',
    'chore(deps-dev): bump lint-staged from 17.6.0 to 17.6.1 in the dev-tooling group, and its config',
    'chore(deps-dev): bump lint-staged from 17.6.0 to 17.6.1 in the dev-tooling group across 1 folder',
    // A directory has to be a path, as Dependabot writes it.
    'chore(deps-dev): bump devcontainers/javascript-node from 24-bookworm to 24-bookworm in devcontainer',
    // Dependabot never writes `Bump` under a prefix.
    'chore(deps-dev): Bump lint-staged from 17.6.0 to 17.6.1 in the dev-tooling group across 1 directory',
  ])('fails on its length when it only starts like a bump: %s', async (title) => {
    expect(await failures(title)).toEqual([SUBJECT])
  })

  it('fails on every rule it breaks when it imitates a bump and gets more than length wrong', async () => {
    expect(
      await failures(
        'chore(deps-dev): bump lint-staged from 17.6.0 to 17.6.1 in the dev-tooling group, plus a full stop.',
      ),
    ).toEqual(['subject-full-stop', SUBJECT])
  })

  it.each([
    // Not a scope at all, and three characters past the header limit.
    [PR_271.replace('(deps-dev)', '(dependencies)'), ['scope-enum', HEADER, SUBJECT]],
    // Not a type at all.
    [PR_271.replace('chore(', 'chores('), ['type-enum', SUBJECT]],
    // A type and a scope from the lists, but not a prefix Dependabot is given.
    [PR_271.replace('chore(', 'build('), [SUBJECT]],
    [PR_271.replace('chore(', 'ci('), [SUBJECT]],
    [PR_271.replace('(deps-dev)', '(eval)'), [SUBJECT]],
  ])('fails as a bump with the wrong prefix: %s', async (title, expected) => {
    expect(await failures(title)).toEqual([...expected].sort())
  })
})

describe('the CLI, as the CI job and the commit-msg hook run it', () => {
  const cli = join(root, 'node_modules/@commitlint/cli/cli.js')
  const run = (title: string) =>
    spawnSync(process.execPath, [cli], { cwd: root, input: title, encoding: 'utf8' })

  it('passes the #271 title', () => {
    const result = run(PR_271)
    expect(result.status, result.stdout + result.stderr).toBe(0)
  })

  it('fails a long title from a person, on the rule that replaced subject-max-length', () => {
    const result = run(LONG_HUMAN_TITLE)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain(`[${SUBJECT}]`)
  })
})
