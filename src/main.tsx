#!/usr/bin/env node

import { render } from "ink";
import App from "./app.js";
import { log } from "./utils/log.js";

function resetScreen() {
	const enterAltScreenCommand = "\x1b[?1049h";
	const leaveAltScreenCommand = "\x1b[?1049l";
	process.stdout.write(enterAltScreenCommand);
	process.on("exit", () => {
		process.stdout.write(leaveAltScreenCommand);
	});
}

async function startGame() {
	console.log("Starting game...");
	// resetScreen();
	try {
		const { waitUntilExit } = render(<App />);
		await waitUntilExit();
	} catch (e) {
		log(e);
	}
}

process.on("unhandledRejection", (reason, promise) => {
	log(
		new Error(
			`FATAL: Unhandled Promise Rejection at: ${promise}, reason: ${reason}`
		)
	);
	process.exit(1);
});
process.on("uncaughtException", (err) => {
	log(`FATAL: Uncaught Exception due to error: ${err}`);
	process.exit(1);
});

startGame().catch((e) => console.error(e));
