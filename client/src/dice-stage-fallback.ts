let unavailable = false;

export const isDice3dDown = () => unavailable;

/** Disables 3D dice for the current visit. Results still appear in the toast. */
export function dropDice3d(error: unknown) {
  if (!unavailable)
    console.error("board: 3D dice unavailable, showing the result toast only", error);
  unavailable = true;
}
