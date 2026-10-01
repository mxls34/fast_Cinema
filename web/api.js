// Supabase connection used by every page. The publishable key is safe in the browser:
// tables are read-only through RLS and writes only happen inside the database functions.
export const SUPABASE_URL = "https://jjuvwfbzmpkwzjknhdwu.supabase.co";
export const SUPABASE_KEY = "sb_publishable_Wr329s9gaGjUu1KnqTPkKg_UCZ1TB_D";

export async function rpc(name, params = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`${name}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
