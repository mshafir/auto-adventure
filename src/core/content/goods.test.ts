import { describe, expect, it } from "vitest";
import { forageYields, isForageable } from "../rules/forage.js";
import { itemsStoredIn } from "../rules/loot.js";
import { sellsGoods, shopStock, tradeKind } from "../rules/shop.js";
import { T } from "../tiles/terrain.js";
import { DEFAULT_GOODS, type GoodsTables, mergeGoods } from "./goods.js";
import { PackOverrideSchema } from "./schema.js";

const CAMELOT: GoodsTables = mergeGoods(DEFAULT_GOODS, {
	catalogue: {
		fletcher: [
			["Sheaf of Arrows", "Two dozen, fletched grey."],
			["Yew Stave", "Unstrung, and worth more than it looks."],
		],
	},
	stores: { smithy: [["Broken Mail", "Somebody stopped mending it."]] },
	yields: { forestFloor: [["Bowyer's Yew", "Cut from the trunk's shaded side."]] },
});

describe("goods, before a pack has its say", () => {
	it("sells what the six trading kinds always sold", () => {
		for (const kind of ["shop", "smithy", "apothecary", "inn", "stable", "warehouse"]) {
			expect(sellsGoods(kind), `${kind} should trade`).toBe(true);
		}
		expect(sellsGoods("temple")).toBe(false);
		expect(sellsGoods("house")).toBe(false);
	});

	it("reads a trade out of the prose a director writes", () => {
		expect(tradeKind("the village farrier")).toBe("smithy");
		expect(tradeKind("herbalist")).toBe("apothecary");
		expect(tradeKind("a quartermaster, off duty")).toBe("warehouse");
		expect(tradeKind("shepherd")).toBeUndefined();
	});

	it("still stocks a mill with flour and a forest floor with moss", () => {
		expect(itemsStoredIn("mill")).toContain("Sack of Flour");
		expect(forageYields(T.forestFloor)).toContain("Cushion Moss");
		expect(isForageable(T.forestFloor)).toBe(true);
		expect(isForageable(T.cobbleRoad)).toBe(false);
	});
});

describe("goods, once a pack has written some", () => {
	/**
	 * The bug this whole table was extracted for. `tradeKind` was six regexes over six
	 * hard-coded kinds, so a pack could write a fletcher's catalogue and the fletcher
	 * would still sell nothing — and because `obtainableItems` reads shop stock, no
	 * errand could name a single arrow either.
	 */
	it("lets a trade the built-in tables never heard of sell things", () => {
		expect(tradeKind("the castle fletcher", CAMELOT)).toBe("fletcher");
		expect(sellsGoods("fletcher", CAMELOT)).toBe(true);
		const stock = shopStock(7, 11, 0, "fletcher", CAMELOT);
		expect(stock.length).toBeGreaterThan(0);
		for (const item of stock) {
			expect(["Sheaf of Arrows", "Yew Stave"]).toContain(item.name);
		}
	});

	it("still refuses a role nobody has written a catalogue for", () => {
		expect(tradeKind("the castle falconer", CAMELOT)).toBeUndefined();
		expect(sellsGoods("falconer", CAMELOT)).toBe(false);
	});

	it("replaces a table it names and keeps every table it does not", () => {
		expect(itemsStoredIn("smithy", CAMELOT)).toEqual(["Broken Mail"]);
		expect(itemsStoredIn("mill", CAMELOT)).toContain("Sack of Flour");
		expect(forageYields(T.forestFloor, CAMELOT)).toEqual(["Bowyer's Yew"]);
		expect(forageYields(T.marsh, CAMELOT)).toContain("Bog Myrtle");
	});

	it("leaves the built-in tables untouched, so one world cannot edit another's", () => {
		expect(itemsStoredIn("smithy")).toContain("Iron Ore");
		expect(forageYields(T.forestFloor)).toContain("Cushion Moss");
	});

	it("is accepted from a pack file, so an author can actually write one", () => {
		const parsed = PackOverrideSchema.safeParse({
			id: "camelot",
			goods: {
				catalogue: { fletcher: [["Sheaf of Arrows", "Two dozen, fletched grey."]] },
				trades: [{ kind: "fletcher", roles: ["fletcher", "bowyer"] }],
			},
		});
		expect(parsed.success).toBe(true);
	});

	it("refuses an item with no description, which would price and read as a bug", () => {
		const parsed = PackOverrideSchema.safeParse({
			goods: { catalogue: { fletcher: [["Sheaf of Arrows", ""]] } },
		});
		expect(parsed.success).toBe(false);
	});
});
