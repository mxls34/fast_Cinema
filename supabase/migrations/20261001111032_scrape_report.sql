-- Everything the hidden monitoring report (hold the Home button for 1 minute) needs, in one call.
create or replace function public.scrape_report()
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'now', now(),
    'latest', (select coalesce(json_agg(l), '[]') from (
        select distinct on (source) source, started_at, finished_at, status, movies, theaters, showtimes, note
        from scrape_runs order by source, started_at desc) l),
    'last_ok', (select coalesce(json_object_agg(source, at), '{}') from (
        select source, max(started_at) at from scrape_runs where status in ('ok','partial') group by source) o),
    'runs', (select coalesce(json_agg(r), '[]') from (
        select run_id, source, status, started_at, finished_at, movies, theaters, showtimes, note
        from scrape_runs order by started_at desc limit 20) r),
    'coverage', (select coalesce(json_agg(c order by c.day, c.brand), '[]') from (
        select (st.start_time at time zone 'Asia/Bangkok')::date as day, th.brand, count(*) as showtimes
        from showtimes st join screens sc using (screen_id) join theaters th using (theater_id)
        where st.start_time > now() and st.start_time < now() + interval '7 days'
        group by 1, 2) c),
    'totals', json_build_object(
        'movies', (select count(*) from movies),
        'movies_showing', (select count(distinct movie_id) from showtimes where start_time > now()),
        'theaters_major', (select count(*) from theaters where brand = 'major'),
        'theaters_sf', (select count(*) from theaters where brand = 'sf'),
        'screens', (select count(*) from screens),
        'showtimes_major', (select count(*) from showtimes st join screens sc using (screen_id) join theaters th using (theater_id)
                            where th.brand = 'major' and st.start_time > now()),
        'showtimes_sf', (select count(*) from showtimes st join screens sc using (screen_id) join theaters th using (theater_id)
                         where th.brand = 'sf' and st.start_time > now()),
        'bookings_real', (select count(*) from bookings where not is_demo),
        'revenue_real', (select coalesce(sum(p.amount), 0) from payments p join bookings b using (booking_id) where not b.is_demo))
  );
$$;

grant execute on function public.scrape_report() to anon, authenticated;
