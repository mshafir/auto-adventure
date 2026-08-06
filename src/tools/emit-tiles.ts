/**
 * Draw the `gramarye` tile pack's atlas.
 *
 * ```
 * npm run tiles:emit
 * ```
 *
 * The atlas is committed art, and committed art nobody can regenerate is committed art
 * nobody can change. Drawing it in code costs a few hundred lines and buys the ability
 * to shift the whole pack half a shade colder by editing one constant — which is what
 * actually happens to a tile set — and it keeps the repository free of binaries whose
 * provenance is a shrug.
 *
 * Sixteen cells in a 4x4 grid at 16px. Everything that reads as *ground* is opaque;
 * everything that sits *on* ground — chest, boat, banner, shrine — has an alpha
 * cut-out, because a decor tile without one is a decor tile with a rectangle of
 * background painted round it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tilePackRoot } from "../content/tiles.js";
import { encodePng } from "../ui/render/png.js";

const TILE = 16;
const COLS = 4;
const ROWS = 4;
const W = TILE * COLS;
const H = TILE * ROWS;

type RGBA = readonly [number, number, number, number];

const hex = (value: string, alpha = 255): RGBA => [
	Number.parseInt(value.slice(1, 3), 16),
	Number.parseInt(value.slice(3, 5), 16),
	Number.parseInt(value.slice(5, 7), 16),
	alpha,
];

/** The pack's own swatches, so the atlas cannot drift from `tiles.json`. */
const C = {
	clear: [0, 0, 0, 0] as RGBA,
	tile: hex("#7d4132"),
	tileDark: hex("#4a2820"),
	tileLit: hex("#96513e"),
	// Brown, and deliberately: the road and the curtain wall were both pale grey
	// blocks laid in offset courses, and at tile size that is the same picture twice.
	// Colour separates them at a glance in a way no amount of redrawing does.
	cobble: hex("#8a7d68"),
	cobbleDark: hex("#453b2d"),
	cobbleLit: hex("#9d9078"),
	cobbleShade: hex("#6a6050"),
	stone: hex("#c2bcae"),
	stoneMid: hex("#9a9384"),
	stoneDark: hex("#3a372f"),
	slate: hex("#8d8477"),
	slateDark: hex("#4a453c"),
	timber: hex("#9a7647"),
	timberDark: hex("#46331d"),
	plank: hex("#bd9a63"),
	plankDark: hex("#5a4527"),
	iron: hex("#6b6459"),
	brass: hex("#d8a63c"),
	lamplight: hex("#f0d27a"),
	glass: hex("#cfe0ea"),
	soot: hex("#221a12"),
	pitch: hex("#0e0b08"),
	shallow: hex("#43708c"),
	deep: hex("#2c4a63"),
	foam: hex("#cfe4ea"),
	blood: hex("#a83232"),
	bone: hex("#efe7d3"),
	gold: hex("#e8c34a"),
	pine: hex("#33604a"),
};

const pixels = Buffer.alloc(W * H * 4);

function put(x: number, y: number, colour: RGBA): void {
	if (x < 0 || y < 0 || x >= W || y >= H) return;
	const at = (y * W + x) * 4;
	pixels[at] = colour[0] as number;
	pixels[at + 1] = colour[1] as number;
	pixels[at + 2] = colour[2] as number;
	pixels[at + 3] = colour[3] as number;
}

/** A deterministic dither, so the same tile is drawn the same way every run. */
function noise(x: number, y: number): number {
	const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
	return h - Math.floor(h);
}

/** Draw one cell, with cell-local coordinates. */
function cell(
	col: number,
	row: number,
	draw: (put: (x: number, y: number, c: RGBA) => void) => void,
) {
	draw((x, y, colour) => put(col * TILE + x, row * TILE + y, colour));
}

function fill(
	at: (x: number, y: number, c: RGBA) => void,
	colour: RGBA,
	pick?: (x: number, y: number) => RGBA | undefined,
) {
	for (let y = 0; y < TILE; y++) {
		for (let x = 0; x < TILE; x++) at(x, y, pick?.(x, y) ?? colour);
	}
}

function rect(
	at: (x: number, y: number, c: RGBA) => void,
	x0: number,
	y0: number,
	w: number,
	h: number,
	colour: RGBA,
) {
	for (let y = y0; y < y0 + h; y++) {
		for (let x = x0; x < x0 + w; x++) at(x, y, colour);
	}
}

