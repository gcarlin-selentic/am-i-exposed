-- Daily counters for how the checker is used.
--
-- Run this once in the Supabase SQL Editor for project morosdhhoznicppmrqyr.
-- It is safe to re-run.
--
-- What this table is for, and what it deliberately cannot do: it answers how
-- many checks happened on a day, in which language, of which kind, and how
-- they turned out. It cannot answer who, because nothing identifying is
-- written. There is no address, no password, no IP, no account id and no
-- row per visit, so no individual's behaviour can be reconstructed from it.
-- That is not a side effect of the design, it is the design: the privacy
-- policy promises a checked address is not stored, and a per-visit log would
-- make that untrue even without the address in it.

create table if not exists public.checks_daily (
    fecha      date not null default (now() at time zone 'America/Lima')::date,
    idioma     text not null check (idioma in ('es', 'en')),
    tipo       text not null check (tipo in ('correo', 'contrasena')),
    resultado  text not null check (resultado in ('expuesto', 'limpio')),
    -- Never null: Postgres treats nulls as distinct in a unique constraint, so
    -- a null origin would make a new row on every single check instead of
    -- adding to one. Unknown origin is the string 'desconocido'.
    origen     text not null default 'desconocido',
    total      bigint not null default 0,
    primary key (fecha, idioma, tipo, resultado, origen)
);

-- The day is Lima's, not UTC. A check at 20:00 in Lima belongs to that day,
-- and under UTC it would be filed under the next one, which would make every
-- daily figure wrong by an evening.
comment on column public.checks_daily.fecha is 'Calendar day in America/Lima';

-- No policies are defined, so RLS denies all direct access. Only the
-- SECURITY DEFINER function below can touch this table, and only the server
-- can call it: the anon key cannot reach either.
alter table public.checks_daily enable row level security;

-- One atomic statement, so concurrent checks cannot lose a count between a
-- read and a write.
create or replace function public.record_check(
    p_idioma    text,
    p_tipo      text,
    p_resultado text,
    p_origen    text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.checks_daily as c (fecha, idioma, tipo, resultado, origen, total)
    values (
        (now() at time zone 'America/Lima')::date,
        p_idioma,
        p_tipo,
        p_resultado,
        -- Bounded here as well as in the application, because this function is
        -- the last thing standing between a caller and the table.
        coalesce(nullif(left(trim(p_origen), 50), ''), 'desconocido'),
        1
    )
    on conflict (fecha, idioma, tipo, resultado, origen) do update
        set total = c.total + 1;
end;
$$;

revoke all on function public.record_check(text, text, text, text) from public, anon, authenticated;
