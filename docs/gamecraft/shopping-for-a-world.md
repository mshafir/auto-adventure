# Shopping for a world

The generator decides where settlements can exist. You decide which of them the story is
about. Getting that round the right way is most of what makes a scenario feel deliberate
rather than assembled.

## Survey before you write anything

`craft survey` costs nothing and tells you everything the generator has already decided:
which places exist, how big, on what ground, how far apart, and which anchors they will lay
down. Every one of those is a fact the story can be built on.

Writing the story first and then looking for a world to put it in is how you end up
terraforming a coastline into existence.

## Reseed freely, and only at the start

`craft reseed --seed <word>` takes a second and is free. Five attempts is normal. What you are
looking for is a *shape*: two towns the right distance apart, a ruin between them, a coast
where the story wants water.

It stops working the moment you claim a site, because site ids are a function of the seed —
so a reseeded scenario would carry correctly-named towns standing nowhere. `craft reseed`
refuses once anything is claimed, which is why the shopping has to be finished first.

## What "the right distance" means

`distanceFromSpawn` is straight-line. A player walks around water and through gaps, so the
real distance is longer and sometimes very much longer.

- Under 30 tiles: the same place, effectively. Two beats here are one scene.
- 40–80: a walk with something to see. This is where most legs of a story want to be.
- Over 150: a journey. Worth it once in a story, tedious twice.

`craft playtest` measures the real thing, so trust it over the survey when they disagree.

## Building budget is the real constraint

A hamlet with room for three buildings cannot hold an inn, a mill and a warehouse *and* the
two houses that make it look like somewhere people live. Claim the buildings the story needs
by name and let the generator fill the rest.

A named building is `required: true` and will be built. An unnamed one is a hint.

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
