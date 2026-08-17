import type { ScenarioBeat } from "../core/rules/arc.js";
import { asCondition, type Condition } from "../core/rules/condition.js";
import type { Scene, SceneStep } from "../core/rules/scene.js";
import type { Trigger } from "../core/rules/trigger.js";
import { npcId } from "../core/world/spec.js";
import type { Phase } from "../scenario/phase.js";
import { type Args, CraftError } from "./args.js";
import { addTo, commit, idTaken, openWorkspace, phaseOf, replacePhase } from "./workspace.js";
import { requireId } from "./world.js";

/**
 * Commands about the story: chapters, cutscenes, what the world reacts to, and beats.
 *
 * The one idea that keeps this vocabulary from doubling is `--phase`. There is no
 * `craft phase place` and no `craft phase npc add` — every mutating verb takes the flag and
 * routes its change into that chapter's diff instead of the base world.
 */

export function craftPhaseAdd(args: Args, out: (line: string) => void): void {
	const workspace = openWorkspace(requireId(args, "phase add"));
	const id = args.str("phase");
	const name = args.str("name");
	const when = readCondition(args, "when");
	args.refuseUnknown();

	if ((workspace.artifact.phases ?? []).some((phase) => phase.id === id)) {
		throw new CraftError(`there is already a chapter called "${id}"`);
	}

	const phase: Phase = { id, name, when };
	workspace.artifact = {
		...workspace.artifact,
		phases: [...(workspace.artifact.phases ?? []), phase],
	};
	commit(workspace, `adding the chapter "${name}"`);

	out(
		`"${name}" is chapter ${(workspace.artifact.phases ?? []).length + 1}, in force once ${describe(when)}`,
	);
	out(`  add to it with --phase ${id} on any other command`);
}

export function craftSceneNew(args: Args, out: (line: string) => void): void {
	const workspace = openWorkspace(requireId(args, "scene new"));
	const id = args.str("scene");
	const at = args.has("at") ? args.int("at") : undefined;
	const skippable = !args.bool("unskippable");
	const cast = args.list("cast");
	args.refuseUnknown();

	if (workspace.artifact.scenes?.[id])
		throw new CraftError(`there is already a scene called "${id}"`);
	if (at !== undefined && !workspace.artifact.sites[String(at)]) {
		throw new CraftError(`site ${at} does not exist, so a scene cannot be set there`);
	}

	const roster: Record<string, string> = {};
	for (const entry of cast) {
		const colon = entry.indexOf(":");
		if (colon < 0) throw new CraftError(`--cast wants alias:npcId, not "${entry}"`);
		const alias = entry.slice(0, colon).trim();
		const who = entry.slice(colon + 1).trim();
		if (!knownPeople(workspace.artifact).has(who)) {
			throw new CraftError(`--cast names "${who}", who is nobody in this world`);
		}
		roster[alias] = who;
	}

	// One step, and it is a camera move, because a scene with no steps will not parse and a
	// scene that begins by looking somewhere is what every cutscene begins by doing.
	const opening: SceneStep =
		at !== undefined
			? {
					do: [{ t: "Camera", to: { kind: "anchor", siteId: at, anchor: "square" }, pan: "slow" }],
					hold: 3,
				}
			: { do: [{ t: "Wait", ticks: 2 }] };

	const scene: Scene = {
		id,
		...(Object.keys(roster).length > 0 ? { cast: roster } : {}),
		steps: [opening],
		...(skippable ? {} : { skippable: false }),
	};
	workspace.artifact = {
		...workspace.artifact,
		scenes: { ...workspace.artifact.scenes, [id]: scene },
	};
	commit(workspace, `starting the scene "${id}"`);

	out(`scene "${id}" started`);
	out(
		`  add steps with: craft scene step ${workspace.id} --scene ${id} --say "alias: what they say"`,
	);
	out(
		`  raise it with:  craft trigger add ${workspace.id} --trigger t --when <flag> --scene ${id}`,
	);
}

