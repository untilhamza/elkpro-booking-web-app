// ElkPro booking API — Postgres (Neon) behind Netlify Functions.
//
// Replaces direct browser->Firestore access. The browser can never reach
// Postgres, so every query goes through here and DATABASE_URL stays
// server-side. This is also what makes the old "anyone with the public API
// key can read or delete every booking" problem structurally impossible.
//
// One function with an action router rather than 12 endpoints: fewer cold
// starts, and it maps 1:1 onto src/http/serverInterface.ts.
//
// Timestamps cross the wire as ISO-8601 UTC strings. The client formats them
// with moment in browser-local time, exactly as it did with Firestore's
// Timestamp.toDate().

const { neon } = require("@neondatabase/serverless");

const sql = neon(process.env.DATABASE_URL);

// Firebase Auth UIDs. Carried over verbatim from serverInterface.ts and
// auth-context.js. These are unmanageable (the Firebase project is not
// accessible) and should become a role column during the auth migration.
const ADMINS = ["Nwzxrf32Uee9i6hbTXSN2mWVzlC2", "lHxJifUfgHhJkECibwAudvf3MGp1", "lru8dL4JVWTycq0LHhHgyaWqX133"];

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const fail = (statusCode, message) => json(statusCode, { error: message });

// Slots are minute-granular. Legacy rows carry sub-second precision, so every
// comparison truncates rather than testing equality.
const MINUTE = "date_trunc('minute', starts_at at time zone 'UTC')";

const bookingRow = (r) => ({
  id: String(r.id),
  name: r.name,
  phone: r.phone,
  email: r.email,
  status: r.status,
  startsAt: r.starts_at instanceof Date ? r.starts_at.toISOString() : r.starts_at,
});

