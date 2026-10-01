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
  // promotions / news are large and never hold showtimes
  if (/\/campaign\/cms\/(promotion|newsandactivities|homebanner)/.test(res.url())) return;
  const req = res.request();
  try {
    responses.push({ url: res.url(), method: req.method(), postData: req.postData() ?? null, pageUrl: page.url(), body: await res.json() });
  } catch { /* body not available */ }
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

// The site is a Next.js app without <a href> links to movies, so we click a poster once to learn the
// movie page URL, then open the other movies by swapping the movie id in that URL.
const CANDIDATES = (id) => [`/th/movie/${id}`, `/th/movies/${id}`, `/th/movie-detail/${id}`, `/th/showtime/${id}`];
const pages = [], visited = [];
let template = null;

async function clickPoster(movie) {
  const files = [movie.media?.portrait, movie.media?.landscape].filter(Boolean).map((u) => u.split("/").pop());
  for (const f of files) {
    for (const needle of [f, encodeURIComponent(f)]) {
      const img = page.locator(`img[src*="${needle}"], img[srcset*="${needle}"]`).first();
      if (!(await img.count())) continue;
      const before = page.url();
      await img.scrollIntoViewIfNeeded().catch(() => {});
      await img.click({ timeout: 5000 }).catch(() => {});
      await page.waitForURL((u) => u.href !== before, { timeout: 10_000 }).catch(() => {});
      if (page.url() !== before) return page.url();
    }
  }
  return null;
}

async function movieUrlTemplate(movie) {
  const clicked = await clickPoster(movie);
  if (clicked?.includes(movie.id)) return clicked.replace(movie.id, "{id}");
  if (clicked) console.log("  poster opened", clicked, "(movie id not in URL)");
  for (const path of CANDIDATES(movie.id)) {
    const res = await page.goto(new URL(path, HOME).href, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => null);
    await passChallenge();
    if (res && res.status() < 400 && !/404|not found|ไม่พบหน้า/i.test(await page.title())) return page.url().replace(movie.id, "{id}");
  }
  return null;
}

try {
  await visit(HOME);
  pages.push({ url: page.url(), html: await page.content() });

  const list = responses.find((r) => /\/ticket\/data\/content\?/.test(r.url))?.body?.data ?? [];
  const nowShowing = list.filter((m) => m.type === "now_showing");
  console.log(`SF lists ${nowShowing.length} now-showing movies (${list.length} incl. coming soon)`);

  template = nowShowing.length ? await movieUrlTemplate(nowShowing[0]) : null;
  console.log(template ? `movie page URL: ${template}` : "could not find the movie page URL");

  if (template) {
    for (const m of nowShowing.slice(0, MAX_MOVIES)) {
      const url = template.replace("{id}", m.id);
      console.log("  open", m.title);
      await visit(url);
      visited.push(url);
      if (pages.length < 3) pages.push({ url: page.url(), html: await page.content() });
    }
  }
} finally {
  await ctx.close();
}

console.log(`captured ${responses.length} JSON responses`);
if (DISCOVER) {
  const dir = new URL(`./sf-discovery-${new Date().toISOString().replace(/[:.]/g, "-")}/`, OUT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL("responses.json", dir), JSON.stringify(responses, null, 2));
  writeFileSync(new URL("visited.txt", dir), [`template: ${template}`, ...visited].join("\n"));
  pages.forEach((p, i) => writeFileSync(new URL(`page-${i}.html`, dir), `<!-- ${p.url} -->\n${p.html}`));
  console.log("saved to", fileURLToPath(dir));
}

const { movies, showtimes } = parseSf(responses, { movieUrl: template });
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
