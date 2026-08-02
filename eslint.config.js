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
        project: ["./tsconfig.scripts.json"],
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
