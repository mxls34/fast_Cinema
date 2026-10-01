// Edge Function: send-ticket
// Called by the website right after a successful booking, with the signed-in user's token.
// Sends the e-coupon by email through Resend when RESEND_API_KEY (+ TICKET_FROM) secrets are set.
// Without them it returns {sent:false} and the site shows the ticket on screen instead.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const { token } = await req.json().catch(() => ({}));
  if (!token) return json({ error: "missing token" }, 400);

  // run as the caller, so booking_details only returns their own booking
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } }, auth: { persistSession: false },
  });
  const { data: b, error } = await sb.rpc("booking_details", { p_token: token });
  if (error || !b) return json({ error: "booking not found" }, 404);

  const key = Deno.env.get("RESEND_API_KEY"), from = Deno.env.get("TICKET_FROM");
  if (!key || !from) return json({ sent: false, reason: "email provider not configured", booking: b });

  const when = new Date(b.start_time).toLocaleString("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "full", timeStyle: "short" });
  const html = `<div style="font-family:sans-serif;max-width:480px">
    <h2 style="margin:0 0 8px">ตั๋วภาพยนตร์ของคุณ</h2>
    <p style="margin:0 0 16px;color:#555">แสดงรหัสนี้ที่จุดรับบัตรของโรงภาพยนตร์</p>
    <div style="font-size:28px;font-weight:700;letter-spacing:3px;padding:12px;border:2px dashed #c79a4a;text-align:center">${esc(b.token).toUpperCase()}</div>
    <table style="margin-top:16px;font-size:15px;line-height:1.6">
      <tr><td style="color:#777;padding-right:12px">ภาพยนตร์</td><td><b>${esc(b.movie)}</b></td></tr>
      <tr><td style="color:#777">โรง</td><td>${esc(b.theater)} · ${esc(b.screen)}</td></tr>
      <tr><td style="color:#777">รอบฉาย</td><td>${esc(when)}</td></tr>
      <tr><td style="color:#777">ที่นั่ง</td><td>${esc((b.seats ?? []).join(", "))}</td></tr>
      <tr><td style="color:#777">ยอดชำระ</td><td>฿${esc(b.amount)}</td></tr>
    </table></div>`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [b.email], subject: `ตั๋วหนัง ${b.movie} · ${b.token.toUpperCase()}`, html }),
  });
  return json({ sent: r.ok, booking: b, ...(r.ok ? {} : { reason: await r.text() }) });
});
