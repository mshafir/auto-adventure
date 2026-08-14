/**
 * Report which mechanical invariants a scenario on disk violates.
 *
 * ```
 * npm run invariants                            # every scenario installed
 * npm run invariants -- --scenario green-chapel
 * ```
 *
 * Companion to `npm run validate` rather than a replacement. `validate` answers "is
 * anything wrong with this file"; this answers "which of the four properties a playable
 * world has does this one lack", which is the question worth asking before and after a
 * change to the generator. Exits non-zero when anything is violated, so it can gate a
 * commit.
 */
import { checkInvariants, type InvariantId } from "../scenario/invariants.js";
import { listScenarios, readScenarioAt, scenarioPath } from "../scenario/repo.js";

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

function main(): void {
	const args = parseArgs(process.argv.slice(2));
	const named = args.get("scenario");
	const ids = named && named !== "true" ? [named] : listScenarios().map((entry) => entry.id);

	if (ids.length === 0) {
		process.stderr.write("no scenarios installed\n");
		process.exit(1);
	}

	let broken = false;
	for (const id of ids) {
		const artifact = readScenarioAt(scenarioPath(id));
		if (!artifact) {
			process.stdout.write(`${id} — could not be read\n\n`);
			broken = true;
			continue;
		}

		const report = checkInvariants(artifact);
		process.stdout.write(`${id} — ${artifact.title}\n`);
		for (const violation of report.violations) {
			process.stdout.write(`  ${violation.invariant}  ${violation.where}: ${violation.detail}\n`);
		}
		// Every invariant named, including the ones that held. A report that lists only
		// failures cannot be compared with a later one.
		for (const [invariant, count] of Object.entries(report.counts) as [InvariantId, number][]) {
			process.stdout.write(`  ${count === 0 ? "ok  " : "FAIL"}  ${invariant}: ${count}\n`);
		}
		process.stdout.write("\n");
		broken ||= report.violations.length > 0;
	}

	process.exit(broken ? 1 : 0);
}

main();
