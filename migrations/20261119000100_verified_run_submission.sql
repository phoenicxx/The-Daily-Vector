-- Ranked scores are written only after ace-submit-run replays the captured run.
-- Keep this RPC aligned with the existing account_id/status run schema.
create or replace function public.ace_complete_verified_run(
  p_session_id uuid,
  p_token_hash text,
  p_account_id bigint,
  p_day integer,
  p_points bigint,
  p_time_ms integer,
  p_waves integer,
  p_ending_reason text
) returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_score_id bigint;
  v_name text;
begin
  if p_points < 0 or p_time_ms < 0 or p_waves < 0 or
     p_ending_reason not in (
       'FRIENDLY HIT BY HOSTILE', 'FRIENDLY COLLISION',
       'PING NOT IDENTIFIED WITHIN 3.0 SECONDS'
     ) then
    raise exception 'INVALID_VERIFIED_RESULT' using errcode = '22023';
  end if;

  select name into v_name
    from public.ace_accounts
   where id = p_account_id;

  if not found then
    raise exception 'INVALID_SESSION' using errcode = '22023';
  end if;

  update public.ace_game_runs
     set status = 'completed'
   where id = p_session_id
     and account_id = p_account_id
     and token_hash = p_token_hash
     and puzzle_day = p_day
     and status = 'active'
     and expires_at > now();

  if not found then
    raise exception 'SESSION_USED' using errcode = '23505';
  end if;

  insert into public.ace_scores (
    account_id, name, puzzle_day, points, time_ms, waves, difficulty
  ) values (
    p_account_id, v_name, p_day, p_points, p_time_ms, p_waves, 'easy'
  )
  returning id into v_score_id;

  return v_score_id;
end;
$$;

revoke all on function public.ace_complete_verified_run(uuid, text, bigint, integer, bigint, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.ace_complete_verified_run(uuid, text, bigint, integer, bigint, integer, integer, text)
  to service_role;

-- Prevent the legacy client-credential submission route from bypassing replay.
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
