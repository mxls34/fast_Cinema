// Turns the JSON that sfcinema.com loads in the browser into rows for the scrape-cinemas "ingest" action.
//
// sfcinema.com sits behind a Cloudflare challenge, so it could not be inspected while this was written.
// The parser therefore does not rely on exact field names: it walks every captured JSON response,
// remembers the nearest movie / cinema / screen name above each node, and emits a showtime for every
// date-time value it meets under a time-like key. Run `npm run sf:discover` once and the raw responses
// are saved to out/, so the parser can be tightened to the real field names.

const MOVIE_KEY = /^(movie_?(name|title)(_?th)?|title(_?th)?|name_?th)$/i;
const CINEMA_KEY = /^(cinema|branch|theat(er|re)|location|site)_?name(_?th)?$/i;
const CINEMA_OBJ = /^(cinema|branch|theat(er|re)s?|location|site)$/i;
const SCREEN_KEY = /^(screen|hall|auditorium|theat(er|re))_?(name|no|number)?$/i;
const CITY_KEY = /^(city|province|region|zone)(_?name)?(_?th)?$/i;
const LANG_KEY = /^(lang(uage)?|sound(track)?|audio)(_?name)?$/i;
const TIME_KEY = /(show_?time|start(_?(time|date))?|session(_?time)?|show_?date_?time|date_?time|time)$/i;
const POSTER_KEY = /(poster|image|thumb|cover|banner)/i;
const DURATION_KEY = /^(duration|run_?time|length|minutes?)$/i;
const GENRE_KEY = /^genres?(_?name)?(_?th)?$/i;
const RELEASE_KEY = /^(release(_?date)?|open(ing)?_?date)$/i;

const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const HHMM = /^\d{1,2}:\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
// Major writes "ธี่หยด สมิงเขาขวาง" where SF writes "ธี่หยด: สมิงเขาขวาง"; movies are merged by title, so drop the colons
export const normTitle = (v) => text(v)?.replace(/\s*:\s*/g, " ").replace(/\s+/g, " ").trim() ?? null;

// "2026-10-01 20:30" without an offset is Bangkok local time
export function toIso(value, dateHint) {
  let s = String(value).trim();
  if (HHMM.test(s)) {
    if (!dateHint) return null;
    s = `${dateHint}T${s.padStart(5, "0")}`;
  }
  if (!ISO.test(s)) return null;
  s = s.replace(" ", "T");
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += "+07:00";
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString();
}

function nameOf(v) {
  if (typeof v === "string") return text(v);
  if (v && typeof v === "object") return text(v.name_th ?? v.nameTh ?? v.name ?? v.title ?? v.title_th);
  return null;
}

