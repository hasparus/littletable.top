// WorkOS AuthKit as the sign-in provider, over its REST API with fetch: the
// hosted AuthKit page offers whichever methods the WorkOS dashboard enables
// (passkeys, Google, Discord, Magic Auth e-mail codes), and the Worker only
// sees the authorization code come back.
// https://workos.com/docs/reference/authkit/authentication/get-authorization-url
// https://workos.com/docs/reference/authkit/authentication/code

import { decodeJwt } from "jose";

import { type Exchange, type Identity, ProviderError, type SignInProvider } from "./provider";

export type WorkOsSettings = {
  apiBase: string;
  apiKey: string;
  clientId: string;
};

type WorkOsUser = {
  email: string;
  first_name: string | null;
  id: string;
  last_name: string | null;
  profile_picture_url: string | null;
};

function displayName(user: WorkOsUser): string {
  const full = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return full === "" ? user.email.split("@")[0]! : full;
}

// The access token's `sid` names the AuthKit session, which sign-out ends.
// NOTE: the token came straight from WorkOS over TLS in answer to our
// secret, so it is read, not verified against WorkOS's keys.
function sessionOf(accessToken: unknown): string | null {
  if (typeof accessToken !== "string") return null;
  try {
    const { sid } = decodeJwt(accessToken);
    return typeof sid === "string" ? sid : null;
  } catch {
    return null;
  }
}

export function workOs(settings: WorkOsSettings): SignInProvider {
  const api = (path: string) => new URL(path, settings.apiBase);
  return {
    authorizationUrl({ codeChallenge, redirectUri, state }) {
      const url = api("/user_management/authorize");
      url.search = new URLSearchParams({
        client_id: settings.clientId,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        provider: "authkit",
        redirect_uri: redirectUri,
        response_type: "code",
        state,
      }).toString();
      return url.toString();
    },

    async exchange({ clientIp, code, codeVerifier, userAgent }: Exchange): Promise<Identity> {
      const response = await fetch(api("/user_management/authenticate"), {
        body: JSON.stringify({
          client_id: settings.clientId,
          client_secret: settings.apiKey,
          code,
          code_verifier: codeVerifier,
          grant_type: "authorization_code",
          ip_address: clientIp,
          user_agent: userAgent,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        throw new ProviderError(`WorkOS refused the code: ${response.status}`);
      }
      const body = (await response.json()) as { access_token?: unknown; user?: WorkOsUser };
      if (typeof body.user?.id !== "string") throw new ProviderError("WorkOS named no user");
      return {
        avatarUrl: body.user.profile_picture_url,
        name: displayName(body.user),
        providerSession: sessionOf(body.access_token),
        subject: body.user.id,
      };
    },

    signOutUrl({ providerSession, returnTo }) {
      if (providerSession === null) return null;
      const url = api("/user_management/sessions/logout");
      url.search = new URLSearchParams({
        return_to: returnTo,
        session_id: providerSession,
      }).toString();
      return url.toString();
    },
  };
}
