/** The slash keeps private room names outside the shared board ID space. */
export const secretLayerOf = (board: string) => `${board}/secret`;
export const isSecretLayer = (room: string) => room.endsWith("/secret");
