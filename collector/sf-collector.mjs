// SF Cinema collector. Runs on YOUR computer in a visible Chrome window, because sfcinema.com is behind a
// Cloudflare challenge that blocks servers (Supabase, GitHub, cloud machines all get HTTP 403).
//
//   npm run sf:discover   open the site, save every JSON response + page HTML to out/  (send this to Claude)
//   npm run sf:dry        collect and print what would be saved, without writing to Supabase
//   npm run sf            collect and save to Supabase through the scrape-cinemas "ingest" action
//
// Options: --movies=40 (how many movies), --days=3 (days per movie, max 7), --browser=chrome|msedge|chromium,
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

// Showtimes live on /th/showtime/{movie id} (found by hand: "ซื้อบัตรชมภาพยนตร์" leads there).
// The page shows one day at a time with a strip of date buttons, so open it per movie and click each day.
const SHOWTIME_URL = "https://www.sfcinema.com/th/showtime/{id}";
const THAI_MONTH = /\d{1,2}\s*(ม\.?ค|ก\.?พ|มี\.?ค|เม\.?ย|พ\.?ค|มิ\.?ย|ก\.?ค|ส\.?ค|ก\.?ย|ต\.?ค|พ\.?ย|ธ\.?ค)/;
const DAYS = Math.min(Math.max(Number(args.get("days")) || (DISCOVER ? 2 : 3), 1), 7);
const pages = [], visited = [];

async function collectMovie(movie) {
  const url = SHOWTIME_URL.replace("{id}", movie.id);
  await visit(url);
  visited.push(url);
  if (pages.length < 4) pages.push({ url: page.url(), html: await page.content() });
  // the first day is selected on load; click the following date buttons
  const dates = page.getByText(THAI_MONTH).locator("visible=true");
  const n = Math.min(await dates.count(), DAYS);
  for (let i = 1; i < n; i++) {
    const el = dates.nth(i);
    const label = (await el.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    await el.click({ timeout: 5000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    for (let y = 0; y < 4; y++) { await page.mouse.wheel(0, 1500); await page.waitForTimeout(300); }
    visited.push(`  day ${label}`);
    if (DISCOVER && pages.length < 5) pages.push({ url: `${page.url()} (${label})`, html: await page.content() });
  }
  return n;
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
    const before = responses.length;
    const days = await collectMovie(m);
    console.log(`  [${i + 1}/${todo.length}] ${m.title}: ${days} day(s), ${responses.length - before} responses`);
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

const { movies, showtimes } = parseSf(responses, { movieUrl: SHOWTIME_URL });
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