/**
 * Append one step to a scene.
 *
 * Steps rather than whole scenes, because a scene is built up as the author works out what
 * they want — and because every point in one has to be resolved against the world, which is
 * exactly what an author cannot do in an editor.
 */
export function craftSceneStep(args: Args, out: (line: string) => void): void {
	const workspace = openWorkspace(requireId(args, "scene step"));
	const id = args.str("scene");
	const scene = workspace.artifact.scenes?.[id];
	if (!scene) {
		const known = Object.keys(workspace.artifact.scenes ?? {});
		throw new CraftError(
			`there is no scene called "${id}"${known.length ? ` — there is ${known.join(", ")}` : ""}`,
		);
	}

	const hold = args.has("hold") ? args.int("hold") : undefined;
	const actions = readActions(args, workspace.artifact.sites);
	args.refuseUnknown();
	if (actions.length === 0) {
		throw new CraftError(
			"a step wants something to do: --say, --walk, --spawn, --camera, --face, --wait or --flag",
		);
	}

	const step: SceneStep = { do: actions, ...(hold !== undefined ? { hold } : {}) };
	const next: Scene = { ...scene, steps: [...scene.steps, step] };
	workspace.artifact = {
		...workspace.artifact,
		scenes: { ...workspace.artifact.scenes, [id]: next },
	};
	commit(workspace, `adding a step to "${id}"`);

	out(`"${id}" is now ${next.steps.length} step(s): ${actions.map((a) => a.t).join(", ")}`);
}

function readActions(
	args: Args,
	sites: Readonly<Record<string, { readonly siteId: number }>>,
): SceneStep["do"] {
	const actions: SceneStep["do"][number][] = [];

	for (const raw of args.list("camera")) {
		actions.push({
			t: "Camera",
			to: point(raw, sites),
			pan: args.oneOf("pan", ["cut", "slow", "fast"] as const, "slow"),
		});
	}
	for (const raw of args.list("spawn")) {
		const [actor, where] = split(raw, "--spawn wants actor:place");
		actions.push({ t: "Spawn", actor, at: point(where, sites) });
	}
	for (const raw of args.list("walk")) {
		const [actor, where] = split(raw, "--walk wants actor:place");
		actions.push({
			t: "WalkTo",
			actor,
			to: point(where, sites),
			speed: args.oneOf("speed", ["slow", "normal", "fast"] as const, "normal"),
		});
	}
	for (const raw of args.list("face")) {
		const [actor, where] = split(raw, "--face wants actor:direction");
		const facing = ["up", "down", "left", "right"] as const;
		if ((facing as readonly string[]).includes(where)) {
			actions.push({ t: "Face", actor, at: where as (typeof facing)[number] });
		} else {
			actions.push({ t: "Face", actor, at: point(where, sites) });
		}
	}
	for (const raw of args.list("say")) {
		const [actor, text] = split(raw, "--say wants actor: what they say");
		actions.push({ t: "Say", actor, text: text.trim() });
	}
	for (const raw of args.list("wait")) {
		actions.push({ t: "Wait", ticks: Number(raw) || 1 });
	}
	const flags = args.list("flag");
	if (flags.length > 0) {
		actions.push({
			t: "Effects",
			effects: flags.map((flag) => ({ t: "SetFlag" as const, key: flag, value: true })),
		});
	}
	for (const raw of args.list("grant")) {
		const [name, description] = split(raw, "--grant wants Item: what it looks like");
		actions.push({
			t: "Effects",
			effects: [{ t: "GrantItem", name, description: description.trim(), quantity: 1 }],
		});
	}
	// The other half of a scene that changes what the player carries. A cutscene where
	// somebody takes the letter off you is the natural way for a story to move an object on,
	// and without this the only way to lose a thing was to drop it.
	for (const name of args.list("take")) {
		actions.push({ t: "Effects", effects: [{ t: "TakeItem", name, quantity: 1 }] });
	}
	return actions;
}

