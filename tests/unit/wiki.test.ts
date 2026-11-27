import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DeterminismSchema, OwnerSchema, ProvenanceSchema } from '@sentra/contracts'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

/**
 * The wiki, held to the rules #82 set for it.
 *
 * `wiki/` is published by `.github/workflows/wiki.yml`, and the wiki is the
 * more public of the two documentation surfaces. Its rules were written down in
 * `wiki/README.md` and enforced by nobody: link into the repository rather than
 * restate it, define the project's own words, never send a reader to a page or
 * a heading that is not there. Each `describe` below is one of them, so a page
 * that breaks one fails the unit job before it is published.
 */

const root = new URL('../..', import.meta.url).pathname
const WIKI = join(root, 'wiki')
const REPO = 'https://github.com/AKogut/ai-flaky-test-triage'

const read = (path: string): string => readFileSync(join(root, path), 'utf8')

/** Every published page, by the name GitHub gives it. `README.md` documents publishing instead. */
const PAGES = readdirSync(WIKI)
  .filter((file) => file.endsWith('.md') && file !== 'README.md')
  .map((file) => file.slice(0, -'.md'.length))
  .sort()

/** `_Sidebar` and `_Footer` are rendered around every page rather than being pages of their own. */
const CONTENT_PAGES = PAGES.filter((name) => !name.startsWith('_'))

const page = (name: string): string => read(`wiki/${name}.md`)

/**
 * Each page's counterpart in the repository: the versioned document that is
 * normative where the page is narrative. `null` where there is none.
 *
 * Defined once, here. A page added to `wiki/` fails the first test below until
 * it has a line in this map, so the decision about its counterpart is made when
 * the page is written rather than discovered later.
 */
const COUNTERPARTS: Record<string, string | null> = {
  Home: 'README.md',
  'Getting-Started': 'README.md',
  'Architecture-Overview': 'docs/architecture.md',
  'Classification-Taxonomy': 'docs/taxonomy.md',
  'Agent-Design': 'docs/agent-design.md',
  'Decision-Records': 'docs/adr',
  'Evaluation-Methodology': 'docs/eval-methodology.md',
  'Limitations-and-Guardrails': 'docs/limitations-and-guardrails.md',
  'Branching-and-Release': 'docs/branching-strategy.md',
  Contributing: 'CONTRIBUTING.md',
  Roadmap: 'ROADMAP.md',
  FAQ: null,
  Glossary: null,
}

/** The subjects #82 says the wiki covers, by the page that covers each. */
const REQUIRED: Record<string, string> = {
  Home: 'Home',
  architecture: 'Architecture-Overview',
  taxonomy: 'Classification-Taxonomy',
  'agent design': 'Agent-Design',
  evaluation: 'Evaluation-Methodology',
  guardrails: 'Limitations-and-Guardrails',
  branching: 'Branching-and-Release',
  roadmap: 'Roadmap',
  glossary: 'Glossary',
  FAQ: 'FAQ',
  'ADR index': 'Decision-Records',
}

// ---------------------------------------------------------------------------
// Reading markdown the way GitHub renders it
// ---------------------------------------------------------------------------

/** Fenced blocks hold shell comments and diagrams: `# add ANTHROPIC_API_KEY` is not a heading. */
const withoutFences = (md: string): string =>
  md.replace(/^ *(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ *\1[^\n]*$/gm, '')

/** Inline code holds examples of links, not links: `[Getting Started](Getting-Started)` in the README. */
const prose = (md: string): string =>
  withoutFences(md).replace(/`[^`\n]+`/g, (code) => ' '.repeat(code.length))

/** Inline link targets — the only link style these pages use. */
const linksIn = (md: string): string[] =>
  [...prose(md).matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1] ?? '')

/**
 * A heading's text as rendered: link text and code kept, emphasis dropped. No
 * heading here carries inline HTML, so nothing is done about it; one that did
 * would fail the link test the moment something linked to it.
 */
const plainText = (inline: string): string =>
  inline
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .split(/(`[^`]*`)/)
    .map((part) =>
      part.startsWith('`')
        ? part.slice(1, -1)
        : part.replace(/\*+/g, '').replace(/(^|\s)_(.+?)_(?=\s|$)/g, '$1$2'),
    )
    .join('')

