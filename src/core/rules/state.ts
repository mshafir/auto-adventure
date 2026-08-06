import type { PackOverride } from "../content/pack.js";
import type { WorldBounds } from "../world/bounds.js";
import type { ScenarioBrief } from "../world/brief.js";
import type { ChunkKey } from "../world/coords.js";
import type { WorldRecipe } from "../world/recipe.js";
import type { RegionSpec, SiteSpec, SpecSource, WorldLore } from "../world/spec.js";
import type { ScenarioArc } from "./arc.js";
import type { Card } from "./card.js";
import { startTick, type TimeOptions, timeFromTick, type WorldTime } from "./clock.js";
import type { CachedTurn } from "./dialogue-cache.js";
import type { Barrier } from "./lock.js";
import type { NpcRecord } from "./npc.js";
import type { Placement } from "./placement.js";
import type { Trigger } from "./trigger.js";

export const SAVE_VERSION = 3;

export type Facing = "up" | "down" | "left" | "right";

export interface WorldMeta {
	readonly id: string;
	readonly name: string;
	readonly seed: number;
	readonly createdAt: string;
	/**
	 * The edge of the world, for a pre-generated scenario. Absent means infinite.
	 *
	 * Stored here beside the seed because it is part of what the world *is*: a
	 * bounded save has to stay bounded on reload whether or not the artifact it
	 * came from is still on disk. Terrain is a pure function of the seed and this.
	 */
	readonly bounds?: WorldBounds;
	/**
	 * How this world was generated, beyond the seed.
	 *
	 * Beside the seed and the bounds because it is the same kind of fact: terrain is a
	 * pure function of `(seed, recipe, position)`, so a save that lost the recipe would
	 * come back as a *different world* with the player standing in the middle of it —
	 * a town displaced by fifty tiles, a coastline where a road was. Absent means the
	 * built-in defaults, which is every world the generator made before recipes existed.
	 */
	readonly recipe?: WorldRecipe;
	/**
	 * The tile pack this world is drawn with, by name.
	 *
	 * Persisted for the same reason the content pack's *resolved tables* are: a world
	 * that looked one way when it was made should look that way when it is reopened,
	 * whatever `TILE_PACK` happens to say today. Unlike terrain, nothing about this is
	 * load-bearing — a missing pack falls back to the built-in look and the world plays
	 * identically, which is why the name travels rather than the whole pack.
	 */
	readonly tiles?: string;
	/** The scenario this world came from, if any. Re-attaches arc and dialogue. */
	readonly scenarioId?: string;
	/**
	 * Whether this world has a clock, and what it drives.
	 *
	 * Here beside the seed and the bounds for the same reason those are: it is part of
	 * what the world *is*. A world authored with no time of day has to stay that way on
	 * reload whether or not the artifact it came from is still on disk — and the hour is
	 * derived from the tick, so a save that lost this setting would start deriving one.
	 */
	readonly time?: TimeOptions;
	/**
	 * Whether a model may improvise conversation for this world during play.
	 *
	 * Here for the same reason `time` is: it is part of what the world is, and it has to
	 * survive a reload whether or not the artifact it came from is still on disk. Without
	 * it a scenario generated to improvise would fall silent the second time it was opened.
	 */
	readonly liveInGame?: boolean;
}

/**
 * Where the player is when they are not in the open world.
 *
 * Interiors are separate grids rather than part of the chunk, so "inside" is a
 * different coordinate space entirely; `returnX`/`returnY` remember the
 * doorstep to step back out onto.
 */
export interface InsidePlace {
	readonly interiorId: number;
	readonly structure: string;
	readonly name?: string;
	readonly returnX: number;
	readonly returnY: number;
	/**
	 * Which storey, or how deep. Absent means the ground floor.
	 *
	 * Optional rather than defaulted to 0 so a save written before interiors had
	 * levels loads as what it was: somebody standing on the ground floor.
	 */
	readonly level?: number;
}

