import js from "@eslint/js";
import globals from "globals";
import obsidianmd from "eslint-plugin-obsidianmd";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";
import { fileURLToPath } from "node:url";

const tsconfigRootDir = fileURLToPath(new URL(".", import.meta.url));
const ESLINT_DESCRIPTION_PATTERN = String.raw`^\s*eslint-disable(?:-next-line|-line)?\b.*--\s+\S`;

export default defineConfig(
  globalIgnores([
    "node_modules",
    "release",
    "sample-vault",
    ".e2e",
    ".obsidian-unpacked",
    "e2e-vault",
    "main.js",
    ".beads",
    ".history",
    "assets",
    "dist",
    "versions.json",
  ]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      "no-control-regex": "off",
      "no-useless-escape": "off",
      "preserve-caught-error": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["src/**/*.ts"],
    ...tseslint.configs.recommendedTypeChecked[0],
    languageOptions: {
      ...tseslint.configs.recommendedTypeChecked[0].languageOptions,
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir,
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      ...tseslint.configs.recommendedTypeChecked[0].rules,
      "@typescript-eslint/require-await": "error",
    },
  },
  {
    files: ["src/**/*.{ts,js}"],
    plugins: {
      obsidianmd,
    },
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir,
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      ...obsidianmd.configs.recommended,
    },
  },
  {
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    plugins: {
      local: {
        rules: {
          "require-eslint-disable-description": {
            meta: {
              type: "problem",
              docs: {
                description: "Require eslint-disable directives to include an inline reason after --",
              },
              schema: [],
            },
            create(context) {
              return {
                Program() {
                  for (const comment of context.sourceCode.getAllComments()) {
                    if (!/eslint-disable(?:-next-line|-line)?\b/.test(comment.value)) {
                      continue;
                    }

                    if (new RegExp(ESLINT_DESCRIPTION_PATTERN).test(comment.value)) {
                      continue;
                    }

                    context.report({
                      loc: comment.loc,
                      message:
                        "Unexpected undescribed directive comment. Include descriptions to explain why the comment is necessary.",
                    });
                  }
                },
              };
            },
          },
        },
      },
    },
    rules: {
      "local/require-eslint-disable-description": "error",
    },
  },
  {
    files: ["scripts/**/*.{js,mjs,cjs}", "esbuild.config.mjs"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  eslintConfigPrettier,
);
