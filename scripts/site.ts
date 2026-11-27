import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { getDefaults, Lexer, Parser, Renderer, type Tokens } from 'marked'
import { main as demo, OUTPUT as DEMO_OUTPUT } from './demo.js'

/**
 * `npx tsx scripts/site.ts` — the project site, rendered from the repository.
 *
 * https://akogut.github.io/ai-flaky-test-triage/ is for a reader who will not
 * clone the repository and may not have a GitHub account. It has four pages,
 * each made from something the repository already has: the README's 60-second
 * tour, `eval/report.md`, `eval/ablation.md`, and the report `npm run demo`
 * writes, run while the site is built. The only words written for the site are
 * the navigation, a line about each page on the index, and the note that says
 * the example is one. A page written for the site would be a second copy of
 * each claim, and a copy is what goes stale. These say what the repository
 * says, at the commit each page names in its footer.
 *
 * `.github/workflows/pages.yml` runs this on main and deploys `_site/`. Run it
 * from the repository root, as every script here is run, and preview with
 * `python3 -m http.server -d _site`.
 *
 * A relative link that points at nothing fails the build rather than shipping
 * a page with a dead link, and so does an image from another origin: every
 * page's Content-Security-Policy would block it, which is the point of the
 * policy. The site loads no script, no font and nothing from anywhere else.
 */

export const OUT_DIR = '_site'
export const STYLESHEET = 'scripts/site.css'
export const REPOSITORY = 'https://github.com/AKogut/ai-flaky-test-triage'
export const SITE_URL = 'https://akogut.github.io/ai-flaky-test-triage/'
export const TOUR = '## The 60-second tour'

/** Nothing runs, and nothing loads from another origin. */
export const CSP =
  "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'"

/** A link to one of these files goes to its page here, not to GitHub. */
const RENDERED: Readonly<Record<string, string>> = {
  'eval/report.md': 'report.html',
  'eval/ablation.md': 'ablation.html',
}

export interface Inputs {
  readme: string
  report: string
  ablation: string
  /** The `report.md` that `npm run demo` wrote. */
  demo: string
}

export interface Page {
  /** Its file under `_site/`. */
  file: string
  /** Its name in the navigation and in `<title>`. */
  title: string
  /** A sentence or two for the index and the meta description. Backticks mark code, and nothing else is markup. */
  summary: string
  /** What it is made from, linked from its footer at the commit it was built from. */
  sources: string[]
  markdown: string
  /** The file the Markdown's relative links are relative to. */
  base: string
  /** An excerpt has only some of its document's headings, so `#heading` links go to the whole document. */
  excerpt?: boolean
  /** Markdown shown above the content, saying what the page is. */
  notice?: string
}

export interface Repo {
  kind(path: string): 'file' | 'directory' | undefined
}

export interface Site {
  /** Every page, by its file under `_site/`. */
  pages: Map<string, string>
  /** Repository files the pages show, copied to the same path under `_site/`. */
  assets: string[]
}

// ---------------------------------------------------------------------------
// The pages
// ---------------------------------------------------------------------------

/** How the example page names the classifier that wrote it, keyed by the name the demo prints. */
const CLASSIFIED_BY: Readonly<Record<string, string>> = {
  baseline: 'the **baseline** classifier, a heuristic that calls no model',
  agent: 'the **agent**, replaying recorded model responses rather than calling the model',
}

export function pages(inputs: Inputs): Page[] {
  const classifier = demoClassifier(inputs.demo)
  return [
    {
      file: 'index.html',
      title: 'Overview',
      summary:
        'Sentra triages CI test failures: who owns the fix, and whether the failure comes back on rerun. It is built to be measured, against a hand-labelled dataset and a non-LLM baseline.',
      sources: ['README.md'],
      markdown: tour(inputs.readme),
      base: 'README.md',
      excerpt: true,
    },
    {
      file: 'report.html',
      title: 'Evaluation report',
      summary:
        'The scores on the hand-labelled golden dataset, with confidence intervals, as `npm run eval` wrote them.',
      sources: ['eval/report.md'],
      markdown: inputs.report,
      base: 'eval/report.md',
    },
    {
      file: 'ablation.html',
      title: 'Ablation study',
      summary:
        'What each part of the context is worth to the classifier, measured by withholding it, as `npm run eval:ablation` wrote it.',
      sources: ['eval/ablation.md'],
      markdown: inputs.ablation,
      base: 'eval/ablation.md',
    },
    {
      file: 'example.html',
      title: 'Example triage report',
      summary: `What \`npm run demo\` writes for the bundled CI run, with the ${classifier} classifier.`,
      sources: ['scripts/demo.ts', 'demo/analysis.json'],
      markdown: inputs.demo,
      // The demo writes report.md at the repository root, and links from there.
      base: DEMO_OUTPUT,
      notice: [
        '**An example, not a live classification.** This is the `report.md` that `npm run demo`',
        'wrote when this page was built, for the bundled CI run in',
        `[\`demo/analysis.json\`](demo/analysis.json), with ${CLASSIFIED_BY[classifier] ?? ''}.`,
        'It shows what the pipeline posts, not how often it is right: that is the',
        '[evaluation report](eval/report.md).',
      ].join('\n'),
    },
  ]
}

