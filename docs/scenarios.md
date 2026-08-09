# Scenarios

A scenario is an answer to the question "what is this world *about*?" — supplied
up front rather than discovered as the player walks.

Today a world has a premise the model invents on first contact
(`lorePrompt()` takes no arguments) and a story that emerges, if it emerges at
all, from whatever an NPC happened to improvise. That is the right default for an
infinite world, and it stays the default. But it makes two things impossible: you
cannot ask for *a particular* story, and you cannot play a good one twice.

Scenarios add both, in three flavours that differ only in **when** the authoring
happens.

| Flavour | Authoring | Model at play time |
|---|---|---|
| `procedural` | none — deterministic fallbacks | never |
| `live` | during play, in the background | yes |
| `prebuilt` | ahead of time, into an artifact | **never** |

`procedural` is today's `NO_AI=1`, unchanged. `live` is today's default plus a
brief. `prebuilt` is new: every model call has already happened, the results are
in a file, and the game is a pure function of that file.

## Why this is cheap

Every model output in the game already passes through one of four typed shapes,
and three of them are already persisted with a deterministic fallback behind
them:

| Shape | Produced by | Persisted as |
|---|---|---|
| `WorldLore` | `Director.ensureLore` | `state.lore` |
| `RegionSpec` | `Director.ensureRegion` | `state.regions` |
| `SiteSpec` | `Director.resolveSite` | `state.sites` |
| `DialogueTurnResponse` | `dialogue.ts` | — (interactive) |

`Director` already accepts `{lore, regions, sites, sources, disabled}` in its
constructor. **A prebuilt scenario is a pre-populated version of those four
fields.** There is no second Director, no alternate generation path, and no new
branch on the movement path — `prebuilt` is `disabled: true` with the answers
already in hand.

It also gets a property no other flavour has. In `live`, a spec arriving late
triggers `rebuildSite`, and the commitment rule in `Director` exists precisely to
stop a town rearranging itself around a standing player. In `prebuilt` every spec
is present before the first frame, so there is no late spec, no rebuild, and no
commitment race. The town the player walks into is the authored one, always.

The genuinely new runtime component is scripted dialogue — and `canned.ts`
already proves its shape: a deterministic provider returning
`DialogueTurnResponse`. Authored trees are a richer sibling of it, not a new
subsystem.

## The brief

The brief is shared by `live` and `prebuilt`, which is what makes "guide a live
world's generation" fall out of this work rather than being a second feature.

```ts
interface ScenarioBrief {
  readonly premise?: string;      // freeform, the main knob
  readonly setting?: string;      // "a drowned archipelago of debt-collectors"
  readonly storyline?: string;    // "find a sibling who joined the tithe-ships"
  readonly tone?: string;
  readonly protagonist?: string;
  readonly avoid?: string;
  readonly duration?: Duration;   // "short" | "medium" | "long"
}
```

`premise` is freeform and is what most people will use — `SCENARIO_PROMPT`, or
one text field in the launcher. The rest refine it. It lives in
`core/world/brief.ts` rather than `src/scenario/`, for the reason `spec.ts`
already gives for `WorldLore`: it is persisted in `GameState`, and core cannot
depend on anything above it.

Every prompt normalises its own brief instead of trusting the caller. Briefs
arrive from environment variables, a launcher field and artifact JSON, and a
whitespace-only field from any of them has to read as silence — a brief that says
nothing must leave the default prompts byte-identical, or every world that
predates briefs would start generating differently.

The injection point is `prompt.ts`, and the house rule there does not change: the
model is *naming and populating a place the engine already built*. A brief adds
intent, never geometry. `lorePrompt(brief?)` replaces the hardcoded premise;
`regionPrompt` and `sitePrompt` gain `brief` and, in `prebuilt`, the site's role
in the arc.

A `live` world persists its brief in `state.brief`, so a resumed world keeps
generating in the same key rather than reverting to the generic premise on the
next region it reaches.

## Duration

Duration is the only field that means something mechanical, because in a bounded
world narrative length and spatial extent are the same knob.

| | beats | footprint radius | walking | estimate |
|---|---|---|---|---|
| `short` | 3 | 4 chunks | ~1500 tiles | ~30 min |
| `medium` | 6 | 6 chunks | ~4500 tiles | ~1.5 hr |
| `long` | 10 | 9 chunks | ~12000 tiles | ~4 hr |

The estimate is checked rather than asserted. Validation paths
`spawn → beat₁ → … → beatₙ` with A\* over the *bounded* world and warns when the
result is more than 40% off the table. At radius 9 that is a 1216² grid per leg,
which is fine offline but is the slowest thing in the pipeline — path over a
downsampled passability grid first and only go full-resolution when the coarse
path fails.

Tiles-per-minute is a guess about the player, not a fact about the world. Treat
the estimate as an ordering, not a promise.

## The artifact

One versioned JSON file, self-contained and shareable.

```ts
interface ScenarioArtifact {
  readonly artifactVersion: 1;
  readonly id: string;
  readonly title: string;
  readonly blurb: string;
  readonly brief: ScenarioBrief;

  readonly seed: number;                     // authoritative — see below
  readonly spawn: { x: number; y: number };
  readonly bounds: WorldBounds;

  readonly lore: WorldLore;
  readonly regions: Record<string, RegionSpec>;
  readonly sites: Record<string, SiteSpec>;
  // Added, optional, in phases 5 and 6 — a v1 reader ignores what it does not know.
  readonly arc?: ScenarioArc;
  readonly trees?: Record<string, DialogueTree>;
  // Added, optional, in the gameplay pass. Same rule: everything is optional, so an
  // artifact written before any of it existed still loads and still plays.
  readonly triggers?: Trigger[];          // condition -> effects
  readonly barriers?: Barrier[];          // gates across the world
  readonly placements?: Placement[];      // particular things in particular places
  readonly time?: TimeOptions;            // whether this world has a clock at all

  readonly authoredWith: {
    readonly models: Record<string, string>;
    readonly calls: number;
    readonly at: string;
  };
}
```

**The seed lives in the artifact, not the environment.** This is load-bearing.
Site ids are `hash32(seed, 0x51e0, mx, my)`, so an artifact loaded against a
different seed would key its specs to sites that do not exist — a world of
correctly-named towns standing in the wrong places, or nowhere. `WORLD_SEED` is
ignored when a scenario is loaded, the same way a save's own seed already wins
over the configured one.

Dialogue trees key off `npcId(siteId, slot)`. Both halves are deterministic —
the site id from the macro hash, the slot from the array index `resolveSite`
assigns — so tree keys are computable at authoring time with no runtime
cooperation at all.

## Conditions

Everything gateable in a scenario is gated by one shape, and it is a predicate over
state the game already records:

```ts
type Condition =
  | { all: Condition[] } | { any: Condition[] } | { not: Condition }
  | { flag: string; equals?: string | number | boolean }
  | { item: string; atLeast?: number }
  | { quest: string; is: "open" | "done" | "absent" }
  | { talked: string }                          // an npcId spoken to at all
  | { visited: string }                         // a place name stood in
  | { reputation: string; atLeast?: number; atMost?: number }
  | { disposition: string; atLeast?: number; atMost?: number }
  | { hour: { from: number; to: number } }      // wraps across midnight
```

No leaf asks about anything that was not already durable. `visited` reads the flag
`recordArrival` writes on every first arrival; `talked` reads the NPC's own
`totalTurns`; `item` calls the same `itemCount` that decides a `have` objective. So
there is nothing new to keep in step, and a condition cannot ask a question the save
cannot answer after a reload.

Anywhere a `requires` field appears — a beat, a dialogue node, a dialogue choice — a
plain list of flag names still works and still means "all of these are set". That
spelling is better for the commonest case and every artifact already on disk uses it;
`asCondition` lowers it.

**A condition on a flag nothing sets is the failure mode to watch for.** At runtime
it is simply false forever, which is indistinguishable from content the player has
not reached yet: no error, no symptom, and a story that dead-ends four hours in.
`validateArtifact` refuses those, and `flagsWritten` is deliberately generous about
what counts as a writer — beats, triggers, written dialogue, cards, barriers, and the
engine's own `visited:` / `card:` / `looted:` / `trigger:` / `arc:branch:` prefixes.

## Triggers

The piece that makes the rest compose:

```json
{ "id": "saw-the-bastion",
  "when": { "visited": "Stonewait" },
  "effects": [{ "t": "SetFlag", "key": "saw:stonewait", "value": true }] }
```

Checked after every command, in the same settled position as the arc's own ending
check, and interleaved with quest verification and arrival recording — because each
can be what the next was waiting for. Arriving somewhere sets the flag a trigger
watches; a trigger granting the ledger ticks a `have` objective; an errand closing is
what another trigger was waiting for. All three resolve within the one command.

Deliberately not an event bus. A trigger is a condition over *state*, so an author
never has to know which command caused a thing to become true, and a trigger cannot
be missed for having been registered after the event — the same reasoning that makes
`verifyQuests` re-check objectives rather than trust a model to announce progress.

`once` defaults to true. A repeating trigger whose effects do not change its own
condition would otherwise fire forever, so the pass is bounded at
`MAX_TRIGGER_PASSES` rather than run to a fixed point.

