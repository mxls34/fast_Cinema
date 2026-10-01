-- runs every 6 hours (00:07, 06:07, 12:07, 18:07 UTC); token is read at run time, never stored in the job text
select cron.unschedule(jobid) from cron.job where jobname = 'scrape-major-every-6h';
select cron.schedule('scrape-major-every-6h', '7 */6 * * *', $$
  select net.http_post(
    url := 'https://jjuvwfbzmpkwzjknhdwu.supabase.co/functions/v1/scrape-cinemas',
    headers := jsonb_build_object('Content-Type','application/json','x-ingest-token',(select value from public.app_config where key='ingest_token')),
    body := '{"action":"major","days":3}'::jsonb,
    timeout_milliseconds := 150000);
$$);
-- keep the showtimes table lean: drop past showtimes older than 3 days that nobody booked
select cron.unschedule(jobid) from cron.job where jobname = 'prune-old-showtimes';
select cron.schedule('prune-old-showtimes', '30 20 * * *', $$
  delete from public.showtimes st where st.start_time < now() - interval '3 days'
  and not exists (select 1 from public.bookings b where b.showtime_id = st.showtime_id);
$$);
