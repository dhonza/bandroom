// @ts-check
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import i18next from "eslint-plugin-i18next";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const noDefaultExport = {
  selector: "ExportDefaultDeclaration",
  message: "Use named exports (project conventions).",
};

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/.data/**",
      "apps/server/drizzle/**",
      "playwright-report/**",
      "test-results/**",
      ".cache/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.js", "e2e/*.mjs", "e2e/ios-sim/*.mjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      "no-restricted-syntax": ["error", noDefaultExport],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
  {
    // Tool configs that require a default export.
    files: [
      "**/vite.config.ts",
      "**/vitest.config.ts",
      "**/playwright.config.ts",
      "**/drizzle.config.ts",
      "**/tsdown.config.ts",
      "e2e/global-setup.ts",
      "eslint.config.js",
    ],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    // Plain JS, incl. the WebDriver device-test tool and the Samply mock (untyped JSON).
    files: ["**/*.js", "e2e/ios-sim/*.mjs", "e2e/samply-mock.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ["apps/web/src/**/*.tsx"],
    ignores: ["**/*.test.tsx"],
    plugins: { i18next },
    rules: {
      // JSX text plus attributes that end up as user-visible copy (SPEC §12).
      "i18next/no-literal-string": [
        "error",
        {
          mode: "jsx-only",
          "jsx-attributes": {
            include: [
              "aria-label",
              "aria-description",
              "aria-placeholder",
              "aria-valuetext",
              "title",
              "alt",
              "placeholder",
              "label",
              "description",
              "error",
            ],
          },
        },
      ],
    },
  },
  prettier,
);
