-- 018_character_details.sql
-- Full RP character profile fields + confirmation/lock support.
-- Additive only: existing columns keep their meaning (name stays the
-- display name; whitelisted/xuid unchanged).

BEGIN;

ALTER TABLE characters
    ADD COLUMN first_name    TEXT,
    ADD COLUMN last_name     TEXT,
    ADD COLUMN nickname      TEXT,
    ADD COLUMN date_of_birth DATE,
    ADD COLUMN gender        TEXT,
    ADD COLUMN nationality   TEXT,
    ADD COLUMN photo_url     TEXT,
    ADD COLUMN citizen_id    TEXT,
    ADD COLUMN biography     TEXT,
    ADD COLUMN personality   TEXT,
    ADD COLUMN strengths     TEXT,
    ADD COLUMN weaknesses    TEXT,
    ADD COLUMN abilities     TEXT,
    ADD COLUMN previous_job  TEXT,
    ADD COLUMN hometown      TEXT,
    ADD COLUMN reason_for_moving TEXT,
    ADD COLUMN life_goals    TEXT,
    -- confirmation = player reviewed the profile and locked it in.
    -- After confirmation, changing locked fields requires an approved
    -- case/ticket (see modules/cases + admin character.update).
    ADD COLUMN confirmed_at  TIMESTAMPTZ,
    ADD COLUMN lock_version  INT NOT NULL DEFAULT 0;

-- Citizen ID is a government-issued number: unique per server. NULL rows
-- (pre-existing characters) are ignored by the unique index.
ALTER TABLE characters
    ADD CONSTRAINT uq_characters_citizen_id UNIQUE (citizen_id);

ALTER TABLE characters
    ADD CONSTRAINT chk_characters_gender CHECK (
        gender IS NULL OR gender IN ('male', 'female', 'other')
    );

-- No time-travel, and characters must be at least 13 years old.
ALTER TABLE characters
    ADD CONSTRAINT chk_characters_dob CHECK (
        date_of_birth IS NULL OR (
            date_of_birth >= '1920-01-01'
            AND date_of_birth <= (current_date - INTERVAL '13 years')
        )
    );

-- A confirmed (locked) character must be flagged as such by lock_version.
ALTER TABLE characters
    ADD CONSTRAINT chk_characters_confirm_lock CHECK (
        confirmed_at IS NULL OR lock_version >= 1
    );

COMMIT;