import { z } from 'zod'

/**
 * What the agents are allowed to return.
 *
 * These schemas are the only thing standing between a language model and the
 * rest of the pipeline. Two constraints from docs/agent-design.md are load-
 * bearing and are enforced here rather than asked for in a prompt, because a
 * prompt is a request and a schema is a guarantee:
 *
 *  - `RootCause.alternativeHypothesis` is required below the confidence
 *    threshold. A single confident-sounding explanation is the most dangerous
 *    output this system produces — it redirects a developer's attention with
 *    more authority than it has earned.
 *  - `evidence` and `risks` are non-empty. Both exist to make overconfidence
 *    visible in review rather than buried in a decimal.
 *
 * Every free-text field is length-capped. Uncapped prose in a PR comment is a
 * denial-of-attention attack even when nobody meant it as one.
 */

// ---------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------

/** Where the fix goes. Answers "is this mine?" — see docs/taxonomy.md. */
export const OwnerSchema = z.enum(['app_code', 'test_code', 'environment'])
export type Owner = z.infer<typeof OwnerSchema>

/** How it behaves on rerun. Answers "will rerunning help?". */
export const DeterminismSchema = z.enum(['deterministic', 'intermittent'])
export type Determinism = z.infer<typeof DeterminismSchema>

export const ClassificationSchema = z
  .object({
    owner: OwnerSchema,
    determinism: DeterminismSchema,
    confidence: z.number().min(0).max(1),
    reasoning: z.string().min(1).max(400),

    /**
     * Fragments quoted from the input the decision rests on.
     *
     * Not decoration. Requiring the model to quote what it relied on makes a
     * fabricated justification visible in review, and gives the eval harness
     * something to check beyond the label itself.
     */
    evidence: z.array(z.string().min(1).max(500)).min(1).max(6),
  })
  .strict()
export type Classification = z.infer<typeof ClassificationSchema>

/** The six cells of the taxonomy matrix, as one string for reports and metrics. */
export function quadrantOf(c: Pick<Classification, 'owner' | 'determinism'>): string {
  return `${c.owner}+${c.determinism}`
}

/** `app_code` + `intermittent` — the quadrant the project exists for. */
export function isHardQuadrant(c: Pick<Classification, 'owner' | 'determinism'>): boolean {
  return c.owner === 'app_code' && c.determinism === 'intermittent'
}

// ---------------------------------------------------------------------------
// Root cause
// ---------------------------------------------------------------------------

/**
 * Confidence below which a stated alternative is mandatory.
 *
 * Distinct from `SENTRA_ROOT_CAUSE_THRESHOLD`, which decides whether the agent
 * runs at all and is derived from the calibration curve. This one is about what
 * a hypothesis must contain once it exists.
 */
export const ALTERNATIVE_REQUIRED_BELOW = 0.7

export const MechanismSchema = z.enum([
  'race',
  'null_handling',
  'state_leak',
  'logic_error',
  'api_contract',
  'timing',
  'other',
])
export type Mechanism = z.infer<typeof MechanismSchema>

export const RootCauseSchema = z
  .object({
    hypothesis: z.string().min(1).max(600),
    implicatedFiles: z.array(z.string().min(1).max(300)).max(10),
    implicatedSymbols: z.array(z.string().min(1).max(200)).max(20),
    mechanism: MechanismSchema,
    confidence: z.number().min(0).max(1),
    alternativeHypothesis: z.string().min(1).max(600).optional(),
  })
  .strict()
  .refine(
    (v) => v.confidence >= ALTERNATIVE_REQUIRED_BELOW || v.alternativeHypothesis !== undefined,
    {
      message: `alternativeHypothesis is required when confidence is below ${String(ALTERNATIVE_REQUIRED_BELOW)}`,
      path: ['alternativeHypothesis'],
    },
  )
export type RootCause = z.infer<typeof RootCauseSchema>

// ---------------------------------------------------------------------------
// Fix suggestion
// ---------------------------------------------------------------------------

export const FixSuggestionSchema = z
  .object({
    summary: z.string().min(1).max(200),
    approach: z.string().min(1).max(800),

    /**
     * Illustrative only. Rendered inside a fenced code block and never applied —
     * there is no code path from here to a filesystem write, and #69 asserts it.
     */
    patch: z.string().max(4000).optional(),

    /**
     * What this fix could break. Non-empty on purpose: a suggestion without
     * stated risks reads as more authoritative than it has earned.
     */
    risks: z.array(z.string().min(1).max(300)).min(1).max(6),

    /**
     * What test would have caught this earlier. For a flaky-test system the most
     * valuable output is often "the real problem is that nothing tests this path".
     */
    testGap: z.string().min(1).max(400).optional(),
  })
  .strict()
export type FixSuggestion = z.infer<typeof FixSuggestionSchema>

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/**
 * JSON Schema handed to the model as a tool definition.
 *
 * Generated from the Zod schema rather than written alongside it, so the thing
 * the model is told to produce and the thing the response is validated against
 * cannot disagree. Two hand-written copies would drift, and the symptom would be
 * a model dutifully returning a shape the validator rejects — read as "the model
 * is unreliable" rather than "our tool definition is stale".
 */
export function toolSchema(schema: z.ZodType): JsonSchemaObject {
  return z.toJSONSchema(schema, { io: 'input', target: 'draft-7' }) as unknown as JsonSchemaObject
}

/** The Anthropic tool-definition shape. `input_schema` is JSON Schema. */
export interface ToolDefinition {
  name: string
  description: string
  input_schema: JsonSchemaObject
}

export interface JsonSchemaObject {
  type: string
  properties?: Record<string, JsonSchemaProperty>
  required?: string[]
  additionalProperties?: boolean
  [key: string]: unknown
}

export interface JsonSchemaProperty {
  type?: string | string[]
  enum?: string[]
  [key: string]: unknown
}

export const TRIAGE_TOOL: ToolDefinition = {
  name: 'record_classification',
  description:
    'Record the classification of one test failure on both axes, with the evidence it rests on.',
  input_schema: toolSchema(ClassificationSchema),
}

export const ROOT_CAUSE_TOOL: ToolDefinition = {
  name: 'record_root_cause',
  description:
    'Record a hypothesis for why the product failed, the files and symbols implicated, and — when confidence is low — a stated alternative.',
  input_schema: toolSchema(RootCauseSchema),
}

export const FIX_SUGGESTION_TOOL: ToolDefinition = {
  name: 'record_fix_suggestion',
  description:
    'Record a text-only fix suggestion, the risks it carries, and the test that would have caught the failure earlier.',
  input_schema: toolSchema(FixSuggestionSchema),
}
