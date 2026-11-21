// ---------------------------------------------------------------------------
//  OAuth 2.1 authorization server + resource server for localmcpcoder.
//
//  Implements the subset of the MCP authorization spec that ChatGPT and Claude
//  use to connect to a custom connector, so neither the passphrase nor the
//  access token ever travels in a URL (which is what ends up in proxy logs):
//
//    RFC 9728  Protected Resource Metadata   /.well-known/oauth-protected-resource
//    RFC 8414  Authorization Server Metadata /.well-known/oauth-authorization-server
//    RFC 7591  Dynamic Client Registration   POST /oauth/register
//    OAuth 2.1 + PKCE (S256, mandatory)      GET/POST /oauth/authorize, POST /oauth/token
//    RFC 8707  Resource Indicators           access tokens are audience-bound
//    RFC 9207  Issuer identification         `iss` in the authorization response
//
//  The client registers itself, so there is no client id or secret to copy by
//  hand. The only human step is typing the passphrase on the consent page.
//
//  State lives in memory: restarting the server invalidates every token.
// ---------------------------------------------------------------------------
import crypto from "node:crypto";

const ACCESS_TTL_MS = 60 * 60 * 1000; // 1 hour
const CODE_TTL_MS = 60 * 1000; // 1 minute
const SCOPE = "mcp";

// Slow down guessing on the consent page. The passphrase has 192 bits of
// entropy, so this is belt and braces, but it also caps log noise.
const MAX_FAILURES = 5;
const LOCKOUT_MS = 60 * 1000;

const rand = (n = 32) => crypto.randomBytes(n).toString("hex");

/** Compares two secrets without leaking their contents through timing. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function s256(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

/**
 * The public origin this request arrived on. The quick tunnel hands out a new
 * hostname on every run, so every URL we advertise is derived from the request
 * instead of being configured.
 */
function origin(req) {
  const proto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
  const host = req.get("x-forwarded-host") || req.get("host");
  return `${proto}://${host}`;
}

const htmlEscape = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

