// Feature 6: "booking complete" and the ticket (also emailed when the send-ticket function has an email provider).
import { $, esc, sb, params, setBrand, fmtTime, fmtDate, nf, showError } from "./lib.js";

const token = params.get("token");
const main = $("main");
$("back").href = "./";

try {
  const { data: t, error } = await sb.rpc("booking_details", { p_token: token });
  if (error || !t) throw new Error(error?.message ?? "ไม่พบการจองนี้ (ต้องเปิดในเบราว์เซอร์ที่ยืนยันอีเมลไว้)");
  setBrand(t.brand);
  const sent = params.get("sent") === "1";
  main.innerHTML = `
    <div style="text-align:center"><div class="big-check">✅</div><h2 style="margin:6px 0 0">จองสำเร็จ!</h2>
      <p class="note ${sent ? "ok" : ""}">${sent ? `ส่งตั๋วไปที่ ${esc(t.email)} แล้ว` : `แสดงหน้านี้ที่จุดรับบัตร (ยังไม่ได้ตั้งค่าการส่งอีเมล)`}</p></div>
    <div class="ticket">
      <h2>${esc(t.movie)}</h2>
      <div class="code">${esc(String(t.token).toUpperCase())}</div>
      <div id="qr" style="display:grid;place-items:center"></div>
      <dl>
        <dt>โรงภาพยนตร์</dt><dd>${esc(t.theater)}</dd>
        <dt>โรง</dt><dd>${esc(t.screen)}</dd>
        <dt>รอบฉาย</dt><dd>${fmtDate(t.start_time, { weekday: "short", day: "numeric", month: "short", year: "numeric" })} · ${fmtTime(t.start_time)}</dd>
        <dt>ที่นั่ง</dt><dd>${esc((t.seats ?? []).join(", "))}</dd>
        <dt>ยอดชำระ</dt><dd>${nf.format(t.amount)} THB</dd>
        <dt>อีเมล</dt><dd>${esc(t.email)}</dd>
      </dl>
    </div>
    <a class="gold-btn" href="./">กลับหน้าแรก</a>`;
  if (window.QRCode) new window.QRCode($("qr"), { text: String(t.token), width: 140, height: 140 });
} catch (e) {
  showError(main, e);
}
