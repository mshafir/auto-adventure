# Six worlds that are not this one

## Context

The pack system can now change what a world is *made of*, not only what it is called: a
pack carries names, households, roles, lore, ambient lines, **goods** (what there is to
find, buy and gather) and a **recipe fragment** (climate, biome grounds, site weights and
what each kind of settlement is built out of). Tile packs carry a 53-key palette, glyphs
for all 47 terrains and 24 decors, and sprites written as resolution-independent shapes.

Three packs exist — `default`, `thornwick`, `camelot` — and all three are the same world:
temperate, medieval, north-western European, smallholders and road-traders. Nothing has
tested whether the format carries a *genre*, and the honest answer is that nobody knows,
because nothing has tried to move more than the vocabulary.

**The finding that shapes this batch: almost nothing new is needed.** A recipe can
re-ground and rename any of the sixteen biomes, so a "salt flat" is `moor` with different
ground and a different name; it can bias climate so a world is mostly desert; and it can
say what a village is built of. A pack renames every role, every household and every
item. Between them, five of the six worlds below need no engine change at all. That is
the claim this batch is really testing, and the small list of additions at the end is
short *because* it is the list of things a pack genuinely cannot say.

## The coverage matrix

Chosen to be maximally distant from each other and from the three that exist — on
terrain, on social vocabulary, and on what there is to want. Two worlds that differ only
in adjective are one world.

| pack | era | genre | ground | what money is |
|---|---|---|---|---|
| `default` | medieval | pastoral | temperate lowland | coin, smallholding |
| `thornwick` | medieval | folk horror | marsh and timber road | the levy |
| `camelot` | medieval | chivalric | meadow and forest | oath and obligation |
| **`thalassa`** | ancient | classical | savanna, meadow, beach | olive, marble, tribute |
| **`sunspire`** | medieval | desert caravan | desert, badlands | water and salt |
| **`hollowfrost`** | dark age | northern saga | taiga, glacier, moor | furs and iron |
| **`saltmere`** | early modern | age of sail | archipelago, marsh | cargo and charter |
| **`redgulch`** | industrial frontier | western | shrubland, badlands | credit at the store |
| **`ashfall`** | post-collapse | survival | badlands, ruins | barter, nothing minted |

Era runs ancient → post-collapse; genre runs pastoral, horror, heroic, mercantile,
survival. Every cell that matters has an occupant and no two packs share a climate.

## What each pack is

Each is one JSON file in `.packs/`. Roughly 250–400 lines: nine cosmetic tables, a
`goods` block, a `world` fragment — and a `description`.

**The description is not optional in this batch, whatever the schema says.** Nine packs
offered by name is a list nobody can answer: `sunspire` and `thalassa` are both hot and
dry and the name says nothing about which is which. The one-liners below are written
first, because they are also the tightest statement of what each pack is *for*, and a
pack whose line is hard to write is a pack that has not been decided yet. The same goes
for the six tile packs, which get a description and are seen through the three-row
preview the chooser draws.

### thalassa — classical antiquity

Hot and dry with a wet coast. `climate.temperatureBias` up, `moistureBias` slightly down,
`seaLevel` raised so the map is islands and headlands. Lowlands come out savanna and
meadow, which is the right olive-and-scrub register with no new biome.

Rosters put `temple` and `shrine` far higher than anywhere else and drop `farmhouse`
almost out — a polis is a town with civic buildings in it, not a village that grew.
Stone everywhere: `materials` are already per-structure, so the *tile pack* does the
marble. Goods are olive oil, figs, wine, cured fish, bronze, dyed wool. Trades: potter,
dyer, olive-presser, shipwright. Names are Aegean rather than Latin — a Roman register
reads as empire, and empire needs a bureaucracy this game does not model.

### sunspire — desert caravan

`temperatureBias` well up, `moistureBias` down, `elevationScale` up so the land is broad
and flat with occasional badlands. Lowlands are desert and shrubland; `moor` re-grounded
to gravel and renamed "salt pan".

The interesting constraint: a desert world has few sites, so its rosters run **large and
far apart** — `radius` up, `weights` down. A caravanserai is an `inn` with a `stable`
against it and a `well` at its centre, which the anchor system already produces. Goods are
water, salt, dates, indigo, glass, camel tack; the well is the thing everyone talks about.
This is the pack that most wants the new `saguaro` and `palm` scatter terrain, because a
desert full of yellow broadleaf trees is the failure mode a recolour cannot fix.

### hollowfrost — northern saga

`temperatureBias` down hard, `latitudeBand` narrowed so the climate reads as one place.
Taiga, moor and glacier; conifers everywhere. `alpineLevel` lowered so highlands turn to
ice early.

Rosters are `house` and `barn` and almost nothing else — a longhouse is a `house` with a
different roof pitch in the tile pack — plus `shrine` for the waystones and `tower` for
the watch-cairns. No `apothecary`, no `shop`: trade is at the hall, so the `inn` carries
it. Goods are furs, seal oil, dried fish, bog iron, amber, mead. This is where the new
`totem` decor earns itself.

### saltmere — age of sail

`seaLevel` raised until the map is an archipelago, `docks` weight raised sharply and
`castle` dropped to nothing. The `docks` feature, `pier`, `deck`, `boat` and `mooring`
already exist and have never been the *point* of a world.

Rosters are `warehouse`, `inn`, `shop` and `house` — a port is a place goods pass
through. Goods are the batch's best case for the goods tables: cordage, sailcloth,
tar, salt cod, logwood, sugar, a charter. Trades: chandler, cooper, sailmaker, factor.
An errand here is a *cargo*, which is exactly what a `have` objective is for.

