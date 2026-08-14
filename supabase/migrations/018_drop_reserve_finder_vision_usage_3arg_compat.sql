-- PR #33 (which introduces the 5-argument reserve_finder_vision_usage caller in
-- lib/gemini-vision.ts) has merged and deployed to production — confirmed via the Vercel
-- project's latestDeployment matching the merge commit, target=production, state=READY. The
-- 3-argument compatibility overload added in migration 017 to bridge the gap between "016
-- applied" and "matching app code deployed" is no longer called by any live code path, so it's
-- dropped here per the cleanup note left in that migration.
drop function if exists public.reserve_finder_vision_usage(text, boolean, integer);
