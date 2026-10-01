-- Schema from the "DataBase Schema" slide, plus a few columns the app needs (marked "extra")
create table public.theaters (
  theater_id   serial primary key,
  name         varchar not null,
  city         varchar,
  brand        varchar not null check (brand in ('major','sf')),  -- extra: which chain
  source_url   text,                                               -- extra
  unique (brand, name)
);

create table public.screens (
  screen_id    serial primary key,
  theater_id   int not null references public.theaters(theater_id) on delete cascade,
  name         varchar not null,
  unique (theater_id, name)
);

create table public.seats (
  seat_id      serial primary key,
  screen_id    int not null references public.screens(screen_id) on delete cascade,
  seat_number  varchar not null,
  seat_type    varchar not null default 'Normal',   -- extra
  price        numeric(10,2) not null default 260,  -- extra
  unique (screen_id, seat_number)
);

create table public.movies (
  movie_id     serial primary key,
  title        varchar not null unique,
  duration     int,
  poster_url   text,          -- extra
  genre        varchar,       -- extra
  release_date date,          -- extra
  rating       varchar,       -- extra (e.g. ทั่วไป, 13+)
  major_url    text,          -- extra: source page on majorcineplex.com
  sf_url       text,          -- extra: source page on sfcinema.com
  updated_at   timestamptz not null default now()
);

create table public.showtimes (
  showtime_id  serial primary key,
  movie_id     int not null references public.movies(movie_id) on delete cascade,
  screen_id    int not null references public.screens(screen_id) on delete cascade,
  start_time   timestamptz not null,
  language     varchar default 'TH/--',  -- extra
  unique (screen_id, start_time)
);

create table public.bookings (
  booking_id    serial primary key,
  showtime_id   int not null references public.showtimes(showtime_id) on delete cascade,
  booking_token varchar not null unique default encode(gen_random_bytes(8),'hex'),
  email         varchar,                       -- extra
  is_demo       boolean not null default false,-- extra: seeded sample data for the dashboard
  created_at    timestamptz not null default now()
);

create table public.booking_seats (
  booking_id   int not null references public.bookings(booking_id) on delete cascade,
  seat_id      int not null references public.seats(seat_id) on delete cascade,
  showtime_id  int not null references public.showtimes(showtime_id) on delete cascade, -- extra: blocks double booking
  primary key (booking_id, seat_id),
  unique (showtime_id, seat_id)
);

create table public.payments (
  payments_id  serial primary key,
  booking_id   int not null references public.bookings(booking_id) on delete cascade,
  amount       numeric(10,2) not null,
  status       varchar not null default 'paid',
  method       varchar,                     -- extra: credit_card / qr_code
  created_at   timestamptz not null default now()
);

create table public.scrape_runs (            -- extra: log of each scrape
  run_id serial primary key,
  started_at timestamptz default now(),
  source varchar, movies int, theaters int, note text
);

-- Row level security: the public site can read the catalogue, but writes go through functions only
alter table public.theaters      enable row level security;
alter table public.screens       enable row level security;
alter table public.seats         enable row level security;
alter table public.movies        enable row level security;
alter table public.showtimes     enable row level security;
alter table public.bookings      enable row level security;
alter table public.booking_seats enable row level security;
alter table public.payments      enable row level security;
alter table public.scrape_runs   enable row level security;

create policy read_theaters  on public.theaters  for select using (true);
create policy read_screens   on public.screens   for select using (true);
create policy read_seats     on public.seats     for select using (true);
create policy read_movies    on public.movies    for select using (true);
create policy read_showtimes on public.showtimes for select using (true);

-- Seats already taken for a showtime
create or replace function public.booked_seats(p_showtime_id int)
returns setof int language sql stable security definer set search_path = public as $$
  select seat_id from booking_seats where showtime_id = p_showtime_id;
$$;

-- Create booking + seats + payment atomically
create or replace function public.create_booking(p_showtime_id int, p_seat_ids int[], p_email text, p_method text)
returns table(booking_id int, booking_token varchar, amount numeric)
language plpgsql security definer set search_path = public as $$
declare v_id int; v_token varchar; v_amount numeric;
begin
  if coalesce(array_length(p_seat_ids,1),0) = 0 then raise exception 'no seats selected'; end if;
  if p_email is null or p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid email'; end if;
  if exists (select 1 from seats s join showtimes t on t.screen_id = s.screen_id
             where s.seat_id = any(p_seat_ids) and t.showtime_id = p_showtime_id) is false
     or (select count(*) from seats s join showtimes t on t.screen_id = s.screen_id
         where s.seat_id = any(p_seat_ids) and t.showtime_id = p_showtime_id) <> array_length(p_seat_ids,1)
  then raise exception 'seat does not belong to this showtime'; end if;

  insert into bookings(showtime_id, email) values (p_showtime_id, p_email)
    returning bookings.booking_id, bookings.booking_token into v_id, v_token;
  begin
    insert into booking_seats(booking_id, seat_id, showtime_id)
      select v_id, unnest(p_seat_ids), p_showtime_id;
  exception when unique_violation then
    raise exception 'seat already booked';
  end;
  select sum(price) into v_amount from seats where seat_id = any(p_seat_ids);
  insert into payments(booking_id, amount, status, method) values (v_id, v_amount, 'paid', p_method);
  return query select v_id, v_token, v_amount;
end $$;

-- Monthly viewers per chain for the dashboard (one viewer = one booked seat)
create or replace function public.monthly_viewers(p_year int default extract(year from now())::int, p_include_demo boolean default true)
returns table(month int, brand varchar, viewers bigint)
language sql stable security definer set search_path = public as $$
  select extract(month from b.created_at at time zone 'Asia/Bangkok')::int, th.brand, count(*)
  from booking_seats bs
  join bookings b   on b.booking_id = bs.booking_id
  join showtimes st on st.showtime_id = b.showtime_id
  join screens sc   on sc.screen_id = st.screen_id
  join theaters th  on th.theater_id = sc.theater_id
  where extract(year from b.created_at at time zone 'Asia/Bangkok') = p_year
    and (p_include_demo or not b.is_demo)
  group by 1,2 order by 1,2;
$$;

create or replace function public.dashboard_summary()
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'movies', (select count(*) from movies),
    'theaters_major', (select count(*) from theaters where brand='major'),
    'theaters_sf', (select count(*) from theaters where brand='sf'),
    'showtimes_upcoming', (select count(*) from showtimes where start_time > now()),
    'bookings_real', (select count(*) from bookings where not is_demo),
    'revenue_real', (select coalesce(sum(p.amount),0) from payments p join bookings b using(booking_id) where not b.is_demo),
    'last_scrape', (select max(started_at) from scrape_runs)
  );
$$;

grant execute on function public.booked_seats(int) to anon, authenticated;
grant execute on function public.create_booking(int,int[],text,text) to anon, authenticated;
grant execute on function public.monthly_viewers(int,boolean) to anon, authenticated;
grant execute on function public.dashboard_summary() to anon, authenticated;
