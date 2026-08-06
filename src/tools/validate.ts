/**
 * Run the offline pass over a scenario that is already installed.
 *
 * ```
 * npm run validate -- --scenario green-chapel
 * npm run validate                              # every scenario on disk
 * ```
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
import { listScenarios, readScenarioFile, scenarioPath, verifyArtifact } from "../scenario/repo.js";
import { hasErrors, validateArtifact } from "../scenario/validate.js";

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

function main() {
	const args = parseArgs(process.argv.slice(2));
	const named = args.get("scenario");
	const ids = named && named !== "true" ? [named] : listScenarios().map((entry) => entry.id);

	if (ids.length === 0) {
		process.stderr.write("no scenarios installed\n");
		process.exit(2);
	}

	let broken = false;
	for (const id of ids) {
		const artifact = readScenarioFile(scenarioPath(id));
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
		process.stdout.write(`  ${errors} error(s), ${warnings} warning(s)\n\n`);
		broken ||= structural.length > 0 || hasErrors(findings);
	}

	process.exit(broken ? 1 : 0);
}

main();
