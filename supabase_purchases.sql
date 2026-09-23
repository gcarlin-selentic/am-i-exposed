-- Purchases and report entitlement
--
-- One purchase grants 30 days of unlimited report generation for that account.
-- Only the server (service_role) may write here. The webhook is the single
-- source of truth for whether something was actually paid for; the browser can
-- read its own rows but can never create or modify one.
--
-- Run once in the Supabase SQL Editor for project morosdhhoznicppmrqyr.
-- Safe to re-run.

create table if not exists public.purchases (
    id                     uuid primary key default gen_random_uuid(),
    user_id                uuid not null references auth.users(id) on delete cascade,
    email                  text,

    status                 text not null default 'pending'
                           check (status in ('pending', 'paid', 'failed', 'refunded', 'cancelled')),

    provider               text not null default 'mercadopago',
    provider_preference_id text,
    -- Unique so a webhook replay cannot grant a second entitlement.
    provider_payment_id    text unique,

    amount                 numeric(12,2),
    currency               text,

    paid_at                timestamptz,
    expires_at             timestamptz,

    created_at             timestamptz not null default now(),
    updated_at             timestamptz not null default now()
);

create index if not exists purchases_user_active_idx
    on public.purchases (user_id, status, expires_at desc);

create index if not exists purchases_preference_idx
    on public.purchases (provider_preference_id);

alter table public.purchases enable row level security;

-- A signed-in user may read their own purchase history, so the page can show
-- "your access runs until ...". There is deliberately no insert, update or
-- delete policy: those require service_role, which only the server holds.
drop policy if exists "read own purchases" on public.purchases;
create policy "read own purchases"
    on public.purchases
    for select
    using (auth.uid() = user_id);

-- Keep updated_at honest.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists purchases_touch_updated_at on public.purchases;
create trigger purchases_touch_updated_at
    before update on public.purchases
    for each row execute function public.touch_updated_at();

-- Convenience view of whether the current user has access right now.
-- Reads through RLS, so it can only ever report on the caller.
create or replace view public.my_report_access
with (security_invoker = true) as
    select
        exists (
            select 1 from public.purchases p
            where p.user_id = auth.uid()
              and p.status = 'paid'
              and (p.expires_at is null or p.expires_at > now())
        ) as has_access,
        (
            select max(p.expires_at) from public.purchases p
            where p.user_id = auth.uid()
              and p.status = 'paid'
        ) as access_until;

grant select on public.my_report_access to authenticated;
