import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { maskKey, readSettings, settingsPath, writeSettings } from "./settings.js";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "auto-adventure-settings-"));
	process.env.AUTO_ADVENTURE_HOME = home;
});

afterEach(() => {
	// Assigning undefined would set the literal string "undefined".
	delete process.env.AUTO_ADVENTURE_HOME;
	rmSync(home, { recursive: true, force: true });
});

describe("settings", () => {
	it("says nothing when there is no file", () => {
		expect(readSettings()).toEqual({});
	});

	it("keeps what it was given", () => {
		writeSettings({ gatewayKey: "vck_abcdef", modelSet: "claude-sonnet" });
		expect(readSettings()).toEqual({ gatewayKey: "vck_abcdef", modelSet: "claude-sonnet" });
	});

	it("patches one field without disturbing the other", () => {
		// The whole reason this is a merge: the options page writes a key knowing
		// nothing about models, and the config page writes a model without being able
		// to wipe somebody's key.
		writeSettings({ gatewayKey: "vck_abcdef" });
		writeSettings({ modelSet: "gemini-3" });
		expect(readSettings()).toEqual({ gatewayKey: "vck_abcdef", modelSet: "gemini-3" });
	});

	it("treats an empty key as forget rather than as a key", () => {
		writeSettings({ gatewayKey: "vck_abcdef" });
		writeSettings({ gatewayKey: "" });
		expect(readSettings().gatewayKey).toBeUndefined();
		// And the file is still there holding whatever else was in it.
		writeSettings({ modelSet: "qwen" });
		expect(readSettings()).toEqual({ modelSet: "qwen" });
	});

	it("writes the key where only its owner can read it", () => {
		// The entire protection. There is no keychain here, so a file the rest of a
		// shared machine can read is the same as a key in the repository.
		writeSettings({ gatewayKey: "vck_abcdef" });
		const mode = statSync(settingsPath()).mode & 0o777;
		expect(mode & 0o077).toBe(0);
	});

	it("survives a file somebody edited into nonsense", () => {
		// A bad settings file must cost a player their key, not their game.
		writeSettings({ gatewayKey: "vck_abcdef" });
		writeFileSync(settingsPath(), "{ this is not json", "utf8");
		expect(readSettings()).toEqual({});
	});

	it("ignores fields of the wrong shape", () => {
		writeFileSync(settingsPath(), JSON.stringify({ gatewayKey: 42, modelSet: [] }), "utf8");
		expect(readSettings()).toEqual({});
	});

	it("leaves no temporary file behind", () => {
		// The write goes via a temp file and a rename, the same as saves do.
		writeSettings({ modelSet: "deepseek" });
		expect(readFileSync(settingsPath(), "utf8")).toContain("deepseek");
		expect(() => statSync(`${settingsPath()}.tmp`)).toThrow();
	});
});

describe("maskKey", () => {
	it("shows enough to recognise a key by and no more", () => {
		const masked = maskKey("vck_1234567890abcdef");
		expect(masked).toContain("vck_");
		expect(masked).toContain("cdef");
		expect(masked).not.toContain("567890");
	});

	it("shows nothing at all of a short one", () => {
		expect(maskKey("short")).toBe("•••••");
	});
});
