/**
 * Plan a demo route, print it as VHS keystrokes, and check it before recording.
 *
 *   npx vite-node src/tools/route.ts 23                        # print the tape body
 *   npx vite-node src/tools/route.ts 23 --verify docs/demo.tape # replay it
 *
 * Choreographing `docs/demo.tape` by hand means guessing where the walls are, and
 * a take costs several minutes to find out you guessed wrong. This builds the
 * same world the game will — through the same Director, because a settlement
 * generated with a spec is laid out differently from one generated without —
 * paths through it with the same A*, and then replays the result through a real
 * engine and reports where the player actually ends up.
 *
 * Everything it knows was learned from a take that went wrong: the turn-first
 * rule, blocking furniture indoors, doorsteps occupied by their own shopkeeper,
 * houses with nothing in them, and VHS batching keys it was asked to space out.
 *
 * Not part of the build. Run it when the demo seed changes.
 */
import { readFileSync } from "node:fs";
import { Director } from "../ai/director/director.js";
import { resolveSeed } from "../config.js";
import { getInterior, type Interior } from "../core/gen/features/interior.js";
import type { StructureKind } from "../core/gen/features/patch.js";
import { findPath } from "../core/geom/astar.js";
import type { Rect } from "../core/geom/vec.js";
import { containerContents, isContainer } from "../core/rules/loot.js";
import { createInitialState } from "../core/rules/state.js";
import { D, decorDef } from "../core/tiles/decor.js";
import { TFlag } from "../core/tiles/flags.js";
import { CHUNK, toChunk } from "../core/world/coords.js";
import { sitesAround } from "../core/world/macro.js";
import { worldSeed } from "../core/world/recipe.js";
import { GameEngine } from "../engine/engine.js";
import { findSpawn } from "../engine/spawn.js";

const seed = resolveSeed(process.argv[2]);
const world = worldSeed(seed);
const spawn = findSpawn(world);
const cc = toChunk(spawn.x, spawn.y);

/**
 * The same Director the game runs, rather than a hand-rolled bag of fallback
 * specs. It commits fallbacks only for the sites within one macro cell, and a
 * settlement generated with a spec is laid out differently from one generated
 * without — so building the world any other way plans a route through a village
 * that does not exist. Which is exactly what the first take walked into.
 */
const host: { engine?: GameEngine } = {};
const director = new Director({
	world,
	regions: {},
	sites: {},
	sources: {},
	disabled: true,
	onLore: () => undefined,
	onRegion: () => undefined,
	onSite: (spec, source) => host.engine?.dispatch({ t: "SiteLearned", spec, source }),
	onSiteChanged: (site) => host.engine?.rebuildSite(site),
});

const engine = new GameEngine(
	createInitialState(
		{ id: "route", name: "route", seed, createdAt: "2026-01-01T00:00:00.000Z" },
		spawn,
	),
	{
		runEffect: () => undefined,
		specFor: director.specFor,
		siteSpec: (id) => director.siteSpec(id),
	},
);
host.engine = engine;
director.request(cc);
engine.getChunks().prefetch(cc, 2);
engine.populateNpcs(cc);

const here = director.siteSpec(
	sitesAround(world, cc.cx, cc.cy, 1).find((s) => specHas(s.id))?.id ?? -1,
);
function specHas(id: number) {
	return director.siteSpec(id) !== undefined;
}
process.stdout.write(`# settlement: ${here?.name ?? "(none)"}\n`);

const view = engine.getView();
const bounds: Rect = {
	x: (cc.cx - 1) * CHUNK,
	y: (cc.cy - 1) * CHUNK,
	w: CHUNK * 3,
	h: CHUNK * 3,
};

/**
 * Steps from `from` to `to`. Never routes *through* a person, but may end on
 * one — walking into somebody is how you talk to them — and may end on a closed
 * door, which is how you go inside.
 */
function walk(from: { x: number; y: number }, to: { x: number; y: number }) {
	return findPath(from, to, {
		bounds,
		diagonal: false,
		cost: (x, y) => {
			if (x === to.x && y === to.y) return 1;
			if (engine.getNpcs().at(x, y)) return Number.POSITIVE_INFINITY;
			return (view.flagsAt(x, y) & TFlag.Passable) !== 0 ? 1 : Number.POSITIVE_INFINITY;
		},
	});
}

