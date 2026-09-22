-- Durable rate limiting for /api/check-email
--
-- The Vercel function runs on many instances, so an in-memory counter only
-- bounds abuse per instance. This moves the counter into Postgres so the limit
-- holds globally.
--
-- Run this once in the Supabase SQL Editor for project morosdhhoznicppmrqyr.
-- It is safe to re-run.

create table if not exists public.rate_limits (
    key          text primary key,
    hits         integer     not null default 0,
    window_start timestamptz not null default now()
);

-- No policies are defined, so RLS denies all direct access. Only the
-- SECURITY DEFINER function below can touch this table.
alter table public.rate_limits enable row level security;

-- Returns true when the request is allowed, false when it is over the limit.
-- The INSERT ... ON CONFLICT is a single atomic statement, so concurrent
-- requests cannot race past the limit.
create or replace function public.check_rate_limit(
    p_key            text,
    p_max            integer,
    p_window_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_hits   integer;
    v_cutoff timestamptz := now() - make_interval(secs => p_window_seconds);
begin
    insert into public.rate_limits as r (key, hits, window_start)
    values (p_key, 1, now())
    on conflict (key) do update
        set hits = case when r.window_start < v_cutoff then 1 else r.hits + 1 end,
            window_start = case when r.window_start < v_cutoff then now() else r.window_start end
    returning r.hits into v_hits;

    -- Opportunistic cleanup so the table does not grow without bound. Runs on
    -- roughly 1% of calls rather than on every request.
    if random() < 0.01 then
        delete from public.rate_limits where window_start < now() - interval '1 day';
    end if;

    return v_hits <= p_max;
end;
$$;

-- Only the server-side service role may call this. The anon key is public in
-- the page source, so it must not be able to reach the limiter.
revoke all on function public.check_rate_limit(text, integer, integer)
    from public, anon, authenticated;

grant execute on function public.check_rate_limit(text, integer, integer)
    to service_role;
