/**
 * Which multiplexer the game is running inside, and what it can be trusted with.
 *
 * One list, because two separate questions turn out to have the same answer
 * shape. A multiplexer sits between the game and the terminal that eventually
 * draws: it re-parses every escape and re-emits its own, so anything unusual has
 * to be understood by *two* implementations rather than one.
 *
 * It has to be a list of names rather than a capability question, and that is the
 * genuinely awkward part. A multiplexer runs the game on a pty of its own and
 * hands the environment straight down, so `TERM_PROGRAM` still names the outer
 * terminal — and a query sent into a pane is answered by that outer terminal,
 * truthfully, about itself. There is no question whose answer distinguishes "this
 * terminal can do it" from "the terminal at the far end of this multiplexer can do
 * it". Only the name does.
 */

export interface Multiplexer {
	readonly name: string;
	/**
	 * Whether frames may be bracketed in DEC 2026 synchronized updates.
	 *
	 * Found the hard way in herdr, and the shape of the failure is worth recording
	 * because neither half of it looks broken on its own. The game leans on exactly
	 * two escapes an ordinary TUI does not — the alternate screen buffer, and a
	 * synchronized update around *every* write — and inside herdr the map did not
	 * draw at all. Turning off either one fixed it. So neither is unsupported; it is
	 * the pair that this particular parser cannot follow.
	 *
	 * Of the two, synchronized output is the one to give up. It is an optimisation:
	 * it stops the terminal showing the gap between Ink erasing a frame and writing
	 * the next, which reads as flicker. The alternate screen is not an optimisation —
	 * without it the game paints over the player's scrollback and does not give
	 * their shell back on exit.
	 */
	readonly synchronizedOutput: boolean;
}

const KNOWN: readonly {
	readonly name: string;
	readonly detect: (env: NodeJS.ProcessEnv) => boolean;
	readonly synchronizedOutput: boolean;
}[] = [
	// tmux 3.4 and later implement DEC 2026, and it is where the flicker fix was
	// developed. Checked before the `screen` TERM below, which tmux also sets.
	{ name: "tmux", detect: (env) => Boolean(env.TMUX), synchronizedOutput: true },
	{
		name: "herdr",
		detect: (env) => Boolean(env.HERDR_ENV || env.HERDR_PANE_ID),
		synchronizedOutput: false,
	},
	// GNU screen, which predates the mode by decades.
	{
		name: "screen",
		detect: (env) => (env.TERM ?? "").startsWith("screen"),
		synchronizedOutput: false,
	},
];

export function multiplexer(env: NodeJS.ProcessEnv = process.env): Multiplexer | undefined {
	for (const entry of KNOWN) {
		if (entry.detect(env)) {
			return { name: entry.name, synchronizedOutput: entry.synchronizedOutput };
		}
	}
	return undefined;
}
