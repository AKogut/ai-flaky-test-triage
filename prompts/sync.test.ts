import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadRubric } from './registry.js'
import {
  BEGIN_MARKER,
  END_MARKER,
  SyncError,
  TAXONOMY_DOC,
  fileDeps,
  main,
  syncedDoc,
} from './sync.js'

const doc = (middle: string): string =>
  `# Taxonomy\n\n## The rubric\n\n${BEGIN_MARKER}\n${middle}\n${END_MARKER}\n\n## After\n`

describe('generating the block', () => {
  it('replaces whatever was between the markers', () => {
    expect(syncedDoc(doc('stale text'), 'fresh')).toContain('fresh')
    expect(syncedDoc(doc('stale text'), 'fresh')).not.toContain('stale text')
  })

  it('leaves the rest of the document alone', () => {
    const result = syncedDoc(doc('old'), 'new')
    expect(result.startsWith('# Taxonomy\n\n## The rubric\n\n')).toBe(true)
    expect(result.endsWith('\n\n## After\n')).toBe(true)
  })

  /** `--check` compares by running the generator; a generator that drifts would never settle. */
  it('is idempotent', () => {
    const once = syncedDoc(doc('old'), 'new')
    expect(syncedDoc(once, 'new')).toBe(once)
  })

  it('says where to edit, inside the block a reader is looking at', () => {
    expect(syncedDoc(doc(''), 'new')).toContain('npm run prompts:sync')
  })

  it.each([
    ['no markers at all', '# Taxonomy\n'],
    ['only an opener', `# Taxonomy\n${BEGIN_MARKER}\n`],
    ['only a closer', `# Taxonomy\n${END_MARKER}\n`],
    ['markers in the wrong order', `${END_MARKER}\nrubric\n${BEGIN_MARKER}`],
  ])('refuses a document with %s', (_case, contents) => {
    expect(() => syncedDoc(contents, 'rubric')).toThrow(SyncError)
  })
})

describe('the CLI', () => {
  const fresh = syncedDoc(doc('old'), 'rubric text')

  it('reports success and writes nothing when already in sync', () => {
    const writes: string[] = []
    const code = main([], {
      readDoc: () => fresh,
      writeDoc: (_path, text) => writes.push(text),
      rubric: () => 'rubric text',
      log: () => undefined,
    })
    expect(code).toBe(0)
    expect(writes).toEqual([])
  })

  it('writes the block when it is stale', () => {
    const writes: string[] = []
    const code = main([], {
      readDoc: () => doc('old'),
      writeDoc: (_path, text) => writes.push(text),
      rubric: () => 'rubric text',
      log: () => undefined,
    })
    expect(code).toBe(0)
    expect(writes[0]).toBe(fresh)
  })

  it('fails under --check instead of writing, and says what drift costs', () => {
    const writes: string[] = []
    const lines: string[] = []
    const code = main(['--check'], {
      readDoc: () => doc('old'),
      writeDoc: (_path, text) => writes.push(text),
      rubric: () => 'rubric text',
      log: (message) => lines.push(message),
    })
    expect(code).toBe(1)
    expect(writes).toEqual([])
    expect(lines.join('\n')).toContain('agreement with a rule nobody applied')
    expect(lines.join('\n')).toContain('npm run prompts:sync')
  })
})

describe('the real filesystem', () => {
  it('round-trips a document unchanged', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sentra-sync-')), 'doc.md')
    fileDeps.writeDoc(path, 'contents\n')
    expect(fileDeps.readDoc(path)).toBe('contents\n')
  })

  it('reads the same rubric the loader does', () => {
    expect(fileDeps.rubric()).toBe(loadRubric())
  })
})

/**
 * The invariant itself, asserted here rather than only in CI.
 *
 * A check that lives only in a workflow file holds until someone runs the tests
 * locally, sees green, and pushes a rubric edit that CI then rejects — which is
 * a slower and more confusing way to learn the same thing.
 */
describe('the committed documentation', () => {
  it('carries the current rubric', () => {
    const current = readFileSync(TAXONOMY_DOC, 'utf8')
    expect(current).toBe(syncedDoc(current, loadRubric()))
  })
})
