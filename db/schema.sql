-- ElkPro booking app — Postgres schema (target: Neon)
-- Derived from the 2026-09-04 Firestore export:
--   bookings 2944 rows, slots 9299 rows, settings 1 row.
--
-- Design notes are in MIGRATION.md. Key decisions:
--   * Firestore `date` is already a full UTC instant and is authoritative;
--     the sibling `time` string is display-only and dirty (134 distinct
--     values, including malformed entries like '10:30' with no AM/PM).
--     One timestamptz column replaces both.
--   * slots(status='confirmed') is a redundant mirror of bookings and has
--     already drifted (276 confirmed bookings have no slot row, 34 slot rows
--     have no booking). It is NOT migrated — confirmed availability is
--     derived from bookings. Only slots(status='blocked') carries real,
--     independent state, so it becomes its own table.
--   * Customers repeat: 602 distinct emails across 2944 bookings.

BEGIN;

CREATE TABLE settings (
    id             smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- single row
    start_time     time        NOT NULL,
    end_time       time        NOT NULL,
    slot_minutes   integer     NOT NULL CHECK (slot_minutes > 0),
    address        text        NOT NULL,
    timezone       text        NOT NULL DEFAULT 'Asia/Seoul',
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Admin-blocked availability. Independent of bookings.
CREATE TABLE blocked_slots (
    id          bigserial   PRIMARY KEY,
    starts_at   timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    legacy_id   text UNIQUE,                 -- Firestore doc id, for traceability
    UNIQUE (starts_at)
);

CREATE TYPE booking_status AS ENUM ('confirmed', 'cancelled');

CREATE TABLE bookings (
    id            bigserial      PRIMARY KEY,
    starts_at     timestamptz    NOT NULL,
    status        booking_status NOT NULL DEFAULT 'confirmed',

    name          text           NOT NULL,
    phone         text           NOT NULL,          -- see phone_e164
    phone_e164    text,                             -- normalized, NULL if unparseable
    email         text,                             -- 35 legacy rows have none

    -- Identity. 2054 of 2944 bookings are guests, so this is nullable and
    -- stays nullable after any auth migration.
    user_id       text,
    account_name  text,
    photo_url     text,

    created_at    timestamptz    NOT NULL DEFAULT now(),
    legacy_id     text UNIQUE,                      -- Firestore doc id
    legacy_time   text                              -- original display string, kept for audit
);

-- The constraint Firestore could not enforce: one confirmed booking per slot.
--
-- Truncated to the MINUTE, not the raw instant. 2576 legacy rows carry
-- sub-second precision, so indexing starts_at directly would let two bookings
-- share a slot whenever their microseconds differed -- 6 such collisions
-- existed in the migrated data (all 2022-2023, later row demoted to
-- 'cancelled'). date_trunc on timestamptz is only STABLE, so the expression
-- is pinned to UTC to make it IMMUTABLE and therefore indexable.
CREATE UNIQUE INDEX bookings_one_confirmed_per_minute
    ON bookings ((date_trunc('minute', starts_at AT TIME ZONE 'UTC')))
    WHERE status = 'confirmed';

CREATE INDEX bookings_starts_at_idx ON bookings (starts_at DESC);
CREATE INDEX bookings_phone_idx     ON bookings (phone);
CREATE INDEX bookings_email_idx     ON bookings (email) WHERE email IS NOT NULL;
CREATE INDEX bookings_user_id_idx   ON bookings (user_id) WHERE user_id IS NOT NULL;

-- Availability for a day, replacing the slots collection:
--   generate_series over settings, minus blocked_slots, minus confirmed bookings.
CREATE VIEW taken_slots AS
    SELECT starts_at, 'booked'::text AS reason FROM bookings WHERE status = 'confirmed'
    UNION ALL
    SELECT starts_at, 'blocked'::text            FROM blocked_slots;

COMMIT;
