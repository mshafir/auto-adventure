import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { describeObjective } from "../core/rules/quests.js";
import { activeQuests, type Facing, type GameState, worldAnchor } from "../core/rules/state.js";
import { decorDef } from "../core/tiles/decor.js";
import { terrainDef } from "../core/tiles/terrain.js";
import { buildSession, type Session } from "../session.js";
import { type Args, CraftError } from "./args.js";
import { openWorkspace } from "./workspace.js";
import { requireId } from "./world.js";

/**
 * Play a scenario without a terminal, one typed line at a time.
 *
 * The instrument the review pass is built on, and the thing every static check cannot be. A
 * validator reasons about the files; this walks the world and reports what a player would
 * see — which is the only way to find out that a conversation refers to a document nobody
 * can find, that a town is dull, or that the story gives no reason to go anywhere.
 *
 * Output is deliberately plain text with one fact per line. The caller is an agent, and a
 * frame drawn with box characters and colour is a frame it has to parse rather than read.
 */

const HELP = [
	"n s e w   walk one step (or north/south/east/west)",
	"look      what is in front of you",
	"talk      speak to whoever you are facing",
	"1-9       answer, when a conversation offers choices",
	"search    look in whatever is in front of you",
	"enter     go through the door in front of you",
	"wait      let a moment pass",
	"map       redraw",
	"where     position, place, and the hour",
	"quests    the errand log",
	"journal   what has been learned",
	"items     what is carried",
	"done      stop",
].join("\n");

const STEPS: Readonly<Record<string, Facing>> = {
	n: "up",
	north: "up",
	s: "down",
	south: "down",
	e: "right",
	east: "right",
	w: "left",
	west: "left",
};

export async function craftPlay(args: Args, out: (line: string) => void): Promise<void> {
	const workspace = openWorkspace(requireId(args, "play"));
	const script = args.has("script") ? args.str("script") : undefined;
	const radius = args.int("radius", 8);
	args.bool("headless");
	args.refuseUnknown();

	const session = buildSession(
		{
			worldId: `craft-play-${workspace.id}`,
			seed: workspace.artifact.seed,
			flavour: "prebuilt",
			scenario: workspace.artifact,
		},
		{ persist: false },
	);

	try {
		out(`playing "${workspace.artifact.title}"`);
		out("type `help` for what you can do, `done` to stop");
		out("");
		settle(session, out);
		draw(session, radius, out);

		const lines = script ? scriptLines(script) : typedLines();
		for await (const line of lines) {
			const command = line.trim().toLowerCase();
			if (!command || command.startsWith("#")) continue;
			if (script) out(`> ${command}`);
			if (command === "done" || command === "quit") break;
			perform(session, command, radius, out);
		}
	} finally {
		session.dispose();
	}
}

/** Lines typed at the terminal, as an async iterable so the loop above reads the same either way. */
function typedLines(): AsyncIterable<string> {
	return createInterface({ input: process.stdin, terminal: false });
}

/**
 * Lines from a file, with a readable complaint when there is no such file.
 *
 * Worth the four lines: a raw ENOENT stack trace tells an agent that something threw inside
 * `node:fs`, which is a diagnosis it has to do rather than read.
 */
function scriptLines(path: string): string[] {
	try {
		return readFileSync(path, "utf8").split("\n");
	} catch {
		throw new CraftError(`there is no script at ${path}`, 2);
	}
}

function perform(
	session: Session,
	command: string,
	radius: number,
	out: (line: string) => void,
): void {
	const engine = session.engine;
	const state = () => engine.getState();

	/** The commands that only look. None of them changes the world, so none of them settles. */
	const reports: Readonly<Record<string, () => void>> = {
		help: () => out(HELP),
		map: () => draw(session, radius, out),
		where: () => where(state(), session, out),
		quests: () => quests(state(), out),
		journal: () => journal(state(), out),
		items: () => items(state(), out),
	};
	const report = reports[command];
	if (report) {
		report();
		return;
	}

	const facing = STEPS[command];
	if (facing) {
		engine.dispatch({ t: "Move", facing });
		settle(session, out);
		draw(session, radius, out);
		return;
	}

	switch (command) {
		case "look":
			look(session, out);
			return;
		case "talk":
		case "search":
		case "enter":
			// One verb in the game, deliberately: interacting with what is in front of you does
			// whatever that thing affords. Three words here because a person describing what they
			// did says "I talked to her", not "I interacted with her".
			engine.dispatch({ t: "Interact" });
			settle(session, out);
			after(session, out);
			return;
		case "wait":
			engine.dispatch({ t: "Tick", amount: 1 });
			return;
		default:
			break;
	}

	const choice = Number(command);
	if (Number.isInteger(choice) && choice >= 1) {
		const options = state().dialogue?.choices ?? [];
		const picked = options[choice - 1];
		if (!picked) {
			out(
				`there is no answer ${choice}. ${options.length ? `There are ${options.length}.` : "Nobody is speaking."}`,
			);
			return;
		}
		engine.dispatch({
			t: "DialogueTurn",
			npcId: state().dialogue?.npcId ?? "",
			speaker: "you",
			text: picked,
		});
		settle(session, out);
		after(session, out);
		return;
	}

	out(`"${command}" is not something you can do. Try \`help\`.`);
}

