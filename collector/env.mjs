// Tiny .env loader (avoids a dotenv dependency) + the shared ingest call.
import { readFileSync, existsSync } from "node:fs";

const file = new URL("./.env", import.meta.url);
if (existsSync(file)) {
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

export const SUPABASE_URL = process.env.SUPABASE_URL || "https://jjuvwfbzmpkwzjknhdwu.supabase.co";
export const INGEST_TOKEN = process.env.INGEST_TOKEN || "";

export async function callScraper(body) {
  if (!INGEST_TOKEN) throw new Error("INGEST_TOKEN missing: copy collector/.env.example to collector/.env and fill it in");
  const res = await fetch(`${SUPABASE_URL}/functions/v1/scrape-cinemas`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ingest-token": INGEST_TOKEN },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`scrape-cinemas ${res.status}: ${out.error ?? "unknown error"}`);
  return out;
}
