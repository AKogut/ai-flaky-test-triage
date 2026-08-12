import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

/**
 * Flat config. Formatting is Prettier's job entirely — `eslint-config-prettier`
 * is applied last and turns off every stylistic rule that could disagree with it,
 * so there is exactly one tool with an opinion about whitespace.
 */

/** Node's filesystem and process-spawning modules, in both bare and prefixed form. */
const IO_MODULES = ['fs', 'node:fs', 'fs/promises', 'node:fs/promises']
const EXEC_MODULES = ['child_process', 'node:child_process']

const restrict = (modules, message) => modules.map((name) => ({ name, message }))

/** Repeated by every block that configures `no-restricted-imports` under `agents/`. */
const SDK_PATTERN = {
  group: ['@anthropic-ai/sdk', '@anthropic-ai/sdk/*'],
  message:
    'Model calls go through agents/transport.ts. A second SDK client would bypass replay, sanitisation, the token budget and telemetry — see docs/agent-design.md.',
}

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      // The orchestrator fans out asynchronous work. A dropped promise there would
      // silently swallow one test's entire classification and report success, which
      // is the worst failure shape this pipeline can have.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // verbatimModuleSyntax is on, so the type/value distinction has to be explicit
      // anyway. Enforcing it here makes the compiler error arrive as a lint fix.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // Every entry point here is a CLI. Printing is the interface.
      'no-console': 'off',

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-param-reassign': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
    },
  },

  // ---------------------------------------------------------------------------
  // Guardrail: exactly one module may construct an SDK client.
  //
  // Replay, sanitisation, the token budget and telemetry are all properties of
  // going through `agents/transport.ts`. A second module that builds its own
  // client keeps every one of those working right up until the first call site
  // that forgets, and then loses them silently. This makes that a build failure
  // rather than something review has to catch every time.
  // ---------------------------------------------------------------------------
  {
    files: ['agents/**/*.ts'],
    // Exactly the transport and its own test. The test constructs real SDK
    // errors on purpose — the mapping it checks is the part that rots when the
    // SDK's exception hierarchy moves. Exempting `**/*.test.ts` wholesale would
    // let any agent's test build a client and quietly become the template for
    // the production code beside it.
    ignores: ['agents/transport.ts', 'agents/transport.test.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [SDK_PATTERN] }],
    },
  },

  // ---------------------------------------------------------------------------
  // Guardrail: the pure agent modules touch neither the filesystem nor a process.
  //
  // docs/limitations-and-guardrails.md promises that agents never modify the
  // working tree. A promise kept by discipline is not a guardrail; this makes it
  // a build failure.
  //
  // The orchestrator and the report writer are deliberately outside this scope —
  // they are the one component allowed to write, and exactly one file. That is
  // asserted at runtime instead, by the guardrail suite in #69.
  //
  // This block **must come after the SDK block and must repeat its pattern.**
  // Flat config resolves a rule to its last matching entry rather than merging
  // the entries, so two blocks configuring `no-restricted-imports` over
  // overlapping files means one of them silently does nothing. It did: the SDK
  // block matched `agents/**` and replaced this one wholesale, so the filesystem
  // guardrail was off for every file it was written to protect. Only a test that
  // feeds the config a violation catches that, which is why one exists —
  // `tests/unit/lint-guardrails.test.ts`.
  // ---------------------------------------------------------------------------
  {
    files: [
      'agents/triage/**/*.ts',
      'agents/root-cause/**/*.ts',
      'agents/fix-suggestion/**/*.ts',
      'agents/context/**/*.ts',
      'agents/prompts/**/*.ts',
      // The pure modules that exist today as single files. Listed rather than
      // matched by a wildcard over `agents/`, because the transport and the
      // cassette store read and write on purpose.
      'agents/context.ts',
      'agents/sanitise.ts',
      'agents/redact.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            ...restrict(
              IO_MODULES,
              'Agents have no filesystem access. Callers read paths and pass the contents in — see docs/limitations-and-guardrails.md.',
            ),
            ...restrict(
              EXEC_MODULES,
              'Agents cannot spawn processes. Git access goes through the read-only facade — see docs/limitations-and-guardrails.md.',
            ),
          ],
          patterns: [SDK_PATTERN],
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Config and script files are plain JavaScript and are not in any tsconfig,
  // so type-aware rules cannot run against them.
  // ---------------------------------------------------------------------------
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  prettier,
)
