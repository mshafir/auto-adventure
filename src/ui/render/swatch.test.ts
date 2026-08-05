import { describe, expect, it } from "vitest";
import { PAL } from "./palette.js";
import { MISSING, swatch } from "./swatch.js";

describe("swatch", () => {
	it("resolves a palette entry by name", () => {
		expect(swatch("moss")).toEqual(PAL.moss);
		expect(swatch("lamplight")).toEqual(PAL.lamplight);
	});

	it("takes a hex literal for colours the palette has no word for", () => {
		expect(swatch("#7a6a8a")).toEqual([0x7a, 0x6a, 0x8a]);
		expect(swatch("#abc")).toEqual([0xaa, 0xbb, 0xcc]);
	});

	// A theme is data, and once it can come from a pack a typo must not stop the
	// game from starting — but it must be impossible to miss.
	it("flags a name it does not know rather than throwing", () => {
		expect(swatch("chartreuse")).toEqual(MISSING);
		expect(swatch("#ggg")).toEqual(MISSING);
		expect(swatch("")).toEqual(MISSING);
	});

	// `PAL.bloom` is a list of colours, not one, so it is not a swatch.
	it("does not resolve a palette entry that holds several colours", () => {
		expect(swatch("bloom")).toEqual(MISSING);
	});
});
