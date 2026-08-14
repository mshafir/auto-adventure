# auto-adventure

A terminal RPG on an infinite, seamless, procedurally generated world, with an
LLM as its author rather than its renderer.

![A recording of the game being played](docs/screens/play.gif)

```
npx auto-adventure        # play it without cloning anything
```

From a clone:

```
npm install
npm start                 # pick a world, or start one
WORLD_NAME=hollowmoor npm start   # skip the menu, open that slot
NO_AI=1 npm start         # play with no model at all
SCENARIO_PROMPT="a drowned archipelago run by debt-collectors" npm start
npm run preview -- --seed vale --at 0,0    # dump a chunk to stdout
npm run preview -- --at 0,0 --ascii        # ...as one ASCII byte per tile
npm run preview -- --at 0,0 --flat         # ...with shadows and slope shading off
npm run preview -- --at 0,0 --xscale 1     # ...one column per tile instead of two
npm run survey -- --seed thornwick --duration short                # dump the map, free
npm run validate                                                   # check every scenario on disk
npm run check             # typecheck + lint + tests
```

## The idea

The engine decides **what exists**; the model decides **what it is called and
who lives there**. No model call ever emits a tile, and no model call is ever on
the movement path.

Every tile is a pure function of `(worldSeed, globalPosition)` plus feature data
that is itself a pure function of `(worldSeed, macroCoordinate)`. There is no
boundary in the function, so there is no boundary in the output — seams are
impossible rather than repaired. A town is generated once in its own coordinate
frame and *clipped* into whichever chunks it overlaps, so a settlement straddling
four chunks is one town seen four ways.

## Layout

| Path | What it is |
|---|---|
| `src/core/` | Pure. No `fs`, `react`, `ink`, `zustand` or `ai` — enforced by lint. Worker-safe. |
| `src/core/rand` | xoshiro128\*\*, simplex noise, jittered-grid blue noise |
| `src/core/world` | Fields, biomes, macro sites, roads, rivers, weather, names |
| `src/core/gen` | The chunk pipeline and its features (settlements, buildings, interiors) |
| `src/core/rules` | `reduce(state, command, probe) → {state, effects}` — pure and total |
| `src/engine/` | Chunk manager, stitched world view, effect runner, NPC directory |
| `src/ai/` | Gateway client, director (regions and sites), dialogue and memory |
| `src/scenario/` | Scenario directories, chapters, the survey, and validation against the real generator |
| `src/persist/` | Deltas-only saves, atomic writes, versioned migration |
| `src/ui/` | Ink app, panels, and the two renderers |
| `src/ui/render/` | Glyphs, autotile, ANSI run-length encoding, sprites, the kitty graphics protocol |

## Configuration

`src/config.ts` loads `dotenv-flow` before anything else, so the usual files
work out of the box. Copy `.env.example` to `.env.local` and fill in the key:

```
cp .env.example .env.local
```

Precedence, lowest to highest: `.env` → `.env.local` → `.env.[NODE_ENV]` →
`.env.[NODE_ENV].local`, and a real environment variable beats all of them:

```
AI_GATEWAY_API_KEY=sk-... npm start
```

Both `.env` and `.env.local` are git-ignored. `.env.local` is also skipped when
`NODE_ENV=test`, which is what stops the test suite from picking up a key and
quietly making live calls.

All variables are optional. The game runs with none of them set.

### The model