export interface PlayerState {
	readonly x: number;
	readonly y: number;
	readonly facing: Facing;
	readonly hp: number;
	readonly maxHp: number;
	readonly inside?: InsidePlace;
}

/**
 * Where the player is *in the world*, whether or not they are standing in it.
 *
 * Indoors `player.x/y` are local to the interior grid, so a chunk-space question asked
 * of them straight — which chunks to keep loaded, which site is this, which building
 * has this interior id — is answered about a place near the origin instead of about
 * where the player actually is. Somebody in a bower at (-1,-122) reads as (5,7), and
 * every one of those questions quietly returns nothing.
 *
 * The doorstep is the honest answer: it is the tile they will step back out onto, it is
 * inside the site they are in, and it is what `placeNameAt` has always been asked.
 */
export function worldAnchor(player: PlayerState): { readonly x: number; readonly y: number } {
	const inside = player.inside;
	return inside ? { x: inside.returnX, y: inside.returnY } : { x: player.x, y: player.y };
}

// Re-exported so the several dozen call sites that only ever wanted "what time is
// it" keep importing it from here, while the clock's own rules live in one file.
export {
	START_TICK,
	startTick,
	TICKS_PER_HOUR,
	type TimeOptions,
	timeFromTick,
	type WorldTime,
} from "./clock.js";

export interface InventoryItem {
	readonly name: string;
	readonly description: string;
	readonly quantity: number;
}

/**
 * What an objective is checked against.
 *
 * `quest` is the one that makes a story a graph rather than a line: an errand whose
 * objective is another errand's completion. It needs no new machinery because
 * `verifyQuests` already re-checks every objective against real state after every
 * command, so a parent closes the moment its last child does — which is exactly the
 * property that stopped quests depending on a model remembering to say so.
 */
export type QuestObjectiveKind = "reach" | "talk" | "have" | "flag" | "quest";

export interface QuestObjective {
	readonly kind: QuestObjectiveKind;
	readonly target: string;
	readonly quantity?: number;
	readonly done: boolean;
}

export interface Quest {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly objectives: readonly QuestObjective[];
	readonly progress: readonly string[];
	readonly completed: boolean;
	/**
	 * The settlement whose resident gave this out.
	 *
	 * Recorded so an open quest can be marked on the map. A minimap draws one
	 * character per 64-tile chunk, so a town and a building inside it are the same
	 * cell — settlement precision is all the display can show, and it is what the
	 * player actually needs to remember. Absent on quests from before this existed
	 * and on any the engine cannot place.
	 */
	readonly siteId?: number;
	/**
	 * The errand this one is a step of, if any.
	 *
	 * Display only. Nothing gates on it — the gating is a `quest` objective on the
	 * parent, which is real state the engine checks — but the quest pane needs to know
	 * that three open errands are one job with three parts rather than three jobs, or a
	 * branching story reads as an unsorted to-do list.
	 */
	readonly parentId?: string;
}

export interface JournalEntry {
	readonly tick: number;
	readonly kind: "lore" | "place" | "rumor" | "event";
	readonly text: string;
	readonly source?: string;
}

/**
 * Player-caused changes to a chunk.
 *
 * Chunk tile arrays are never saved: the generator reproduces them exactly from
 * the seed. Only what the player changed has to persist, which keeps a heavily
 * explored world down to a few hundred kilobytes.
 */
export interface ChunkDelta {
	/** Flat triples of `[localIndex, terrainId, flags]`. */
	readonly tiles?: readonly number[];
	readonly decor?: readonly number[];
	readonly removedEntities?: readonly string[];
}

export interface DialogueLine {
	readonly speaker: string;
	readonly text: string;
}

/**
 * The dialogue *UI queue*, not the model's conversation history.
 *
 * The old design conflated the two in one array, which is why NPC memory could
 * not outlive a conversation: closing the panel destroyed the history along
 * with it. Model history lives per NPC in `npcs` and is persisted; this is
 * discarded on exit and never written to disk.
 */
