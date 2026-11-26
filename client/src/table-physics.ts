export const FPS = 60;
const SUBSTEPS = 4;
export const DT = 1 / (FPS * SUBSTEPS);
const GRAVITY = 70;
const RESTITUTION = 0.32;
const BOUNCE_MIN = 1.2;

export function advancePhysicsFrame(step: () => void) {
  for (let k = 0; k < SUBSTEPS; k += 1) step();
}

export function fallingSpeed(speed: number) {
  return speed - GRAVITY * DT;
}

export function reboundSpeed(speed: number, restitution = RESTITUTION) {
  return speed < -BOUNCE_MIN ? -restitution * speed : 0;
}
