// Standalone mode is its own issuer: one RSA key signs its passes and the
// short-lived cookies of a sign-in in progress, and its public half verifies
// them through the same code path as a host's passes.

import { exportJWK, importJWK, importPKCS8, type JWTPayload, jwtVerify, SignJWT } from "jose";

import type { Pass, Verifier } from "../pass";

import { STANDALONE_AUDIENCE, STANDALONE_ISSUER } from "../config";

export type Keys = { private: CryptoKey; public: CryptoKey };

const loaded = new Map<string, Promise<Keys>>();

async function load(pem: string): Promise<Keys> {
  const signing = await importPKCS8(pem, "RS256", { extractable: true });
  const { e, kty, n } = await exportJWK(signing);
  const verifying = await importJWK({ alg: "RS256", e, kty, n }, "RS256");
  return { private: signing, public: verifying as CryptoKey };
}

export function keysFrom(pem: string): Promise<Keys> {
  let keys = loaded.get(pem);
  if (keys === undefined) {
    keys = load(pem);
    loaded.set(pem, keys);
  }
  return keys;
}

export const passVerifier = (keys: Keys): Verifier => ({
  audience: STANDALONE_AUDIENCE,
  issuer: STANDALONE_ISSUER,
  key: keys.public,
});

export const PASS_LIFETIME_S = 300;

export function signPass(
  keys: Keys,
  { avatar, board, link, name, owner, sessionHash, sub }: Pass,
): Promise<string> {
  return new SignJWT({
    board,
    link,
    name,
    owner,
    ...(avatar === null ? {} : { avatar }),
    ...(sessionHash === undefined ? {} : { sessionHash }),
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(STANDALONE_ISSUER)
    .setAudience(STANDALONE_AUDIENCE)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(`${PASS_LIFETIME_S}s`)
    .sign(keys.private);
}

// Small signed values the Worker hands the browser to keep (a guest's id and
// name, a sign-in's state), each under an audience of its own so none can
// stand in for another or for a pass.
export function seal(
  keys: Keys,
  audience: string,
  claims: JWTPayload,
  lifetimeSeconds: number,
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(STANDALONE_ISSUER)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${lifetimeSeconds}s`)
    .sign(keys.private);
}

export async function unseal(
  keys: Keys,
  audience: string,
  token: string,
): Promise<JWTPayload | null> {
  try {
    const { payload } = await jwtVerify(token, keys.public, {
      algorithms: ["RS256"],
      audience,
      issuer: STANDALONE_ISSUER,
    });
    return payload;
  } catch {
    return null;
  }
}