/** `alias:rest`, which is how every two-part scene argument is written. */
function split(raw: string, complaint: string): [string, string] {
	const colon = raw.indexOf(":");
	if (colon < 0) throw new CraftError(`${complaint}, not "${raw}"`);
	return [raw.slice(0, colon).trim(), raw.slice(colon + 1)];
}

/**
 * Where a scene puts something, written as `x,y`, `<siteId>` or `<siteId>@anchor`.
 *
 * Deliberately not a placement's spelling. A placement resolves *inside* a building, which is
 * its purpose since stories hide things in chests; a cutscene happens in the square.
 */
function point(raw: string, sites: Readonly<Record<string, { readonly siteId: number }>>) {
	if (raw.includes(",")) {
		const [x, y] = raw.split(",").map((part) => Number(part.trim()));
		if (!Number.isInteger(x) || !Number.isInteger(y))
			throw new CraftError(`"${raw}" is not a position`);
		return { kind: "world" as const, x: x as number, y: y as number };
	}
	const [site, anchor] = raw.includes("@") ? raw.split("@") : [raw, "square"];
	const siteId = Number(site);
	if (!Number.isInteger(siteId))
		throw new CraftError(`"${raw}" is not a place: want x,y or <siteId>[@anchor]`);
	if (!sites[String(siteId)])
		throw new CraftError(`site ${siteId} does not exist; nothing has been founded there`);
	if (anchor === "door")
		throw new CraftError('a door wants a building: write "<siteId>@door:Name"');
	if (anchor?.startsWith("door:")) {
		return { kind: "door" as const, siteId, structure: anchor.slice("door:".length) };
	}
	return { kind: "anchor" as const, siteId, anchor: (anchor ?? "square") as "square" };
}

export function craftTriggerAdd(args: Args, out: (line: string) => void): void {
	const workspace = openWorkspace(requireId(args, "trigger add"));
	const phase = phaseOf(workspace, args.has("phase") ? args.str("phase") : undefined);
	const id = args.str("trigger");
	const when = readCondition(args, "when");
	const scene = args.has("scene") ? args.str("scene") : undefined;
	const flags = args.list("set");
	const repeats = args.bool("repeats");
	args.refuseUnknown();

	if (idTaken(workspace.artifact, "triggers", id))
		throw new CraftError(`there is already a trigger called "${id}"`);
	if (scene && !workspace.artifact.scenes?.[scene]) {
		throw new CraftError(`there is no scene called "${scene}" for this trigger to play`);
	}

	const effects: Trigger["effects"] = [
		...(scene ? [{ t: "PlayScene" as const, id: scene }] : []),
		...flags.map((flag) => ({ t: "SetFlag" as const, key: flag, value: true })),
	];
	if (effects.length === 0) throw new CraftError("a trigger wants --scene or --set <flag>");

	addTo(workspace, phase, "triggers", { id, when, effects, ...(repeats ? { once: false } : {}) });
	commit(workspace, `wiring the trigger "${id}"`);

	out(`"${id}" fires once ${describe(when)}`);
	if (scene) out(`  plays "${scene}"`);
	if (flags.length > 0) out(`  sets ${flags.join(", ")}`);
}

