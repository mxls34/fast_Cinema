-- movies with upcoming showtimes, flagged per chain
create or replace function now_showing()
returns table(movie_id int, title varchar, duration int, poster_url text, genre varchar, release_date date,
              has_major boolean, has_sf boolean, next_show timestamptz)
language sql stable security definer set search_path = public as $$
  select m.movie_id, m.title, m.duration, m.poster_url, m.genre, m.release_date,
         bool_or(th.brand = 'major'), bool_or(th.brand = 'sf'), min(st.start_time)
  from movies m join showtimes st using(movie_id) join screens sc using(screen_id) join theaters th using(theater_id)
  where st.start_time > now()
  group by m.movie_id order by count(*) desc;
$$;

-- one movie's showtimes for a chain on a Bangkok calendar date
create or replace function movie_showtimes(p_movie_id int, p_brand text, p_date date)
returns table(showtime_id int, theater_id int, theater varchar, city varchar, screen varchar, start_time timestamptz, language varchar)
language sql stable security definer set search_path = public as $$
  select st.showtime_id, th.theater_id, th.name, th.city, sc.name, st.start_time, st.language
  from showtimes st join screens sc using(screen_id) join theaters th using(theater_id)
  where st.movie_id = p_movie_id and th.brand = p_brand and st.start_time > now()
    and (st.start_time at time zone 'Asia/Bangkok')::date = p_date
  order by th.name, st.start_time;
$$;

-- which upcoming dates have shows (for the date strip)
create or replace function movie_dates(p_movie_id int, p_brand text)
returns table(show_date date, shows bigint)
language sql stable security definer set search_path = public as $$
  select (st.start_time at time zone 'Asia/Bangkok')::date, count(*)
  from showtimes st join screens sc using(screen_id) join theaters th using(theater_id)
  where st.movie_id = p_movie_id and th.brand = p_brand and st.start_time > now()
  group by 1 order by 1;
$$;

grant execute on function now_showing(), movie_showtimes(int,text,date), movie_dates(int,text) to anon, authenticated;
