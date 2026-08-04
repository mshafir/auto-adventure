import { defineConfig } from "vitest/config";

export default defineConfig({
	esbuild: {
		jsx: "automatic",
	},
	test: {
		include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
		environment: "node",
		// Phase 0 ships the harness before the first suite; Phase 1 adds real tests.
		passWithNoTests: true,
	},
});
