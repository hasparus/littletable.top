type ScheduledEvent = { at: number; type: "begin" | "reset" | "restart" | "finish" };

const [seedText = "43", variant = "current"] = process.argv.slice(2);
const seed = Number(seedText);
if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
  throw new Error("Seed must be an unsigned 32-bit integer");
}
if (variant !== "current" && variant !== "stale-snapshot") {
  throw new Error("Variant must be current or stale-snapshot");
}

let rng = seed;
function delay(max: number): number {
  rng = (Math.imul(rng, 1_664_525) + 1_013_904_223) >>> 0;
  return (rng >>> 16) % max;
}

const agenda: ScheduledEvent[] = [
  { at: 0, type: "begin" },
  { at: 1 + delay(5), type: "reset" },
  { at: 2 + delay(5), type: "restart" },
  { at: 3 + delay(5), type: "finish" },
];
agenda.sort((a, b) => a.at - b.at);

const passVersion = 0;
let storedVersion = 0;
let roomVersion = 0;
let sampledVersion = 0;
let resetDelivered = false;

console.log(`seed=${seed} variant=${variant}`);
for (const { at, type } of agenda) {
  switch (type) {
    case "begin":
      sampledVersion = roomVersion;
      console.log(`t=${at} begin pass v${passVersion}; saw v${sampledVersion}`);
      break;
    case "reset":
      storedVersion = 1;
      roomVersion = 1;
      resetDelivered = true;
      console.log(`t=${at} reset to v1`);
      break;
    case "restart":
      roomVersion = storedVersion;
      console.log(`t=${at} restart; loaded v${roomVersion}`);
      break;
    case "finish": {
      const checkedVersion = variant === "stale-snapshot" ? sampledVersion : roomVersion;
      const admitted = passVersion >= checkedVersion;
      console.log(`t=${at} finish; ${admitted ? "accepted" : "rejected"} pass v${passVersion}`);
      const shouldAdmit = !resetDelivered;
      if (admitted !== shouldAdmit) {
        console.log("FAIL: admission must match whether the reset has been delivered");
        process.exitCode = 1;
      }
      break;
    }
  }
}
if (process.exitCode !== 1) console.log("PASS");
