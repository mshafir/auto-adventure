import type { BuildingPlacement } from "../core/gen/features/patch.js";
import type { ScenarioBeat } from "../core/rules/arc.js";
import { asCondition, itemsRead } from "../core/rules/condition.js";
import type { DomainEffect } from "../core/rules/effects.js";
import type { Facing, QuestObjective } from "../core/rules/state.js";
import { namesMatch } from "../core/rules/surroundings.js";
import { toChunk } from "../core/world/coords.js";
import type { MacroSite } from "../core/world/macro.js";
import { npcId } from "../core/world/spec.js";
import type { GameEngine } from "../engine/engine.js";
import type { PlacedNpc } from "../engine/npc-directory.js";
import type { ScenarioArtifact } from "./artifact.js";

/**
 * How a player does things, for a harness that is not one.
 *
 * Lifted out of `walkTheStory` when a second caller appeared. Every function here carries a
 * comment recording a bug it exists to prevent — a door opened with the wrong key, a room
 * with no way out, a card nobody read, a teleport that left the player believing they were
 * still indoors — and every one of those was found by a real walk failing in a way that
 * looked like the scenario's fault. That is the whole argument for this file existing rather
 * than the primitives being written twice: the second copy would relearn all of it.
 *
 * `absent` is collected here rather than returned per call because it is the same fact for
 * every caller: somebody the story names and the engine put nowhere.
 */

export interface StoryWalker {
	/**
	 * Let whatever the world is doing finish, before doing anything with it.
	 *
	 * A card and a cutscene both take the world away, and a walker that does not know it spends
	 * its whole budget pressing arrow keys at something swallowing them. Cards are dismissed and
	 * scenes are played out frame by frame, answering each line — as a player would, rather than
	 * skipping, because a walkthrough that skipped every scene would never prove they work.
	 */
	readonly catchUp: () => void;
	readonly goTo: (site: MacroSite) => void;
	readonly buildingsOf: (siteId: number, structureName?: string) => BuildingPlacement[];
	readonly findIndoors: (id: string, siteId: number, structure?: string) => PlacedNpc | undefined;
	readonly talkTo: (
		id: string,
		indoors?: { readonly siteId: number; readonly structure?: string },
	) => Promise<boolean>;
	readonly roomOf: (
		siteId: number,
		slot: number,
	) => { readonly siteId: number; readonly structure?: string } | undefined;
	/**
	 * Do what an errand asks for, or hand it over and say so.
	 *
	 * Here rather than in either caller, because both need it and for the same reason: a
	 * main-line beat commonly waits on the previous beat's errand being closed, so a walker
	 * that never closes one cannot get past the second scene. That was found by writing
	 * `settleTheStory` without it and watching both shipped stories stop at their first gated
	 * beat.
	 */
	readonly satisfy: (objective: QuestObjective, questName: string) => Promise<boolean>;
	/**
	 * Hand over whatever a beat needs the player to be carrying before it can open.
	 *
	 * Shared for the same reason as `satisfy`: finding a thing is not something a walker can
	 * do, and both callers have to grant it before the visit so the scene plays as it would for
	 * a player who had already found it.
	 */
	readonly openWith: (beat: ScenarioBeat) => void;
	/** Ids the walk asked for and the engine had nowhere to put. */
	readonly absent: ReadonlySet<string>;
	/** What had to be given rather than earned, in words. */
	readonly concessions: readonly string[];
}

/** How many doors to open looking for one person before giving up on them. */
const INDOOR_TRIES = 12;

