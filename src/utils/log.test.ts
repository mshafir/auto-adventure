import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Two sinks, and the point of them is that they disagree.
 *
 * The file is for whoever set `LOG_LEVEL`; the ring is for the working view, which wants
 * the debug lines whether or not anybody asked the file for them. A ring that inherited
 * the file's threshold would be an empty pane on the one screen it exists to fill.
 *
 * `logFile` and the threshold are both read once at module load, so the environment has to
 * be in place before the import — which is why every test below imports the module itself
 * rather than taking it from the top of the file.
 */

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "aa-log-"));
	process.env.LOG_FILE = path.join(dir, "log.txt");
	delete process.env.LOG_LEVEL;
	// Fresh module state per test: the threshold, the ring and the file path are all
	// module-level, and a ring left full by the previous test would make the limit
	// assertion below pass for the wrong reason.
	vi.resetModules();
});

afterEach(() => {
	delete process.env.LOG_FILE;
	delete process.env.LOG_LEVEL;
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("the log ring", () => {
	it("keeps a debug line the file's own threshold threw away", async () => {
		const { logger, logRing } = await import("./log.js");
		logger.debug("dropping late spec for committed site 42");

		expect(logRing().at(-1)?.text).toContain("committed site 42");
		expect(logRing().at(-1)?.level).toBe("debug");
		// The file is at `info` by default, so this line is deliberately not in it — and
		// the file is only created by a write, so its absence is the assertion.
		expect(fs.existsSync(process.env.LOG_FILE as string)).toBe(false);
	});

	it("still writes to the file what the file asked for", async () => {
		const { logger } = await import("./log.js");
		logger.warn("gateway key is not set");

		const written = fs.readFileSync(process.env.LOG_FILE as string, "utf8");
		expect(written).toContain("WARN gateway key is not set");
	});

	it("drops the oldest rather than growing without end", async () => {
		const { logger, logRing, LOG_RING_LIMIT } = await import("./log.js");
		for (let i = 0; i < LOG_RING_LIMIT + 5; i++) logger.debug(`line ${i}`);

		expect(logRing()).toHaveLength(LOG_RING_LIMIT);
		// The tail survives: the newest line is the one somebody is looking at.
		expect(logRing().at(-1)?.text).toBe(`line ${LOG_RING_LIMIT + 4}`);
		expect(logRing()[0]?.text).toBe("line 5");
	});

	it("tells a listener when a line lands, and stops when it is let go", async () => {
		const { logger, onLog } = await import("./log.js");
		let heard = 0;
		const off = onLog(() => {
			heard++;
		});
		logger.info("one");
		logger.info("two");
		off();
		logger.info("three");

		expect(heard).toBe(2);
	});

	it("folds the extra arguments into the line, the way the file does", async () => {
		const { logger, logRing } = await import("./log.js");
		logger.debug("brief", { premise: "a drowned archipelago" });

		expect(logRing().at(-1)?.text).toContain("a drowned archipelago");
	});

	it("empties on request, so one run does not read as the tail of the last", async () => {
		const { clearLogRing, logger, logRing } = await import("./log.js");
		logger.info("the previous world");
		clearLogRing();

		expect(logRing()).toHaveLength(0);
	});
});