Effects are a deliberate subset of `DomainEffect` — everything an author would want
to cause, and none of the engine's own dialogue bookkeeping, so a file cannot
fabricate a relationship the player never had.

## Locked doors, and gates

Two different things, because a barred shop and a barred road behave differently.

A **lock** sits on a structure in a site's roster and refuses the transition into its
interior. Nothing is written down: the door was already drawn closed, the player
simply does not go through, and a regenerated chunk is locked again for free because
the lock travels with the spec.

```json
{ "kind": "tower", "size": "medium", "importance": 5, "name": "The Warden's Hall",
  "lock": { "opensWhen": { "flag": "arc:the-second-weight" },
            "lockedText": "The Warden's Hall is shut. Cull carries the key on him." } }
```

A **barrier** is a gate on tiles in the open world. It has to change the map and stay
changed, so it is the one authored thing that writes a `ChunkDelta` — which is
already what deltas are for. The generator stamps `gateClosed` at every barrier tile
unconditionally; opening one writes `gateOpen` into the delta and records
`barrier:<id>`. The generator therefore never learns what the player has done.

```json
{ "id": "stonewait-gate",
  "tiles": [{ "x": -104, "y": -93 }, { "x": -103, "y": -93 },
            { "x": -102, "y": -93 }, { "x": -101, "y": -93 }],
  "opensWhen": { "flag": "arc:the-short-tally" },
  "lockedText": "A barred gate where the road narrows between the crags.",
  "opensText": "The bar lifts, and the gate swings inward." }
```

**`tiles` is a list because a road is rarely one tile wide.** A gate on the middle
tile of a three-wide cobbled road is not a gate: the player steps onto the verge and
back on. One flag covers the whole span, so the whole span lifts together.

The validator does the part a look at the map cannot: with every gate in the scenario
shut, it asks whether one side of the span can still reach the other, four-connected
because the player is. A detour of a handful of tiles is an error — the span does not
cross the way through. A long one is a warning with the number in it, because a gate
in a pass with a two-hundred-tile detour round it is a real gate and only the author
can say whether that is the point.

Gates want choke points, and a world may not have many. Searching for one is worth
doing before writing the gate rather than after.

**Open a gate on the gatekeeper, not on an arc flag.** `beatOpenedBy` fires at the
moment of a conversation, and only if the beat's requirements hold *then* — so a player
who talks to people in an order nobody anticipated loses that beat silently, and a gate
waiting on its flag stays barred with nothing on screen to explain it. That shipped: a
porter said the right thing while his gate never opened, because the beat the gate was
gated on belonged to a knight the player had met too early.

```json
{ "opensWhen": { "talked": "npc:3839432062:2" } }
```

`{ "talked": ... }` asks about the conversation itself and cannot be missed. The same
argument gives any beat the story cannot proceed without an `opensOn`, which is checked
after every command rather than only during a conversation:

```json
{ "id": "the-porters-gate", "opensOn": { "visited": "Hautdesert" } }
```

## Special items in specific places

The generator already fills every crate and hedgerow, but only with *typical* items.
A placement is how a scenario says "the ledger is in the chest in the mill", which is
the sentence most stories are built out of.

```json
{ "id": "the-lead-standard",
  "at": { "kind": "site", "siteId": 2528282773, "structure": "tower" },
  "item": { "name": "Lead Standard", "description": "Crown-stamped, and half an ounce light." },
  "requires": { "flag": "arc:the-second-weight" },
  "emptyText": "The straw where the standard sat is still pressed flat." }
```

Three spellings of `at`, in descending order of how much the author has to know: an
exact `world` tile, an `interior` position, or a `site` and a structure kind. The last
is the only one writable from the story alone, and it is resolved against the real
generated settlement when the world opens — so an unresolvable one is a finding
rather than an item that is quietly nowhere.

Implemented inside the existing search gesture rather than beside it: the placement
index is consulted *before* `containerContents` and `forageAt`. So an authored item
inherits the whole path — the empty message, `have` objective resolution — without
needing its own verb. It also means `obtainableItems` has to know about placements, or
the validator would refuse a fetch quest for the very item the scenario placed to be
fetched.

`requires` is what makes "the body is in the millrace, *after* the flood" expressible:
searched beforehand, the tile falls through to whatever is really there.

**Taking one is recorded under `taken:<placement id>`, not under the tile.** Sharing
the container's `lootKey` was a silent, unwinnable bug in both directions. A gated
placement sits on a tile the generator already furnished, so a player who searched the
shelf *before* the story put anything in it emptied it — and when the item appeared a
minute later, the flag saying "you have been through this" was already set. The errand
became impossible to finish, in a room the quest log was pointing at, with prose about
folded linen where the item should have been. The other direction: a positional key is
only stable while the resolver keeps choosing the same tile, and it does not — the axe
at Camelot moved the day the resolver learned to prefer a container the player could
actually reach.

**`showDecor` is what makes a promised item findable.** Off by default, which is right
for something inside a crate the player would open anyway — marking those gives away
which crate in the warehouse matters. It is wrong for anything a line of dialogue tells
the player to go and fetch. *"Take it afterwards if you have the legs for it"* pointed
at an unmarked tile two storeys down a three-level cave.

**An item is not findable just because it is obtainable.** This one cost a real
playthrough: the shipped scenario gated its third act on carrying the Lead Standard,
the standard was sitting in a locked tower the player had every right to open, and
nothing in the game ever said the standard existed. Every other check passed — the
flag was written, the placement resolved, the item was obtainable — and the errand log
went empty with nowhere to go.

So `checkFindability` refuses a condition on `{ item: X }` unless *something* points
the player at X: an errand that asks for it by name, a conversation that hands it over,
or the name appearing in prose the player will actually read. The third is a substring
match, which is loose — but the failure being caught is "the name appears nowhere at
all", and for that a loose test is the right one.

## Conditional people

`NpcSpec.requires` keeps somebody out of the world entirely until the story brings
them on — not standing elsewhere, but absent: not drawable, not walk-into-able, not
resolvable by id, and not offered to the dialogue layer as somebody who is here.

Their station is still reserved while they are away, because the gate is applied when
the roster is *indexed* rather than when it is placed. A courier who arrives in
chapter two must not find their doorstep taken by whoever was shuffled into it.

**Bring them on when their scene does.** A `requires` weaker than the beat they anchor
puts somebody on stage early, talkable, with nothing behind them — which reads as a
broken quest rather than as a wait. The Green Knight appeared when the covenant was
sworn and anchored a beat two beats later, so a player who rode straight for the mound
got the entire finale delivered at them and nothing happened.

Two fixes, and the second is usually the better story:

- gate them on the beat's own condition, so they simply are not there yet; or
- give their tree an opening conditioned on the beat *not* having happened, which turns
  arriving early into a scene — *"Early, sir. Look at your hands, there is nothing in
  them."* — and sends the player back with a reason.

`checkEarlyCast` warns about the first case and is silenced by either fix. Ungated cast
are exempt: somebody with no `requires` is permanent scenery and precedes every beat by
construction.

## Branching, sub-errands and side errands

Four additions to the arc, all small on purpose.

**Sub-errands.** A new objective kind, `quest`, whose target is another errand's id,
satisfied when that errand completes. `verifyQuests` re-checks it after every command
like everything else, so a parent closes the moment its last child does — with no
model, trigger or beat having to notice. `Quest.parentId` is display only: it is what
lets the errand pane show one job with three parts rather than three unrelated jobs.

**Side errands.** `ScenarioBeat.optional` keeps a beat out of `remaining` and out of
whether the arc is `finished`, so a story can end with side quests still open.

**Forks.** Beats sharing a `branch` group are mutually exclusive. Opening one records
`arc:branch:<group> = <beatId>` and bars its siblings for good — permanently, and
without a warning, because a fork the player can back out of is a menu.

`arcOutline` excludes the arm not taken from the main-line count. Without that,
`remaining` would sit above zero forever: the barred arm can never open, so the story
would read as unfinished after it had finished.

The validator's job here is precise. A fork is fine; what breaks is a *downstream*
beat gated on a flag only one arm sets. Take the other arm and that beat can never
open. That is an error, per arm, by name.

**Forked outcomes.** `arc.endings` is an ordered list; the first whose `when` holds
wins, and an entry with no `when` is the catch-all. Ordered rather than scored,
because an author writing "the grim one if the mill burned, otherwise the quiet one"
has already said which comes first. Each ending's card id is its own, so the read-once
flag is per outcome.

**An ending card is an epilogue, not the scene.** A fork whose only consequence is the
last page is a fork the player experiences as being ignored, and it fails in a way
nothing structural catches: both arms open, both endings pick correctly, every flag is
written and read. The scenario this was learned on had one finale speech, written for
the arm that kept the girdle, so a player who handed it over was told to his face that
he had failed the third test — and then shown a card congratulating him. The king said
the same thing a minute later.

Branch the dialogue too. Two openings on the anchor, gated on the arms:

```json
"entryAfter": [
  { "node": "returned-clean", "when": { "all": [{ "flag": "arc:done" }, { "flag": "girdle:given" }] } },
  { "node": "returned",       "when": { "all": [{ "flag": "arc:done" }, { "flag": "girdle:hidden" }] } }
]
```

