/**
 * Turn a written draft into a playable scenario.
 *
 * ```
 * npm run assemble -- --draft drafts/drowned-archipelago.json
 * ```
 *
 * Calls no model: the words are already written. This validates them against the
 * real generator and refuses to install a scenario with errors in it, which is the
 * point — a draft that names a building the settlement pass will not build produces
 * a character standing nowhere, and nothing at runtime would ever say so.
 */
import { readFileSync } from "node:fs";
import { assembleArtifact, ScenarioDraftSchema } from "../scenario/draft.js";
import { verifyArtifact, writeScenario } from "../scenario/repo.js";
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
	const path = args.get("draft");
	if (!path || args.has("help")) {
		process.stderr.write(
			[
				"usage: npm run assemble -- --draft <path>",
				"",
				"  --draft <path>   the scenario draft to assemble",
				"  --check          validate and report, but write nothing",
				"  --force          install even if validation found errors",
				"",
			].join("\n"),
		);
		process.exit(2);
	}

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (cause) {
		process.stderr.write(
			`could not read ${path}: ${cause instanceof Error ? cause.message : cause}\n`,
		);
		process.exit(1);
	}

	const parsed = ScenarioDraftSchema.safeParse(raw);
	if (!parsed.success) {
		process.stderr.write(`${path} is not a valid draft:\n`);
		for (const issue of parsed.error.issues.slice(0, 12)) {
			process.stderr.write(`  ${issue.path.join(".") || "(root)"}: ${issue.message}\n`);
		}
		process.exit(1);
	}

	const artifact = assembleArtifact(parsed.data, new Date().toISOString());

	const structural = verifyArtifact(artifact);
	const findings = validateArtifact(artifact);
	for (const problem of structural) process.stdout.write(`error    ${problem}\n`);
	for (const finding of findings) {
		process.stdout.write(
			`${finding.severity === "error" ? "error  " : "warning"}  ${finding.message}\n`,
		);
	}

	const authored = Object.values(artifact.sites).filter((site) =>
		parsed.data.sites?.some((drafted) => drafted.siteId === site.siteId),
	).length;
	process.stdout.write(
		[
			"",
			`${artifact.title}`,
			`  seed        ${artifact.seed}`,
			`  world       ${artifact.bounds.maxX - artifact.bounds.minX} tiles across, ${artifact.bounds.style} edge`,
			`  spawn       ${artifact.spawn.x},${artifact.spawn.y}`,
			`  places      ${Object.keys(artifact.sites).length} (${authored} written, ${
				Object.keys(artifact.sites).length - authored
			} procedural)`,
			`  beats       ${artifact.arc?.beats.length ?? 0}`,
			`  dialogue    ${Object.keys(artifact.trees ?? {}).length} written`,
			"",
		].join("\n"),
	);

	const broken = structural.length > 0 || hasErrors(findings);
	if (args.has("check")) {
		process.stdout.write(broken ? "would not install: errors above\n" : "ready to install\n");
		process.exit(broken ? 1 : 0);
	}
	if (broken && !args.has("force")) {
		process.stderr.write(
			"not installing a scenario with errors in it; pass --force to override.\n",
		);
		process.exit(1);
	}

	process.stdout.write(`installed ${writeScenario(artifact)}\n`);
}

main();
