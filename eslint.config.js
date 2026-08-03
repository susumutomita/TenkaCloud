import sonarjs from "eslint-plugin-sonarjs";
import tseslint from "typescript-eslint";

// Keep the initial typed-lint scope bounded to repository automation scripts so rollout stays measurable.
const typedSourceFiles = ["scripts/**/*.ts"];
const testFiles = ["**/*.test.ts", "**/*.spec.ts"];

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/cdk.out/**",
      "**/cdk.out.test/**",
      "landing/**",
      "problems/**",
    ],
  },
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  sonarjs.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: {
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/ban-ts-comment": "error",
      // `_` prefix is this repo's existing "intentionally unused" marker (rest-sibling omit
      // idiom, interface-mandated parameters). Without an ignore pattern the rule has no way to
      // express that, so it reported deliberate placeholders. An *unprefixed* unused binding is
      // still an error — this narrows the rule's vocabulary, not its reach.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          // `const { secret, ...rest } = x` is the omit idiom, not a dead binding.
          // sonarjs/no-unused-vars recognises it only in this shorthand form, so both rules
          // have to agree on it or the two contradict each other.
          ignoreRestSiblings: true,
        },
      ],
      // no-floating-promises requires `void promise` for intentionally detached
      // work, so Sonar's blanket ban would make the two rules contradictory.
      "sonarjs/void-use": "off",
    },
  },
  {
    files: typedSourceFiles,
    ignores: testFiles,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        // Type-aware lint needs every linted file to belong to the program. `tsconfig.scripts.json`
        // is the *typecheck gate* scope and #2861 narrowed it to a single file, so sharing it made
        // the parser reject every other script with "The file was not found in any of the provided
        // project(s)" (#2862 — 97 of the 148 findings). Lint therefore gets its own project that
        // inherits the same compilerOptions but spans all of scripts/.
        //
        // That project additionally turns on `noUncheckedIndexedAccess`, which the typecheck gate
        // does not: without it `argv[i]` is typed `string`, so sonarjs/different-types-comparison
        // called four real `=== undefined` guards over argv / split() results dead code. The flag
        // only makes the lint program's types *less* optimistic and adds no findings of its own.
        project: ["./tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/no-misused-promises": "warn",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-base-to-string": "error",
    },
  },
];