### redgulch — industrial frontier

Shrubland and badlands, `civilizationFloor` raised so settlement is sparse and clustered,
`ruins` weight up (there was something here before). Dirt roads rather than cobble, which
falls out of the roster and the tile pack together.

Rosters: `shop` (the store), `inn` (the saloon), `smithy` (the livery), `barracks` (the
post), `house`. Goods are cartridges, coffee, tinned peaches, blasting powder, a claim
deed. This is the pack that wants `track` terrain — a rail line is the one thing on the
frontier that is neither road nor river, and there is no tile that stands in for it.

### ashfall — post-collapse

`ruins` and `landmark` weights raised far above anything else, settled weights cut to a
fraction, `civilizationFloor` raised so most of the map is wild. Badlands and moor,
`grassland` re-grounded to dirt and renamed "waste".

The pack that tests the *validator* hardest, because it deliberately has almost no shops:
`catalogue` is nearly empty, `stores` carry salvage, and `forageChance` is raised because
the land is what is left. An errand here can only name what can be scavenged or gathered —
which is precisely the check `obtainableItems` performs, and precisely the fault
`dropErrandsForThingsThatDoNotExist` was written for. If the completeness machinery works,
this world proves it; if it does not, this world is where it fails loudly.

## The tile packs

One per content pack, in `.packs/tiles/`, each a palette recolour of all 53 keys plus a
handful of shape-DSL sprite overrides where a recolour is not enough:

| pack | overrides |
|---|---|
| thalassa | `broadleaf` → olive, `stoneWall` → ashlar courses, `roof` → pantile |
| sunspire | `broadleaf` → palm, `bush` → saguaro, `woodWall` → adobe, `grass` → sparse stipple |
| hollowfrost | `conifer` → heavier, `roof` → steep pitch, `rock` → cairn, `marsh` → frozen |
| saltmere | `pier`/`deck` sharpened, `bush` → gorse, `roof` → slate, `water` → chop |
| redgulch | `bush` → sage, `deadTree` → sun-bleached, `fence` → post-and-rail, `roof` → shingle |
| ashfall | `rubble` → heavier, `deadTree` → burnt, `stoneWall` → cracked, `crops` → dead |

Shapes rather than atlas art, deliberately: a shape stays crisp at eight pixels and at
forty-eight, and it can be reviewed in a diff. `gramarye` remains the one pack with drawn
art, and `emit-tiles.ts` remains how it is drawn.

## What has to be added to the engine

Short, and each entry is here because a specific pack above cannot say it.

**Terrain** (appended — ids are the wire format, so entries may be appended but never
reordered): `palm`, `saguaro`, `track`, `adobeWall`. Each needs a built-in glyph and
sprite so it renders in an unthemed world, and each is reachable from a recipe's biome
`scatter` table, which is how sunspire gets palms without a code change of its own.

**Decor**: `totem` (hollowfrost's waystones), `keg`, `loom`, `cauldron`. Cheap, and they
are what makes an interior read as a *trade* rather than as furniture.

**One structure kind**: `hall`. `temple` is currently the only large non-military room,
so every civic building in every world is a church. A hall is benches and a long table and
no altar, and thalassa, hollowfrost and saltmere all want one for different reasons.

**One recipe field**: `bounds.style`. `BoundaryStyle` already has three values and
`styleForEdge` only ever chooses two of them — `mountains` exists and is unreachable. A
scenario cannot say what its edge is, so hollowfrost cannot ask to be ringed by ice
mountains and sunspire cannot ask for anything but sea or cliffs.

**No new biomes.** The sixteen cover the climate space, and a recipe already re-grounds
and renames all of them, so the additions would be names for things that already exist.

## Sequencing

1. **The engine additions first**, because three of the packs reference them and a pack
   written against a terrain that does not exist yet cannot be validated.
2. **A pack-gallery test**, before the packs. Every file in `.packs/` must parse, merge,
   name only registered structure kinds and real terrain keys, produce goods whose entries
   are well-formed, and **carry a description** — the schema allows one to be missing,
   because a pack written before descriptions existed is still a good pack, but nothing
   shipped from here on should be. Three hundred lines of hand-written JSON per pack is
   exactly where a typo hides, and the test is what makes writing six of them safe.
3. **The six packs**, cheapest first: `saltmere` and `ashfall` need no new terrain, so
   they land first and prove the format carries a genre before any engine change is
   leaned on.
4. **The six tile packs.**
5. **One generated world per pack**, measured.

## Verification

- `npm run check` — typecheck, `biome check .` over the whole repository, and the suite.
- **The goldens must not move.** New terrain is appended and nothing re-grounds a biome by
  default, so an unpacked world must generate byte-identically at every step. This is the
  guard that says the batch is additive.
- **Every pack parses and merges**, from the gallery test above.
- **A generated world per pack**, validated: places, people, structures, side errands,
  hidden things, triggers and barriers counted the way the last batch of work was
  measured, and `--deep` walked to its ending in the real engine. A pack that produces a
  world that cannot be finished is a broken pack, and this is the only way to find out.
- **`ashfall` specifically must produce a finishable world**, because it is the one built
  to starve the errand machinery. If `obtainableItems` and the repair pass are right, it
  comes out clean; if they are not, it is the pack that says so.
- **A screenshot per tile pack**, via `npm run screens`, so a recolour that reads as mud
  is visible before it ships.

Delete this document when the work is done.
