import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  cassetteFile,
  cassetteKey,
  CassetteMissError,
  CassetteTransport,
  listCassettes,
  ModeError,
  REDACTED,
  resolveMode,
  scrub,
} from './cassettes.js'
import {
  TransportError,
  type ModelRequest,
  type ModelResponse,
  type Transport,
} from './transport.js'

const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: 'claude-opus-5',
  maxTokens: 8000,
  effort: 'high',
  system: 'You classify test failures.\nUse the rubric.',
  prompt: 'Classify this failure.',
  schemaName: 'Classification',
  jsonSchema: { type: 'object', properties: { owner: { type: 'string' } } },
  promptVersion: 'triage.v1',
  ...over,
})

const response: ModelResponse = {
  raw: { owner: 'app_code' },
  stopReason: 'end_turn',
  model: 'claude-opus-5',
  usage: { inputTokens: 1200, outputTokens: 88 },
}

/** Fails on any call. Wrapping this is how "replay makes no network call" is proved. */
const unreachable: Transport = {
  send() {
    throw new Error('the inner transport was called in replay mode')
  },
  countInputTokens() {
    throw new Error('the inner transport was called in replay mode')
  },
}

const recording = (): Transport & { sends: number } => {
  const t = {
    sends: 0,
    send(_request: ModelRequest) {
      t.sends += 1
      return Promise.resolve(response)
    },
    countInputTokens(_request: ModelRequest) {
      return Promise.resolve(1200)
    },
  }
  return t
}

const scratch = (): string => mkdtempSync(join(tmpdir(), 'sentra-cassettes-'))

describe('resolveMode', () => {
  it('replays when asked', () => {
    expect(resolveMode({ SENTRA_REPLAY: '1', ANTHROPIC_API_KEY: 'sk-ant-x' })).toBe('replay')
  })

  it('records when asked', () => {
    expect(resolveMode({ SENTRA_RECORD: '1', ANTHROPIC_API_KEY: 'sk-ant-x' })).toBe('record')
  })

  it('replays when there are no credentials, so a fresh clone works', () => {
    // The claim the README rests on: clone, run, see it work, no key.
    expect(resolveMode({})).toBe('replay')
  })

  it('treats an auth token as credentials too', () => {
    // Checking ANTHROPIC_API_KEY alone would put a token-authenticated
    // developer into replay and leave them wondering why nothing changed.
    expect(resolveMode({ ANTHROPIC_AUTH_TOKEN: 'x' })).toBe('live')
  })

  it('treats an empty key as no key', () => {
    expect(resolveMode({ ANTHROPIC_API_KEY: '' })).toBe('replay')
  })

  it('lets a profile-authenticated developer force live', () => {
    // The SDK also accepts an `ant auth login` profile, which leaves nothing in
    // the environment to detect. Without this flag that developer silently gets
    // replay.
    expect(resolveMode({ SENTRA_LIVE: '1' })).toBe('live')
  })

  it('refuses two conflicting requests rather than picking a winner', () => {
    // A silent winner is a trap: somebody who meant to re-record and got replay
    // sees stale answers and concludes the model changed.
    expect(() => resolveMode({ SENTRA_REPLAY: '1', SENTRA_RECORD: '1' })).toThrow(ModeError)
    expect(() => resolveMode({ SENTRA_LIVE: '1', SENTRA_REPLAY: '1' })).toThrow(/exactly one/)
  })

  it('names both modes that were asked for', () => {
    const error = (() => {
      try {
        resolveMode({ SENTRA_REPLAY: '1', SENTRA_RECORD: '1' })
        return ''
      } catch (e) {
        return e instanceof Error ? e.message : ''
      }
    })()
    expect(error).toContain('replay')
    expect(error).toContain('record')
  })
})

describe('the cassette key', () => {
  it('is stable across runs', () => {
    expect(cassetteKey(request())).toBe(cassetteKey(request()))
  })

  it.each([
    ['a reworded prompt', { prompt: 'Classify this differently.' }],
    ['a different prompt version', { promptVersion: 'triage.v2' }],
    ['a different model', { model: 'claude-sonnet-5' }],
    ['a different system prompt', { system: 'Something else.' }],
    ['a different effort', { effort: 'low' as const }],
    ['a different token ceiling', { maxTokens: 4000 }],
  ])('changes on %s', (_case, over) => {
    expect(cassetteKey(request(over))).not.toBe(cassetteKey(request()))
  })

  it('changes when the output schema changes', () => {
    // A reshaped output is a different question even when the prose is
    // identical; replaying the old answer would validate against the new schema
    // by luck or fail confusingly.
    expect(cassetteKey(request({ jsonSchema: { type: 'object', properties: {} } }))).not.toBe(
      cassetteKey(request()),
    )
  })

  it('names files so a directory sorts by prompt version', () => {
    expect(cassetteFile(request())).toMatch(/^triage\.v1\.[0-9a-f]{16}\.json$/)
  })
})

