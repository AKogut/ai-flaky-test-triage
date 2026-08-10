/**
 * Commit messages are a data contract, not a style preference: `CHANGELOG.md` and
 * the release notes are generated from `main`'s history, and `main`'s history is
 * made entirely of squashed pull-request titles.
 *
 * Types and scopes are kept in step with docs/branching-strategy.md and with the
 * `PR title convention` job in .github/workflows/ci.yml. All three must agree —
 * a commit that passes the hook and fails the CI check would be worse than either
 * gate on its own.
 *
 * @type {import('@commitlint/types').UserConfig}
 */
export default {
  extends: ['@commitlint/config-conventional'],
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

    // Matches the `.{1,72}` in the CI PR-title regex.
    'subject-max-length': [2, 'always', 72],
    'subject-case': [2, 'never', ['start-case', 'pascal-case', 'upper-case']],
    'subject-full-stop': [2, 'never', '.'],

    'body-max-line-length': [1, 'always', 100],
  },
}
