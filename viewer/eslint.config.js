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
    // АРХКОМ-8 verdict: dangerouslySetInnerHTML is banned EVERYWHERE ("запре-
    // щён всюду"), not only in the docs feature — docs is the one sanctioned
    // HTML-injection surface and its escape hatches must not normalize else-
    // where. The docs-scoped block below re-states it with a docs-specific
    // message; for docs files the later block wins (flat config: last match),
    // everywhere else THIS one fires.
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message:
            "dangerouslySetInnerHTML is forbidden app-wide (АРХКОМ-8): HTML entering the DOM must pass the docs pipeline's sanitizer or an explicit, reviewed exception — never a raw escape hatch.",
        },
        {
          selector: "Property[key.name='dangerouslySetInnerHTML']",
          message:
            "dangerouslySetInnerHTML is forbidden app-wide (АРХКОМ-8): HTML entering the DOM must pass the docs pipeline's sanitizer or an explicit, reviewed exception — never a raw escape hatch.",
        },
      ],
    },
  },
  {
    // Docs security gates (АРХКОМ-8 rework of contract 2026-09-22 §9.1):
    // raw HTML is now ALLOWED but only through the pipeline
    // rehype-raw → rehype-sanitize(sanitizeSchema) — and dangerously-
    // SetInnerHTML stays banned at lint level everywhere, including the
    // one file allowed to open the pipeline.
    files: ["src/features/docs/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message:
            "Docs gate (АРХКОМ-8): dangerouslySetInnerHTML is forbidden in the docs feature — sanitization runs inside the react-markdown pipeline.",
        },
        {
          selector: "Property[key.name='dangerouslySetInnerHTML']",
          message:
            "Docs gate (АРХКОМ-8): dangerouslySetInnerHTML is forbidden in the docs feature — sanitization runs inside the react-markdown pipeline.",
        },
      ],
    },
  },
  {
    // rehype-raw + rehype-sanitize are allowed ONLY in Markdown.tsx (the
    // single sanitization story, gate §9.4); the mermaid library is allowed
    // ONLY in Mermaid.tsx (the single lazy chunk boundary, ADR-0015 budget).
    // Anywhere else in the feature both are import errors.
    files: ["src/features/docs/**/*.{ts,tsx}"],
    ignores: ["src/features/docs/Markdown.tsx", "src/features/docs/Mermaid.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "rehype-raw",
              message:
                "Docs gate (АРХКОМ-8): rehype-raw is allowed only in Markdown.tsx — the raw→sanitize order lives at the single pipeline site.",
            },
            {
              name: "rehype-sanitize",
              message:
                "Docs gate (АРХКОМ-8): rehype-sanitize is allowed only in Markdown.tsx — schemas must not multiply outside the single pipeline.",
            },
            {
              name: "mermaid",
              message:
                "Docs gate (АРХКОМ-8): mermaid is allowed only in Mermaid.tsx — the lazy chunk boundary (≤450 KiB pool) depends on this single import site.",
            },
          ],
        },
      ],
    },
  },
  {
    // Markdown.tsx hosts the raw pipeline but NOT the diagram library: a
    // static mermaid import here would weld the 450 KiB pool onto every
    // docs page and break the lazy-chunk budget.
    files: ["src/features/docs/Markdown.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "mermaid",
              message:
                "Docs gate (АРХКОМ-8): mermaid must stay behind Mermaid.tsx's dynamic import — never import it here.",
            },
          ],
        },
      ],
    },
  },
  {
    // Mermaid.tsx owns diagrams only — it must not grow its own raw-HTML
    // pipeline; sanitization stays the Markdown.tsx pipeline's job.
    files: ["src/features/docs/Mermaid.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "rehype-raw",
              message:
                "Docs gate (АРХКОМ-8): the raw-HTML pipeline lives only in Markdown.tsx.",
            },
            {
              name: "rehype-sanitize",
              message:
                "Docs gate (АРХКОМ-8): sanitize schemas live only in Markdown.tsx's pipeline.",
            },
          ],
        },
      ],
    },
  },
);