Mutually exclusive conditions rather than an ordered list of increasingly specific
ones: `openingNode` takes the first that holds, so a general opening listed before a
specific one silently shadows it. `checkForkIsSpoken` warns when no dialogue node or
choice in the whole scenario is conditioned on either arm.

**Beats that open on their own.** `opensOn` lets a beat arrive without anybody
speaking — walking into the burnt mill, or finding the ledger. Evaluated in the same
settled pass as triggers, so it lands in the command that made it true rather than on
the next step. The NPC anchor stays required, because that is what the validator
checks against and what a later conversation about the beat hangs off.

## The draft says all of it

Everything on this page is a field of `ScenarioDraftSchema`, so a scenario is one file
and one command. That was not true until recently: the newer vocabulary lived only in
the artifact, so the loop was *assemble once, hand-patch the JSON, then never
re-assemble* — because re-running the tool discarded every edit without saying so. A
scenario that cannot be regenerated from its source is a scenario nobody can change.

`drafts/green-chapel.json` is the proof and the worked example: it assembles to the
shipped artifact byte for byte, and `green-chapel-live.test.ts` asserts that it still
does. Two things are still derived rather than written, on purpose — beat order and
gating flags — and one of those is worth reading about before writing a fork:

**Do not write `requires` at a fork.** Assembly derives it, including the two cases
that are easy to get wrong. An arm waits on the beat *before* the fork rather than on
its sibling, or it can never open at all. And the beat after a fork waits on
`{ any: [both arms] }`, because waiting on one arm dead-ends the other and waiting on
the pre-fork beat lets the fork be skipped — which leaves `remaining` above zero for
good, since neither arm was ever barred.

## Editing a scenario somebody is playing

`arc`, `triggers`, `barriers` and `placements` are all re-read from the artifact when a
world is resumed, not only when one is created. Without that, fixing a scenario
somebody is halfway through means telling them to delete their save.

Progress is unaffected: which beats have opened lives in the flags, what has been taken
in `looted:`, which gates are open in `barrier:`. None of that is in the arc.

The honest limit is quests. An errand the old arc already handed out keeps the
objectives it was created with, because a quest is state and rewriting one under a
player would un-finish work they had done. So an edit reaches beats not yet opened, and
an errand already in the log stays as it was — which is worth knowing when the fix *is*
a changed objective.

### Checking one after you have edited it

```
npm run validate -- --scenario green-chapel     # one
npm run validate                                # every scenario on disk
npm run validate -- --deep                      # and play each of them to the end
```

`assemble --check` validates a *draft*; this runs the same offline pass over what is
**installed**, and exits non-zero on errors so it can gate a commit. Worth having even
now that a draft can say everything, because an artifact can be hand-edited, produced
by an older build, or assembled against a generator that has since moved.

`--deep` is a different kind of check, and the strongest one available. Everything else
reasons *about* the file; this builds a real session and walks the story through the real
engine — teleporting between the towns the beats name, opening the doors of the people
who are indoors, holding the conversations, and asking `arcOutline` at the end whether the
story is told. It is the only way to find out that the person a beat hangs on is not
actually standing in the town written for them, which every static check will call fine.

It reports what it had to be *given* as well as what it managed, and that line is the one
to read:

```
  given    gave "Lead Standard" so beat the-weight-in-hand could open
  walked 8 beat(s) to the end, with 1 hand-out(s)
```

A walker cannot search a crate it has no reason to open, so an item it could not obtain by
going somewhere or speaking to somebody is handed over and recorded. "Finished with three
hand-outs" is a weaker result than "finished", and saying only the verdict would hide the
difference behind a word.

## Turning the clock off

Not every game wants a time of day. A single-afternoon mystery or a dungeon crawl gets
a clock the player has to work around, and a village that empties at 22:00 is an
obstacle rather than atmosphere.

```json
"time": { "enabled": false }
```

Four switches, because they come apart in practice:

| field | off means |
| --- | --- |
| `enabled` | the hour never advances; it sits at `startHour` |
| `lighting` | no day/night tint (interiors keep their lamplight) |
| `schedules` | everybody stays at their work station |
| `weather` | no rain, fog or snow |

`lighting` and `schedules` default to whatever `enabled` is; `weather` defaults on
even with the clock frozen, because weather is sampled along the *tick* and the tick
keeps counting.

**The tick always keeps counting.** It is an action counter, not a clock — the journal
orders entries on it and the weather samples along it — so stopping it would break two
things that have nothing to do with the time of day. What a frozen clock does is stop
deriving an hour from it.

The top bar drops the clock and the day entirely rather than showing `08:00, day 1`
forever, which reads as the game having hung.

## The recipe: choosing the world instead of rolling for it

A scenario used to be able to say one thing about its world: the seed. That is not
control, it is a lottery ticket — you re-roll until something usable comes up and then
write the story around whatever you got. A **recipe** is the other half. It lifts the
constants the generator used to hold as module literals into data an author writes
down, so you can say *there is a town here*, *the sea is higher*, *the woods are thick
around Harrowmere*.

```json
"recipe": {
  "climate": { "seaLevel": 0.5, "moistureBias": 0.1 },
  "biomes": { "forest": { "scatterDensity": 0.8 } },
  "sites": { "weights": { "town": 0.5, "hamlet": 8 } },
  "places": [{ "at": { "x": 320, "y": -64 }, "kind": "town", "importance": 5 }],
  "zones": [
    { "id": "deepwood", "at": { "x": 320, "y": -64 }, "radius": 140, "moisture": 0.25, "scatter": 2.5 }
  ]
}
```

Every field is optional and every default reproduces the constant it replaced exactly,
so a scenario with no recipe generates the identical world it always did.

**Look before you write.** Both authoring tools take the recipe, so you can see what it
produces before committing a word of story to it:

```
npm run preview -- --seed thornwick --at 5,-2 --recipe my-recipe.json
npm run survey  -- --seed thornwick --duration short --recipe my-recipe.json
```

The file can be a bare recipe or a whole draft with a `recipe` in it — whichever you
happen to have open.

### climate

Moves the shape of the world before anything is built on it: `seaLevel`, `shoreLevel`,
`uplandLevel`, `alpineLevel` (which must ascend), `elevationBias` and `elevationScale`,
`moistureBias`/`moistureScale`, `temperatureBias`/`temperatureScale`, `latitudeBand`,
`roughnessScale`.

These move coastlines, so they move where towns can stand and where roads can run.
Raising the sea is how you get an archipelago; widening `elevationScale` is how you get
one continent instead of a scatter of islands.

### biomes

Per-biome overrides on the built-in table — `ground`, `groundAlt`, `scatterDensity`,
`scatter`, `habitable`, `name`. Partial: `{ "forest": { "scatterDensity": 0.8 } }`
thickens woodland and inherits everything else about a forest. Terrain is written by
key (`"sand"`, `"conifer"`), not by number.

### sites

`weights` is the **percentage of habitable macro cells** carrying each kind, and
`wildWeights` the same for ground too steep or too wild to live on. Percentages rather
than relative weights, because the interesting number is how much of the map is empty.
The defaults total 18%, and the schema refuses more than 80% — past that a map is not
more densely settled, it is one continuous suburb.

Also here: `radius` per kind (`{ base, perImportance }`), `maxImportance`,
`civilizationFloor` and `maxSlope`.

### roster and filler

What each kind of settlement is actually built out of:

```json
{
  "sites": {
    "roster": {
      "village": {
        "count": { "base": 8, "perImportance": 1 },
        "structures": [["farmhouse", 10], ["barn", 6], ["shrine", 3]]
      },
      "town": { "count": { "base": 11, "perImportance": 1 }, "walled": 3,
                "structures": [["tower", 6], ["temple", 5], ["inn", 5]] }
    },
    "filler": [["farmhouse", 6], ["barn", 3]]
  }
}
```

`count` is `base + floor(perImportance × importance)`, which is how a town grows by one
building per point of importance and a village by one per two. `walled` is `true` for
always or a number meaning "at this importance and above" — a fort is walled because it
is a fort, a town once it is big enough to be worth the stone. `structures` is weighted
and drawn from with replacement.

`filler` is separate because it answers a different question: what to put on a plot the
spec did not name. Filling from the site's own roster would arguably read better — a
fort padded with barracks rather than cottages — but it changes what every world
generates, so it is a thing to write down rather than a decision made on your behalf.

Rosters merge **by kind**. Naming the village leaves the hamlet exactly as it was.

The buildings you may name are the registered structure kinds, and the schema refuses
anything else — including `cave`, which the cave feature builds as the mouth of a
volume rather than something a roster asks for.

### places

A site put somewhere specific:

```json
{ "at": { "x": 320, "y": -64 }, "kind": "town", "importance": 5, "radius": 26 }
```

A place **replaces** whatever its macro cell would have rolled rather than sitting
beside it, and it keeps the id that cell would have had. That last part is the whole
reason it is keyed by cell: a `SiteSpec` names its site by id, so a roster written for
an authored town keys exactly as one written for a rolled town, and moving the town in
the recipe does not orphan everything written about it.

