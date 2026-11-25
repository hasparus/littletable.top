import { importSPKI, jwtVerify } from "jose";

import { MAX_NAME_LENGTH } from "./limits";

/**
 * Who may vouch for a pass: one key, one issuer, one audience. Hosted mode
 * trusts the host's public key; standalone mode the Worker's own.
 */
export type Verifier = {
  audience: string;
  issuer: string;
  key: CryptoKey;
};

/**
 * What the issuer vouches for: this person may be on this board while the
 * board's link is at this version.
 */
export type Pass = {
  /**
   * Hosted mode: the person's picture, a URL on the host's origin.
   * Standalone mode: the SHA-256 of the copy the Worker made at sign-in.
   * Null for a guest or anyone without one.
   */
  avatar: string | null;
  board: string;
  link: number;
  name: string;
  owner: boolean;
  role: Role;
  /** Only a standalone secret-layer pass is bound to an account session. */
  sessionHash?: string;
  sub: string;
};

/** Owners and board managers can grant assistants access. Guests can draw. */
export type Role = "owner" | "shaman" | "write";

const MAX_AVATAR_CLAIM = 2048;

const imported = new Map<string, Promise<CryptoKey>>();

export function publicKeyFrom(pem: string): Promise<CryptoKey> {
  let key = imported.get(pem);
  if (key === undefined) {
    key = importSPKI(pem, "RS256");
    imported.set(pem, key);
  }
  return key;
}

export async function verifyPass(token: string, verifier: Verifier): Promise<Pass> {
  const { payload } = await jwtVerify(token, verifier.key, {
    algorithms: ["RS256"],
    audience: verifier.audience,
    issuer: verifier.issuer,
    requiredClaims: ["exp", "iat", "sub"],
  });
  const { avatar, board, link, name, owner, sessionHash, sub } = payload;
  let { role } = payload;
  if (role === undefined) {
    if (owner === true) role = "owner";
    if (owner === false) role = "write";
  }
  if (
    typeof sub !== "string" ||
    typeof board !== "string" ||
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > MAX_NAME_LENGTH ||
    (role !== "owner" && role !== "shaman" && role !== "write") ||
    (sub.startsWith("g:") && role !== "write") ||
    !Number.isInteger(link) ||
    (link as number) < 0
  ) {
    throw new Error("Invalid pass");
  }
  // WARNING: Invalid optional avatars must not cause an otherwise valid pass to be rejected.
  const picture =
    typeof avatar === "string" && avatar.length > 0 && avatar.length <= MAX_AVATAR_CLAIM
      ? avatar
      : null;
  return {
    avatar: picture,
    board,
    link: link as number,
    name,
    owner: role === "owner",
    role,
    ...(typeof sessionHash === "string" ? { sessionHash } : {}),
    sub,
  };
}

async function verifyBoardCommand(token: string, verifier: Verifier) {
  const { payload } = await jwtVerify(token, verifier.key, {
    algorithms: ["RS256"],
    audience: verifier.audience,
    issuer: verifier.issuer,
    requiredClaims: ["exp"],
  });
  if (typeof payload.board !== "string") throw new TypeError("Invalid board command");
  return { board: payload.board, link: payload.link };
}

export async function verifyDeletion(token: string, verifier: Verifier): Promise<string> {
  const { board } = await verifyBoardCommand(token, verifier);
  return board;
}

export async function verifyLinkReset(token: string, verifier: Verifier) {
  const { board, link } = await verifyBoardCommand(token, verifier);
  if (typeof link !== "number" || !Number.isSafeInteger(link) || link < 1) {
    throw new Error("Invalid link version");
  }
  return { board, link };
}
