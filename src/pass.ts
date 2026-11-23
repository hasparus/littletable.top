import { importSPKI, jwtVerify } from "jose";

import { MAX_NAME_LENGTH } from "./limits";

// Who may vouch for a pass: one key, one issuer, one audience. Hosted mode
// trusts the host's public key; standalone mode the Worker's own.
export type Verifier = {
  audience: string;
  issuer: string;
  key: CryptoKey;
};

// What the issuer vouches for: this person may be on this board while the
// board's link is at this version.
export type Pass = {
  // Hosted mode: the person's picture, a URL on the host's origin.
  // Standalone mode: the SHA-256 of the copy the Worker made at sign-in.
  // Null for a guest or anyone without one.
  avatar: string | null;
  board: string;
  link: number;
  name: string;
  // Whether the person owns the board: `role` is "owner".
  owner: boolean;
  role: Role;
  sub: string;
};

// What a person is on a board. Anyone with a pass may draw; a shaman may
// also connect an assistant to the board and say whether it reads or
// edits; the owner makes shamans and is one. A guest is always "write".
export type Role = "owner" | "shaman" | "write";

const ROLES = new Set<unknown>(["owner", "shaman", "write"]);

// NOTE: a pass from before roles says only `owner`; it reads as the owner
// or as "write". A pass with both is taken by its role.
function roleOf(role: unknown, owner: unknown): Role | null {
  if (role !== undefined) return ROLES.has(role) ? (role as Role) : null;
  if (typeof owner !== "boolean") return null;
  return owner ? "owner" : "write";
}

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
  const { avatar, board, link, name, owner, sub } = payload;
  const role = roleOf(payload.role, owner);
  if (
    typeof sub !== "string" ||
    typeof board !== "string" ||
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > MAX_NAME_LENGTH ||
    role === null ||
    // A guest (`g:`) holds no role beyond drawing.
    (sub.startsWith("g:") && role !== "write") ||
    !Number.isInteger(link) ||
    (link as number) < 0
  ) {
    throw new Error("Invalid pass");
  }
  // NOTE: a malformed picture costs the person their picture, not the board.
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
    sub,
  };
}

// NOTE: its own audience keeps the two kinds apart: a pass cannot delete a
// board, and a deletion token cannot open a socket or roll.
export async function verifyDeletion(token: string, verifier: Verifier): Promise<string> {
  const { payload } = await jwtVerify(token, verifier.key, {
    algorithms: ["RS256"],
    audience: verifier.audience,
    issuer: verifier.issuer,
    requiredClaims: ["exp"],
  });
  if (typeof payload.board !== "string") throw new Error("Invalid deletion token");
  return payload.board;
}
