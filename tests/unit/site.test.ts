import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { main as demo } from '../../scripts/demo.js'
import {
  build,
  checkLinks,
  CSP,
  demoClassifier,
  main,
  pages,
  render,
  REPOSITORY,
  resolveLink,
  SITE_URL,
  slug,
  STYLESHEET,
  tour,
  TOUR,
  type Repo,
} from '../../scripts/site.js'

/**
 * The project site, held to what scripts/site.ts says about it.
 *
 * Its promise is that it cannot disagree with the repository: every page is a
 * file in it, or the demo's own output, rendered at a named commit. So most of
 * what is checked here is the built site itself, from this checkout: that each
 * page is the file it names, that the example is the demo's report and says
 * which classifier wrote it, and that nothing on it reaches another origin or
 * points at a page or a heading that is not there.
 */

const root = new URL('../..', import.meta.url).pathname
const read = (path: string): string => readFileSync(join(root, path), 'utf8')
const COMMIT = '0123456789abcdef0123456789abcdef01234567'

/** A repository with exactly these files and directories. */
const repo = (files: string[], directories: string[] = []): Repo => ({
  kind: (path) =>
    files.includes(path) ? 'file' : directories.includes(path) ? 'directory' : undefined,
})

/** The report the demo writes, captured rather than written. */
async function demoReport(): Promise<string> {
  let report = ''
  await demo({
    env: { SENTRA_REPLAY: '1' },
    write: (_path, contents) => {
      report = contents
    },
    log: () => undefined,
  })
  return report
}

describe('the index', () => {
  const readme = read('README.md')

  it("is the README's title, its description and the 60-second tour", () => {
    const markdown = tour(readme)
    expect(markdown.startsWith('# Sentra\n\n**')).toBe(true)
    expect(markdown).toContain(`\n${TOUR}\n`)
    expect(markdown).toContain('**Read next:**')
  })

  it('stops at the rule that ends the tour', () => {
    expect(tour(readme)).not.toContain('## The problem')
    expect(tour('# T\n\nline\n\n## The 60-second tour\n\n- a\n\n---\n\n- b')).toBe(
      '# T\n\nline\n\n## The 60-second tour\n\n- a',
    )
  })

  it('stops at the next heading where there is no rule, or at the end', () => {
    expect(tour('# T\n\nline\n\n## The 60-second tour\n\n- a\n\n## Next\n\n- b')).not.toContain(
      'Next',
    )
    expect(tour('# T\n\nline\n\n## The 60-second tour\n\n- a\n')).toMatch(/- a$/)
  })

  it('fails the build when the README has no tour to render', () => {
    expect(() => tour('# T\n\n## The tour\n')).toThrow(/no "## The 60-second tour" section/)
    expect(() => tour('## The 60-second tour\n')).toThrow(/no "## The 60-second tour" section/)
  })
})

describe('a link', () => {
  const files = ['README.md', 'docs/architecture.md', 'eval/report.md', 'eval/ablation.md']
  const here = repo(files, ['docs', 'docs/adr'])
  const full = { base: 'eval/report.md' }
  const excerpt = { base: 'README.md', excerpt: true }

  it('to a file the site renders goes to its page, keeping the fragment', () => {
    expect(resolveLink('eval/report.md', excerpt, here)).toBe('report.html')
    expect(resolveLink('ablation.md#comparison', full, here)).toBe('ablation.html#comparison')
    expect(resolveLink('/eval/ablation.md', full, here)).toBe('ablation.html')
  })

  it('to any other file goes to it on GitHub, on main', () => {
    expect(resolveLink('../docs/architecture.md#layers', full, here)).toBe(
      `${REPOSITORY}/blob/main/docs/architecture.md#layers`,
    )
    expect(resolveLink('docs/adr/', excerpt, here)).toBe(`${REPOSITORY}/tree/main/docs/adr`)
    expect(resolveLink('../', full, here)).toBe(REPOSITORY)
  })

  it('to a heading stays on the page, unless the page is an excerpt', () => {
    expect(resolveLink('#headline', full, here)).toBe('#headline')
    expect(resolveLink('#what-it-posts-today', excerpt, here)).toBe(
      `${REPOSITORY}/blob/main/README.md#what-it-posts-today`,
    )
  })

  it('to another site is left alone, and to this one is made relative', () => {
    for (const href of ['https://example.com/a', 'mailto:a@example.com', '//example.com'])
      expect(resolveLink(href, full, here)).toBe(href)
    expect(resolveLink(SITE_URL, excerpt, here)).toBe('index.html')
    expect(resolveLink(`${SITE_URL}report.html#cost`, excerpt, here)).toBe('report.html#cost')
  })

  it('to nothing fails the build, naming the page and the link', () => {
    expect(() => resolveLink('../docs/missing.md', full, here)).toThrow(
      'eval/report.md links to ../docs/missing.md, and there is no docs/missing.md',
    )
    expect(() => resolveLink('../../etc/passwd', full, here)).toThrow(/outside the repository/)
  })
})

