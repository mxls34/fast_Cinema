// Shared helpers for the booking pages (movie -> showtime -> seat -> email -> pay -> done).
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY, rpc, esc } from "./api.js";

export { rpc, esc };
export const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
export const params = new URLSearchParams(location.search);
export const $ = (id) => document.getElementById(id);
export const BRAND_NAME = { major: "Major Cineplex", sf: "SF Cinema" };
export const nf = new Intl.NumberFormat("th-TH");

// read-only table access (RLS allows select on the catalogue tables)
export async function select(table, query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: { apikey: SUPABASE_KEY } });
  if (!res.ok) throw new Error(`${table}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const TZ = "Asia/Bangkok";
export const fmtTime = (iso) => new Date(iso).toLocaleTimeString("th-TH", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
export const fmtDate = (iso, opts = { day: "numeric", month: "short", year: "2-digit" }) =>
  new Date(iso).toLocaleDateString("th-TH", { timeZone: TZ, ...opts });
export const fmtDuration = (min) => (min ? `${Math.floor(min / 60)} ชม. ${min % 60} นาที` : "");

export function setBrand(brand) {
  document.body.dataset.view = brand === "major" || brand === "sf" ? brand : "home";
}

// the selection carried from the seat page to the payment page; localStorage (not sessionStorage) so it
// survives the email's sign-in link opening in a new tab
const KEY = "fast-cinema-booking";
export const booking = {
  get() { try { return JSON.parse(localStorage.getItem(KEY)) ?? null; } catch { return null; } },
  set(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private mode: state lives only on this page */ } },
  clear() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } },
};

// showtime with its movie, screen and theater, for page headers
export async function showtimeInfo(id) {
  const rows = await select("showtimes",
    `showtime_id=eq.${Number(id)}&select=showtime_id,start_time,language,` +
    `movie:movies(movie_id,title,poster_url,duration,rating,genre),screen:screens(name,theater:theaters(name,brand,city))`);
  return rows[0] ?? null;
}

export function movieCard(m, extra = "") {
  return `
    <section class="movie-hero">
      <div class="hero-poster">${m.poster_url ? `<img src="${esc(m.poster_url)}" alt="" referrerpolicy="no-referrer" />` : ""}</div>
      <div class="hero-text">
        <h2>${esc(m.title)}</h2>
        <p>${[m.genre && `ประเภท: ${esc(m.genre)}`, m.rating && `เรต: ${esc(m.rating)}`, m.duration && `⏱ ${fmtDuration(m.duration)}`].filter(Boolean).join("<br>")}</p>
        ${extra}
      </div>
    </section>`;
}

export function showError(el, e) {
  console.error(e);
  el.innerHTML = `<p class="status">เกิดข้อผิดพลาด: ${esc(e.message ?? e)}</p>`;
}
