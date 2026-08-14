# Things that looked right and were wrong

Every one of these passed the checks that existed at the time. That is what makes them worth
writing down: a fault a validator catches is a fault nobody needs to remember.

## A scene staged perfectly and nothing moved

The fixture cast a rider — the person who arrives with the news — as the shrine-keeper who was
already standing at the well. The scene staged clean, `craft check` passed, and the walk was
nought tiles long: the actor was already at the destination.

What it looked like in play: the camera pans, a caption appears, the camera pans back. No
arrival, no movement, nothing to watch. It reads as a rendering fault rather than as a scene.

**The rule.** A cast member already in the world starts where they stand. `Spawn` is for
somebody genuinely not there yet. If the story says somebody *arrives*, they must be spawned
somewhere they are not, and the somewhere has to be a real tile on the road they would come
in by.

`craft check` cannot catch this: a walk of zero tiles is legal, and often correct, when the
destination is computed. Watch the scene.

## Four gates, and "the first one" is not a thing an author means

Ash Hollow has four `gate` anchors. `{ kind: "anchor", anchor: "gate" }` resolves to whichever
the generator laid down first, which had nothing to do with the road the news came along.

**The rule.** Where several anchors of a kind exist, use a world tile — `craft render` and
`craft survey` are how you find the right one. The anchor spelling is for the anchors there is
only one of: the square, the well.

## The town has room for ten buildings and you asked for twelve

`craft claim` refuses this now, and says how much room there is. Before it did, the generator
substituted filler for the buildings that would not fit — so the story's counting house became
a house, silently, and the beat anchored to it put a named character in a building that was
not there.

**The rule.** The survey's `room for N` is a hard number. Ask for fewer than it.

## An anchor that only exists indoors

`hearth` is a real anchor kind and every one of them is inside somebody's house. A scene that
names it resolves to a tile in a front room, and the cutscene plays there — which is not what
"at the hearth" meant.

**The rule.** Scene points are outdoor. `craft check` refuses an indoor anchor now, and says
so. For somebody indoors, use `--in` on the NPC and let the beat happen in conversation.

## A conversation that traps the panel open

A dialogue tree whose every node has choices and none of them `goto: null` has no way out. ESC
still works, but a player should not have to know that.

`craft tree --init` scaffolds one with a way out already. If you write nodes by hand, every
branch needs to reach a `null`.
