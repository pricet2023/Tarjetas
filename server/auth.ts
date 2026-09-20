/**
 * Who is allowed to spend the box's CPU.
 *
 * The scorer is reachable from the internet (through the tunnel) and does a
 * second and a half of work per request, which makes an unauthenticated one a
 * free denial-of-service and, once someone notices, free inference. So it
 * takes the same posture as the `translate` edge function's `verify_jwt`: a
 * Supabase access token, verified locally, or a 401.
 *
 * Verified locally rather than by calling `/auth/v1/user`, because that would
 * put a Supabase round trip in front of every attempt and make the scorer stop
 * working whenever Supabase does — for a check whose whole content is a
 * signature we can compute ourselves.
 *
 * Two signing schemes, because Supabase has both. Older projects sign HS256
 * with the project's shared JWT secret; newer ones use asymmetric keys
 * published at `/auth/v1/.well-known/jwks.json`. Which one you have decides
 * whether you set `SUPABASE_JWT_SECRET` or just `SUPABASE_URL`.
 */

export interface AuthConfig {
  /** Project URL. Used for JWKS discovery and to pin the issuer. */
  supabaseUrl?: string;
  /** Legacy shared secret, for projects still signing HS256. */
  jwtSecret?: string;
  /**
   * Turn verification off. Dev only, and never the default — it has to be
   * asked for by name, because the failure mode of getting this wrong in
   * production is silent and expensive.
   */
  allowAnonymous?: boolean;
  fetchImpl?: typeof fetch;
}

export class Unauthorized extends Error {}

export type Verifier = (authorization: string | undefined) => Promise<string>;

interface Claims {
  sub?: string;
  exp?: number;
  nbf?: number;
  iss?: string;
  aud?: string | string[];
}

const HS = "HS256";
const ASYMMETRIC: Record<string, { name: string; hash: string; namedCurve?: string }> = {
  ES256: { name: "ECDSA", hash: "SHA-256", namedCurve: "P-256" },
  RS256: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
};

/** Sixty seconds of tolerance, for the usual reason: clocks. */
const SKEW_SECONDS = 60;

export function createVerifier(config: AuthConfig): Verifier {
  if (config.allowAnonymous) {
    console.warn("[scorer] SCORER_ALLOW_ANONYMOUS is set — every request is accepted.");
    return async () => "anonymous";
  }
  if (!config.jwtSecret && !config.supabaseUrl) {
    throw new Error(
      "The scorer needs SUPABASE_JWT_SECRET (HS256 projects) or SUPABASE_URL (asymmetric keys) " +
        "to verify tokens. Set SCORER_ALLOW_ANONYMOUS=1 only for local development.",
    );
  }

  const keys = new JwkCache(config.supabaseUrl, config.fetchImpl);
  const secret = config.jwtSecret ? hmacKey(config.jwtSecret) : null;

  return async (authorization) => {
    const token = bearer(authorization);
    const { header, claims, signed, signature } = decode(token);
    const alg = header.alg ?? "";

    if (alg === HS) {
      if (!secret) throw new Unauthorized("This token is HS256 but no JWT secret is configured.");
      const ok = await crypto.subtle.verify("HMAC", await secret, signature, signed);
      if (!ok) throw new Unauthorized("Bad token signature.");
    } else if (alg in ASYMMETRIC) {
      const spec = ASYMMETRIC[alg];
      const key = await keys.get(header.kid, alg);
      const algorithm =
        spec.name === "ECDSA" ? { name: "ECDSA", hash: spec.hash } : { name: spec.name };
      const ok = await crypto.subtle.verify(algorithm, key, signature, signed);
      if (!ok) throw new Unauthorized("Bad token signature.");
    } else {
      // Explicitly including `none`, which is the classic way to be let in.
      throw new Unauthorized(`Unsupported token algorithm "${alg}".`);
    }

    const now = Math.floor(Date.now() / 1000);
    if (claims.exp !== undefined && claims.exp + SKEW_SECONDS < now) {
      throw new Unauthorized("That session has expired.");
    }
    if (claims.nbf !== undefined && claims.nbf - SKEW_SECONDS > now) {
      throw new Unauthorized("That token isn't valid yet.");
    }
    if (config.supabaseUrl && claims.iss && !claims.iss.startsWith(config.supabaseUrl)) {
      throw new Unauthorized("That token was issued by someone else.");
    }
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audience.includes("authenticated")) {
      throw new Unauthorized("That token isn't for a signed-in user.");
    }
    if (!claims.sub) throw new Unauthorized("That token names no user.");
    return claims.sub;
  };
}

