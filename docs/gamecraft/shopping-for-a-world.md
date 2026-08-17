# Shopping for a world

The generator gives you land. You decide where anything stands on it. Getting that round the
right way is most of what makes a scenario feel deliberate rather than assembled.

## Nothing is built until you build it

A seed produces coasts, rivers, forest, hill and moor, and no settlements at all. That is on
purpose. The seed used to scatter villages across the map, a story used two of them, and every
other one was a place with a name, houses, and nobody with anything to say — which a player
reads as the game being broken rather than as scenery.

So every town in an authored world is there because the story needed it, and `craft found`
is what puts it there. One call writes both halves: the recipe entry that makes the generator
lay out a settlement in that cell, and the spec that names it and says what is in it. They
cannot come apart, because nothing writes one without the other.

## Survey before you write anything

`craft survey` asks the ground a question rather than reading you a list: *where will this
country hold a village, how far is it from the start, and what is it like there*. Every row is
measured by actually laying a settlement out on that cell and counting the plots it finds, so
a row the survey prints is a place founding will accept.

```
--at 96,-32      91 away  room for 13  meadow, lowland
--at 32,160     143 away  room for  4  shore, coast
```

`--kind town --importance 5` asks the same question about somewhere bigger, and gets a
shorter list: a big footprint needs more level ground.

Writing the story first and then looking for a world to put it in is how you end up
terraforming a coastline into existence.

## Reseed freely, and only at the start

`craft reseed --seed <word>` takes a second and is free. Five attempts is normal. What you are
looking for is *ground*: somewhere the two ends of the story can be far apart, a coast if the
story wants water, a forest if it wants to hide something.

It stops working the moment you found a place, because site ids are a function of the seed —
so a reseeded scenario would carry correctly-named towns standing nowhere.

## Distances, by what you want them to mean

**These numbers were wrong before and it cost a world.** The first one built this way put its
two towns forty-seven tiles apart on the old guidance, and a player reported it as "the two
key towns were basically overlapping". They were. The bands live in `distance.ts` now, the
survey prints them, and `craft check` warns when two places or two consecutive beats fall
below the floor.

| reach | tiles | what it is |
|---|---|---|
| adjacent | 0+ | the same place with a field in it. Two beats here are one scene |
| neighbouring | 70+ | the next village over, in sight of where you came from |
| a walk | 140+ | half a minute of road with something to see. Where most legs want to be |
| a journey | 300+ | somewhere you set out for. Worth it once, tedious twice |
| far | 550+ | the other end of the world. Put something at the halfway point |

A step is one command and a player manages three or four a second, so a hundred tiles is
around half a minute of holding a key. That is the unit the bands are built from.

**Ask the survey for what you want**, rather than reading coordinates and doing arithmetic:

```
npm run craft -- survey <id> --reach "a journey"
```

lists only the cells at least that far from everything already founded, and prints how far
each is in both words and tiles.

The survey's distance is straight-line. A player walks around water and through gaps, so the
real distance is longer and sometimes very much longer — `craft playtest` measures the real
thing, so trust it over the survey when they disagree.

**A short world is 896 tiles across** and a long one 1792. That is deliberately generous: a
world sized to just fit its beats has no room for the player to be anywhere that is not on
the critical path.

## One place per cell, and no two touching

Sites are addressed by 64-tile macro cell, and a site's id is hashed from its cell — so two
places in one cell would share an id and the spec written for one would name the other.
Founding refuses it.

It also refuses a place whose footprint would run into one already there. Two overlapping
towns are legal as far as the generator is concerned and read as one sprawling place, which is
never what founding a second town meant. If the refusal is in your way, lower `--importance`
rather than moving the story.

## Building budget is the real constraint

A hamlet with room for three buildings cannot hold an inn, a mill and a warehouse *and* the
two houses that make it look like somewhere people live. Name the buildings the story needs
and let the generator fill the rest.

A named building is `required: true` and will be built. An unnamed one is a hint.

`--importance` is the knob for room: it runs 1 to 5 and it is what makes a village big enough
to hold what you are asking of it. Founding tells you the real number before it writes
anything.

## Terraform is a debt

Every edit grows the scenario and makes the world look hand-mangled: a road that goes
straight where every other road bends reads as a seam. Use it for:

- the lane the story needs between two places the road network did not connect
- a bridge where the story crosses water
- a clearing where a scene has to happen and the trees are in the way

Not for reshaping a country. If you find yourself laying a third road, the seed was wrong and
you should have reseeded.

## Moving the ground is a bigger debt

`craft terraform --lower x,y --radius 40 --by 0.06` and its `--raise` twin do something
different from the other edits. A path is a run of road tiles laid over the world; this
changes the elevation field the world is *made of*, so the coastline, the biome, the cliffs,
which ground will hold a building and the rivers all move together.

The numbers are small because the whole world from sea floor to alpine is one unit:

| by | what it does to lowland |
|---|---|
| 0.04 | a dip you can see |
| 0.06 | dry land becomes shore |
| 0.10 | dry land becomes water |
| 0.30 | open sea |

**Shape the land before you found anything on it.** An earthwork under a town moves the
plots its buildings were laid on. `craft terraform` refuses one that leaves a founded place
on ground that no longer holds it, and `craft check` regenerates every settlement against the
new ground — but the cheap order is land first, towns second.

An earthwork cannot belong to a chapter, and the refusal says why: the ground is
world-constant, so a chapter that moved a coastline would move it under a town the player has
already walked through.

## Authoring a river

Rivers are traced by steepest descent over macro cells, so you do not draw one — you make the
water want to go somewhere. A river needs a **source cell above the upland level** that also
passes the spring roll, and then three cells of downhill to run through.

Which means: **raise a hillside, not a pillar.** Macro cells are 64 tiles apart, so a raise
with a radius of 40 lifts one cell and leaves its neighbours where they were; the water runs
off it, finds a local minimum next door and stops, which is two cells and not a river. A
radius of 150 tilts the whole neighbourhood and the water keeps going.

`craft check` will show you what you got. Expect to try three or four positions — you are
asking the seed a question, not giving it an instruction.