/**
 * Whether an interior tile can be walked on.
 *
 * The tile flag is not enough: a table or a bed blocks as surely as a wall, and
 * `interior-view.ts` checks both. Planning against the flag alone routed the
 * walk straight through the furniture beside the door, and the recording stood
 * there pressing left into a dresser.
 */
function insideOpen(interior: Interior, x: number, y: number): boolean {
	if (x < 0 || y < 0 || x >= interior.width || y >= interior.height) return false;
	const i = y * interior.width + x;
	if (decorDef(interior.decor[i] ?? D.none).blocks) return false;
	return ((interior.flags[i] ?? 0) & TFlag.Passable) !== 0;
}

const KEY: Record<string, string> = { "0,-1": "Up", "0,1": "Down", "-1,0": "Left", "1,0": "Right" };

/**
 * A path as VHS lines.
 *
 * Two rules, both learned from takes that went wrong.
 *
 * A change of direction costs an extra press, because the first press of a new
 * direction only turns. Get it wrong and the walk stops one tile short of
 * everything.
 *
 * That extra press is folded into the same repeat command rather than emitted on
 * its own line. VHS applies `@400ms` *between the repeats of one command*, not
 * between commands — so a bare `Left` followed by `Left 2` sends two keys
 * back-to-back, they arrive in a single read, and Ink parses the pair of
 * three-byte escape sequences as one key. The step is silently lost. Merging
 * them means every press in a run is properly spaced, and an explicit sleep
 * covers the seam between runs.
 */
const PRESS = "400ms";

function keys(path: readonly { x: number; y: number }[], facing = "Down"): string[] {
	const out: string[] = [];
	let last = facing;
	let run = 0;
	const flush = () => {
		if (run > 0) {
			if (out.length > 0) out.push(`Sleep ${PRESS}`);
			out.push(`${last}@${PRESS} ${run}`);
		}
		run = 0;
	};
	for (let i = 1; i < path.length; i++) {
		const a = path[i - 1];
		const b = path[i];
		if (!a || !b) continue;
		const key = KEY[`${b.x - a.x},${b.y - a.y}`];
		if (!key) continue;
		if (key !== last) {
			flush();
			last = key;
			run = 1; // the turn
		}
		run++; // the step
	}
	flush();
	return out;
}

/** Every key emitted so far, so the whole plan can be replayed at the end. */
const emitted: string[] = [];

/** Emit a leg and return where the player is standing when it ends. */
function leg(
	label: string,
	from: { x: number; y: number },
	target: { x: number; y: number },
	facing: string,
): { at: { x: number; y: number }; facing: string } | undefined {
	const path = walk(from, target);
	process.stdout.write(`\n# ${label} — ${target.x},${target.y}\n`);
	if (!path || path.length < 2) {
		process.stdout.write("#   NO ROUTE\n");
		return undefined;
	}
	const lines = keys(path, facing);
	process.stdout.write(`#   ${path.length - 1} steps\n${lines.join("\n")}\n`);
	emitted.push(...lines);

	// The final step lands on the target, which for a person or a door is a bump
	// rather than a move: the player is still on the tile before it.
	const stop = path[path.length - 2] ?? from;
	const lastKey = lines[lines.length - 1]?.split("@")[0]?.split(" ")[0] ?? facing;
	return { at: stop, facing: lastKey };
}

process.stdout.write(`# seed ${seed}  spawn ${spawn.x},${spawn.y}  chunk ${cc.cx},${cc.cy}\n`);

const people = engine
	.getNpcs()
	.all()
	.map((npc) => ({ npc, d: Math.abs(npc.x - spawn.x) + Math.abs(npc.y - spawn.y) }))
	.sort((a, b) => a.d - b.d);

process.stdout.write("\n# --- people ---\n");
for (const { npc, d } of people.slice(0, 6)) {
	process.stdout.write(`#   ${npc.name} (${npc.role}) at ${npc.x},${npc.y}  ${d} away\n`);
}

const doors = [-1, 0, 1]
	.flatMap((dy) => [-1, 0, 1].map((dx) => ({ dx, dy })))
	.flatMap(({ dx, dy }) => engine.getChunks().buildingsIn(cc.cx + dx, cc.cy + dy))
	.map((b) => ({ b, d: Math.abs(b.door.x - spawn.x) + Math.abs(b.door.y - spawn.y) }))
	.sort((a, b) => a.d - b.d);

