import { describe, expect, it, vi } from "vitest";
import { KEY, renderInk } from "../../../test/harness/ink.js";
import type { Pitch } from "../../ai/author/pitch.js";
import { PickPremise } from "./pick-premise.js";

/**
 * Four worlds, and a decision the player makes before paying rather than after.
 *
 * The call is injected because this page has to render in a test with no gateway key —
 * the same rule the rest of the launcher follows for the disk.
 */

const FOUR: Pitch[] = [
	{ title: "The Tide-Glass", tone: "sombre", premise: "A drowned archipelago run by collectors." },
	{ title: "The Ledger of Saint Wain", tone: "wry", premise: "A monastery audits its miracles." },
	{ title: "Nine Years at the Gate", tone: "weary", premise: "A siege nobody remembers starting." },
	{ title: "The Salt Road", tone: "hard", premise: "The caravans have stopped coming through." },
];

function mount(props: Partial<Parameters<typeof PickPremise>[0]> = {}) {
	const chosen: Pitch[] = [];
	const backs: number[] = [];
	// The parameter is declared even though the body ignores it, so that `mock.calls` is
	// typed and the cases below can read what the page asked for without casting.
	const suggest = vi.fn(
		async (_input: { readonly hint?: string; readonly avoid?: readonly string[] }) =>
			FOUR as readonly Pitch[],
	);
	const ink = renderInk(
		<PickPremise
			columns={100}
			rows={24}
			depth="none"
			duration="medium"
			suggest={suggest}
			onChoose={(pitch) => chosen.push(pitch)}
			onBack={() => backs.push(1)}
			{...props}
		/>,
		{ columns: 100, rows: 24 },
	);
	// The local mock, not whatever `props` overrode it with: the cases that override it are
	// asserting on the screen, and the cases that read `.mock` here use the default.
	return { ink, chosen, backs, suggest, screen: ink.screen };
}

describe("choosing a premise", () => {
	it("says it is working rather than sitting blank while the call runs", () => {
		// A launcher screen that shows nothing for several seconds is one a player assumes
		// has hung, and this is the first model call of the whole session.
		const m = mount({ suggest: vi.fn(() => new Promise<readonly Pitch[]>(() => undefined)) });
		expect(m.screen()).toMatch(/writing|thinking|working/i);
		m.ink.unmount();
	});

	it("shows each world's name, its register and what it is about", async () => {
		const m = mount();
		await m.ink.settle();
		const text = m.screen();
		expect(text).toContain("The Tide-Glass");
		expect(text).toContain("sombre");
		expect(text).toContain("drowned archipelago");
		m.ink.unmount();
	});

	it("hands back the whole bundle, not just the words", async () => {
		const m = mount();
		await m.ink.settle();
		await m.ink.type(KEY.enter);
		expect(m.chosen).toHaveLength(1);
		expect(m.chosen[0]?.title).toBe("The Tide-Glass");
		expect(m.chosen[0]?.tone).toBe("sombre");
		expect(m.chosen[0]?.premise).toContain("drowned archipelago");
		m.ink.unmount();
	});

	it("asks for more without offering the same four again", async () => {
		const m = mount();
		await m.ink.settle();
		await m.ink.type("m");
		await m.ink.settle();

		expect(m.suggest).toHaveBeenCalledTimes(2);
		// Named rather than merely counted: a model with no memory between calls will
		// otherwise return four rewordings and the key will read as broken.
		expect(m.suggest.mock.calls[1]?.[0]?.avoid).toContain("The Tide-Glass");
		m.ink.unmount();
	});

	it("passes on what the player had already typed", async () => {
		const m = mount({ hint: "something about debt" });
		await m.ink.settle();
		expect(m.suggest.mock.calls[0]?.[0]?.hint).toBe("something about debt");
		m.ink.unmount();
	});

	it("says so and steps aside when nothing comes back", async () => {
		// A page that cannot be left is worse than a page that failed: the player still has
		// to be able to go and type their own.
		const m = mount({ suggest: vi.fn(async () => [] as readonly Pitch[]) });
		await m.ink.settle();
		expect(m.screen()).toMatch(/could not|nothing came back/i);
		await m.ink.type(KEY.escape);
		expect(m.backs).toHaveLength(1);
		m.ink.unmount();
	});

	it("goes back on ESC without choosing anything", async () => {
		const m = mount();
		await m.ink.settle();
		await m.ink.type(KEY.escape);
		expect(m.backs).toHaveLength(1);
		expect(m.chosen).toHaveLength(0);
		m.ink.unmount();
	});
});
