import { Args, CraftError, parseArgs } from "./args.js";
import { craftCheck, craftPlaytest } from "./check.js";
import {
	craftFound,
	craftNpcAdd,
	craftPlace,
	craftSignposts,
	craftTerraform,
	craftTree,
} from "./content.js";
import { craftPlay, craftRender } from "./play.js";
import {
	craftBeatAdd,
	craftPhaseAdd,
	craftSceneNew,
	craftSceneStep,
	craftTriggerAdd,
} from "./story.js";
import { craftNew, craftReseed, craftSurvey } from "./world.js";

/**
 * The whole vocabulary, in one table.
 *
 * A registry rather than a switch so that `craft` with no arguments can print what it can do.
 * That matters more than usual here: the caller is an agent reading `--help`, and a verb it
 * cannot discover is a verb it will work around by hand-editing JSON — which is exactly what
 * this exists to make unnecessary.
 */

export interface Verb {
	/** The words that select it, e.g. `["phase", "add"]`. */
	readonly words: readonly string[];
	readonly usage: string;
	readonly summary: string;
	readonly run: (args: Args, out: (line: string) => void) => void | Promise<void>;
}

export const VERBS: readonly Verb[] = [
	{
		words: ["new"],
		usage:
			'craft new <id> --premise "..." [--title "..."] [--duration short] [--seed word] [--pack p] [--tiles t]',
		summary: "start a scenario: pick a world, write the stub files",
		run: craftNew,
	},
	{
		words: ["reseed"],
		usage: "craft reseed <id> [--seed word]",
		summary: "shop for a different world. Free, and only before anything is founded",
		run: craftReseed,
	},
	{
		words: ["survey"],
		usage: "craft survey <id> [--kind village] [--importance 3] [--all]",
		summary: "where the ground will hold a place, how far it is, and what it is like there",
		run: craftSurvey,
	},
	{
		words: ["found"],
		usage:
			'craft found <id> --at x,y --name "..." --description "..." [--kind village] [--importance 3] [--structure kind:Name]... [--hook "..."]... [--walled]',
		summary: "put a settlement somewhere, and say what is built in it. Nothing generates one",
		run: craftFound,
	},
	{
		words: ["npc", "add"],
		usage:
			'craft npc add <id> --site N --name "..." --role "..." [--at anchor] [--in "Building"] [--indoors] [--knows "..."]... [--stays] [--live] [--like npc:...]',
		summary:
			"put somebody in a place. --live lets a model speak for them; --like shares another's words",
		run: craftNpcAdd,
	},
	{
		words: ["tree"],
		usage: "craft tree <id> --npc npc:S:N --init",
		summary: "scaffold a conversation with a way out, for the prose to be written into",
		run: craftTree,
	},
	{
		words: ["place"],
		usage:
			'craft place <id> --item "Name" --description "..." --site N [--in "Building"] [--anchor a] [--requires flag] [--show] | --sign --at x,y --arm N... | --gate --site N --opens-when flag',
		summary: "put a thing, a board or a barred gate somewhere real. Refuses what cannot land",
		run: craftPlace,
	},
	{
		words: ["signposts"],
		usage: "craft signposts <id>",
		summary: "put a board on the road out of every town the story walks between. Free, and derived",
		run: craftSignposts,
	},
	{
		words: ["terraform"],
		usage:
			"craft terraform <id> --path x,y x,y [--width 3] [--surface path|dirt|cobble] | --bridge x,y x,y | --clearing x,y [--radius 3]",
		summary: "change the ground. A debt: reseeding is free and this is not",
		run: craftTerraform,
	},
	{
		words: ["phase", "add"],
		usage: 'craft phase add <id> --phase <phaseId> --name "..." --when <flag>',
		summary: "a later chapter. Every other command takes --phase to write into it",
		run: craftPhaseAdd,
	},
	{
		words: ["scene", "new"],
		usage:
			"craft scene new <id> --scene <sceneId> [--at N] [--cast alias:npc:S:N]... [--unskippable]",
		summary: "start a cutscene",
		run: craftSceneNew,
	},
	{
		words: ["scene", "step"],
		usage:
			'craft scene step <id> --scene <sceneId> [--say "who: words"] [--walk who:place] [--spawn who:place] [--camera place] [--face who:dir] [--wait n] [--flag f] [--grant "Item: what it is"] [--hold n]',
		summary: "append a step. A place is x,y or <siteId>[@anchor]",
		run: craftSceneStep,
	},
	{
		words: ["trigger", "add"],
		usage:
			"craft trigger add <id> --trigger T --when <flag> [--scene S] [--set flag]... [--repeats]",
		summary: "what the world reacts to. The only thing that can raise a scene",
		run: craftTriggerAdd,
	},
	{
		words: ["beat", "add"],
		usage:
			'craft beat add <id> --beat B --site N --slot N [--sets-flag F] [--requires F]... [--journal "..."] [--optional]',
		summary: "a step of the story, opened by speaking to somebody",
		run: craftBeatAdd,
	},
	{
		words: ["check"],
		usage: "craft check <id>",
		summary: "everything knowable without playing it, including staging every scene",
		run: craftCheck,
	},
	{
		words: ["render"],
		usage: "craft render <id> --at <siteId|x,y> [--radius 12]",
		summary: "look at a place without walking to it",
		run: craftRender,
	},
	{
		words: ["play"],
		usage: "craft play <id> [--script file] [--radius 8]",
		summary: "play it, a typed line at a time. What a review reads rather than reasons about",
		run: craftPlay,
	},
	{
		words: ["playtest"],
		usage: "craft playtest <id>",
		summary: "walk the story through the real engine, and say where it stops",
		run: craftPlaytest,
	},
];

/** The verb these words select, longest match first so `scene new` beats `scene`. */
export function selectVerb(words: readonly string[]): Verb | undefined {
	const candidates = [...VERBS].sort((a, b) => b.words.length - a.words.length);
	return candidates.find((verb) => verb.words.every((word, index) => words[index] === word));
}

export function helpText(): string {
	const lines = ["craft — build a scenario the game can play", ""];
	for (const verb of VERBS) {
		lines.push(`  ${verb.usage}`);
		lines.push(`      ${verb.summary}`);
	}
	return lines.join("\n");
}

/**
 * Run one command line.
 *
 * Returns the exit code rather than calling `process.exit`, so the whole CLI is testable
 * without a subprocess — which is what makes it possible to assert that a refused command
 * changed nothing on disk.
 */
export async function runCraft(
	argv: readonly string[],
	out: (line: string) => void = console.log,
): Promise<number> {
	const parsed = parseArgs(argv);
	if (parsed.words.length === 0 || parsed.words[0] === "help") {
		out(helpText());
		return 0;
	}

	const verb = selectVerb(parsed.words);
	if (!verb) {
		out(`craft: no such command "${parsed.words.join(" ")}"`);
		out("");
		out(helpText());
		return 1;
	}

	try {
		await verb.run(new Args(parsed, verb.words.length), out);
		return 0;
	} catch (error) {
		if (error instanceof CraftError) {
			out(`craft: ${error.message}`);
			return error.code;
		}
		throw error;
	}
}