// --- (0,0) roof: shingles, laid in courses ----------------------------------
cell(0, 0, (at) => {
	fill(at, C.tileDark);
	for (let y = 0; y < TILE; y++) {
		const course = Math.floor(y / 4);
		const offset = (course % 2) * 2;
		for (let x = 0; x < TILE; x++) {
			const inCourse = y % 4;
			const seam = (x + offset) % 4 === 0;
			if (inCourse === 3 || seam) at(x, y, C.tileDark);
			else at(x, y, inCourse === 0 ? C.tileLit : C.tile);
		}
	}
});

// --- (1,0) cobbles ----------------------------------------------------------
// Setts, not blocks. Small, round-shouldered, each one its own shade, bedded in mud
// that shows between them — everything the wall above is not.
cell(1, 0, (at) => {
	fill(at, C.cobbleDark);
	for (let cy = 0; cy < 5; cy++) {
		for (let cx = 0; cx < 5; cx++) {
			const ox = cx * 3 + (cy % 2) + 1;
			const oy = cy * 3 + 1;
			const roll = noise(cx * 2 + 1, cy * 3 + 2);
			const shade = roll > 0.66 ? C.cobbleLit : roll > 0.3 ? C.cobble : C.cobbleShade;
			// A 3x2 sett with its corners knocked off, so the outline reads as round.
			rect(at, ox, oy, 3, 2, shade);
			at(ox, oy, C.cobbleDark);
			at(ox + 2, oy + 1, C.cobbleDark);
		}
	}
});

// --- (2,0) ashlar wall ------------------------------------------------------
// Big dressed blocks, a bright edge along the top of each course and a hard shadow
// under it. That top-lit banding is what says "this is standing up in front of you"
// rather than "this is the ground you are walking on".
cell(2, 0, (at) => {
	fill(at, C.stoneDark);
	for (let course = 0; course < 4; course++) {
		const offset = (course % 2) * 4;
		for (let y = 0; y < 3; y++) {
			for (let x = 0; x < TILE; x++) {
				const joint = (x + offset) % 8 === 0;
				if (joint) continue;
				const face = y === 0 ? C.stone : y === 1 ? C.stoneMid : C.slateDark;
				at(x, course * 4 + y, face);
			}
		}
	}
});

// --- (3,0) barred gate ------------------------------------------------------
cell(3, 0, (at) => {
	fill(at, C.pitch);
	rect(at, 0, 0, TILE, 2, C.stoneDark);
	for (const x of [2, 6, 10, 13]) rect(at, x, 2, 2, TILE - 2, C.iron);
	for (const y of [5, 11]) rect(at, 0, y, TILE, 1, C.iron);
	for (const x of [2, 6, 10, 13]) {
		at(x, 5, C.brass);
		at(x, 11, C.brass);
	}
});

// --- (0,1) open gate: an arch with the dark beyond it ------------------------
cell(0, 1, (at) => {
	fill(at, C.stoneDark);
	for (let y = 0; y < TILE; y++) {
		for (let x = 0; x < TILE; x++) {
			const dx = x - 7.5;
			const arch = y > 4 || dx * dx + (y - 5) * (y - 5) * 2.2 < 30;
			if (arch && x > 2 && x < 13) at(x, y, y > 12 ? C.soot : C.pitch);
			else at(x, y, y % 4 === 3 ? C.stoneDark : C.stoneMid);
		}
	}
});

// --- (1,1) planked door with an iron strap ----------------------------------
cell(1, 1, (at) => {
	fill(at, C.timberDark);
	rect(at, 1, 0, 14, TILE, C.timber);
	for (const x of [4, 8, 12]) rect(at, x, 0, 1, TILE, C.timberDark);
	rect(at, 1, 3, 14, 1, C.iron);
	rect(at, 1, 11, 14, 1, C.iron);
	rect(at, 11, 7, 2, 2, C.brass);
});

// --- (2,1) open doorway -----------------------------------------------------
cell(2, 1, (at) => {
	fill(at, C.timberDark);
	rect(at, 0, 0, 3, TILE, C.timber);
	rect(at, 3, 0, 11, TILE, C.soot);
	rect(at, 3, 0, 1, TILE, C.timberDark);
	rect(at, 14, 0, 2, TILE, C.timber);
	rect(at, 5, 6, 4, 3, C.lamplight);
});

// --- (3,1) leaded window ----------------------------------------------------
cell(3, 1, (at) => {
	fill(at, C.timberDark);
	rect(at, 2, 2, 12, 12, C.glass);
	for (const x of [5, 8, 11]) rect(at, x, 2, 1, 12, C.iron);
	for (const y of [5, 8, 11]) rect(at, 2, y, 12, 1, C.iron);
	rect(at, 6, 9, 2, 2, C.lamplight);
});