describe('scrubbing', () => {
  it.each([
    ['an Anthropic key', 'key sk-ant-api03-AbCdEfGh12345678 here'],
    ['a bearer token', 'Authorization: Bearer abcdefghijklmnop123'],
    ['a GitHub token', 'ghp_abcdefghijklmnopqrstuvwxyz0123'],
    ['a fine-grained GitHub token', 'github_pat_11ABCDEFG0abcdefghijklmn'],
    ['an AWS access key', 'AKIAIOSFODNN7EXAMPLE'],
    ['a Slack token', 'xoxb-123456789012-abcdefghijkl'],
  ])('removes %s', (_case, text) => {
    expect(scrub(text)).toContain(REDACTED)
    expect(scrub(text)).not.toMatch(
      /sk-ant-api03-A|abcdefghijklmnop123|ghp_abcdef|AKIAIOSF|xoxb-123/,
    )
  })

  it('reaches into nested structures, where a leak would actually hide', () => {
    const scrubbed = scrub({ a: [{ b: 'sk-ant-api03-SECRETVALUE123' }] })
    expect(JSON.stringify(scrubbed)).toContain(REDACTED)
    expect(JSON.stringify(scrubbed)).not.toContain('SECRETVALUE')
  })

  it('leaves ordinary text alone', () => {
    const text = 'expected 3 to equal 4 at board.spec.ts:42'
    expect(scrub(text)).toBe(text)
  })

  it('does not touch keys, since a key name is not a secret', () => {
    expect(scrub({ ANTHROPIC_API_KEY: 'ordinary' })).toEqual({ ANTHROPIC_API_KEY: 'ordinary' })
  })

  it('passes non-strings through unchanged', () => {
    expect(scrub({ n: 1, b: true, z: null })).toEqual({ n: 1, b: true, z: null })
  })
})

describe('replay', () => {
  it('serves the recorded response without touching the network', async () => {
    // The property the whole feature rests on. The inner transport throws on
    // any call, so a fallthrough fails loudly here rather than costing money in
    // production.
    const dir = scratch()
    const record = new CassetteTransport(recording(), {
      mode: 'record',
      dir,
      today: () => '2026-08-11',
    })
    await record.send(request())

    const replay = new CassetteTransport(unreachable, { mode: 'replay', dir })
    await expect(replay.send(request())).resolves.toMatchObject({ raw: { owner: 'app_code' } })
  })

  it('serves the token count from the cassette too', async () => {
    const dir = scratch()
    await new CassetteTransport(recording(), {
      mode: 'record',
      dir,
      today: () => '2026-08-11',
    }).send(request())

    const replay = new CassetteTransport(unreachable, { mode: 'replay', dir })
    await expect(replay.countInputTokens(request())).resolves.toBe(1200)
  })

  it('throws on a miss rather than falling through to a live call', async () => {
    // A silent fallthrough turns a free deterministic run into a surprise bill
    // and an intermittent test, and takes months to notice.
    const replay = new CassetteTransport(unreachable, { mode: 'replay', dir: scratch() })
    await expect(replay.send(request())).rejects.toThrow(CassetteMissError)
  })

  it('names the key, the expected file and how to re-record', async () => {
    const replay = new CassetteTransport(unreachable, { mode: 'replay', dir: scratch() })
    const error = (await replay.send(request()).catch((e: unknown) => e)) as Error

    expect(error.message).toContain(cassetteKey(request()))
    expect(error.message).toContain(cassetteFile(request()))
    expect(error.message).toContain('SENTRA_RECORD=1')
  })

  it('misses when the prompt changes, rather than replaying a stale answer', async () => {
    const dir = scratch()
    await new CassetteTransport(recording(), {
      mode: 'record',
      dir,
      today: () => '2026-08-11',
    }).send(request())

    const replay = new CassetteTransport(unreachable, { mode: 'replay', dir })
    await expect(replay.send(request({ prompt: 'A different question.' }))).rejects.toThrow(
      CassetteMissError,
    )
  })

  it('reports a corrupt cassette as corrupt, not as a miss', async () => {
    // "Re-record" is the wrong advice for somebody whose problem is a bad edit
    // to a committed file.
    const dir = scratch()
    writeFileSync(join(dir, cassetteFile(request())), JSON.stringify({ key: 'x' }))

    const replay = new CassetteTransport(unreachable, { mode: 'replay', dir })
    const error = (await replay.send(request()).catch((e: unknown) => e)) as Error
    expect(error).toBeInstanceOf(TransportError)
    expect(error.message).toContain('not a valid cassette')
  })
})

