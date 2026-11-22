// What a deployment configures, read once per request from the Worker's
// environment. A configuration that mixes the two modes, or misses what its
// mode needs, serves nothing (see `readConfig`).

export type ConfigEnv = {
  // "hosted" (a host application signs passes) or "standalone" (the
  // tabletop signs its own).
  TABLETOP_MODE?: string;
  // Hosted: the issuer's public key (SPKI PEM, "\n" escapes allowed), its
  // `iss`, and the audiences of passes and deletion tokens.
  DELETION_AUDIENCE?: string;
  ISSUER?: string;
  ISSUER_PUBLIC_KEY?: string;
  PASS_AUDIENCE?: string;
  // Hosted, optional: the host's OAuth authorization server (its issuer
  // URL), which turns on the MCP endpoint, and the `aud` of its access tokens.
  MCP_AUDIENCE?: string;
  MCP_AUTHORIZATION_SERVER?: string;
  // Hosted: the host's origin, which the client asks for passes, and where a
  // person typing the tabletop's bare name goes.
  HOME_URL?: string;
  HOST_ORIGIN?: string;
  // Standalone: the deployment's name, where a guest is sent back to.
  DISPLAY_NAME?: string;
  // Standalone: the private key (PKCS#8 PEM) the Worker signs passes with.
  SIGNING_KEY?: string;
  // Standalone: the WorkOS application people sign in through, its API
  // key (a secret), and the API's address (tests point it at a fake).
  WORKOS_API_BASE?: string;
  WORKOS_API_KEY?: string;
  WORKOS_CLIENT_ID?: string;
  // The host the tabletop answers on, and the hosts that 308 to it, comma
  // separated. Without a primary host nothing redirects.
  ALIAS_HOSTS?: string;
  PRIMARY_HOST?: string;
};

// The standalone mode's own names. A hosted configuration may not use them,
// so a pass one mode issues is never one the other accepts.
export const STANDALONE_ISSUER = "tabletop";
export const STANDALONE_AUDIENCE = "tabletop-standalone";

export type Hosts = { aliases: string[]; primary: string | null };

export type HostedConfig = {
  deletionAudience: string;
  homeUrl: string;
  hostOrigin: string;
  hosts: Hosts;
  issuer: string;
  mcp: { audience: string; authorizationServer: string } | null;
  mode: "hosted";
  passAudience: string;
  publicKey: string;
};

export type StandaloneConfig = {
  displayName: string;
  hosts: Hosts;
  mode: "standalone";
  signingKey: string;
  workOs: { apiBase: string; apiKey: string; clientId: string };
};

export type Config = HostedConfig | StandaloneConfig;

export class ConfigError extends Error {
  override name = "ConfigError";
}

const present = (value: string | undefined): value is string =>
  value !== undefined && value.trim() !== "";

const pem = (value: string) => value.replaceAll(String.raw`\n`, "\n");