// --- (0,2) cave mouth: a split in the rock ----------------------------------
cell(0, 2, (at) => {
	fill(at, C.slateDark, (x, y) => (noise(x, y) > 0.7 ? C.slate : undefined));
	for (let y = 2; y < TILE; y++) {
		const half = Math.min(6, Math.round((y - 1) * 0.7 + noise(0, y) * 1.4));
		for (let x = 8 - half; x <= 7 + half; x++) at(x, y, y > 12 ? C.soot : C.pitch);
	}
});

// --- (1,2) pier: planks with water between ----------------------------------
cell(1, 2, (at) => {
	fill(at, C.deep, (x, y) => (noise(x, y * 0.2) > 0.8 ? C.shallow : undefined));
	for (let y = 0; y < TILE; y++) {
		if (y % 5 === 4) continue;
		for (let x = 0; x < TILE; x++) at(x, y, y % 5 === 3 ? C.plankDark : C.plank);
	}
	for (const x of [3, 11]) rect(at, x, 0, 1, TILE, C.plankDark);
});

// --- (2,2) deck -------------------------------------------------------------
cell(2, 2, (at) => {
	fill(at, C.plankDark);
	for (let y = 0; y < TILE; y++) {
		for (let x = 0; x < TILE; x++) {
			if (x % 6 === 5) continue;
			at(x, y, noise(x * 0.3, y) > 0.75 ? C.plankDark : C.plank);
		}
	}
	rect(at, 0, 7, TILE, 1, C.pitch);
});

// --- (3,2) flagstones -------------------------------------------------------
cell(3, 2, (at) => {
	fill(at, C.slateDark);
	for (let cy = 0; cy < 2; cy++) {
		for (let cx = 0; cx < 2; cx++) {
			const shade = noise(cx + 3, cy + 7) > 0.5 ? C.stoneMid : C.slate;
			rect(at, cx * 8 + 1, cy * 8 + 1, 6, 6, shade);
		}
	}
});

// --- (0,3) chest ------------------------------------------------------------
cell(0, 3, (at) => {
	fill(at, C.clear);
	rect(at, 2, 5, 12, 8, C.timber);
	rect(at, 2, 5, 12, 2, C.timberDark);
	rect(at, 2, 12, 12, 1, C.pitch);
	for (const x of [4, 11]) rect(at, x, 5, 1, 8, C.iron);
	rect(at, 7, 8, 2, 3, C.brass);
	rect(at, 3, 4, 10, 1, C.timberDark);
});

// --- (1,3) boat -------------------------------------------------------------
cell(1, 3, (at) => {
	fill(at, C.clear);
	for (let y = 6; y < 13; y++) {
		const inset = Math.max(0, y - 9);
		for (let x = 1 + inset; x < 15 - inset; x++) {
			at(x, y, y === 6 ? C.plank : y > 10 ? C.timberDark : C.timber);
		}
	}
	rect(at, 7, 1, 1, 6, C.plankDark);
	rect(at, 8, 2, 4, 4, C.bone);
});

// --- (2,3) banner -----------------------------------------------------------
cell(2, 3, (at) => {
	fill(at, C.clear);
	rect(at, 7, 0, 2, TILE, C.timberDark);
	for (let y = 2; y < 13; y++) {
		const tail = y > 10 ? y - 10 : 0;
		for (let x = 9; x < 15 - tail; x++) at(x, y, y % 4 === 0 ? C.blood : C.blood);
	}
	rect(at, 10, 5, 3, 3, C.gold);
	rect(at, 11, 4, 1, 5, C.blood);
});

// --- (3,3) wayside shrine ---------------------------------------------------
cell(3, 3, (at) => {
	fill(at, C.clear);
	rect(at, 3, 12, 10, 3, C.slate);
	rect(at, 3, 14, 10, 1, C.slateDark);
	rect(at, 7, 2, 2, 10, C.bone);
	rect(at, 4, 5, 8, 2, C.bone);
	rect(at, 7, 0, 2, 2, C.gold);
	at(6, 9, C.pine);
	at(9, 9, C.pine);
});

const directory = join(tilePackRoot(), "gramarye");
mkdirSync(directory, { recursive: true });
const path = join(directory, "atlas.png");
writeFileSync(path, encodePng(W, H, pixels, 4));
process.stdout.write(`wrote ${path} (${W}x${H}, ${COLS * ROWS} cells at ${TILE}px)\n`);