Everything here is optional in the strongest sense: with no key at all the game
is fully playable — every place is named, every building is entered, and every
conversation is a real dialogue tree. See
[Playing without a model](#playing-without-a-model).

**You do not need any of these variables to use a model.** *Options*, on the
title screen, takes a gateway key and keeps it in
`~/.auto-adventure/settings.json` at mode `0600` — out of the repository, so it
cannot be committed, copied into a container or pasted into a bug report. The
same page chooses which models write a world, and so does the page that
configures a world before it is written.

| Variable | Default | Meaning |
|---|---|---|
| `AI_GATEWAY_API_KEY` | — | Vercel AI Gateway key. Beats the saved one. Absent means the deterministic path. |
| `NO_AI` | `0` | Force the deterministic path even with a key. |
| `MODEL_SET` | `gemini-2.5` | Which pair of models writes a world. Beats the saved choice. |
| `MODEL_DIRECTOR` | the set's cheap half | Region and site specs. High volume, never read directly. |
| `MODEL_DIALOGUE` | the set's dear half | What NPCs say, and the authored conversation trees. |
| `MODEL_SUMMARY` | the set's cheap half | Rolling NPC memory. |
| `MODEL_BIBLE` | the set's dear half | The world premise and the story's plot, once per world. |

#### Which models

A choice is a *pair*, not a model. The game makes a lot of small structured calls
whose output nobody reads and rather fewer prose calls the player reads every
word of; running both on the good model costs several times what a world is
worth, and running both on the cheap one is visible in the writing. Rows are
named after the half you can see, and priced against the default.

| `MODEL_SET` | Writes | Bookkeeping | ≈ cost |
|---|---|---|---|
| `deepseek` | `deepseek/deepseek-v3.2` | the same | 0.5× |
| `gpt-5-mini` | `openai/gpt-5-mini` | `openai/gpt-5-nano` | 0.8× |
| `gemini-2.5` | `google/gemini-2.5-flash` | `google/gemini-2.5-flash-lite` | 1× |
| `gemini-3` | `google/gemini-3-flash` | `google/gemini-3.1-flash-lite` | 1.8× |
| `claude-haiku` | `anthropic/claude-haiku-4.5` | the same | 4.6× |
| `claude-sonnet` | `anthropic/claude-sonnet-5` | `anthropic/claude-haiku-4.5` | 6.2× |

Per-token prices live in `src/ai/catalogue.ts` and are read off the gateway's own
catalogue rather than each vendor's pricing page, because the gateway is who
bills. The multiplier is a blend for ordering the list, not a quote.

Membership is not a judgement of how good a model is. It is whether the model can
be **relied on to answer in a schema** — several strong writers answer one time in
six and were cut for it, which is a failure nobody would ever see: a malformed
answer is not an error, it is a world that quietly comes out with none of the
authored names in it. `src/ai/catalogue-live.test.ts` is what checks this; it
skips without a key, and the header of `catalogue.ts` records what was cut and
why.

Models are provider-prefixed strings routed through the gateway, so pointing a
call type at a different provider is a variable rather than a code change. Calls
cost tokens, so they are counted: `src/ai/telemetry.ts` reports calls, tokens and
latency per call type into the log on exit.

### Which world, and what it is about

| Variable | Default | Meaning |
|---|---|---|
| `WORLD_SEED` | `auto-adventure` | A word or a number. The whole world is a pure function of it. |
| `WORLD_NAME` | `default` | Save slot. Setting it explicitly **skips the launcher** and opens that slot. |
| `SCENARIO_PROMPT` | — | Freeform brief: what this world is about. The main knob. |
| `SCENARIO_SETTING` | — | Refines the brief. |
| `SCENARIO_STORYLINE` | — | The story wanted from it. |
| `SCENARIO_TONE` | — | Refines the brief. |
| `SCENARIO_PROTAGONIST` | — | Who the player is. |
| `SCENARIO_AVOID` | — | Genres, tropes or subjects to keep out. |
| `SCENARIO_DURATION` | — | `short`, `medium` or `long`. Sets how large a world `npm run survey` measures. |

A brief is *intent*, never geometry: nothing here can move a coastline or place a
town. It reaches the prompts that name and populate what the engine already
built, which is why an unsatisfiable brief gives a differently-flavoured world
rather than a broken one.

### What things are called, and where they live

| Variable | Default | Meaning |
|---|---|---|
| `CONTENT_PACK` | — | A flavour pack: a shipped name or a path (`./my-pack.json`). Names, households, trades, goods and ambient lines, and for most of them the shape of the map too. Nine ship: `default`, `thornwick`, `camelot`, `thalassa`, `sunspire`, `hollowfrost`, `saltmere`, `redgulch`, `ashfall`. Steers a **new** world only — a save keeps the pack it was made with, because adopting another would rename everybody already met while keeping their memories. |
| `TILE_PACK` | — | A directory under `.packs/tiles/`, or a path to one. Chooses how the map *looks*; the world is identical either way. Eight ship, one per pack that wanted a look of its own. |
| `AUTO_ADVENTURE_HOME` | `~/.auto-adventure` | Where saves live. |
| `AUTO_ADVENTURE_PACKS` | `./.packs` | Where content and tile packs are read from. |
| `AUTO_ADVENTURE_SCENARIOS` | `./.scenarios` | Where scenario directories are read from, and written to. |
| `LOG_FILE`, `LOG_LEVEL` | `log.txt`, `info` | The TUI owns stdout, so logs go to a file. `debug` is what to reach for when something silently did not happen. |
| `SAVE_DEBOUNCE_MS` | `2000` | How long a change waits before it is written. Checkpoints and quitting flush immediately regardless. |

Packs and scenarios live in the repository rather than under your home directory
because they are *source*: a pack decides what the people in a world are called,
and a change to one belongs in a diff where it can be read.

### How the map is drawn

The map draws as **glyphs** by default and as **pixels** on terminals that
implement the kitty graphics protocol. They draw the same layout from the same
state — the choice is about fidelity, not about what the game is. The one place
they differ is how much world fits: a glyph tile is always two columns by one row,
so there is no size to trade and the view is uncapped, where pixel mode caps at
`FOV` and lets `ZOOM` trade world for detail.

`TILE_MODE` is the one to know:

| Value | What happens |
|---|---|
| `auto` (default) | The game **asks the terminal**. A one-pixel graphics query goes out alongside the cell-size query, in the window before Ink takes stdin, and a terminal that answers gets pixels. Silence means glyphs. |
| `kitty` or `pixel` | Pixels, with **no capability check**. The escape hatch for a terminal that implements the protocol but will not say so — and for one that has not shipped yet. In a terminal that genuinely cannot, this produces a mess rather than a crash, which is the accepted trade. |
| `glyph` or `glyphs` | Glyphs, whatever the terminal can do. |

Asking replaced a hard-coded list of terminal names, which was wrong in the quiet
direction: a capable terminal nobody had added got glyphs and no explanation. Two
things still override the answer. Inside a **multiplexer** the query is not sent
at all — tmux, screen and herdr are recognised by name, because a multiplexer
passes the environment straight down and a query sent into a pane is answered by
the terminal *behind* it, truthfully and about the wrong program. And when stdout
is not a TTY — a pipe, a golden test, a screenshot — glyphs win, because none of
those can show an image. Glyphs are the permanent floor, not a fallback that
might one day be dropped. [Renderers](#renderers) goes into why.

| Variable | Default | Meaning |
|---|---|---|
| `TILE_MODE` | `auto` | As above. |
| `TILE_WIDTH` | `2` | Terminal columns per world tile. `2` makes tiles square; `1` shows twice as much world, stretched 2:1 vertically. Glyph mode only. |
| `ZOOM` | `1` | Where zoom starts in pixel mode; `+` and `-` take it from there. Above 1 is bigger tiles and less world on screen, below is the reverse. |
| `FOV` | `72x32` in pixel mode, uncapped in glyph mode | `WxH` — the most world the map will show, in tiles. Past it the map stops growing and centres in the window rather than filling it. Set explicitly it applies to **both** renderers; the default only to pixels, where there is a tile size to trade for. |
| `TILE_PX` | derived | Pixels per tile edge, pinned. Left alone it is derived from the terminal's cell so pixel mode shows the same field of view as glyph mode. |
| `CELL_PX` | measured | `WxH` override for a terminal that will not answer `CSI 16 t` with its cell size. A wrong cell size is not cosmetic: it decides how many tiles fit, so a bad guess centres the player for a viewport of the wrong shape. |
| `KITTY_DEFLATE` | `1` | zlib level for the frame. Raise it to trade CPU for bytes on a slow link. |
| `NO_RELIEF` | `0` | Turn off slope shading. Costs about 14KB a frame, so worth trying if the display flickers over a slow link. |
| `NO_COLOR`, `FORCE_COLOR` | — | The usual conventions, honoured. Set means no colour at all; `FORCE_COLOR` is `0`–`3` for none, 16, 256 and truecolor. Otherwise the depth comes from `COLORTERM` and `TERM`. |

Everything else the renderer reads — `TERM`, `TERM_PROGRAM`, `TMUX`,
`KITTY_WINDOW_ID` and friends — is set *by* your terminal rather than by you, and
is only ever used to work out what it is. There is nothing to configure there.

### Pacing, and the escape hatches

The first four exist because a terminal is a much slower display than it looks.
The last three exist to make "it does not render at all" bisectable in two runs,
rather than guessing at an emulator we cannot install.

| Variable | Default | Meaning |
|---|---|---|
| `FRAME_MS` | `33` | Shortest gap between two frames — thirty a second, against the ~20ms a frame costs to draw. Changes arriving closer together are drawn once. `0` renders on every change, which is the way to tell whether this is what feels wrong. |
| `FRAME_PIXELS` | `4000000` | The most pixels one pixel-mode frame may be. Past it tiles are drawn smaller and the terminal scales them back up into the same cells — the camera is unaffected, so the same world is on screen at a slightly lower resolution. Uncapped, a 163x70 window asked for 8 megapixels and 24MB of raw RGB *per keypress*. |
| `CHUNK_SLICE` | `1` | Chunks built per turn of the event loop while the ground ahead is filled in. One chunk is already ~28ms, and the point is to stay interruptible. |
| `DEAD_ZONE` | `0.4` | How far in from each edge the player may walk before the view scrolls. Smaller means the world holds still more often but shows less ground ahead once you are moving; `0.49` is a centred camera, which scrolls on every single step. |
| `NO_SYNC_OUTPUT` | `0` | Stop bracketing frames in DEC mode 2026. Off automatically inside a multiplexer not known to follow it. |
| `SYNC_OUTPUT` | — | Force bracketing back on where it was turned off for you. `NO_SYNC_OUTPUT` still wins. |
| `NO_ALT_SCREEN` | `0` | Draw in the terminal's own scrollback rather than on a screen of its own. The other half of the "nothing renders" bisect. |

The game leans on exactly two escapes an ordinary TUI does not: the alternate
screen buffer, and a synchronized update around every write. If nothing draws,
turn off one and then the other — whichever fixes it names the culprit.

## What it looks like

That recording is a real session, played offline with no model calls: waking up
in a village, walking up the road to the shopkeeper, going through a crate in
his house, and quitting. The stills below are particular moments.

How a game introduces itself. Every flavour opens on a full screen saying where
you are, who you are, what brought you here and — if the world has a story —
which town to make for and who to ask for when you get there — assembled from the world's own
lore, the brief it was given and the story's premise, so it works with no model
at all. The same mechanism is reused mid-journey: a story beat can raise one for
a turn a line of dialogue cannot carry.

![How a game introduces itself](docs/screens/opening.svg)

A town from the road. The map takes the full width and every one of its rows —
where you are, the clock and the weather are pinned along the top, and the
explored world is drawn into the corner of the map itself rather than laid out
beside it. That is what lets the same layout be drawn as pixels: see
[the renderers](#renderers) below.

![A town, seen from the road](docs/screens/town.svg)

Talking to somebody. Conversations are choice-only — the model suggests what you
might say, and every option is a real branch rather than a text box.

![Talking to somebody](docs/screens/conversation.svg)

Inside a building. Somebody is usually home — a weaver at her loom, a farrier
with scorched hands, a child entirely unsurprised to see you — derived from the
seed rather than written, so a town of thirty buildings costs nothing extra to
populate. Which trades live where, and how they are described, comes from a
content pack, so a scenario can be peopled by fellers and bark-peelers instead. Crates, barrels, chests and shelves can be searched, and what a
building stores depends on what it is for; a mill really does hold timber.
Outdoors the same key gathers from the ground.

![Inside a building, where somebody is home](docs/screens/inside.svg)

The story so far, and the errand in hand. The main quest is pinned above the
errand list and needs no cursor: the steps you have reached, ticked when their
errand is finished and marked `[~]` while it is still open, and the clues the
story has told you. It counts what remains without naming it — the next step is
already the errand below, with a bearing back to the town that gave it. Quest
targets are resolved against what the engine actually built, so an NPC cannot
send you after something that was never placed.

![The story so far, and the errand in hand](docs/screens/quest.svg)

When the last beat closes and the last errand is done, the story says so — a line in
the journal, `told` in the quest page, and a closing card the way it opened on one.
A scenario can write its own last page; one is assembled from what the player
actually did if it does not.

`M` — or `Tab` — opens the menu, which takes the whole frame inside a heavy
border that says you are in a mode. Left and right walk the tabs, down steps
into the one you are on, `Esc` goes back to the map, and `M` again closes it.
One key rather than four because four letters is four bindings to know before
any of them can be found; the strip along the top then says what is in here, so
nothing has to be remembered.

Each tab takes the full width because everything in it is prose written for a
human — a 32-column panel elided a quest description or a story clue
mid-sentence, on exactly the part worth reading.

What you are carrying. The arrow keys move the selection and `D` drops it.
Dropping destroys the item, so it asks first, and it tells you when an open
errand still wants it.

![The inventory panel, with an errand item flagged](docs/screens/inventory.svg)

What the glyphs mean, read out of the tile registry rather than written down, so
the key cannot start describing a colour or a character the game stopped using.

![What the glyphs on the map mean](docs/screens/key.svg)

The stills are rendered from real frames by `npm run screens` — the same
compositor, palette and panels the game uses, captured through Ink and written
out as SVG. So they are a build artifact rather than a photograph of somebody's
terminal, and refreshing them after a change is one command.

The recording is [`docs/demo.tape`](docs/demo.tape), played back through
[vhs](https://github.com/charmbracelet/vhs) — `npm run build && vhs docs/demo.tape`,
which additionally needs `ttyd` and `ffmpeg`. Its keystrokes are generated rather
than written: `npx vite-node src/tools/route.ts 23` builds the same world, paths
through it with the same A\*, replays the result through a real engine to check
it, and prints the tape body.

## Controls

Arrows move; the first press of a new direction only turns, so looking at a sign
costs nothing. Walking into a door enters the building. Walking into a person
starts a conversation, as does `SPACE`. `SPACE` searches whatever you are facing:
a crate, barrel, chest or shelf indoors, or the ground itself outdoors. What a
building stores depends on what it is for — a mill really does hold timber — and
crops, forest floor, marsh, reeds and bramble each give up their own things.
Conversations are choice-only — up/down to pick, `SPACE` to answer, `ESC` to
leave.

The view follows rather than being pinned to you. There is a dead zone in the
middle of the map — `DEAD_ZONE` sets how big — and inside it walking moves you and
nothing else; the world only scrolls once you reach its edge. A centred camera
slides the entire scene by a tile on every single step with the player nailed to
the middle, which reads as the ground moving rather than as you moving. The trade
is that a sustained walk leaves you slightly ahead of centre and so shows a little
less ground in front of you.

The bar along the bottom always says which keys are live, because they change:
the arrow keys mean three different things depending on whether you are walking,
choosing a reply, or reading a list.

`+` and `-` zoom the map in pixel mode, through a short list of steps rather than
by a factor — so zooming back out lands exactly where zooming in started. Zoom is
how you ask for a bigger picture, because the pixel map no longer takes a bigger
window as a request for one: past `FOV` tiles it stops growing and centres itself
in the window instead. A glyph is whatever size your font is, so there is nothing
to zoom: the keys are not bound in that mode, the bar does not offer them, and the
glyph map goes on filling the window however large it is.

`M` or `TAB` opens the menu: what you are carrying, the errands, the journal and
the map key. Left and right walk the tabs, down hands the arrow keys to the list
on the one you are on, and `ESC` or `M` goes back to the map. Inside the
inventory, `D` drops what the cursor is on; it asks first, and warns you if an
open errand wants it, because there is no ground layer to pick it back up from.
`S` saves and quits, also with a confirmation.

The top bar carries the clock: a tick is a minute and a move is a tick, so an
hour of world time is sixty steps. Which way you are facing decides what `SPACE`
acts on, so it is shown — as a wedge on the player's own sprite in pixel mode,
and as an arrow beside the line describing what is in front of you in glyph
mode. The minimap in the corner of the map draws one
cell per chunk of the world you have walked into, `@` for where you are and `!`
for a chunk with an errand waiting; the quest list gives the same errand a
bearing in chunks — `E 2` rather than a tile count.

## Renderers

The map draws as glyphs by default and can draw as pixels instead, on terminals
that implement the kitty graphics protocol:

```bash
npm start                   # asks the terminal, and uses pixels if it says yes
TILE_MODE=kitty npm start   # pixels, no capability check
TILE_MODE=glyph npm start   # glyphs, whatever the terminal can do
npm run kitty-check         # does this terminal actually support it?
npm run kitty-geometry      # what the game asked, and what came back
```

Left to itself the game **asks**: a one-pixel graphics query goes out with the
cell-size queries in the window before Ink takes stdin, and a terminal that
answers `OK` gets pixels. That replaced a list of terminal names, which was wrong
in the quiet direction — a capable terminal nobody had added to the list got
glyphs and no explanation. The trade is worth stating: a terminal that implements
the protocol but drops the reply now gets glyphs where the list would have given
it pixels, and `TILE_MODE=kitty` is the way back.

`TILE_MODE` overrides in both directions and without a check, because a terminal
that supports the protocol but will not say so is something the player is better
placed to know than we are. Inside a multiplexer the query is not sent at all —
one *prints* an APC sequence it does not understand rather than eating it — and
glyphs are the permanent floor rather than a fallback that might one day be
dropped.

Multiplexers have to be recognised by name (`TMUX`, `screen`, `herdr`) rather than
by asking, and that is worth explaining because it looks like a shortcut. A
multiplexer runs the game on a pty of its own and passes the environment straight
down, so inside a herdr pane `TERM_PROGRAM` still reads `ghostty` — and a graphics
query sent into the pane reaches Ghostty, which answers truthfully about *itself*.
The game would then hold an `OK` from a terminal it is not talking to. No amount
of asking gets round that; only knowing the name does. `TILE_MODE=kitty` forces
past it for a multiplexer that really does implement the protocol.

The same list decides whether frames are bracketed in DEC 2026, and that came from
a report of the map not drawing *at all* inside herdr — in glyph mode, where there
are no graphics escapes involved. The game leans on exactly two things an ordinary
TUI does not: the alternate screen buffer, and a synchronized update around every
write. Turning off either one fixed it, so neither is unsupported on its own; it
is the pair that parser cannot follow. Bracketing is the half worth giving up,
being an optimisation against flicker rather than something the game needs to be
usable — where the alternate screen is what stops it painting over your scrollback
and hands your shell back on exit. `SYNC_OUTPUT=1` puts it back. Sprites are
procedures over the unit square rather than a bitmap, so tile size is a free
choice; both renderers consume the same composed scene, so lighting, field of
view, autotiling and the minimap overlay are shared and cannot drift apart.

The layout above is what makes this possible. Ink cuts a row of Unicode
placeholders in half the moment anything shares the screen line with it, so the
map has to own every column of its rows — which is why the panel that used to sit
beside it is now a top bar, an overlay composited into the frame, and pages that
take the whole screen.

A frame is three or four megapixels, so the pixel path is measured rather than
guessed at. `npm run pixel-bench` times it stage by stage, and
`npm run capture && npm run analyze` runs the built game under a real PTY and
reports what actually went down the wire — how many tiles each row carried, and
how many times the terminal was asked to present. The second number is the one
that shows as flicker: the image and the frame that displays it have to reach
the terminal inside a single synchronized update, or every step is presented
twice.

A frame used to be drawn at the map's own screen resolution, so a large window
decided its size rather than anything the game chose — and that got out of hand
fast. At 163x70 cells with a 19x42 cell it came to eight megapixels: 24MB of raw
RGB, sent again on every keypress for the terminal to inflate and turn into a
fresh texture. Hold a direction key and that is hundreds of megabytes a second,
and it took Ghostty down. A frame is therefore capped at four megapixels
(`FRAME_PIXELS`), past which the tiles are *drawn* smaller and the terminal scales
the image back into the same cells.

That cap was a floor under the damage rather than a fix, because the window still
decided everything above it, and in the wrong direction twice over:

```
100x30 cells -> camera  50x26 tiles, tile drawn 38px (full)
163x37 cells -> camera  81x34 tiles, tile drawn 38px (full)
200x64 cells -> camera 100x64 tiles, tile drawn 25px
240x80 cells -> camera 120x70 tiles, tile drawn 21px   <- 55%, upscaled back
```

A bigger screen showed *more* world at *lower* resolution — a person walking a
road filled a third of a laptop window and was a speck on a monitor, and the tile
art nobody could make out was being paid for in full. So the pixel map stops at
`FOV` tiles and centres in whatever is left over. Every window past the cap now
draws the same 72x32 tiles at the same size, sharp, for a fixed 3.3 megapixels:
20ms a frame against 30ms before, and against however much a 240-column window
felt like asking for. Bigger tiles are `+`, not a bigger terminal.

None of that reasoning applies to glyphs, and the cap does not either. Every line
of it is about pixels — the megapixels a frame costs, the budget that shrinks
tiles to fit, the zoom that buys size back — whereas a glyph tile is two columns
and one row and there is no bigger to trade up to. Capping it there shows less
world at exactly the same size and spends the rest of the terminal on margins; on
a 300x90 window that was a 144-column island twenty-five rows down an otherwise
empty screen, which does not read as a layout decision. The glyph map fills the
window, as it always has.

Frames are also coalesced. One costs about 20ms and a terminal's key repeat is
faster than that, so a render per keystroke — each starting inside the stdin
handler that delivered the key — left the display steadily behind the player's
fingers and still moving after they let go. `FRAME_MS` is the shortest gap between
two frames; every keystroke still reaches the engine immediately and in order, and
what is dropped is only the intermediate pictures.

The other thing that felt like the renderer was not the renderer at all.
Generating a chunk costs about 28ms, and a step used to prefetch a 5x5 square of
them inside its own dispatch — free while they were all cached, and about 140ms of
dead process the moment the player crossed a chunk seam. The ring is now built one
chunk per turn of the event loop (`CHUNK_SLICE`), nearest first, so the total work
is unchanged and the longest pause it can cause is one chunk rather than five.

If it still flickers on your terminal, the next levers are the payload —
`KITTY_DEFLATE=6` roughly halves the bytes for more CPU, `ZOOM=0.8` reduces both,
and `FRAME_PIXELS=2000000` halves the picture again.

## Choosing what to play

`npm start` opens a title screen with two ways on:

```
╭──────────────────────────────────────────────────────────────────────────────╮
│                                                                              │
│             ▄▀█ █░█ ▀█▀ █▀█ ▄▀█ █▀▄ █░█ █▀▀ █▄░█ ▀█▀ █░█ █▀█ █▀▀             │
│             █▀█ █▄█ ░█░ █▄█ █▀█ █▄▀ ▀▄▀ ██▄ █░▀█ ░█░ █▄█ █▀▄ ██▄             │
│                An endless world, written as you walk into it.                │
│      by Michael Shafir · produced with the help of large language models     │
│                                                                              │
│                  ──────────────────── ◆ ────────────────────                 │
│                                                                              │
│                             ❯ Continue  7 worlds                             │
│                               New world                                      │
│                               Quit                                           │
│                                                                              │
│                       ↑↓ move · ENTER choose · Q quit                        │
╰──────────────────────────────────────────────────────────────────────────────╯
```

Every page here takes the whole screen inside a border, the way the game's own
reader and card screens do, so the front door looks like the same piece of
software as the thing behind it.

**New world** offers the scenarios already written, and under a rule, one way to
have another written. That used to be four choices — briefed, unguided, without a
model, or a written scenario — which was four points on one axis pretending to be
four kinds of thing. The axis is how much of the world is decided before you walk
into it, and the far end is the only end worth being at: a world with a plotted
story, named people and written conversations beats one that invents them as you
arrive, and it costs a wait rather than a compromise.

**An unwritten world** is the other way in: ground in every direction and towns named and
populated as you reach them. With a key that naming is done by a model; without one it comes
out of the flavour tables, which is free, offline, and the same world every time for a given
seed. Nothing is decided until you get there, which also means nothing is waiting for you.

What this page deliberately does *not* offer is writing a world. Authoring happens at
development time now, by an agent driving a CLI over a scenario directory, and what it
produces appears on the shelf above like anything else. The row that used to promise "a few
minutes" ran a ten-pass pipeline whose whole middle section existed to argue a story into
agreement with a world it had never been shown — and the worlds it produced had people in
them asking after documents that were nowhere.

**Continue** is a grid of cards, as many across and down as the terminal allows,
scrolling by whole rows when there are more worlds than fit. Each says how far in
it is, where you were standing, when you last played it in words ("yesterday",
because a wall-clock timestamp makes the reader do the subtraction) and either
the scenario it came from or the date it was made. `D` deletes one, behind a
confirm — the first way to do that short of knowing where the game keeps its
files.

ESC goes back a page throughout, and back from the title is quitting.

The banner comes from `assets/ui/title.txt` in three sizes and is coloured with a
diagonal ramp, quantised so a wide row costs a dozen escape sequences rather than
seventy-seven, and degraded by colour depth — this is the one screen drawn before
anything has been asked of the terminal, so it has to look deliberate on sixteen
colours too. The widest size that fits *both* the width and the height is used,
and below the smallest it falls back to the plain words: a wrapped banner does not
read as a small title, it reads as a rendering fault, on the first screen anybody
sees.

Two cases skip the menu, because a menu would be wrong for both: naming a slot
with `WORLD_NAME` (the caller already knows which world it wants) and having no
TTY (nothing can answer it). Both resume that slot and create it if absent, which
is what every invocation did before there was anything to choose between.

Starting a new world never lands on an existing slot — the name is derived and
then made unique. Each new world also takes its seed from its slot name, so two
new worlds are two different worlds rather than the same one twice; `WORLD_SEED`
still wins when it is set.

## Asking for a particular world

By default the model invents a premise on first contact. `SCENARIO_PROMPT` tells
it what you actually want instead:

```
SCENARIO_PROMPT="a drowned archipelago run by debt-collectors" \
  SCENARIO_AVOID="dragons" npm start
```

A brief is *intent*, never geometry. It cannot move a coastline or place a town —
the engine still decides what exists, exactly as it does with no brief at all.
The brief only reaches the calls that name and populate what the engine already
built, so an unsatisfiable brief gives you a differently-flavoured world rather
than a broken one.

A brief belongs to the world, like its seed: it is written into the save, so a
resumed world keeps generating in the same key rather than reverting to the
default premise for every region found after the reload. That also means the
environment cannot re-brief a world that already has one — start a new save slot
instead. A world that has *no* brief will adopt a configured one.

## Written scenarios

A scenario is a whole world authored ahead of time — premise, regions, towns, people, story,
conversations and cutscenes all written down before you play, so **no model call happens
while the game runs**. It is a directory:

```
.scenarios/the-drowned-abbey/
  scenario.json      seed, recipe, bounds, spawn, packs
  story.md           the premise expanded, for people to read
  world/             sites, authored ground, items and gates
  phases/            later chapters, as diffs
  scenes/            cutscenes
  trees/             one conversation per file
```

A directory rather than one file because a scenario is something that gets *edited*. As a
single blob, every change was a rewrite of several hundred kilobytes: the diff was one
enormous line, and a review could not tell a corrected sentence from a rebuilt world.

Both kinds of content live in the repository and are committed:

| `.packs/` | flavour packs — names, households, trades, the ambient lines |
| `.scenarios/` | whole authored worlds |

In the repository rather than under your home directory because they are *source*. A pack
decides what everybody in a world is called and what they trade in; a scenario is
hand-editable JSON keyed to a seed, and every way it can go wrong is silent at runtime — a
site id the seed does not produce is a town that never gets its name, and nothing anywhere
reports an error. Content you can read in a diff is content you can review.
`AUTO_ADVENTURE_PACKS` and `AUTO_ADVENTURE_SCENARIOS` redirect either one elsewhere.

A scenario names the pack it is peopled from rather than embedding a copy. The tables are
folded in when it is read, so what a *save* records is the names themselves — deleting a
pack next month cannot rename anybody you have already met.

Two things make a written world better than a live one rather than merely cheaper. First,
nothing arrives late: every spec is in the state the engine starts from, so the first frame
shows the authored town, and the whole late-spec-rebuild-commitment problem does not exist.
Second, the generator is pure and runs offline, so a checker can execute the real thing over
a scenario and prove what a live director structurally cannot — that the person the story
hangs on is standing at an anchor that actually got built, that the town they were assigned
to exists, that the road between two beats can be walked inside the boundary, and that a
cutscene's actors can reach the places it sends them.

A scenario is bounded, and the edge is made of deep water, cliffs or mountains, chosen to
suit the ground it is drawn on and placed so that it cuts no settlement in half.

A written world puts up its own signposts, and they cost nothing: the arc knows which towns
the story walks between, so a board goes up on the road out of each one with the next place
on it. The direction and the distance are worked out from where that place actually is,
every time you face the post — there is no field in a scenario file for a compass point,
which is the only way to be sure a board never points the wrong way. It matters because an
open errand only gets a bearing on the map once you have *been* to the town it is in, so the
case with no marker at all is exactly the case you need one for.

### Chapters and cutscenes

A scenario can change. `phases/` holds later chapters, each a **diff** over the world before
it — this NPC is gone, this conversation is replaced, there is a body in the millrace now, a
lane has been trodden between the two towns. A chapter is entered when its condition holds,
and which one is in force is derived from the flags rather than written down, so a chapter
file can be corrected while somebody is halfway through the world.

`scenes/` holds cutscenes: the world takes over, the camera pans to the gate, a rider walks
in and says the abbey has fallen, and then you have the world back and it is a different
one. A story told only through conversations is a story nobody can see.

Full reference in [`docs/scenarios.md`](docs/scenarios.md).

### How one gets written

By an agent, at development time, driving a CLI — not by the game.

There used to be a row on the launcher promising a world in a few minutes, and behind it ten
model passes. Most of them existed to negotiate between a story a model had already written
and a world that was never consulted: one added the conversations that were missing, one
moved what collided, one rewrote objectives the world could not satisfy, one dropped side
errands that would not open, and the last read the result and reported what it still could
not believe. The worlds it produced had people in them asking after documents that were
nowhere, and no number of repair passes fixes that, because the disagreement is the design.

The rule now is that **the only way to assert a fact about the world is to call a tool that
makes it true** — so a story cannot mention a ledger unless a ledger exists, in a container,
in a building, in a named town, at real coordinates.

Authoring starts with the survey, which costs nothing because the generator is pure:

```
npm run survey -- --seed abbey --duration short   # every town, its size, its ground
npm run validate                                  # check what is installed
npm run validate -- --deep                        # and play each story to the end
```

`--deep` is the strongest check available. Everything else reasons *about* the files; this
builds a real session and walks the story through the real engine — travelling between the
towns the beats name, opening the doors of people who are indoors, holding the
conversations, sitting through the cutscenes, and asking at the end whether the story is
told. It is the only way to find out that the person a beat hangs on is not actually
standing in the town written for them, which every static check will call fine.

## Playing without a model

There are two ways, and the better one is a **written scenario**. A pre-generated
scenario is a whole world — country, towns, people, plot and conversations — that
was paid for once and now runs entirely offline. The ones in `.scenarios/` need no
key and make no calls, so with no key at all the launcher still opens straight onto
a playable story.

The other is an endless generated world with no story in it:

```bash
NO_AI=1 npm start
```

That is a supported way to play, not a degraded mode. Every place still gets a
name, every settlement still gets people with roles and things to tell you, and
conversations are real dialogue trees built from what those people know. What is
missing is a story tying it together — which is what the model is for, and why the
launcher no longer offers this as a menu entry: given the choice between a world
with a plot and one without, there was no reason to put them side by side. The
variable is still the way in for anyone who wants the endless version.

`NO_AI=1` ignores the brief, because nothing reads it: there is no model to steer.