/**
 * Let a cutscene or a card finish before drawing anything.
 *
 * A card and a scene both take the world, and an agent that did not know it would spend its
 * whole budget typing `n` at something swallowing the keystrokes. Scenes are played out
 * rather than skipped — a review that skipped every one would be reviewing a different game.
 */
function settle(session: Session, out: (line: string) => void): void {
	const engine = session.engine;
	for (let guard = 0; guard < 4000; guard++) {
		const state = engine.getState();
		if (state.card) {
			out("");
			out(`── ${state.card.title} ──`);
			if (state.card.subtitle) out(state.card.subtitle);
			for (const section of state.card.sections) {
				out(`  ${section.heading}: ${section.body}`);
			}
			out("");
			engine.dispatch({ t: "DismissCard" });
			continue;
		}
		const scene = state.scene;
		if (!scene) return;
		if (scene.caption) {
			out(`  ${scene.caption.speaker}: ${scene.caption.text}`);
			engine.dispatch({ t: "Advance" });
			continue;
		}
		engine.dispatch({ t: "SceneFrame" });
	}
}

/** Whatever the last interaction produced: a line of speech, a notice, or nothing. */
function after(session: Session, out: (line: string) => void): void {
	const state = session.engine.getState();
	if (state.notice) out(state.notice);
	const dialogue = state.dialogue;
	if (!dialogue) return;
	const last = dialogue.lines.at(-1);
	if (last) out(`${last.speaker}: ${last.text}`);
	dialogue.choices?.forEach((choice, index) => out(`  ${index + 1}. ${choice}`));
	if (!dialogue.choices?.length) out("  (nothing more to say)");
}

function look(session: Session, out: (line: string) => void): void {
	const state = session.engine.getState();
	const { x, y, facing } = state.player;
	const step = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[facing] as [
		number,
		number,
	];
	const at = { x: x + step[0], y: y + step[1] };
	const view = session.engine.getView();
	const person = session.engine.personAt(at.x, at.y);

	out(`facing ${facing}, at ${at.x},${at.y}`);
	if (person) out(`  ${person.name}, ${person.spec.role}`);
	// Decor first when there is any, since a crate on a road is what you are looking at; the
	// ground otherwise. `decorDef(0).name` is the empty string rather than undefined, so the
	// check has to be on the content and not on the presence.
	const decor = decorDef(view.decorAt(at.x, at.y)).name;
	out(`  ${decor || terrainDef(view.terrainAt(at.x, at.y)).name}`);
	const sign = session.engine.signAt(at.x, at.y);
	if (sign) out(`  the board reads: ${sign}`);
}

/**
 * The world as characters, centred on the player.
 *
 * The same information the game draws, in the plainest form that carries it: terrain as its
 * own letter, people as theirs, the player as `@`. An agent reading this can tell a wall from
 * a road and find the person it was told to look for, which is all a map is for here.
 */
function draw(session: Session, radius: number, out: (line: string) => void): void {
	const state = session.engine.getState();
	const view = session.engine.getView();
	const { x: px, y: py } = state.player;

	for (let y = py - radius; y <= py + radius; y++) {
		let row = "";
		for (let x = px - radius; x <= px + radius; x++) {
			if (x === px && y === py) {
				row += "@";
				continue;
			}
			const person = session.engine.personAt(x, y);
			if (person) {
				row += person.glyph;
				continue;
			}
			row += view.isPassable(x, y) ? "." : "#";
		}
		out(row);
	}
	out("");
	where(state, session, out);
}

function where(state: GameState, session: Session, out: (line: string) => void): void {
	const anchor = worldAnchor(state.player);
	const place = state.player.inside
		? (state.player.inside.name ?? state.player.inside.structure)
		: session.engine.placeNameAt(anchor.x, anchor.y);
	out(
		`at ${state.player.x},${state.player.y} facing ${state.player.facing}` +
			`${place ? ` in ${place}` : ""} — day ${state.time.day}, ${String(state.time.hour).padStart(2, "0")}:00`,
	);
}

function quests(state: GameState, out: (line: string) => void): void {
	const open = activeQuests(state);
	if (open.length === 0) {
		out("no errands");
		return;
	}
	for (const quest of open) {
		out(`${quest.name} — ${quest.description}`);
		for (const objective of quest.objectives) {
			out(`  [${objective.done ? "x" : " "}] ${describeObjective(objective)}`);
		}
	}
}

function journal(state: GameState, out: (line: string) => void): void {
	const entries = state.journal.slice(-12);
	if (entries.length === 0) {
		out("nothing learned yet");
		return;
	}
	for (const entry of entries) out(`${entry.kind}: ${entry.text}`);
}

function items(state: GameState, out: (line: string) => void): void {
	if (state.inventory.length === 0) {
		out("carrying nothing");
		return;
	}
	for (const item of state.inventory) {
		out(`${item.quantity} × ${item.name} — ${item.description}`);
	}
}
