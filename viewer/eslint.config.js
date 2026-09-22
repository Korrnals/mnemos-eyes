import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Generated and build output are out of lint scope.
  { ignores: ["dist", "coverage", "node_modules", "src/types/openapi.d.ts"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],
    },
  },
  {
    // shadcn/ui convention co-locates cva variant exports with the component
    // (buttonVariants/badgeVariants) and ThemeProvider ships with useTheme;
    // splitting them would diverge from the upstream shadcn layout for a
    // dev-only HMR nicety. DensityProvider and HotkeysProvider follow the
    // same provider+hook pattern as ThemeProvider (Ф1). routes.tsx is the
    // route TABLE (data with embedded elements), not an HMR-able component.
    files: [
      "src/components/ui/**/*.{ts,tsx}",
      "src/components/theme-provider.tsx",
      "src/components/density-provider.tsx",
      "src/layout/Hotkeys.tsx",
      "src/app/routes.tsx",
    ],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
  {
    // Docs security gates (contract 2026-09-22 §9.1): markdown renders ONLY
    // through react-markdown's default sanitization — the raw-HTML escape
    // hatches are banned at lint level, not just by convention.
    files: ["src/features/docs/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "rehype-raw",
              message:
                "Docs gate §9: raw HTML passthrough is forbidden — hostile content must never reach the DOM.",
            },
            {
              name: "rehype-sanitize",
              message:
                "Docs gate §9: sanitization IS the react-markdown default (no rehype-raw); adding rehype-sanitize would imply raw HTML.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message:
            "Docs gate §9: dangerouslySetInnerHTML is forbidden in the docs feature.",
        },
        {
          selector: "Property[key.name='dangerouslySetInnerHTML']",
          message:
            "Docs gate §9: dangerouslySetInnerHTML is forbidden in the docs feature.",
        },
      ],
    },
  },
);
