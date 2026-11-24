// A slash keeps the private room's storage name outside the shared room ID space.
export const secretLayerOf = (board: string) => `${board}/secret`;
export const isSecretLayer = (room: string) => room.endsWith("/secret");
