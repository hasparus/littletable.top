# Gizmos

Open `/dev/gizmos` to play with the packages in this checkout. The practice table starts with all three pieces and resets on reload. Open `/dev/gizmos?empty` to try a first installation.

| Package                                   | At the table                                                                                                                                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Tarot deck](tarot/gizmo.json)            | Tap to deal a spread. Lift from the deck and place face down, or toss to reveal. Loose cards coast when tossed and keep their side up. Tap one to turn it over. [Artwork credits](tarot/ARTWORK.md) |
| [Spotlight tracker](spotlight/gizmo.json) | Mark the player who just took a moment. Their count increases and the marker passes to the next player.                                                                                             |
| [Explosion button](explosion/gizmo.json)  | Press the red cap for a spring recoil and a short screenshake. Reduced motion keeps the board steady.                                                                                               |

## Install on a shared board

Open **Gizmos** from the board menu. A new board opens the marketplace. Once a piece is installed, the menu opens the drawer and **Browse marketplace** takes you back to the catalog.

Owners can install an [official listing](registry.json) or paste a public GitHub folder or `gizmo.json` link. Browsing loads only listing metadata and thumbnails. Install resolves the link to a commit and fetches the manifest. The drawer opens with the installed piece in view. Anyone at the table can drag the piece onto the board, or tap it or press Enter to place it at the center.

Participants can request a listing or paste their own link. The owner sees the package source and who requested it, and can install or decline it. Requests survive the owner being away. Repeated requests for the same source share one decision.

A fork is a separate package. For example, copy the explosion directory to a public repository, replace the cap artwork or change `effect` to `"none"`, commit, and install that permalink. Each installation stays on the selected commit.

## What a package can do

Version 1 reads JSON and package-relative raster images. The manifests above are complete examples of the supported deck, tracker, and button primitives. The host handles pointer and keyboard input, multiplayer state, reduced motion, and sound preferences. A button can request the bounded `shake` effect. A deck supplies its card identities, names, dimensions, faces, and back. The room owns the shuffle and draw order.

A shared board stores the installed manifest. Its images resolve on demand from the pinned public repository. Keep the source and its images available while a board uses it.

The [research notebook](../client/public/research/gizmos/index.html) compares options for scripting, distribution, and agent authoring beyond this format.
