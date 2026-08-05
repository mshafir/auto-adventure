/**
 * Prove the kitty graphics path works in this terminal, before anything is
 * built on top of it.
 *
 * The test pattern is chosen so that every way it can go wrong looks different:
 * four differently-coloured quadrants catch a scrambled placement, a white
 * diagonal catches rows or columns being transposed, and a one-pixel border
 * catches the image being scaled into the wrong cell rectangle. A pattern that
 * is merely "colourful" would look fine while being completely wrong.
 *
 *   vite-node src/tools/kitty-check.ts --
 *   vite-node src/tools/kitty-check.ts -- --explicit
 */
import {
	deleteFrame,
	detectKittyGraphics,
	graphicsBlockedByMultiplexer,
	placeholderRows,
	transmitFrame,
} from "../ui/render/kitty.js";

const ESC = "\u001B";

function parseArgs(argv: readonly string[]) {
	const args = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const match = /^--([^=]+)(?:=(.*))?$/.exec(argv[i] ?? "");
		if (!match?.[1]) continue;
		if (match[2] !== undefined) {
			args.set(match[1], match[2]);
			continue;
		}
		const next = argv[i + 1];
		if (next !== undefined && !next.startsWith("--")) {
			args.set(match[1], next);
			i++;
		} else {
			args.set(match[1], "true");
		}
	}
	return args;
}

/**
 * Four quadrants, a diagonal and a border. See the note at the top of the file.
 *
 * `noisy` dithers every pixel by a few levels. That is not decoration: a flat
 * pattern deflates to well under one 4096-byte chunk, so the obvious version of
 * this test silently never exercises chunked transmission — while a real map
 * frame is 30KB and needs eight chunks or more. The dither is small enough to
 * leave the quadrants perfectly readable and large enough to defeat deflate.
 */
function testPattern(width: number, height: number, noisy: boolean): Buffer {
	const rgb = Buffer.alloc(width * height * 3);
	let seed = 2463534242;
	const jitter = () => {
		seed ^= seed << 13;
		seed ^= seed >>> 17;
		seed ^= seed << 5;
		return (seed & 7) - 3;
	};
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const left = x < width / 2;
			const top = y < height / 2;
			let c: [number, number, number] = top
				? left
					? [220, 40, 40] // red
					: [40, 200, 40] // green
				: left
					? [60, 90, 230] // blue
					: [230, 200, 40]; // yellow

			// The diagonal runs corner to corner, so a transposition shows up as a
			// mirrored line rather than as nothing at all.
			if (Math.abs(x / width - y / height) < 0.01) c = [255, 255, 255];
			const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
			if (edge) c = [20, 20, 20];

			const i = (y * width + x) * 3;
			const n = noisy ? jitter() : 0;
			rgb[i] = Math.max(0, Math.min(255, c[0] + n));
			rgb[i + 1] = Math.max(0, Math.min(255, c[1] + n));
			rgb[i + 2] = Math.max(0, Math.min(255, c[2] + n));
		}
	}
	return rgb;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const columns = Number(args.get("columns") ?? 40);
	const rows = Number(args.get("rows") ?? 16);
	// Defaults to what the game emits, so a pass here means the game will work.
	const explicit = args.has("explicit");
	// Roughly a cell's aspect, so the pattern is not obviously squashed.
	const width = columns * 8;
	const height = rows * 16;

	// The game's frames are tens of kilobytes and always chunk, so this defaults
	// to a payload that chunks too. A flat pattern does not, which is how a
	// working single-chunk test sat beside a blank map for a whole round.
	const noisy = !args.has("flat");
	const loud = args.has("loud");

	const escapes = transmitFrame({
		rgb: testPattern(width, height, noisy),
		width,
		height,
		columns,
		rows,
		loud,
	});
	const chunks = escapes.split(`${ESC}_G`).length - 1;

	const out = process.stdout;
	out.write(`terminal: TERM=${process.env.TERM} TERM_PROGRAM=${process.env.TERM_PROGRAM}\n`);
	out.write(`kitty graphics detected: ${detectKittyGraphics()}\n`);
	out.write(`multiplexer in the way: ${graphicsBlockedByMultiplexer()}\n`);
	out.write(
		`placement: ${explicit ? "every cell named" : "row anchor, then continuation (what the game emits)"}\n`,
	);
	out.write(`image: ${width}x${height} px into ${columns}x${rows} cells\n`);
	out.write(
		`payload: ${(escapes.length / 1024).toFixed(1)}KB in ${chunks} chunk(s)` +
			`${chunks > 1 ? " — exercises chunked transmission, as the game does" : " — single chunk, NOT what the game sends"}\n`,
	);
	out.write(`replies: ${loud ? "on (q=0), errors will print below" : "suppressed (q=2)"}\n\n`);

	out.write(escapes);
	out.write(`${placeholderRows(columns, rows, { explicit }).join("\n")}\n`);

	out.write("\nExpected: a rectangle in four colours — red top-left, green top-right,\n");
	out.write("blue bottom-left, yellow bottom-right — with a white diagonal from the\n");
	out.write("top-left corner to the bottom-right, and a thin dark border.\n\n");
	out.write("If you see base64 text, the escapes are not being consumed.\n");
	out.write("If you see nothing at all, the placement did not resolve.\n");
	out.write("If the colours are shuffled, the row/column diacritics are wrong.\n\n");
	out.write("Narrowing it down:\n");
	out.write("  --flat      one chunk instead of many. If this works and the default\n");
	out.write("              does not, chunked transmission is the problem.\n");
	out.write("  --loud      let the terminal report its errors instead of staying quiet.\n");
	out.write("  --explicit  name every cell rather than continuing a run.\n");

	// Deliberately *not* deleting the image on the way out: the placement is what
	// is on screen, and freeing it here would wipe the very thing being checked.
	void deleteFrame;
}

main();
