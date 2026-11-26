// WARNING: A plain modulo would bias rolls toward the low faces.
export function rollDie(sides: number) {
  const limit = 2 ** 32 - (2 ** 32 % sides);
  const draw = new Uint32Array(1);
  do crypto.getRandomValues(draw);
  while (draw[0]! >= limit);
  return (draw[0]! % sides) + 1;
}