/**
 * GitHub's anchor for a heading, by github-slugger's rules: lower-cased, every
 * character that is not a letter, mark, number, connector, space or hyphen
 * removed, and each space turned into a hyphen. So `## 4. Does confidence mean
 * anything?` is `#4-does-confidence-mean-anything`, and an em dash between two
 * spaces leaves two hyphens behind.
 *
 * Checked, when this was written, against the ids GitHub rendered for every
 * heading on four published pages, the ADR titles with their em dashes among
 * them. They all matched.
 */
const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-')

/** Every anchor a page has. A repeated heading gets `-1`, `-2` and so on, as on GitHub. */
function anchorsOf(md: string): Set<string> {
  const seen = new Map<string, number>()
  const anchors = new Set<string>()
  for (const match of withoutFences(md).matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*$/gm)) {
    const base = slug(plainText(match[1] ?? ''))
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    anchors.add(n === 0 ? base : `${base}-${String(n)}`)
  }
  return anchors
}

/** The body of a `##` section, up to the next heading at that level. */
function section(md: string, heading: string): string {
  const start = md.indexOf(`\n## ${heading}\n`)
  if (start === -1) return ''
  const end = md.indexOf('\n## ', start + 1)
  return md.slice(start, end === -1 ? undefined : end)
}

const normalised = (text: string): string => text.replace(/\s+/g, ' ')

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A link to a file or directory on `main`, the only form a wiki page can use for one. */
const REPO_FILE = new RegExp(`^${escaped(REPO)}/(?:blob|tree)/main/(.+?)/?$`)
const WIKI_PAGE = new RegExp(`^${escaped(REPO)}/wiki(?:/([^/]+))?/?$`)

/** What is wrong with one link, or `undefined` when it resolves. */
function brokenLink(from: string, target: string): string | undefined {
  const hash = target.indexOf('#')
  const decoded = decodeURIComponent(hash === -1 ? target : target.slice(0, hash))
  const anchor = hash === -1 ? '' : target.slice(hash + 1)
  const missingAnchor = (md: string, where: string): string | undefined =>
    anchor === '' || anchorsOf(md).has(anchor)
      ? undefined
      : `${where} has no heading with the anchor #${anchor}`

  const file = REPO_FILE.exec(decoded)?.[1]
  if (file !== undefined) {
    if (!existsSync(join(root, file))) return `${file} is not in the repository`
    return file.endsWith('.md') ? missingAnchor(read(file), file) : undefined
  }

  const wikiPage = WIKI_PAGE.exec(decoded)
  if (wikiPage !== null) {
    const name = wikiPage[1] ?? 'Home'
    if (!PAGES.includes(name)) return `the wiki has no page named ${name}`
    return missingAnchor(page(name), name)
  }

  // Anything else with a scheme is somebody else's page.
  if (/^[a-z][a-z\d+.-]*:/i.test(decoded)) return undefined

  // wiki/README.md renders in the repository, where a relative link is a path.
  if (from === 'README') {
    if (decoded === '') return missingAnchor(read('wiki/README.md'), 'wiki/README.md')
    const repoPath = join('wiki', decoded)
    if (!existsSync(join(root, repoPath))) return `${repoPath} does not exist`
    return repoPath.endsWith('.md') ? missingAnchor(read(repoPath), repoPath) : undefined
  }

  // On the wiki a relative link is a page name. A repository path written
  // relatively lands here too, and is caught: it works in a checkout and
  // 404s on the wiki.
  const name = decoded === '' ? from : decoded
  if (!PAGES.includes(name)) return `the wiki has no page named ${name}`
  return missingAnchor(page(name), name)
}

// ---------------------------------------------------------------------------
// The pages
// ---------------------------------------------------------------------------

describe('the wiki’s pages', () => {
  it('each have an entry in the counterpart map, and the map names nothing else', () => {
    expect(Object.keys(COUNTERPARTS).sort()).toEqual(CONTENT_PAGES)
  })

  it.each(Object.entries(REQUIRED))('cover %s', (_subject, name) => {
    expect(CONTENT_PAGES).toContain(name)
  })

  it('are all in the sidebar', () => {
    const linked = new Set(linksIn(page('_Sidebar')))
    expect(CONTENT_PAGES.filter((name) => !linked.has(name))).toEqual([])
  })

  it.each(CONTENT_PAGES)('%s links back to the repository', (name) => {
    expect(linksIn(page(name)).filter((url) => url === REPO || url === `${REPO}/`)).not.toEqual([])
  })

  it.each(
    Object.entries(COUNTERPARTS).filter((entry): entry is [string, string] => entry[1] !== null),
  )('%s links to its counterpart, %s', (name, counterpart) => {
    expect(existsSync(join(root, counterpart)), `${counterpart} is not in the repository`).toBe(
      true,
    )
    const targets = linksIn(page(name)).map((url) => REPO_FILE.exec(url.split('#')[0] ?? '')?.[1])
    expect(targets).toContain(counterpart)
  })
})

