import js from "@eslint/js";
import tseslint from "typescript-eslint";
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["tests/**/*.mjs", "scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        console: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        localStorage: "readonly",
        document: "readonly",
        window: "readonly",
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
);
