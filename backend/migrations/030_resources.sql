-- 030_resources.sql
-- Resource Manager (#4): operator-registered server resources (Postgres,
-- Redis, the backend itself, BDS, ...) that a control client probes and
-- operates through /control/resources.
--
-- Safety model: commands are written into the registry by the OPERATOR at
-- registration time and executed verbatim by the backend. The control API
-- never invents commands — it only runs what the operator configured, and a
-- verb without a configured command returns 409 instead of guessing.

BEGIN;

CREATE TABLE resources (
    id           SERIAL PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    kind         TEXT NOT NULL DEFAULT 'http' CHECK (kind IN ('http','docker','process')),
    target       TEXT NOT NULL,                       -- http URL / compose service or container name / process pattern
    enabled      BOOLEAN NOT NULL DEFAULT true,
    version      TEXT,
    dependencies JSONB NOT NULL DEFAULT '[]'::jsonb,  -- resource names this one requires
    commands     JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {"install","update","restart","status"}
    notes        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;