/** The README's title, its one-line description and the 60-second tour, up to the rule that ends it. */
export function tour(readme: string): string {
  const lines = readme.split('\n')
  const title = lines.findIndex((line) => line.startsWith('# '))
  const start = lines.indexOf(TOUR)
  if (title < 0 || start < 0) {
    throw new Error(`README.md has no "${TOUR}" section, and the index page is rendered from it`)
  }
  const tagline = lines.slice(title + 1).find((line) => line.trim() !== '') ?? ''
  const length = lines.slice(start + 1).findIndex((line) => line === '---' || /^##? /.test(line))
  const end = length < 0 ? lines.length : start + 1 + length
  return [lines[title] ?? '', '', tagline, '', ...lines.slice(start, end)].join('\n').trimEnd()
}

/** The classifier the demo says it ran. The example page is labelled from this line, so it has to be there. */
export function demoClassifier(report: string): string {
  const name = /with the \*\*(\w+)\*\* classifier/.exec(report)?.[1]
  if (name === undefined || !Object.hasOwn(CLASSIFIED_BY, name)) {
    throw new Error(
      `The demo's report.md does not name a classifier this script knows (${Object.keys(CLASSIFIED_BY).join(', ')}), and the example page has to say which one ran`,
    )
  }
  return name
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const SCHEME = /^[a-z][a-z\d+.-]*:/i
const external = (href: string): boolean => SCHEME.test(href) || href.startsWith('//')
const blob = (path: string, ref = 'main'): string => `${REPOSITORY}/blob/${ref}/${encodeURI(path)}`

/** A repository path for `href`, read relative to `base` or, with a leading slash, to the root. */
function repoPath(href: string, base: string): string {
  const joined = href.startsWith('/') ? href.slice(1) : posix.join(posix.dirname(base), href)
  const target = posix.normalize(decodeURI(joined)).replace(/\/$/, '')
  if (target === '..' || target.startsWith('../')) {
    throw new Error(`${base} links to ${href}, which is outside the repository`)
  }
  return target === '.' ? '' : target
}

/**
 * Where a link in a page's Markdown goes on the site.
 *
 * To the page for that file if there is one; otherwise to the file on GitHub, on
 * main, which is where a reader following it would want to be. A link to the
 * site itself becomes relative, so a local build links to itself.
 */
export function resolveLink(
  href: string,
  page: Pick<Page, 'base' | 'excerpt'>,
  repo: Repo,
): string {
  if (href.startsWith(SITE_URL)) return href.slice(SITE_URL.length) || 'index.html'
  if (external(href)) return href

  const at = href.indexOf('#')
  const path = at < 0 ? href : href.slice(0, at)
  const hash = at < 0 ? '' : href.slice(at)
  if (path === '') return page.excerpt === true ? blob(page.base) + hash : hash

  const target = repoPath(path, page.base)
  if (target === '') return REPOSITORY + hash
  const rendered = RENDERED[target]
  if (rendered !== undefined) return rendered + hash
  switch (repo.kind(target)) {
    case 'file':
      return blob(target) + hash
    case 'directory':
      return `${REPOSITORY}/tree/main/${encodeURI(target)}`
    default:
      throw new Error(`${page.base} links to ${href}, and there is no ${target} in the repository`)
  }
}

/** GitHub's heading anchors: lower case, punctuation dropped, each space a hyphen. */
export function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replaceAll(' ', '-')
}

export const escapeHtml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

/** Marked's own HTML, with three changes: heading anchors, scrollable tables, and links that work here. */
class SiteRenderer extends Renderer {
  readonly assets = new Set<string>()
  private readonly ids = new Map<string, number>()
  private section = ''

  constructor(
    private readonly page: Pick<Page, 'base' | 'excerpt'>,
    private readonly repo: Repo,
  ) {
    super()
  }

  override heading(token: Tokens.Heading): string {
    this.section = this.parser.parseInline(token.tokens, this.parser.textRenderer)
    const id = this.unique(slug(this.section))
    return `<h${String(token.depth)} id="${id}">${this.parser.parseInline(token.tokens)}</h${String(token.depth)}>\n`
  }

  override table(token: Tokens.Table): string {
    const label = escapeHtml(this.section === '' ? 'Table' : this.section)
    return `<div class="table" role="region" aria-label="${label}" tabindex="0">\n${super.table(token)}</div>\n`
  }

  override link(token: Tokens.Link): string {
    return super.link({ ...token, href: resolveLink(token.href, this.page, this.repo) })
  }

  override image(token: Tokens.Image): string {
    return super.image({ ...token, href: this.asset(token.href) })
  }

  /** HTML written into the Markdown — `<img>`, `<details>` — with its URLs resolved like any link. */
  override html(token: Tokens.HTML | Tokens.Tag): string {
    return token.text.replace(
      /\b(href|src|srcset)=(?:"([^"]*)"|'([^']*)')/g,
      (_match, name: string, double?: string, single?: string) => {
        const value = (double ?? single ?? '').replaceAll('&amp;', '&')
        const resolved =
          name === 'href'
            ? resolveLink(value, this.page, this.repo)
            : value
                .split(',')
                .map((candidate) => {
                  const [url = '', ...descriptor] = candidate.trim().split(/\s+/)
                  return [this.asset(url), ...descriptor].join(' ')
                })
                .join(', ')
        return `${name}="${escapeHtml(resolved)}"`
      },
    )
  }

  /** An image the page shows: a file in the repository, served from the same path here. */
  private asset(src: string): string {
    if (external(src)) {
      throw new Error(
        `${this.page.base} shows ${src}. The site's Content-Security-Policy blocks images from anywhere else, so commit the image and link the file`,
      )
    }
    const target = repoPath(src, this.page.base)
    if (this.repo.kind(target) !== 'file') {
      throw new Error(`${this.page.base} shows ${src}, and there is no ${target} in the repository`)
    }
    this.assets.add(target)
    return encodeURI(target)
  }

  private unique(id: string): string {
    const seen = this.ids.get(id) ?? 0
    this.ids.set(id, seen + 1)
    return seen === 0 ? id : `${id}-${String(seen)}`
  }
}

