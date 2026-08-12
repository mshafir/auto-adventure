import { readFileSync } from "node:fs";
import { type WorldRecipe, type WorldSeed, worldSeed } from "../core/world/recipe.js";
import { WorldRecipeSchema } from "../core/world/recipe-schema.js";

/**
 * Read a `--recipe <file.json>` argument into a world.
 *
 * Shared by `preview` and `survey`, which are the two tools an author actually uses
 * to find out what a recipe does before writing a scenario around it. Both had to
 * grow the same flag; giving them one implementation is also what stops one of them
 * validating the file and the other trusting it.
 *
 * Exits rather than throws. These are command-line tools, and a stack trace over a
 * misplaced comma is worse than a line saying which field is wrong.
 *
 * The recipe comes back alongside the world it built, because a caller that goes on to
 * *change* the world — the survey grows sites — has to rebuild it from the recipe rather
 * than from the resolved rules, or the rebuilt world quietly loses everything the recipe
 * said that was not about sites.
 */
export function worldFromArgs(
	seed: number,
	path: string | undefined,
): { world: WorldSeed; recipe: WorldRecipe | undefined } {
	if (!path || path === "true") return { world: worldSeed(seed), recipe: undefined };

	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (cause) {
		process.stderr.write(`--recipe: cannot read ${path}: ${(cause as Error).message}\n`);
		process.exit(2);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (cause) {
		process.stderr.write(`--recipe: ${path} is not valid JSON: ${(cause as Error).message}\n`);
		process.exit(2);
	}

	// A file may be a bare recipe or a scenario draft with one inside it, because both
	// are things an author has open while doing this.
	const record = parsed as Record<string, unknown>;
	const body = record && typeof record === "object" && "recipe" in record ? record.recipe : parsed;

	const result = WorldRecipeSchema.safeParse(body);
	if (!result.success) {
		process.stderr.write(`--recipe: ${path} is not a valid recipe\n`);
		for (const issue of result.error.issues) {
			process.stderr.write(`  ${issue.path.join(".") || "(root)"}: ${issue.message}\n`);
		}
		process.exit(2);
	}
	return { world: worldSeed(seed, result.data), recipe: result.data };
}
