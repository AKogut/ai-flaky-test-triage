import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

/**
 * A Codespace is the one place a stranger runs this repository without
 * installing anything, so when it breaks, that is their first impression of it.
 * It can break quietly in two ways.
 *
 * The image's Node line can fall behind engines.node, and nothing else would
 * notice: Dependabot is told to hold that major, and the floor moves by hand.
 *
 * Or the digest can stop being Dependabot's to update. That is what happens to an
 * `image` written into devcontainer.json, and to a versioned tag, which Dependabot
 * misreads. The comment in .devcontainer/Dockerfile has the details.
 */

const IMAGE = 'mcr.microsoft.com/devcontainers/javascript-node'

const floorMajor = (
  JSON.parse(readFileSync('package.json', 'utf8')) as { engines: { node: string } }
).engines.node
  .replace(/^>=/, '')
  .split('.')[0]

const from = readFileSync('.devcontainer/Dockerfile', 'utf8')
  .split('\n')
  .filter((line) => /^FROM\s/i.test(line))

/** devcontainer.json is JSONC. TypeScript's tsconfig reader parses exactly that. */
const configText = readFileSync('.devcontainer/devcontainer.json', 'utf8')
const config = ts.parseConfigFileTextToJson('devcontainer.json', configText).config as Record<
  string,
  unknown
>

interface Update {
  'package-ecosystem': string
  directory?: string
  cooldown?: { 'default-days'?: number }
  ignore?: { 'dependency-name': string; 'update-types'?: string[] }[]
}
const updates = (parse(readFileSync('.github/dependabot.yml', 'utf8')) as { updates: Update[] })
  .updates

describe('the dev container image', () => {
  it('is one FROM line', () => {
    expect(from).toHaveLength(1)
  })

  it('is pinned by digest, under the tag for the Node major engines.node names', () => {
    const match = new RegExp(
      `^FROM ${IMAGE.replaceAll('.', '\\.')}:(\\d+)-bookworm@sha256:[0-9a-f]{64}$`,
    ).exec(from[0] ?? '')
    expect(match?.[1]).toBe(floorMajor)
  })

  it('is kept current by a Dependabot entry that holds its Node major', () => {
    const docker = updates.find(
      (u) => u['package-ecosystem'] === 'docker' && u.directory === '/.devcontainer',
    )
    expect(docker?.cooldown?.['default-days']).toBe(14)
    expect(docker?.ignore).toContainEqual({
      'dependency-name': IMAGE,
      'update-types': ['version-update:semver-major'],
    })
  })
})

describe('devcontainer.json', () => {
  it('builds the Dockerfile, so the image stays where Dependabot reads it', () => {
    expect(config.build).toEqual({ dockerfile: 'Dockerfile' })
    expect(config.image).toBeUndefined()
  })

  /** Features would need a `devcontainers` Dependabot entry, which there is none of. */
  it('uses no Features', () => {
    expect(config.features).toBeUndefined()
  })

  it('installs the dependencies before the first terminal opens, and nothing else', () => {
    expect(config.postCreateCommand).toBe('npm ci')
    expect(config.waitFor).toBe('postCreateCommand')
    expect(configText).not.toMatch(/playwright/i)
  })

  it('needs no key', () => {
    expect(configText).not.toMatch(/ANTHROPIC|secrets|remoteEnv|containerEnv/i)
  })
})