export function render(
  markdown: string,
  page: Pick<Page, 'base' | 'excerpt'>,
  repo: Repo,
): { html: string; assets: string[] } {
  const renderer = new SiteRenderer(page, repo)
  // The lexer and parser directly, not `new Marked({ renderer })`: that copies a
  // renderer's methods one by one onto its own, and refuses one with state.
  const options = { ...getDefaults(), gfm: true, renderer }
  const html = Parser.parse(Lexer.lex(markdown, options), options)
  return { html, assets: [...renderer.assets] }
}

function document(page: Page, body: string, all: readonly Page[], commit: string): string {
  const nav = all
    .map((other) => {
      const current = other === page ? ' aria-current="page"' : ''
      return `<li><a href="${other.file}"${current}>${escapeHtml(other.title)}</a></li>`
    })
    .join('\n')
  const sources = page.sources
    .map((source) => `<a href="${blob(source, commit)}"><code>${escapeHtml(source)}</code></a>`)
    .join(' and ')
  const title = page.file === 'index.html' ? 'Sentra' : `${page.title} · Sentra`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="color-scheme" content="light dark">
<meta name="description" content="${escapeHtml(page.summary.replaceAll('`', ''))}">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="site.css">
</head>
<body>
<a class="skip" href="#content">Skip to the content</a>
<header class="site">
<div class="wrap">
<a class="brand" href="index.html">Sentra</a>
<nav aria-label="Pages">
<ul>
${nav}
<li><a href="${REPOSITORY}">GitHub</a></li>
</ul>
</nav>
</div>
</header>
<main id="content" class="wrap">
${body}
</main>
<footer class="site">
<div class="wrap">
<p>Rendered from ${sources} at commit <a href="${REPOSITORY}/commit/${commit}"><code>${commit.slice(0, 12)}</code></a> by <a href="${blob('scripts/site.ts', commit)}"><code>scripts/site.ts</code></a>, and rebuilt by CI when they change.</p>
<p>The source, the dataset and every number on this site: <a href="${REPOSITORY}">AKogut/ai-flaky-test-triage</a>.</p>
</div>
</footer>
</body>
</html>
`
}

/** The index's own section: the other pages, each with its summary. */
function directory(all: readonly Page[]): string {
  const code = (text: string): string =>
    escapeHtml(text).replace(/`([^`]+)`/g, (_match, span: string) => `<code>${span}</code>`)
  const items = all
    .filter((page) => page.file !== 'index.html')
    .map(
      (page) =>
        `<li><a href="${page.file}">${escapeHtml(page.title)}</a>: ${code(page.summary)}</li>`,
    )
    .join('\n')
  return `<h2 id="on-this-site">On this site</h2>\n<ul>\n${items}\n</ul>`
}

/**
 * Every relative `href` and `src` on the site reaches a file it has, and every
 * `#fragment` an element with that id. Collected, so one run reports them all.
 */
export function checkLinks(files: ReadonlyMap<string, string>, others: readonly string[]): void {
  const present = new Set([...files.keys(), ...others])
  const broken: string[] = []
  for (const [file, html] of files) {
    for (const [, url = ''] of html.matchAll(/\b(?:href|src)="([^"]*)"/g)) {
      const href = url.replaceAll('&amp;', '&')
      if (external(href)) continue
      const at = href.indexOf('#')
      const target = (at < 0 ? href : href.slice(0, at)) || file
      const id = at < 0 ? '' : decodeURIComponent(href.slice(at + 1))
      if (!present.has(decodeURI(target))) broken.push(`${file} -> ${href}: no such file`)
      else if (id !== '' && files.get(target)?.includes(` id="${id}"`) !== true)
        broken.push(`${file} -> ${href}: ${target} has no element with id "${id}"`)
    }
  }
  if (broken.length > 0) throw new Error(`Broken links on the site:\n  ${broken.join('\n  ')}`)
}

