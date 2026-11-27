import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

/**
 * The local Jaeger is a convenience, and this is what keeps it one.
 *
 * ADR-0001 rules out anything that has to be running, and the failure this
 * guards against is not a crash. It is drift: a workflow that starts the
 * collector "just to check", a job that sets the variable, a README that names
 * Docker before it names `npm run demo`. Each would make the optional thing a
 * soft requirement without anything failing. The behaviour of the exporter
 * itself — off by default, never failing the run, bounded by a timeout — is
 * pinned in `agents/spans.test.ts` and `agents/run.test.ts`.
 */

const COMPOSE = 'observability/docker-compose.yml'
const WORKFLOWS = '.github/workflows'

const workflows = readdirSync(WORKFLOWS)
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => ({ file, text: readFileSync(join(WORKFLOWS, file), 'utf8') }))

interface Compose {
  services?: Record<string, { image?: string; ports?: string[]; restart?: string }>
}

describe('CI', () => {
  it('has workflows to check', () => {
    expect(workflows.length).toBeGreaterThan(0)
  })

  it.each(workflows)('$file never asks for a collector', ({ text }) => {
    expect(text).not.toContain('SENTRA_OTLP_ENDPOINT')
    expect(text).not.toContain('OTEL_EXPORTER_OTLP')
  })

  it.each(workflows)('$file never starts Jaeger or the compose file', ({ text }) => {
    expect(text.toLowerCase()).not.toContain('jaeger')
    expect(text.toLowerCase()).not.toMatch(/docker[ -]?compose/)
    expect(text).not.toContain('observability/')
  })

  /** A service container is how a collector would arrive in a job without anyone naming it. */
  it.each(workflows)('$file runs no service containers', ({ text }) => {
    const jobs = (parse(text) as { jobs?: Record<string, { services?: unknown }> }).jobs ?? {}
    for (const job of Object.values(jobs)) expect(job.services).toBeUndefined()
  })
})

describe('the compose file', () => {
  const compose = parse(readFileSync(COMPOSE, 'utf8')) as Compose
  const jaeger = compose.services?.jaeger

  it('runs Jaeger and nothing else', () => {
    expect(Object.keys(compose.services ?? {})).toEqual(['jaeger'])
  })

  /** A floating tag is a different collector on every pull. */
  it('pins the image by version and by digest', () => {
    expect(jaeger?.image).toMatch(/^jaegertracing\/jaeger:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/)
  })

  it('listens on loopback only, for OTLP over HTTP and for the UI', () => {
    expect(jaeger?.ports).toEqual(['127.0.0.1:4318:4318', '127.0.0.1:16686:16686'])
  })

  it('is not restarted, because nothing here is meant to stay up', () => {
    expect(jaeger?.restart).toBe('no')
  })

  it('says it is optional before it says anything else', () => {
    expect(readFileSync(COMPOSE, 'utf8').split('\n')[0]).toMatch(/^# Optional\./)
  })
})

describe('the documentation', () => {
  const readme = readFileSync('README.md', 'utf8')

  /**
   * The issue's own warning: a README that mentions Docker before it mentions
   * `npm run demo` undoes the "no infrastructure" claim in a reader's mind,
   * whatever the text around it says.
   */
  it('names npm run demo before it names Docker', () => {
    const docker = readme.search(/docker/i)
    expect(docker).toBeGreaterThan(readme.indexOf('npm run demo'))
  })

  it('names Docker in the README only in a paragraph that calls it optional', () => {
    const paragraphs = readme.split(/\n\s*\n/).filter((p) => /docker/i.test(p))
    expect(paragraphs.length).toBeGreaterThan(0)
    for (const paragraph of paragraphs) expect(paragraph).toMatch(/optional/i)
  })

  it('has the subsection the README points to', () => {
    expect(readFileSync('docs/agent-design.md', 'utf8')).toContain(
      '### Optional: view spans in Jaeger',
    )
    expect(readme).toContain('docs/agent-design.md#optional-view-spans-in-jaeger')
  })

  it('leaves the variable empty in .env.example, so copying it opts nobody in', () => {
    expect(readFileSync('.env.example', 'utf8')).toMatch(/^SENTRA_OTLP_ENDPOINT=$/m)
  })
})
