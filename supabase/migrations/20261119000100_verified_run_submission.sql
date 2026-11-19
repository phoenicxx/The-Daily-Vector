-- Ranked scores may only be written by ace-submit-run after deterministic replay.
-- This assumes ace_game_runs uses id, token_hash, name, puzzle_day, expires_at,
-- and completed_at, matching the ace-start-run contract consumed by the client.
alter table public.ace_scores
  add column if not exists ending_reason text;

create or replace function public.ace_complete_verified_run(
  p_session_id uuid,
  p_token_hash text,
  p_name text,
  p_day integer,
  p_points integer,
  p_time_ms integer,
  p_waves integer,
  p_ending_reason text
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_score_id uuid;
begin
  if p_points < 0 or p_time_ms < 0 or p_waves < 0 or
     p_ending_reason not in (
       'FRIENDLY HIT BY HOSTILE', 'FRIENDLY COLLISION',
       'PING NOT IDENTIFIED WITHIN 3.0 SECONDS'
     ) then
    raise exception 'INVALID_VERIFIED_RESULT' using errcode = '22023';
  end if;

  update public.ace_game_runs
     set completed_at = now()
   where id = p_session_id
     and token_hash = p_token_hash
     and name = p_name
     and puzzle_day = p_day
     and expires_at > now()
     and completed_at is null;

  if not found then
    raise exception 'SESSION_USED' using errcode = '23505';
  end if;

  insert into public.ace_scores (name, puzzle_day, points, time_ms, waves, ending_reason)
  values (p_name, p_day, p_points, p_time_ms, p_waves, p_ending_reason)
  returning id into v_score_id;

  return v_score_id;
end;
$$;

revoke all on function public.ace_complete_verified_run(uuid, text, text, integer, integer, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.ace_complete_verified_run(uuid, text, text, integer, integer, integer, integer, text)
  to service_role;

-- Remove the old client credential based path and any direct score insertion grants.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as signature
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'ace_submit_score_v2'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.signature);
  end loop;
end;
$$;

revoke insert on public.ace_scores from public, anon, authenticated;
