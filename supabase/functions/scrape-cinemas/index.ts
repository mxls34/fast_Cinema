// Edge Function: scrape-cinemas
// POST {"action":"major","days":2}            -> scrape Major Cineplex (movies + showtimes) into Supabase
// POST {"action":"ingest","brand":"sf",...}    -> store SF Cinema data pushed by the local browser collector
// Every call must send header  x-ingest-token: <app_config.ingest_token>
import { createClient } from "npm:@supabase/supabase-js@2";

const MAJOR = "https://www.majorcineplex.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-ingest-token, authorization, apikey",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// ---------- helpers ----------
const strip = (s: string) =>
  s.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#039;|&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

const MONTHS: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
function parseMajorDate(s: string): string | null {
  const m = s.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  return m && MONTHS[m[2]] ? `${m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2, "0")}` : null;
}
function bangkokDate(offsetDays: number): string {
  const d = new Date(Date.now() + 7 * 3600_000 + offsetDays * 86400_000);
  return d.toISOString().slice(0, 10);
}
// "2026-10-01" + "20:30" (Bangkok) -> ISO UTC. Shows before 05:00 belong to the next calendar day.
function toIso(date: string, hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const base = new Date(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+07:00`);
  if (h < 5) base.setUTCDate(base.getUTCDate() + 1);
  return base.toISOString();
}
async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

type MovieRow = { title: string; duration: number | null; poster_url: string | null; genre: string | null; release_date: string | null; rating?: string | null; major_url?: string | null; sf_url?: string | null; major_movie_id?: number | null };
type ShowRow = { movie_title: string; theater: string; city?: string | null; screen: string; start_time: string; language?: string | null; source_showtime_id?: string | null };

// ---------- Major Cineplex ----------
async function majorMovies(): Promise<MovieRow[]> {
  const html = await (await fetch(`${MAJOR}/movie`, { headers: { "User-Agent": UA } })).text();
  const a = html.indexOf('id="movie-page-showing"'), b = html.indexOf('id="movie-page-coming"');
  if (a < 0) throw new Error("Major: movie list not found (page layout changed?)");
  const section = html.slice(a, b > a ? b : undefined);
  const movies: MovieRow[] = [];
  for (const block of section.split('<div class="ml-box">').slice(1)) {
    const title = strip(block.match(/class="mlb-name">([\s\S]*?)<\/div>/)?.[1] ?? "");
    const id = Number(block.match(/search_showtime\/movie=(\d+)/)?.[1] ?? NaN);
    if (!title || !id) continue;
    const spans = [...block.matchAll(/class="genres_span">([\s\S]*?)<\/span>/g)].map((m) => strip(m[1]));
    const mins = spans.map((s) => s.match(/^(\d+)\s*นาที/)?.[1]).find(Boolean);
    const slug = block.match(/class="mlb-name"><a href="([^"]+)"/)?.[1];
    movies.push({
      title,
      major_movie_id: id,
      duration: mins ? Number(mins) : null,
      genre: spans.find((s) => !/นาที/.test(s)) ?? null,
      poster_url: block.match(/background:url\(([^)]+)\)/)?.[1]?.split("?")[0] ?? null,
      release_date: parseMajorDate(strip(block.match(/class="mlb-date">([\s\S]*?)<\/div>/)?.[1] ?? "")),
      major_url: slug ? MAJOR + slug : null,
    });
  }
  return movies;
}

async function majorShowtimes(movie: MovieRow, date: string): Promise<ShowRow[]> {
  const body = new URLSearchParams({ movie_text: String(movie.major_movie_id), cinema_text: "", flag_special_cinema: "normal", flag_type_showtime: "one_movie", date_link: date });
  const res = await fetch(`${MAJOR}/booking2/get_showtime`, {
    method: "POST",
    headers: { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return [];
  const html = await res.text();
  const rows: ShowRow[] = [];
  for (const branch of html.split('class="bsc-branch"').slice(1)) {
    const theater = strip(branch.match(/data-toggle="collapse"[^>]*>([\s\S]*?)<div class="i-arrow/)?.[1] ?? "");
    if (!theater) continue;
    for (const t of branch.split(/class="bscbbm-theatre-list bscbbmtl-movie/).slice(1)) {
      const lis = [...t.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => strip(m[1]));
      const screen = lis[0] || "Theatre";
      const language = lis[1] || null;
      for (const m of t.matchAll(/<a\b([^>]*)>\s*(\d{1,2}:\d{2})\s*<\/a>/g)) {
        rows.push({
          movie_title: movie.title, theater, screen, language,
          start_time: toIso(date, m[2]),
          source_showtime_id: m[1].match(/data-showtime="(\d+)"/)?.[1] ?? null,
        });
      }
    }
  }
  return rows;
}

// ---------- shared writer ----------
type TheaterRow = { name: string; city?: string | null };
async function save(brand: "major" | "sf", movies: MovieRow[], shows: ShowRow[], extraTheaters: TheaterRow[] = []) {
  // movies (merge on title so the same film from both chains shares one row)
  const byTitle = new Map<string, MovieRow>();
  for (const m of movies) if (m.title) byTitle.set(m.title, { ...byTitle.get(m.title), ...m });
  for (const s of shows) if (!byTitle.has(s.movie_title)) byTitle.set(s.movie_title, { title: s.movie_title, duration: null, poster_url: null, genre: null, release_date: null });
  const movieRows = [...byTitle.values()].map((m) => {
    const r: Record<string, unknown> = { title: m.title, updated_at: new Date().toISOString() };
    for (const k of ["duration", "poster_url", "genre", "release_date", "rating", "major_url", "sf_url", "major_movie_id"] as const) if (m[k] != null) r[k] = m[k];
    return r;
  });
  // upsert per column-set so a missing field never wipes an existing value
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const r of movieRows) { const k = Object.keys(r).sort().join(","); groups.set(k, [...(groups.get(k) ?? []), r]); }
  const movieId = new Map<string, number>();
  for (const rows of groups.values()) {
    const { data, error } = await db.from("movies").upsert(rows, { onConflict: "title" }).select("movie_id,title");
    if (error) throw new Error("movies: " + error.message);
    for (const m of data ?? []) movieId.set(m.title, m.movie_id);
  }

  // theaters (upsert returns ids, so no long ?name=in.(...) lookups)
  const theaterNames = [...new Set([...extraTheaters.map((t) => t.name), ...shows.map((s) => s.theater)])];
  const theaterId = new Map<string, number>();
  if (theaterNames.length) {
    const cities = new Map([...extraTheaters, ...shows.map((s) => ({ name: s.theater, city: s.city }))].filter((t) => t.city).map((t) => [t.name, t.city]));
    const { data, error } = await db.from("theaters").upsert(
      theaterNames.map((name) => ({ brand, name, ...(cities.get(name) ? { city: cities.get(name) } : {}) })),
      { onConflict: "brand,name" },
    ).select("theater_id,name");
    if (error) throw new Error("theaters: " + error.message);
    for (const t of data ?? []) theaterId.set(t.name, t.theater_id);
  }

  // screens
  const screenKeys = [...new Set(shows.map((s) => `${theaterId.get(s.theater)}|${s.screen}`))];
  const screenRows = screenKeys.map((k) => { const [t, ...n] = k.split("|"); return { theater_id: Number(t), name: n.join("|") }; })
    .filter((r) => r.theater_id);
  const screenId = new Map<string, number>();
  for (let i = 0; i < screenRows.length; i += 500) {
    const { data, error } = await db.from("screens").upsert(screenRows.slice(i, i + 500), { onConflict: "theater_id,name" }).select("screen_id,theater_id,name");
    if (error) throw new Error("screens: " + error.message);
    for (const s of data ?? []) screenId.set(`${s.theater_id}|${s.name}`, s.screen_id);
  }

  // showtimes
  const seen = new Set<string>();
  const showRows = [];
  for (const s of shows) {
    const sid = screenId.get(`${theaterId.get(s.theater)}|${s.screen}`);
    const mid = movieId.get(s.movie_title);
    if (!sid || !mid) continue;
    const key = `${sid}|${s.start_time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    showRows.push({ screen_id: sid, movie_id: mid, start_time: s.start_time, language: s.language || "TH/--", source_showtime_id: s.source_showtime_id ?? null });
  }
  for (let i = 0; i < showRows.length; i += 1000) {
    const { error } = await db.from("showtimes").upsert(showRows.slice(i, i + 1000), { onConflict: "screen_id,start_time" });
    if (error) throw new Error("showtimes: " + error.message);
  }
  return { movies: byTitle.size, theaters: theaterNames.length, showtimes: showRows.length };
}

async function logRun(source: string, started: Date, r: { movies?: number; theaters?: number; showtimes?: number }, status: string, note: string) {
  await db.from("scrape_runs").insert({ source, started_at: started.toISOString(), finished_at: new Date().toISOString(), status, note: note.slice(0, 500), ...r });
}

// ---------- SF ingest validation ----------
const str = (v: unknown, max = 300) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
function cleanIngest(body: any): { movies: MovieRow[]; shows: ShowRow[]; theaters: TheaterRow[] } {
  const theaters: TheaterRow[] = (Array.isArray(body.theaters) ? body.theaters : []).slice(0, 300)
    .map((t: any) => ({ name: str(t.name, 150)!, city: str(t.city, 100) })).filter((t: TheaterRow) => t.name);
  const movies: MovieRow[] = (Array.isArray(body.movies) ? body.movies : []).slice(0, 500).map((m: any) => ({
    title: str(m.title, 200)!, duration: Number.isFinite(+m.duration) && +m.duration > 0 ? Math.round(+m.duration) : null,
    poster_url: /^https:\/\//.test(m.poster_url ?? "") ? str(m.poster_url, 500) : null, genre: str(m.genre, 100),
    release_date: /^\d{4}-\d{2}-\d{2}$/.test(m.release_date ?? "") ? m.release_date : null,
    rating: str(m.rating, 20),
    sf_url: /^https:\/\/(www\.)?sfcinema/.test(m.url ?? "") ? str(m.url, 500) : null,
  })).filter((m: MovieRow) => m.title);
  const shows: ShowRow[] = (Array.isArray(body.showtimes) ? body.showtimes : []).slice(0, 20000).map((s: any) => ({
    movie_title: str(s.movie_title, 200)!, theater: str(s.theater, 150)!, city: str(s.city, 100), screen: str(s.screen, 100) ?? "Theatre",
    start_time: !isNaN(Date.parse(s.start_time)) ? new Date(s.start_time).toISOString() : "", language: str(s.language, 30),
    source_showtime_id: str(s.source_showtime_id, 60),
  })).filter((s: ShowRow) => s.movie_title && s.theater && s.start_time);
  return { movies, shows, theaters };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const { data: cfg } = await db.from("app_config").select("value").eq("key", "ingest_token").single();
  if (!cfg || req.headers.get("x-ingest-token") !== cfg.value) return json({ error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const started = new Date();

  if (body.action === "ingest") {
    try {
      const { movies, shows, theaters } = cleanIngest(body);
      if (!movies.length && !shows.length && !theaters.length) return json({ error: "nothing to ingest" }, 400);
      const r = await save("sf", movies, shows, theaters);
      await logRun("sf", started, r, "ok", `ingested from local collector`);
      return json({ ok: true, ...r });
    } catch (e) {
      await logRun("sf", started, {}, "error", String(e));
      return json({ error: String(e) }, 500);
    }
  }

  // default: Major
  const days = Math.min(Math.max(Number(body.days) || 2, 1), 7);
  const maxMovies = Math.min(Math.max(Number(body.maxMovies) || 60, 1), 80);
  try {
    const movies = (await majorMovies()).slice(0, maxMovies);
    const today = bangkokDate(0);
    const jobs = movies.flatMap((m) => Array.from({ length: days }, (_, d) => ({ m, date: bangkokDate(d) })))
      .filter((j) => !j.m.release_date || j.m.release_date <= j.date || j.date === today);
    let failed = 0;
    const results = await pool(jobs, 6, async (j) => {
      try { return await majorShowtimes(j.m, j.date); } catch { failed++; return []; }
    });
    const r = await save("major", movies, results.flat());
    await logRun("major", started, r, failed ? "partial" : "ok", `${days} day(s), ${jobs.length} requests, ${failed} failed`);
    return json({ ok: true, ...r, requests: jobs.length, failed });
  } catch (e) {
    await logRun("major", started, {}, "error", String(e));
    return json({ error: String(e) }, 500);
  }
});