Two places in one macro cell (64 tiles) is an error — the second silently replaces the
first — and so is a place outside the boundary.

### zones

The "thick forest near this town" mechanism:

```json
{ "at": { "x": 320, "y": -64 }, "radius": 140, "moisture": 0.25, "scatter": 2.5 }
```

`moisture` and `temperature` are added to the fields; `scatter` multiplies the biome's
scatter density. All three are weighted by a smoothstep falloff, so the influence is
full at the centre and exactly zero at the rim, with no step anywhere in between.
Overlapping zones compound. `falloff` above 1 concentrates the effect near the centre.

That smoothness is not a nicety. Terrain is a pure function of position, and the reason
chunk seams cannot exist is that no stage has any notion of a chunk. A rectangle of
override would put a hard edge somewhere, and one chunk in the world would eventually
be generated with the edge running through it. A sum of smooth radial fields has no
edge to catch on.

**Zones cannot move elevation, and this is deliberate.** Elevation decides where the
sea is, where towns may stand and where roads may run. A local bump would drag a
coastline under a settlement that had already been placed against the unbumped field.
Moisture and temperature only reach biome classification and the weather, which is
where "make this stretch wetter" belongs.

### What a recipe is not allowed to do

The one hard limit: no feature may reach further than a chunk looks for one. Every
chunk consults `HALO` macro cells around itself, which is 128 tiles; a place with a
bigger radius would exist in the chunks near it and not in the chunks beyond. The
validator refuses it, because it is the single thing here that breaks the property the
whole generator rests on.

### The kinds of place a recipe can ask for

Beyond the settlements the generator always had — `hamlet`, `village`, `town`, `fort`,
`camp`, `ruins`, `landmark` — there are three built by their own generators:

| kind | what it is | what it needs |
| --- | --- | --- |
| `castle` | a curtain wall with one gap, corner towers, a keep and a ward | a square of level ground |
| `docks` | a quay, piers out over the water, boats, sheds behind | a shoreline with room to moor |
| `cave` | a mouth in a rock face, and levels underneath | a hillside |

**Each of them declines rather than compromising.** A castle that cannot find a square
of ground large enough builds nothing; a dock inland builds nothing; a cave on flat
ground builds nothing. An empty patch leaves the wilderness exactly as it was, which
is much better than a curtain wall with the low ground bitten out of it — that is a
castle you can walk into from three sides, and a scenario that barred its gate has
barred nothing.

They are weighted at zero by default, so they only appear where a recipe asks for
them — by weight, for a world of castles, or by `places`, for one in particular.

**The survey drops the ones that declined**, so nothing downstream ever writes a roster
for a castle that found no level ground. That is why raising a weight is safe: the number
you ask for is an upper bound, and the number you get is however many the ground allowed.
`surveyWorld` reports the shortfall as `declined`, and `npm run author` prints it — a
recipe asking for six harbours in a landlocked world says so rather than quietly
producing a smaller world than you asked for.

The generated path asks for these too. The shape pass (`src/ai/author/shape.ts`) turns
`strongholds` / `caves` / `harbours` — three coarse words a model picks — into weights,
so a world generated from a premise about a siege gets somewhere to lay one.

**A castle's gate is a choke point the scenario can bar.** The generator emits it as a
`gate` anchor and leaves it open, because a barred gate needs a condition to open it
and something to say when it will not, and inventing either is not the generator's
business. Put a `barrier` across the three tiles and the courtyard becomes genuinely
unreachable — that is a property the castle generator guarantees and the settlement
generator cannot.

### Adding a new kind of place

One file and one call:

```ts
registerFeature({
  id: "monastery",
  accepts: ["monastery"],
  bounds: (site) => ({ x: …, y: …, w: …, h: … }),
  build: (world, site, spec) => …,
});
```

Then add the module to `core/gen/features/builders.ts`. That list is the only place
that names the builders, and it exists because a builder registers itself when its
module is evaluated — so a module nobody imports is a site kind that silently
generates nothing. That is not hypothetical; it is what happened to every town in the
world the first time settlements went behind the registry.

`bounds` must actually contain what `build` writes. It is consulted to reject a site
cheaply, before building, so a patch that spilled outside would be clipped away in the
chunks that rejected it and drawn in the ones that did not.

### Adding a new kind of building

Buildings have a registry too, in `core/gen/features/structures.ts`, and one entry says
everything about a kind:

```ts
registerStructure({
  id: "granary",
  size: "large", importance: 2,
  materials: { wall: T.woodWall, cover: T.roof },
  sign: false,
  anchors: ["hearth"],
  plan: { size: [15, 11], floor: T.floorWood, wall: T.woodWall, furnishings: [ … ] },
  authorable: true,
});
```

That used to be eight places — walls and roof in `building.ts`, whether it puts a board
out beside it, which anchors it offers, how small a plot it will accept, the room in
`interior.ts`, plot size and plot priority in `fallback-spec.ts`, and who lives in it in
the content pack. There was no way to discover you had missed one except by walking into
the building.

The *list* of kinds was three lists — the `StructureKind` union, the director's
`STRUCTURE_KINDS`, and the fallback roster's keys — with no test tying any two together.
`STRUCTURE_KINDS` is what the model may say and what the scenario schema enforces, so a
drift between the first two was a scenario that validated and then generated a building
nobody had a plan for. It is now derived from the registry, and `authorable` says which
kinds an author may name — `cave` is the one that cannot, because the cave feature builds
it as the mouth of a volume.

**Registration is code, not data, and that is deliberate.** Interiors are cached under
`(seed, interiorId, kind)`. If a kind's plan could differ between two worlds open in one
process — which the launcher does routinely — that key would be wrong. A registered kind
is a build-time fact, identical in every world. A *world* that wants different buildings
says so in its recipe's [`roster`](#roster-and-filler), where it hashes into a key.

## Buildings with more than one room

An interior is a **complex**: a list of levels, generated as a whole and cached as a
whole. An inn has a guest storey, a mill has a loft, a tower has three rooms stacked,
and a cave has three levels of passages under it.

Stairs are the reason the whole complex is generated at once. The tile you go up from
and the tile you come down onto are the same coordinate, and the only way to guarantee
that from two independent generators is to have them agree — which is another way of
saying they are one generator.

A portal carries both what it looks like and where it goes:

```ts
{ kind: "up", to: 1, x: 1, y: 1 }
```

Both, because neither can be derived from the other: level 1 of a tower is *above*
level 0 and level 1 of a cave is *below* it.

Some consequences worth knowing when authoring:

- **The way out is on level 0 only.** A player three levels down cannot walk out of a
  wall.
- **Residents live on the ground floor.** Upstairs is a different grid that happens to
  share coordinates, and the same household standing in the same spots on every storey
  reads as a haunting.
- **A container upstairs is a different container.** The loot key includes the level
  above the ground floor, so emptying a chest on level 0 does not empty the one
  directly above it. Level 0 keeps the key it always had, so old saves still know what
  they looted.
- **Placements resolve on the ground floor.** `at: { siteId, structure, anchor }` finds
  the anchor on level 0. Putting something on an upper storey means naming the tile.

### It travels with the save

`recipe` sits on `WorldMeta` beside the seed and the bounds, for the same reason those
do: terrain is a pure function of `(seed, recipe, position)`, so a save that lost its
recipe would come back as a *different world* with the player standing in the middle of
it — a town displaced fifty tiles, a coastline where a road was.

## The boundary

A scenario is a bounded map, not a slice of an infinite world. The story needs to
know where it ends, and validation needs a closed region to reason about.

