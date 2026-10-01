import { rpc, esc } from "./api.js";

const REFRESH_MS = 60_000;
const HOUR = 3600_000;
const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat("th-TH");
const BRANDS = [{ key: "major", name: "Major" }, { key: "sf", name: "SF" }];

const fmtTime = (iso) => new Date(iso).toLocaleString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
function ago(iso, now) {
  const min = Math.round((now - new Date(iso)) / 60_000);
  if (min < 1) return "เมื่อสักครู่";
  if (min < 60) return `${min} นาทีที่แล้ว`;
  if (min < 48 * 60) return `${Math.round(min / 60)} ชั่วโมงที่แล้ว`;
  return `${Math.round(min / 1440)} วันที่แล้ว`;
}

// Major runs by itself every 6 hours; SF is collected by hand from a browser, so it is allowed to be older.
const RULES = {
  major: { good: 7 * HOUR, warn: 13 * HOUR, how: "ดึงอัตโนมัติทุก 6 ชั่วโมงบน Supabase (pg_cron)", fix: "npm run major" },
  sf: { good: 24 * HOUR, warn: 72 * HOUR, how: "ดึงจากเบราว์เซอร์ในเครื่องของคุณ (Cloudflare บล็อกเซิร์ฟเวอร์)", fix: "npm run sf" },
};
const LEVEL = { good: "✓ ปกติ", warning: "! ต้องดู", critical: "✕ มีปัญหา" };

function health(key, r, now) {
  const rule = RULES[key];
  const latest = r.latest.find((x) => x.source === key);
  const lastOk = r.last_ok[key];
  const upcoming = r.totals[`showtimes_${key}`];
  let level, msg;
  if (!latest) { level = key === "sf" ? "warning" : "critical"; msg = "ยังไม่เคยดึงข้อมูล"; }
  else if (latest.status === "error") { level = "critical"; msg = `รอบล่าสุดล้มเหลว (${ago(latest.started_at, now)}): ${latest.note ?? ""}`; }
  else {
    const age = now - new Date(lastOk);
    level = age <= rule.good ? "good" : age <= rule.warn ? "warning" : "critical";
    msg = `ดึงสำเร็จล่าสุด ${ago(lastOk, now)} · ${nf.format(latest.movies ?? 0)} หนัง · ${nf.format(latest.theaters ?? 0)} โรง · ${nf.format(latest.showtimes ?? 0)} รอบ`;
    if (latest.status === "partial") { level = level === "good" ? "warning" : level; msg += ` · บางคำขอล้มเหลว (${latest.note})`; }
  }
  if (!upcoming && level === "good") level = "warning";
  const fix = level === "good" ? "" : ` · แก้ไข: รัน <code>${rule.fix}</code> ในโฟลเดอร์ collector`;
  return `
    <div class="source">
      <span class="badge ${level}">${LEVEL[level]}</span>
      <strong>${key === "major" ? "Major Cineplex" : "SF Cinema"} · รอบฉายที่จะถึง ${nf.format(upcoming)}</strong>
      <p>${esc(msg)}<br>${esc(rule.how)}${fix}</p>
    </div>`;
}

