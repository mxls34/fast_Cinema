// Feature 1: show the movie and which chains have showtimes for it (Major / SF).
import { $, rpc, select, params, movieCard, fmtDate, showError } from "./lib.js";

const id = Number(params.get("id"));
const main = $("main");

try {
  const [list, rows] = await Promise.all([rpc("now_showing"), select("movies", `movie_id=eq.${id}&select=*`)]);
  const showing = list.find((m) => m.movie_id === id);
  const movie = rows[0];
  if (!movie) throw new Error("ไม่พบภาพยนตร์");
  document.title = `${movie.title} | Fast Cinema`;

  const release = movie.release_date ? `<p>วันที่ฉาย: ${fmtDate(`${movie.release_date}T00:00:00+07:00`, { day: "numeric", month: "short", year: "numeric" })}</p>` : "";
  const btn = (brand, label, ok) =>
    `<a class="brand-btn ${brand}" href="showtime.html?id=${id}&brand=${brand}" ${ok ? "" : 'aria-disabled="true" tabindex="-1"'}>
       <span>${label}<small>${ok ? "ดูรอบฉาย" : "ไม่มีรอบฉาย"}</small></span></a>`;

  main.innerHTML = `
    ${movieCard(movie, release)}
    <p class="note">เลือกโรงภาพยนตร์</p>
    <div class="brand-pick">
      ${btn("major", "MAJOR", showing?.has_major)}
      ${btn("sf", "SF", showing?.has_sf)}
    </div>`;
} catch (e) {
  showError(main, e);
}
$("back").href = "./";
