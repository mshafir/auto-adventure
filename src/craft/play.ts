import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { findPath } from "../core/geom/astar.js";
import { describeObjective } from "../core/rules/quests.js";
import { activeQuests, type Facing, type GameState, worldAnchor } from "../core/rules/state.js";
import { decorDef } from "../core/tiles/decor.js";
import { terrainDef } from "../core/tiles/terrain.js";
import { CHUNK, toChunk } from "../core/world/coords.js";
import { sitesInside } from "../core/world/macro.js";
import { worldSeed } from "../core/world/recipe.js";
import { ChunkManager } from "../engine/chunk-manager.js";
import { createWorldView } from "../engine/world-view.js";
import { artifactWorld } from "../scenario/artifact.js";
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
	"goto X    walk to a site id, an npc:S:N or x,y, along ground you could walk",
	"close     end the conversation you are in",
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
			await perform(session, command, radius, out);
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

/**
 * Look at a place without walking to it.
 *
 * The survey says what is at a site — its size, its ground, its budget; this says what it
 * *looks* like, which is the question an author has after claiming one and before deciding
 * where a scene happens. Both are free, because the generator is pure.
 */
export function craftRender(args: Args, out: (line: string) => void): void {
	const workspace = openWorkspace(requireId(args, "render"));
	const artifact = workspace.artifact;
	const radius = args.int("radius", 12);
	const at = args.str("at");
	args.refuseUnknown();

	const world = artifactWorld(artifact);
	const sites = sitesInside(world, artifact.bounds);
	const centre = at.includes(",")
		? { x: Number(at.split(",")[0]), y: Number(at.split(",")[1]) }
		: sites.get(Number(at))?.site;
	if (!centre || !Number.isInteger(centre.x) || !Number.isInteger(centre.y)) {
		throw new CraftError(
			`--at wants x,y or a site id — "${at}" is neither, or names no place here`,
		);
	}

	const chunks = new ChunkManager({
		world,
		capacity: 256,
		bounds: artifact.bounds,
		specFor: (site) => artifact.sites[String(site.id)]?.settlement,
		...(artifact.terraform ? { terraform: artifact.terraform } : {}),
	});
	const view = createWorldView({
		seed: artifact.seed,
		chunkAt: (cx, cy) => chunks.get(cx, cy),
		revision: () => chunks.revision,
	});
	chunks.prefetch(toChunk(centre.x, centre.y), Math.ceil(radius / CHUNK) + 1);

	const named = artifact.sites[String(Number(at))];
	out(`${named ? `${named.name} — ` : ""}${centre.x},${centre.y}`);
	for (let y = centre.y - radius; y <= centre.y + radius; y++) {
		let row = "";
		for (let x = centre.x - radius; x <= centre.x + radius; x++) {
			const door = chunks.doorAt(x, y);
			if (door) {
				row += "+";
				continue;
			}
			row += view.isPassable(x, y) ? (view.decorAt(x, y) ? "," : ".") : "#";
		}
		out(row);
	}
	out("");
	out(". walkable   , something on it   # blocked   + a door");
}

/**
 * Do one thing, and wait for its consequences.
 *
 * Asynchronous because a conversation is: the dialogue service runs a turn off the effect
 * queue, so a reply lands a microtask after the command that asked for it. The first version of
 * this printed straight after dispatching and so showed the player's own line followed by
 * "nothing more to say" — every answer in the game was invisible.
 */
async function perform(
	session: Session,
	command: string,
	radius: number,
	out: (line: string) => void,
): Promise<void> {
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
			await spoken(session);
			settle(session, out);
			after(session, out);
			return;
		case "wait":
			engine.dispatch({ t: "Tick", amount: 1 });
			return;
		case "close":
			// Movement is swallowed while somebody is talking, exactly as it is in the game — so a
			// review needs a way out of a conversation that is not a keypress it cannot send.
			engine.dispatch({ t: "CloseDialogue" });
			return;
		default:
			break;
	}

	if (command.startsWith("goto ")) {
		goTo(session, command.slice("goto ".length).trim(), radius, out);
		return;
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
		const npc = state().dialogue?.npcId ?? "";
		// The player's own line first, so a transcript reads as an exchange rather than as a list
		// of things said at somebody.
		out(`you: ${picked}`);
		engine.dispatch({ t: "DialogueTurn", npcId: npc, speaker: "you", text: picked });
		await spoken(session);
		settle(session, out);
		after(session, out);
		return;
	}

	out(`"${command}" is not something you can do. Try \`help\`.`);
}

