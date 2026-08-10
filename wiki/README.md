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

```bash
npm run wiki:publish        # or: ./scripts/publish-wiki.sh
```

The script clones `…/ai-flaky-test-triage.wiki.git`, mirrors this directory into it, and pushes.
Page names come from filenames: `Getting-Started.md` becomes the _Getting Started_ page.

`_Sidebar.md` and `_Footer.md` are special — GitHub renders them on every page.

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

Nothing is duplicated. Wiki pages link into `docs/` rather than restating it — two copies of a
specification means one of them is wrong, and it is never obvious which.

Because wiki pages render outside the repository, links to repository files must be absolute
(`https://github.com/AKogut/ai-flaky-test-triage/blob/main/...`). Links between wiki pages use the
bare page name: `[Getting Started](Getting-Started)`.
