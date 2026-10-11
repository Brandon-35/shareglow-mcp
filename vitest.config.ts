import { defineConfig } from "vitest/config";

// e2e/ holds Playwright specs; vitest runs the unit tests only.
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
