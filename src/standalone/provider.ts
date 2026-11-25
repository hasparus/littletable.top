export type Identity = {
  avatarUrl: string | null;
  name: string;
  /** The provider's own session, kept to end it on sign-out; null if none. */
  providerSession: string | null;
  /** The provider's stable user id, which becomes the account id. */
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

/** Runs the PKCE redirect flow. The Worker owns the resulting accounts and sessions. */
export interface SignInProvider {
  authorizationUrl(input: { codeChallenge: string; redirectUri: string; state: string }): string;
  /**
   * Trades the code the callback received for the person; throws
   * ProviderError when the provider refuses it.
   */
  exchange(input: Exchange): Promise<Identity>;
  /** Where to send the browser to end the provider's session too, or null. */
  signOutUrl(input: { providerSession: string | null; returnTo: string }): string | null;
}
