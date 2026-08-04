# A recording of the game actually being played.
#
#   npm run build && vhs docs/demo.tape
#
# Needs vhs, ttyd and ffmpeg on PATH. Deliberately not wired into any npm script:
# it is an occasional job for the README, not part of the build.
#
# The world is pinned by seed and written to a throwaway save directory, so the
# recording is the same every time and never touches a real game. NO_AI=1 keeps
# it offline, so what you see is the deterministic path with no model calls.
#
# The keystrokes below are generated, not hand-written. `npx vite-node
# src/tools/route.ts 23` builds the same world, paths through it with the same
# A*, replays the result through a real engine to check where it ends up, and
# prints these blocks — including the extra press each corner costs, because the
# first press of a new direction only turns. Re-run it if the seed changes.
#
# Every press carries an explicit 400ms, and a run is never split across two
# commands. VHS applies that interval *between the repeats of one command*, not
# between commands — so `Left` followed by `Left 2` sends two keys back-to-back,
# they land in one read, and Ink parses the pair of three-byte escape sequences
# as a single key. Take one walked into a house that way; take two lost two steps
# inside one.

Output docs/screens/play.gif

Set Shell bash
Set FontSize 14
Set Width 1180
Set Height 700
Set Padding 14
Set Framerate 20

Hide
Type "export AUTO_ADVENTURE_HOME=$(mktemp -d) NO_AI=1 WORLD_SEED=23 WORLD_NAME=demo COLORTERM=truecolor"
Enter
Type "clear"
Enter
Show

Type "node dist/main.js"
Enter
# Long enough for the first ring of chunks to finish generating.
Sleep 9s

# Up the road to Ulric Dunmere, the shopkeeper. Walking into somebody is how you
# talk to them.
Up@400ms 3
Sleep 400ms
Right@400ms 15
Sleep 400ms
Up@400ms 5
Sleep 2s

# The replies are suggestions; the player only ever picks one.
Down@400ms
Sleep 1s
Space
Sleep 2500ms
Escape
Sleep 1s

# In through the door beside him. Walking into a door goes inside.
Left@400ms 2
Sleep 2s

# Interiors are separate grids, lit by lamplight rather than daylight. There is a
# crate in the far corner.
Up@400ms 3
Sleep 400ms
Left@400ms 4
Sleep 400ms
Up@400ms 3
Sleep 400ms
Left@400ms 2
Sleep 800ms
Space
Sleep 2500ms

# Back out through the doorway.
Right@400ms 2
Sleep 400ms
Down@400ms 5
Sleep 400ms
Right@400ms 3
Sleep 400ms
Down@400ms 2
Sleep 400ms
Down@400ms
Sleep 1500ms

# What that turned up, with the cursor on it.
Type "i"
Sleep 2500ms
Down@400ms
Sleep 1500ms
Escape
Sleep 500ms

# The world so far, one character per chunk.
Type "w"
Sleep 2500ms
Type "m"
Sleep 2s

# Leaving asks first, and writes the save out before it goes. The final pause is
# short on purpose: the terminal is blank once the game exits, and a couple of
# dead seconds at the end of a loop reads as the recording having broken.
Type "s"
Sleep 2s
Type "y"
Sleep 600ms
