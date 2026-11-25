-- Rakshak (रक्षक) Anonymous Emergency & Feedback Schema
-- Run this SQL in your Supabase SQL Editor.
-- No user login, profiles, emails, or personal identifiers are stored.

create extension if not exists pgcrypto;

create table if not exists public.emergency_events (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  phrase text not null,
  language text not null,
  matched_intent text not null,
  source text not null check (source in ('local', 'gemini', 'cache', 'tile')),
  confidence numeric,
  approx_lat numeric(5, 2),
  approx_lng numeric(5, 2),
  created_at timestamptz not null default now()
);

create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  event_id uuid references public.emergency_events(id) on delete set null,
  phrase text not null,
  matched_intent text not null,
  is_correct boolean not null,
  corrected_intent text,
  created_at timestamptz not null default now()
);

alter table public.emergency_events enable row level security;
alter table public.feedback enable row level security;

-- Anon clients may ONLY insert anonymized records (no select, update, or delete).
drop policy if exists "anon can insert events" on public.emergency_events;
create policy "anon can insert events"
  on public.emergency_events
  for insert
  to anon
  with check (true);

drop policy if exists "anon can insert feedback" on public.feedback;
create policy "anon can insert feedback"
  on public.feedback
  for insert
  to anon
  with check (true);