process.stdout.write("\n# --- doors ---\n");
for (const { b, d } of doors.slice(0, 6)) {
	process.stdout.write(`#   ${b.kind} ${b.name ?? ""} door ${b.door.x},${b.door.y}  ${d} away\n`);
}

/**
 * Pick the pairing, rather than taking the nearest of each.
 *
 * Nearest is not the same as reachable: this village's closest door has its own
 * blacksmith standing on the doorstep, so talking to them and then going inside
 * is impossible in that order. Searching the pairings finds the one that works
 * and keeps the walk short.
 */
let best: { npc: (typeof people)[number]; door: (typeof doors)[number]; total: number } | undefined;

/**
 * Whether a building holds anything worth searching.
 *
 * A house keeps almost nothing, and the first take walked across a village to
 * open a crate with nothing in it. What a building stores is a function of what
 * it is for, so this asks before choosing rather than after recording.
 */
function hasLoot(building: (typeof doors)[number]["b"]): boolean {
	const interior = getInterior(seed, building.interiorId, building.kind as StructureKind);
	for (let y = 0; y < interior.height; y++) {
		for (let x = 0; x < interior.width; x++) {
			const decor = interior.decor[y * interior.width + x] ?? 0;
			if (!isContainer(decor)) continue;
			if (containerContents(seed, building.interiorId, x, y, decor, building.kind).length > 0) {
				return true;
			}
		}
	}
	return false;
}

for (const person of people.slice(0, 4)) {
	const toNpc = walk(spawn, { x: person.npc.x, y: person.npc.y });
	if (!toNpc || toNpc.length < 2) continue;
	const stop = toNpc[toNpc.length - 2] ?? spawn;
	for (const door of doors) {
		const toDoor = walk(stop, door.b.door);
		if (!toDoor) continue;
		// A stocked building beats a near one: the walk is a few seconds of GIF and
		// finding nothing is the whole point of the scene wasted.
		const total = toNpc.length + toDoor.length + (hasLoot(door.b) ? 0 : 1000);
		if (!best || total < best.total) best = { npc: person, door, total };
	}
}

if (!best) {
	process.stdout.write("\n# no workable pairing of a person and a door\n");
} else {
	process.stdout.write(`\n# best pairing: ${best.npc.npc.name} then a ${best.door.b.kind}\n`);
	const end = leg(
		`walk up to ${best.npc.npc.name}, the ${best.npc.npc.role}`,
		spawn,
		{ x: best.npc.npc.x, y: best.npc.npc.y },
		"Down",
	);
	if (end)
		leg(`walk in through the ${best.door.b.kind} door`, end.at, best.door.b.door, end.facing);
}

/**
 * And the last leg, inside.
 *
 * An interior is a separate grid with its own coordinates, so the walk to a
 * crate has to be planned in that space rather than in the world's.
 */
if (best) {
	const interior = getInterior(seed, best.door.b.interiorId, best.door.b.kind as StructureKind);
	const inBounds: Rect = { x: 0, y: 0, w: interior.width, h: interior.height };
	const at = (x: number, y: number) => y * interior.width + x;

	const crates: { x: number; y: number }[] = [];
	for (let y = 0; y < interior.height; y++) {
		for (let x = 0; x < interior.width; x++) {
			if (isContainer(interior.decor[at(x, y)] ?? 0)) crates.push({ x, y });
		}
	}

	process.stdout.write(
		`\n# --- inside the ${best.door.b.kind} (${interior.width}x${interior.height}) ---\n`,
	);
	process.stdout.write(`#   entrance ${interior.entrance.x},${interior.entrance.y}\n`);
	for (const c of crates) {
		const held = containerContents(
			seed,
			best.door.b.interiorId,
			c.x,
			c.y,
			interior.decor[at(c.x, c.y)] ?? 0,
			best.door.b.kind,
		);
		const what = held.length
			? held.map((i) => `${i.quantity} ${i.name}`).join(", ")
			: "EMPTY — nothing to find";
		process.stdout.write(`#   container at ${c.x},${c.y}: ${what}\n`);
	}

	// Stand next to a crate and face it; SPACE searches whatever you are facing.
	for (const crate of crates.slice(0, 3)) {
		const path = findPath(interior.entrance, crate, {
			bounds: inBounds,
			diagonal: false,
			cost: (x, y) => {
				if (x === crate.x && y === crate.y) return 1;
				return insideOpen(interior, x, y) ? 1 : Number.POSITIVE_INFINITY;
			},
		});
		if (!path || path.length < 2) continue;
		process.stdout.write(`\n# walk to the container at ${crate.x},${crate.y}\n`);
		process.stdout.write(`#   ${path.length - 1} steps, then SPACE\n`);
		const inKeys = keys(path, "Up");
		process.stdout.write(`${inKeys.join("\n")}\nSpace\n`);

		// And back out. The entrance is also the way out, so stepping onto it leaves.
		const stop = path[path.length - 2] ?? interior.entrance;
		const lastKey = inKeys[inKeys.length - 1]?.split("@")[0]?.split(" ")[0] ?? "Up";
		const back = findPath(stop, interior.entrance, {
			bounds: inBounds,
			diagonal: false,
			cost: (x, y) => (insideOpen(interior, x, y) ? 1 : Number.POSITIVE_INFINITY),
		});
		if (back && back.length > 1) {
			// Walking *onto* the entrance is not leaving: the way out is the open tile
			// in the south wall one below it, so the walk back needs one more press.
			const outKeys = keys(back, lastKey);
			const lastOut = outKeys[outKeys.length - 1] ?? "";
			outKeys.push(lastOut.startsWith("Down") ? "Down@400ms" : "Sleep 400ms\nDown@400ms 2");
			process.stdout.write(`\n# back out through the doorway\n#   ${back.length - 1} steps\n`);
			process.stdout.write(`${outKeys.join("\n")}\n`);
		}
		break;
	}
}

