import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSf, toIso } from "./sf-parse.mjs";

test("toIso treats times without offset as Bangkok", () => {
  assert.equal(toIso("2026-10-01 20:30"), "2026-10-01T13:30:00.000Z");
  assert.equal(toIso("20:30", "2026-10-01"), "2026-10-01T13:30:00.000Z");
  assert.equal(toIso("2026-10-01T13:30:00Z"), "2026-10-01T13:30:00.000Z");
  assert.equal(toIso("20:30"), null);
});

test("nested cinema -> movie -> sessions", () => {
  const body = {
    data: [{
      cinema_name: "เอส เอฟ เวิลด์ ซีนีม่า เซ็นทรัลเวิลด์", province: "กรุงเทพฯ",
      movies: [{
        movie_name: "Minions", poster_url: "https://cdn.example.com/m.jpg", duration: "124 min",
        screens: [{ screen_name: "Cinema 5", sessions: [{ id: 99, show_time: "2026-10-01 11:30", language: "TH" }] }],
      }],
    }],
  };
  const r = parseSf([{ url: "x", pageUrl: "https://www.sfcinema.com/th/movie/minions", body }]);
  assert.equal(r.movies.length, 1);
  assert.equal(r.movies[0].duration, 124);
  assert.deepEqual(r.showtimes, [{
    movie_title: "Minions", theater: "เอส เอฟ เวิลด์ ซีนีม่า เซ็นทรัลเวิลด์", city: "กรุงเทพฯ", screen: "Cinema 5",
    start_time: "2026-10-01T04:30:00.000Z", language: "TH", source_showtime_id: "99",
  }]);
});

test("time list with a date on the parent, deduplicated", () => {
  const body = { title: "Joker", cinema: { name: "SF Hua Hin" }, date: "2026-10-02", screen: 1, time: ["11:30", "16:20", "11:30"] };
  const r = parseSf([{ url: "x", body }, { url: "y", body }]);
  assert.equal(r.showtimes.length, 2);
  assert.equal(r.showtimes[0].screen, "Theatre 1");
});

test("real SF content endpoint: now_showing only, titles match Major spelling", () => {
  const body = { success: true, data: [
    { id: "f181827e", type: "now_showing", title: "ธี่หยด: สมิงเขาขวาง", genre: "Action, Horror", rating: "15+", releaseDate: "2026-09-30",
      contentLength: 110, media: { portrait: "https://media.sfcinema.com/public/p.jpg" } },
    { id: "x2", type: "coming_soon", title: "Later", contentLength: 90, media: {} },
  ] };
  const r = parseSf([{ url: "https://onl.sfcinema.com/ticket/data/content?locale=th&channel=WEB", body }], { movieUrl: "https://www.sfcinema.com/th/movie/{id}" });
  assert.deepEqual(r.movies, [{
    title: "ธี่หยด สมิงเขาขวาง", duration: 110, poster_url: "https://media.sfcinema.com/public/p.jpg", genre: "Action, Horror",
    release_date: "2026-09-30", rating: "15+", url: "https://www.sfcinema.com/th/movie/f181827e",
  }]);
  assert.equal(r.showtimes.length, 0);
});

test("showtime page: movie title comes from the page URL when the data lacks it", () => {
  const content = { url: "https://onl.sfcinema.com/ticket/data/content?locale=th", body: { data: [
    { id: "65faef2c-75e1-4aa2-8459-143c97bd970a", type: "now_showing", title: "เครยอนชินจัง", media: {} }] } };
  const shows = { url: "https://onl.sfcinema.com/ticket/data/showtime?x", pageUrl: "https://www.sfcinema.com/th/showtime/65faef2c-75e1-4aa2-8459-143c97bd970a",
    body: { data: [{ branchName: "เอส เอฟ เวิลด์ ซีเนม่า เซ็นทรัลเวิลด์", sessions: [{ screenName: "Cinema 5", showTime: "2026-10-02T15:40:00" }] }] } };
  const r = parseSf([content, shows]);
  assert.equal(r.showtimes.length, 1);
  assert.equal(r.showtimes[0].movie_title, "เครยอนชินจัง");
  assert.equal(r.showtimes[0].theater, "เอส เอฟ เวิลด์ ซีเนม่า เซ็นทรัลเวิลด์");
  assert.equal(r.showtimes[0].start_time, "2026-10-02T08:40:00.000Z");
});
