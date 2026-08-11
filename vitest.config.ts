import { defineConfig } from "vitest/config";

/**
 * How much of the machine the suite is allowed to take.
 *
 * Vitest defaults to one worker per CPU core, and a worker here is not cheap: nearly every
 * test generates a *bounded world*, so each one holds chunk pipelines, passability grids and
 * feature patches in the module-level caches that `core/gen` keys by world. Eight of those at
 * once on an 8 GB machine swaps rather than runs — measured at 24,971 pageouts on one full
 * run, with twelve node processes left stranded afterwards.
 *
 * The pool stays `forks` rather than moving to `threads`, deliberately. Every generator cache
 * — `patchCache`, `roadCache`, `riverCache`, the interior cache — is module-level, and a fork
 * gives each worker its own module registry, which is the isolation this suite was written
 * against. Capping the count changes how many run at once and nothing about what any one of
 * them sees, so it cannot alter a result; moving to threads could.
 *
 * Two is not a guess at a nice number: the tests that dominate the bill generate a whole
 * bounded world and one of those is already most of a gigabyte, so the cap is "how many
 * worlds fit beside the editor and the browser", not "how many cores are idle". Raise it on a
 * bigger machine by all means — nothing here depends on the value.
 *
 * Stranding is a consequence of the same problem rather than a separate one: a worker killed
 * abruptly, by the OOM reaper or by a Ctrl-C during a swap storm, never runs its teardown.
 * Staying inside memory is what stops it.
 */
export default defineConfig({
	test: {
		pool: "forks",
		poolOptions: { forks: { minForks: 1, maxForks: 2 } },
	},
});
