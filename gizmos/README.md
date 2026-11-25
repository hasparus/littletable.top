# Gizmos

Open `/dev/gizmos` to play with the packages in this checkout. The practice table starts with all three pieces and resets on reload.

| Package                                   | At the table                                                                                                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Tarot deck](tarot/gizmo.json)            | Tap to deal a spread. Drop a card near the deck to leave it face down, or farther away to reveal it. Anyone at the table can tap a loose face-down card to turn it over. [Artwork credits](tarot/ARTWORK.md) |
| [Spotlight tracker](spotlight/gizmo.json) | Mark the player who just took a moment. Their count increases and the marker passes to the next player.                                                                                                      |
| [Explosion button](explosion/gizmo.json)  | Press the red cap for a spring recoil and a short screenshake. Reduced motion keeps the board steady.                                                                                                        |

## Install on a shared board

1. Open a package’s `gizmo.json` on GitHub. Press **Y** to get a permalink containing the full commit SHA, then copy the URL.
2. As the board owner, open **Gizmos** from the board menu. Paste the permalink and choose **Install**.
3. Drag the piece from the gallery onto the board. Tap it or press Enter to place it at the center instead.

A fork is a separate package. For example, copy the explosion directory to a public repository, replace the cap artwork or change `effect` to `"none"`, commit, and install that permalink. Each installation stays on the selected commit.

## What a package can do

Version 1 reads JSON and package-relative raster images. The manifests above are complete examples of the supported deck, tracker, and button primitives. The host handles pointer and keyboard input, multiplayer state, reduced motion, and sound preferences. A button can request the bounded `shake` effect. A deck supplies its card identities, names, dimensions, faces, and back. The room owns the shuffle and draw order.

A shared board stores the installed manifest. Its images resolve on demand from the pinned public repository. Keep the source and its images available while a board uses it.

The [research notebook](../client/public/research/gizmos/index.html) compares options for scripting, distribution, and agent authoring beyond this format.
