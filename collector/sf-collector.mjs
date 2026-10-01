// SF Cinema collector. Runs on YOUR computer in a visible Chrome window, because sfcinema.com is behind a
// Cloudflare challenge that blocks servers (Supabase, GitHub, cloud machines all get HTTP 403).
//
//   npm run sf:discover   open the site, save every JSON response + page HTML to out/  (send this to Claude)
//   npm run sf:dry        collect and print what would be saved, without writing to Supabase
//   npm run sf            collect and save to Supabase through the scrape-cinemas "ingest" action
//
// Options: --movies=15 (how many movie pages to open), --headless (only after the first run passed the challenge)
import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { callScraper } from "./env.mjs";
import { parseSf } from "./sf-parse.mjs";

const args = new Map(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const DISCOVER = args.has("discover"), DRY = args.has("dry-run");
const MAX_MOVIES = Number(args.get("movies")) || 15;
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

// open a page, click the first visible element whose text matches each pattern, record where it leads
async function explore(label, url, patterns) {
  try {
    console.log(`explore ${label}: ${url}`);
    await visit(url);
    visited.push(`${label}: ${page.url()}`);
    pages.push({ url: page.url(), html: await page.content() });
    for (const re of patterns) {
      const el = page.getByText(re).locator("visible=true").first();
      if (!(await el.count())) { console.log(`  nothing matches ${re}`); continue; }
      const text = (await el.innerText().catch(() => "")).slice(0, 60);
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.click({ timeout: 5000 }).catch((e) => console.log("  click failed:", e.message.split("\n")[0]));
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(3000);
      for (let y = 0; y < 4; y++) { await page.mouse.wheel(0, 1200); await page.waitForTimeout(500); }
      console.log(`  clicked "${text}" -> ${page.url()}`);
      visited.push(`  clicked "${text}" -> ${page.url()}`);
      pages.push({ url: page.url(), html: await page.content() });
    }
    await page.screenshot({ path: fileURLToPath(new URL(`./explore-${label.replace(/\W+/g, "-")}.png`, OUT)), fullPage: true }).catch(() => {});
  } catch (e) {
    console.log(`  explore ${label} failed: ${e.message.split("\n")[0]}`);
  }
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

  template = nowShowing.length ? await movieUrlTemplate(nowShowing[0]) : null;
  console.log(template ? `movie page URL: ${template}` : "could not find the movie page URL");

  if (template) {
    for (const m of nowShowing.slice(0, DISCOVER ? 2 : MAX_MOVIES)) {
      const url = template.replace("{id}", m.id);
      console.log("  open", m.title);
      await visit(url);
      visited.push(url);
      if (pages.length < 3) pages.push({ url: page.url(), html: await page.content() });
    }
  }

  // Movie detail pages hold no showtimes. SF shows them behind the "buy ticket" button and on the branch
  // pages, so in discover mode click through both and record what loads.
  if (DISCOVER) {
    if (template && nowShowing[0]) {
      await explore("buy-ticket button", template.replace("{id}", nowShowing[0].id), [/ซื้อบัตร|ซื้อตั๋ว|buy ticket|get ticket/i, /รอบฉาย|showtime/i]);
    }
    await explore("branches page", new URL("/th/cinemas", HOME).href, [/เอส\s?เอฟ|SF\s?(cinema|x|w)|เซ็นทรัล|central|เดอะมอลล์|the mall|เมกา|mega/i]);
    await explore("branches page (2)", new URL("/th/branches", HOME).href, [/เอส\s?เอฟ|SF\s?(cinema|x|w)|เซ็นทรัล|central|เดอะมอลล์|the mall|เมกา|mega/i]);
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
  writeFileSync(new URL("visited.txt", dir), [`template: ${template}`, ...visited].join("\n"));
  pages.forEach((p, i) => writeFileSync(new URL(`page-${i}.html`, dir), `<!-- ${p.url} -->\n${p.html}`));
  for (const f of ["last-page.png", ...["buy-ticket button", "branches page", "branches page (2)"].map((l) => `explore-${l.replace(/\W+/g, "-")}.png`)]) {
    try { writeFileSync(new URL(f, dir), readFileSync(new URL(f, OUT))); } catch { /* not taken */ }
  }
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