describe('the rule between docs/ and the wiki', () => {
  /**
   * The rule is what keeps two documentation surfaces from both going stale, so
   * it is stated where every reader starts. Three parts of it are held here:
   * where the specifications are, that the wiki links rather than copies, and
   * which side wins a disagreement. The two sentences are matched as written,
   * so rewording one is an edit to this test too, and a deliberate one.
   */
  const organised = section(page('Home'), 'How this documentation is organised')

  it('is stated on Home', () => {
    expect(organised).not.toBe('')
    expect(linksIn(organised)).toContain(`${REPO}/tree/main/docs`)
    expect(normalised(organised)).toContain('The wiki links into `docs/` rather than copying')
    expect(normalised(organised)).toContain('the wiki page is the one to fix')
  })
})

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

describe('every link in wiki/', () => {
  /**
   * Relative links are page names on the wiki and paths in the checkout. Links
   * into the repository are checked against the files on disk, anchors
   * included, so renaming a heading in `docs/` fails here rather than leaving a
   * wiki link that lands at the top of the page.
   */
  it.each([...PAGES, 'README'])('in %s resolves', (name) => {
    const md = name === 'README' ? read('wiki/README.md') : page(name)
    const broken = linksIn(md).flatMap((target) => {
      const problem = brokenLink(name, target)
      return problem === undefined ? [] : [`${target}: ${problem}`]
    })
    expect(broken).toEqual([])
  })

  it('is read the way GitHub slugs headings', () => {
    expect([...anchorsOf('## 4. Does confidence mean anything?\n')]).toEqual([
      '4-does-confidence-mean-anything',
    ])
    expect([...anchorsOf('### [ADR-0001](https://x) — Single repository\n')]).toEqual([
      'adr-0001--single-repository',
    ])
    expect([...anchorsOf('### `owner`\n### `owner`\n```sh\n# not a heading\n```\n')]).toEqual([
      'owner',
      'owner-1',
    ])
    expect(brokenLink('FAQ', 'Getting-Started#no-such-heading')).toMatch(/no heading/)
    expect(brokenLink('FAQ', '../docs/taxonomy.md')).toMatch(/no page named/)
  })
})

// ---------------------------------------------------------------------------
// The glossary
// ---------------------------------------------------------------------------

/**
 * The project-specific terms the wiki uses, each by its Glossary heading and
 * the way the other pages write it.
 *
 * "Project-specific" is bounded by this list rather than left open: a word this
 * repository coined or gives a meaning of its own — a schema value or field, a
 * pipeline artifact, a named component, metric or stage. A term the wiki starts
 * using goes in here, with its Glossary entry, in the same change. Three
 * classes are not left to memory at all: every value of the `owner`,
 * `determinism` and provenance enums is required from the contracts, and every
 * `SENTRA_*` variable a page names is required from the pages.
 *
 * `null` marks a term no page names. Those are fields of `analysis.json`, the
 * file a reader of the pipeline's output meets them in.
 */
