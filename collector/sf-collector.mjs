// SF Cinema collector. Runs on YOUR computer in a visible Chrome window, because sfcinema.com is behind a
// Cloudflare challenge that blocks servers (Supabase, GitHub, cloud machines all get HTTP 403).
//
//   npm run sf:discover   open the site, save every JSON response + page HTML to out/  (send this to Claude)
//   npm run sf:dry        collect and print what would be saved, without writing to Supabase
//   npm run sf            collect and save to Supabase through the scrape-cinemas "ingest" action
//
// Options: --movies=40 (how many movies), --days=3 (days ahead to keep, max 14), --browser=chrome|msedge|chromium,
//          --headless (only after a first visible run passed the challenge)
import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { callScraper } from "./env.mjs";
import { parseSf } from "./sf-parse.mjs";

const args = new Map(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const DISCOVER = args.has("discover"), DRY = args.has("dry-run");
const MAX_MOVIES = Number(args.get("movies")) || 40;
const HOME = "https://www.sfcinema.com/th";
const OUT = new URL("./out/", import.meta.url);

// A persistent profile keeps the Cloudflare clearance cookie between runs. Cloudflare can loop forever on
// Playwright's test Chromium, so prefer the Chrome installed on the computer and hide the automation flag.
// --browser=chromium forces the bundled browser, --browser=msedge uses Edge.
async function launch() {
  const options = {
    headless: args.has("headless"),
    locale: "th-TH",
    timezoneId: "Asia/Bangkok",
    viewport: { width: 1280, height: 900 },
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled"],
  };
  const wanted = args.get("browser");
  const channels = wanted === "chromium" ? [undefined] : wanted ? [wanted] : ["chrome", "msedge", undefined];
  for (const channel of channels) {
    try {
      const ctx = await chromium.launchPersistentContext(fileURLToPath(new URL(`./.profile${channel ? "-" + channel : ""}`, import.meta.url)), { ...options, channel });
      console.log(`browser: ${channel ?? "playwright chromium"}`);
      return ctx;
    } catch (e) {
      if (channel === channels.at(-1)) throw e;
    }
  }
}
const ctx = await launch();
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

// Cloudflare's check page has a localised title, so look for its markup instead of only the English title
const onChallenge = () => page.evaluate(() =>
  /just a moment|attention required|สักครู่|checking your browser/i.test(document.title) ||
  !!document.querySelector('#challenge-form, #challenge-stage, #cf-challenge-running, .cf-turnstile-wrapper'),
).catch(() => true);

async function passChallenge() {
  for (let i = 0; i < 180; i++) {
    if (!(await onChallenge())) return true;
    if (i === 3) console.log("Cloudflare check is showing. If it asks, tick the box in the browser window (waiting up to 3 minutes)...");
    await page.waitForTimeout(1000);
  }
  console.log(`Cloudflare check still showing after 3 minutes (page title: "${await page.title().catch(() => "")}")`);
  return false;
}

// the movie list request is the sign that the real site (not the Cloudflare page) has loaded
const CONTENT_RE = /onl\.sfcinema\.com\/ticket\/data\/content\?/;
async function waitForMovieList(ms) {
  for (let t = 0; t < ms; t += 1000) {
    if (responses.some((r) => CONTENT_RE.test(r.url))) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

async function visit(url, { waitChallenge = true } = {}) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  if (waitChallenge) await passChallenge();
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  // scroll so lazy lists (showtimes per cinema) load
  for (let y = 0; y < 6; y++) { await page.mouse.wheel(0, 1500); await page.waitForTimeout(400); }
}

// Showtimes live on /th/showtime/{movie id} (found by hand: "ซื้อบัตรชมภาพยนตร์" leads there). That page loads
// ticket/data/session?contentId={id}, which lists every showtime of the movie for about two weeks, plus
// ticket/data/branch with the names of all branches, so one page visit per movie is enough.
const SHOWTIME_URL = "https://www.sfcinema.com/th/showtime/{id}";
const DAYS = Math.min(Math.max(Number(args.get("days")) || 3, 1), 14);
const pages = [], visited = [];

async function collectMovie(movie) {
  const url = SHOWTIME_URL.replace("{id}", movie.id);
  const has = () => responses.some((r) => r.url.includes("/ticket/data/session?") && r.url.includes(`contentId=${movie.id}`));
  await visit(url);
  visited.push(url);
  if (DISCOVER && pages.length < 3) pages.push({ url: page.url(), html: await page.content() });
  for (let t = 0; t < 30 && !has(); t++) await page.waitForTimeout(1000);
  return has();
}

try {
  // on the home page the movie list request is the only reliable sign that we are past Cloudflare
  await visit(HOME, { waitChallenge: false });
  console.log("waiting for the SF movie list (tick the Cloudflare box in the browser if one shows, up to 3 minutes)...");
  if (!(await waitForMovieList(90_000))) {
    console.log(`movie list not loaded yet (page title: "${await page.title().catch(() => "")}"), reloading...`);
    await visit(HOME, { waitChallenge: false });
    await waitForMovieList(90_000);
  }
  pages.push({ url: page.url(), html: await page.content().catch(() => "") });

  const list = responses.find((r) => CONTENT_RE.test(r.url))?.body?.data ?? [];
  const nowShowing = list.filter((m) => m.type === "now_showing");
  console.log(`SF lists ${nowShowing.length} now-showing movies (${list.length} incl. coming soon)`);

  const todo = nowShowing.slice(0, DISCOVER ? 2 : MAX_MOVIES);
  for (const [i, m] of todo.entries()) {
    const ok = await collectMovie(m);
    console.log(`  [${i + 1}/${todo.length}] ${m.title}: ${ok ? "showtimes loaded" : "no showtimes response"}`);
  }
} catch (e) {
  console.error("stopped early:", e.message);
  if (!pages.length) pages.push({ url: page.url(), html: await page.content().catch(() => "") });
} finally {
  await page.screenshot({ path: fileURLToPath(new URL("./last-page.png", OUT)) }).catch(() => {});
  await ctx.close();
}

console.log(`captured ${responses.length} JSON responses`);
if (DISCOVER) {
  const dir = new URL(`./sf-discovery-${new Date().toISOString().replace(/[:.]/g, "-")}/`, OUT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL("responses.json", dir), JSON.stringify(responses, null, 2));
  writeFileSync(new URL("visited.txt", dir), visited.join("\n"));
  pages.forEach((p, i) => writeFileSync(new URL(`page-${i}.html`, dir), `<!-- ${p.url} -->\n${p.html}`));
  try { writeFileSync(new URL("last-page.png", dir), readFileSync(new URL("last-page.png", OUT))); } catch { /* not taken */ }
  console.log("saved to", fileURLToPath(dir));
}

const { movies, theaters, showtimes } = parseSf(responses, { movieUrl: SHOWTIME_URL, days: DAYS });
console.log(`parsed ${movies.length} movies, ${theaters.length} theaters, ${showtimes.length} showtimes (next ${DAYS} day(s))`);
for (const s of showtimes.slice(0, 3)) console.log("  e.g.", s.movie_title, "|", s.theater, "|", s.screen, "|", s.start_time, "|", s.language);

if (DISCOVER || DRY) process.exit(0);
if (!movies.length && !showtimes.length) {
  console.error("Nothing recognised. Run `npm run sf:discover` and share the out/ folder so the parser can be fixed.");
  process.exit(1);
}
// send in chunks so one request stays small; movies and theaters go with the first chunk
const CHUNK = 4000;
let saved = 0;
for (let i = 0; i === 0 || i < showtimes.length; i += CHUNK) {
  const part = showtimes.slice(i, i + CHUNK);
  const r = await callScraper({ action: "ingest", brand: "sf", ...(i === 0 ? { movies, theaters } : {}), showtimes: part });
  saved += r.showtimes;
  if (i === 0) console.log(`saved to Supabase: ${r.movies} movies, ${r.theaters} theaters`);
}
console.log(`saved to Supabase: ${saved} showtimes`);
