import ts from "typescript-eslint";
export default ts.config(
  {
    ignores: [
      "**/next-env.d.ts",
      "**/node_modules/**",
      "**/dist/**",
      "**/.next*/**",
      "**/.expo/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  ...ts.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