const TERMS: Record<string, RegExp | null> = {
  Ablation: /\bablation\b/i,
  '`alternativeHypothesis`': /\balternativeHypothesis\b/,
  '`analysis.json`': /\banalysis\.json\b/,
  '`app_code`': /`app_code`/,
  Baseline: /\bbaseline\b/i,
  Bucket: /\bbuckets?\b/i,
  Budget: /\bbudget\b/i,
  Captured: /\bcaptured\b/i,
  Cassette: /\bcassettes?\b/i,
  'Chaos (`SENTRA_CHAOS`)': /\bSENTRA_CHAOS\b/,
  'Confidence threshold': /\b(?:confidence|calibration) threshold\b/i,
  'Context bundle': /\bcontext bundle\b/i,
  'Definition of Done': /\bDefinition of Done\b/,
  '`determinism`': /`determinism`/,
  '`deterministic`': /`deterministic`/,
  'Development slice': /\bdevelopment slice\b/i,
  'ECE (Expected Calibration Error)': /\bExpected Calibration Error\b/,
  'Emergent flakiness': /\bemergent\b/i,
  '`environment`': /`environment`/,
  EWMA: null,
  'Exit criterion': /\bexit criteri(?:on|a)\b/i,
  'Fix-suggestion agent': /\bfix-suggestion agents?\b/i,
  Fixture: /\bfixtures?\b/i,
  '`flakemetry-lib`': /\bflakemetry-lib\b/,
  'Flakiness score': /\bflakiness score\b/i,
  'Golden dataset': /\bgolden dataset\b/i,
  'Hard quadrant': /\bhard quadrant\b/i,
  'Held-out slice': /\bheld-out\b/i,
  '`intermittent`': /`intermittent`/,
  '`isNew`': null,
  'Joint accuracy': /\bjoint accuracy\b/i,
  'Label leakage': /\blabel[- ]leakage\b/i,
  '`lowConfidenceGroundTruth`': /\blowConfidenceGroundTruth\b/,
  'Merge gate': /\b(?:merge|eval) gate\b/i,
  Mutated: /\bmutated\b/i,
  '`owner`': /`owner`/,
  Provenance: /\bprovenance\b/i,
  'Replay mode': /\breplay mode\b/i,
  '`report.md`': /(?<!eval\/)\breport\.md\b/,
  'Root-cause agent': /\broot-cause agents?\b/i,
  Rubric: /\brubric\b/i,
  'Scripted transport': /\bscripted transport\b/i,
  'Self-consistency': /\bself-consistency\b/i,
  Sentra: /\bSentra\b/,
  '`SENTRA_E2E_RETRIES`': /\bSENTRA_E2E_RETRIES\b/,
  'Squash merge': /\bsquash merge\b/i,
  '`statusHistory`': null,
  'Streak (`consecutiveFailures`)': /\bstreak\b/i,
  Synthetic: /\bsynthetic\b/i,
  TaskFlow: /\bTaskFlow\b/,
  '`test_code`': /`test_code`/,
  '`TestRun`': /\bTestRun\b/,
  'Triage agent': /\btriage agent\b/i,
  Unclassified: /\bunclassified\b/i,
  'Wilson interval': /\bWilson interval\b/,
}

