export const MAX_PEOPLE = 30;
export const MAX_DICE = 20;
export const DIE_SIDES = [4, 6, 8, 10, 12, 20, 100] as const;
export const ROLL_LOG_LENGTH = 50;
export const MIN_ROLL_INTERVAL_MS = 500;
export const MAX_NAME_LENGTH = 40;
export const MAX_TITLE_LENGTH = 80;
// Standalone mode: boards an account may keep and create per hour, passes an
// address may ask for per minute, and sign-ins it may start per minute.
export const MAX_BOARDS_PER_ACCOUNT = 100;
export const MAX_BOARDS_PER_HOUR = 20;
export const MAX_PASSES_PER_MINUTE = 30;
export const MAX_SIGN_INS_PER_MINUTE = 10;
