// Feature 3: seat map of one showtime; booked seats are disabled, up to 10 seats can be picked.
import { $, esc, rpc, params, setBrand, showtimeInfo, fmtTime, fmtDate, nf, booking, showError } from "./lib.js";

const showtimeId = Number(params.get("showtime"));
const MAX = 10;
const ORDER = ["J", "I", "H", "G", "F", "E", "D", "C", "B", "A"]; // as in the mockup: screen on top, J first
const TYPE_LABEL = { Couple: "Couple", Normal: "Normal", Premium: "Premium", Deluxe: "Deluxe" };
const main = $("main");
const picked = new Map(); // seat_id -> seat

try {
  if (!showtimeId) throw new Error("ลิงก์ไม่มี ?showtime= (ถ้าใช้ npx serve ให้เปิดจากโฟลเดอร์ web ที่มีไฟล์ serve.json)");
  const info = await showtimeInfo(showtimeId);
  if (!info) throw new Error("ไม่พบรอบฉายนี้");
  const theater = info.screen.theater;
  setBrand(theater.brand);
  $("back").href = `showtime.html?id=${info.movie.movie_id}&brand=${theater.brand}&date=${new Date(new Date(info.start_time).getTime() + 7 * 3600_000).toISOString().slice(0, 10)}`;
  if (new Date(info.start_time) < new Date()) throw new Error("รอบนี้เริ่มฉายแล้ว กรุณาเลือกรอบอื่น");

  const seats = await rpc("get_seat_map", { p_showtime_id: showtimeId });
  const rows = new Map();
  for (const s of seats) {
    const r = s.seat_number.match(/^[A-Z]+/)[0];
    if (!rows.has(r)) rows.set(r, []);
    rows.get(r).push(s);
  }
  for (const list of rows.values()) list.sort((a, b) => parseInt(a.seat_number.slice(1)) - parseInt(b.seat_number.slice(1)));
  const rowNames = [...rows.keys()].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  const types = [...new Map(seats.map((s) => [s.seat_type, s.price])).entries()];

  const seatBtn = (s) => `<button type="button" class="seat ${esc(s.seat_type)}" data-id="${s.seat_id}" ${s.booked ? "disabled" : ""}
      title="${esc(s.seat_number)} · ${nf.format(s.price)} บาท${s.booked ? " · จองแล้ว" : ""}" aria-label="ที่นั่ง ${esc(s.seat_number)}"></button>`;

  main.innerHTML = `
    <div class="panel-box">
      <div class="seatmap">
        <div class="screen-bar">SCREEN</div>
        ${rowNames.map((r) => {
          const list = rows.get(r), half = Math.ceil(list.length / 2);
          return `<div class="seat-row"><span class="row-label">${r}</span>
            ${list.slice(0, half).map(seatBtn).join("")}<span style="width:10px"></span>${list.slice(half).map(seatBtn).join("")}
            <span class="row-label">${r}</span></div>`;
        }).join("")}
      </div>
    </div>
    <div class="seat-legend">
      ${types.map(([t, p]) => `<div><span class="seat ${esc(t)}"></span>${esc(TYPE_LABEL[t] ?? t)}<br>${nf.format(p)} THB</div>`).join("")}
      <div><span class="seat" style="background:#5b5470"></span>จองแล้ว</div>
    </div>
    <div class="panel-box summary">
      <div>ที่นั่ง: <b id="sel">-</b> · ${esc(info.screen.name)} · รอบฉาย: ${fmtTime(info.start_time)}</div>
      <div>${esc(info.movie.title)}<br><small>${esc(theater.name)} · ${fmtDate(info.start_time)}</small></div>
      <div class="price">ราคา: <span id="total">0</span> THB</div>
      <button class="gold-btn" id="buy" type="button" disabled>ซื้อตั๋ว</button>
      <p class="note" id="msg"></p>
    </div>`;

  const update = () => {
    const list = [...picked.values()].sort((a, b) => a.seat_number.localeCompare(b.seat_number, "en", { numeric: true }));
    $("sel").textContent = list.map((s) => s.seat_number).join(", ") || "-";
    $("total").textContent = nf.format(list.reduce((sum, s) => sum + Number(s.price), 0));
    $("buy").disabled = !list.length;
  };
  const byId = new Map(seats.map((s) => [s.seat_id, s]));
  main.querySelector(".seatmap").addEventListener("click", (e) => {
    const b = e.target.closest(".seat");
    if (!b || b.disabled) return;
    const s = byId.get(Number(b.dataset.id));
    if (picked.has(s.seat_id)) { picked.delete(s.seat_id); b.classList.remove("on"); }
    else if (picked.size >= MAX) { $("msg").textContent = `เลือกได้สูงสุด ${MAX} ที่นั่ง`; return; }
    else { picked.set(s.seat_id, s); b.classList.add("on"); }
    $("msg").textContent = "";
    update();
  });
  $("buy").addEventListener("click", () => {
    const list = [...picked.values()].sort((a, b) => a.seat_number.localeCompare(b.seat_number, "en", { numeric: true }));
    booking.set({
      showtime_id: showtimeId,
      seat_ids: list.map((s) => s.seat_id),
      seat_numbers: list.map((s) => s.seat_number),
      amount: list.reduce((sum, s) => sum + Number(s.price), 0),
      movie: info.movie.title, poster: info.movie.poster_url, theater: theater.name, brand: theater.brand,
      screen: info.screen.name, start_time: info.start_time,
    });
    location.href = "email.html";
  });
} catch (e) {
  showError(main, e);
}
