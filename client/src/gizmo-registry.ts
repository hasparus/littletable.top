import official from "../../gizmos/registry.json";

type Listing = (typeof official)[number];

const reviewed = import.meta.glob<Listing>("../../gizmos/registry/*.json", {
  eager: true,
  import: "default",
});

export const registry = [...official, ...Object.values(reviewed)];
