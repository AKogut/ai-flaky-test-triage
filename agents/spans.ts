import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
  type Tracer,
} from '@opentelemetry/api'
import { ExportResultCode, hrTimeToMilliseconds, type ExportResult } from '@opentelemetry/core'
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources'
import {
  SimpleSpanProcessor,
  TracerProvider,
  type IdGenerator,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace'
import { CassetteMissError, type Mode } from './cassettes.js'
import { BudgetExceededError, SchemaViolationError, type CallRecord } from './model-client.js'
import { redactSecrets } from './redact.js'
import { TransportError } from './transport.js'

/** Re-exported so the OpenTelemetry SDK is imported in this module and no other. */
export type { IdGenerator }

/**
 * OpenTelemetry spans for one `npm run agents:analyze`, written to `otel-spans.json`.
 *
 * What is instrumented is the pipeline's own decisions — how long a
 * classification took, what it cost, where it retried — not the application
 * under test. A file rather than a collector, per ADR-0001: nothing has to be
 * running to capture it, and the `analyze` job uploads it in the
 * `triage-report` artifact beside the report it explains.
 *
 * **Exporting never fails the run.** The file is written once, at the end, by
 * `RunSpans.close`, which logs a failure and returns. A run whose classifier
 * worked and whose instrumentation did not is a run that worked.
 *
 * **Atomic.** Written to a temp file and renamed into place, so a run killed
 * part-way leaves the previous file or none — never half of one that `jq`
 * then refuses.
 *
 * **A collector is optional, and never instead of the file.** With
 * `SENTRA_OTLP_ENDPOINT` set, the same spans are sent over OTLP/HTTP once the
 * file is written — for `observability/docker-compose.yml`, a local Jaeger to
 * read them in. Unset, which is the default and always the case in CI, the OTLP
 * exporter is not even loaded. Set, it is held to the same rule as the file: a
 * collector that is missing, refuses or never answers costs a logged line and
 * at most `COLLECTOR_TIMEOUT_MS`, never the exit code. See `sendToCollector`.
 *
 * ## What a span may carry
 *
 * Identifiers, counts, enums and numbers. Never a test title, an error message,
 * a diff, a prompt or anything a model wrote: all of that is text a contributor
 * controls, and this file ends up somewhere a reader trusts. The three strings
 * that come from outside the code — run id, commit and branch — must look like
 * identifiers and are passed through `redactSecrets` as well; anything else is
 * recorded as `[withheld]`. Exceptions are reduced to `error.type`, a closed
 * set, rather than recorded: `recordException` would copy the message and the
 * stack, and the message is where a test title ends up.
 *
 * ## The file
 *
 * One JSON document, indented so that a person and `jq` can both read it:
 *
 *     {
 *       "schemaVersion": 1,
 *       "resource": { "service.name": "sentra", "telemetry.sdk.version": "3.1.0", … },
 *       "scope": { "name": "@sentra/agents" },
 *       "spans": [ … ]          // the run first, then each model call by start time
 *     }
 *
 * Every span has `traceId`, `spanId`, `parentSpanId` (model calls only),
 * `name`, `kind`, `startTime` and `endTime` (ISO-8601), `durationMs`,
 * `status` (`{ code: UNSET | OK | ERROR, message? }`) and flat `attributes`.
 *
 * **The run** — `sentra.run`, kind `INTERNAL`, one per file:
 *
 * | attribute                     | value                                                         |
 * | ----------------------------- | ------------------------------------------------------------- |
 * | `sentra.run.id`               | `analysis.json`'s `runId`                                     |
 * | `sentra.run.commit`           | the commit analysed                                           |
 * | `sentra.run.branch`           | the branch, shape-checked and redacted                        |
 * | `sentra.run.classifier`       | `model`, or `baseline` when no model could run                |
 * | `sentra.run.degraded`         | the report carries a degradation, or a test went unclassified |
 * | `sentra.run.notices`          | how many degradation notices the report opens with            |
 * | `sentra.run.tests.considered` | tests selected for triage                                     |
 * | `sentra.run.tests.classified` | of those, how many got a verdict                              |
 * | `sentra.run.calls`            | model calls made, including failed ones                       |
 * | `sentra.run.input_tokens`     | billed input tokens, summed over the calls                    |
 * | `sentra.run.output_tokens`    | billed output tokens, likewise                                |
 * | `sentra.run.cost_usd`         | the priced calls' cost, from `agents/pricing.ts`              |
 * | `sentra.run.unpriced_calls`   | calls to a model `pricing.ts` has no price for                |
 * | `sentra.budget.limit`         | the input-token budget                                        |
 * | `sentra.budget.used`          | billed input tokens charged against it                        |
 * | `sentra.cassette.mode`        | `replay`, `record` or `live`, when cassettes are in play      |
 *
 * Every token figure here is a sum over the usage ledger (`agents/ledger.ts`),
 * the same list the report footer totals, so the run's tokens, its cost and
 * `sentra.budget.used` agree with the footer by construction.
 *
 * A run that crashed before its report was written still gets a root span,
 * with status `ERROR` and message `incomplete`.
 *
 * **Each model call** — `chat <model>`, kind `CLIENT`, a child of the run.
 * Named and attributed per the OpenTelemetry GenAI semantic conventions where
 * they have a name for the thing, and under `sentra.` where they do not:
 *
 * | attribute                        | value                                                |
 * | -------------------------------- | ---------------------------------------------------- |
 * | `gen_ai.operation.name`          | `chat`                                               |
 * | `gen_ai.provider.name`           | `anthropic`                                          |
 * | `gen_ai.agent.name`              | `triage`, `root-cause` or `fix-suggestion`           |
 * | `gen_ai.request.model`           | what `MODEL_CONFIG` asked for                        |
 * | `gen_ai.response.model`          | what answered; absent if nothing did                 |
 * | `gen_ai.request.max_tokens`      | the output ceiling                                   |
 * | `gen_ai.usage.input_tokens`      | billed, over every attempt that got a response       |
 * | `gen_ai.usage.output_tokens`     | likewise                                             |
 * | `error.type`                     | on failure only — see below                          |
 * | `sentra.prompt.version`          | e.g. `triage.v1`                                     |
 * | `sentra.call.outcome`            | `ok`, `refused`, `schema-invalid`, `budget`, `error` |
 * | `sentra.call.attempts`           | dispatches, including schema retries                 |
 * | `sentra.call.schema_violations`  | answers rejected by the schema                       |
 * | `sentra.call.transient_failures` | rate limits and server faults retried                |
 * | `sentra.call.cost_usd`           | absent when the model is unpriced                    |
 * | `sentra.cassette.mode`           | as on the run                                        |
 * | `sentra.cassette.hit`            | whether a recorded answer served the call            |
 *
 * `error.type` is `rate-limit`, `server`, `client` or `refusal` for a transport
 * failure, else `budget-exceeded`, `schema-violation`, `cassette-miss` or
 * `_OTHER`. Latency is the span's own duration. Costs are in US dollars,
 * rounded to a millionth.
 *
 * Useful first questions:
 *
 *     jq '.spans[0].attributes' otel-spans.json
 *     jq '.spans[1:][] | {agent: .attributes["gen_ai.agent.name"], ms: .durationMs,
 *         outcome: .attributes["sentra.call.outcome"]}' otel-spans.json
 */

/** Where the spans go unless `--spans` says otherwise. The `analyze` job uploads this path. */
export const SPANS_FILE = 'otel-spans.json'

/** Bumped when a field is renamed or removed; additions do not bump it. */
export const SPANS_SCHEMA_VERSION = 1

/** Recorded in place of a string that does not look like an identifier. */
export const WITHHELD = '[withheld]'

const SCOPE = '@sentra/agents'

/**
 * What an attribute here may hold: a string, a number or a boolean.
 *
 * `@opentelemetry/api` 1.10 types every attribute value as `unknown`, and SDK 3
 * records an object or a mixed array where 2.x dropped it. Together those let a
 * structure carrying a test title reach the file with no type error and nothing
 * at runtime to stop it, so every attribute below is built against this type
 * rather than `Attributes`.
 */
type FlatAttributes = Readonly<Record<string, string | number | boolean>>

/**
 * What an identifier may look like to be recorded.
 *
 * Wide enough for a numeric run id, a hex SHA, `dependabot/npm_and_yarn/vite-8.3.8`
 * and every model id, and narrow enough that a branch named to carry a sentence,
 * markup or a shell substitution does not: none of those survive without a
 * space, a quote, a bracket or a dollar sign.
 */
const IDENTIFIER = /^[\w.@/:+-]{1,200}$/

/**
 * A string from outside the code, made safe to record.
 *
 * Shape first, then redaction: a token is perfectly identifier-shaped, and a
 * branch named after one would otherwise pass.
 */
export function identifier(value: string): string {
  return IDENTIFIER.test(value) ? redactSecrets(value).text : WITHHELD
}

/**
 * Rounded to a millionth of a dollar. A sum of float prices otherwise prints as
 * `0.07250000000000001`, which claims a precision nobody has; a single call is
 * still thousands of these units, so nothing a reader would compare is lost.
 */
const dollars = (usd: number): number => Math.round(usd * 1_000_000) / 1_000_000

/** `triage.v1` → `triage`. The prompt registry's naming rule, read backwards. */
function agentName(promptVersion: string): string | undefined {
  return /^([a-z][a-z-]*)\.v[1-9]\d*$/.exec(promptVersion)?.[1]
}

/**
 * The class of failure a call ended with, as a closed set.
 *
 * Classified by type and never by message. The message of a schema violation
 * names the test it was triaging, and a transport error can quote the response.
 */
export function spanErrorType(error: unknown): string {
  if (error instanceof TransportError) return error.kind
  if (error instanceof BudgetExceededError) return 'budget-exceeded'
  if (error instanceof SchemaViolationError) return 'schema-violation'
  if (error instanceof CassetteMissError) return 'cassette-miss'
  return '_OTHER'
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Write `contents` to `path` through a temp file and a rename.
 *
 * The same shape as `writeHistory` in flakemetry-lib, for the same reason: a
 * reader should find the old file or the new one, never a prefix of the new
 * one. A failed write removes its own temp file before rethrowing.
 */
export function writeFileAtomically(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${String(process.pid)}.tmp`
  try {
    writeFileSync(temp, contents)
    renameSync(temp, path)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // Best-effort. Reporting the cleanup instead of the write would hide the
      // reason it failed behind a less useful one.
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// The exporter
// ---------------------------------------------------------------------------

export interface FileSpanExporterOptions {
  path: string
  /** Injected so a test can capture the document instead of touching the disk. */
  write?: (path: string, contents: string) => void
}

/**
 * A `SpanExporter` that keeps finished spans in memory and writes them once, on
 * shutdown.
 *
 * Once rather than per span because the file has to be a single valid document
 * at every moment anyone could read it, and appending to JSON cannot promise
 * that. A run has a handful of spans; holding them costs nothing.
 */
export class FileSpanExporter implements SpanExporter {
  private readonly finished: ReadableSpan[] = []
  private readonly write: (path: string, contents: string) => void

  constructor(private readonly options: FileSpanExporterOptions) {
    this.write = options.write ?? writeFileAtomically
  }

  get path(): string {
    return this.options.path
  }

  get count(): number {
    return this.finished.length
  }

  /** What the file holds, for a collector to be sent the same spans. */
  get spans(): readonly ReadableSpan[] {
    return this.finished
  }

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    this.finished.push(...spans)
    done({ code: ExportResultCode.SUCCESS })
  }

  forceFlush(): Promise<void> {
    return Promise.resolve()
  }

  /** Rejects, rather than throwing, when the write fails — the SDK awaits it. */
  shutdown(): Promise<void> {
    return new Promise((resolve) => {
      this.write(this.options.path, render(this.finished))
      resolve()
    })
  }
}

const KIND: Record<SpanKind, string> = {
  [SpanKind.INTERNAL]: 'INTERNAL',
  [SpanKind.SERVER]: 'SERVER',
  [SpanKind.CLIENT]: 'CLIENT',
  [SpanKind.PRODUCER]: 'PRODUCER',
  [SpanKind.CONSUMER]: 'CONSUMER',
}

const STATUS: Record<SpanStatusCode, string> = {
  [SpanStatusCode.UNSET]: 'UNSET',
  [SpanStatusCode.OK]: 'OK',
  [SpanStatusCode.ERROR]: 'ERROR',
}

const iso = (time: ReadableSpan['startTime']): string =>
  new Date(hrTimeToMilliseconds(time)).toISOString()

/**
 * The document, with the run first and the calls after it in start order.
 *
 * Sorted because the exporter receives spans as they end, which is completion
 * order — the run last, and its calls in whatever order the network returned
 * them. That is the wrong order to read a run in.
 */
export function render(spans: readonly ReadableSpan[]): string {
  const ordered = [...spans].sort(
    (a, b) =>
      Number(a.parentSpanContext !== undefined) - Number(b.parentSpanContext !== undefined) ||
      hrTimeToMilliseconds(a.startTime) - hrTimeToMilliseconds(b.startTime),
  )
  const first = ordered[0]

  const document = {
    schemaVersion: SPANS_SCHEMA_VERSION,
    resource: first?.resource.attributes ?? {},
    scope: { name: first?.instrumentationScope.name ?? SCOPE },
    spans: ordered.map((span) => ({
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
      ...(span.parentSpanContext !== undefined && {
        parentSpanId: span.parentSpanContext.spanId,
      }),
      name: span.name,
      kind: KIND[span.kind],
      startTime: iso(span.startTime),
      endTime: iso(span.endTime),
      durationMs: hrTimeToMilliseconds(span.duration),
      status: {
        code: STATUS[span.status.code],
        ...(span.status.message !== undefined && { message: span.status.message }),
      },
      attributes: span.attributes,
    })),
  }

  return `${JSON.stringify(document, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// An optional collector
// ---------------------------------------------------------------------------

/**
 * The variable that sends a run's spans to an OTLP collector as well as to the file.
 *
 * A base URL, the form `OTEL_EXPORTER_OTLP_ENDPOINT` takes: `/v1/traces` is
 * appended. Its own name rather than the standard one, so that a runner or a
 * shell that happens to export the standard variable for something else does
 * not start shipping this project's spans anywhere. Opting in is a decision
 * about this project, made with this project's variable.
 */
export const COLLECTOR_VARIABLE = 'SENTRA_OTLP_ENDPOINT'

/**
 * How long a run waits for a collector, all told, before giving up on it.
 *
 * Long enough for a local collector on a loaded laptop; short enough that a
 * forgotten `SENTRA_OTLP_ENDPOINT` pointing at nothing costs two seconds once
 * per run rather than a hang.
 */
export const COLLECTOR_TIMEOUT_MS = 2_000

export interface CollectorOptions {
  endpoint: string
  timeoutMillis?: number
  /** Builds the exporter. Injected so a test needs no collector; OTLP over HTTP otherwise. */
  exporter?: (url: string, timeoutMillis: number) => SpanExporter | Promise<SpanExporter>
}

/** The collector the environment asks for, or none. Unset and empty both mean none. */
export function collectorFrom(env: NodeJS.ProcessEnv): CollectorOptions | undefined {
  const endpoint = (env[COLLECTOR_VARIABLE] ?? '').trim()
  return endpoint === '' ? undefined : { endpoint }
}

/**
 * `http://localhost:4318` → `http://localhost:4318/v1/traces`.
 *
 * Null for anything that is not an http(s) URL. A value that ends in the
 * traces path already is used as it is, so pasting a full endpoint works too.
 */
export function tracesUrl(endpoint: string): URL | null {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.pathname.endsWith('/v1/traces')) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/traces`
  }
  return url
}

/** The URL as a log line may show it: no credentials, no query. */
const shown = (url: URL): string => `${url.protocol}//${url.host}${url.pathname}`

/**
 * OTLP over HTTP, loaded only when a collector is asked for.
 *
 * Imported on demand rather than at the top of the file, so a default run —
 * every CI run — pays nothing for an exporter it never uses. `architecture.md`
 * records what loading the SDK costs, and this keeps that figure true.
 */
async function otlpOverHttp(url: string, timeoutMillis: number): Promise<SpanExporter> {
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http')
  return new OTLPTraceExporter({ url, timeoutMillis })
}

/**
 * Settles with `promise`, or rejects once `ms` have passed.
 *
 * The loser is not left to reject unobserved, which would take the process down
 * under Node's default, and the timer does not hold the process open by itself.
 */
function within<T>(ms: number, promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined)
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        reject(new Error(`no answer within ${String(ms)} ms`))
      },
      Math.max(0, ms),
    )
    timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer)
  })
}

