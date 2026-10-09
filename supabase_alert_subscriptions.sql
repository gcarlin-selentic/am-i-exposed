-- Class action alert subscriptions
--
-- Deliberately not stored in public.purchases. That table models one payment
-- that buys 30 days of report access and is done; a subscription is a thing
-- with a status that keeps changing for months. Forcing one into the other
-- would have meant a status column that means two different things depending
-- on provider, which is how entitlement bugs happen.
--
-- Only the server (service_role) writes here. The Paddle webhook is the single
-- source of truth for whether somebody is actually subscribed; the browser can
-- read its own row and can never create or change one.
--
-- Run once in the Supabase SQL Editor. Safe to re-run.

create table if not exists public.alert_subscriptions (
    id            uuid primary key default gen_random_uuid(),
    user_id       uuid not null references auth.users(id) on delete cascade,
    email         text not null,

    -- Paddle's own status values, copied exactly. Translating them into our
    -- own vocabulary would mean maintaining a mapping that silently rots the
    -- next time Paddle adds a state.
    status        text not null
                  check (status in ('trialing', 'active', 'past_due', 'paused', 'canceled')),

    provider                 text not null default 'paddle',
    provider_subscription_id text unique,
    provider_customer_id     text,

    -- False for anything that came from the Paddle sandbox. Test and real
    -- subscriptions land in the same table, exactly as purchases.live_mode
    -- does, so without this a sandbox subscription would grant real alerts.
    live_mode     boolean not null default false,

    -- Collected at checkout. The state is the only one used for anything: some
    -- settlements pay residents of particular states an extra statutory
    -- amount, and that is what we flag.
    first_name    text,
    last_name     text,
    state         text,

    current_period_end timestamptz,
    canceled_at        timestamptz,

    -- The occurred_at of the last Paddle event applied to this row.
    --
    -- Paddle does not guarantee delivery order, and a captured webhook can be
    -- replayed. Both are the same bug: an older event arriving after a newer
    -- one and undoing it, which would resurrect a canceled subscription. Every
    -- write compares against this and drops anything not strictly newer.
    last_event_at timestamptz,

    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

-- One live subscription per email, per environment.
--
-- Partial on status so somebody who cancels can subscribe again later: the
-- canceled row stays for the record and stops blocking. Lowercased because
-- Ana@x.com and ana@x.com are one person to every mail server on earth, and a
-- plain unique index would happily take both.
create unique index if not exists alert_subscriptions_one_per_email
    on public.alert_subscriptions (lower(email), live_mode)
    where status <> 'canceled';

create index if not exists alert_subscriptions_user_idx
    on public.alert_subscriptions (user_id, status, live_mode);

alter table public.alert_subscriptions enable row level security;

-- A signed-in user may read their own subscription, so the page can show
-- "active until ...". No insert, update or delete policy on purpose: those
-- need service_role, which only the server holds.
drop policy if exists "read own alert subscription" on public.alert_subscriptions;
create policy "read own alert subscription"
    on public.alert_subscriptions
    for select
    using (auth.uid() = user_id);

-- Named for this table rather than something generic: "create or replace
-- function" overwrites whatever already answers to the name, so a generic
-- touch_updated_at risks replacing another table's trigger body.
create or replace function public.alert_subscriptions_set_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists alert_subscriptions_touch_updated_at on public.alert_subscriptions;
create trigger alert_subscriptions_touch_updated_at
    before update on public.alert_subscriptions
    for each row execute function public.alert_subscriptions_set_updated_at();

-- Whether the caller has alerts right now. Reads through RLS, so it can only
-- ever report on the caller.
--
-- past_due counts as active on purpose: Paddle keeps retrying a failed card
-- for days, and cutting someone off the moment a renewal bounces would hide a
-- settlement deadline from somebody who is still paying.
--
-- live_mode = true is not optional here, and this view deliberately differs
-- from my_report_access next door, which does not filter it.
--
-- The reason they differ: Paddle's sandbox checkout is opened with a
-- client-side token that ships inside the page's JavaScript, so it is public
-- by design. Anyone who found it could complete a checkout with Paddle's test
-- card and land a row here with live_mode false. Without this filter that row
-- would read as a paying subscriber on the real site. The sandbox environment
-- must query alert_subscriptions directly and ask for live_mode false.
create or replace view public.my_alert_access
with (security_invoker = true) as
    select
        exists (
            select 1 from public.alert_subscriptions s
            where s.user_id = auth.uid()
              and s.live_mode = true
              and s.status in ('trialing', 'active', 'past_due')
        ) as has_alerts,
        (
            select max(s.current_period_end) from public.alert_subscriptions s
            where s.user_id = auth.uid()
              and s.live_mode = true
              and s.status in ('trialing', 'active', 'past_due')
        ) as alerts_until;

grant select on public.my_alert_access to authenticated;
