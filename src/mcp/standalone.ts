import { createRemoteJWKSet, jwtVerify } from "jose";

import type { McpSettings } from "./route";

import { AssistantGrants } from "../standalone/assistant-grants";

export function standaloneMcp(
  issuer: string,
  resource: string,
  db: D1Database,
  manageUrl: string | undefined,
  deployment: string,
): McpSettings {
  const jwks = createRemoteJWKSet(new URL("/oauth2/jwks", issuer));
  const grants = new AssistantGrants(db, deployment);
  return {
    async authenticate(token) {
      let identity;
      try {
        const { payload } = await jwtVerify(token, jwks, {
          algorithms: ["RS256"],
          audience: resource,
          issuer,
          requiredClaims: ["exp", "iat", "sub", "client_id", "sid"],
        });
        const { client_id: clientId, sid, sub, sub_profile: profile } = payload;
        if (
          profile === "ai_agent" ||
          typeof sub !== "string" ||
          !sub ||
          typeof sid !== "string" ||
          !sid ||
          typeof clientId !== "string" ||
          !clientId ||
          clientId.length > 512
        )
          return null;
        identity = { account: sub, clientId };
      } catch {
        return null;
      }
      await grants.register(identity.account, identity.clientId);
      return {
        ...identity,
        boards: await grants.grants(identity.account, identity.clientId),
        manageUrl,
      };
    },
    authorizationServer: issuer,
    resource,
    scopes: ["openid", "offline_access"],
  };
}
