// Tiny static server for the web/ folder (no install needed):  node web/server.mjs   ->  http://localhost:5500
// Keeps ?id=... in links and serves index.html at "/" (npx serve's clean URLs drop the query string).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT) || 5500;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT) || file.endsWith(".mjs")) { res.writeHead(404).end("not found"); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" }).end(body);
    console.log(200, req.url);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
    console.log(404, req.url);
  }
}).listen(PORT, () => console.log(`Fast Cinema: http://localhost:${PORT}  (Ctrl+C to stop)`));
