# Eclectic Oxlint config

This is the packed `@hasparus/oxlint-config` 0.5.0 workspace from
[hasparus/eclectic at be6fb249](https://github.com/hasparus/eclectic/tree/be6fb249933437e26821922f92f2fc3b1f6f6fdc/packages/hasparus-oxlint-config).
Bun's GitHub dependency resolves the monorepo root. The package lives in
`packages/hasparus-oxlint-config` and needs its build to include the JavaScript
config and plugins.

To regenerate the package, check out that revision, install the Eclectic
workspace dependencies, and run these commands from its Oxlint config directory.

```sh
bun run build
bun pm pack
```

Copy the resulting tarball here and update the dependency and lockfile.

## Warning baseline

`bun run lint` fails on every error and on warning counts that exceed
`oxlint-warning-baseline.json` for their file and rule. This lets the repo adopt
the new rules while reducing existing warnings. Lower or remove the matching
counts when addressing a warning. To see every finding, run:

```sh
bun run oxlint -c oxlint.config.ts client src alchemy e2e
```
