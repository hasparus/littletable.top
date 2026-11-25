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
