-- 0024_drop_invites.sql — drop the invite system.
--
-- The .deb desktop install is single-user-local; there's nobody to
-- invite. The /invites surface and the /auth/claim flow have been
-- removed; this migration drops their backing table so nothing
-- spurious stays in the schema.

DROP TABLE IF EXISTS invites CASCADE;
