export default [
  {
    files: [
      "src/**/*.js",
      "test/**/*.js",
      "examples/**/*.js",
      "eslint.config.js",
    ],
    rules: {
      "no-console": "warn",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "prefer-const": "error",
      "no-var": "error",
    },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
    },
  },
];