function origin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} is not a URL`);
  }
  if (url.origin !== value.replace(/\/$/u, "")) {
    throw new ConfigError(`${name} must be an origin, with no path`);
  }
  return url.origin;
}

function hostsOf(env: ConfigEnv): Hosts {
  const primary = present(env.PRIMARY_HOST) ? env.PRIMARY_HOST.trim().toLowerCase() : null;
  const aliases = (env.ALIAS_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== "");
  if (primary === null && aliases.length > 0) {
    throw new ConfigError("ALIAS_HOSTS needs a PRIMARY_HOST to lead to");
  }
  if (primary !== null && aliases.includes(primary)) {
    throw new ConfigError("PRIMARY_HOST cannot also be an alias");
  }
  return { aliases, primary };
}

function forbid(env: ConfigEnv, mode: string, names: (keyof ConfigEnv)[]) {
  const set = names.filter((name) => present(env[name]));
  if (set.length > 0) throw new ConfigError(`${set.join(", ")} cannot be set in ${mode} mode`);
}

function require(env: ConfigEnv, mode: string, names: (keyof ConfigEnv)[]) {
  const missing = names.filter((name) => !present(env[name]));
  if (missing.length > 0) throw new ConfigError(`${mode} mode needs ${missing.join(", ")}`);
}

function hosted(env: ConfigEnv): HostedConfig {
  require(env, "hosted", ["ISSUER_PUBLIC_KEY", "ISSUER", "HOST_ORIGIN"]);
  forbid(env, "hosted", [
    "SIGNING_KEY",
    "DISPLAY_NAME",
    "WORKOS_API_KEY",
    "WORKOS_CLIENT_ID",
    "WORKOS_API_BASE",
  ]);
  const passAudience = present(env.PASS_AUDIENCE) ? env.PASS_AUDIENCE : "board";
  const deletionAudience = present(env.DELETION_AUDIENCE)
    ? env.DELETION_AUDIENCE
    : "board-deletion";
  if (passAudience === deletionAudience) {
    throw new ConfigError("PASS_AUDIENCE and DELETION_AUDIENCE must differ");
  }
  if (env.ISSUER === STANDALONE_ISSUER) {
    throw new ConfigError(`ISSUER "${STANDALONE_ISSUER}" is the standalone mode's own`);
  }
  if ([deletionAudience, passAudience].includes(STANDALONE_AUDIENCE)) {
    throw new ConfigError(`the audience "${STANDALONE_AUDIENCE}" is the standalone mode's own`);
  }
  const hostOrigin = origin(env.HOST_ORIGIN!, "HOST_ORIGIN");
  const mcpAudience = present(env.MCP_AUDIENCE) ? env.MCP_AUDIENCE : "tabletop-mcp";
  if ([deletionAudience, passAudience, STANDALONE_AUDIENCE].includes(mcpAudience)) {
    throw new ConfigError("MCP_AUDIENCE must differ from the other audiences");
  }
  return {
    deletionAudience,
    homeUrl: present(env.HOME_URL) ? env.HOME_URL : `${hostOrigin}/`,
    hostOrigin,
    hosts: hostsOf(env),
    issuer: env.ISSUER!,
    mcp: present(env.MCP_AUTHORIZATION_SERVER)
      ? {
          audience: mcpAudience,
          authorizationServer: origin(env.MCP_AUTHORIZATION_SERVER, "MCP_AUTHORIZATION_SERVER"),
        }
      : null,
    mode: "hosted",
    passAudience,
    publicKey: pem(env.ISSUER_PUBLIC_KEY!),
  };
}

function standalone(env: ConfigEnv): StandaloneConfig {
  require(env, "standalone", ["SIGNING_KEY", "WORKOS_CLIENT_ID", "WORKOS_API_KEY"]);
  forbid(env, "standalone", [
    "ISSUER_PUBLIC_KEY",
    "ISSUER",
    "PASS_AUDIENCE",
    "DELETION_AUDIENCE",
    "HOST_ORIGIN",
    "HOME_URL",
    "MCP_AUDIENCE",
    "MCP_AUTHORIZATION_SERVER",
  ]);
  return {
    displayName: present(env.DISPLAY_NAME) ? env.DISPLAY_NAME : "Tabletop",
    hosts: hostsOf(env),
    mode: "standalone",
    signingKey: pem(env.SIGNING_KEY!),
    workOs: {
      apiBase: present(env.WORKOS_API_BASE)
        ? origin(env.WORKOS_API_BASE, "WORKOS_API_BASE")
        : "https://api.workos.com",
      apiKey: env.WORKOS_API_KEY!,
      clientId: env.WORKOS_CLIENT_ID!,
    },
  };
}

export function readConfig(env: ConfigEnv): Config {
  if (env.TABLETOP_MODE === "hosted") return hosted(env);
  if (env.TABLETOP_MODE === "standalone") return standalone(env);
  throw new ConfigError('TABLETOP_MODE must be "hosted" or "standalone"');
}