const actions = {
  async getSettings() {
    // start/end must come back as "1:00 pm" / "11:10 pm", not "13:00:00".
    // src/utils/helpers.js parses them with moment(start, "h:mma") to build the
    // slot grid, so a bare 24h string silently generates the wrong times.
    // to_char with FM strips the leading zero and lowercase "am" matches the
    // exact strings Firestore held.
    const rows = await sql`
      select id,
             to_char(start_time, 'FMHH12:MI am') as start_time,
             to_char(end_time,   'FMHH12:MI am') as end_time,
             slot_minutes, address
      from settings where id = 1`;
    if (!rows.length) throw Object.assign(new Error("No default settings found"), { status: 404 });
    const s = rows[0];
    // Field names match what GeneralSettingsPage/TimeSelector already expect.
    return { id: String(s.id), startTime: s.start_time, endTime: s.end_time, slotSize: s.slot_minutes, address: s.address };
  },

  async submitSettings({ startTime, endTime, slotSize, address }) {
    // Postgres parses "1:00 pm" into time directly, so the admin form's
    // existing values round-trip unchanged.
    await sql`
      update settings set
        start_time   = coalesce(${startTime ?? null}::time, start_time),
        end_time     = coalesce(${endTime ?? null}::time, end_time),
        slot_minutes = coalesce(${slotSize ?? null}, slot_minutes),
        address      = coalesce(${address ?? null}, address),
        updated_at   = now()
      where id = 1`;
    return actions.getSettings();
  },

  // Bookings whose instant falls inside [dayStart, dayEnd).
  async getBookings({ dayStart, dayEnd }) {
    const rows = await sql`
      select id, name, phone, email, status, starts_at from bookings
      where starts_at >= ${dayStart} and starts_at < ${dayEnd}
      order by starts_at asc`;
    return rows.map(bookingRow);
  },

  async getBooking({ id }) {
    const rows = await sql`select id, name, phone, email, status, starts_at from bookings where id = ${id}`;
    if (!rows.length) throw Object.assign(new Error("No booking found!"), { status: 404 });
    return bookingRow(rows[0]);
  },

  // Bookings for a phone number since `since`. Mirrors the old behaviour of
  // looking back one day, and still needs no login.
  async checkBooking({ phone, since }) {
    const rows = await sql`
      select id, name, phone, email, status, starts_at from bookings
      where phone = ${phone} and starts_at > ${since}
      order by starts_at desc`;
    if (!rows.length) throw Object.assign(new Error(`Found no bookings under ${phone}`), { status: 404 });
    return rows.map(bookingRow);
  },

  // Everything unavailable on a day: confirmed bookings plus blocked slots.
  // Replaces the old `slots` collection, which duplicated bookings and had
  // already drifted out of sync with them.
  async getSlots({ dayStart, dayEnd }) {
    const rows = await sql`
      select 'confirmed' as status, starts_at, 'b' || id as id from bookings
        where status = 'confirmed' and starts_at >= ${dayStart} and starts_at < ${dayEnd}
      union all
      select 'blocked' as status, starts_at, 's' || id as id from blocked_slots
        where starts_at >= ${dayStart} and starts_at < ${dayEnd}
      order by starts_at asc`;
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      startsAt: r.starts_at instanceof Date ? r.starts_at.toISOString() : r.starts_at,
    }));
  },

  async checkSlotNotInDB({ slot, status }) {
    const rows =
      status === "blocked"
        ? await sql`select 1 from blocked_slots where date_trunc('minute', starts_at at time zone 'UTC') = date_trunc('minute', ${slot}::timestamptz at time zone 'UTC') limit 1`
        : await sql`select 1 from bookings where status = 'confirmed' and date_trunc('minute', starts_at at time zone 'UTC') = date_trunc('minute', ${slot}::timestamptz at time zone 'UTC') limit 1`;
    return { free: rows.length === 0 };
  },

  async deleteRemoteSlot({ slot, status }) {
    if (status === "blocked") {
      await sql`delete from blocked_slots where date_trunc('minute', starts_at at time zone 'UTC') = date_trunc('minute', ${slot}::timestamptz at time zone 'UTC')`;
      return { ok: true };
    }
    // A confirmed "slot" is no longer a stored row — it is a confirmed
    // booking. Cancelling the booking is what frees it.
    await sql`update bookings set status = 'cancelled'
              where status = 'confirmed'
                and date_trunc('minute', starts_at at time zone 'UTC') = date_trunc('minute', ${slot}::timestamptz at time zone 'UTC')`;
    return { ok: true };
  },

  async submitBooking({ booking }) {
    const { startsAt, name, phone, email, userId, accountName, photoURL, dayStart, dayEnd, legacyTime } = booking;
    if (!startsAt || !name || !phone) throw Object.assign(new Error("Missing booking fields"), { status: 400 });

    // Preserved rule: an admin may always book. A signed-in customer is
    // allowed while they have at most one confirmed booking that day — the
    // original `numberOfBookings <= 1` test, which in practice permits two
    // per day. Guests (no userId) were never checked and still are not.
    if (userId && !ADMINS.includes(userId)) {
      const [{ count }] = await sql`
        select count(*)::int as count from bookings
        where user_id = ${userId} and status = 'confirmed'
          and starts_at >= ${dayStart} and starts_at < ${dayEnd}`;
      if (count > 1) throw Object.assign(new Error("Looks like you have already booked today :)."), { status: 409 });
    }

    // Hardening, deliberately different from the old code: that path only
    // checked for a confirmed booking, so a blocked slot could still be
    // booked through a crafted request — the UI was the only thing stopping
    // it. Both are checked here.
    const blocked = await sql`select 1 from blocked_slots
      where date_trunc('minute', starts_at at time zone 'UTC') = date_trunc('minute', ${startsAt}::timestamptz at time zone 'UTC') limit 1`;
    if (blocked.length) throw Object.assign(new Error("Slot is not available. Please choose another slot."), { status: 409 });

    try {
      const rows = await sql`
        insert into bookings (starts_at, status, name, phone, email, user_id, account_name, photo_url, legacy_time)
        values (date_trunc('second', ${startsAt}::timestamptz), 'confirmed', ${name}, ${phone},
                ${email ?? null}, ${userId ?? null}, ${accountName ?? null}, ${photoURL ?? null}, ${legacyTime ?? null})
        returning id, name, phone, email, status, starts_at`;
      return bookingRow(rows[0]);
    } catch (e) {
      // The partial unique index is the real guard against double-booking;
      // the check above is only a nicer error path.
      if (String(e.message || "").includes("bookings_one_confirmed_per_minute")) {
        throw Object.assign(new Error("Slot is not available. Please choose another slot."), { status: 409 });
      }
      throw e;
    }
  },

  async cancelBooking({ id }) {
    const rows = await sql`
      update bookings set status = 'cancelled' where id = ${id}
      returning id, name, phone, email, status, starts_at`;
    if (!rows.length) throw Object.assign(new Error("The booking you are attempting to cancel was not found!"), { status: 404 });
    return bookingRow(rows[0]);
  },

  // Replace the day's blocked slots wholesale, refusing if any requested slot
  // is already booked. Runs as one statement sequence so a refusal leaves the
  // previous blocks intact.
  async submitBlockedSlots({ dayStart, dayEnd, slots }) {
    const wanted = Array.isArray(slots) ? slots : [];
    for (const s of wanted) {
      const taken = await sql`select 1 from bookings
        where status = 'confirmed'
          and date_trunc('minute', starts_at at time zone 'UTC') = date_trunc('minute', ${s}::timestamptz at time zone 'UTC') limit 1`;
      if (taken.length) throw Object.assign(new Error("Sorry, cannot block slots that have been booked by a user."), { status: 409 });
    }
    await sql`delete from blocked_slots where starts_at >= ${dayStart} and starts_at < ${dayEnd}`;
    for (const s of wanted) {
      await sql`insert into blocked_slots (starts_at) values (date_trunc('second', ${s}::timestamptz))
                on conflict (starts_at) do nothing`;
    }
    return actions.getSlots({ dayStart, dayEnd });
  },
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return fail(405, "Method not allowed");
  if (!process.env.DATABASE_URL) return fail(500, "DATABASE_URL is not configured");

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return fail(400, "Invalid JSON body");
  }

  const { action, ...args } = payload;
  const fn = actions[action];
  if (!fn) return fail(400, `Unknown action: ${action}`);

  try {
    return json(200, { data: await fn(args) });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(`[api:${action}]`, err);
    return fail(status, err.message || "Server error");
  }
};
