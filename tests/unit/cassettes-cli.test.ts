import { readFileSync } from 'node:fs'
import { cassetteKey, type Cassette, type ModelRequest, type Transport } from '@sentra/agents'
import { describe, expect, it, vi } from 'vitest'
import { expectations, main as check } from '../../scripts/cassettes.js'
import { main as record } from '../../scripts/record.js'

const read = (path: string): string => readFileSync(path, 'utf8')

const asCassette = (request: ModelRequest): Cassette => ({
  key: cassetteKey(request),
  promptVersion: request.promptVersion,
  model: request.model,
  recordedAt: '2026-08-12',
  sample: request.sample ?? 0,
  request: {
    effort: request.effort,
    maxTokens: request.maxTokens,
    schemaName: request.schemaName,
    schemaDigest: 'digest',
    system: request.system.split('\n'),
    prompt: request.prompt.split('\n'),
  },
  inputTokens: 100,
  response: {
    raw: {},
    stopReason: 'end_turn',
    model: request.model,
    usage: { inputTokens: 100, outputTokens: 20 },
  },
})

describe('what the check expects', () => {
  const wanted = expectations(read)

  it('covers the golden dataset and the demo', () => {
    expect(wanted.some((row) => row.source.startsWith('eval '))).toBe(true)
    expect(wanted.some((row) => row.source.startsWith('demo '))).toBe(true)
  })

  it('asks for every sample the harness runs by default', () => {
    const forOneFixture = wanted.filter((row) => row.source.startsWith('eval '))
    const perFixture = new Map<string, number>()
    for (const row of forOneFixture) {
      const name = row.source.split(' ')[1] ?? ''
      perFixture.set(name, (perFixture.get(name) ?? 0) + 1)
    }
    expect([...new Set(perFixture.values())]).toEqual([5])
  })

  /**
   * Mirrors what the demo does. If the check assumed a source the demo cannot
   * read, every demo key would differ and the check would report failures that
   * only exist inside itself.
   */
  it('gives up on an unreadable test source exactly as the demo does', () => {
    const withoutSources = (path: string): string => {
      if (path.includes('sources')) throw new Error('ENOENT')
      return readFileSync(path, 'utf8')
    }
    const wantedWithout = expectations(withoutSources)
    expect(wantedWithout).toHaveLength(wanted.length)
    // The demo requests change; the dataset's do not, since they carry their own source.
    const demoKeys = (rows: typeof wanted): string[] =>
      rows.filter((row) => row.source.startsWith('demo ')).map((row) => cassetteKey(row.request))
    expect(demoKeys(wantedWithout)).not.toEqual(demoKeys(wanted))
  })

  it('names the current prompt version on every request', () => {
    expect(new Set(wanted.map((row) => row.request.promptVersion)).size).toBe(1)
    expect(wanted[0]?.request.promptVersion).toMatch(/^triage\.v\d+$/)
  })

  /**
   * The property that makes this check worth having rather than a second
   * implementation of the pipeline. The keys it expects are the keys the agent
   * would actually request — asserted by running the agent against a transport
   * that records what it was handed, and comparing.
   */
  it('is the key the agent would really send', async () => {
    const { triage } = await import('@sentra/agents')
    const { loadPrompt, CURRENT_PROMPT } = await import('@sentra/prompts')
    const { loadPayload, listFixtures } = await import('@sentra/eval')

    const sent: ModelRequest[] = []
    const transport: Transport = {
      countInputTokens: () => Promise.resolve(10),
      send: (request) => {
        sent.push(request)
        return Promise.resolve({
          raw: {
            owner: 'app_code',
            determinism: 'intermittent',
            confidence: 0.5,
            reasoning: 'x',
            evidence: ['y'],
          },
          stopReason: 'end_turn',
          model: request.model,
          usage: { inputTokens: 10, outputTokens: 5 },
        })
      },
    }

    const name = listFixtures()[0] ?? ''
    const prompt = loadPrompt(CURRENT_PROMPT.triage)
    await triage(loadPayload(name).payload, {
      transport,
      system: prompt.system,
      promptVersion: prompt.version,
      sample: 3,
    })

    const predicted = new Set(expectations(read).map((row) => cassetteKey(row.request)))
    expect(sent).toHaveLength(1)
    expect(sent.map((request) => predicted.has(cassetteKey(request)))).toEqual([true])
  })
})

describe('the check', () => {
  it('passes and says why when nothing is recorded', () => {
    const lines: string[] = []
    expect(check({ read, cassettes: () => [], log: (m) => lines.push(m) })).toBe(0)
    expect(lines.join('')).toContain('nothing to go stale')
  })

  it('passes when every expected recording is present', () => {
    const all = expectations(read).map((row) => asCassette(row.request))
    expect(check({ read, cassettes: () => all, log: () => undefined })).toBe(0)
  })

  it('fails, loudly, when one is missing', () => {
    const all = expectations(read).map((row) => asCassette(row.request))
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
      errors.push(String(m))
    })
    try {
      expect(check({ read, cassettes: () => all.slice(1), log: () => undefined })).toBe(1)
    } finally {
      spy.mockRestore()
    }
    expect(errors.join('')).toContain('Missing')
    expect(errors.join('')).toContain('npm run cassettes:record')
  })

  /**
   * The failure the whole check exists for: a prompt reworded, every recording
   * silently answering a question nobody asks any more.
   */
  it('fails when the recordings answer a prompt that no longer exists', () => {
    const stale = expectations(read).map((row) =>
      asCassette({ ...row.request, system: 'an older wording of the rubric' }),
    )
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(check({ read, cassettes: () => stale, log: () => undefined })).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('the recorder', () => {
  /**
   * The only script in the repository that costs money, so it refuses to guess.
   * A recording run that quietly recorded nothing is worse than one that did not
   * start.
   */
  it('refuses to start without credentials', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(await record({ env: { SENTRA_REPLAY: '1' }, log: () => undefined })).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('records the dataset and the demo, in that order, in one run', async () => {
    const steps: string[] = []
    const code = await record({
      env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
      runEval: (argv) => {
        steps.push(`eval ${argv.join(' ')}`)
        return Promise.resolve(0)
      },
      runDemo: () => {
        steps.push('demo')
        return Promise.resolve(0)
      },
      log: () => undefined,
    })
    expect(code).toBe(0)
    expect(steps).toEqual(['eval --classifier=agent', 'demo'])
  })

  it('sets record mode for the runs it drives', async () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'sk-ant-test' }
    await record({
      env,
      runEval: () => Promise.resolve(0),
      runDemo: () => Promise.resolve(0),
      log: () => undefined,
    })
    expect(env.SENTRA_RECORD).toBe('1')
  })

  it('stops at the first failure rather than reporting a clean run', async () => {
    const steps: string[] = []
    const code = await record({
      env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
      runEval: () => Promise.resolve(1),
      runDemo: () => {
        steps.push('demo')
        return Promise.resolve(0)
      },
      log: () => undefined,
    })
    expect(code).toBe(1)
    expect(steps).toEqual([])
  })
})
