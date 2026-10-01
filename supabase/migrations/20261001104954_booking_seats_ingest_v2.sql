-- external ids from source sites
alter table movies    add column if not exists major_movie_id int unique;
alter table showtimes add column if not exists source_showtime_id text;
alter table scrape_runs add column if not exists status varchar default 'ok';
alter table scrape_runs add column if not exists showtimes int;
alter table scrape_runs add column if not exists finished_at timestamptz;
create index if not exists showtimes_movie_start_idx on showtimes(movie_id, start_time);

-- private config (no RLS policies => invisible to anon/authenticated)
create table if not exists app_config (key text primary key, value text not null);
alter table app_config enable row level security;
insert into app_config(key, value) values ('ingest_token', encode(extensions.gen_random_bytes(24),'hex'))
on conflict (key) do nothing;

-- seat layout from the mockup: J,I couple pairs (1,000) / H-D normal (260) / C premium (280) / B,A deluxe (290)
create or replace function ensure_seats(p_screen_id int) returns void
language plpgsql security definer set search_path = public as $$
declare r record; i int;
begin
  if exists (select 1 from seats where screen_id = p_screen_id) then return; end if;
  for r in select * from (values
      ('J',14,'Couple',1000),('I',14,'Couple',1000),('H',14,'Normal',260),('G',12,'Normal',260),
      ('F',12,'Normal',260),('E',12,'Normal',260),('D',12,'Normal',260),('C',14,'Premium',280),
      ('B',12,'Deluxe',290),('A',12,'Deluxe',290)) v(row_letter,n,kind,price)
  loop
    for i in 1..r.n loop
      insert into seats(screen_id, seat_number, seat_type, price)
      values (p_screen_id, r.row_letter || i, r.kind, r.price) on conflict do nothing;
    end loop;
  end loop;
end $$;

create or replace function get_seat_map(p_showtime_id int)
returns table(seat_id int, seat_number varchar, seat_type varchar, price numeric, booked boolean)
language plpgsql security definer set search_path = public as $$
declare v_screen int;
begin
  select screen_id into v_screen from showtimes where showtime_id = p_showtime_id;
  if v_screen is null then raise exception 'showtime not found'; end if;
  perform ensure_seats(v_screen);
  return query
    select s.seat_id, s.seat_number, s.seat_type, s.price,
           exists(select 1 from booking_seats bs where bs.showtime_id = p_showtime_id and bs.seat_id = s.seat_id)
    from seats s where s.screen_id = v_screen order by s.seat_number;
end $$;

-- booking: only for a signed-in user whose email was verified by OTP
create or replace function create_booking(p_showtime_id int, p_seat_ids int[], p_email text, p_method text)
returns table(booking_id int, booking_token varchar, amount numeric)
language plpgsql security definer set search_path = public as $$
declare v_id int; v_token varchar; v_amount numeric; v_n int := coalesce(array_length(p_seat_ids,1),0);
begin
  if auth.uid() is null then raise exception 'please verify your email first'; end if;
  if lower(coalesce(auth.jwt()->>'email','')) <> lower(coalesce(p_email,'')) then raise exception 'email does not match verified email'; end if;
  if v_n = 0 or v_n > 10 then raise exception 'select 1-10 seats'; end if;
  if p_method not in ('credit_card','qr_code') then raise exception 'invalid payment method'; end if;
  if not exists (select 1 from showtimes where showtime_id = p_showtime_id and start_time > now()) then
    raise exception 'this showtime has already started'; end if;
  if (select count(distinct s.seat_id) from seats s join showtimes t on t.screen_id = s.screen_id
      where s.seat_id = any(p_seat_ids) and t.showtime_id = p_showtime_id) <> v_n then
    raise exception 'seat does not belong to this showtime'; end if;

  insert into bookings(showtime_id, email) values (p_showtime_id, lower(p_email))
    returning bookings.booking_id, bookings.booking_token into v_id, v_token;
  begin
    insert into booking_seats(booking_id, seat_id, showtime_id) select v_id, unnest(p_seat_ids), p_showtime_id;
  exception when unique_violation then raise exception 'seat already booked'; end;
  select sum(price) into v_amount from seats where seat_id = any(p_seat_ids);
  insert into payments(booking_id, amount, status, method) values (v_id, v_amount, 'paid', p_method);
  return query select v_id, v_token, v_amount;
end $$;

-- booking details for the ticket email / success screen (own bookings only)
create or replace function booking_details(p_token text) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('token', b.booking_token, 'email', b.email, 'movie', m.title, 'poster', m.poster_url,
    'theater', th.name, 'brand', th.brand, 'screen', sc.name, 'start_time', st.start_time,
    'seats', (select array_agg(s.seat_number order by s.seat_number) from booking_seats bs join seats s using(seat_id) where bs.booking_id = b.booking_id),
    'amount', (select amount from payments p where p.booking_id = b.booking_id limit 1))
  from bookings b join showtimes st using(showtime_id) join movies m using(movie_id)
  join screens sc on sc.screen_id = st.screen_id join theaters th on th.theater_id = sc.theater_id
  where b.booking_token = p_token and (lower(b.email) = lower(auth.jwt()->>'email') or auth.role() = 'service_role');
$$;

create or replace function dashboard_summary() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'movies', (select count(*) from movies),
    'theaters_major', (select count(*) from theaters where brand='major'),
    'theaters_sf', (select count(*) from theaters where brand='sf'),
    'showtimes_upcoming', (select count(*) from showtimes where start_time > now()),
    'showtimes_major', (select count(*) from showtimes st join screens sc using(screen_id) join theaters th using(theater_id) where th.brand='major' and st.start_time > now()),
    'showtimes_sf', (select count(*) from showtimes st join screens sc using(screen_id) join theaters th using(theater_id) where th.brand='sf' and st.start_time > now()),
    'bookings_real', (select count(*) from bookings where not is_demo),
    'revenue_real', (select coalesce(sum(p.amount),0) from payments p join bookings b using(booking_id) where not b.is_demo),
    'last_scrape', (select max(started_at) from scrape_runs),
    'runs', (select coalesce(json_agg(r order by r.started_at desc),'[]') from (select run_id, started_at, finished_at, source, status, movies, theaters, showtimes, note from scrape_runs order by started_at desc limit 8) r)
  );
$$;

-- lock down execute rights
revoke execute on function ensure_seats(int) from public, anon, authenticated;
revoke execute on function create_booking(int,int[],text,text) from public, anon;
grant  execute on function create_booking(int,int[],text,text) to authenticated;
revoke execute on function booking_details(text) from public, anon;
grant  execute on function booking_details(text) to authenticated;
grant  execute on function get_seat_map(int) to anon, authenticated;
revoke execute on function rls_auto_enable() from public, anon, authenticated;
