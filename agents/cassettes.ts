import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { scrub } from './redact.js'
import {
  TransportError,
  type ModelRequest,
  type ModelResponse,
  type Transport,
} from './transport.js'

/**
 * Record and replay for model calls.
 *
 * This is what makes the README's central claim true — clone the repository,
 * run the pipeline, see it work, with no credentials — and it makes the
 * integration tests free and deterministic at the same time. Specified in
 * ADR-0005.
 *
 * The design point everything else follows from: **a replay miss is a loud
 * error, never a fallthrough to a live call.** A miss that quietly reaches the
 * network turns "free deterministic test" into a surprise bill and a flaky
 * test, and does it in a way nobody notices for months — the suite still
 * passes, just slower and occasionally differently.
 *
 * Implemented as a decorator around a `Transport` rather than inside the
 * Anthropic one, so replay has no opinion about the SDK and the SDK adapter has
 * no opinion about replay. In replay mode the inner transport is never touched
 * at all, which a test asserts by wrapping one that throws on any call.
 */

export type Mode = 'live' | 'record' | 'replay'

export const CASSETTE_DIR = 'agents/replay/cassettes'

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

export class ModeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModeError'
  }
}

/**
 * Which mode the environment asks for.
 *
 * Pure, so the precedence is testable without touching `process.env`. The
 * precedence itself is the interesting part:
 *
 * Asking for record *and* replay at once is refused rather than resolved. Any
 * silent winner here is a trap — a developer who meant to re-record and got
 * replay sees stale answers and concludes the model changed.
 *
 * Absent credentials mean replay, per ADR-0005, so a clone with no key works.
 * "Absent" is judged from `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`
 * together, and even then it can be wrong: the SDK also accepts an
 * `ant auth login` profile that leaves no trace in the environment. Somebody
 * authenticated that way and expecting live calls gets replay instead, which is
 * why `SENTRA_LIVE=1` exists to say so explicitly.
 */
export interface ModeEnv {
  SENTRA_REPLAY?: string | undefined
  SENTRA_RECORD?: string | undefined
  SENTRA_LIVE?: string | undefined
  ANTHROPIC_API_KEY?: string | undefined
  ANTHROPIC_AUTH_TOKEN?: string | undefined
}

export function resolveMode(env: ModeEnv): Mode {
  const wantsReplay = env.SENTRA_REPLAY === '1'
  const wantsRecord = env.SENTRA_RECORD === '1'
  const wantsLive = env.SENTRA_LIVE === '1'

  const asked = [wantsReplay && 'replay', wantsRecord && 'record', wantsLive && 'live'].filter(
    (mode): mode is Mode => mode !== false,
  )
  if (asked.length > 1) {
    throw new ModeError(
      `SENTRA_REPLAY, SENTRA_RECORD and SENTRA_LIVE ask for different things (${asked.join(', ')}). ` +
        'Set exactly one — guessing which you meant is how a stale cassette gets mistaken for a model change.',
    )
  }

  if (wantsReplay) return 'replay'
  if (wantsRecord) return 'record'
  if (wantsLive) return 'live'

  const credentialed =
    (env.ANTHROPIC_API_KEY ?? '') !== '' || (env.ANTHROPIC_AUTH_TOKEN ?? '') !== ''
  return credentialed ? 'live' : 'replay'
}

// ---------------------------------------------------------------------------
// The cassette format
// ---------------------------------------------------------------------------

/**
 * Multi-line text is stored as an array of lines.
 *
 * A prompt inside a JSON string is one enormous line, so any edit to it shows
 * up in review as a single changed line with no indication of what moved. Split
 * into lines it diffs like the prose it is. Rejoined on read, so nothing
 * downstream knows.
 */
const LinesSchema = z.array(z.string())

const CassetteSchema = z
  .object({
    key: z.string(),
    promptVersion: z.string(),
    model: z.string(),
    /** Day precision. Enough for #40 to spot a cassette older than its prompt. */
    recordedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** Which of N self-consistency samples this response was. */
    sample: z.number().int().nonnegative().default(0),
    request: z.object({
      effort: z.string(),
      maxTokens: z.number().int().positive(),
      schemaName: z.string(),
      /** A digest, not the schema — see `cassetteKey`. */
      schemaDigest: z.string(),
      system: LinesSchema,
      prompt: LinesSchema,
    }),
    inputTokens: z.number().int().nonnegative(),
    response: z.object({
      raw: z.unknown(),
      stopReason: z.string().nullable(),
      model: z.string(),
      usage: z.object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      }),
    }),
  })
  .strict()

export type Cassette = z.infer<typeof CassetteSchema>

/**
 * A stable identity for a request.
 *
 * Covers the prompt version, the model, the sample index, and everything about
 * the request that could change the answer — including the response schema,
 * because a reshaped output is a different question even when the prose is
 * identical.
 *
 * The schema is hashed rather than stored: it is derived from a Zod type, runs
 * to hundreds of lines, and would bury the prompt in every cassette review.
 * Storing its digest keeps it in the identity without putting it on the page.
 */
