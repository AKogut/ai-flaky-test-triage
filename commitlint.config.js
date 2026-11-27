/**
 * Commit messages are a data contract, not a style preference: `CHANGELOG.md` and
 * the release notes are generated from `main`'s history, and `main`'s history is
 * made entirely of squashed pull-request titles.
 *
 * Types and scopes are kept in step with docs/branching-strategy.md. The
 * `PR title convention` job in .github/workflows/ci.yml runs commitlint with this
 * file rather than a copy of its lists, so the local hook and the CI check cannot
 * disagree — a commit that passes one and fails the other would be worse than
 * either gate on its own.
 */

/**
 * The title Dependabot writes for a version bump, under the three prefixes
 * .github/dependabot.yml gives it, and nothing else:
 *
 *   bump <package> from <version> to <version>
 *   bump <package> from <version> to <version> in the <group> group
 *   bump <package> from <version> to <version> in the <group> group across 1 directory
 *   bump <package> from <version> to <version> in /<directory>
 *   bump the <group> group with <n> updates
 *   bump the <group> group across 1 directory with <n> updates
 *
 * `in /<directory>` is what Dependabot adds for an entry that is not the
 * repository root — the Codespace image under /.devcontainer (#292).
 *
 * Anchored at both ends, so a title that only borrows the opening is not one.
 */
const DEPENDABOT_BUMP =
  /^(?:chore\(deps(?:-dev)?\)|ci\(deps\)): bump (?:\S+ from \S+ to \S+(?: in the \S+ group(?: across \d+ director(?:y|ies))?| in \/\S+)?|the \S+ group(?: across \d+ director(?:y|ies))? with \d+ updates)$/

/**
 * A length limit that a Dependabot bump is let off. Its length is a package
 * name, two versions and a group name, none of them chosen here, and the only
 * way to shorten it is by hand: #271 took an edited title and a close and
 * reopen, because a re-run reads the title the event recorded. It never
 * reaches the changelog, which omits `chore` and `ci`.
 *
 * Both limits need it. The #271 title is 99 characters of header, so with
 * only the subject let off, the same bump of a package whose name is two
 * characters longer than `lint-staged` would fail on the header instead.
 */
const maxLengthExceptBumps = (field) => (parsed, _when, max) => {
  const length = parsed[field]?.length ?? 0
  return [
    length <= max || DEPENDABOT_BUMP.test(parsed.header ?? ''),
    `${field} must not be longer than ${max} characters, current length is ${length}`,
  ]
}

/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  plugins: [
    {
      rules: {
        'subject-max-length-except-bumps': maxLengthExceptBumps('subject'),
        'header-max-length-except-bumps': maxLengthExceptBumps('header'),
      },
    },
  ],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'docs', 'test', 'chore', 'refactor', 'perf', 'build', 'ci', 'revert'],
    ],

    // A free-form scope field degrades into noise within a month, and the
    // changelog groups by scope. `deps` and `deps-dev` are here because
    // Dependabot is configured to emit them (.github/dependabot.yml).
    'scope-enum': [
      2,
      'always',
      [
        'app',
        'client',
        'server',
        'tests',
        'e2e',
        'flakemetry',
        'agents',
        'triage',
        'root-cause',
        'fix-suggestion',
        'eval',
        'dataset',
        'prompts',
        'ci',
        'docs',
        'otel',
        'deps',
        'deps-dev',
        'release',
      ],
    ],
    'scope-empty': [1, 'never'],

    // Holds for the PR title too: the CI job runs this config, not a regex of its own.
    //
    // Length is the only rule a Dependabot bump is let off. Type, scope, case and
    // full stop still run against it, with the same lists as every other title.
    // An `ignores` entry would have skipped every rule for a title it matched,
    // and turned its pattern into a second copy of the type and scope lists. The
    // built-in length rules are off rather than left beside these, because one
    // failing rule fails the title whatever the others make of it. 100 is
    // config-conventional's own header limit.
    'subject-max-length': [0],
    'subject-max-length-except-bumps': [2, 'always', 72],
    'header-max-length': [0],
    'header-max-length-except-bumps': [2, 'always', 100],
    'subject-case': [2, 'never', ['start-case', 'pascal-case', 'upper-case']],
    'subject-full-stop': [2, 'never', '.'],

    'body-max-line-length': [1, 'always', 100],
  },
}