const glossary = page('Glossary')
const ENTRIES = [...glossary.matchAll(/^\*\*(.+?)\*\* — \S/gm)].map((m) => m[1] ?? '')
const sortKey = (entry: string): string => entry.replace(/`/g, '')
const elsewhere = PAGES.filter((name) => name !== 'Glossary').map((name) => page(name))

describe('the glossary', () => {
  it('has entries in alphabetical order', () => {
    const sorted = [...ENTRIES].sort((a, b) =>
      sortKey(a).localeCompare(sortKey(b), 'en', { sensitivity: 'base' }),
    )
    expect(ENTRIES).toEqual(sorted)
  })

  it('defines every term in the list, and nothing the list does not name', () => {
    const terms = Object.keys(TERMS)
    expect(
      terms.filter((term) => !ENTRIES.includes(term)),
      'no Glossary entry',
    ).toEqual([])
    expect(
      ENTRIES.filter((entry) => !terms.includes(entry)),
      'not in TERMS',
    ).toEqual([])
  })

  it('lists only terms the other pages actually use', () => {
    const unused = Object.entries(TERMS)
      .filter(([, pattern]) => pattern !== null && !elsewhere.some((md) => pattern.test(md)))
      .map(([term]) => term)
    expect(unused).toEqual([])
  })

  /** A `null` is a claim that no page names the term; once one does, it gets its pattern. */
  it('marks a term unused only while no page names it', () => {
    const named = Object.entries(TERMS)
      .filter(([term, pattern]) => {
        const bare = term.replace(/`/g, '')
        return pattern === null && elsewhere.some((md) => md.includes(bare))
      })
      .map(([term]) => term)
    expect(named).toEqual([])
  })

  it('defines every value the classification and fixture schemas allow', () => {
    const defined = new Set(ENTRIES.map((entry) => sortKey(entry).toLowerCase()))
    const values = [
      ...OwnerSchema.options,
      ...DeterminismSchema.options,
      ...ProvenanceSchema.options,
    ]
    expect(values.filter((value) => !defined.has(value))).toEqual([])
  })

  it('defines every SENTRA_ variable a page names', () => {
    const named = new Set(elsewhere.flatMap((md) => md.match(/\bSENTRA_[A-Z\d_]+\b/g) ?? []))
    expect([...named].filter((name) => !glossary.includes(name))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

interface Step {
  name?: string
  uses?: string
  run?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
}

interface Job {
  if?: string
  permissions?: Record<string, string>
  steps: Step[]
}

const workflowSource = read('.github/workflows/wiki.yml')
const workflow = parse(workflowSource) as {
  on: { push?: { branches?: string[]; paths?: string[] }; workflow_dispatch?: unknown }
  permissions?: Record<string, string>
  jobs: Record<string, Job | undefined>
}
const steps = Object.values(workflow.jobs).flatMap((job) => job?.steps ?? [])
const SCRIPT = './scripts/publish-wiki.sh'

describe('the publishing workflow', () => {
  it('runs when wiki/ or the script changes on main, and on demand', () => {
    expect(workflow.on.push?.branches).toEqual(['main'])
    expect(workflow.on.push?.paths).toEqual(
      expect.arrayContaining(['wiki/**', 'scripts/publish-wiki.sh']),
    )
    expect('workflow_dispatch' in workflow.on).toBe(true)
  })

  /** A manual run can start from any branch; what is published is what was reviewed. */
  it('publishes main and nothing else', () => {
    expect(workflow.jobs.publish?.if).toBe("github.ref == 'refs/heads/main'")
  })

  it('may write only from the job that publishes', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(Object.keys(workflow.jobs)).toEqual(['publish'])
    expect(workflow.jobs.publish?.permissions).toEqual({ contents: 'write' })
  })

  /** No personal token exists for this, and none should appear. */
  it('authenticates with its own GITHUB_TOKEN', () => {
    expect(workflowSource.match(/secrets\.\w+/g)).toEqual(['secrets.GITHUB_TOKEN'])
  })

  it('keeps no credentials in the checkout', () => {
    const checkouts = steps.filter((step) => step.uses?.startsWith('actions/checkout@') === true)
    expect(checkouts.length).toBeGreaterThan(0)
    for (const step of checkouts) expect(step.with?.['persist-credentials']).toBe(false)
  })

  /** The repository requires it (`sha_pinning_required`); a tag would fail the run outright. */
  it('pins every action to a full commit SHA', () => {
    for (const step of steps)
      if (step.uses !== undefined) expect(step.uses).toMatch(/@[0-9a-f]{40}$/)
  })

  /** An expression inside a script is a script injection; values come in through `env`. */
  it('puts no expression inside a script', () => {
    for (const step of steps) expect(step.run ?? '').not.toContain('${{')
  })

  it('runs the same script a maintainer runs by hand', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> })
      .scripts
    expect(scripts['wiki:publish']).toBe(SCRIPT)
    expect(steps.filter((step) => step.run === SCRIPT)).toHaveLength(1)
  })
})

