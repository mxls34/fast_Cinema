// Feature 2: showtimes of one movie at one chain, per day, grouped by cinema and screen.
import { $, esc, rpc, select, params, setBrand, movieCard, fmtTime, showError, BRAND_NAME } from "./lib.js";

const id = Number(params.get("id"));
const brand = params.get("brand") === "sf" ? "sf" : "major";
const main = $("main");
setBrand(brand);
$("title").textContent = BRAND_NAME[brand];
$("back").href = `movie.html?id=${id}`;

let shows = [], filter = "";

function renderList() {
  const q = filter.trim().toLowerCase();
  const byTheater = new Map();
  for (const s of shows) {
    if (q && !`${s.theater} ${s.city ?? ""}`.toLowerCase().includes(q)) continue;
    if (!byTheater.has(s.theater_id)) byTheater.set(s.theater_id, { name: s.theater, city: s.city, screens: new Map() });
    const t = byTheater.get(s.theater_id);
    const key = `${s.screen}|${s.language ?? ""}`;
    if (!t.screens.has(key)) t.screens.set(key, { screen: s.screen, language: s.language, times: [] });
    t.screens.get(key).times.push(s);
  }
  const list = [...byTheater.values()];
  $("list").innerHTML = list.length ? list.map((t, i) => `
    <details class="theater" ${i < 3 ? "open" : ""}>
      <summary><span>${esc(t.name)}${t.city ? `<br><span class="city">${esc(t.city)}</span>` : ""}</span></summary>
      ${[...t.screens.values()].map((sc) => `
        <div class="screen-row">
          <div class="meta">${esc(sc.screen)} · 🔊 ${esc(sc.language ?? "TH/--")}</div>
          <div class="times">${sc.times.map((s) => `<a class="time-chip" href="seat.html?showtime=${s.showtime_id}">${fmtTime(s.start_time)}</a>`).join("")}</div>
        </div>`).join("")}
    </details>`).join("") : `<p class="status">${shows.length ? "ไม่พบสาขาที่ค้นหา" : "ไม่พบรอบฉายในวันนี้"}</p>`;
}

async function loadDay(date) {
  for (const b of document.querySelectorAll(".date-btn")) b.classList.toggle("active", b.dataset.date === date);
  $("list").innerHTML = `<p class="status">กำลังโหลด…</p>`;
  try {
  if (!id) throw new Error("ลิงก์ไม่มี ?id= (ถ้าใช้ npx serve ให้เปิดจากโฟลเดอร์ web ที่มีไฟล์ serve.json)");
    shows = await rpc("movie_showtimes", { p_movie_id: id, p_brand: brand, p_date: date });
    renderList();
  } catch (e) { showError($("list"), e); }
}

try {
  const [movie] = await select("movies", `movie_id=eq.${id}&select=*`);
  if (!movie) throw new Error("ไม่พบภาพยนตร์");
  const dates = await rpc("movie_dates", { p_movie_id: id, p_brand: brand });

  main.innerHTML = `
    ${movieCard(movie)}
    <div class="dates" id="dates">${dates.map((d) => {
      const day = new Date(`${d.show_date}T00:00:00+07:00`);
      const wd = day.toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok", weekday: "short" });
      const dm = day.toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short" });
      return `<button type="button" class="date-btn" data-date="${d.show_date}">${wd}<b>${dm}</b></button>`;
    }).join("")}</div>
    <input class="filter" id="filter" type="search" placeholder="ค้นหาสาขา / จังหวัด" autocomplete="off" />
    <div id="list" style="display:grid;gap:10px"></div>`;

  if (!dates.length) {
    $("list").innerHTML = `<p class="status">ยังไม่มีรอบฉายของ ${BRAND_NAME[brand]} สำหรับเรื่องนี้</p>`;
  } else {
    $("dates").addEventListener("click", (e) => { const b = e.target.closest(".date-btn"); if (b) loadDay(b.dataset.date); });
    $("filter").addEventListener("input", (e) => { filter = e.target.value; renderList(); });
    loadDay(dates.some((d) => d.show_date === params.get("date")) ? params.get("date") : dates[0].show_date);
  }
} catch (e) {
  showError(main, e);
}
