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
		/**
		 * How much of the machine the suite may take.
		 *
		 * Vitest sizes its pool to the CPU count by default, and a worker here is not cheap:
		 * nearly every test generates a *bounded world*, so each one holds chunk pipelines,
		 * passability grids and feature patches in the module-level caches `core/gen` keys by
		 * world. Eight of those at once on an 8 GB machine swaps rather than runs — measured
		 * at 24,971 pageouts on a full run, with twelve node processes left stranded when it
		 * was interrupted mid-swap.
		 *
		 * Two forks: zero new pageouts, ~640 MB across all workers, and the pass count
		 * unchanged from the eight-fork run measured before this cap went in. Capping how
		 * many run at once cannot change what any one of them sees, so it cannot change a
		 * result — it costs only wall clock, 38s to 96s here. (Read this as "matched before
		 * and after the change", not as a number to keep in sync — the suite has grown many
		 * times since and will again.)
		 *
		 * The pool stays `forks` rather than moving to `threads` deliberately. Every generator
		 * cache is module-level, and a fork gives each worker its own module registry, which
		 * is the isolation these tests were written against. Raise the cap on a bigger
		 * machine; nothing depends on the value.
		 *
		 * Stranding is the same problem rather than a separate one: a worker killed abruptly,
		 * by the OOM reaper or a Ctrl-C during a swap storm, never runs its teardown. Staying
		 * inside memory is what prevents it. `npm run test:reap` clears any that survive.
		 */
		pool: "forks",
		poolOptions: { forks: { minForks: 1, maxForks: 2 } },
	},
});