export function looksLikeMovie(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return false;
  const keys = Object.keys(o);
  return keys.some((k) => MOVIE_KEY.test(k) && text(o[k])) && keys.some((k) => POSTER_KEY.test(k) && typeof o[k] === "string" && /^https?:\/\//.test(o[k]));
}

function movieFrom(o, pageUrl) {
  const k = Object.keys(o);
  const title = normTitle(o[k.find((x) => /th$/i.test(x) && MOVIE_KEY.test(x))]) ?? normTitle(o[k.find((x) => MOVIE_KEY.test(x))]);
  const poster = o[k.find((x) => POSTER_KEY.test(x) && typeof o[x] === "string" && /^https:\/\//.test(o[x]))] ?? null;
  const dur = Number(String(o[k.find((x) => DURATION_KEY.test(x))] ?? "").match(/\d+/)?.[0]);
  const genreVal = o[k.find((x) => GENRE_KEY.test(x))];
  const genre = Array.isArray(genreVal) ? genreVal.map(nameOf).filter(Boolean).join(", ") : nameOf(genreVal);
  const release = String(o[k.find((x) => RELEASE_KEY.test(x))] ?? "").slice(0, 10);
  return {
    title,
    duration: dur > 0 && dur < 600 ? dur : null,
    poster_url: poster,
    genre: genre || null,
    release_date: DATE.test(release) ? release : null,
    url: /sfcinema/.test(pageUrl ?? "") ? pageUrl : null,
  };
}

// Walk one JSON document. ctx = nearest movie / cinema / screen / city / language / date seen above.
function walk(node, ctx, out, pageUrl) {
  if (Array.isArray(node)) {
    for (const x of node) walk(x, ctx, out, pageUrl);
    return;
  }
  if (!node || typeof node !== "object") return;

  const next = { ...ctx };
  if (looksLikeMovie(node)) {
    const m = movieFrom(node, pageUrl);
    if (m.title) {
      const filled = Object.fromEntries(Object.entries(m).filter(([, v]) => v != null));
      out.movies.set(m.title, { ...m, ...out.movies.get(m.title), ...filled });
      next.movie = m.title;
    }
  }
  for (const [k, v] of Object.entries(node)) {
    if (MOVIE_KEY.test(k) && text(v) && !next.movie) next.movie = normTitle(v);
    if (CINEMA_KEY.test(k) && text(v)) next.cinema = text(v);
    if (CINEMA_OBJ.test(k) && v && typeof v === "object" && !Array.isArray(v) && nameOf(v)) next.cinema = nameOf(v);
    if (SCREEN_KEY.test(k) && (typeof v === "string" || typeof v === "number") && String(v).trim()) next.screen = String(v).trim();
    if (CITY_KEY.test(k) && text(v)) next.city = text(v);
    if (LANG_KEY.test(k) && text(v)) next.language = text(v);
    if (/date$/i.test(k) && typeof v === "string" && DATE.test(v.slice(0, 10)) && !ISO.test(v)) next.date = v.slice(0, 10);
  }
  for (const [k, v] of Object.entries(node)) {
    const values = Array.isArray(v) ? v : [v];
    if (TIME_KEY.test(k) && values.every((x) => typeof x === "string")) {
      for (const x of values) {
        const iso = toIso(x, next.date);
        if (iso && next.movie && next.cinema) {
          out.showtimes.push({
            movie_title: next.movie,
            theater: next.cinema,
            city: next.city ?? null,
            screen: next.screen ? (/^\d+$/.test(next.screen) ? `Theatre ${next.screen}` : next.screen) : "Theatre",
            start_time: iso,
            language: next.language ?? null,
            source_showtime_id: text(String(node.id ?? node.showtime_id ?? node.session_id ?? "")) ,
          });
        }
      }
    } else if (v && typeof v === "object") {
      walk(v, next, out, pageUrl);
    }
  }
}

// Known SF endpoint (seen in a real capture): onl.sfcinema.com/ticket/data/content
// -> { data: [{ id, type: "now_showing"|"coming_soon", title, genre, rating, releaseDate, contentLength, media: { portrait } }] }
const CONTENT = /onl\.sfcinema\.com\/ticket\/data\/content\?/;
// endpoints that never hold showtimes but are full of dates and names
const NOISE = /\/campaign\/|\/ticket\/data\/(brand|getconfig|event|specialscreen|popup)\b/;

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

// responses: [{ url, pageUrl, body }] captured by the browser; movieUrl: e.g. "https://www.sfcinema.com/th/movie/{id}"
export function parseSf(responses, { movieUrl } = {}) {
  const out = { movies: new Map(), showtimes: [] };
  const content = responses.filter((r) => CONTENT.test(r.url)).flatMap((r) => r.body?.data ?? []);
  for (const m of content) {
    if (m.type !== "now_showing" || !text(m.title)) continue;
    out.movies.set(normTitle(m.title), sfMovie(m, movieUrl));
  }
  // on /th/showtime/{movie id} the showtime data may not repeat the movie title, so seed it from the page URL
  const titleById = new Map(content.map((m) => [m.id, normTitle(m.title)]));
  for (const r of responses) {
    if (CONTENT.test(r.url) || NOISE.test(r.url)) continue;
    const id = r.pageUrl?.match(/\/showtime\/([0-9a-f-]{36})/)?.[1];
    walk(r.body, id && titleById.get(id) ? { movie: titleById.get(id) } : {}, out, r.pageUrl);
  }
  const seen = new Set();
  const showtimes = out.showtimes.filter((s) => {
    const k = `${s.theater}|${s.screen}|${s.start_time}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
  return { movies: [...out.movies.values()], showtimes };
}