describe('rendering', () => {
  const here = repo(['README.md', 'docs/assets/demo.gif', 'docs/assets/dark.png'])
  const page = { base: 'README.md' }

  it("gives headings GitHub's anchors, numbering repeats", () => {
    const { html } = render('# A `b` c\n\n## Same\n\n## Same\n', page, here)
    expect(html).toContain('<h1 id="a-b-c">A <code>b</code> c</h1>')
    expect(html).toContain('<h2 id="same">Same</h2>')
    expect(html).toContain('<h2 id="same-1">Same</h2>')
  })

  it.each([
    [
      "Baseline control — the agent's ablation waits on #38",
      'baseline-control--the-agents-ablation-waits-on-38',
    ],
    ['By difficulty bucket', 'by-difficulty-bucket'],
    ['`owner`', 'owner'],
    ['snake_case and 3.5%', 'snake_case-and-35'],
  ])('slugs %j as %j', (text, expected) => {
    expect(slug(text)).toBe(expected)
  })

  it('wraps each table in a scrollable region named for its section', () => {
    const { html } = render('## Cost\n\n| a | b |\n| - | -: |\n| 1 | 2 |\n', page, here)
    expect(html).toContain('<div class="table" role="region" aria-label="Cost" tabindex="0">')
    expect(html).toContain('<td align="right">2</td>')
    expect(render('| a |\n| - |\n| 1 |\n', page, here).html).toContain('aria-label="Table"')
  })

  it('resolves the URLs in HTML written into the Markdown, and serves its images', () => {
    const { html, assets } = render(
      [
        '<img src="docs/assets/demo.gif" width="760" alt="A">',
        '',
        '<picture><source srcset=\'docs/assets/dark.png 2x\'><a href="https://example.com/?a=1&amp;b=2">x</a></picture>',
        '',
        '![still](docs/assets/demo.gif)',
      ].join('\n'),
      page,
      here,
    )
    expect(html).toContain('<img src="docs/assets/demo.gif" width="760" alt="A">')
    expect(html).toContain('srcset="docs/assets/dark.png 2x"')
    expect(html).toContain('href="https://example.com/?a=1&amp;b=2"')
    expect(html).toContain('<img src="docs/assets/demo.gif" alt="still">')
    expect(assets.sort()).toEqual(['docs/assets/dark.png', 'docs/assets/demo.gif'])
  })

  /** The page's Content-Security-Policy would block it, so it would ship broken. */
  it('fails the build on an image from another origin, or one that is not there', () => {
    expect(() => render('![b](https://img.shields.io/x.svg)', page, here)).toThrow(
      /Content-Security-Policy blocks images from anywhere else/,
    )
    expect(() => render('<img src="data:image/png;base64,AA">', page, here)).toThrow(
      /Content-Security-Policy/,
    )
    expect(() => render('![b](docs/assets/gone.png)', page, here)).toThrow(
      /there is no docs\/assets\/gone.png/,
    )
  })
})

describe('the example page', () => {
  it('is labelled from the line in which the demo names its classifier', async () => {
    expect(demoClassifier(await demoReport())).toBe('baseline')
    expect(demoClassifier('> Produced by `npm run demo` with the **agent** classifier — x')).toBe(
      'agent',
    )
  })

  it('cannot be built from a report that does not say which classifier wrote it', () => {
    expect(() => demoClassifier('# Flaky-test triage\n')).toThrow(/does not name a classifier/)
    expect(() => demoClassifier('with the **constructor** classifier')).toThrow(
      /does not name a classifier/,
    )
  })
})

