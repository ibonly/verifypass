export default [
  {
    ignores: ["node_modules/**", "dist/**", "coverage/**", "evidence-store/**"]
  },
  {
    files: ["**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true }
      },
      globals: {
        AbortSignal: "readonly",
        Blob: "readonly",
        Buffer: "readonly",
        FormData: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        __VP_API_BASE__: "readonly",
        __VP_SECRET_KEY__: "readonly",
        alert: "readonly",
        console: "readonly",
        document: "readonly",
        fetch: "readonly",
        module: "readonly",
        process: "readonly",
        require: "readonly",
        sessionStorage: "readonly",
        setTimeout: "readonly",
        window: "readonly"
      }
    }
  }
];