# Replay cassettes

Recorded model responses, committed so the pipeline runs with no API key and no network — the
claim [ADR-0005](../../../docs/adr/0005-replay-cassettes-for-credential-free-demo.md) exists to
make true, and what makes the integration tests free and deterministic.

Empty until the first recorded evaluation lands in #38 — recording needs credentials, so it is a
deliberate act with a cost rather than something that happens on the way past. Until then
`npm run demo` runs the model-free baseline and says so, and the integration tests drive the agent
through stub transports instead. The machinery that reads and writes these files is
`agents/cassettes.ts`.

## Recording

```bash
npm run cassettes:record
```

One command, two passes — the golden dataset and the bundled demo run. They ask for different
things, and re-recording only one leaves the other replaying answers to questions nobody asks any
more. Commit whatever it writes.

Recording needs credentials and costs money; it is the only script here that does, which is why it
refuses to start without them rather than producing a confident-looking run that recorded nothing.

## Checking

```bash
npm run cassettes:check
```

Offline, free, and run in CI on every push. It asks the triage agent to assemble the requests it
*would* send and compares their keys against these files, reporting three things separately:

- **missing** — a request with nothing recorded for it. Replay fails here.
- **stale** — recorded under a prompt version or model no longer in use. Expected after a bump.
- **orphaned** — recorded under the *current* version and model, and still unrequested. The
  alarming one: same version, same model, different content means the prompt or the assembled
  context moved without the version being bumped, so any published number attributed to that
  version describes text that no longer exists.

## Reading a diff

Each file is one request and one response. `system` and `prompt` are stored as arrays of lines
rather than as strings, so a reworded prompt reviews line by line instead of as a single altered
line thousands of characters long.

`schemaDigest` stands in for the response schema. The schema is derived from a Zod type, runs to
hundreds of lines, and would bury the prompt in every review — but it still belongs in the
cassette's identity, because a reshaped output is a different question even when the prose is
identical. Hashing it keeps it in the key without putting it on the page.

## Rules

**A replay miss is an error, never a live call.** A silent fallthrough turns a free deterministic
run into a surprise bill and an intermittent test, and takes months to notice. The error names the
missing key and the command above.

**Do not hand-edit a cassette.** The point of a recording is that it is what the model actually
said. An edited one is a fixture pretending to be evidence, and every number derived from it
inherits the pretence. Re-record instead.

**Secrets are scrubbed on write** — Anthropic keys, bearer tokens, GitHub and AWS and Slack
credentials. That scrub is the last point at which a leaked credential can be caught before it is
in public git history forever, so it is deliberately broad.