describe('the link check', () => {
  it('reports every link to a missing file or a missing id, all at once', () => {
    const files = new Map([
      ['a.html', '<a href="b.html#nope">x</a><a href="c.html">y</a><a href="#top">z</a>'],
      ['b.html', '<h1 id="top">B</h1><img src="d.png"><a href="https://example.com">e</a>'],
    ])
    expect(() => checkLinks(files, ['d.png'])).toThrow(
      [
        'Broken links on the site:',
        '  a.html -> b.html#nope: b.html has no element with id "nope"',
        '  a.html -> c.html: no such file',
        '  a.html -> #top: a.html has no element with id "top"',
      ].join('\n'),
    )
    expect(() =>
      checkLinks(new Map([['b.html', files.get('b.html') ?? '']]), ['d.png']),
    ).not.toThrow()
  })
})

describe('the site, built from this checkout', () => {
  const out = mkdtempSync(join(tmpdir(), 'sentra-site-'))
  const html = new Map<string, string>()
  const logged: string[] = []
  let report = ''

  beforeAll(async () => {
    writeFileSync(join(out, 'stale.html'), 'left over from an earlier build')
    report = await demoReport()
    expect(await main({ out, commit: COMMIT, log: (line) => logged.push(line) })).toBe(0)
    for (const file of ['index.html', 'report.html', 'ablation.html', 'example.html'])
      html.set(file, readFileSync(join(out, file), 'utf8'))
  })

  it('writes the four pages, the stylesheet and the images they show, and nothing else', () => {
    const written = readdirSync(out, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(out, join(entry.parentPath, entry.name)))
    expect(written.sort()).toEqual([
      'ablation.html',
      'docs/assets/demo.gif',
      'example.html',
      'index.html',
      'report.html',
      'site.css',
    ])
    expect(readFileSync(join(out, 'site.css'), 'utf8')).toBe(read(STYLESHEET))
    expect(readFileSync(join(out, 'docs/assets/demo.gif'))).toEqual(
      readFileSync(join(root, 'docs/assets/demo.gif')),
    )
    expect(existsSync(join(out, 'stale.html'))).toBe(false)
    expect(logged.join('\n')).toContain('with the baseline classifier')
  })

  /** No script, no font, no tracker: the policy forbids them, and the markup does not try. */
  it('loads nothing from another origin and runs nothing', () => {
    for (const [file, page] of html) {
      expect(page, file).toContain(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`)
      expect(page, file).not.toMatch(/<script|<iframe|<style|\sstyle=|\son[a-z]+=|javascript:/i)
      expect(page.match(/<link\b[^>]*>/g), file).toEqual([
        '<link rel="stylesheet" href="site.css">',
      ])
      expect(page, file).not.toMatch(/\s(?:src|srcset)="(?:[a-z]+:|\/\/)/i)
    }
    expect(read(STYLESHEET)).not.toMatch(/@import|url\(/)
  })

  it('is one document per page, in English, at phone width, in both colour schemes', () => {
    for (const [file, page] of html) {
      expect(page.startsWith('<!doctype html>\n<html lang="en">'), file).toBe(true)
      expect(page, file).toContain(
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
      )
      expect(page, file).toContain('<meta name="color-scheme" content="light dark">')
      expect(page.match(/<h1 /g), file).toHaveLength(1)
    }
    expect(read(STYLESHEET)).toContain('@media (prefers-color-scheme: dark)')
  })

  it('names, on every page, the files it was made from and the commit, and links the repository', () => {
    const sources: Record<string, string[]> = {
      'index.html': ['README.md'],
      'report.html': ['eval/report.md'],
      'ablation.html': ['eval/ablation.md'],
      'example.html': ['scripts/demo.ts', 'demo/analysis.json'],
    }
    for (const [file, page] of html) {
      for (const source of sources[file] ?? [])
        expect(page, file).toContain(
          `<a href="${REPOSITORY}/blob/${COMMIT}/${source}"><code>${source}</code></a>`,
        )
      expect(page, file).toContain(
        `<a href="${REPOSITORY}/commit/${COMMIT}"><code>${COMMIT.slice(0, 12)}</code></a>`,
      )
      expect(page, file).toContain(`<a href="${REPOSITORY}">`)
    }
  })

  it('marks the page you are on, and only that one', () => {
    for (const [file, page] of html) {
      expect(page.match(/aria-current="page"/g), file).toHaveLength(1)
      expect(page, file).toContain(`<a href="${file}" aria-current="page">`)
    }
  })

  /** Read off the disk, not from the build's own check, so the two are independent. */
  it('has no relative link to a file or a heading that is not there', () => {
    for (const [file, page] of html) {
      for (const [, url = ''] of page.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
        if (/^(?:[a-z]+:|\/\/)/.test(url)) continue
        const [path = '', id] = url.split('#')
        const target = path === '' ? file : path
        expect(existsSync(join(out, target)), `${file} -> ${url}`).toBe(true)
        if (id !== undefined) expect(html.get(target), `${file} -> ${url}`).toContain(` id="${id}"`)
      }
    }
  })

  it('renders each report from the file it names', () => {
    const revision = /dataset revision\s*\|\s*`([0-9a-f]+)`/.exec(read('eval/report.md'))?.[1]
    expect(revision).toBeDefined()
    expect(html.get('report.html')).toContain(`<code>${revision ?? ''}</code>`)
    expect(html.get('report.html')).toContain('<h2 id="headline">Headline</h2>')
    expect(html.get('ablation.html')).toContain('<h1 id="ablation-study">Ablation study</h1>')
    expect(html.get('index.html')).toContain('<h2 id="the-60-second-tour">The 60-second tour</h2>')
  })

  it("shows the demo's report as the example, labelled with the classifier that wrote it", () => {
    const example = html.get('example.html') ?? ''
    expect(example).toContain(render(report, { base: 'report.md' }, { kind: () => 'file' }).html)
    expect(example).toContain('with the <strong>baseline</strong> classifier — ')
    expect(example).toMatch(
      /<div class="notice" role="note">\n<p><strong>An example, not a live classification\.<\/strong>[\s\S]*with the <strong>baseline<\/strong> classifier, a heuristic that calls no model\./,
    )
  })

  it('lists the other pages on the index, each with its summary', () => {
    const index = html.get('index.html') ?? ''
    const all = pages({ readme: read('README.md'), report: '', ablation: '', demo: report })
    expect(all.map((page) => page.file)).toEqual([...html.keys()])
    for (const page of all.filter((other) => other.file !== 'index.html'))
      expect(index).toContain(`<li><a href="${page.file}">${page.title}</a>: `)
  })

  it('stamps the commit HEAD is at when none is given', async () => {
    const other = mkdtempSync(join(tmpdir(), 'sentra-site-'))
    await main({ out: other, demo: () => Promise.resolve(report), log: () => undefined })
    expect(readFileSync(join(other, 'index.html'), 'utf8')).toMatch(
      new RegExp(`${REPOSITORY}/commit/[0-9a-f]{40}"`),
    )
  })
})

describe('the build', () => {
  const inputs = {
    readme: read('README.md'),
    report: '# R\n',
    ablation: '# A\n',
    demo: 'with the **baseline** classifier',
  }
  const here: Repo = {
    kind: (path) => (/^(?:docs|demo)\/|\.md$/.test(path) ? 'file' : undefined),
  }

  it('refuses a commit that is not a full SHA, because every page links to it', () => {
    expect(() => build(inputs, here, 'HEAD')).toThrow('"HEAD" is not a full commit SHA')
    expect(() => build(inputs, here, COMMIT.slice(0, 12))).toThrow(/not a full commit SHA/)
  })

  it('stops before writing anything when the demo report is not one it can label', async () => {
    const out = mkdtempSync(join(tmpdir(), 'sentra-site-'))
    await expect(
      main({ out, commit: COMMIT, demo: () => Promise.resolve('# x\n'), log: () => undefined }),
    ).rejects.toThrow(/does not name a classifier/)
    expect(existsSync(join(out, 'index.html'))).toBe(false)
  })
})
