/**
 * Author a scenario, offline.
 *
 * ```
 * npm run author -- --id drowned-archipelago \
 *   --prompt "a drowned archipelago run by debt-collectors" \
 *   --duration short
 * ```
 *
 * This is the expensive path: roughly sixty model calls for a medium world. It
 * prints what it is doing, validates its own output against the real generator, and
 * refuses to write a file with errors in it unless told to.
 */

import { authorScenario } from "../ai/author/author.js";
import { logTelemetry, money, telemetrySnapshot } from "../ai/telemetry.js";
import { hasGatewayKey, installGatewayKey, resolveSeed } from "../config.js";
import { isDuration, normalizeBrief, type ScenarioBrief } from "../core/world/brief.js";
import { writeScenario } from "../scenario/repo.js";
import { hasErrors } from "../scenario/validate.js";

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
		} else {
			args.set(key, "true");
		}
	}
	return args;
}

function usage(): never {
	process.stderr.write(
		[
			"usage: npm run author -- --id <slug> [options]",
			"",
			"  --id <slug>          filename and scenario id (lower-case, dashes)",
			"  --prompt <text>      what the world is about",
			"  --setting <text>     refines the brief",
			"  --storyline <text>   the story wanted from it",
			"  --tone <text>        refines the brief",
			"  --protagonist <text> who the player is",
			"  --avoid <text>       what to keep out",
			"  --duration <d>       tiny | short | medium | long   (default medium)",
			"  --seed <word|number> which world to author against",
			"  --concurrency <n>    model calls in flight  (default 4)",
			"  --no-trees           skip the per-person dialogue pass",
			"  --force              write even if validation found errors",
			"",
		].join("\n"),
	);
	process.exit(2);
}

function briefFromArgs(args: Map<string, string>): ScenarioBrief | undefined {
	const duration = args.get("duration");
	if (duration && !isDuration(duration)) {
		process.stderr.write(`--duration must be tiny, short, medium or long, not "${duration}"\n`);
		process.exit(2);
	}
	return normalizeBrief({
		premise: args.get("prompt"),
		setting: args.get("setting"),
		storyline: args.get("storyline"),
		tone: args.get("tone"),
		protagonist: args.get("protagonist"),
		avoid: args.get("avoid"),
		...(duration && isDuration(duration) ? { duration } : {}),
	});
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const id = args.get("id");
	if (!id || args.has("help")) usage();
	if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
		process.stderr.write(`--id must be lower-case letters, digits and dashes: got "${id}"\n`);
		process.exit(2);
	}
	// Arguments before environment: a typo in the command is the caller's own and
	// deserves to be the thing reported, not a missing key they may well have.
	const brief = briefFromArgs(args) ?? {};
	// A key saved from the launcher's options page lives in the player's settings, and
	// the AI SDK reads `process.env` and nothing else. Without this the check below
	// passed — `hasGatewayKey` consults both — and then every single call failed for
	// want of the key it had just confirmed was there.
	installGatewayKey();
	if (!hasGatewayKey()) {
		process.stderr.write("AI_GATEWAY_API_KEY is not set; there is nothing to author with.\n");
		process.exit(1);
	}

	// The seed defaults to the id, so re-running the same command reproduces the same
	// world and a different scenario gets a different one.
	const seed = resolveSeed(args.get("seed") ?? id);
	const started = Date.now();

	const { artifact, calls, findings, repairs } = await authorScenario({
		id,
		brief,
		seed,
		concurrency: Number(args.get("concurrency") ?? 4) || 4,
		skipTrees: args.has("no-trees"),
		onProgress: (message) => process.stdout.write(`  ${message}\n`),
	});

	if (repairs.length > 0) {
		process.stdout.write(`\nrepaired ${repairs.length}:\n`);
		for (const repair of repairs) process.stdout.write(`  fixed    ${repair}\n`);
	}

	process.stdout.write(
		findings.length > 0 ? `\nwhat is left:\n` : `\nnothing left wrong with it\n`,
	);
	for (const finding of findings) {
		process.stdout.write(
			`  ${finding.severity === "error" ? "error  " : "warning"}  ${finding.message}\n`,
		);
	}

	const broken = hasErrors(findings);
	if (broken && !args.has("force")) {
		process.stderr.write("\nnot writing a scenario with errors in it; pass --force to override.\n");
		logTelemetry();
		process.exit(1);
	}

	const path = writeScenario(artifact);
	const seconds = Math.round((Date.now() - started) / 1000);
	process.stdout.write(
		`\nwrote ${path}\n  ${calls} model calls, ${seconds}s, ${money(telemetrySnapshot().totalCost)}, ${
			Object.keys(artifact.sites).length
		} places, ${artifact.arc?.beats.length ?? 0} beats, ${
			Object.keys(artifact.trees ?? {}).length
		} conversations\n`,
	);
	logTelemetry();
}

main().catch((error) => {
	process.stderr.write(
		`\nauthoring failed: ${error instanceof Error ? error.stack : String(error)}\n`,
	);
	process.exit(1);
});
