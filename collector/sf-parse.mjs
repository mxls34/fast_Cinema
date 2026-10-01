// Turns the JSON that sfcinema.com loads in the browser into rows for the scrape-cinemas "ingest" action.
// Field names below come from real captures of the site (October 2026):
//
//   onl.sfcinema.com/ticket/data/content?...            movies   { data: [{ id, type, title, genre, rating, releaseDate, contentLength, media }] }
//   onl.sfcinema.com/ticket/data/branch?...             branches { data: [{ id: "T21", name, regionId }] }
//   onl.sfcinema.com/ticket/data/session?contentId=...  sessions { data: [{ id, branchId, screenName, contentId, audio, subtitles,
//                                                                          sessionDatetime: "2026-10-01T10:35:00" (Bangkok), status }] }
//
// The session list of one movie covers about two weeks (thousands of rows), so callers pass `days` to keep the next few days.

const CONTENT = /onl\.sfcinema\.com\/ticket\/data\/content\?/;
const BRANCH = /onl\.sfcinema\.com\/ticket\/data\/branch\?/;
const SESSION = /onl\.sfcinema\.com\/ticket\/data\/session\?/;
const REGION = /onl\.sfcinema\.com\/ticket\/data\/region\?/;

// ticket/data/region is only loaded on some pages, so keep the six regions here as a fallback
const REGIONS = {
  "33821cf0-af36-47cf-971c-fc0c376d51b8": "กรุงเทพและปริมณฑล",
  "d9bbe26f-21ff-418e-8d6b-7c35028039be": "ภาคเหนือ",
  "57441cbe-0108-45ff-bdf9-d847ed8a6d25": "ภาคกลาง",
  "01f5f9ba-9365-407c-9fc8-4fdcfcd56d96": "ภาคตะวันออกเฉียงเหนือ",
  "d14ce8aa-19d7-438b-92b8-cbb726c6853d": "ภาคตะวันออก",
  "2d023bda-91e3-4df5-b8dc-daa90a9f059a": "ภาคใต้",
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
// Major writes "ธี่หยด สมิงเขาขวาง" where SF writes "ธี่หยด: สมิงเขาขวาง"; movies are merged by title, so drop the colons
export const normTitle = (v) => text(v)?.replace(/\s*:\s*/g, " ").replace(/\s+/g, " ").trim() ?? null;

// "2026-10-01T10:35:00" without an offset is Bangkok local time
export function toIso(value) {
  let s = String(value ?? "").trim().replace(" ", "T");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return null;
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += "+07:00";
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString();
}

export function sfMovie(m, movieUrl) {
  return {
    title: normTitle(m.title),
    duration: m.contentLength > 0 && m.contentLength < 600 ? m.contentLength : null,
    poster_url: m.media?.portrait ?? null,
    genre: text(m.genre),
    release_date: DATE.test(m.releaseDate ?? "") ? m.releaseDate : null,
    rating: text(m.rating),
    url: movieUrl ? movieUrl.replace("{id}", m.id) : null,
  };
}

const dataOf = (responses, re) => responses.filter((r) => re.test(r.url)).flatMap((r) => (Array.isArray(r.body?.data) ? r.body.data : []));

// responses: [{ url, body }] captured by the browser
// movieUrl: e.g. "https://www.sfcinema.com/th/showtime/{id}"; days: keep sessions from now up to this many Bangkok days
export function parseSf(responses, { movieUrl, days = 3, now = new Date() } = {}) {
  const movies = new Map();
  const content = dataOf(responses, CONTENT);
  for (const m of content) if (m.type === "now_showing" && normTitle(m.title)) movies.set(normTitle(m.title), sfMovie(m, movieUrl));
  const titleById = new Map(content.map((m) => [m.id, normTitle(m.title)]));

  const regions = { ...REGIONS, ...Object.fromEntries(dataOf(responses, REGION).map((g) => [g.id, g.name])) };
  const branches = new Map(dataOf(responses, BRANCH).filter((b) => text(b.name)).map((b) => [b.id, { name: b.name.trim(), city: regions[b.regionId] ?? null }]));

  // Bangkok calendar window: today .. today + days - 1
  const bkk = (d) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
  const from = now.toISOString(), last = bkk(new Date(now.getTime() + (days - 1) * 86400_000));

  const seen = new Set();
  const showtimes = [];
  for (const s of dataOf(responses, SESSION)) {
    const title = titleById.get(s.contentId);
    const branch = branches.get(s.branchId);
    const start = toIso(s.sessionDatetime);
    if (!title || !branch || !start || s.status !== "A") continue;
    if (start < from || String(s.sessionDatetime).slice(0, 10) > last) continue;
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    const subs = (Array.isArray(s.subtitles) ? s.subtitles : []).filter(Boolean).join(",");
    showtimes.push({
      movie_title: title,
      theater: branch.name,
      city: branch.city,
      screen: text(s.screenName) ?? (s.screenNumber ? `Cinema ${s.screenNumber}` : "Theatre"),
      start_time: start,
      language: `${text(s.audio) ?? "TH"}/${subs || "--"}`,
      source_showtime_id: text(s.id),
    });
  }
  const theaters = [...branches.values()];
  return { movies: [...movies.values()], theaters, showtimes };
}