/**
 * Walk to a place, along ground the player could actually walk.
 *
 * Not a teleport, and not a convenience: an agent reviewing a world has a budget, and counting
 * arrow keys to cross sixty tiles spends all of it on travel. What it must not do is *skip* the
 * travel, because a leg that cannot be walked is one of the things a review is looking for — so
 * this pathfinds over the same passability the player has and then takes the steps.
 */
function goTo(session: Session, where: string, radius: number, out: (line: string) => void): void {
	const engine = session.engine;
	const state = engine.getState();
	if (state.player.inside) {
		out("you are indoors; step outside first");
		return;
	}
	// Movement is swallowed while somebody is talking, exactly as it is in the game. Said rather
	// than worked around, because a review that silently walked out of conversations would not be
	// experiencing the game the player does — and because the first version of this reported
	// having walked fifty tiles while standing still.
	if (state.dialogue) {
		out("a conversation is open — `close` it first");
		return;
	}

	const aimed = destination(session, where);
	if (!aimed) {
		out(`"${where}" is not somewhere to go: want a site id, an npc:S:N, or x,y`);
		return;
	}
	// Held separately from `aimed` because the target is re-asked after the walk: a person's
	// position comes from a roster that is only populated around the player, so one sixty tiles
	// away is resolved from a stale reading.
	let target = aimed;

	const view = engine.getView();
	const from = { x: state.player.x, y: state.player.y };
	// Generous bounds, since the route may need to go round water; the search is cheap and this
	// is not on any frame path.
	const path = findPath(from, target, {
		bounds: {
			x: Math.min(from.x, aimed.x) - 96,
			y: Math.min(from.y, aimed.y) - 96,
			w: Math.abs(aimed.x - from.x) + 192,
			h: Math.abs(aimed.y - from.y) + 192,
		},
		// People count as in the way, because they are: walking into somebody opens a conversation
		// rather than moving. Without this the route went straight through whoever was standing in
		// the square and stopped dead at them a step later.
		cost: (x, y) => {
			if (!view.isPassable(x, y)) return Number.POSITIVE_INFINITY;
			if (x === aimed.x && y === aimed.y) return 1;
			return engine.personAt(x, y) ? Number.POSITIVE_INFINITY : 1;
		},
	});
	if (!path) {
		out(`there is no way from ${from.x},${from.y} to ${aimed.x},${aimed.y} on foot`);
		return;
	}

	let walked = 0;
	// The last tile is the destination itself, which for a person is the tile they are standing on
	// — walking onto it opens a conversation. Stopping beside them is what a player does.
	const route = engine.personAt(aimed.x, aimed.y) ? path.slice(1, -1) : path.slice(1);
	for (const step of route) {
		const at = engine.getState().player;
		const facing = towards(at, step);
		if (!facing) continue;
		// Twice, because the first press of a direction turns and the second walks — the game's
		// own rule, and a walker that dispatched one command per step would spend half of them
		// turning on the spot.
		engine.dispatch({ t: "Move", facing });
		engine.dispatch({ t: "Move", facing });
		settle(session, out);
		const now = engine.getState();
		if (now.player.x === at.x && now.player.y === at.y) {
			// Something is in the way that the passability check did not know about — a person
			// standing on the route is the usual one. Worth saying rather than looping.
			out(`stopped at ${at.x},${at.y}: something is in the way`);
			break;
		}
		walked++;
		// A conversation or a cutscene has taken the world. Stop rather than pressing on through
		// it, because whatever happens next is what the player would be looking at.
		if (now.scene || now.dialogue) break;
	}

	/*
	 * Close the last gap, and re-ask where the target is before doing it.
	 *
	 * Two reasons the first walk can end short. A person's position is derived from the roster,
	 * which is only populated around the player — so a target sixty tiles away is resolved from a
	 * stale reading and the route ends up a tile off. And somebody without `--stays` genuinely
	 * moves while you are walking to them.
	 */
	for (let attempt = 0; attempt < 3; attempt++) {
		const at = engine.getState().player;
		target = destination(session, where) ?? target;
		const gap = Math.abs(target.x - at.x) + Math.abs(target.y - at.y);
		if (gap <= 1) break;
		const step = towards(at, target);
		if (!step) break;
		engine.dispatch({ t: "Move", facing: step });
		engine.dispatch({ t: "Move", facing: step });
		settle(session, out);
		if (engine.getState().player.x === at.x && engine.getState().player.y === at.y) break;
		walked++;
	}

	// Turn to face what was asked for, so `goto npc:...` followed by `talk` works. Arriving beside
	// somebody and facing the other way is the sort of thing a person does without noticing and an
	// agent cannot see at all.
	const end = engine.getState().player;
	const facing = towards(end, target);
	if (facing && end.facing !== facing) engine.dispatch({ t: "Move", facing });

	// The distance actually covered, not the length of the route. The first version reported the
	// route's length and so claimed to have walked fifty tiles from a standing start.
	out(`walked ${walked} tile(s), now at ${end.x},${end.y}`);
	draw(session, radius, out);
}

