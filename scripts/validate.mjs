import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = await readFile(resolve(root, "index.html"), "utf8");
const errors = [];
const warnings = [];

if (!/<title\b[^>]*>\s*Parliamentum:\s*Seats of Power\s*<\/title>/i.test(html)) {
  errors.push("Expected Parliamentum page title was not found.");
}

const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
const inlineScripts = scriptTags.filter(([, attributes, body]) =>
  !/\bsrc\s*=/.test(attributes) && body.trim().length > 0
);

if (inlineScripts.length === 0) {
  errors.push("No inline application scripts were found.");
}

for (const [index, match] of inlineScripts.entries()) {
  try {
    // Parse only: browser globals and application code are not executed in CI.
    new Function(match[2]);
  } catch (error) {
    errors.push(`Inline script ${index + 1} has a syntax error: ${error.message}`);
  }
}

const appSource = inlineScripts.map(([, , body]) => body).join("\n");
const requiredTables = [
  "saves", "profiles", "room_players", "rooms", "presence",
  "player_wallets", "bills", "votes", "player_deals",
  "shared_state", "player_mutes", "messages"
];
const requiredRpcs = [
  "create_room", "join_room", "resolve_room_vote", "set_presence",
  "send_room_message", "send_gift", "propose_player_deal",
  "respond_player_deal", "propose_room_bill", "cast_room_vote",
  "publish_room_state", "set_world_clock"
];

for (const table of requiredTables) {
  const pattern = new RegExp(String.raw`\.from\s*\(\s*(['"])${table}\1\s*\)`);
  if (!pattern.test(appSource)) errors.push(`Missing expected Supabase table reference: ${table}`);
}

for (const rpc of requiredRpcs) {
  const pattern = new RegExp(String.raw`\\.rpc\\s*\\(\\s*(['"])${rpc}\\1\\s*(?:,|\\))`);
  if (!pattern.test(appSource)) errors.push(`Missing expected Supabase RPC reference: ${rpc}`);
}

if (!html.includes("wbyjqdwmmtznlobsfhck.supabase.co")) {
  errors.push("The configured Parliamentum Supabase project URL is missing or has changed.");
}

// A browser bundle must never contain a Supabase service-role or secret API key.
if (/service[_-]?role|sb_secret_/i.test(html)) {
  errors.push("A privileged Supabase key pattern was found in index.html.");
}

const ids = [...html.matchAll(/\bid\s*=\s*(["'])(.*?)\1/g)].map((match) => match[2]);
const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
if (duplicateIds.length) {
  warnings.push(`Duplicate HTML id attributes found: ${duplicateIds.join(", ")}`);
}

console.log(`Parsed ${inlineScripts.length} inline JavaScript block(s).`);
console.log(`Checked ${requiredTables.length} Supabase table references and ${requiredRpcs.length} RPC references.`);
if (warnings.length) for (const warning of warnings) console.warn(`WARNING: ${warning}`);

if (errors.length) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  process.exitCode = 1;
} else {
  console.log("Parliamentum static validation passed.");
}
