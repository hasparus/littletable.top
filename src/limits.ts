export const MAX_PEOPLE = 30;
export const MAX_DICE = 20;
export const DIE_SIDES = [4, 6, 8, 10, 12, 20, 100] as const;
export const ROLL_LOG_LENGTH = 50;
export const MIN_ROLL_INTERVAL_MS = 500;
export const MAX_NAME_LENGTH = 40;
export const MAX_TITLE_LENGTH = 80;
export const MAX_BOARDS_PER_ACCOUNT = 100;
export const MAX_BOARDS_PER_HOUR = 20;
export const MAX_PASSES_PER_MINUTE = 30;
export const MAX_SIGN_INS_PER_MINUTE = 10;
/** The client re-encodes phone photos to fit this limit before uploading. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Duplicate uploads count against this quota once. */
export const MAX_BOARD_FILE_BYTES = 256 * 1024 * 1024;
/** Images embedded in .tldr files spend the same allowance as individual uploads. */
export const MAX_UPLOADS_PER_MINUTE = 60;
export const MAX_AVATAR_BYTES = 1024 * 1024;
/** Caps avatar-copy latency so a slow picture cannot hold up sign-in or board entry. */
export const AVATAR_TIMEOUT_MS = 3000;
export const MAX_AVATAR_REDIRECTS = 3;
export const AVATAR_RETRY_MS = 60 * 60 * 1000;
export const MAX_TEXT_RESULT_BYTES = 512 * 1024;
export const MAX_TEXT_WORDS = 20_000;
export const MAX_WORD_LENGTH = 64;
export const MAX_TEXT_WRITES_PER_MINUTE = 60;
export const MAX_TEXT_CLAIMS_PER_MINUTE = 60;
export const TEXT_LEASE_MS = 30_000;
export const MAX_TEXT_FAILURES = 3;