/**
 * Send the run's spans to a collector. Never throws, and never takes longer
 * than the timeout.
 *
 * Called after the file is written, never before or instead: the file is the
 * record CI uploads, and a collector must not be able to delay or prevent it.
 * One deadline covers building the exporter, the export and its shutdown,
 * because the exporter's own retries are bounded by its timeout but its
 * shutdown waits on whatever is still in flight.
 */
export async function sendToCollector(
  spans: readonly ReadableSpan[],
  options: CollectorOptions,
  log: (message: string) => void,
): Promise<void> {
  const url = tracesUrl(options.endpoint)
  if (url === null) {
    log(
      `  ${COLLECTOR_VARIABLE} is not an http(s) URL, so no spans were sent to a collector — ` +
        'the run is unaffected',
    )
    return
  }

  const timeout = options.timeoutMillis ?? COLLECTOR_TIMEOUT_MS
  const deadline = Date.now() + timeout
  const build = options.exporter ?? otlpOverHttp
  let exporter: SpanExporter | undefined

  try {
    const result = await within(
      timeout,
      (async (): Promise<ExportResult> => {
        const built = await build(url.toString(), timeout)
        exporter = built
        return new Promise<ExportResult>((resolve) => {
          built.export([...spans], resolve)
        })
      })(),
    )
    log(
      result.code === ExportResultCode.SUCCESS
        ? `  sent ${String(spans.length)} span(s) to ${shown(url)}`
        : `  could not send spans to ${shown(url)}: ${reason(result.error)} — the run is unaffected`,
    )
  } catch (error) {
    log(`  could not send spans to ${shown(url)}: ${reason(error)} — the run is unaffected`)
  } finally {
    if (exporter !== undefined) {
      await within(deadline - Date.now(), exporter.shutdown()).catch(() => undefined)
    }
  }
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

export interface RunIdentity {
  runId: string
  commitSha: string
  branch: string
}

export interface RunSpansOptions {
  path?: string
  write?: (path: string, contents: string) => void
  /** Epoch milliseconds. Injected so a test can pin timestamps. */
  now?: () => number
  /** Injected so a test can pin trace and span ids. Random otherwise. */
  idGenerator?: IdGenerator
  /** Absent when the transport is not the cassette decorator — a test stub, say. */
  cassetteMode?: Mode
  budgetLimit: number
  /** Where to send the spans as well as the file. Absent — the default — sends them nowhere else. */
  collector?: CollectorOptions
}

/** How the run ended. Recorded on the root span by `RunSpans.complete`. */
export interface RunOutcome {
  classifier: 'model' | 'baseline'
  degraded: boolean
  notices: number
  considered: number
  classified: number
  budgetUsed: number
}

/**
 * The spans for one run: a root opened on construction, a child per model call
 * through `onCall`, and the file written by `close`.
 *
 * The provider is private to the run rather than registered globally. A global
 * provider is state every later test in the same worker inherits, and nothing
 * here needs context to propagate implicitly — the only parent a call span ever
 * has is the run, and it is passed explicitly.
 */
export class RunSpans {
  private readonly exporter: FileSpanExporter
  private readonly provider: TracerProvider
  private readonly tracer: Tracer
  private readonly root: Span
  private readonly parent: Context
  private readonly now: () => number
  private readonly cassetteMode: Mode | undefined
  private readonly collector: CollectorOptions | undefined
  private readonly totals = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpriced: 0 }
  private completed = false

  constructor(run: RunIdentity, options: RunSpansOptions) {
    this.now = options.now ?? Date.now
    this.cassetteMode = options.cassetteMode
    this.collector = options.collector
    this.exporter = new FileSpanExporter({
      path: options.path ?? SPANS_FILE,
      ...(options.write !== undefined && { write: options.write }),
    })
    this.provider = new TracerProvider({
      resource: defaultResource().merge(resourceFromAttributes({ 'service.name': 'sentra' })),
      spanProcessors: [new SimpleSpanProcessor({ exporter: this.exporter })],
      ...(options.idGenerator !== undefined && { idGenerator: options.idGenerator }),
    })
    this.tracer = this.provider.getTracer(SCOPE)

    this.root = this.tracer.startSpan(
      'sentra.run',
      {
        kind: SpanKind.INTERNAL,
        startTime: new Date(this.now()),
        attributes: {
          'sentra.run.id': identifier(run.runId),
          'sentra.run.commit': identifier(run.commitSha),
          'sentra.run.branch': identifier(run.branch),
          'sentra.budget.limit': options.budgetLimit,
          ...(this.cassetteMode !== undefined && { 'sentra.cassette.mode': this.cassetteMode }),
        } satisfies FlatAttributes,
      },
      ROOT_CONTEXT,
    )
    this.parent = trace.setSpan(ROOT_CONTEXT, this.root)
  }

  /**
   * One span per model call. Bound, so it can be handed straight to the pipeline.
   *
   * Tokens and cost are copied from the record, never recomputed: `callModel`
   * sums them from the usage ledger, and a second pricing here would be a second
   * number with every chance of disagreeing with the footer.
   */
  readonly onCall = (call: CallRecord): void => {
    const agent = agentName(call.promptVersion)
    const failed = call.outcome !== 'ok'

    this.totals.calls += 1
    this.totals.inputTokens += call.inputTokens
    this.totals.outputTokens += call.outputTokens
    if (call.costUsd === undefined) this.totals.unpriced += 1
    else this.totals.costUsd += call.costUsd

    const attributes: FlatAttributes = {
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'anthropic',
      ...(agent !== undefined && { 'gen_ai.agent.name': agent }),
      'gen_ai.request.model': identifier(call.requestModel),
      ...(call.responseModel !== undefined && {
        'gen_ai.response.model': identifier(call.responseModel),
      }),
      'gen_ai.request.max_tokens': call.maxTokens,
      'gen_ai.usage.input_tokens': call.inputTokens,
      'gen_ai.usage.output_tokens': call.outputTokens,
      ...(failed && { 'error.type': spanErrorType(call.error) }),
      'sentra.prompt.version': identifier(call.promptVersion),
      'sentra.call.outcome': call.outcome,
      'sentra.call.attempts': call.attempts,
      'sentra.call.schema_violations': call.schemaViolations,
      'sentra.call.transient_failures': call.transientFailures,
      ...(call.costUsd !== undefined && { 'sentra.call.cost_usd': dollars(call.costUsd) }),
      ...(this.cassetteMode !== undefined && {
        'sentra.cassette.mode': this.cassetteMode,
        // In replay every call is served from a cassette or fails for want of
        // one; in record and live none is.
        'sentra.cassette.hit':
          this.cassetteMode === 'replay' && !(call.error instanceof CassetteMissError),
      }),
    }

    const span = this.tracer.startSpan(
      `chat ${identifier(call.requestModel)}`,
      { kind: SpanKind.CLIENT, startTime: new Date(call.startedAt), attributes },
      this.parent,
    )
    if (failed) span.setStatus({ code: SpanStatusCode.ERROR, message: call.outcome })
    span.end(new Date(call.startedAt + call.durationMs))
  }

  /** Records how the run ended. A run that never gets here is exported as incomplete. */
  complete(outcome: RunOutcome): void {
    this.completed = true
    this.root.setAttributes({
      'sentra.run.classifier': outcome.classifier,
      'sentra.run.degraded': outcome.degraded,
      'sentra.run.notices': outcome.notices,
      'sentra.run.tests.considered': outcome.considered,
      'sentra.run.tests.classified': outcome.classified,
      'sentra.budget.used': outcome.budgetUsed,
    } satisfies FlatAttributes)
  }

  /**
   * End the run's span, write the file, and send the spans to a collector if
   * one was asked for. Never throws.
   *
   * A failure is logged and swallowed: the exit code belongs to the pipeline,
   * and `agents/run.ts` exits 0 whenever the pipeline worked.
   */
  async close(log: (message: string) => void): Promise<void> {
    try {
      this.root.setAttributes({
        'sentra.run.calls': this.totals.calls,
        'sentra.run.input_tokens': this.totals.inputTokens,
        'sentra.run.output_tokens': this.totals.outputTokens,
        'sentra.run.cost_usd': dollars(this.totals.costUsd),
        'sentra.run.unpriced_calls': this.totals.unpriced,
      } satisfies FlatAttributes)
      if (!this.completed) {
        this.root.setStatus({ code: SpanStatusCode.ERROR, message: 'incomplete' })
      }
      this.root.end(new Date(this.now()))

      await this.provider.forceFlush()
      await this.provider.shutdown()
      log(`  wrote ${this.exporter.path} (${String(this.exporter.count)} span(s))`)
    } catch (error) {
      log(`  could not write ${this.exporter.path}: ${reason(error)} — the run is unaffected`)
    }

    // After the file, whatever became of it: the spans are in memory either way,
    // and a collector that fails or hangs has already been kept from the file.
    if (this.collector !== undefined) {
      await sendToCollector(this.exporter.spans, this.collector, log)
    }
  }
}

/**
 * Why something failed, in a few words.
 *
 * `forceFlush` rejects with an array of errors, which `String` renders legibly
 * enough. A refused connection is an `AggregateError` with an empty message,
 * so its code is the useful part.
 */
const reason = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error)
  if (error.message !== '') return error.message
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : error.name
}
