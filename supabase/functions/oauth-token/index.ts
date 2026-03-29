import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Hono } from "hono";
import { SignJWT } from "jose";

const OAUTH_CLIENT_ID     = Deno.env.get("OAUTH_CLIENT_ID")!.trim();
const OAUTH_CLIENT_SECRET = Deno.env.get("OAUTH_CLIENT_SECRET")!.trim();
const JWT_SECRET          = Deno.env.get("JWT_SECRET")!.trim();

const secretBytes = new TextEncoder().encode(JWT_SECRET);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const app = new Hono();

app.options("*", (c) => c.text("ok", 200, corsHeaders));

// Catch-all: route internally by method + path (matches open-brain-mcp pattern)
app.all("*", async (c) => {
  const url = new URL(c.req.url);
  const path = url.pathname;
  const method = c.req.method;

  // OAuth Authorization Server Metadata (RFC 8414)
  if (method === "GET" && path.endsWith("/.well-known/oauth-authorization-server")) {
    const base = `${url.origin}/functions/v1/oauth-token`;
    return c.json(
      {
        issuer: base,
        token_endpoint: `${base}/token`,
        grant_types_supported: ["client_credentials"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      },
      200,
      corsHeaders
    );
  }

  // Token endpoint — Client Credentials grant (RFC 6749 §4.4)
  if (method === "POST" && (path.endsWith("/token") || path === "/functions/v1/oauth-token")) {
    let client_id: string | undefined;
    let client_secret: string | undefined;
    let grant_type: string | undefined;

    const contentType = c.req.header("content-type") ?? "";

    if (contentType.includes("application/x-www-form-urlencoded")) {
      const body = await c.req.formData();
      grant_type    = body.get("grant_type")?.toString();
      client_id     = body.get("client_id")?.toString();
      client_secret = body.get("client_secret")?.toString();
    } else {
      try {
        const body = await c.req.json();
        grant_type    = body.grant_type;
        client_id     = body.client_id;
        client_secret = body.client_secret;
      } catch {
        return c.json(
          { error: "invalid_request", error_description: "Unreadable body" },
          400,
          corsHeaders
        );
      }
    }

    if (grant_type !== "client_credentials") {
      return c.json({ error: "unsupported_grant_type" }, 400, corsHeaders);
    }
    if (!client_id || !client_secret) {
      return c.json(
        { error: "invalid_request", error_description: "client_id and client_secret required" },
        400,
        corsHeaders
      );
    }

    if (!timingSafeEqual(client_id, OAUTH_CLIENT_ID) || !timingSafeEqual(client_secret, OAUTH_CLIENT_SECRET)) {
      return c.json({ error: "invalid_client" }, 401, corsHeaders);
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresIn = 3600;

    const access_token = await new SignJWT({ sub: client_id })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + expiresIn)
      .sign(secretBytes);

    return c.json(
      { access_token, token_type: "Bearer", expires_in: expiresIn },
      200,
      { ...corsHeaders, "Cache-Control": "no-store", Pragma: "no-cache" }
    );
  }

  return c.json({ error: "not_found" }, 404, corsHeaders);
});

function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) {
    let dummy = 0;
    for (let i = 0; i < bBytes.length; i++) dummy |= bBytes[i];
    void dummy;
    return false;
  }
  let result = 0;
  for (let i = 0; i < aBytes.length; i++) result |= aBytes[i] ^ bBytes[i];
  return result === 0;
}

Deno.serve(app.fetch);
