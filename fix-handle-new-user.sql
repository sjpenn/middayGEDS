-- ============================================================
--  Fix: auto-create public.users row on Supabase auth signup
--
--  Root cause of the midday.eudaven.com login 500:
--  every protectedProcedure runs withTeamPermission, which does
--    SELECT ... FROM public.users WHERE id = auth.uid()
--  and throws NOT_FOUND "User not found" when the row is missing.
--  The self-hosted Supabase Cloud project was never given the
--  handle_new_user trigger that inserts that row on auth.users INSERT,
--  so no signup ever gets a public.users row and user.me 404s -> 500.
--
--  Run this in the Supabase SQL Editor (project elxfxhiwmilsedxgfvjk).
-- ============================================================

-- 1. Function: copy new auth user into public.users
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, full_name, avatar_url, locale)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture'),
    'en'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- 2. Trigger: fire after every new auth.users row
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 3. Backfill: create rows for auth users that already signed in
--    (e.g. anyone who hit the broken login before this fix)
insert into public.users (id, email, full_name, avatar_url, locale)
select
  u.id,
  u.email,
  coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name'),
  coalesce(u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture'),
  'en'
from auth.users u
left join public.users p on p.id = u.id
where p.id is null;

-- 4. Verify
select
  (select count(*) from auth.users)   as auth_users,
  (select count(*) from public.users) as public_users;
