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

## What "the right distance" means

The survey's distance is straight-line. A player walks around water and through gaps, so the
real distance is longer and sometimes very much longer.

- Under 30 tiles: the same place, effectively. Two beats here are one scene.
- 40–80: a walk with something to see. This is where most legs of a story want to be.
- Over 150: a journey. Worth it once in a story, tedious twice.

`craft playtest` measures the real thing, so trust it over the survey when they disagree.

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

## Elevation is not available yet

Authored rivers need the elevation field to be editable, so that lowering a valley makes the
existing river network flow there rather than stamping water onto a hillside. That is designed
and not built. Until it is, a story that needs a river needs a seed that has one.
