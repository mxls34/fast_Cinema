// Runs the Major Cineplex scrape on Supabase right now (it also runs by itself every 6 hours).
// usage: npm run major -- 3        (number of days, 1-7, default 3)
import { callScraper } from "./env.mjs";

const days = Number(process.argv[2]) || 3;
console.log(`Scraping Major Cineplex for ${days} day(s)...`);
const r = await callScraper({ action: "major", days });
console.log(`done: ${r.movies} movies, ${r.theaters} theaters, ${r.showtimes} showtimes (${r.requests} requests, ${r.failed} failed)`);
