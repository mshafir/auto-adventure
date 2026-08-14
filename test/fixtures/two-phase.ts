import { npcId } from "../../src/core/world/spec.js";
import { ARTIFACT_VERSION, type ScenarioArtifact } from "../../src/scenario/artifact.js";

/**
 * A small, real, two-chapter scenario with a cutscene in it.
 *
 * Built in TypeScript rather than committed as JSON, and the reason is that a committed blob
 * cannot be type-checked: every field here is verified against the artifact's own types at
 * compile time, and the tests write it out with `writeScenarioDir` and read it back — so the
 * round trip is exercised rather than assumed, and the fixture cannot drift out of step with
 * a schema change without the compiler saying so.
 *
 * The world is real. Seed `abbey` (3304608049) puts a village at (39,-31) with room for ten
 * buildings and a hamlet at (86,-29) with room for five, forty-nine tiles apart in the same
 * region — surveyed with `npm run survey -- --seed abbey --duration short`, which is how a
 * scenario is meant to be written: against ground the generator has already decided on.
 *
 * The story: the player begins at Wenthollow, walks east to Ash Hollow, and arriving there
 * plays a cutscene in which a rider brings word that the abbey has fallen. That turns the
 * chapter, and the second chapter changes the world — a body in the millrace that was not
 * there before, the ferryman with nothing left to say about the crossing, and a lane trodden
 * between the two places by everyone who has fled along it.
 */

const SEED = 3304608049;

/** Wenthollow, the village the player starts in. */
const WENTHOLLOW = 4213455557;
/** Ash Hollow, the hamlet east of it. */
const ASH_HOLLOW = 539500626;

const REGION = "3163599116";

export const TWO_PHASE_ID = "two-phase";
export const WENTHOLLOW_ID = WENTHOLLOW;
export const ASH_HOLLOW_ID = ASH_HOLLOW;

/**
 * The npcId the engine derives for a site's slot.
 *
 * Re-exported from the engine rather than spelled out, so a fixture cannot key its
 * conversations to people who do not exist — which is exactly what happened when it was
 * written by hand.
 */
export const npcIdFor = npcId;

