import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The lint guardrails, checked by breaking them.
 *
 * `npm run lint` passing proves the repository has no violations. It says
 * nothing about whether a violation would be caught, and those are different
 * claims — a rule that silently does nothing passes exactly as loudly as a rule
 * that works.
 *
 * This file exists because that happened. Two blocks configured
 * `no-restricted-imports` over overlapping files, and flat config resolves a
 * rule to its **last matching entry** rather than merging entries, so the SDK
 * block replaced the filesystem block wholesale for everything under `agents/`.
 * The result was a guardrail that the documentation described, the config
 * appeared to implement, and that had been off for every file it was written to
 * protect. `npm run lint` was green throughout.
 */

/**
 * These are type-aware rules, so the first `lintText` builds a TypeScript program
 * for the whole project before it can report anything. That is seconds of work,
 * paid once, and it fits inside the default five-second timeout on a developer
 * machine and does not on a CI runner — which is precisely the failure this
 * repository exists to talk about, so it is fixed rather than retried.
 *
 * The warm-up pays the cost where it is visible instead of charging it to
 * whichever test happens to run first.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const eslint = new ESLint()

beforeAll(async () => {
  await eslint.lintText('export const warm = 1\n', { filePath: 'agents/context.ts' })
})

/** Message ids are not stable across versions; the rule name is. */
async function violations(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath })
  return (result?.messages ?? [])
    .filter((message) => message.ruleId === '@typescript-eslint/no-restricted-imports')
    .map((message) => message.message)
}

const PURE_MODULES = [
  'agents/context.ts',
  'agents/sanitise.ts',
  'agents/redact.ts',
  'agents/triage.ts',
] as const

describe('agents cannot touch the filesystem', () => {
  it.each(PURE_MODULES)('%s cannot import node:fs', async (file) => {
    const found = await violations(
      `import { readFileSync } from 'node:fs'\nexport const x = (p: string) => readFileSync(p, 'utf8')\n`,
      file,
    )
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('Callers read paths and pass the contents in')
  })

  it.each(PURE_MODULES)('%s cannot spawn a process', async (file) => {
    const found = await violations(
      `import { execFileSync } from 'node:child_process'\nexport const x = () => execFileSync('git', [])\n`,
      file,
    )
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('read-only facade')
  })

  /**
   * Asked of the resolved config rather than by linting text, because the agent
   * directories have no files yet and type-aware parsing needs one on disk. The
   * question is the same either way: does this path carry the rule.
   */
  it.each(['agents/triage/run.ts', 'agents/root-cause/run.ts', 'agents/context/bundle.ts'])(
    '%s is covered even though it does not exist yet',
    async (file) => {
      const config = (await eslint.calculateConfigForFile(file)) as {
        rules: Record<string, unknown>
      }
      expect(JSON.stringify(config.rules['@typescript-eslint/no-restricted-imports'])).toContain(
        'node:fs',
      )
    },
  )

  /**
   * The transport and the cassette store read and write on purpose. If the rule
   * covered them the exemption would be a suppression comment, and a suppression
   * comment is a thing people copy.
   */
  it('does not apply to the modules that are meant to do IO', async () => {
    const found = await violations(
      `import { readFileSync } from 'node:fs'\nexport const x = (p: string) => readFileSync(p, 'utf8')\n`,
      'agents/cassettes.ts',
    )
    expect(found).toEqual([])
  })
})

describe('only the git facade may reach the git client', () => {
  /**
   * `agents/git.ts` hands out four reads and holds the client in a closure, so
   * there is no field to reach through. That only means anything while it is the
   * sole importer: one `import { simpleGit }` elsewhere and an agent has push,
   * tag and commit, with nothing anywhere to notice.
   */
  it.each([...PURE_MODULES, 'agents/cassettes.ts', 'agents/transport.ts'])(
    '%s cannot import simple-git',
    async (file) => {
      const found = await violations(
        `import { simpleGit } from 'simple-git'\nexport const g = simpleGit()\n`,
        file,
      )
      expect(found).toHaveLength(1)
      expect(found[0]).toContain('agents/git.ts')
    },
  )

  it('exempts the facade, which is the one module allowed to', async () => {
    const found = await violations(
      `import { simpleGit } from 'simple-git'\nexport const g = simpleGit()\n`,
      'agents/git.ts',
    )
    expect(found).toEqual([])
  })

  /**
   * The facade is still not allowed to build a model client. Flat config resolves
   * this rule to its last matching entry, so the block exempting `agents/git.ts`
   * from the git restriction has to repeat the SDK one — and this is the
   * assertion that notices when it does not.
   */
  it('does not accidentally exempt the facade from everything else', async () => {
    const found = await violations(
      `import Anthropic from '@anthropic-ai/sdk'\nexport const client = new Anthropic()\n`,
      'agents/git.ts',
    )
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('Model calls go through agents/transport.ts')
  })

  /** The same trap in the other direction: the pure modules carry all three now. */
  it.each(PURE_MODULES)('%s is covered by all three restrictions at once', async (file) => {
    const found = await violations(
      `import Anthropic from '@anthropic-ai/sdk'\nimport { readFileSync } from 'node:fs'\nimport { simpleGit } from 'simple-git'\nexport const x = new Anthropic(readFileSync('a', 'utf8')) as unknown as typeof simpleGit\n`,
      file,
    )
    expect(found).toHaveLength(3)
  })
})

describe('only the transport may construct an SDK client', () => {
  it.each([...PURE_MODULES, 'agents/cassettes.ts', 'agents/model-client.ts'])(
    '%s cannot import the SDK',
    async (file) => {
      const found = await violations(
        `import Anthropic from '@anthropic-ai/sdk'\nexport const client = new Anthropic()\n`,
        file,
      )
      expect(found).toHaveLength(1)
      expect(found[0]).toContain('Model calls go through agents/transport.ts')
    },
  )

  /**
   * The regression that prompted this file: the pure modules match two blocks
   * that both configure this rule, so the later one has to carry both
   * restrictions or the earlier one disappears.
   */
  it.each(PURE_MODULES)('%s is covered by both restrictions at once', async (file) => {
    const found = await violations(
      `import Anthropic from '@anthropic-ai/sdk'\nimport { readFileSync } from 'node:fs'\nexport const x = new Anthropic(readFileSync('a', 'utf8'))\n`,
      file,
    )
    expect(found).toHaveLength(2)
  })

  it('exempts the transport, which is the one module allowed to', async () => {
    const found = await violations(
      `import Anthropic from '@anthropic-ai/sdk'\nexport const client = new Anthropic()\n`,
      'agents/transport.ts',
    )
    expect(found).toEqual([])
  })
})
