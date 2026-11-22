import { createClient } from "npm:@supabase/supabase-js@2.119.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const USERNAME_PATTERN = /^[a-z0-9_-]{3,20}$/;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_SIGNUPS_PER_WINDOW = 5;

// Best-effort per-isolate throttle. Keep stronger project-level abuse protection enabled as well.
const signupAttempts = new Map<string, { startedAt: number; count: number }>();

function reply(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function requestIp(req: Request): string {
  return req.headers.get("cf-connecting-ip")?.trim()
    || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "";
}

function allowSignup(ip: string): boolean {
  if (!ip) return true;
  const now = Date.now();
  const record = signupAttempts.get(ip);
  if (!record || now - record.startedAt >= RATE_WINDOW_MS) {
    signupAttempts.set(ip, { startedAt: now, count: 1 });
    return true;
  }
  if (record.count >= MAX_SIGNUPS_PER_WINDOW) return false;
  record.count += 1;

  if (signupAttempts.size > 5000) {
    for (const [key, value] of signupAttempts) {
      if (now - value.startedAt >= RATE_WINDOW_MS) signupAttempts.delete(key);
    }
  }
  return true;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply({ error: "METHOD_NOT_ALLOWED" }, 405);

  if (!allowSignup(requestIp(req))) return reply({ error: "TOO_MANY_ATTEMPTS" }, 429);

  let payload: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return reply({ error: "INVALID_REQUEST" }, 400);
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return reply({ error: "INVALID_JSON" }, 400);
  }

  const username = typeof payload.username === "string" ? payload.username.trim().toLowerCase() : "";
  const password = typeof payload.password === "string" ? payload.password : "";

  if (!USERNAME_PATTERN.test(username)) {
    return reply({ error: "INVALID_USERNAME", message: "Use 3–20 letters, numbers, underscores or hyphens." }, 400);
  }
  if (password.length < 8 || password.length > 128) {
    return reply({ error: "INVALID_PASSWORD", message: "Password must be between 8 and 128 characters." }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Registration function is missing its server-side Supabase environment.");
    return reply({ error: "SERVER_CONFIGURATION_ERROR" }, 500);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const internalEmail = username + "@players.parliamentum.invalid";
  const { error } = await admin.auth.admin.createUser({
    email: internalEmail,
    password,
    email_confirm: true,
    user_metadata: {
      username,
      display_name: username,
    },
  });

  if (error) {
    const message = String(error.message || "").toLowerCase();
    if (/already|registered|exists|duplicate/.test(message)) {
      return reply({ error: "USERNAME_TAKEN" }, 409);
    }
    console.error("Player registration rejected:", error.message);
    return reply({ error: "REGISTRATION_FAILED" }, 400);
  }

  return reply({ ok: true }, 201);
});