function consentPage({ origin: org, clientName, params, error }) {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${htmlEscape(k)}" value="${htmlEscape(v)}">`)
    .join("\n      ");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize localmcpcoder</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; display: grid;
         place-items: center; min-height: 100vh; background: Canvas; color: CanvasText; }
  main { width: min(28rem, 92vw); padding: 2rem; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
         border-radius: 12px; }
  h1 { font-size: 1.15rem; margin: 0 0 .25rem; }
  p { margin: .5rem 0; }
  .muted { opacity: .7; font-size: .875rem; }
  .warn { border-left: 3px solid #d97706; padding-left: .75rem; }
  .err { color: #dc2626; font-weight: 600; }
  input[type=password] { width: 100%; padding: .6rem; margin: .75rem 0;
         border: 1px solid color-mix(in srgb, CanvasText 30%, transparent);
         border-radius: 8px; background: Canvas; color: CanvasText; font: inherit; }
  button { width: 100%; padding: .65rem; border: 0; border-radius: 8px;
           background: #2563eb; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
</style></head><body><main>
  <h1>Authorize access to this machine</h1>
  <p class="muted"><strong>${htmlEscape(clientName)}</strong> is asking to connect to
     <strong>${htmlEscape(org)}</strong>.</p>
  <p class="warn">Approving grants it shell access, and the ability to read, write and
     delete files, as your user.</p>
  ${error ? `<p class="err">${htmlEscape(error)}</p>` : ""}
  <form method="POST" action="/oauth/authorize">
      ${hidden}
    <label for="pw" class="muted">Passphrase (printed by start.sh when the server booted)</label>
    <input id="pw" name="passphrase" type="password" autocomplete="off" autofocus required>
    <button type="submit">Approve</button>
  </form>
</main></body></html>`;
}

/**
 * Mounts the OAuth endpoints and returns an Express middleware that rejects
 * requests without a valid, audience-bound access token.
 */
export function installOAuth(app, { passphrase }) {
  const clients = new Map(); // client_id  -> metadata
  const codes = new Map(); // code       -> grant
  const access = new Map(); // token      -> grant
  const refresh = new Map(); // token      -> grant
  let failures = 0;
  let lockedUntil = 0;

  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of codes) if (v.expiresAt < now) codes.delete(k);
    for (const [k, v] of access) if (v.expiresAt < now) access.delete(k);
  };
  setInterval(sweep, 60_000).unref();

  // --- discovery ------------------------------------------------------------
  const protectedResource = (req, res) => {
    const org = origin(req);
    res.json({
      resource: `${org}/mcp`,
      authorization_servers: [org],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ["header"],
    });
  };
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

  const asMetadata = (req, res) => {
    const org = origin(req);
    res.json({
      issuer: org,
      authorization_endpoint: `${org}/oauth/authorize`,
      token_endpoint: `${org}/oauth/token`,
      registration_endpoint: `${org}/oauth/register`,
      scopes_supported: [SCOPE],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
    });
  };
  app.get("/.well-known/oauth-authorization-server", asMetadata);
  app.get("/.well-known/oauth-authorization-server/mcp", asMetadata);
  app.get("/.well-known/openid-configuration", asMetadata);

  // --- dynamic client registration (RFC 7591) -------------------------------
  app.post("/oauth/register", (req, res) => {
    const body = req.body ?? {};
    const redirect_uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (!redirect_uris.length) {
      return res.status(400).json({
        error: "invalid_redirect_uri",
        error_description: "redirect_uris is required",
      });
    }
    const client_id = rand(16);
    const client = {
      client_id,
      client_name: body.client_name || "Unnamed MCP client",
      redirect_uris,
      token_endpoint_auth_method: "none", // public client, PKCE is the protection
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: SCOPE,
    };
    clients.set(client_id, client);
    console.log(`[oauth] registered client "${client.client_name}" (${client_id})`);
    res.status(201).json({ ...client, client_id_issued_at: Math.floor(Date.now() / 1000) });
  });

  // --- authorization endpoint -----------------------------------------------
  /** Validates the query shared by GET and POST. Returns [error, ctx]. */
  function readAuthzRequest(q) {
    const client = clients.get(q.client_id);
    if (!client) return ["unknown client_id — register first", null];
    if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri))
      return ["redirect_uri does not match the one registered", null];
    // From here on the redirect_uri is trusted, so errors can go back to the client.
    if (q.response_type !== "code") return [null, { client, oauthError: "unsupported_response_type" }];
    if (q.code_challenge_method !== "S256" || !q.code_challenge)
      return [null, { client, oauthError: "invalid_request" }];
    return [null, { client }];
  }

  function redirectError(res, req, q, error) {
    const u = new URL(q.redirect_uri);
    u.searchParams.set("error", error);
    if (q.state) u.searchParams.set("state", q.state);
    u.searchParams.set("iss", origin(req));
    res.redirect(302, u.toString());
  }

  app.get("/oauth/authorize", (req, res) => {
    const q = req.query;
    const [fatal, ctx] = readAuthzRequest(q);
    // A bad client_id or redirect_uri cannot be reported by redirecting — that
    // is the open-redirect hole — so it is shown here instead.
    if (fatal) return res.status(400).type("text/plain").send(`Authorization error: ${fatal}`);
    if (ctx.oauthError) return redirectError(res, req, q, ctx.oauthError);

    res.type("html").send(
      consentPage({
        origin: origin(req),
        clientName: ctx.client.client_name,
        params: {
          client_id: q.client_id,
          redirect_uri: q.redirect_uri,
          response_type: q.response_type,
          code_challenge: q.code_challenge,
          code_challenge_method: q.code_challenge_method,
          state: q.state ?? "",
          scope: q.scope ?? SCOPE,
          resource: q.resource ?? "",
        },
      })
    );
  });

  app.post("/oauth/authorize", (req, res) => {
    const q = req.body ?? {};
    const [fatal, ctx] = readAuthzRequest(q);
    if (fatal) return res.status(400).type("text/plain").send(`Authorization error: ${fatal}`);
    if (ctx.oauthError) return redirectError(res, req, q, ctx.oauthError);

    const now = Date.now();
    if (now < lockedUntil) {
      return res.status(429).type("html").send(
        consentPage({
          origin: origin(req),
          clientName: ctx.client.client_name,
          params: q,
          error: `Too many failed attempts. Try again in ${Math.ceil((lockedUntil - now) / 1000)}s.`,
        })
      );
    }
    if (!safeEqual(q.passphrase ?? "", passphrase)) {
      failures += 1;
      if (failures >= MAX_FAILURES) {
        lockedUntil = now + LOCKOUT_MS;
        failures = 0;
        console.log("[oauth] too many failed passphrase attempts — locked for 60s");
      }
      return res.status(401).type("html").send(
        consentPage({
          origin: origin(req),
          clientName: ctx.client.client_name,
          params: q,
          error: "Wrong passphrase.",
        })
      );
    }
    failures = 0;

    const code = rand(24);
    codes.set(code, {
      client_id: q.client_id,
      redirect_uri: q.redirect_uri,
      code_challenge: q.code_challenge,
      resource: q.resource || `${origin(req)}/mcp`,
      scope: q.scope || SCOPE,
      expiresAt: now + CODE_TTL_MS,
    });
    console.log(`[oauth] approved "${ctx.client.client_name}"`);

    const u = new URL(q.redirect_uri);
    u.searchParams.set("code", code);
    if (q.state) u.searchParams.set("state", q.state);
    u.searchParams.set("iss", origin(req)); // RFC 9207
    res.redirect(302, u.toString());
  });

  // --- token endpoint --------------------------------------------------------
  app.post("/oauth/token", (req, res) => {
    const b = req.body ?? {};
    const issue = (grant) => {
      const at = rand();
      const rt = rand();
      access.set(at, { ...grant, expiresAt: Date.now() + ACCESS_TTL_MS });
      refresh.set(rt, grant);
      res.json({
        access_token: at,
        token_type: "Bearer",
        expires_in: ACCESS_TTL_MS / 1000,
        refresh_token: rt,
        scope: grant.scope,
      });
    };

    if (b.grant_type === "authorization_code") {
      const grant = codes.get(b.code);
      codes.delete(b.code); // single use, even on failure
      if (!grant || grant.expiresAt < Date.now())
        return res.status(400).json({ error: "invalid_grant" });
      if (grant.client_id !== b.client_id || grant.redirect_uri !== b.redirect_uri)
        return res.status(400).json({ error: "invalid_grant" });
      if (!b.code_verifier || s256(b.code_verifier) !== grant.code_challenge)
        return res.status(400).json({ error: "invalid_grant", error_description: "PKCE check failed" });
      return issue({
        client_id: grant.client_id,
        aud: b.resource || grant.resource,
        scope: grant.scope,
      });
    }

    if (b.grant_type === "refresh_token") {
      const grant = refresh.get(b.refresh_token);
      if (!grant) return res.status(400).json({ error: "invalid_grant" });
      refresh.delete(b.refresh_token); // rotate
      return issue({ ...grant, aud: b.resource || grant.aud });
    }

    res.status(400).json({ error: "unsupported_grant_type" });
  });

  // --- resource server -------------------------------------------------------
  function challenge(req, res, { status = 401, error, description } = {}) {
    const parts = [`Bearer resource_metadata="${origin(req)}/.well-known/oauth-protected-resource"`];
    if (error) parts.push(`error="${error}"`);
    parts.push(`scope="${SCOPE}"`);
    if (description) parts.push(`error_description="${description}"`);
    res.set("WWW-Authenticate", parts.join(", "));
    res.status(status).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: description || "Unauthorized" },
      id: null,
    });
  }

  /** Express middleware: requires a live access token issued for this server. */
  function requireAuth(req, res, next) {
    const header = req.get("authorization") || "";
    if (!header.startsWith("Bearer ")) return challenge(req, res);
    const presented = header.slice(7).trim();

    // Escape hatch for CLI clients: the passphrase itself works as a bearer
    // token. It goes in a header, never a URL, so it is not log-visible.
    if (safeEqual(presented, passphrase)) return next();

    const grant = access.get(presented);
    if (!grant) return challenge(req, res, { error: "invalid_token" });
    if (grant.expiresAt < Date.now()) {
      access.delete(presented);
      return challenge(req, res, { error: "invalid_token", description: "Token expired" });
    }
    // Audience binding (RFC 8707): a token minted for another resource is not
    // usable here, even if that resource shares this authorization server.
    const expected = `${origin(req)}/mcp`;
    if (grant.aud && grant.aud !== expected && grant.aud !== origin(req)) {
      return challenge(req, res, { error: "invalid_token", description: "Token audience mismatch" });
    }
    next();
  }

  return { requireAuth };
}