export function build(inputs: Inputs, repo: Repo, commit: string): Site {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`"${commit}" is not a full commit SHA`)
  const all = pages(inputs)
  const assets = new Set<string>()
  const files = new Map<string, string>()
  for (const page of all) {
    const content = render(page.markdown, page, repo)
    const notice =
      page.notice === undefined
        ? ''
        : `<div class="notice" role="note">\n${render(page.notice, page, repo).html}</div>\n`
    const extra = page.file === 'index.html' ? `\n${directory(all)}` : ''
    for (const asset of content.assets) assets.add(asset)
    files.set(page.file, document(page, notice + content.html + extra, all, commit))
  }
  checkLinks(files, ['site.css', ...assets])
  return { pages: files, assets: [...assets].sort() }
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

const kind = (path: string): 'file' | 'directory' | undefined => {
  const stat = statSync(path, { throwIfNoEntry: false })
  return stat === undefined ? undefined : stat.isDirectory() ? 'directory' : 'file'
}

/**
 * The demo, in replay mode whatever the environment holds: a build with an API
 * key in its shell must not spend it. Its report is kept rather than written to
 * report.md, so its banner, which ends "Wrote report.md", is not printed either.
 */
async function runDemo(): Promise<string> {
  let report: string | undefined
  await demo({
    env: { SENTRA_REPLAY: '1' },
    write: (path, contents) => {
      if (path === DEMO_OUTPUT) report = contents
    },
    log: () => undefined,
  })
  if (report === undefined) throw new Error(`npm run demo wrote no ${DEMO_OUTPUT}`)
  return report
}

export interface SiteDeps {
  /** The commit the pages say they were built from. Defaults to `HEAD`. */
  commit?: string
  /** The demo's `report.md`. Defaults to running the demo. */
  demo?: () => Promise<string>
  out?: string
  log?: (message: string) => void
}

export async function main(deps: SiteDeps = {}): Promise<number> {
  const log = deps.log ?? console.log
  const out = deps.out ?? OUT_DIR
  const commit =
    deps.commit ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const read = (path: string): string => readFileSync(path, 'utf8')
  const inputs: Inputs = {
    readme: read('README.md'),
    report: read('eval/report.md'),
    ablation: read('eval/ablation.md'),
    demo: await (deps.demo ?? runDemo)(),
  }
  const site = build(inputs, { kind }, commit)

  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  for (const [file, html] of site.pages) writeFileSync(join(out, file), html)
  copyFileSync(STYLESHEET, join(out, 'site.css'))
  for (const asset of site.assets) {
    mkdirSync(dirname(join(out, asset)), { recursive: true })
    copyFileSync(asset, join(out, asset))
  }
  log(
    `Wrote ${[...site.pages.keys()].join(', ')}, site.css and ${String(site.assets.length)} image(s) to ${out}/, from commit ${commit.slice(0, 12)}.`,
  )
  log(`The example report is npm run demo's, with the ${demoClassifier(inputs.demo)} classifier.`)
  return 0
}

if (process.argv[1]?.endsWith('site.ts') === true) {
  process.exitCode = await main()
}
