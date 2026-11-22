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
  board: string;
  link: number;
  name: string;
  owner: boolean;
  sub: string;
};

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
  const { board, link, name, owner, sub } = payload;
  if (
    typeof sub !== "string" ||
    typeof board !== "string" ||
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > MAX_NAME_LENGTH ||
    typeof owner !== "boolean" ||
    !Number.isInteger(link) ||
    (link as number) < 0
  ) {
    throw new Error("Invalid pass");
  }
  return { board, link: link as number, name, owner, sub };
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