export interface DialogueState {
	readonly npcId: string;
	readonly npcName: string;
	readonly lines: readonly DialogueLine[];
	readonly cursor: number;
	readonly choices?: readonly string[];
	readonly choiceIndex: number;
	readonly pending: boolean;
	/**
	 * The reply as far as it has streamed, shown but not yet part of the conversation.
	 *
	 * Deliberately not a `line`: a line is something that was said, and this is a sentence
	 * still being formed. Keeping it separate means nothing downstream of `lines` — the
	 * NPC's memory, the summariser, the cursor the player scrolls — can ever see a
	 * half-finished one, and clearing it needs no bookkeeping because the turn that
	 * commits overwrites it.
	 */
	readonly preview?: string;
}

export interface GameState {
	readonly version: typeof SAVE_VERSION;
	readonly world: WorldMeta;
	readonly player: PlayerState;
	readonly time: WorldTime;
	readonly inventory: readonly InventoryItem[];
	readonly quests: readonly Quest[];
	readonly flags: Readonly<Record<string, string | number | boolean>>;
	/**
	 * Replies a model has already written, so the same moment reads the same way twice.
	 *
	 * Optional, and absent on every save made before it existed — nothing needs migrating,
	 * because an empty cache is indistinguishable from a cold one. See
	 * `dialogue-cache.ts` for what the key is conditioned on and, more importantly, what
	 * it deliberately is not.
	 */
	readonly dialogueCache?: Readonly<Record<string, CachedTurn>>;
	readonly journal: readonly JournalEntry[];
	readonly deltas: Readonly<Record<ChunkKey, ChunkDelta>>;
	readonly discovered: readonly ChunkKey[];
	/**
	 * Authored content, keyed by region id and site id.
	 *
	 * These are the expensive part of the world and the only LLM output worth
	 * persisting: tile arrays are reproduced from the seed for free, but a town's
	 * name and its people cost a model call and must survive a restart. Keyed by
	 * *site*, never by chunk — a town straddling four chunks has one spec, which
	 * is the same reason the settlement patch itself is cached by site.
	 */
	readonly lore?: WorldLore;
	/**
	 * What this world was asked to be about, if anything.
	 *
	 * Persisted so a resumed world keeps generating in the same key. Without it, a
	 * world briefed as a drowned archipelago would name its first few regions
	 * accordingly and then quietly revert to the default premise for every region
	 * discovered after the reload.
	 */
	readonly brief?: ScenarioBrief;
	/**
	 * The flavour tables this world was generated with, as an override on the default.
	 *
	 * Owned by the world for the same reason the brief is: names are derived rather
	 * than stored, so opening a save without the pack that made it would rename
	 * everybody the player has already met while keeping their memories. The override
	 * is stored rather than the merged pack because it is small — the default is
	 * compiled in, so nothing on disk has to still exist to merge against.
	 */
	readonly content?: PackOverride;
	/**
	 * The story this world is telling, for a pre-generated scenario.
	 *
	 * Persisted, unlike the dialogue trees, and the difference is what happens when
	 * the artifact goes missing halfway through a playthrough. A world with no trees
	 * still holds real conversations, because `cannedTurn` is a designed floor. A
	 * world with no arc simply stops having a story, silently, with no way to notice
	 * — so the arc travels with the save and the trees are re-read.
	 */
	readonly arc?: ScenarioArc;
	/**
	 * What this world reacts to, for a pre-generated scenario.
	 *
	 * Persisted for the same reason the arc is, and it is the same failure: a world
	 * with no trees still holds real conversations because `cannedTurn` is a designed
	 * floor, but a world whose triggers went missing stops reacting to anything the
	 * player does, silently, with no way to notice. So they travel with the save.
	 */
	readonly triggers?: readonly Trigger[];
	/**
	 * Gates across the world, and what opens them.
	 *
	 * The definitions travel in the save; *which* have been opened is a flag, like
	 * everything else the player has done. The tile change itself lives in `deltas`,
	 * which is already the home for player-caused changes to a chunk.
	 */
	readonly barriers?: readonly Barrier[];
	/**
	 * Authored items, in the places the story puts them.
	 *
	 * Persisted rather than re-read, because a `have` objective may name one and an
	 * objective whose item stopped existing is an errand that cannot be finished.
	 * Whether each has been taken is the existing `looted:` flag.
	 */
	readonly placements?: readonly Placement[];
	readonly regions: Readonly<Record<string, RegionSpec>>;
	readonly sites: Readonly<Record<string, SiteSpec>>;
	readonly specSources: Readonly<Record<string, SpecSource>>;
	/** Everyone the player has ever spoken to, and what they remember. */
	readonly npcs: Readonly<Record<string, NpcRecord>>;
	/** Standing with each named faction, -100..100. Surfaced into prompts. */
	readonly reputation: Readonly<Record<string, number>>;
	readonly dialogue?: DialogueState;
	/**
	 * One line of feedback for something that just happened — searching a crate,
	 * finding it empty.
	 *
	 * UI-facing and never persisted, like `dialogue`, and cleared by the next
	 * command so it reads as a reaction rather than as status.
	 */
	readonly notice?: string;
	/**
	 * A full screen of prose waiting to be read.
	 *
	 * UI-facing and never persisted, like `dialogue` — but unlike a notice it is not
	 * cleared by the next command, because it is the thing the player is doing. It
	 * blocks movement until dismissed, which is the point: framing that can be walked
	 * out of without being read is framing nobody reads.
	 */
	readonly card?: Card;
	/**
	 * Cards waiting behind the one on screen.
	 *
	 * One turn can raise two: the last beat of a story shows its revelation and the
	 * story then runs out of story, so the ending is raised in the same step. With a
	 * single slot the second silently replaced the first and the revelation was never
	 * read — while its flag said it had been.
	 *
	 * UI-transient like `card` itself. A queue that survived a save would resume into
	 * a stack of screens the player had already dismissed.
	 */
	readonly pendingCards?: readonly Card[];
}

