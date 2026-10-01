// SF Cinema collector. Runs on YOUR computer in a visible Chrome window, because sfcinema.com is behind a
// Cloudflare challenge that blocks servers (Supabase, GitHub, cloud machines all get HTTP 403).
//
//   npm run sf:discover   open the site, save every JSON response + page HTML to out/  (send this to Claude)
//   npm run sf:dry        collect and print what would be saved, without writing to Supabase
//   npm run sf            collect and save to Supabase through the scrape-cinemas "ingest" action
//
// Options: --movies=15 (how many movie pages to open), --headless (only after the first run passed the challenge)
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { callScraper } from "./env.mjs";
import { parseSf } from "./sf-parse.mjs";

const args = new Map(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const DISCOVER = args.has("discover"), DRY = args.has("dry-run");
const MAX_MOVIES = Number(args.get("movies")) || 15;
const HOME = "https://www.sfcinema.com/th";
const OUT = new URL("./out/", import.meta.url);

// a persistent profile keeps the Cloudflare clearance cookie between runs
const ctx = await chromium.launchPersistentContext(fileURLToPath(new URL("./.profile", import.meta.url)), {
  headless: args.has("headless"),
  locale: "th-TH",
  timezoneId: "Asia/Bangkok",
  viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

const responses = [];
page.on("response", async (res) => {
  const type = res.headers()["content-type"] ?? "";
  if (!type.includes("json") || res.request().method() === "OPTIONS") return;
  try { responses.push({ url: res.url(), pageUrl: page.url(), body: await res.json() }); } catch { /* body not available */ }
});

async function passChallenge() {
  for (let i = 0; i < 120; i++) {
    const title = await page.title().catch(() => "");
    if (title && !/just a moment|attention required|กรุณารอสักครู่/i.test(title)) return;
    if (i === 3) console.log("Cloudflare check is showing. If it asks, tick the box in the browser window (waiting up to 2 minutes)...");
    await page.waitForTimeout(1000);
  }
  throw new Error("Cloudflare challenge not passed within 2 minutes");
}

async function visit(url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await passChallenge();
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  // scroll so lazy lists (showtimes per cinema) load
  for (let y = 0; y < 6; y++) { await page.mouse.wheel(0, 1500); await page.waitForTimeout(400); }
}

const pages = [];
try {
  await visit(HOME);
  pages.push({ url: page.url(), html: await page.content() });

  const movieLinks = await page.$$eval("a[href]", (as) =>
    [...new Set(as.map((a) => a.href).filter((h) => /sfcinema\.com\/(th\/)?movies?\/[^/?#]+/i.test(h) && !/now-?showing|coming-?soon/i.test(h)))]);
  console.log(`found ${movieLinks.length} movie links on the home page`);

  for (const url of movieLinks.slice(0, MAX_MOVIES)) {
    console.log("  open", url);
    await visit(url);
    if (pages.length < 3) pages.push({ url: page.url(), html: await page.content() });
  }
} finally {
  await ctx.close();
}

console.log(`captured ${responses.length} JSON responses`);
if (DISCOVER) {
  const dir = new URL(`./sf-discovery-${new Date().toISOString().replace(/[:.]/g, "-")}/`, OUT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL("responses.json", dir), JSON.stringify(responses, null, 2));
  pages.forEach((p, i) => writeFileSync(new URL(`page-${i}.html`, dir), `<!-- ${p.url} -->\n${p.html}`));
  console.log("saved to", fileURLToPath(dir));
}

const { movies, showtimes } = parseSf(responses);
const theaters = new Set(showtimes.map((s) => s.theater));
console.log(`parsed ${movies.length} movies, ${theaters.size} theaters, ${showtimes.length} showtimes`);
for (const s of showtimes.slice(0, 5)) console.log("  e.g.", s.movie_title, "|", s.theater, "|", s.screen, "|", s.start_time);

if (DISCOVER || DRY) process.exit(0);
if (!movies.length && !showtimes.length) {
  console.error("Nothing recognised. Run `npm run sf:discover` and share the out/ folder so the parser can be fixed.");
  process.exit(1);
}
const r = await callScraper({ action: "ingest", brand: "sf", movies, showtimes });
console.log(`saved to Supabase: ${r.movies} movies, ${r.theaters} theaters, ${r.showtimes} showtimes`);
