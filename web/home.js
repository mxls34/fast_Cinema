import { rpc, esc } from "./api.js";

const HOLD_MS = 60_000;        // hold the home button this long to open the report
const RING_AFTER_MS = 2_000;   // only show the progress ring once it is clearly a long press

const TEXT = {
  th: { home: "Home", major: "Major cinema", sf: "SF cinema", loading: "กำลังโหลด…", empty: "ไม่พบภาพยนตร์", search: "ค้นหาชื่อหนัง",
        error: "โหลดข้อมูลไม่สำเร็จ", min: "นาที", soon: "หน้ารายละเอียดหนังยังไม่เปิดให้ใช้งาน", hold: "กดค้างต่อเพื่อเปิดรายงาน" },
  en: { home: "Home", major: "Major cinema", sf: "SF cinema", loading: "Loading…", empty: "No movies found", search: "Search movies",
        error: "Could not load movies", min: "min", soon: "Movie details page is not available yet", hold: "Keep holding to open the report" },
};

const $ = (id) => document.getElementById(id);
const state = { movies: [], view: viewFromHash(), q: "", lang: localGet("lang") || "th" };

function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
function viewFromHash() { const h = location.hash.slice(1); return h === "major" || h === "sf" ? h : "home"; }
const t = (k) => TEXT[state.lang][k];

function render() {
  document.body.dataset.view = state.view;
  document.documentElement.lang = state.lang;
  $("title").textContent = t(state.view);
  $("lang").textContent = state.lang === "th" ? "ภาษา" : "TH";
  $("q").placeholder = t("search");
  for (const b of document.querySelectorAll(".dock-btn")) b.classList.toggle("active", b.dataset.go === state.view);

  const q = state.q.trim().toLowerCase();
  const list = state.movies.filter((m) =>
    (state.view === "home" || (state.view === "major" ? m.has_major : m.has_sf)) &&
    (!q || m.title.toLowerCase().includes(q)));

  $("grid").innerHTML = list.map((m) => `
    <li>
      <button class="card" type="button" data-id="${m.movie_id}">
        <div class="poster">${m.poster_url ? `<img src="${esc(m.poster_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ""}</div>
        <div class="card-title">${esc(m.title)}</div>
        <div class="card-meta">
          <span class="dots">
            ${m.has_major ? '<i class="dot major" title="Major Cineplex"></i>' : ""}
            ${m.has_sf ? '<i class="dot sf" title="SF Cinema"></i>' : ""}
          </span>
          ${m.duration ? `<span class="len">${m.duration} ${t("min")}</span>` : ""}
        </div>
      </button>
    </li>`).join("");
  $("status").hidden = list.length > 0;
  if (!list.length && state.movies.length) $("status").textContent = t("empty");
}

async function load() {
  $("status").textContent = t("loading");
  try {
    state.movies = await rpc("now_showing");
    if (!state.movies.length) $("status").textContent = t("empty");
  } catch (e) {
    console.error(e);
    $("status").textContent = t("error");
  }
  render();
}

let toastTimer;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2500);
}

// ---- navigation ----
document.querySelector(".dock").addEventListener("click", (e) => {
  const btn = e.target.closest(".dock-btn");
  if (!btn || btn.dataset.suppressClick) { if (btn) delete btn.dataset.suppressClick; return; }
  location.hash = btn.dataset.go === "home" ? "" : btn.dataset.go;
});
addEventListener("hashchange", () => { state.view = viewFromHash(); render(); });

$("grid").addEventListener("click", (e) => { if (e.target.closest(".card")) toast(t("soon")); });
$("search-btn").addEventListener("click", () => {
  const box = $("search");
  box.hidden = !box.hidden;
  if (!box.hidden) $("q").focus(); else { state.q = ""; $("q").value = ""; render(); }
});
$("q").addEventListener("input", (e) => { state.q = e.target.value; render(); });
$("lang").addEventListener("click", () => { state.lang = state.lang === "th" ? "en" : "th"; localSet("lang", state.lang); render(); });

// ---- hidden report: hold the home button for 1 minute ----
const home = $("home-btn");
let holdStart = 0, holdFrame = 0, hintShown = false;

function holdTick() {
  const held = performance.now() - holdStart;
  if (held >= RING_AFTER_MS) {
    home.classList.add("holding");
    home.style.setProperty("--hold", Math.min(held / HOLD_MS, 1));
    if (!hintShown) { hintShown = true; toast(t("hold")); }
  }
  if (held >= HOLD_MS) { stopHold(); location.href = "report.html"; return; }
  holdFrame = requestAnimationFrame(holdTick);
}
function stopHold() {
  if (holdStart && performance.now() - holdStart >= RING_AFTER_MS) home.dataset.suppressClick = "1";
  cancelAnimationFrame(holdFrame);
  holdStart = 0;
  hintShown = false;
  home.classList.remove("holding");
  home.style.setProperty("--hold", 0);
}
home.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  home.setPointerCapture(e.pointerId);
  holdStart = performance.now();
  holdFrame = requestAnimationFrame(holdTick);
});
for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) home.addEventListener(ev, () => holdStart && stopHold());
home.addEventListener("contextmenu", (e) => e.preventDefault());

render();
load();