describe('scripts/publish-wiki.sh', () => {
  /** Git as the script will meet it in CI: no user configuration, no identity, no prompt. */
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith('GIT_') && !key.startsWith('WIKI_'),
      ),
    ),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  })

  const git = (...args: string[]): string => {
    const result = spawnSync('git', args, { env: env(), encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
    return result.stdout
  }

  /** A wiki as GitHub leaves it after "Create the first page", plus a retired page and an upload. */
  const seededWiki = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'sentra-wiki-'))
    const remote = join(dir, 'wiki.git')
    const seed = join(dir, 'seed')
    git('init', '--quiet', '--bare', '--initial-branch=master', remote)
    git('init', '--quiet', '--initial-branch=master', seed)
    writeFileSync(join(seed, 'Home.md'), 'placeholder\n')
    writeFileSync(join(seed, 'Retired-Page.md'), 'no longer in wiki/\n')
    writeFileSync(join(seed, 'diagram.png'), 'uploaded through the browser\n')
    git('-C', seed, 'add', '-A')
    git(
      '-C',
      seed,
      '-c',
      'user.name=Seed',
      '-c',
      'user.email=seed@example.invalid',
      'commit',
      '-qm',
      'Initial Home page',
    )
    git('-C', seed, 'push', '--quiet', remote, 'master')
    return remote
  }

  const publish = (remote: string, args: string[] = [], extra: Record<string, string> = {}) =>
    spawnSync('bash', [join(root, SCRIPT), ...args], {
      env: env({ WIKI_REMOTE: remote, TMPDIR: dirname(remote), ...extra }),
      encoding: 'utf8',
    })

  const head = (remote: string): string => git('--git-dir', remote, 'rev-parse', 'master').trim()
  const files = (remote: string): string[] =>
    git('--git-dir', remote, 'ls-tree', '--name-only', 'master').trim().split('\n').sort()

  it(
    'mirrors every page but README.md, and leaves files that are not pages alone',
    { timeout: 30_000 },
    () => {
      const remote = seededWiki()
      const run = publish(remote)
      expect(run.status, run.stderr).toBe(0)
      expect(files(remote)).toEqual([...PAGES.map((name) => `${name}.md`), 'diagram.png'].sort())
      expect(git('--git-dir', remote, 'show', 'master:Home.md')).toBe(page('Home'))
    },
  )

  it('commits as the owner, under the public noreply address', { timeout: 30_000 }, () => {
    const remote = seededWiki()
    expect(publish(remote).status).toBe(0)
    const [author, committer, subject] = git(
      '--git-dir',
      remote,
      'log',
      '-1',
      '--format=%an <%ae>%n%cn <%ce>%n%s',
      'master',
    )
      .trim()
      .split('\n')
    expect(author).toBe('Andrii Kohut <AKogut@users.noreply.github.com>')
    expect(committer).toBe(author)
    expect(subject).toMatch(/^docs: sync wiki from wiki\/ at [0-9a-f]{7,}$/)
  })

  it('commits nothing when the wiki already matches', { timeout: 30_000 }, () => {
    const remote = seededWiki()
    expect(publish(remote).status).toBe(0)
    const before = head(remote)
    const again = publish(remote)
    expect(again.status, again.stderr).toBe(0)
    expect(again.stdout).toContain('already up to date')
    expect(head(remote)).toBe(before)
  })

  it('shows what it would publish on a dry run, and pushes nothing', { timeout: 30_000 }, () => {
    const remote = seededWiki()
    const before = head(remote)
    const dry = publish(remote, ['--dry-run'])
    expect(dry.status, dry.stderr).toBe(0)
    expect(dry.stdout).toContain('Retired-Page.md')
    expect(dry.stdout).toContain('nothing pushed')
    expect(head(remote)).toBe(before)
  })

  /** The CI path, end to end. A file remote asks for no credentials, so this proves the plumbing. */
  it('publishes with a token set, and never prints it', { timeout: 30_000 }, () => {
    const remote = seededWiki()
    const run = publish(remote, [], { WIKI_TOKEN: 'token-that-must-not-be-printed' })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout + run.stderr).not.toContain('token-that-must-not-be-printed')
    expect(files(remote)).not.toContain('Retired-Page.md')
  })

  /**
   * The helper itself, asked the way git asks it over https. The configured
   * `store` helper stands in for a keychain: with the reset it never sees the
   * token, and without it — the control — it does.
   */
  it('gives git the token through a helper and lets no other helper keep it', () => {
    // The reset and the helper, as the script passes them: the first clears the list, so the
    // second is the only helper git asks.
    const passed = /-c credential\.helper= \\\n\s+-c '(credential\.helper=![^']+)'/.exec(
      read(SCRIPT),
    )
    const helper = passed?.[1] ?? ''
    expect(helper).not.toBe('')

    const dir = mkdtempSync(join(tmpdir(), 'sentra-wiki-credential-'))
    const stored = join(dir, 'stored')
    const config = join(dir, 'gitconfig')
    writeFileSync(config, `[credential]\n\thelper = store --file ${stored}\n`)
    const credential = (reset: boolean, action: string, input: string): string =>
      spawnSync(
        'git',
        [...(reset ? ['-c', 'credential.helper='] : []), '-c', helper, 'credential', action],
        {
          env: env({ GIT_CONFIG_GLOBAL: config, WIKI_TOKEN: 'wiki-token' }),
          input,
          encoding: 'utf8',
        },
      ).stdout

    const filled = credential(true, 'fill', 'protocol=https\nhost=github.com\n\n')
    expect(filled).toContain('username=x-access-token\n')
    expect(filled).toContain('password=wiki-token\n')

    credential(true, 'approve', `${filled}\n`)
    expect(existsSync(stored)).toBe(false)
    credential(false, 'approve', `${filled}\n`)
    expect(readFileSync(stored, 'utf8')).toContain('wiki-token')
  })

  it('refuses an argument it does not know', () => {
    expect(publish(seededWiki(), ['--force']).status).toBe(2)
  })
})
