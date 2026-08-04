import { type RGB, rgb } from "./color.js";

/**
 * One palette for the whole game so that terrain, decor and entities read as a
 * single world rather than a pile of independently-chosen colours. Names are
 * material-first ("moss", "bark") rather than role-first ("grassColor") so the
 * same swatch can be reused wherever that material appears.
 */
export const PAL = {
	// water
	abyss: rgb("#0d2d5c"),
	deep: rgb("#2f6fb5"),
	shallow: rgb("#1d4f85"),
	foam: rgb("#7fc3e8"),
	ice: rgb("#c8dbe6"),
	iceDark: rgb("#7f97a6"),

	// earth
	sand: rgb("#e0cf9a"),
	sandDark: rgb("#b89e63"),
	loam: rgb("#4a3a28"),
	dirt: rgb("#6b5b43"),
	dirtDark: rgb("#4a3f2f"),
	mud: rgb("#3d3325"),
	gravel: rgb("#8c857a"),
	gravelDark: rgb("#4f4a43"),

	// plants
	moss: rgb("#5fb04a"),
	mossDark: rgb("#2f5f28"),
	leaf: rgb("#3f8f33"),
	leafDark: rgb("#274d21"),
	pine: rgb("#1b6b2f"),
	pineDark: rgb("#143f1c"),
	oak: rgb("#2f8a3a"),
	oakDark: rgb("#1a4a20"),
	reed: rgb("#7f8f4a"),
	reedDark: rgb("#3f4524"),
	wheat: rgb("#d6b95c"),
	wheatDark: rgb("#6b5a2a"),

	// stone
	stone: rgb("#b7b0a6"),
	stoneDark: rgb("#3c3936"),
	slate: rgb("#8a8378"),
	slateDark: rgb("#4a453f"),
	snow: rgb("#ffffff"),
	snowShadow: rgb("#c8d4de"),

	// built
	timber: rgb("#a97f4d"),
	timberDark: rgb("#4a3520"),
	plank: rgb("#c49a63"),
	plankDark: rgb("#5c4526"),
	tile: rgb("#8a4c3a"),
	tileDark: rgb("#5c3225"),
	cobble: rgb("#9a938a"),
	cobbleDark: rgb("#5f5a53"),
	brass: rgb("#d9a441"),
	lamplight: rgb("#e8c96a"),
	glass: rgb("#cfe6f5"),
	soot: rgb("#2a1f14"),
	ash: rgb("#2a2620"),
	bone: rgb("#e8e2d6"),

	// accents
	blood: rgb("#b23a3a"),
	bloom: [rgb("#e8695c"), rgb("#e8c15c"), rgb("#d98ce0"), rgb("#eaeaea"), rgb("#7fb0e8")] as RGB[],
	player: rgb("#7fff6a"),
	friendly: rgb("#8fd6ff"),
	neutral: rgb("#e8e2d6"),
	wary: rgb("#e8c96a"),
	hostile: rgb("#ff7b6a"),
} as const;
