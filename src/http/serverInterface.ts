import moment, { Moment } from "moment";

import { combineDateTimeMoment } from "../utils/helpers";

// Data access moved from Firestore to Postgres (Neon) behind a Netlify
// Function. Every exported name, argument and return shape below is unchanged,
// so no page or component needed editing — the swap is contained to this file.
//
// Why the indirection: a browser cannot hold a Postgres credential. Routing
// through /.netlify/functions/api keeps DATABASE_URL server-side and ends the
// era where the public Firebase key could read or delete every booking.

const API_URL = "/.netlify/functions/api";

interface NewBooking {
  email: string;
  googleAccountName: string | null;
  name: string;
  phone: string;
  photoURL: string | null;
  time: string;
  userId: string;
  date: Moment;
}

type BookingStatus = "confirmed" | "blocked" | "cancelled";

async function call(action: string, args: any = {}) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...args }),
  });

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    /* fall through to the status-based error below */
  }

  if (!response.ok) {
    throw new Error((payload && payload.error) || `Request failed (${response.status})`);
  }
  return payload ? payload.data : null;
}

// Day boundaries in the viewer's local timezone, matching how the old code
// derived them from a Moment before handing them to Firestore.
function dayBounds(momentDate: Moment) {
  const start = moment(momentDate).startOf("day");
  return { dayStart: start.toISOString(), dayEnd: start.clone().add(1, "day").toISOString() };
}

// Shapes an API booking exactly as the Firestore version did, so Appointment,
// CheckAppointment and Admin keep working untouched.
function processBooking(result) {
  const when = moment(result.startsAt);
  const isDone = when < moment();

  return {
    name: result.name,
    phone: result.phone,
    date: when.toDate().toDateString(),
    time: when.format("LT"),
    fb_timeStamp: result.startsAt,
    status: isDone && result.status === "confirmed" ? "completed" : result.status,
    isPast: when < moment().subtract("1", "days"),
    id: result.id,
  };
}

function processSlot(result) {
  return {
    time: moment(result.startsAt).format("LT"),
    isBooked: result.status === "confirmed",
    isBlocked: result.status === "blocked",
  };
}

function makeSlotMoment(momentDate: Moment, timeString) {
  let timeMoment = moment(timeString, "h:mm a");
  let slotMoment = combineDateTimeMoment(momentDate, timeMoment);
  return slotMoment;
}

// Frees a slot. A blocked slot is a stored row; a confirmed one is a booking,
// so releasing it means cancelling that booking.
export async function deleteRemoteSlot(slotMoment: Moment, status: BookingStatus) {
  try {
    await call("deleteRemoteSlot", { slot: moment(slotMoment).toISOString(), status });
  } catch (err) {
    console.log("delete slot error", err);
    throw err;
  }
}

// True when the slot is free for the given status.
export async function checkSlotNotInDB(slotMoment: Moment, status: BookingStatus) {
  try {
    const result = await call("checkSlotNotInDB", { slot: moment(slotMoment).toISOString(), status });
    return result.free;
  } catch (err) {
    console.log("error in check slot in db", err);
    throw err;
  }
}

export async function httpGetBooking(id) {
  const result = await call("getBooking", { id });
  return processBooking(result);
}

export async function httpGetSettings() {
  return await call("getSettings");
}

export async function httpSubmitSettings(newSettings) {
  try {
    const { startTime, endTime, slotSize, address } = newSettings;
    await call("submitSettings", { startTime, endTime, slotSize, address });
  } catch (err) {
    console.log(err);
    throw err;
  }
}

// Bookings for a phone number since yesterday. Deliberately still unauthenticated:
// this is how customers look up a booking without an account, and 69% of
// bookings have no user attached at all.
export async function httpCheckBooking(phoneNumber) {
  const since = moment().clone().subtract(1, "days").toISOString();
  const results = await call("checkBooking", { phone: phoneNumber, since });
  return results.map((r) => ({ ...processBooking(r), id: r.id }));
}

export async function httpGetBookings(dateMoment) {
  const results = await call("getBookings", dayBounds(moment(dateMoment)));
  return results.map((r) => ({ ...processBooking(r), id: r.id }));
}

// Unavailable slots for a day: confirmed bookings plus admin-blocked slots.
export async function httpGetSlots(dateMoment) {
  const results = await call("getSlots", dayBounds(moment(dateMoment)));
  return results.map((r) => ({ ...processSlot(r), id: r.id }));
}

export async function httpSubmitBlockedSlots(momentDate: Moment, localTimesArray) {
  try {
    const slots = (localTimesArray || []).map((t) => makeSlotMoment(momentDate, t).toISOString());
    const results = await call("submitBlockedSlots", { ...dayBounds(moment(momentDate)), slots });
    return results.map((r) => ({ ...processSlot(r), id: r.id }));
  } catch (err) {
    console.log("Error in submitting blocked slots", err);
    throw err;
  }
}

export async function httpSubmitBooking(bookingData) {
  const startsAt = makeSlotMoment(bookingData.date, bookingData.time);
  const bounds = dayBounds(moment(bookingData.date));

  const result = await call("submitBooking", {
    booking: {
      startsAt: startsAt.toISOString(),
      name: bookingData.name,
      phone: bookingData.phone,
      email: bookingData.email,
      userId: bookingData.userId || null,
      accountName: bookingData.googleAccountName || null,
      photoURL: bookingData.photoURL || null,
      legacyTime: bookingData.time,
      dayStart: bounds.dayStart,
      dayEnd: bounds.dayEnd,
    },
  });

  // Callers expect the new booking's id.
  return result.id;
}

export async function httpCancelBooking(id) {
  try {
    return await call("cancelBooking", { id });
  } catch (err) {
    console.log(err);
    throw err;
  }
}