export function createInitialState(
	world: WorldMeta,
	spawn: { x: number; y: number },
	brief?: ScenarioBrief,
	content?: PackOverride,
): GameState {
	return {
		version: SAVE_VERSION,
		world,
		...(brief ? { brief } : {}),
		...(content ? { content } : {}),
		player: { x: spawn.x, y: spawn.y, facing: "down", hp: 20, maxHp: 20 },
		time: timeFromTick(startTick(world.time), world.time),
		inventory: [{ name: "Gold", description: "A handful of coins.", quantity: 12 }],
		quests: [],
		flags: {},
		journal: [],
		deltas: {},
		discovered: [],
		regions: {},
		sites: {},
		specSources: {},
		npcs: {},
		reputation: {},
	};
}

/**
 * The flag recording that the player has stood in a place.
 *
 * One definition, because two would be a silent failure rather than a loud one:
 * `recordArrival` writes this key and a `{ visited }` condition reads it, and a
 * pair that disagreed about case or prefix would produce a gate that never opens
 * with nothing on screen to say why.
 */
export function visitedKey(placeName: string): string {
	return `visited:${placeName.toLowerCase()}`;
}

export function findItem(state: GameState, name: string): InventoryItem | undefined {
	const lower = name.toLowerCase();
	return state.inventory.find((item) => item.name.toLowerCase() === lower);
}

export function itemCount(state: GameState, name: string): number {
	return findItem(state, name)?.quantity ?? 0;
}

export function activeQuests(state: GameState): readonly Quest[] {
	return state.quests.filter((quest) => !quest.completed);
}
