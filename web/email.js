// Feature 4: the email that receives the e-coupon, verified with a one-time code (Supabase Auth email OTP).
import { $, esc, sb, setBrand, booking, fmtTime, nf } from "./lib.js";

const b = booking.get();
const main = $("main");
if (!b) { location.replace("./"); throw new Error("no seats selected"); }
setBrand(b.brand);
$("back").href = `seat.html?showtime=${b.showtime_id}`;

const next = (email) => { booking.set({ ...booking.get(), email }); location.href = "pay.html"; };

const { data: { session } } = await sb.auth.getSession();
const summary = `<p class="note">${esc(b.movie)} · ${esc(b.theater)} · ${fmtTime(b.start_time)} · ที่นั่ง ${esc(b.seat_numbers.join(", "))} · ${nf.format(b.amount)} THB</p>`;

if (session?.user?.email) {
  // already verified in this browser (also the case after clicking the link in the email)
  main.innerHTML = `
    <h2 style="text-align:center;font-size:18px;margin:8px 0">ส่งตั๋วไปที่อีเมล</h2>
    <div class="panel-box" style="text-align:center"><b>${esc(session.user.email)}</b><br><span class="note ok">✓ ยืนยันอีเมลแล้ว</span></div>
    ${summary}
    <button class="gold-btn" id="go" type="button">ยืนยัน</button>
    <button class="link-btn" id="other" type="button">ใช้อีเมลอื่น</button>`;
  $("go").onclick = () => next(session.user.email);
  $("other").onclick = async () => { await sb.auth.signOut(); location.reload(); };
} else {
  main.innerHTML = `
    <h2 style="text-align:center;font-size:18px;margin:8px 0">กรุณาระบุอีเมลที่ต้องการรับตั๋วหนัง</h2>
    <div class="field">
      <label for="email">✉ ระบุอีเมล :</label>
      <input id="email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" />
      <div class="actions"><button class="small-gold" id="send" type="button">รับ OTP</button></div>
    </div>
    <div class="field">
      <label for="otp">รหัส OTP :</label>
      <input id="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="รหัสจากอีเมล" disabled />
      <div class="actions"><button class="link-btn" id="resend" type="button" disabled>ส่งรหัสอีกครั้ง</button></div>
    </div>
    <p class="note" id="msg"></p>
    ${summary}
    <button class="gold-btn" id="verify" type="button" disabled>ยืนยัน</button>`;

  let email = "", cooldown = 0, timer;
  const msg = (text, cls = "") => { $("msg").textContent = text; $("msg").className = `note ${cls}`; };
  const tick = () => {
    cooldown--;
    $("resend").textContent = cooldown > 0 ? `ส่งรหัสอีกครั้ง (${cooldown})` : "ส่งรหัสอีกครั้ง";
    $("resend").disabled = $("send").disabled = cooldown > 0;
    if (cooldown <= 0) clearInterval(timer);
  };
  async function send() {
    email = $("email").value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return msg("รูปแบบอีเมลไม่ถูกต้อง", "err");
    $("send").disabled = true;
    msg("กำลังส่งรหัส…");
    const { error } = await sb.auth.signInWithOtp({
      email, options: { shouldCreateUser: true, emailRedirectTo: new URL("email.html", location.href).href },
    });
    if (error) { $("send").disabled = false; return msg(`ส่งรหัสไม่สำเร็จ: ${error.message}`, "err"); }
    msg(`ส่งรหัสไปที่ ${email} แล้ว (ตรวจในกล่องจดหมายขยะด้วย) — หรือกดลิงก์ในอีเมลก็ได้`, "ok");
    $("otp").disabled = false; $("otp").focus();
    cooldown = 60; clearInterval(timer); timer = setInterval(tick, 1000); tick();
  }
  $("send").onclick = send;
  $("resend").onclick = send;
  $("otp").oninput = () => { $("verify").disabled = $("otp").value.trim().length < 6; };
  $("verify").onclick = async () => {
    $("verify").disabled = true;
    msg("กำลังตรวจสอบ…");
    const { data, error } = await sb.auth.verifyOtp({ email, token: $("otp").value.trim(), type: "email" });
    if (error || !data.session) { $("verify").disabled = false; return msg(`รหัสไม่ถูกต้องหรือหมดอายุ${error ? `: ${error.message}` : ""}`, "err"); }
    next(data.session.user.email);
  };
}