export function craftBeatAdd(args: Args, out: (line: string) => void): void {
	const workspace = openWorkspace(requireId(args, "beat add"));
	const artifact = workspace.artifact;
	const phase = phaseOf(workspace, args.has("phase") ? args.str("phase") : undefined);
	const id = args.str("beat");
	const siteId = args.int("site");
	const slot = args.int("slot");
	const setsFlag = args.str("sets-flag", `beat:${id}`);
	const requires = args.list("requires");
	const journal = args.has("journal") ? args.str("journal") : undefined;
	const optional = args.bool("optional");
	args.refuseUnknown();

	const site = artifact.sites[String(siteId)];
	if (!site) throw new CraftError(`site ${siteId} does not exist; nothing has been founded there`);
	if (!site.npcs.some((npc) => npc.slot === slot)) {
		throw new CraftError(
			`${site.name} has nobody in slot ${slot}. It has: ${site.npcs.map((npc) => `${npc.slot} (${npc.name})`).join(", ") || "nobody"}`,
		);
	}

	const beats = [...(artifact.arc?.beats ?? []), ...(phase?.beats ?? [])];
	if (beats.some((beat) => beat.id === id))
		throw new CraftError(`there is already a beat called "${id}"`);

	const beat: ScenarioBeat = {
		id,
		order: beats.length + 1,
		siteId,
		npcSlot: slot,
		requires,
		setsFlag,
		...(journal ? { journal } : {}),
		...(optional ? { optional: true } : {}),
	};

	if (phase) {
		replacePhase(workspace, { ...phase, beats: [...(phase.beats ?? []), beat] });
	} else {
		const arc = artifact.arc ?? {
			title: artifact.title,
			premise: artifact.brief.premise ?? artifact.blurb,
			beats: [],
		};
		workspace.artifact = { ...artifact, arc: { ...arc, beats: [...arc.beats, beat] } };
	}
	commit(workspace, `adding the beat "${id}"`);

	const who = site.npcs.find((npc) => npc.slot === slot);
	out(`beat "${id}" opens when the player speaks to ${who?.name} at ${site.name}`);
	out(`  sets ${setsFlag}${requires.length ? `, waits on ${requires.join(", ")}` : ""}`);
	out(`  ${npcId(siteId, slot)} now anchors the story, so they may not be marked --live`);
}

/**
 * A condition from the command line.
 *
 * Deliberately small: a flag, a visited place, or an item. Anything more elaborate is written
 * into the file by hand — a condition language on a command line is a language nobody can
 * read back, and `asCondition` already turns the common case into the right shape.
 */
function readCondition(args: Args, key: string): Condition {
	// Every part read before any is judged, because a reader that returned on the first match
	// would leave the others unread — and an unread flag is refused as unknown, which is how
	// `--when x --when-visited y` came to be rejected for not taking `--when`.
	const visited = args.list(`${key}-visited`).map((place) => ({ visited: place }) as Condition);
	const carried = args.list(`${key}-item`).map((item) => ({ item }) as Condition);
	const flags = args.list(key);
	// `asCondition` returns undefined for an empty list, so the flags go through the same
	// collected-parts path rather than being passed wholesale.
	const parts: Condition[] = [
		...visited,
		...carried,
		...(flags.length > 0 ? [asCondition(flags) as Condition] : []),
	];

	if (parts.length === 0) {
		throw new CraftError(`--${key} wants a flag, or --${key}-visited / --${key}-item`);
	}
	// Combined rather than first-wins, because the common shape is genuinely a conjunction: a
	// cutscene fires on *arriving somewhere having already been told why*. First-wins made that
	// inexpressible, and a scene whose trigger only watched the flag played in the wrong town.
	return parts.length === 1 ? (parts[0] as Condition) : { all: parts };
}

function describe(when: Condition): string {
	if ("flag" in when) return `"${when.flag}" is set`;
	if ("visited" in when) return `the player has been to ${when.visited}`;
	if ("item" in when) return `the player carries ${when.item}`;
	if ("all" in when) return when.all.map(describe).join(" and ");
	if ("any" in when) return when.any.map(describe).join(" or ");
	return "its condition holds";
}

function knownPeople(artifact: {
	readonly sites: Readonly<
		Record<string, { readonly siteId: number; readonly npcs: readonly { readonly slot: number }[] }>
	>;
}): Set<string> {
	const known = new Set<string>();
	for (const site of Object.values(artifact.sites)) {
		for (const npc of site.npcs) known.add(npcId(site.siteId, npc.slot));
	}
	return known;
}