export function twoPhaseArtifact(): ScenarioArtifact {
	return {
		artifactVersion: ARTIFACT_VERSION,
		id: TWO_PHASE_ID,
		title: "The Drowned Abbey",
		blurb: "Word comes east along the shore road, and the vale does not stay quiet.",
		brief: {
			title: "The Drowned Abbey",
			premise: "An abbey on the sandflats goes under, and the news travels faster than the water.",
			tone: "sombre",
			duration: "short",
		},
		seed: SEED,
		// Inside Wenthollow rather than at the surveyed spawn sixty tiles south, so a walkthrough
		// starts where the story does. Passability is checked by the loader, not asserted here.
		spawn: { x: 39, y: -31 },
		bounds: { minX: -194, minY: -205, maxX: 280, maxY: 269, style: "cliffs", thickness: 8 },
		lore: {
			title: "The Sandflat Shore",
			premise: "A coast of shallow water and long tides, where the sea comes in over the fields.",
			era: "late mediaeval",
			tone: "sombre",
			factions: ["The Abbey of Saint Ceol", "The Wenthollow Ferry"],
			deities: ["Saint Ceol, who walked out on the water"],
		},
		regions: {
			[REGION]: {
				id: REGION,
				name: "The Sandflats",
				blurb: "Grassland running down to a shore that is neither land nor sea.",
				tone: "sombre",
				culture: "fishers and ferrymen, and the abbey that taxes both",
				factionName: "The Abbey of Saint Ceol",
				lore: [
					"The abbey stands on a spit that the tide cuts off twice a day.",
					"Wenthollow keeps the only ferry, and the abbey keeps the tolls.",
				],
				ambient: ["Gulls somewhere out over the flats.", "The smell of weed and wet rope."],
			},
		},
		sites: {
			[String(WENTHOLLOW)]: {
				siteId: WENTHOLLOW,
				name: "Wenthollow",
				shortName: "Wenthollow",
				description: "A ferry village of ten roofs, its jetty longer than its high street.",
				settlement: {
					name: "Wenthollow",
					walled: false,
					structures: [
						{ kind: "inn", size: "medium", importance: 4, name: "The Long Tide", required: true },
						{
							kind: "mill",
							size: "medium",
							importance: 3,
							name: "Wenthollow Mill",
							required: true,
						},
						{ kind: "warehouse", size: "small", importance: 2, name: "The Rope Store" },
						{ kind: "house", size: "small", importance: 1 },
						{ kind: "house", size: "small", importance: 1 },
					],
				},
				npcs: [
					{
						slot: 0,
						name: "Ilse Wentworth",
						role: "ferryman",
						glyph: "I",
						appearance: "A short woman in a tarred coat, hands like knotted rope.",
						persona:
							"Blunt, and not unkind about it. Talks about tides the way others talk about weather.",
						disposition: 10,
						placement: "square",
						knows: ["The crossing is only safe either side of the turn of the tide."],
						stays: true,
					},
					{
						slot: 1,
						name: "Bran Cawle",
						role: "miller",
						glyph: "B",
						appearance: "Flour to the elbows, and a limp he does not explain.",
						persona: "Talks a great deal, mostly about the millrace.",
						disposition: 0,
						placement: "doorstep",
						structureName: "Wenthollow Mill",
						knows: ["The millrace runs fast after rain and catches whatever the river brings."],
						stays: true,
					},
				],
				hooks: ["The ferry has not run since the abbey bell stopped."],
			},
			[String(ASH_HOLLOW)]: {
				siteId: ASH_HOLLOW,
				name: "Ash Hollow",
				shortName: "Ash Hollow",
				description: "Five houses in a dip of the woods, and a well nobody trusts.",
				settlement: {
					name: "Ash Hollow",
					walled: false,
					structures: [
						{
							kind: "shrine",
							size: "small",
							importance: 4,
							name: "The Ash Shrine",
							required: true,
						},
						{ kind: "house", size: "small", importance: 1 },
						{ kind: "house", size: "small", importance: 1 },
					],
				},
				npcs: [
					{
						slot: 0,
						name: "Rell Ashcombe",
						role: "shrine-keeper",
						glyph: "R",
						appearance: "Grey, and dressed for a colder season than this one.",
						persona: "Careful with words. Waits to be asked twice.",
						disposition: 0,
						placement: "well",
						knows: ["The shrine was raised for people the sea kept."],
						stays: true,
					},
				],
				hooks: ["Nobody here goes down to the shore any more."],
			},
		},
		arc: {
			title: "The Drowned Abbey",
			premise: "The abbey goes under, and Wenthollow has to decide whether the ferry still runs.",
			beats: [
				{
					id: "ask-the-ferryman",
					order: 1,
					siteId: WENTHOLLOW,
					npcSlot: 0,
					requires: [],
					setsFlag: "beat:asked-ilse",
					journal:
						"Ilse says the abbey bell has not rung for two days. Go east to Ash Hollow and ask Rell.",
				},
			],
		},
		triggers: [
			{
				id: "the-messenger-arrives",
				// Fires on reaching Ash Hollow, having first spoken to Ilse — so the cutscene cannot
				// happen before the errand that explains it.
				when: { all: [{ visited: "Ash Hollow" }, { flag: "beat:asked-ilse" }] },
				effects: [{ t: "PlayScene", id: "the-messenger-arrives" }],
			},
		],
		scenes: {
			"the-messenger-arrives": {
				id: "the-messenger-arrives",
				// The keeper already lives here and is standing at the well all day, so she needs no
				// `Spawn` — staging starts a cast member wherever the world has them. The rider is
				// genuinely not in the world and has to be put on stage.
				cast: { keeper: npcIdFor(ASH_HOLLOW, 0) },
				steps: [
					{
						do: [
							{
								t: "Camera",
								to: { kind: "anchor", siteId: ASH_HOLLOW, anchor: "well" },
								pan: "slow",
							},
							// A world tile rather than an anchor, because Ash Hollow has four gates and
							// "the first one" is not a thing an author means. This is the western gate, on
							// the road from Wenthollow, which is the direction the news comes from.
							{ t: "Spawn", actor: "rider", at: { kind: "world", x: 61, y: -24 } },
							{ t: "Face", actor: "keeper", at: "left" },
						],
						hold: 3,
					},
					{
						do: [
							{
								t: "WalkTo",
								actor: "rider",
								to: { kind: "anchor", siteId: ASH_HOLLOW, anchor: "well" },
								speed: "fast",
							},
						],
					},
					{ do: [{ t: "Say", actor: "rider", text: "The bell has stopped. The abbey is under." }] },
					{
						do: [
							{
								t: "Card",
								card: {
									id: "chapter-two",
									title: "After the Flood",
									subtitle: "The second day",
									sections: [
										{
											heading: "What the tide left",
											body: "By morning the shore road is full of people walking inland, and the millrace at Wenthollow is running with things that were not in it yesterday.",
										},
									],
								},
							},
						],
					},
					{
						// Last step, so the non-idempotent grant is allowed here and nowhere earlier — an
						// interrupted scene replays, and a ledger handed out twice is a ledger handed out
						// twice. The hold keeps the final frame on screen long enough to be seen, which
						// a scene's last step does not otherwise get.
						do: [
							{
								t: "Effects",
								effects: [
									{ t: "SetFlag", key: "flood", value: true },
									{
										t: "GrantItem",
										name: "Abbey Ledger",
										description: "Water-swollen, and the ink has run in the margins.",
										quantity: 1,
									},
								],
							},
						],
						hold: 3,
					},
				],
			},
		},
		terraform: [
			{
				t: "Path",
				id: "the-shore-road",
				// Wenthollow to Ash Hollow. The generator gave both places roads; this is the
				// footpath between them that the story needs and the road network did not provide.
				from: { x: 45, y: -31 },
				to: { x: 80, y: -29 },
				surface: "path",
			},
		],
		phases: [
			{
				id: "after-the-flood",
				name: "After the Flood",
				when: { flag: "flood" },
				placements: {
					add: [
						{
							id: "the-body-in-the-millrace",
							at: { kind: "site", siteId: WENTHOLLOW, structure: "Wenthollow Mill" },
							item: {
								name: "Abbey Seal",
								description:
									"A lead seal on a broken cord, still bright where the cord protected it.",
							},
							showDecor: true,
							emptyText: "Only weed, and the water going over.",
						},
					],
				},
				terraform: {
					add: [
						{
							t: "Path",
							id: "the-trodden-verge",
							// Widened by everyone who fled along it. Laid over the same line as the
							// footpath, so the later edit wins where they overlap.
							from: { x: 45, y: -31 },
							to: { x: 80, y: -29 },
							width: 3,
							surface: "dirt",
						},
					],
				},
				trees: {
					// The ferryman has nothing left to say about the crossing, because there is
					// nothing left to cross to.
					[npcIdFor(WENTHOLLOW, 0)]: null,
				},
			},
		],
		trees: {
			[npcIdFor(WENTHOLLOW, 0)]: {
				npcId: npcIdFor(WENTHOLLOW, 0),
				entry: ["opening"],
				nodes: {
					opening: {
						id: "opening",
						speech:
							"Ferry's not running. Bell's not rung for two days and I'll not cross to a silent abbey.",
						choices: [
							{ text: "What do you think has happened?", goto: "guess" },
							{ text: "Fair enough.", goto: null },
						],
					},
					guess: {
						id: "guess",
						speech:
							"I think the tide came in and did not go out. Ask Rell at Ash Hollow — they watch the shore.",
						choices: [{ text: "I'll go east.", goto: null }],
						// The flat, all-nullable action shape is a structured-output workaround for
						// providers that cannot express a union, and authored trees share it so that
						// one runtime reads both.
						actions: [
							{
								kind: "setFlag",
								key: "beat:asked-ilse",
								value: "true",
								item: null,
								description: null,
								quantity: null,
								questId: null,
								questName: null,
								note: null,
								objectives: null,
							},
						],
					},
				},
			},
			[npcIdFor(ASH_HOLLOW, 0)]: {
				npcId: npcIdFor(ASH_HOLLOW, 0),
				entry: ["opening"],
				nodes: {
					opening: {
						id: "opening",
						speech: "You have come from the water. I can smell it on you.",
						choices: [{ text: "I have.", goto: null }],
					},
				},
			},
		},
		authoredWith: { models: {}, calls: 0, at: "2026-08-14T00:00:00.000Z" },
	};
}