describe('recording', () => {
  it('writes a cassette and still returns the live response', async () => {
    const dir = scratch()
    const inner = recording()
    const transport = new CassetteTransport(inner, {
      mode: 'record',
      dir,
      today: () => '2026-08-11',
    })

    await expect(transport.send(request())).resolves.toMatchObject({ raw: { owner: 'app_code' } })
    expect(inner.sends).toBe(1)
    expect(listCassettes(dir)).toHaveLength(1)
  })

  it('stores multi-line text as lines, so a prompt edit diffs readably', async () => {
    // Inside a JSON string a whole prompt is one enormous line, and any change
    // to it reviews as a single altered line with no sign of what moved.
    const dir = scratch()
    await new CassetteTransport(recording(), {
      mode: 'record',
      dir,
      today: () => '2026-08-11',
    }).send(request())
    const cassette = listCassettes(dir)[0]
    expect(cassette?.request.system).toEqual(['You classify test failures.', 'Use the rubric.'])
  })

  it('stores a digest of the schema rather than the schema', async () => {
    // The schema runs to hundreds of derived lines and would bury the prompt in
    // every review, but it still belongs in the identity.
    const dir = scratch()
    await new CassetteTransport(recording(), {
      mode: 'record',
      dir,
      today: () => '2026-08-11',
    }).send(request())
    const raw = readFileSync(join(dir, cassetteFile(request())), 'utf8')
    expect(raw).toContain('schemaDigest')
    expect(raw).not.toContain('"properties"')
  })

  it('scrubs secrets before anything is committed', async () => {
    // The last point at which a leaked credential can be caught: after this it
    // is in git history forever.
    const dir = scratch()
    const leaky: Transport = {
      send: () =>
        Promise.resolve({ ...response, raw: { note: 'used sk-ant-api03-LEAKED12345678' } }),
      countInputTokens: () => Promise.resolve(10),
    }
    await new CassetteTransport(leaky, { mode: 'record', dir, today: () => '2026-08-11' }).send(
      request({ prompt: 'token ghp_abcdefghijklmnopqrstuvwxyz0123' }),
    )

    const raw = readFileSync(
      join(dir, cassetteFile(request({ prompt: 'token ghp_abcdefghijklmnopqrstuvwxyz0123' }))),
      'utf8',
    )
    expect(raw).not.toContain('LEAKED')
    expect(raw).not.toContain('ghp_abcdef')
    expect(raw).toContain(REDACTED)
  })

  it('writes JSON a human can read', async () => {
    const dir = scratch()
    await new CassetteTransport(recording(), {
      mode: 'record',
      dir,
      today: () => '2026-08-11',
    }).send(request())
    const raw = readFileSync(join(dir, cassetteFile(request())), 'utf8')
    expect(raw).toContain('\n  "key"')
    expect(raw.endsWith('\n')).toBe(true)
  })

  it('records the date, so #40 can spot a cassette older than its prompt', async () => {
    const dir = scratch()
    await new CassetteTransport(recording(), {
      mode: 'record',
      dir,
      today: () => '2026-08-11',
    }).send(request())
    expect(listCassettes(dir)[0]?.recordedAt).toBe('2026-08-11')
  })
})

describe('live mode', () => {
  it('passes straight through and writes nothing', async () => {
    const dir = scratch()
    const inner = recording()
    const transport = new CassetteTransport(inner, { mode: 'live', dir })

    await transport.send(request())
    await transport.countInputTokens(request())

    expect(inner.sends).toBe(1)
    expect(listCassettes(dir)).toEqual([])
  })
})

describe('listCassettes', () => {
  it('returns nothing for a directory that does not exist yet', () => {
    expect(listCassettes(join(scratch(), 'missing'))).toEqual([])
  })

  it('refuses a corrupt file rather than skipping it', () => {
    // Skipping would make a broken cassette look like a missing one, and the
    // staleness check in #40 would report a clean sheet.
    const dir = scratch()
    writeFileSync(join(dir, 'triage.v1.deadbeefdeadbeef.json'), '{"nope":true}')
    expect(() => listCassettes(dir)).toThrow(/not a valid cassette/)
  })

  it('returns them sorted, so a listing does not churn', async () => {
    const dir = scratch()
    const transport = new CassetteTransport(recording(), {
      mode: 'record',
      dir,
      today: () => '2026-08-11',
    })
    await transport.send(request({ promptVersion: 'triage.v2' }))
    await transport.send(request({ promptVersion: 'triage.v1' }))

    expect(listCassettes(dir).map((c) => c.promptVersion)).toEqual(['triage.v1', 'triage.v2'])
  })
})

describe('the committed cassette directory', () => {
  it('parses, whatever is in it', () => {
    // Empty today. When the triage agent lands in #35 this is what stops a
    // hand-edited cassette reaching main.
    expect(() => listCassettes()).not.toThrow()
  })
})