export function cassetteKey(request: ModelRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        request.promptVersion,
        request.model,
        request.effort,
        request.maxTokens,
        request.schemaName,
        schemaDigest(request),
        request.system,
        request.prompt,
        request.sample ?? 0,
      ]),
    )
    .digest('hex')
    .slice(0, 16)
}

const schemaDigest = (request: ModelRequest): string =>
  createHash('sha256').update(JSON.stringify(request.jsonSchema)).digest('hex').slice(0, 12)

/** `triage.v1.a1b2c3d4e5f6a7b8.json` — sorts by prompt version, unique by request. */
export const cassetteFile = (request: ModelRequest): string =>
  `${request.promptVersion}.${cassetteKey(request)}.json`

// ---------------------------------------------------------------------------
// The transport decorator
// ---------------------------------------------------------------------------

export class CassetteMissError extends Error {
  constructor(
    readonly key: string,
    readonly file: string,
    readonly promptVersion: string,
  ) {
    super(
      [
        `no cassette for ${promptVersion} request ${key}.`,
        '',
        `Expected: ${file}`,
        '',
        'Replay never falls through to a live call — a silent fallthrough turns a free,',
        'deterministic run into a surprise bill and an intermittent test. Re-record with:',
        '',
        '    SENTRA_RECORD=1 npm run eval -- --classifier=agent',
        '',
        'and commit the cassette it writes.',
      ].join('\n'),
    )
    this.name = 'CassetteMissError'
  }
}

export interface CassetteOptions {
  mode: Mode
  dir?: string
  /** Injected so a recording test does not have to reason about the clock. */
  today?: () => string
}

/**
 * Wraps a transport with record and replay.
 *
 * In `replay` the inner transport is unreachable — not merely unused. That is
 * the property the whole feature rests on, and it is asserted by a test that
 * wraps a transport which throws on any call.
 */
export class CassetteTransport implements Transport {
  private readonly dir: string
  private readonly today: () => string

  constructor(
    private readonly inner: Transport,
    private readonly options: CassetteOptions,
  ) {
    this.dir = options.dir ?? CASSETTE_DIR
    this.today = options.today ?? (() => new Date().toISOString().slice(0, 10))
  }

  get mode(): Mode {
    return this.options.mode
  }

  async countInputTokens(request: ModelRequest): Promise<number> {
    if (this.mode === 'replay') return this.load(request).inputTokens
    return this.inner.countInputTokens(request)
  }

  async send(request: ModelRequest): Promise<ModelResponse> {
    if (this.mode === 'replay') {
      const cassette = this.load(request)
      return {
        raw: cassette.response.raw,
        stopReason: cassette.response.stopReason,
        model: cassette.response.model,
        usage: cassette.response.usage,
      }
    }

    const response = await this.inner.send(request)
    if (this.mode === 'record') {
      // Counted after the fact rather than before, so recording adds one
      // request rather than two to every call it captures.
      const inputTokens = response.usage.inputTokens
      this.write(request, inputTokens, response)
    }
    return response
  }

  private load(request: ModelRequest): Cassette {
    const file = cassetteFile(request)
    let raw: string
    try {
      raw = readFileSync(join(this.dir, file), 'utf8')
    } catch {
      throw new CassetteMissError(cassetteKey(request), file, request.promptVersion)
    }

    const parsed = CassetteSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      // A corrupt cassette is not a miss. Treating it as one would print
      // "re-record" at somebody whose problem is a bad edit to a committed file.
      throw new TransportError(
        'client',
        `${file} is not a valid cassette: ${parsed.error.issues[0]?.message ?? ''}`,
      )
    }
    return parsed.data
  }

  private write(request: ModelRequest, inputTokens: number, response: ModelResponse): void {
    const cassette: Cassette = scrub({
      key: cassetteKey(request),
      promptVersion: request.promptVersion,
      model: request.model,
      recordedAt: this.today(),
      sample: request.sample ?? 0,
      request: {
        effort: request.effort,
        maxTokens: request.maxTokens,
        schemaName: request.schemaName,
        schemaDigest: schemaDigest(request),
        system: request.system.split('\n'),
        prompt: request.prompt.split('\n'),
      },
      inputTokens,
      response: {
        raw: response.raw,
        stopReason: response.stopReason,
        model: response.model,
        usage: response.usage,
      },
    })

    mkdirSync(this.dir, { recursive: true })
    writeFileSync(join(this.dir, cassetteFile(request)), `${JSON.stringify(cassette, null, 2)}\n`)
  }
}

/** Every committed cassette, for the staleness check in #40 and for tests. */
export function listCassettes(dir: string = CASSETTE_DIR): Cassette[] {
  let files: string[]
  try {
    files = readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .sort()
  } catch {
    return []
  }

  return files.map((file) => {
    const parsed = CassetteSchema.safeParse(JSON.parse(readFileSync(join(dir, file), 'utf8')))
    if (!parsed.success) {
      throw new Error(`${file} is not a valid cassette: ${parsed.error.issues[0]?.message ?? ''}`)
    }
    return parsed.data
  })
}
