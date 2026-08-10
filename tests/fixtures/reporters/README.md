# Reporter fixtures

Real output from the pinned reporter versions, produced by running the tool — not hand-written to
match what its documentation says. Hand-written fixtures encode the author's belief about a format,
and that belief is exactly what breaks on an upgrade.

| File                     | Produced by                                    | Contains                                                                                                                                                    |
| ------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `playwright-1.62.1.json` | `@playwright/test` JSON reporter, `retries: 2` | nested suites, a pass, an assertion failure retried to exhaustion, a test that failed then passed on retry, a `test.skip` with an annotation, and a timeout |

Absolute paths from the machine that produced them are rewritten to `/repo`, and the node binary
path to `/usr/local/bin/node`. Nothing else is edited: the point is that the shape is genuine.

Regenerating these is deliberately manual — see the pinned versions asserted in
`tests/unit/reporter-contract.test.ts`. A version bump should be a conscious update with the new
output committed, not a silent refresh.
