#!/usr/bin/env python3
"""Load the Firestore export into Postgres (Neon).

    python3 load.py --dry-run            # transform + validate, no DB needed
    DATABASE_URL=postgres://... python3 load.py

Reads ../bookings.json, ../slots.json, ../settings.json (the normalized
export, not the .raw.json envelopes). Transform logic is identical in both
modes, so a clean --dry-run means the data is ready to load.
"""
import argparse, json, os, re, sys, collections
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
EXPORT = os.path.dirname(HERE)


def load(name):
    with open(os.path.join(EXPORT, f"{name}.json")) as f:
        return json.load(f)


def parse_ts(s):
    """Firestore timestamps: '2024-04-10T04:00:00Z' or with fractional seconds."""
    if not s:
        return None
    s = s.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(s).astimezone(timezone.utc)
    except ValueError:
        return None


def to_e164(raw, default_cc="82"):
    """Best-effort Korean normalization. Returns None when unsure — the raw
    value is always preserved in bookings.phone regardless."""
    if not raw:
        return None
    d = re.sub(r"[^\d+]", "", str(raw))
    if d.startswith("+"):
        return d if 8 <= len(d) - 1 <= 15 else None
    if d.startswith("00"):
        d = "+" + d[2:]
        return d if 8 <= len(d) - 1 <= 15 else None
    if d.startswith("0"):                 # 01012345678 -> +821012345678
        return f"+{default_cc}{d[1:]}"
    if d.startswith(default_cc):
        return f"+{d}"
    return None


def build():
    settings, slots, bookings = load("settings"), load("slots"), load("bookings")
    report = collections.Counter()

    s = settings[0]
    settings_row = (1, s["startTime"], s["endTime"], int(s["slotSize"]), s["address"])

    # Only 'blocked' slots carry independent state; 'confirmed' mirrors bookings.
    blocked = []
    for r in slots:
        if r.get("status") != "blocked":
            report["slots_skipped_confirmed_mirror"] += 1
            continue
        ts = parse_ts(r.get("date"))
        if ts is None:
            report["slots_dropped_bad_date"] += 1
            continue
        blocked.append((ts, r["_id"]))
    # blocked_slots.starts_at is UNIQUE — collapse duplicates
    seen, dedup = set(), []
    for ts, lid in blocked:
        if ts in seen:
            report["slots_dropped_duplicate_instant"] += 1
            continue
        seen.add(ts)
        dedup.append((ts, lid))
    blocked = dedup

    rows, confirmed_seen = [], {}
    for r in bookings:
        ts = parse_ts(r.get("date"))
        if ts is None:
            report["bookings_dropped_bad_date"] += 1
            continue
        status = r.get("status")
        if status not in ("confirmed", "cancelled"):
            report[f"bookings_unexpected_status_{status}"] += 1
            status = "confirmed"

        # Enforce one confirmed booking per instant. Historical violations keep
        # the earliest-created row confirmed; later ones are demoted so the
        # partial unique index can be created. Nothing is deleted.
        if status == "confirmed":
            if ts in confirmed_seen:
                report["bookings_demoted_double_booking"] += 1
                status = "cancelled"
            else:
                confirmed_seen[ts] = r["_id"]

        phone = str(r.get("phone") or "").strip()
        e164 = to_e164(phone)
        if phone and not e164:
            report["phone_unparseable"] += 1

        rows.append((
            ts, status, (r.get("name") or "").strip(), phone, e164,
            (r.get("email") or "").strip() or None,
            r.get("userId"), r.get("googleAccountName"), r.get("photoURL"),
            parse_ts(r.get("createdTime")) or ts,
            r["_id"], r.get("time"),
        ))

    return settings_row, blocked, rows, report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    settings_row, blocked, rows, report = build()

    print(f"settings       : 1 row")
    print(f"blocked_slots  : {len(blocked)} rows")
    print(f"bookings       : {len(rows)} rows")
    print(f"  confirmed    : {sum(1 for r in rows if r[1] == 'confirmed')}")
    print(f"  cancelled    : {sum(1 for r in rows if r[1] == 'cancelled')}")
    print("\ntransform report:")
    for k, v in sorted(report.items()):
        print(f"  {k:<38} {v}")

    if a.dry_run:
        print("\ndry run — nothing written")
        return

    url = os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("DATABASE_URL not set (or use --dry-run)")
    try:
        import psycopg
    except ImportError:
        sys.exit("pip install 'psycopg[binary]'")

    with psycopg.connect(url) as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO settings (id,start_time,end_time,slot_minutes,address) "
            "VALUES (%s,%s,%s,%s,%s) ON CONFLICT (id) DO UPDATE SET "
            "start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time, "
            "slot_minutes=EXCLUDED.slot_minutes, address=EXCLUDED.address",
            settings_row)
        cur.executemany(
            "INSERT INTO blocked_slots (starts_at,legacy_id) VALUES (%s,%s) "
            "ON CONFLICT (legacy_id) DO NOTHING", blocked)
        cur.executemany(
            "INSERT INTO bookings (starts_at,status,name,phone,phone_e164,email,"
            "user_id,account_name,photo_url,created_at,legacy_id,legacy_time) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
            "ON CONFLICT (legacy_id) DO NOTHING", rows)
        conn.commit()
    print("\nloaded.")


if __name__ == "__main__":
    main()
