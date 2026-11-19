-- Store the browser installation hash against each game run.
ALTER TABLE public.ace_game_runs
ADD COLUMN IF NOT EXISTS device_hash text;

-- Server-managed browser installation banlist.
CREATE TABLE IF NOT EXISTS public.ace_device_bans (
    device_hash text PRIMARY KEY,
    reason text NOT NULL DEFAULT 'Unspecified',
    banned_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz
);

ALTER TABLE public.ace_device_bans ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.ace_device_bans
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
ON public.ace_device_bans
TO service_role;