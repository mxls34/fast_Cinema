// Feature 5: choose credit card or QR code. Payment is simulated: no card number is asked and no money moves.
// create_booking (database function) books the seats and records the payment in one transaction.
import { $, esc, sb, setBrand, booking, fmtTime, fmtDate, nf } from "./lib.js";

const b = booking.get();
const main = $("main");
if (!b?.email) { location.replace(b ? "email.html" : "./"); throw new Error("no verified email"); }
setBrand(b.brand);
$("back").href = "email.html";

const { data: { session } } = await sb.auth.getSession();
if (!session) { location.replace("email.html"); throw new Error("not signed in"); }

main.innerHTML = `
  <div class="panel-box">
    <b>${esc(b.movie)}</b><br>
    <span class="note" style="text-align:left;display:block">${esc(b.theater)} · ${esc(b.screen)}<br>
    ${fmtDate(b.start_time, { weekday: "short", day: "numeric", month: "short" })} · ${fmtTime(b.start_time)} · ที่นั่ง ${esc(b.seat_numbers.join(", "))}</span>
    <div class="summary" style="margin-top:8px"><span class="price">${nf.format(b.amount)} THB</span></div>
  </div>
  <h2 style="font-size:16px;margin:4px 0">เลือกช่องทางการชำระเงิน</h2>
  <div class="methods">
    <label class="method"><input type="radio" name="method" value="credit_card" checked />
      <span>💳 บัตรเครดิต / เดบิต<small>ระบบจำลองสำหรับโปรเจกต์ ไม่ต้องกรอกเลขบัตร ไม่มีการตัดเงินจริง</small></span></label>
    <label class="method"><input type="radio" name="method" value="qr_code" />
      <span>📱 QR Code (พร้อมเพย์)<small>QR จำลอง ไม่มีการโอนเงินจริง</small></span></label>
  </div>
  <div id="qr" class="qr" hidden></div>
  <p class="note">ส่งตั๋วไปที่ ${esc(b.email)}</p>
  <button class="gold-btn" id="pay" type="button">ชำระเงิน ${nf.format(b.amount)} THB</button>
  <p class="note" id="msg"></p>`;

const method = () => main.querySelector('input[name="method"]:checked').value;
main.querySelector(".methods").addEventListener("change", () => {
  const box = $("qr");
  box.hidden = method() !== "qr_code";
  if (!box.hidden && !box.childElementCount && window.QRCode) {
    new window.QRCode(box, { text: `FASTCINEMA-DEMO|${b.showtime_id}|${b.seat_numbers.join(",")}|${b.amount}`, width: 160, height: 160 });
  }
});

$("pay").onclick = async () => {
  $("pay").disabled = true;
  $("msg").className = "note";
  $("msg").textContent = "กำลังทำรายการ…";
  const { data, error } = await sb.rpc("create_booking", {
    p_showtime_id: b.showtime_id, p_seat_ids: b.seat_ids, p_email: b.email, p_method: method(),
  });
  if (error || !data?.[0]) {
    $("pay").disabled = false;
    $("msg").className = "note err";
    $("msg").textContent = /already booked/.test(error?.message) ? "มีคนจองที่นั่งนี้ไปแล้ว กรุณาเลือกที่นั่งใหม่"
      : `ทำรายการไม่สำเร็จ: ${error?.message ?? "unknown error"}`;
    return;
  }
  const { booking_token } = data[0];
  // email the e-coupon; the success page still shows the ticket if email is not configured
  const sent = await sb.functions.invoke("send-ticket", { body: { token: booking_token } })
    .then((r) => r.data?.sent === true).catch(() => false);
  booking.clear();
  location.href = `done.html?token=${encodeURIComponent(booking_token)}&sent=${sent ? 1 : 0}`;
};
