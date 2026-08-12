import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CURRENT_PROMPT,
  PROMPT_DIR,
  PromptError,
  RUBRIC_FILE,
  RUBRIC_PLACEHOLDER,
  listPromptVersions,
  loadPrompt,
  loadRubric,
} from './registry.js'

const scratch = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'sentra-prompts-'))
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents)
  return dir
}

describe('loading', () => {
  it('substitutes the rubric into the prompt', () => {
    const dir = scratch({
      'rubric.md': 'Rule 1. Rule 2.\n',
      'triage.v1.md': `Before.\n\n${RUBRIC_PLACEHOLDER}\n\nAfter.\n`,
    })
    expect(loadPrompt('triage.v1', dir).system).toBe('Before.\n\nRule 1. Rule 2.\n\nAfter.')
  })

  it('reports the version it loaded, since that is what gets recorded', () => {
    const dir = scratch({ 'rubric.md': 'r', 'triage.v3.md': RUBRIC_PLACEHOLDER })
    expect(loadPrompt('triage.v3', dir).version).toBe('triage.v3')
  })

  /**
   * Sending it would put `{{evidence}}` in front of the model as though it were
   * an instruction, and the reply would look entirely ordinary.
   */
  it('refuses a template with a placeholder it cannot fill', () => {
    const dir = scratch({
      'rubric.md': 'r',
      'triage.v1.md': `${RUBRIC_PLACEHOLDER}\n{{evidence}}`,
    })
    expect(() => loadPrompt('triage.v1', dir)).toThrow(/unresolved placeholder \{\{evidence\}\}/)
  })

  it.each([
    ['no agent', '.v1'],
    ['no version', 'triage'],
    ['a zero version', 'triage.v0'],
    ['a decimal version', 'triage.v1.2'],
    ['a path traversal', '../../etc/passwd'],
  ])('rejects %s as a version', (_case, version) => {
    expect(() => loadPrompt(version, PROMPT_DIR)).toThrow(PromptError)
  })

  it('names what does exist when a version does not', () => {
    const dir = scratch({ 'rubric.md': 'r', 'triage.v1.md': RUBRIC_PLACEHOLDER })
    expect(() => loadPrompt('triage.v9', dir)).toThrow(/found triage\.v1/)
  })

  it('says so plainly when the directory has no prompts at all', () => {
    const dir = scratch({ 'rubric.md': 'r' })
    expect(() => loadPrompt('triage.v1', dir)).toThrow(/found none/)
  })

  it('says which file is missing when the rubric is gone', () => {
    const dir = scratch({ 'triage.v1.md': RUBRIC_PLACEHOLDER })
    expect(() => loadRubric(dir)).toThrow(/rubric is missing/)
  })

  it('lists versions from the directory rather than a list to maintain', () => {
    const dir = scratch({
      'rubric.md': 'r',
      'triage.v2.md': 'x',
      'triage.v1.md': 'x',
      'README.md': 'x',
      'notes.txt': 'x',
    })
    expect(listPromptVersions(dir)).toEqual(['triage.v1', 'triage.v2'])
  })

  it('treats a missing directory as no prompts rather than an error', () => {
    expect(listPromptVersions(join(tmpdir(), 'sentra-does-not-exist'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The repository's own prompts
// ---------------------------------------------------------------------------

describe('the committed prompts', () => {
  const versions = listPromptVersions()

  it('has at least one', () => {
    expect(versions.length).toBeGreaterThan(0)
  })

  it('points CURRENT_PROMPT at versions that exist', () => {
    for (const version of Object.values(CURRENT_PROMPT)) {
      expect(versions).toContain(version)
    }
  })

  it.each(versions)('%s embeds the rubric by reference, exactly once', (version) => {
    const template = readFileSync(join(PROMPT_DIR, `${version}.md`), 'utf8')
    expect(template.split(RUBRIC_PLACEHOLDER)).toHaveLength(2)
  })

  /**
   * The invariant the whole feature exists for, stated the only way that
   * survives an edit: not "the copies match" — they would, on the day someone
   * pastes one — but "there is no second copy to fall out of step".
   *
   * Derived from the rubric's own lines rather than a list of phrases, so it
   * keeps working when the rubric is rewritten.
   */
  it.each(versions)('%s contains no pasted copy of the rubric', (version) => {
    const template = readFileSync(join(PROMPT_DIR, `${version}.md`), 'utf8')
    const substantial = loadRubric()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 40)

    expect(substantial.length).toBeGreaterThan(5)
    expect(substantial.filter((line) => template.includes(line))).toEqual([])
  })

  it.each(versions)('%s resolves against the real rubric', (version) => {
    const prompt = loadPrompt(version)
    expect(prompt.system).toContain(loadRubric())
  })

  it('keeps the rubric where both readers look for it', () => {
    expect(loadRubric()).toBe(readFileSync(join(PROMPT_DIR, RUBRIC_FILE), 'utf8').trimEnd())
  })
})
