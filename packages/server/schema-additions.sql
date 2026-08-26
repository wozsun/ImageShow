-- Current-release additions contain only explicitly reviewed, bounded schema
-- changes or one-time data changes for the active release cycle.
-- After every controlled database has applied an entry, the following release
-- moves it into schema.sql and restores this comment-only placeholder. Do not
-- skip a release carrying entries.
-- The schema bootstrap owns the transaction that covers this file and the
-- following readiness check. Do not add transaction control statements here.

-- No schema additions are required for the current release.
