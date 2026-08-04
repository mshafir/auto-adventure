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
		/**
		 * A chunk costs tens of milliseconds to generate and the connectivity,
		 * walkability and placement suites each build hundreds of them, so several
		 * sat just under the 5s default and tipped over as soon as generation got
		 * marginally slower. Raised so that a real regression is what fails, rather
		 * than whatever else happens to be using the cores. Suites that legitimately
		 * run longer still set their own, as the seam test does.
		 */
		testTimeout: 30_000,
	},
});
