import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PACK } from "../core/content/default.js";
import { listPacks, loadPack, packPath, readOverride, resolveOverride } from "./load.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "auto-adventure-pack-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function write(name: string, body: unknown): string {
	const path = join(dir, name);
	writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
	return path;
}

describe("the shipped default asset", () => {
	it("is exactly the pack compiled into the game", () => {
		// The two exist for different reasons — the code so `core` needs no filesystem,
		// the file so an author has a complete example to copy — and they are only
		// useful together if they cannot drift. Regenerate the asset if this fails.
		const shipped = readOverride(packPath("default"));
		expect(shipped).toEqual(JSON.parse(JSON.stringify(DEFAULT_PACK)));
	});

	it("is listed among the packs on disk", () => {
		expect(listPacks()).toContain("default");
	});
});

describe("resolving what the player asked for", () => {
	it("finds a shipped pack by bare name", () => {
		expect(resolveOverride("default")?.id).toBe("default");
	});

	it("reads a pack given as a path, so one can live beside a draft", () => {
		const path = write("mine.json", { id: "mine", appearance: { cooper: "Pitch to the elbow." } });
		expect(resolveOverride(path)?.appearance?.cooper).toBe("Pitch to the elbow.");
	});

	it("asks for nothing when nothing was named", () => {
		expect(resolveOverride(undefined)).toBeUndefined();
		expect(resolveOverride("   ")).toBeUndefined();
	});

	it("falls back to the default rather than refusing to start", () => {
		// A player asked to play, not to debug their JSON. The authoring tool is where a
		// bad pack deserves a hard error; here it must never stop a game.
		expect(resolveOverride("no-such-pack")).toBeUndefined();
		expect(resolveOverride(join(dir, "missing.json"))).toBeUndefined();
		expect(resolveOverride(write("broken.json", "{ not json"))).toBeUndefined();
	});

	it("refuses a pack that would break a generator", () => {
		// An empty given-name list would have `personName` index into nothing and call
		// everybody in the world "undefined undefined".
		expect(resolveOverride(write("empty.json", { names: { given: [] } }))).toBeUndefined();
	});

	it("lays a pack over the default rather than replacing it", () => {
		const path = write("thin.json", { id: "thin", appearance: { cooper: "Pitch." } });
		const pack = loadPack(path);
		expect(pack.id).toBe("thin");
		expect(pack.appearance.cooper).toBe("Pitch.");
		// Everything the file said nothing about still works.
		expect(pack.names.given).toEqual(DEFAULT_PACK.names.given);
		expect(pack.households.inn).toEqual(DEFAULT_PACK.households.inn);
	});

	it("gives the default pack when asked for nothing", () => {
		expect(loadPack(undefined)).toBe(DEFAULT_PACK);
	});
});
