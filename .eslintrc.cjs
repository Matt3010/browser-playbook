module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  env: { node: true, es2022: true, browser: true },
  parserOptions: { ecmaVersion: 2022, sourceType: "module" },
  rules: {
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }
    ],
    "@typescript-eslint/no-empty-object-type": "off",
    "no-empty": ["error", { allowEmptyCatch: true }],
    "no-console": "off"
  },
  ignorePatterns: [
    "**/dist/**",
    "**/node_modules/**",
    "**/.next/**",
    "**/*.cjs",
    "**/*.js",
    "**/generated/**",
    "**/playwright-report/**",
    "**/test-results/**"
  ]
};
