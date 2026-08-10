import { describe, expect, it } from 'vitest'
import {
  ALTERNATIVE_REQUIRED_BELOW,
  ClassificationSchema,
  FIX_SUGGESTION_TOOL,
  FixSuggestionSchema,
  isHardQuadrant,
  quadrantOf,
  ROOT_CAUSE_TOOL,
  RootCauseSchema,
  TRIAGE_TOOL,
} from './agent-output.js'

const classification = {
  owner: 'app_code' as const,
  determinism: 'intermittent' as const,
  confidence: 0.8,
  reasoning: 'The diff touches the optimistic reorder path and history alternates.',
  evidence: ['history: PPFPFP', 'diff touches app/client/board.tsx'],
}

const rootCause = {
  hypothesis: 'The optimistic update is applied before the server response is reconciled.',
  implicatedFiles: ['app/client/board.tsx'],
  implicatedSymbols: ['reorderTask'],
  mechanism: 'race' as const,
  confidence: 0.9,
}

const fix = {
  summary: 'Reconcile against the server order before repainting.',
  approach: 'Await the reorder response and apply the returned order.',
  risks: ['Adds perceived latency to the drag interaction.'],
}

describe('ClassificationSchema', () => {
  it('accepts a well-formed classification', () => {
    expect(ClassificationSchema.parse(classification).owner).toBe('app_code')
  })

  it('requires at least one piece of evidence', () => {
    // Evidence is what makes a fabricated justification visible in review.
    expect(() => ClassificationSchema.parse({ ...classification, evidence: [] })).toThrow()
  })

  it('caps reasoning length', () => {
    expect(() =>
      ClassificationSchema.parse({ ...classification, reasoning: 'x'.repeat(401) }),
    ).toThrow()
  })

  it('rejects a label outside the taxonomy', () => {
    expect(() => ClassificationSchema.parse({ ...classification, owner: 'infra' })).toThrow()
  })

  it('rejects an extra field the model invented', () => {
    expect(() => ClassificationSchema.parse({ ...classification, severity: 'high' })).toThrow()
  })

  it('keeps confidence inside 0..1', () => {
    expect(() => ClassificationSchema.parse({ ...classification, confidence: 1.5 })).toThrow()
  })
})

describe('quadrants', () => {
  it('names the cell', () => {
    expect(quadrantOf(classification)).toBe('app_code+intermittent')
  })

  it('identifies the hard quadrant and nothing else', () => {
    expect(isHardQuadrant(classification)).toBe(true)
    expect(isHardQuadrant({ owner: 'test_code', determinism: 'intermittent' })).toBe(false)
    expect(isHardQuadrant({ owner: 'app_code', determinism: 'deterministic' })).toBe(false)
  })
})

describe('RootCauseSchema', () => {
  it('accepts a confident hypothesis with no alternative', () => {
    expect(RootCauseSchema.parse(rootCause).mechanism).toBe('race')
  })

  it('requires an alternative below the confidence threshold', () => {
    // The single most dangerous output this system can produce is one
    // confident-sounding explanation with nothing to weigh it against.
    expect(() =>
      RootCauseSchema.parse({ ...rootCause, confidence: ALTERNATIVE_REQUIRED_BELOW - 0.01 }),
    ).toThrow(/alternativeHypothesis is required/)
  })

  it('accepts a low-confidence hypothesis that states an alternative', () => {
    const parsed = RootCauseSchema.parse({
      ...rootCause,
      confidence: 0.4,
      alternativeHypothesis: 'The test may assert before the list settles.',
    })
    expect(parsed.alternativeHypothesis).toBeTruthy()
  })

  it('treats the threshold itself as confident', () => {
    expect(() =>
      RootCauseSchema.parse({ ...rootCause, confidence: ALTERNATIVE_REQUIRED_BELOW }),
    ).not.toThrow()
  })

  it('bounds how many files a hypothesis may implicate', () => {
    expect(() =>
      RootCauseSchema.parse({ ...rootCause, implicatedFiles: Array<string>(11).fill('a.ts') }),
    ).toThrow()
  })
})

describe('FixSuggestionSchema', () => {
  it('accepts a suggestion with stated risks', () => {
    expect(FixSuggestionSchema.parse(fix).risks).toHaveLength(1)
  })

  it('requires at least one risk', () => {
    // A suggestion without stated risks reads as more authoritative than it has
    // earned, which is how automation bias gets in.
    expect(() => FixSuggestionSchema.parse({ ...fix, risks: [] })).toThrow()
  })

  it('treats the patch as optional and bounded', () => {
    expect(FixSuggestionSchema.parse({ ...fix, patch: '- a\n+ b' }).patch).toBe('- a\n+ b')
    expect(() => FixSuggestionSchema.parse({ ...fix, patch: 'x'.repeat(4001) })).toThrow()
  })
})

describe('tool definitions', () => {
  it.each([
    ['triage', TRIAGE_TOOL],
    ['root cause', ROOT_CAUSE_TOOL],
    ['fix suggestion', FIX_SUGGESTION_TOOL],
  ])('%s tool has a name, description and object schema', (_label, tool) => {
    expect(tool.name).toMatch(/^[a-z_]+$/)
    expect(tool.description.length).toBeGreaterThan(30)
    expect(tool.input_schema.type).toBe('object')
  })

  it('derives the tool schema from the Zod schema, so the two cannot disagree', () => {
    // Two hand-written copies would drift, and the symptom is a model dutifully
    // returning a shape the validator rejects — read as "the model is
    // unreliable" rather than "our tool definition is stale".
    const properties = TRIAGE_TOOL.input_schema.properties ?? {}
    expect(Object.keys(properties).sort()).toEqual([
      'confidence',
      'determinism',
      'evidence',
      'owner',
      'reasoning',
    ])
    expect(TRIAGE_TOOL.input_schema.required).toEqual(
      expect.arrayContaining(['owner', 'determinism', 'confidence', 'reasoning', 'evidence']),
    )
  })

  it('carries the enum values into the tool schema', () => {
    const properties = TRIAGE_TOOL.input_schema.properties ?? {}
    expect(properties.owner?.enum).toEqual(['app_code', 'test_code', 'environment'])
  })
})
