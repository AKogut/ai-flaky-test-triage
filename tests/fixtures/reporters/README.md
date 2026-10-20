# Reporter fixtures

Real output from the pinned reporter versions, produced by running the tool — not hand-written to
match what its documentation says. Hand-written fixtures encode the author's belief about a format,
and that belief is exactly what breaks on an upgrade.

| File                     | Produced by                                    | Contains                                                                                                                                                    |
| ------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `playwright-1.64.1.json` | `@playwright/test` JSON reporter, `retries: 2` | nested suites, a pass, an assertion failure retried to exhaustion, a test that failed then passed on retry, a `test.skip` with an annotation, and a timeout |
| `vitest-5.0.5.json`      | Vitest JSON reporter                           | a nested `describe`, a pass, a failed assertion, a thrown `TypeError`, and an `it.skip`                                                                     |

Absolute paths from the machine that produced them are rewritten to `/repo`, and the node binary
path to `/usr/local/bin/node`. Nothing else is edited: the point is that the shape is genuine.

Regenerating these is deliberately manual — see the pinned versions asserted in
`tests/unit/reporter-contract.test.ts`. A version bump should be a conscious update with the new
output committed, not a silent refresh.

## Regenerating

The inputs are in [`source/`](source/). They sit outside every glob this repository's own runners
use, and ESLint ignores them: they are what the fixtures were made from, not tests of this project.

Run them in an empty directory, with nothing installed but the versions being pinned:

```bash
dir=$(mktemp -d) && cp -R tests/fixtures/reporters/source/. "$dir" && cd "$dir"
echo '{ "type": "module" }' > package.json
npm install -D @playwright/test@<version> vitest@<version> typescript
npx playwright test                                    # writes report.json; exits 1 by design
npx vitest run --reporter=json --outputFile=vitest-report.json
```

Then rewrite `$dir` to `/repo` and the node binary to `/usr/local/bin/node`, save the two reports as
`playwright-<version>.json` and `vitest-<version>.json`, and run Prettier over them. Every error
location in the committed fixtures — `tasks.test.ts:10:31`, `sample.spec.ts:21:13` and the rest —
comes from these files, so they must not be reformatted or reflowed. A line that moves changes the
output.

The two files were rebuilt from the earlier fixtures when moving to 1.64.1 / 5.0.5. Run under
1.62.1 / 4.1.10, the Vitest input reproduces its earlier fixture field for field, timings aside.
The Playwright input reproduces its fixture except in two places:

- **The code frame around the flaky test's assertion.** The original counted attempts in a file on
  disk, so it had to be deleted before every run. This one reads `testInfo.retry`, which needs no
  cleanup.
- **The `column` of each `test()` call.** No normaliser reads it.