/**
 * Replay a tape through a real engine.
 *
 * A path is not a plan until the game agrees with it: turns cost a press and no
 * time, walls swallow presses silently, a conversation eats the arrow keys, and
 * an off-by-one leaves the recording walking on the spot. Each take costs several
 * minutes, so the tape is checked here first.
 *
 *   npx vite-node src/tools/route.ts 23 --verify docs/demo.tape
 */
function replay(tape: string): void {
	const sim = new GameEngine(
		createInitialState(
			{ id: "sim", name: "sim", seed, createdAt: "2026-01-01T00:00:00.000Z" },
			spawn,
		),
		{
			runEffect: () => undefined,
			specFor: director.specFor,
			siteSpec: (id) => director.siteSpec(id),
		},
	);
	sim.getChunks().prefetch(cc, 2);
	sim.populateNpcs(cc);

	const facingOf: Record<string, "up" | "down" | "left" | "right"> = {
		Up: "up",
		Down: "down",
		Left: "left",
		Right: "right",
	};

	const where = () => {
		const st = sim.getState();
		const inside = st.player.inside ? ` inside(${st.player.inside.structure})` : "";
		const talking = st.dialogue ? ` talking(${st.dialogue.npcName})` : "";
		return `${st.player.x},${st.player.y}${inside}${talking}`;
	};

	process.stdout.write(`\n# --- replay of ${tape} ---\n#   start ${where()}\n`);

	// A focused list pane takes the arrow keys, so a Down after `Type "i"` moves a
	// cursor rather than the player. Without this the replay reports the player
	// wandering off during the panel tour and the tape looks broken when it is not.
	let focused = false;

	for (const raw of readFileSync(tape, "utf8").split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		if (/^Type "[iqj]"$/.test(line)) {
			focused = true;
			continue;
		}
		if (/^Type "[mw]"$/.test(line)) {
			focused = false;
			continue;
		}
		const [head, count] = line.split(" ");
		const key = head?.split("@")[0] ?? "";
		const facing = facingOf[key];

		if (focused) {
			if (key === "Escape") focused = false;
			continue;
		}
		if (facing) {
			for (let n = 0; n < Number(count ?? 1); n++) sim.dispatch({ t: "Move", facing });
		} else if (key === "Space") {
			sim.dispatch({ t: "Interact" });
		} else if (key === "Escape") {
			sim.dispatch({ t: "CloseDialogue" });
		} else {
			continue; // Sleep, Set, Type, Output — nothing that moves the player
		}
		process.stdout.write(`#   ${line.padEnd(18)} -> ${where()}\n`);
	}

	const st = sim.getState();
	process.stdout.write(
		`#   carrying: ${st.inventory.map((i) => `${i.quantity} ${i.name}`).join(", ")}\n`,
	);
	if (st.notice) process.stdout.write(`#   notice: ${st.notice}\n`);
}

const verify = process.argv.indexOf("--verify");
if (verify !== -1) {
	const tape = process.argv[verify + 1];
	if (tape) replay(tape);
}
