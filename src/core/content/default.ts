import { DEFAULT_GOODS } from "./goods.js";
import type { ContentPack } from "./pack.js";

/**
 * The pack every world starts from.
 *
 * Held as code rather than read from disk, so the pure generators always have a
 * complete set of tables with no filesystem in the path — `core` must stay callable
 * from a test, a validator and a browser alike. `.packs/default.json` is the
 * same data as a file, for authors to copy from, and a test pins the two together so
 * they cannot drift.
 *
 * These are the tables that used to live in `names.ts`, `fallback.ts` and
 * `residents.ts`. Moving them here changed nothing about the world they generate.
 */
export const DEFAULT_PACK: ContentPack = {
	id: "default",
	description:
		"Temperate smallholding country: coopers, reeves and road-traders, and a market every place is a day from.",
	names: {
		given: [
			"Alder",
			"Bryn",
			"Cass",
			"Doryn",
			"Elke",
			"Fenn",
			"Garrow",
			"Hale",
			"Isa",
			"Joral",
			"Kest",
			"Lune",
			"Marrow",
			"Nessa",
			"Orrin",
			"Pell",
			"Quill",
			"Rhoswen",
			"Sable",
			"Tam",
			"Ulric",
			"Vess",
			"Wren",
			"Yarrow",
		],
		family: [
			"Ashdown",
			"Barrowmoor",
			"Coldwick",
			"Dunmere",
			"Emberly",
			"Fallowend",
			"Grimsby",
			"Harrowgate",
			"Larkspur",
			"Marchbank",
			"Netherfield",
			"Oakhame",
			"Quillon",
			"Ridderhelm",
			"Stonecarve",
			"Thistlewood",
		],
		heads: {
			wet: ["mire", "fen", "marl", "sedge", "bog", "reed", "silt", "drift"],
			green: ["thorn", "brack", "elder", "haw", "brier", "wold", "bram", "willow"],
			cold: ["frost", "cold", "rime", "hoar", "snow", "bleak", "grim", "north"],
			dry: ["ash", "dust", "scald", "kiln", "ember", "sun", "barren", "salt"],
			high: ["crag", "stone", "scar", "tor", "iron", "grey", "cliff", "pike"],
			plain: ["hart", "oak", "wheat", "gold", "long", "fair", "bell", "mill"],
		},
		tails: [
			"ford",
			"hollow",
			"reach",
			"barrow",
			"gate",
			"mere",
			"stead",
			"combe",
			"march",
			"row",
			"wick",
			"holt",
			"crest",
			"bridge",
		],
		ruinTails: ["barrow", "cairn", "wrack", "ruin", "hush", "remnant"],
		fortTails: ["keep", "watch", "hold", "bastion", "gate", "ward"],
		regionTails: ["moor", "wold", "reach", "vale", "expanse", "marches", "downs", "waste"],
	},
	// Counts are about what makes a room worth entering rather than realism: a
	// barracks with one soldier in it is a disappointment, and a warehouse with a
	// family in it is a puzzle.
	households: {
		inn: { count: [2, 4], roles: ["cook", "server", "drover", "traveller", "harpist"] },
		shop: { count: [1, 2], roles: ["shopkeeper", "porter"] },
		apothecary: { count: [1, 2], roles: ["herbalist", "apprentice"] },
		smithy: { count: [1, 2], roles: ["striker", "apprentice"] },
		temple: { count: [1, 3], roles: ["priest", "acolyte", "mourner"] },
		shrine: { count: [0, 1], roles: ["caretaker"] },
		hall: { count: [1, 3], roles: ["reeve", "server", "harpist", "old resident"] },
		barracks: { count: [2, 4], roles: ["soldier", "sergeant", "recruit", "cook"] },
		mill: { count: [1, 2], roles: ["miller", "carter"] },
		stable: { count: [1, 2], roles: ["groom", "farrier"] },
		warehouse: { count: [0, 2], roles: ["tallyman", "porter"] },
		barn: { count: [0, 1], roles: ["farmhand"] },
		tower: { count: [1, 2], roles: ["watchman", "signaller"] },
		ruin: { count: [0, 0], roles: [] },
		// A hole in a hillside is not somewhere a household lives. Said out loud because
		// the fall-back for an unlisted kind is `house`, and without this the Green Chapel
		// — a mound the story calls the least inhabited place in the world — was generating
		// a weaver and a cooper inside it.
		cave: { count: [0, 0], roles: [] },
		house: {
			count: [1, 3],
			roles: ["weaver", "cooper", "carpenter", "widow", "child", "labourer", "brewer", "netmaker"],
		},
	},
	// One telling detail per trade, written out rather than templated. The first
	// draft generated these and gave nearly everybody "at work on something that does
	// not stop for visitors" — a town of thirty people saying one sentence is worse
	// than a town of nobody. This is the line the examine verb prints, so it is read
	// more often than any dialogue in the game.
	appearance: {
		weaver: "Sat at the loom, and not stopping it for you.",
		cooper: "Hands pale with shavings, a half-hooped barrel between the knees.",
		carpenter: "A pencil behind one ear and sawdust in the crease of both sleeves.",
		widow: "Neat, grey, and entirely composed. Black worn past the point of mourning.",
		child: "Small, unbothered, and entirely unsurprised to see you.",
		labourer: "Big hands, borrowed boots, asleep in the chair until you came in.",
		brewer: "Sleeves rolled past the elbow, forearms scalded pink.",
		netmaker: "Knotting by feel, watching you instead of the work.",
		cook: "Flour to the wrist, and a knife they have not put down.",
		server: "Carrying four things and looking for somewhere to put two of them.",
		drover: "Smells of the road and of somebody else's cattle.",
		traveller: "Boots by the fire, coat still on, ready to be somewhere else.",
		harpist: "Tuning something that will not stay tuned in this weather.",
		shopkeeper: "Counting the shelf again, having lost the count once already.",
		porter: "Waiting to be told which of two crates goes first.",
		herbalist: "Sorting cuttings into piles that look identical to you.",
		apprentice: "Young, watchful, and plainly not supposed to be talking to you.",
		striker: "Shoulders like a door, deaf on the side nearest the anvil.",
		priest: "Unhurried in the way of somebody whose day has no appointments in it.",
		acolyte: "Trimming lamps, and glad of the interruption.",
		mourner: "Sat where the light is worst, and not looking up.",
		soldier: "Off duty, boots off, belt hung on the bedpost.",
		sergeant: "Awake, dressed, and unimpressed by the door opening.",
		recruit: "Standing straighter than anyone else in the room.",
		miller: "White to the eyebrows, shouting a little out of habit.",
		carter: "One boot up on a sack, resting a leg that has been walked on all day.",
		groom: "Talking to a horse in the voice most people save for children.",
		farrier: "Apron scorched through in three places, hands black to the wrist.",
		tallyman: "A slate, a stub of chalk, and a very poor opinion of your timing.",
		farmhand: "Up to the shins in straw, and glad of a reason to stand still.",
		watchman: "Awake at the wrong end of the day, and making sure you know it.",
		signaller: "One eye on the window the whole time.",
		caretaker: "Sweeping something that does not need it, slowly.",
		reeve: "At the head of the table with the tally in front of them, unread.",
	},
	talksAbout: {
		child: "the dog, the roof, and whatever you are carrying",
		widow: "who has died, who has left, and who is pretending not to have",
		soldier: "the watch, the food, and the officers",
		sergeant: "the watch, and what the watch is for",
		traveller: "the road behind them and the price of a bed",
		drover: "prices at the last three markets",
		priest: "the season, the dead, and the collection",
		tallyman: "what came in, what went out, and the difference",
		miller: "the grain, the water, and whoever is late",
		shopkeeper: "stock, and what nobody will buy",
		reeve: "who owes what, and how long they have owed it",
	},
	outdoorRoles: {
		shop: { role: "shopkeeper", placement: "doorstep" },
		inn: { role: "innkeeper", placement: "doorstep" },
		smithy: { role: "blacksmith", placement: "doorstep" },
		temple: { role: "priest", placement: "doorstep" },
		apothecary: { role: "apothecary", placement: "doorstep" },
		barracks: { role: "guard", placement: "gate" },
		stable: { role: "stablehand", placement: "yard" },
		mill: { role: "miller", placement: "yard" },
		farmhouse: { role: "farmer", placement: "yard" },
		warehouse: { role: "factor", placement: "yard" },
		hall: { role: "reeve", placement: "doorstep" },
	},
	wanderers: [
		{ role: "carter", placement: "well" },
		{ role: "herbalist", placement: "stall" },
		{ role: "old resident", placement: "bench" },
		{ role: "messenger", placement: "gate" },
	],
	lore: {
		title: "The Long Weather",
		premise:
			"The old roads still run between the holdfasts, though fewer people walk them each year. " +
			"Something in the weather has turned, and the villages have begun keeping their own counsel.",
		era: "the late years of a long decline",
		tone: "weatherbeaten and plainspoken",
		factions: ["the Roadwardens", "the Hollow Assembly", "the Salt Factors"],
		deities: ["the Patient Sister", "Ord of the Nine Gates"],
	},
	ambient: [
		"The wind moves across the country.",
		"Somewhere behind you, a bird you cannot name calls twice and stops.",
		"The road here is older than anything built beside it.",
	],
	goods: DEFAULT_GOODS,
};
