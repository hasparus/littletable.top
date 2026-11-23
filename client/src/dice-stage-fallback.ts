let unavailable = false;

export const isDice3dDown = () => unavailable;

// NOTE: one failure (the chunk, WebGL2 or an error mid-throw) turns the 3D
// dice off for the rest of the visit; the toast carries the result alone.
export function dropDice3d(error: unknown) {
  if (!unavailable)
    console.error("board: 3D dice unavailable, showing the result toast only", error);
  unavailable = true;
}