export function storyWalker(
	artifact: ScenarioArtifact,
	engine: GameEngine,
	sites: ReadonlyMap<number, MacroSite>,
): StoryWalker {
	const absent = new Set<string>();
	const concessions: string[] = [];
	const state = () => engine.getState();
	const apply = (...effects: DomainEffect[]) => engine.dispatch({ t: "ApplyEffects", effects });

	/**
	 * Read whatever the story has just put on screen.
	 *
	 * Not housekeeping. A card blocks the game until it is dismissed — deliberately, since
	 * framing that can be walked out of unread is framing nobody reads — so a walker that
	 * never dismisses one stops being able to do anything the moment a beat shows one. The
	 * symptom is precise and thoroughly misleading: conversations still *open*, but the
	 * dialogue never lands in state, so a `talk` objective sits unticked forever and the
	 * story reports as unfinishable when in fact nobody was listening.
	 */
	const catchUp = () => {
		// Bounded generously rather than tightly: a cutscene is dozens of frames, and several may
		// fire in a row when a chapter turns. The bound is only here so a scene that somehow
		// cannot finish stops the walk instead of hanging it.
		for (let guard = 0; guard < 4000; guard++) {
			const now = state();
			if (now.card) {
				engine.dispatch({ t: "DismissCard" });
				continue;
			}
			if (!now.scene) return;
			// The advance key when somebody is speaking, a frame otherwise — which is exactly what
			// the UI's interval and the player's thumb do between them.
			engine.dispatch(now.scene.caption ? { t: "Advance" } : { t: "SceneFrame" });
		}
	};

	/**
	 * Turn to face a direction, which is what the first press of a key does.
	 *
	 * A `Move` the player is not already facing turns them and nothing else — the game's
	 * own rule, and the right one for a keyboard. A walker that dispatches one command per
	 * direction therefore spends half of them turning on the spot, which is how a room
	 * with a door in it becomes a room with no way out.
	 */
	const face = (facing: Facing) => {
		if (state().player.facing !== facing) engine.dispatch({ t: "Move", facing });
	};

	/** One actual step, in the direction given. */
	const step = (facing: Facing) => {
		face(facing);
		engine.dispatch({ t: "Move", facing });
	};

	/**
	 * Come back out, the way a player does: step off the threshold and back onto it.
	 *
	 * A doorway is crossed by *walking through it*, so there is no "leave" to dispatch —
	 * and entering leaves the player standing on the exit tile, which cannot be stepped
	 * onto from where they already are. One step in and one step back is the whole trick;
	 * the directions are tried in turn because a room's furniture decides which of them is
	 * free.
	 *
	 * Getting this wrong is quiet and expensive. Indoors the player's coordinates are
	 * interior-local and the reducer asks which place they are in about the *doorstep* they
	 * came in by — so a walker that thinks it left, teleports across the world, and carries
	 * on is reported as standing in the last town it was inside, forever. A `reach`
	 * objective for the town it is actually standing in never ticks, and the story reads as
	 * unfinishable.
	 */
	const leaveRoom = () => {
		const ways = [
			["up", "down"],
			["down", "up"],
			["left", "right"],
			["right", "left"],
		] as const;
		for (const [away, back] of ways) {
			if (!state().player.inside) return;
			step(away);
			// Checked between the two, not only around the pair. The step *away* is often the
			// one that lands on the exit — and stepping back afterwards walks straight in
			// through the door again, which looks exactly like never having left.
			if (!state().player.inside) return;
			step(back);
		}
	};

	/** Stand in a place, which is what makes the engine agree the player has been there. */
	const goTo = (site: MacroSite) => {
		// Out of doors first. Indoors the player's coordinates are interior-local, so
		// teleporting without leaving would put them at a world position while the game
		// still believes they are in a room — and every question about where they are,
		// from which town this is to which chunks to keep, answers about somewhere else.
		leaveRoom();
		// Ground first, then stand on it. The reducer settles inside the teleport — asking
		// which place this is, ticking whatever that answers — so arriving before the chunk
		// exists means arriving nowhere, and a `reach` objective for the town the player is
		// standing in stays open.
		//
		// The whole footprint, not the chunk under the player: a roster derived while some
		// of a town's ground is missing is a guess, at the limit a guess that nobody lives
		// there. Two chunks either way covers the largest site the generator makes.
		const cc = toChunk(site.site.x, site.site.y);
		engine.getChunks().prefetch(cc, 2);
		engine.populateNpcs(cc);
		apply({ t: "Teleport", x: site.site.x, y: site.site.y });
	};

	/** Every building of a settlement, the one a person was assigned to first. */
	const buildingsOf = (siteId: number, structureName?: string): BuildingPlacement[] => {
		const site = sites.get(siteId);
		if (!site) return [];
		const cc = toChunk(site.site.x, site.site.y);
		const around: BuildingPlacement[] = [];
		for (let dy = -2; dy <= 2; dy++) {
			for (let dx = -2; dx <= 2; dx++) {
				around.push(...engine.getChunks().buildingsIn(cc.cx + dx, cc.cy + dy));
			}
		}
		const wanted = structureName?.toLowerCase();
		if (!wanted) return around;
		return [...around].sort(
			(a, b) => Number(b.name?.toLowerCase() === wanted) - Number(a.name?.toLowerCase() === wanted),
		);
	};

	/**
	 * Go in through a door, the way a player does: stand on the step and walk into it.
	 *
	 * Walking, not interacting. A doorway is crossed by stepping onto it — deliberately,
	 * so that a door behaves the way a door should — and `Interact` is for searching and
	 * speaking. A walker that pressed the interact key at a door stood on the step
	 * forever and reported everybody indoors as missing.
	 */
	const enterBuilding = (building: BuildingPlacement): boolean => {
		apply({ t: "Teleport", x: building.door.x, y: building.door.y + 1 });
		catchUp();
		step("up");
		return state().player.inside !== undefined;
	};

	/**
	 * Find somebody the scenario put in a room, by going in and looking.
	 *
	 * An indoor character is only resolvable while the player is standing in their
	 * building, which is correct and which means a walker that never goes inside reports
	 * every one of them as missing. The building they were assigned to is tried first and
	 * the rest are tried after it, because `structureName` is matched loosely by the
	 * engine and a walk that trusted it exactly would give up on a scene that a player
	 * would find by opening the next door along.
	 */
	const findIndoors = (id: string, siteId: number, structure?: string) => {
		for (const building of buildingsOf(siteId, structure).slice(0, INDOOR_TRIES)) {
			leaveRoom();
			if (!enterBuilding(building)) continue;
			const person = engine.personById(id);
			if (person) return person;
		}
		return undefined;
	};

	const talkTo = async (
		id: string,
		indoors?: { readonly siteId: number; readonly structure?: string },
	): Promise<boolean> => {
		catchUp();
		const person = indoors
			? (engine.personById(id) ?? findIndoors(id, indoors.siteId, indoors.structure))
			: engine.personById(id);
		if (!person) {
			absent.add(id);
			return false;
		}
		engine.dispatch({ t: "DialogueOpened", npcId: person.id, npcName: person.name });
		// The opening line arrives through the dialogue service, and `talked` reads the
		// turn it records — so this needs a real tick, not a zero-tick wait.
		await new Promise((resolve) => setTimeout(resolve, 20));
		engine.dispatch({ t: "CloseDialogue" });
		catchUp();
		return true;
	};

	/** The room somebody stands in, when the scenario put them in one. */
	const roomOf = (
		siteId: number,
		slot: number,
	): { readonly siteId: number; readonly structure?: string } | undefined => {
		const npc = artifact.sites[String(siteId)]?.npcs.find((person) => person.slot === slot);
		if (!npc?.indoors) return undefined;
		return { siteId, ...(npc.structureName ? { structure: npc.structureName } : {}) };
	};

	const openWith = (beat: ScenarioBeat) => {
		for (const item of itemsRead(asCondition(beat.opensOn))) {
			if (state().inventory.some((entry) => entry.name === item)) continue;
			apply({ t: "GrantItem", name: item, description: "Given, to walk the story.", quantity: 1 });
			concessions.push(`gave "${item}" so beat ${beat.id} could open`);
		}
	};

	/**
	 * Do the thing an objective asks for, or hand it over and say so.
	 *
	 * A walker is not a player. It cannot search a crate it has no reason to look in, or work
	 * out which conversation hands over a ring — so where an objective cannot be satisfied by
	 * going somewhere or speaking to somebody, it is granted outright and *recorded*. A story
	 * that only finishes with four things handed to the player is a different result from one
	 * that finishes on its own, and reporting both the same way would make the walk worth
	 * nothing.
	 */
	const satisfy = async (objective: QuestObjective, questName: string): Promise<boolean> => {
		if (objective.kind === "quest") return false;
		if (objective.kind === "reach") {
			const target = [...sites.values()].find((site) =>
				namesMatch(artifact.sites[String(site.id)]?.name ?? "", objective.target),
			);
			if (!target) return false;
			goTo(target);
			return true;
		}
		if (objective.kind === "talk") {
			const found = Object.values(artifact.sites).flatMap((spec) =>
				spec.npcs
					.filter((npc) => namesMatch(npc.name, objective.target))
					.map((npc) => ({ spec, npc })),
			);
			const person = found[0];
			if (!person) return false;
			const site = sites.get(person.spec.siteId);
			if (site) goTo(site);
			return talkTo(
				npcId(person.spec.siteId, person.npc.slot),
				roomOf(person.spec.siteId, person.npc.slot),
			);
		}
		if (objective.kind === "have") {
			if (state().inventory.some((entry) => entry.name === objective.target)) return false;
			apply({
				t: "GrantItem",
				name: objective.target,
				description: "Given, to walk the story.",
				quantity: objective.quantity ?? 1,
			});
			concessions.push(`gave "${objective.target}" to close "${questName}"`);
			return true;
		}
		if (state().flags[objective.target]) return false;
		apply({ t: "SetFlag", key: objective.target, value: true });
		concessions.push(`set "${objective.target}" to close "${questName}"`);
		return true;
	};

	return {
		catchUp,
		goTo,
		buildingsOf,
		findIndoors,
		talkTo,
		roomOf,
		satisfy,
		openWith,
		absent,
		concessions,
	};
}