function bearer(authorization: string | undefined): string {
  const match = /^Bearer (.+)$/i.exec(authorization?.trim() ?? "");
  if (!match) throw new Unauthorized("Sign in to score pronunciation.");
  return match[1];
}

function decode(token: string): {
  header: { alg?: string; kid?: string };
  claims: Claims;
  signed: ArrayBuffer;
  signature: ArrayBuffer;
} {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Unauthorized("That isn't a token.");
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")),
      claims: JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
      signed: bytes(new TextEncoder().encode(`${parts[0]}.${parts[1]}`)),
      signature: bytes(Buffer.from(parts[2], "base64url")),
    };
  } catch {
    throw new Unauthorized("That token is malformed.");
  }
}

/**
 * A view copied into an `ArrayBuffer` of its own.
 *
 * `Buffer`s are views into a shared pool and `TextEncoder` output is typed as
 * backed by `ArrayBufferLike`, neither of which `crypto.subtle` accepts. A JWT
 * is a few hundred bytes, so the copy costs nothing and removes the cast.
 */
function bytes(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

const hmacKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    bytes(new TextEncoder().encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

/**
 * The project's public signing keys, fetched once and kept.
 *
 * Refetched when a token arrives with a `kid` we have never seen, which is how
 * a key rotation heals itself — but rate-limited, so a stream of junk tokens
 * with random `kid`s cannot turn into a stream of outbound requests.
 */
class JwkCache {
  private keys = new Map<string, Promise<CryptoKey>>();
  private fetchedAt = 0;
  private inFlight: Promise<void> | null = null;

  // Plain fields and an explicit body, not parameter properties: Node runs
  // this file by stripping types, and a parameter property is not a type — it
  // emits an assignment, so strip-only mode rejects it outright.
  private readonly supabaseUrl: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(supabaseUrl: string | undefined, fetchImpl?: typeof fetch) {
    this.supabaseUrl = supabaseUrl;
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async get(kid: string | undefined, alg: string): Promise<CryptoKey> {
    if (!this.supabaseUrl) {
      throw new Unauthorized("This token needs SUPABASE_URL configured to verify it.");
    }
    const id = kid ?? alg;
    const known = this.keys.get(id);
    if (known) return known;

    await this.refresh();
    const found = this.keys.get(id);
    if (!found) throw new Unauthorized("That token was signed with an unknown key.");
    return found;
  }

  private async refresh(): Promise<void> {
    if (Date.now() - this.fetchedAt < 60_000) {
      throw new Unauthorized("That token was signed with an unknown key.");
    }
    this.inFlight ??= (async () => {
      const url = `${this.supabaseUrl!.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`;
      const response = await this.fetchImpl(url);
      if (!response.ok) throw new Error(`JWKS fetch failed (${response.status}).`);
      const { keys } = (await response.json()) as { keys: JsonWebKey[] & { kid?: string }[] };
      const next = new Map<string, Promise<CryptoKey>>();
      for (const jwk of keys) {
        const spec = ASYMMETRIC[jwk.alg ?? ""];
        if (!spec) continue;
        next.set(
          (jwk as { kid?: string }).kid ?? jwk.alg!,
          crypto.subtle.importKey(
            "jwk",
            jwk,
            spec.namedCurve
              ? { name: spec.name, namedCurve: spec.namedCurve }
              : { name: spec.name, hash: spec.hash },
            false,
            ["verify"],
          ),
        );
      }
      this.keys = next;
      this.fetchedAt = Date.now();
    })().finally(() => {
      this.inFlight = null;
    });
    await this.inFlight;
  }
}
