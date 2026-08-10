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
  // Guardrail: agents cannot touch the filesystem or spawn processes.
  //
  // docs/limitations-and-guardrails.md promises that agents never modify the
  // working tree. A promise kept by discipline is not a guardrail; this makes it
  // a build failure.
  //
  // The orchestrator and the report writer are deliberately outside this scope —
  // they are the one component allowed to write, and exactly one file. That is
  // asserted at runtime instead, by the guardrail suite in #69.
  // ---------------------------------------------------------------------------
  {
    files: [
      'agents/triage/**/*.ts',
      'agents/root-cause/**/*.ts',
      'agents/fix-suggestion/**/*.ts',
      'agents/context/**/*.ts',
      'agents/prompts/**/*.ts',
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
