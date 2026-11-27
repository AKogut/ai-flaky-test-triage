# Wiki source

These files are the source of truth for the
[GitHub wiki](https://github.com/AKogut/ai-flaky-test-triage/wiki). They are versioned here so that
wiki changes go through review like everything else, rather than being edited live by whoever
happens to be logged in.

**Do not edit the wiki in the browser.** The next publish overwrites it.

`Home.md` and `Getting-Started.md` carry a status banner generated from `ROADMAP.md` by
`npm run docs:status`, the same generator the README uses. Do not hand-edit the block between the
`<!-- status:start -->` markers; CI checks it. Commands that are not implemented yet are marked
🚧 with the milestone and issue they arrive in — the wiki is the more public surface of the two,
so it gets the stricter convention, not an exemption from it.

## Publishing

Merging is publishing. [`.github/workflows/wiki.yml`](../.github/workflows/wiki.yml) runs on every
push to `main` that changes this directory or the publish script, and can be started by hand from
the Actions tab. It runs the same script a maintainer would:

```bash
npm run wiki:publish                  # or: ./scripts/publish-wiki.sh
./scripts/publish-wiki.sh --dry-run   # print the diff it would publish, push nothing
```

The script clones `…/ai-flaky-test-triage.wiki.git`, mirrors this directory into it except this
file, and pushes. When the wiki already matches, it says so and commits nothing. Page names come
from filenames: `Getting-Started.md` becomes the _Getting Started_ page.

Either way, the commit on the wiki carries the owner's name and GitHub noreply address. In CI the
push authenticates with the workflow's own `GITHUB_TOKEN`, granted `contents: write` on that one
job; no personal token exists for it. By hand the default remote is SSH and uses your key, and
`WIKI_REMOTE=https://github.com/AKogut/ai-flaky-test-triage.wiki.git` clones anonymously, which is
all a dry run needs.

`_Sidebar.md` and `_Footer.md` are special — GitHub renders them on every page.

### What CI holds these pages to

[`tests/unit/wiki.test.ts`](../tests/unit/wiki.test.ts) runs with the unit suite, so a page that
breaks one of these rules fails the build before it is published:

- every page links to the repository and, where it has one, to its counterpart there — a page
  added here needs a line in that test's counterpart map
- the `docs/` versus wiki rule stays stated on Home
- every term in the test's list has a Glossary entry, and so does every value of the `owner`,
  `determinism` and provenance enums and every `SENTRA_*` variable a page names
- every link between pages, and every link into the repository, resolves — anchors included,
  slugged the way GitHub slugs headings

### First-time setup

GitHub does not create the wiki's git repository until the wiki has at least one page, and there is
no API for creating that first page. Once, manually:

1. Open <https://github.com/AKogut/ai-flaky-test-triage/wiki>
2. Click **Create the first page**, save it with any content
3. Run the publish script — it overwrites that placeholder

## What belongs here, and what does not

|                    | Holds                                                                                  | Why                                               |
| ------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------- |
| [`docs/`](../docs) | Normative specs: schemas, contracts, labelling rules, ADRs                             | Versioned with the code and must match it exactly |
| `wiki/`            | Orientation and narrative: how things fit, why decisions were made, what to read first | Free to be discursive; nothing here is a contract |

Wiki pages link into `docs/` rather than copying specifications — two copies of a specification
means one of them is wrong, and it is never obvious which. A summary still restates some facts, a
guardrail's status or a milestone's, so a change that moves one of those updates the page in the
same pull request; where the two disagree, `docs/` and the code win. Measured figures are never
restated — they live in `eval/report.md`.

Because wiki pages render outside the repository, links to repository files must be absolute
(`https://github.com/AKogut/ai-flaky-test-triage/blob/main/...`). Links between wiki pages use the
bare page name: `[Getting Started](Getting-Started)`.
