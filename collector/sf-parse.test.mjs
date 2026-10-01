import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSf, toIso } from "./sf-parse.mjs";

// trimmed copies of real sfcinema.com responses
const content = {
  url: "https://onl.sfcinema.com/ticket/data/content?locale=th&channel=WEB",
  body: { data: [
    { id: "e64cabc5-eb6f-402b-b649-24d033aa2dea", type: "now_showing", title: "ธี่หยด: สมิงเขาขวาง", genre: "Action, Horror", rating: "15+",
      releaseDate: "2026-09-30", contentLength: 110, media: { portrait: "https://media.sfcinema.com/public/p.jpg" } },
    { id: "x2", type: "coming_soon", title: "Later", contentLength: 90, media: {} },
  ] },
};
const branch = {
  url: "https://onl.sfcinema.com/ticket/data/branch?locale=th&channel=WEB&spceialScreenId=&seatCateId=&branch=",
  body: { data: [
    { id: "T21", name: "เอส เอฟ ซีเนม่า เทอร์มินอล 21 อโศก", regionId: "33821cf0-af36-47cf-971c-fc0c376d51b8" },
    { id: "CMA", name: "เอส เอฟ เอ็กซ์ ซีเนม่า เมญ่า เชียงใหม่", regionId: "d9bbe26f-21ff-418e-8d6b-7c35028039be" },
  ] },
};
const session = (id, sessionDatetime, extra = {}) => ({
  id, branchId: "T21", screenNumber: 7, screenName: "Cinema 7", contentId: "e64cabc5-eb6f-402b-b649-24d033aa2dea",
  audio: "EN", subtitles: ["TH"], sessionDatetime, status: "A", ...extra,
});
const sessions = {
  url: "https://onl.sfcinema.com/ticket/data/session?locale=th&contentId=e64cabc5-eb6f-402b-b649-24d033aa2dea&branch=&special=&channel=WEB",
  body: { data: [
    session("a", "2026-10-01T10:35:00"),                       // already started at "now"
    session("b", "2026-10-01T20:00:00"),
    session("b", "2026-10-01T20:00:00"),                       // duplicate
    session("c", "2026-10-03T23:30:00"),                       // last day in a 3-day window
    session("d", "2026-10-04T10:00:00"),                       // outside the window
    session("e", "2026-10-01T21:00:00", { branchId: "XXX" }),  // unknown branch
    session("f", "2026-10-01T21:00:00", { status: "C" }),      // not active
  ] },
};
const now = new Date("2026-10-01T05:00:00Z"); // 12:00 in Bangkok

test("toIso treats times without offset as Bangkok", () => {
  assert.equal(toIso("2026-10-01T20:30:00"), "2026-10-01T13:30:00.000Z");
  assert.equal(toIso("2026-10-01 20:30"), "2026-10-01T13:30:00.000Z");
  assert.equal(toIso("2026-10-01T13:30:00Z"), "2026-10-01T13:30:00.000Z");
  assert.equal(toIso("20:30"), null);
});

test("movies: now_showing only, titles match Major spelling", () => {
  const r = parseSf([content], { movieUrl: "https://www.sfcinema.com/th/showtime/{id}" });
  assert.deepEqual(r.movies, [{
    title: "ธี่หยด สมิงเขาขวาง", duration: 110, poster_url: "https://media.sfcinema.com/public/p.jpg", genre: "Action, Horror",
    release_date: "2026-09-30", rating: "15+", url: "https://www.sfcinema.com/th/showtime/e64cabc5-eb6f-402b-b649-24d033aa2dea",
  }]);
});

test("theaters: every branch with its region as city", () => {
  const r = parseSf([content, branch]);
  assert.deepEqual(r.theaters, [
    { name: "เอส เอฟ ซีเนม่า เทอร์มินอล 21 อโศก", city: "กรุงเทพและปริมณฑล" },
    { name: "เอส เอฟ เอ็กซ์ ซีเนม่า เมญ่า เชียงใหม่", city: "ภาคเหนือ" },
  ]);
});

test("showtimes: upcoming, active, known branch, inside the day window, no duplicates", () => {
  const r = parseSf([content, branch, sessions], { days: 3, now });
  assert.deepEqual(r.showtimes.map((s) => s.source_showtime_id), ["b", "c"]);
  assert.deepEqual(r.showtimes[0], {
    movie_title: "ธี่หยด สมิงเขาขวาง", theater: "เอส เอฟ ซีเนม่า เทอร์มินอล 21 อโศก", city: "กรุงเทพและปริมณฑล",
    screen: "Cinema 7", start_time: "2026-10-01T13:00:00.000Z", language: "EN/TH", source_showtime_id: "b",
  });
});