Two constraints shape the implementation. The flags byte is fully allocated, and
`flags.ts` asks that new state be derived from terrain where it can be — so
**there is no `Boundary` flag**. The band is made of terrain that is already
impassable: `deepWater`, `cliff`, `mountain`, none of which carry `Passable`.
Three styles, not the four first sketched — a chasm has no terrain to be made of,
and a style the renderer cannot express is not a style.
This also makes it unbreakable for free. The rewrite removed runtime
wall-breaking outright (`settlement.test.ts`: "the old design let the player
punch through stone when an objective was unreachable"), so nothing in the game
mutates terrain for passability and nothing can open the band.

```ts
interface WorldBounds {
  readonly minX: number; readonly minY: number;
  readonly maxX: number; readonly maxY: number;
  readonly style: "ocean" | "cliffs" | "mountains";
  readonly thickness: number;   // ~6-10 tiles
}
```

`GenContext` gains an optional `bounds`, and `generateChunk` gains one stage:

> **S9 — boundary.** Runs after the settlement patches are stamped, so it wins
> over any patch that reaches the edge, and before the water/passable tally, so
> `TerrainSummary` describes what the chunk actually is.

The seam contract survives intact. A tile remains a pure function of
`(seed, worldPosition, bounds)`, and `bounds` is a scenario constant — no stage
reads another chunk, so chunks still cannot disagree. The band's inner edge takes
`fbm2` jitter at the world seed so it reads as geography rather than a ruler
line; that is the same trick `groundPatchAt` uses, and it costs nothing.

Because `bounds` is optional and no caller passes it today, the goldens do not
change and `procedural`/`live` stay unbounded infinite worlds.

Threading: `ChunkManager` and `findSpawn` both construct a `GenContext` and both
need it. Nothing else does.

What the player sees costs nothing either — `describeFaced` already narrates
terrain, so walking into the band reads *"Bare stone climbing out of sight."*
The world-map panel should draw the extent, so the edge is legible before it is
reached.

Three things the boundary demands of the authoring pass, all possible only
because the generator is pure and available offline:

- **The rect must not intersect any site footprint.** Every site position and
  radius is known from `sitesAround` before a single model call, so the pass
  solves for a rect that lands in the gaps. This is what stops a town being half
  clipped into a cliff face.
- **A\* runs with bounds applied.** Arc reachability is checked against the real
  bounded world, not the infinite one it was surveyed from.
- **Style must suit the edge.** Do not ring a desert in ocean. The model picks;
  the validator checks the choice against `biomeAt` along the band.

A road that runs into the band simply dead-ends. That reads acceptably for
`cliffs` and `mountains`; for `ocean` it reads better still. Not
worth a generator change in v1.

## The arc

No new rules engine. `verifyQuests` already latches objectives against `have`,
`flag`, `reach` and `talk` after every command, and `mapActions` already lowers
declarative actions into `DomainEffect[]`. A beat is therefore a thin wrapper
over primitives that exist:

```ts
interface ScenarioBeat {
  readonly id: string;
  readonly order: number;
  readonly siteId: number;        // where it is anchored
  readonly npcSlot: number;       // and with whom
  readonly requires: readonly string[];   // flag gate
  readonly setsFlag: string;
  readonly quest?: Quest;
  readonly journal?: string;
  readonly card?: CardBody;      // a full screen, for a turn dialogue cannot carry
}
```

Beats gate on flags. Quests complete through the existing verifier, so a beat
cannot wedge because an NPC forgot to call `completeQuest` — the failure mode
`quests.ts` was written to eliminate. Dialogue nodes carry `ActionResponse`
values, so a baked conversation can give items, open quests, adjust reputation
and set flags through zero new runtime machinery.

## The story on screen

Two pages read the arc, and both were thinner than the arc deserved.

**The quest page** pins the main quest above the errand list, reachable without
moving a cursor, because the arc is not an errand: it has no bearing, it cannot be
completed by walking somewhere, and it is the thing a player most often wants
reminding of. `arcOutline(arc, state)` assembles it:

```
─ THE HOLLOW TITHE — THE STORY SO FAR ──────────────
Your sister took the warden's badge, walked the road east, and stopped writing.
[x] Take the tally to Stonewait
[~] Timber for the mill
─ CLUES ────────────────────────────────────────────
• Ilse Marrow keeps her own count, and it is short by a cord a month.
```

It is deliberately **backwards-looking**. Steps already reached, the clues already
gathered, and a count of what remains — never *what* remains. The next step is
already the open errand below it with a bearing on the map; naming the beat after
that would hand over the plot in the first minute.

A step ticks `[x]` only once its errand is *finished*, and shows `[~]` while it is
still in hand. Ticking on the beat merely opening was visibly wrong: the outline
showed a step complete while that very errand sat open in the list underneath it.

Clues are read out of the journal **by source**, not stored twice, so a clue and
the entry reporting it cannot disagree. `beatEffects` tags its journal line with
`arc:<beatId>`; matching on prose would orphan every clue in an existing save the
first time an author edited a line.

### Reading in full

This used to live in a side panel 32 columns wide and a fixed number of rows
tall, which is right for checking a bearing and hopeless for reading. A quest
description, a journal entry and a story clue are all prose written for a human,
and all three were being cut mid-sentence — on exactly the part worth reading.

Widening the panel was wrong twice over: the map pays for the columns, and a pane
tall enough to hold a quest log reaches the terminal height, at which point Ink
stops updating incrementally and clears the screen on every keypress.

So a list takes the whole frame, inside a heavy border that says you are in a
mode. `M` opens the menu and `M` puts it down again, as does `Esc`; left and
right walk the tabs, down hands the arrow keys to the list on the one you are on,
and up and down then move through it. Space is left alone throughout — it is the
world's look-and-act key, and a keypress meant for the world must not reach it
from a list.

There is no smaller version to be in, which is a simplification the pixel
renderer forced: Ink cuts a row of Unicode placeholders in half the moment
anything shares the screen line with it, so the map has to own every column of
its rows and there is no room beside it for a panel to live in.

The reader sits above dialogue in `routeKey`'s precedence. A dialogue turn resolves
asynchronously and can land at any moment; taking the arrow keys off somebody
mid-read would be indistinguishable from a bug.

Its layout is the same primitives the panel uses (`Rule`, `Prose`, `Field`,
`ScrollList`, extracted to `panels/primitives.tsx` when the second consumer
arrived), plus `Bullet` — a hanging indent, written because clues were the last
thing still being cut and a wrapped clue with no indent reads as several items.

**The journal** recorded only outcomes. An errand appeared in the log when it
finished and never when it was given, and a three-step errand left no trace at all
until the moment it closed — which made the log useless for remembering where you
had got to. It now records:

| When | Entry |
| --- | --- |
| a quest is created | `New errand: Take the tally to Stonewait.` |
| an objective ticks off, errand still open | `Take the tally to Stonewait: go to Stonewait — done.` |
| the errand finishes | `Completed: Take the tally to Stonewait.` |
| a beat opens | whatever the author wrote, tagged `arc:<beatId>` |
| a place is first entered | `Arrived in Bracken Cross.` |

Every entry carries a `source` — the quest id or the beat — so the log can be read
back by errand as well as by time. A finish is announced *once*: a single-objective
errand satisfies its last objective and completes in the same step, and reporting
both would put two lines in the log for one act.

`describeObjective` moved into `core/rules/quests.ts` for this. The pane and the log
now phrase an objective with the same words, and two copies would drift in a way the
player would see.

## Framing cards

The game used to drop the player onto a tile with a place name in the corner and
no statement of where they were, who they were, or why they had come. All three
facts existed already — in the lore, in the brief, in the arc premise — and none
were ever said out loud.

A `Card` is a full screen of prose, raised by a `DomainEffect` and shown *once*:

```ts
interface Card {
  readonly id: string;            // becomes `card:<id>` in the flags
  readonly title: string;
  readonly subtitle?: string;
  readonly sections: readonly { heading: string; body: string }[];
  readonly footer?: string;
}
```

Two properties earn it a place in state rather than in the UI.

**Anything that can change the game can raise one.** It is an effect, so a beat,
an arrival or a discovery can put one up without the UI knowing what occasions
exist. `beatEffects` emits it after the quest and the journal, so what the player
reads is already true of the game behind the card.

**It is read once, ever.** The id becomes a persisted flag, set in the same step
the card goes up. A beat re-applied after a partial save, or a world resumed from
a save that already read it, cannot show it twice — and the card itself is
dropped on load like `dialogue` and `notice`, so a save taken mid-read does not
come back blocking the first keypress.

Cards block movement, interaction and conversation while up (`CARD_BLOCKS` in
`reduce.ts`), because framing that can be walked out of unread is framing nobody
reads. Everything asynchronous stays live, so the world behind it is complete by
the time it comes down.

### The ending

A player finished a scenario, saw `Completed: Find the ledger in Harrowmere` as the
last line of their log, and asked whether that was it. It was. Nothing said so.

The game *knew* — every beat reached, every errand closed — and reported it as `3/3`
in a rule label, leaving the player to do arithmetic and still be unsure. An ending
is not a status.

`arcOutline` now carries `finished`, and `arcEndEffects` fires once when it becomes
true: a journal line in the words the question was asked in (*"the story is told.
Nothing is waiting on you now"*), a closing card, and a flag so it is said exactly
once. The pane says `told` rather than `3/3`, and both pane and reader state it in a
sentence.

`arc.ending` is authorable, and one is **assembled when nobody writes it** — the
premise, the steps actually finished, and plainly that nothing is waiting — so every
scenario ends rather than stopping. Inventing an epilogue would be putting words in
an author's mouth about a story this code has never read.

Completion is checked in `reduce`'s tail rather than beside the beat that opened,
because an arc can run out of story on any of three unrelated acts: the last beat
opening, the last objective latching, or a conversation completing a quest outright.
It is checked *before* the no-change shortcut, since the command that opens the final
beat changes nothing about quests or arrivals — an early return skipped exactly the
case this exists for.

**Cards queue.** Raising two in one step used to replace the first, and the last beat
of a story is precisely where that happens: its revelation and the ending arrive
together, and the revelation was lost while its flag claimed it had been read.
`state.pendingCards` holds what is waiting; dismissing hands the screen straight to
the next, so a finale reads as consecutive pages.

### The opening

`openingCard()` assembles three fixed headings — the questions a player has in
the first ten seconds, in the order they have them:

| Heading | Prebuilt | Live | Procedural |
| --- | --- | --- | --- |
| Where you are | artifact lore + region + town | model lore, once it lands | fallback lore + landscape |
| Who you are | `brief.protagonist` | `brief.protagonist` | a default line |
| What brought you here | `arc.premise` | `brief.storyline` | admits there is no errand |

Every part is optional and an empty part produces no heading, so the thinnest
case — procedural, unbriefed — still reads as deliberate rather than broken. It
never invents a motive: with no arc to hold the player to, there is no promise
worth making.

Timing is the one place the flavours differ. With no model the lore is already
known, so `buildSession` raises the card immediately. With one, `getLore()` would
answer with the deterministic fallback and the card would describe a world the
game is about to replace — so it waits for `onLore`, which the director always
fires, adopting its own fallback if the call fails.

## People indoors

Every interior was empty. You could walk into a house, read the furniture, search
a crate and leave, and the only people in a town of twenty buildings were the
three or four standing outdoors.

`residentsOf(seed, interiorId, kind, interior)` is pure, like everything else
about an interior, so a house always holds the same people without any of them
being stored. Ids are `npc:in:{interiorId}:{slot}` — namespaced away from a
site's `npc:{siteId}:{slot}`, since both halves are hashes and could otherwise
collide into one shared memory record.

The division of labour is deliberate. A town's **principals** come from the
director: three or four per town, named by a model, carrying what they know and
their part in the story. **Residents** are the other thirty, and a model call
each would cost ten times the whole world for people whose function is to be
somebody home when you knock. So the engine decides that a house holds a weaver
and a child, and the model earns its keep in the *dialogue* — a live world
improvises with them, a scenario falls back to the deterministic tree.

They present as `PlacedNpc` at every read site. `engine.personAt` and
`personById` promote a resident by filling in the two things that differ: their
position is interior-local, and their site is resolved **from the doorway**
(`inside.returnX/Y`) rather than from the player's own coordinates, which indoors
would answer about whatever town sits near the world origin. That promotion is
why a conversation with somebody's cooper works without the dialogue layer
knowing residents exist — and why a resident can tell you the town's hook.

## Tile packs: what the world looks like

A **content pack** decides what a world is *called*. A **tile pack** decides what it
*looks like*, down to the pixel. They are deliberately separate: a content pack is
flavour-only by contract and cannot affect mechanism, and a tile pack cannot affect
anything at all — it is the last layer, after every decision about the world has been
made.

```
.packs/tiles/<name>/tiles.json    the manifest
.packs/tiles/<name>/atlas.png     full-colour tiles, one grid cell each
```

A directory rather than one file, and the art as a PNG rather than base64 inside JSON,
because a full-colour atlas is a quarter of a megabyte of pixels and JSON is a bad
container for that. It is also the format art arrives in, so a pack opens in an image
editor.

Choose one with `TILE_PACK=inkwell`, or by naming it in a scenario:

```json
"tiles": "inkwell"
```

Either way the name is written into the save, so a world that looked one way when it
was made looks that way when it is reopened — whatever `TILE_PACK` happens to say
today. A missing pack falls back to the built-in look and the world plays identically.

### What a pack may say

Everything is optional and everything merges by key, the same rule content packs use.

**`palette`** — any colour by name. Eleven lines recolours the entire game, because
every glyph and every sprite draws in palette colours rather than in literals.

```json
"palette": { "moss": "#6f7f4a", "mossDark": "#2e3a22" }
```

**`glyphs.terrain` / `glyphs.decor`** — per key, the character and its colours:

```json
"grass": { "ch": ["░", "'", "."], "fg": "moss", "bg": "mossDark" },
"stoneWall": { "ch": ["▓"], "fg": "stone", "bg": "stoneDark", "autotile": "heavyWall" }
```

`ch` may be one character or a list, in which case the tile's stable per-position
variant picks between them. `autotile` names one of the built-in connection sets.

A pack must be able to say something here even if it ships an atlas, because **glyph
mode is the floor**: it is what runs when the terminal cannot do graphics. A pack that
supplies no glyphs simply inherits the built-in ones.

**`sprites.terrain` / `sprites.decor` / `sprites.glyph`** — how a tile is drawn in
pixel mode, in one of four forms:

| form | what it is | keeps lighting? |
| --- | --- | --- |
| `{ "shape": … }` | geometry over `box`, `disc`, `ring`, `cone`, `wave`, `any`, `all`, `not` | yes |
| `{ "density": 0.25 }` | a shade between the tile's two colours | yes |
| `{ "mask": ["#.", ".#"] }` | an N×N ink mask, `#` for ink | yes |
| `{ "atlas": [col, row] }` | a full-colour cell of `atlas.png` | yes, see below |

Reach for `shape` first: it stays resolution-independent, so a conifer is crisp at
eight pixels and at forty-eight and the tile size stays a number rather than a redraw.
A `mask` is pixel-level and still two-colour. An `atlas` cell is full colour.

Sprites are keyed by **terrain and decor key, not by glyph**, because the glyph
vocabulary is lossy in exactly the way a tile pack exists to fix: `▒` is a roof *and* a
bush, and a pack that wants to draw them differently cannot say so through the
character.

### Full colour and lighting

A two-colour sprite gets everything atmospheric for free: day/night tint, field of
view, contact shadows and slope relief are already folded into the cell's two colours,
and any shape drawn in them inherits the lot.

A full-colour tile carries its own colour and cannot. So the compositor records what it
multiplied the cell by (`Cell.mul`) and the rasteriser multiplies the atlas pixels by
the same thing. Without that a bitmap tile would blaze at noon brightness in the middle
of the night. Alpha composites over the cell background, which is what lets a decor
tile be a chest with the road showing round it.

That cost is only paid when a pack actually has bitmaps — the theme says whether it
does, and the compositor asks.

### What a pack cannot do

**Ship a glyph that would tear the row.** `assertSafeGlyphs` runs on the resolved
theme, not merely on the built-in tables, so a double-width character is refused with
the pack's name in the message. That is the one failure mode that would break the
*display* rather than merely look wrong, and it would read as a terminal bug.

Everything else degrades: a missing palette name draws in loud magenta, an atlas cell
that is not there falls back to the built-in sprite, and an unparseable manifest logs
and leaves the game looking ordinary. The player asked to play, not to debug JSON.

### The two shipped packs

`.packs/tiles/inkwell/` is the small one: three glyph overrides, three sprites, an
eleven-colour palette and a three-cell atlas. It is what a pack looks like when it only
wants to change a few things.

`.packs/tiles/gramarye/` is the exhaustive one, and the one to copy from. It restates
the *whole* palette, redraws forty-odd terrain and decor glyphs, and supplies sprites in
all four forms — a dozen shapes, eight densities, ten ink masks and sixteen full-colour
atlas cells with alpha.

Its atlas is drawn in code:

```
npm run tiles:emit
```

Committed art nobody can regenerate is committed art nobody can change. Drawing it means
the whole set can be shifted half a shade colder by editing one constant, which is what
actually happens to a tile set, and it keeps the repository free of binaries whose
provenance is a shrug. `encodePng` grew a four-channel path for it — `decodePng` had read
colour type 6 all along, so until then the repo could read an atlas it had no way to
write, and a decor tile with no alpha is a decor tile with a rectangle of background
painted round it.

Look at either one over any world, including one a scenario describes:

```
npm run pixel-shot -- --seed alpha --at -1,-1 --tiles inkwell
npm run pixel-shot -- --seed 3611560565 --at 0,-1 --tiles gramarye \
                      --recipe .scenarios/green-chapel.json
```

## Content packs

Everything a world is *called* used to be a `const` table in the module that read
it: name syllables in `names.ts`, outdoor trades in `fallback.ts`, households and
their appearance lines in `residents.ts`. A timber-levy road and a drowned
archipelago want different registers, and the tables were the last thing in the
pipeline a scenario could not touch.

A `ContentPack` is those tables as data. Two rules keep it from becoming a
configuration language:

**Cosmetic, except where it is checkable.** Nothing in a pack decides whether a tile is
passable. Most of it decides only what things are *called*, so a world opened with the
wrong pack looks different and cannot become unplayable. Two tables reach further and are
handled differently — `goods` and `world`, both below — and the rule for those is not
that you are trusted but that the result is *verified*.

**Owned by the world.** Names are *derived*, not stored — so adopting a different
pack mid-world would rename everybody the player had already met while keeping
their memories. A pack override travels in the save and in the artifact, exactly
like the brief, and a world with one of its own ignores whatever is offered.

| Table | What it changes |
| --- | --- |
| `names.given` / `family` | who people are called |
| `names.heads` / `tails` / `ruinTails` / `fortTails` / `regionTails` | how places and regions are named |
| `households` | who lives in each kind of building, and how many |
| `appearance` | the one telling detail the examine verb prints |
| `talksAbout` | what a resident will discuss, which the canned tree leans on |
| `outdoorRoles` | who stands outside each kind of building |
| `wanderers` | the people at the well and the bench |
| `lore` | the premise a world with no model runs on |
| `ambient` | flavour lines for a region nobody wrote |
| `goods` | what there is to find, buy and gather |
| `world` | a recipe fragment: what the map is *built* of |

### goods

`stores` (what a building keeps in its crates), `catalogue` (what a shop sells),
`yields` and `forageChance` (what the ground gives up), and `trades` (which catalogue a
role sells from). Everything is `[name, description]` pairs, keyed by structure kind or
terrain key, merged by key.

This is where a pack's illusion used to break hardest: a Camelot smith, renamed and
re-voiced by the pack, still sold the same *Horseshoe* as every other world.

It is not cosmetic. `obtainableItems` reads all three tables to decide which item names a
`have` objective may legitimately use, so emptying a catalogue is an errand for something
that does not exist. What makes it safe to write anyway is that the same function answers
the question offline: the validator reports an errand nothing can satisfy, and
`repairUntilClean` drops it. A hostile pack produces a reported fault, not a story that
quietly cannot be finished.

**Adding a trade is one entry.** A role trades from a catalogue whose name appears in it,
so writing `catalogue.fletcher` is enough to make "the castle fletcher" sell arrows.
`trades` is only the shortcut for roles whose words do not match — a farrier keeps a
smithy.

### world

A recipe fragment, in the pack, using exactly the syntax of
[the recipe](#the-recipe-choosing-the-world-instead-of-rolling-for-it) — most usefully
`sites.roster`, so a Camelot pack can say its villages are farmhouses and barns.

It is handled unlike every other table here, and the reason is mechanical. Feature
patches are cached under the seed *and the recipe* (`worldKey`), and interiors under
`(seed, interiorId, kind)`. Anything that changes what the generator builds has to be
inside one of those keys, or a town generated under one pack gets served, from cache, to
a world opened under another. So the fragment is folded into the scenario's recipe **when
the scenario is built** rather than consulted while it runs — after which it hashes into
the key like everything else, and is persisted into the artifact. A world built with a
pack replays correctly even if the pack is deleted, because the part that shaped the map
is no longer in the pack.

A scenario's own recipe wins over the pack's, section by section: naming a pack and then
stating a climate is correcting the pack, not being overruled by it.

### Merge rules

An override is partial, and the two rules differ on purpose:

- **Maps merge by key.** Changing one trade's appearance is one line; the other
  thirty keep the default. Restating thirty lines to change one is how a format
  stops being used.
- **Lists replace.** Supplying `given` means "these are the given names in my
  world". Appending would leave exactly the names the author was trying to remove.

### Where a pack comes from

```
CONTENT_PACK=thornwick npm start        # a shipped pack, by name
CONTENT_PACK=./my-pack.json npm start   # or a path, so one can live beside a draft
```

…or `"content": { … }` in a scenario draft, which is inlined into the artifact so
the scenario is self-contained: no file to install, nothing beside it to lose.

The baked default is **code** (`core/content/default.ts`), not a file, so the pure
generators always have a complete set of tables with no filesystem in the path —
`core` has to stay callable from a validator and a test. `.packs/default.json`
is the same data as a file, for authors to copy, and a test pins the two together so
they cannot drift. A missing or invalid pack logs and falls back to the default
rather than refusing to start: a player asked to play, not to debug their JSON.

## Dialogue trees

```ts
interface DialogueChoice {
  readonly text: string;
  readonly goto: string | null;           // null ends the conversation
  readonly requires?: readonly string[];  // hidden until these flags are set
}

interface DialogueNode {
  readonly id: string;
  readonly speech: string;
  readonly requires?: readonly string[];  // eligibility as an opening
  readonly choices: readonly DialogueChoice[];
  readonly actions?: readonly ActionResponse[];
}

interface DialogueTree {
  readonly npcId: string;
  readonly entry: readonly string[];      // first meeting, most specific first
  readonly revisit?: readonly string[];   // every meeting after
  readonly nodes: Record<string, DialogueNode>;
}
```

State-sensitivity arrives two ways, and both are list-shaped rather than
single-valued: `entry`/`revisit` are ordered candidates so a character can greet
the player differently once the story has moved, and a choice can be hidden until
its flags are set so the same node offers different ground depending on what the
player knows.

The runtime cursor is a new `node?: string` on `NpcRecord`, moved by a
`SetNpcNode` effect. It belongs there because it is exactly what that record is
for — what an NPC remembers — and because it must survive ESC, a reload and chunk
eviction, all of which that record already does.

`scripted.ts` returns the same `{runDialogueTurn, summarizeNpc}` pair
`createDialogueService` does, so `effect-runner.ts` does not change.
`summarizeNpc` takes the existing trim-only branch: memory still stays bounded,
it just stops being rewritten.

**Any node miss falls through to `cannedTurn`.** The tree is an enrichment over a
floor that already works, never a cliff.

**An opening is re-chosen at every hello, so it must not erase its own condition.**
The obvious spelling of a hand-over — an opening gated on `{ "item": "X" }` whose
actions take X — works exactly once. Next meeting the item is gone, the condition is
false, and the conversation falls back to the greeting that opening was written to
replace: the ferryman asks for the mooring iron again, a minute after taking it out of
the player's hands. Nothing else notices, because nothing else is wrong.

Record the hand-over on the same node and give the revisit an opening that reads it:

```json
{ "id": "iron-back", "requires": { "item": "Mooring Iron" },
  "actions": [ { "kind": "takeItem", "item": "Mooring Iron", "quantity": 1 },
               { "kind": "giveItem", "item": "Fen Charm" },
               { "kind": "adjustDisposition", "quantity": 15 },
               { "kind": "setFlag", "key": "iron:returned", "value": "true" } ] }
```

Four actions are allowed on a node for exactly this shape — take, give, warm, record —
and the cap used to be three, which quietly forced the record out. `checkHandovers`
warns about an opening that takes what it is gated on, and is silenced by a `setFlag`
some other node reads.

Mid-conversation nodes are exempt: they are entered once by construction. It is only
openings that are asked again.

The honest limitation: a baked tree cannot react to arbitrary player state the
way a live call can. `requires` variants and a revisit node cover the cases worth
covering; a player who does something genuinely strange gets a stiff
conversation. That is the price of the mode, and it is why `live` remains the
default.

## What the authoring pipeline can now write

`npm run author` learns most of the surface above, in two places.

**Before the survey**, it asks a model what kind of country the brief wants — five
coarse settings (`sea`, `climate`, `wet`, `settled`, `woods`) and a sentence saying
why — and `shape.ts` turns those into a recipe. The model never sees a `WorldRecipe`,
and that is deliberate: a model handed `seaLevel` and asked for a drowned archipelago
writes `0.9`, which is not an archipelago but an empty ocean with the player standing
on the one remaining rock. The numbers in that table were arrived at by generating
worlds and looking at them. An explicit `recipe` in the draft always wins — somebody
who wrote one has seen the map.

**In the arc pass**, a beat may now carry four more things:

| field | what it does |
| --- | --- |
| `optional` | a side errand; the story can finish with it open |
| `partOf` | makes this beat a step of an earlier one |
| `branch` | two beats with the same group are mutually exclusive |
| `find` | something hidden in a named kind of building at that settlement |

`find` becomes **two** things at once — a `Placement` the engine resolves against real
geometry, and a `have` objective on the beat. Both or neither: a placement alone is an
item nobody was told about, and an objective alone is an item that is nowhere. That is
the dead end the findability check exists to catch, and the pipeline is now incapable
of writing it.

The lowering enforces what the schema cannot. A side errand never becomes the thing the
next beat waits on; two arms of a fork never gate each other; a step that names a
parent it cannot have is demoted rather than dropped; and a parent gets a `quest`
objective per step, so it closes the moment its last step does.

`optional` and `find` are now *required* rather than offered. Both sat in the schema,
documented, for as long as the pipeline existed, and every generated world came back with
none of either — because "you may" reads as "you need not" and the straight line is always
the easier thing to write. A story with no side errand and nothing to search for is a
story of walking between conversations.

**After the arc**, a reactions pass writes the two kinds nothing had ever produced:

| kind | what it does |
| --- | --- |
| `triggers` | the world noticing — a journal line, a card — once a beat has opened |
| `barriers` | a castle gate barred until a beat opens it |

Both are chosen by **index** into lists the pass is shown, never by id or coordinate: a
trigger waits on a flag some beat definitely sets, and a gate names a site the survey
found. An unsatisfiable condition is not something the pass can express. Barriers are
offered only where there is a castle, because a village's streets have as many ways in as
they have edges — barring one tile of an open road bars nothing and says it did — and a
gate whose opening beat happens *behind* it is refused outright.

What the model is still not trusted with: `places` and `zones` (they need coordinates,
and a coordinate is exactly what a model invents confidently and wrongly), where a gate
actually stands (`castleGateTiles` answers that from the generated world), and the recipe
itself.

## Authoring

`src/tools/author.ts`, run offline, checkpointing between passes because it is
expensive enough to want resuming.

| Pass | Does | Cost |
|---|---|---|
| 0 | **Shape** — what kind of country the brief wants, lowered into a recipe | 1 call |
| 1 | **Survey.** `findSpawn`, `sitesAround` over the footprint, `siteContext`/`regionContext` for each, boundary-rect solve | free — all pure |
| 1b | **Reachability.** One flood fill from the spawn over the whole bounded world; places it cannot reach are not offered to the story | one world generation |
| 1 | **Lore** from the brief | 1 call |
| 2 | **Regions** | ~6 calls |
| 3 | **Sites**, each told what the engine has room for | ~13 calls |
| 4 | **Arc** — beats placed over the surveyed sites | 1 call |
| 4b | **Reactions** — triggers, and a gate on a castle if there is one | 1 call |
| 5 | **Trees**, per NPC | ~40 calls |
| 6 | **Validate and repair**, mechanically | free |
| 7 | **Mend** — the faults that need prose written | ≤ 6 calls |

Pass 1 is why this produces better worlds than `live` can. The model is handed
the real site list — kinds, importance, bearings, building budgets, distances —
before it invents anything. Pass 4b runs *after* the arc for the same kind of
reason in reverse: a trigger is a consequence, and it can only be conditioned on a
flag that already exists, so nothing it writes can wait on something nobody sets.

Pass 1b is the only one that costs real work for nothing visible, and it is worth
it. `distanceFromSpawn` is a straight line — right for ordering a story outward,
wrong for deciding a place can be visited at all, because a town across an inlet is
thirty tiles away and unreachable. Without this the validator says so at the *end*,
after sixty calls have been spent writing a scene nobody can walk to.

At radius 6 that is roughly 60 calls: ~169 macro cells, ~13 settlements, ~40
people. A couple of minutes at Flash speeds with a concurrency of 4.

### Validation is the point

Pass 6 is the strongest argument for prebuilt scenarios existing. The entire
generator is pure and runs offline, so the authoring tool can execute it against
its own output and check things live generation structurally cannot:

- every `NpcSpec.structureName` matches a building the settlement generator
  actually placed, and every `placement` anchor exists
- `buildingBudget` is respected
- quest `reach` targets resolve through `placeNameAt`; `have` items are
  obtainable somewhere in the arc
- beat sites are A\*-reachable from spawn *within the bounds*, and the walking
  distance matches the requested duration
- the boundary rect intersects no site footprint and suits its edge biome
- every tree node is reachable and every `goto` resolves
- **the story can be finished**: `checkCompleteness` simulates the arc forward from
  an empty state, once per arm of every fork, and reports a beat that no route
  reaches or an errand no route can close — the class of fault where every id
  resolves, every flag is written, and the story stops anyway

A golden test asserts the artifact's site ids equal `macroSite(seed, mx, my).id`,
which is the one invariant that silently ruins everything if it breaks.

### Repair until clean

Findings are not merely printed. `scenario/repair.ts` fixes what has one right
answer, and the loop is judged by the validator rather than by itself:

```
repair (mechanical, free)  →  validate  →  keep it only if the score fell
   ↓  what is left and needs words, capped at 6 calls
mend (model)               →  validate  →  keep it only if the score fell
```

Errors count for ten warnings in that score, so trading a step of the story that
cannot be taken for a place that came out rougher than intended is a trade the loop
will make, and the reverse is one it will not. A round that improves nothing is
thrown away whole, which means a repair with an unforeseen consequence costs one
wasted world-generation rather than a worse scenario.

Every repair **re-derives its own condition** rather than parsing a finding — a
finding is a sentence written for a person, and coupling a fix to its wording means
improving the wording silently disables the fix. What they fix, one class each:

| repair | fault |
|---|---|
| `standTheCastSomewhereReal` | somebody at an anchor the town does not build, in a room that was not built, or claiming a building that did not fit |
| `hideThingsWhereThereIsSomewhereToHideThem` | a hidden thing in a kind of building the ground refused |
| `spellObjectivesAsTheWorldDoes` | an objective the world spells differently, so it would never match |
| `dropErrandsForThingsThatDoNotExist` | a `have` objective for an item this world's goods do not produce under any spelling |
| `dropObjectivesNothingCanTick` | an objective waiting on a flag nothing sets, which keeps the whole arc from ever ending |
| `dropOneArmedForks` | a fork with one arm, which is not a choice |
| `forgetPeopleWhoAreNotHere` | a conversation gated on somebody the scenario does not contain |
| `gateTheCastOnTheirOwnScene` | somebody on stage before the beat they carry can open |

`mend` covers the two that genuinely need prose: somebody with no conversation at
all, and a fork nobody speaks about. It keeps a rewrite only if the rewrite did the
thing it was asked for, so a replacement that is merely *different* is discarded and
the original conversation kept.

## Launcher

`main.tsx` currently builds the whole session before `render`. That splits:

- `src/session.ts` — `buildSession(choice: LaunchChoice)`, everything
  `startGame` does except rendering.
- `src/ui/launcher/` — an Ink screen listing saves (`saveRoot()/saves/*/save.json`)
  and scenarios (`saveRoot()/scenarios/*.json`, plus `--scenario <path>`), with a
  **New game** submenu choosing flavour and a text field for a live brief.
- `main.tsx` — render launcher, await a choice, build the session, render `App`.

There is no text input component yet, because dialogue is choice-only. A ~40-line
`useInput` field is preferable to adding `ink-text-input` for one screen.

Testing it needed `test/harness/ink.tsx`. `ink-testing-library` cannot drive the
installed Ink: its fake stdin has no `ref`, which Ink calls to enable raw mode, and
in raw mode Ink reads with `readable`/`read()` while the library emits `data`. The
`ref` failure lands inside a `useEffect`, so the first frame is already committed
and correct and only the *next* one is an error message — which is why the existing
`app.test.tsx` passed while every render under it was throwing. The harness
implements both contracts, so a test can assert what a keypress does rather than
only what a screen looks like.

Saves gain `world.scenarioId?`, so resuming re-attaches the artifact: the save
carries the specs, but the trees, arc and bounds live only in the file. The field
is optional, so `SAVE_VERSION` does not move.

## Layout

| Path | What it is |
|---|---|
| `src/core/world/brief.ts` | `ScenarioBrief` and `Duration`, pure — it is saved state |
| `src/scenario/scenario.ts` | Artifact and arc types, `ARTIFACT_VERSION` |
| `src/scenario/schema.ts` | Zod schemas for the artifact |
| `src/scenario/repo.ts` | List, load, write and verify artifacts |
| `test/harness/ink.tsx` | Render an Ink tree and type at it |
| `src/scenario/arc.ts` | Beat → quest/flag lowering (pure) |
| `src/ai/dialogue/scripted.ts` | Tree walker and the scripted service |
| `src/ai/author/` | The offline pipeline and its prompts |
| `src/scenario/draft.ts` | The hand-authored format, and lowering it to an artifact |
| `src/tools/author.ts` | CLI entry point |
| `src/ui/launcher/` | The selector |
| `src/session.ts` | Session assembly, extracted from `main.tsx` |
| `src/core/gen/bounds.ts` | S9, pure — lives in `core` and imports nothing new |

## Phases

Each phase leaves the game playable.

| # | Lands |
|---|---|
| 1 | ✅ `ScenarioBrief`; brief-aware prompts; brief persisted; `SCENARIO_*` env. Promptable `live`, no new UI. |
| 2 | ✅ Launcher, selector, flavour picker, `session.ts` split. |
| 3 | ✅ Artifact format, repo, `prebuilt` loading of lore/regions/sites. A working pre-gen mode with canned conversation. |
| 3b | ✅ `bounds` in `GenContext`, S9, threading, seam tests. |
| 4 | ✅ The authoring tool and its validation pass, including the boundary solve. |
| 5 | ✅ The arc: baked quests, flags, journal. |
| 6 | ✅ Dialogue trees, authored and walked. |

All six have landed, plus a seventh way in that was not in the original plan:
**authoring by hand**. `npm run survey` prints the map for free and
`npm run assemble` takes a written draft, so a scenario can be produced with no API
key — by a person, or by an agent in an editor session via the `author-scenario`
skill. The draft format asks only for judgement and derives every mechanical part,
which is what makes a hand-written arc impossible to mis-wire.

Two things the implementation learned that the design did not know:

`generateSettlement` memoises by `(seed, siteId)`. That is right for a running
game — one town, generated once — and wrong for validation, which measures several
candidate rosters for the same site in one process and would otherwise report the
first layout for all of them. The pass drops the entry before generating.

Two mechanisms were reaching the same invariant by different means, and one of them
was wrong. The validator matched place names by *substring* while `verifyQuests`
matches on *significant words*, so `reach: "Thorn"` passed authoring against a town
called "Thornwick" and could never complete in play — authoring accepted a quest the
game refused, and the only symptom was an errand that never finished. Name resolution
now lives once in `core/rules/surroundings.ts` (`resolveObjectiveTarget`) and
obtainability once in `core/rules/obtainable.ts`, both called by the engine and the
validator; the engine's four sources for a fetchable item are no longer approximated
by a pattern over NPC roles. Assembly canonicalises `reach` and `talk` targets to the
world's own spelling, which is what the runtime already did for a quest an NPC opens.

The anchor check was also *wrong*, not merely weak, and stayed wrong until a real
draft ran through it. `pickAnchor` treats `yard` as `doorstep` and falls back to any
free anchor otherwise — its own comment says the placement is advisory — so an
unbuilt anchor relocates somebody rather than stranding them. As an error it would
have refused to install perfectly playable scenarios, including every one built from
the deterministic roster, which asks for a `yard` routinely.

Beyond that, the anchor check is weaker than hoped. A settlement of any size lays down
eight of the nine anchor kinds, so only `yard` is realistically ever missing from a
town, and the check earns its keep mainly on hamlets and camps. It stays because
the failure it catches — a named character standing nowhere — is invisible
otherwise.
