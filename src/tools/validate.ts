/**
 * Run the offline pass over a scenario that is already installed.
 *
 * ```
 * npm run validate -- --scenario green-chapel
 * npm run validate                              # every scenario on disk
 * npm run validate -- --deep                    # and play each of them to the end
 * ```
 *
 * `--deep` is the other half, and a different kind of check. Everything above it reasons
 * *about* the file; that one builds a real session and walks the story through the real
 * engine, which is the only way to find out whether the person a beat hangs on is
 * actually standing in the town that was written for them. Slow, so it is asked for
 * rather than assumed.
 *
 * `assemble` validates a *draft*, which covers everything a draft can say — and the
 * newer vocabulary (conditions, triggers, gates, placed items, forks) is not among
 * them. Those are hand-written into `.scenarios/<id>.json` afterwards, and until this
 * existed the only way to check that work was to write a test for it. So the workflow
 * the docs describe had no tool at its last step, which is exactly where the mistakes
 * are: a gate that can be walked around, an item that is nowhere, a fork with a beat
 * downstream of one arm only.
 *
 * Reads what the game reads. Exits non-zero on errors so it can gate a commit.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listScenarios, readScenarioAt, scenarioPath, verifyArtifact } from "../scenario/repo.js";
import { hasErrors, validateArtifact } from "../scenario/validate.js";
import { walkTheStory } from "../scenario/walk.js";

function parseArgs(argv: readonly string[]): Map<string, string> {
	const args = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token?.startsWith("--")) continue;
		const [key, inline] = token.slice(2).split("=", 2);
		if (!key) continue;
		if (inline !== undefined) {
			args.set(key, inline);
			continue;
		}
		const next = argv[i + 1];
		if (next && !next.startsWith("--")) {
			args.set(key, next);
			i++;
		} else args.set(key, "true");
	}
	return args;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const named = args.get("scenario");
	const ids = named && named !== "true" ? [named] : listScenarios().map((entry) => entry.id);
	const deep = args.has("deep");

	if (ids.length === 0) {
		process.stderr.write("no scenarios installed\n");
		process.exit(2);
	}

	// A home of its own, so nothing here can read or write the player's real saves. The walk
	// itself no longer writes one — its session is built with `persist: false`, and
	// `walk.test.ts` pins that — so this is the belt to those braces, and it still earns its
	// keep: a deep check loads and plays a scenario, and a bug in any of that must not be
	// able to reach a playthrough.
	let home: string | undefined;
	if (deep) {
		home = mkdtempSync(join(tmpdir(), "auto-adventure-validate-"));
		process.env.AUTO_ADVENTURE_HOME = home;
	}

	let broken = false;
	for (const id of ids) {
		const artifact = readScenarioAt(scenarioPath(id));
		if (!artifact) {
			process.stdout.write(`${id}\n  error    does not load\n`);
			broken = true;
			continue;
		}

		const structural = verifyArtifact(artifact);
		const findings = validateArtifact(artifact);
		const errors = structural.length + findings.filter((f) => f.severity === "error").length;
		const warnings = findings.length - (errors - structural.length);

		process.stdout.write(`${id} — ${artifact.title}\n`);
		for (const problem of structural) process.stdout.write(`  error    ${problem}\n`);
		for (const finding of findings) {
			process.stdout.write(
				`  ${finding.severity === "error" ? "error  " : "warning"}  ${finding.message}\n`,
			);
		}
		process.stdout.write(`  ${errors} error(s), ${warnings} warning(s)\n`);
		broken ||= structural.length > 0 || hasErrors(findings);

		if (deep) {
			const walk = await walkTheStory(artifact, `validate-${id}`);
			for (const beat of walk.stuck) process.stdout.write(`  stuck    beat ${beat} never opened\n`);
			for (const who of walk.absent)
				process.stdout.write(`  absent   ${who} was not standing anywhere the walk could reach\n`);
			for (const open of walk.unfinished) process.stdout.write(`  open     ${open}\n`);
			// Said plainly, because "finished" earned by four hand-outs is a different
			// result from "finished", and printing only the verdict would hide the
			// difference behind a word.
			for (const concession of walk.concessions) process.stdout.write(`  given    ${concession}\n`);
			process.stdout.write(
				walk.finished
					? `  walked ${walk.opened.length} beat(s) to the end${
							walk.concessions.length > 0 ? `, with ${walk.concessions.length} hand-out(s)` : ""
						}\n`
					: `  did not finish: ${walk.opened.length} beat(s) opened\n`,
			);
			broken ||= !walk.finished;
		}
		process.stdout.write("\n");
	}

	if (home) rmSync(home, { recursive: true, force: true });
	process.exit(broken ? 1 : 0);
}

main().catch((error) => {
	process.stderr.write(`\nvalidation failed: ${error instanceof Error ? error.stack : error}\n`);
	process.exit(2);
});