/**
 * Where `goto` is being asked to go.
 *
 * Three spellings, and the middle one is the important one. `goto <siteId>` goes to the town —
 * its centre, predictably, rather than to whichever of its people the roster happened to list
 * first, which is where this landed the player before and made every approach a different tile.
 * `goto npc:S:N` walks up to a particular person, which is what "ask for Ilse Wentworth" means.
 */
function destination(session: Session, where: string): { x: number; y: number } | undefined {
	if (where.includes(",")) {
		const [x, y] = where.split(",").map((part) => Number(part.trim()));
		return Number.isInteger(x) && Number.isInteger(y)
			? { x: x as number, y: y as number }
			: undefined;
	}
	if (where.startsWith("npc:")) {
		const person = session.engine.personById(where);
		return person ? { x: person.x, y: person.y } : undefined;
	}
	const siteId = Number(where);
	if (!Number.isInteger(siteId)) return undefined;
	return siteCentre(session, siteId);
}

function siteCentre(session: Session, siteId: number): { x: number; y: number } | undefined {
	const state = session.engine.getState();
	const bounds = state.world.bounds;
	if (!bounds) return undefined;
	return sitesInside(worldSeed(state.world.seed, state.world.recipe), bounds).get(siteId)?.site;
}

/** Which single step goes from one tile to the next. Undefined when they are the same tile. */
function towards(from: { x: number; y: number }, to: { x: number; y: number }): Facing | undefined {
	if (to.x > from.x) return "right";
	if (to.x < from.x) return "left";
	if (to.y > from.y) return "down";
	if (to.y < from.y) return "up";
	return undefined;
}

/**
 * Wait for a reply, or for it to be clear there is not going to be one.
 *
 * A turn is produced off the effect queue — for an authored tree that is a microtask, for an
 * improvised one a network call — so the only honest way to read the answer is to wait for the
 * line count to move. Bounded, because a turn that never arrives must not hang a review.
 */
async function spoken(session: Session, within = 4000): Promise<void> {
	// Counted over the *other* person's lines only. `DialogueTurn` adds the player's own line
	// synchronously, so waiting for the line count to move at all returned immediately and every
	// reply in the game was reported as "nothing more to say".
	const theirs = (state: GameState) =>
		(state.dialogue?.lines ?? []).filter((line) => line.speaker !== "you").length;
	const before = theirs(session.engine.getState());
	const deadline = Date.now() + within;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 5));
		const now = session.engine.getState();
		if (theirs(now) > before) return;
		// Nothing opened at all — the tile in front held no conversation — so there is nothing to
		// wait for, and saying so at once beats a four-second pause.
		if (!now.dialogue) return;
	}
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
	if (last && last.speaker !== "you") out(`${last.speaker}: ${last.text}`);
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
