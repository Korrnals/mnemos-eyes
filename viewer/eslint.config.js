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
    // dev-only HMR nicety.
    files: ["src/components/ui/**/*.{ts,tsx}", "src/components/theme-provider.tsx"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
);
