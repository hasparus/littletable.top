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
// Images on a board: the largest file the Worker stores (what a phone's
// photo is re-encoded to fit, see client/src/images.ts), the bytes one board
// may keep in all (each distinct image counted once), and uploads a person
// may start per minute, which a .tldr import with many images also spends.
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_BOARD_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_UPLOADS_PER_MINUTE = 60;
// People's pictures (src/avatars.ts): the largest one copied (a provider's
// are tens of kilobytes), how long a copy may take before the person goes
// without, the redirects followed, and how long a hosted board waits before
// it tries a picture that failed again.
export const MAX_AVATAR_BYTES = 1024 * 1024;
export const AVATAR_TIMEOUT_MS = 3000;
export const MAX_AVATAR_REDIRECTS = 3;
export const AVATAR_RETRY_MS = 60 * 60 * 1000;
// Text read off a board's images (src/text-store.ts): the largest result a
// browser may store for one image and engine, its words and their length;
// how many results a person may store, and readings they may claim, per
// minute; how long a claim holds without being renewed; and how many
// failed readings of one image make the board stop handing it out.
export const MAX_TEXT_RESULT_BYTES = 512 * 1024;
export const MAX_TEXT_WORDS = 20_000;
export const MAX_WORD_LENGTH = 64;
export const MAX_TEXT_WRITES_PER_MINUTE = 60;
export const MAX_TEXT_CLAIMS_PER_MINUTE = 60;
export const TEXT_LEASE_MS = 30_000;
export const MAX_TEXT_FAILURES = 3;
