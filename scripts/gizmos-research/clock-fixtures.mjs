// WebAssembly 1.0 modules for the local experiment. The fixtures use single-byte section lengths.
const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const signature = [1, 6, 1, 0x60, 1, 0x7f, 1, 0x7f]; // (i32) -> i32
const oneFunction = [3, 2, 1, 0];
const exportStep = [7, 8, 1, 4, 0x73, 0x74, 0x65, 0x70, 0, 0]; // export "step"

function rule(instructions, memory = []) {
  const body = [0, ...instructions, 0x0b]; // No locals. Terminate the function body.
  const code = [10, body.length + 2, 1, body.length, ...body];
  return Uint8Array.from([
    ...header,
    ...signature,
    ...oneFunction,
    ...memory,
    ...exportStep,
    ...code,
  ]);
}

// (func (export "step") (param i32) (result i32) (i32.add (local.get 0) (i32.const 1)))
export const increment = rule([0x20, 0, 0x41, 1, 0x6a]);

// (import "host" "step" (func (param i32) (result i32)))
const importStep = [2, 13, 1, 4, 104, 111, 115, 116, 4, 115, 116, 101, 112, 0, 0];
export const requiresHost = Uint8Array.from([
  ...header,
  ...signature,
  ...importStep,
  ...exportStep,
]);

// Identity function with one private, unexported page of linear memory.
export const requiresMemory = rule([0x20, 0], [5, 3, 1, 0, 1]);

// (loop (br 0)) followed by an unreachable result.
export const neverFinishes = rule([0x03, 0x40, 0x0c, 0, 0x0b, 0x41, 0]);
