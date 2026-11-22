// The one seam between standalone mode's accounts and whoever proves who a
// person is. The Worker owns accounts, sessions and boards; a provider only
// runs a redirect sign-in (authorization code with PKCE) and names the
// person who came back. workos.ts is the one implementation.

export type Identity = {
  avatarUrl: string | null;
  name: string;
  // The provider's own session, kept to end it on sign-out; null if none.
  providerSession: string | null;
  // The provider's stable user id, which becomes the account id.
  subject: string;
};

export type Exchange = {
  clientIp: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  userAgent: string;
};

export class ProviderError extends Error {
  override name = "ProviderError";
}

export interface SignInProvider {
  // Where to send the browser to sign in.
  authorizationUrl(input: { codeChallenge: string; redirectUri: string; state: string }): string;
  // Trades the code the callback received for the person; throws
  // ProviderError when the provider refuses it.
  exchange(input: Exchange): Promise<Identity>;
  // Where to send the browser to end the provider's session too, or null.
  signOutUrl(input: { providerSession: string | null; returnTo: string }): string | null;
}