function tiles(t) {
  const tile = (label, value, sub = "") => `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  return [
    tile("หนังที่มีรอบฉาย", nf.format(t.movies_showing), `ทั้งหมดในฐานข้อมูล ${nf.format(t.movies)}`),
    tile("โรงภาพยนตร์", nf.format(t.theaters_major + t.theaters_sf), `Major ${nf.format(t.theaters_major)} · SF ${nf.format(t.theaters_sf)}`),
    tile("การจองจริง", nf.format(t.bookings_real), "ไม่นับข้อมูลตัวอย่าง"),
    tile("รายได้", `฿${nf.format(t.revenue_real)}`, "จากการจองจริง"),
  ].join("");
}

// Grouped bar chart, one group per category, Major and SF side by side, one y-axis.
function bars(el, categories, valueOf, emptyText) {
  const W = 340, H = 170, L = 34, R = 4, T = 8, B = 22;
  const max = Math.max(0, ...categories.flatMap((c) => BRANDS.map((b) => valueOf(c, b.key))));
  if (!categories.length || !max) {
    el.innerHTML = `<svg viewBox="0 0 ${W} 60" role="img" aria-label="${esc(emptyText)}"><text class="empty" x="${W / 2}" y="34" text-anchor="middle">${esc(emptyText)}</text></svg>`;
    return;
  }
  const step = 10 ** Math.floor(Math.log10(max));
  const top = Math.ceil(max / step) * step;
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const groupW = (W - L - R) / categories.length;
  const barW = Math.min(18, (groupW - 10) / 2);
  const ticks = [0, top / 2, top];
  let svg = ticks.map((v) => `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${nf.format(v)}</text>`).join("");
  categories.forEach((c, i) => {
    const cx = L + groupW * i + groupW / 2;
    svg += `<text class="axis" x="${cx}" y="${H - 6}" text-anchor="middle">${esc(c.label)}</text>`;
    BRANDS.forEach((b, j) => {
      const v = valueOf(c, b.key);
      const x = cx - barW - 1 + j * (barW + 2);
      const tip = `${c.full ?? c.label} · ${b.name}: ${nf.format(v)}`;
      svg += `<rect class="hit" x="${x - 1}" y="${T}" width="${barW + 2}" height="${H - T - B}" data-tip="${esc(tip)}"/>`;
      if (v > 0) {
        const yt = y(v), yb = y(0), r = Math.min(4, barW / 2, yb - yt);
        svg += `<path class="bar ${b.key}" data-tip="${esc(tip)}" d="M${x},${yb} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x + barW - r} Q${x + barW},${yt} ${x + barW},${yt + r} V${yb} Z"/>`;
      }
    });
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img">${svg}</svg>`;
}

const tip = $("tip");
document.addEventListener("pointermove", (e) => {
  const t = e.target.closest?.("[data-tip]");
  if (!t) { tip.hidden = true; return; }
  tip.textContent = t.dataset.tip;
  tip.hidden = false;
  tip.style.left = `${Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8)}px`;
  tip.style.top = `${e.clientY - 36}px`;
});

async function load() {
  try {
    const [r, viewers] = await Promise.all([rpc("scrape_report"), rpc("monthly_viewers", { p_year: new Date().getFullYear(), p_include_demo: false })]);
    const now = new Date(r.now);
    $("health").innerHTML = BRANDS.map((b) => health(b.key, r, now)).join("");
    $("tiles").innerHTML = tiles(r.totals);

    const days = [...new Set(r.coverage.map((c) => c.day))].map((d) => ({
      key: d,
      label: new Date(`${d}T00:00:00+07:00`).toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok", weekday: "short", day: "numeric" }),
      full: new Date(`${d}T00:00:00+07:00`).toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "medium" }),
    }));
    bars($("coverage"), days, (c, b) => r.coverage.find((x) => x.day === c.key && x.brand === b)?.showtimes ?? 0, "ยังไม่มีรอบฉายที่จะถึง");

    const months = [...new Set(viewers.map((v) => v.month))].sort((a, b) => a - b).map((m) => ({
      key: m, label: new Date(2000, m - 1).toLocaleDateString("th-TH", { month: "short" }),
    }));
    bars($("viewers"), months, (c, b) => viewers.find((v) => v.month === c.key && v.brand === b)?.viewers ?? 0, "ยังไม่มีการจองในปีนี้");

    $("runs").innerHTML = r.runs.map((x) => `
      <tr>
        <td class="when">${fmtTime(x.started_at)}</td>
        <td>${x.source === "major" ? "Major" : "SF"}</td>
        <td><span class="badge ${x.status === "ok" ? "good" : x.status === "partial" ? "warning" : "critical"}">${esc(x.status)}</span></td>
        <td class="num">${x.movies ?? "–"}</td><td class="num">${x.theaters ?? "–"}</td><td class="num">${x.showtimes != null ? nf.format(x.showtimes) : "–"}</td>
        <td class="note">${esc(x.note ?? "")}</td>
      </tr>`).join("") || `<tr><td colspan="7">ยังไม่มีประวัติ</td></tr>`;
    $("updated").textContent = `อัปเดต ${now.toLocaleTimeString("th-TH", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" })}`;
  } catch (e) {
    console.error(e);
    $("health").innerHTML = `<div class="source"><span class="badge critical">${LEVEL.critical}</span><strong>เชื่อมต่อ Supabase ไม่ได้</strong><p>${esc(e.message)}</p></div>`;
  }
}

load();
setInterval(load, REFRESH_MS);
