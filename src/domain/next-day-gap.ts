/**
 * "Tomorrow has no post" rule — the only queue alert shown to users.
 *
 * Critical when the account publishes today (a post scheduled, sending or already sent on today's local date)
 * and nothing is scheduled for tomorrow's local date. Accounts that do not post today are not flagged: they are
 * either inactive or publish outside Buffer, and flagging them every day would be noise.
 * Only confirmed posts count for tomorrow (status scheduled/sending with a resolved time); drafts and posts
 * awaiting approval do not.
 */
import { DateTime } from "luxon";
import { localDateKey } from "./periods";

export interface DayPost {
  status: string;
  /** Publication time: sentAt for published posts, dueAt otherwise. */
  at: Date | null;
}

export interface NextDayGapResult {
  today: string;
  tomorrow: string;
  postsToday: number;
  scheduledTomorrow: number;
  isGap: boolean;
  /** Start of tomorrow in local time: schedule something before this instant. */
  tomorrowStartsAt: Date;
}

const TODAY_STATUSES = new Set(["scheduled", "sending", "sent"]);
const TOMORROW_STATUSES = new Set(["scheduled", "sending"]);

export function evaluateNextDayGap({ now, timezone, posts }: { now: Date; timezone: string; posts: DayPost[] }): NextDayGapResult {
  const todayLocal = DateTime.fromJSDate(now, { zone: timezone }).startOf("day");
  const tomorrowLocal = todayLocal.plus({ days: 1 });
  const today = todayLocal.toISODate() as string;
  const tomorrow = tomorrowLocal.toISODate() as string;
  let postsToday = 0;
  let scheduledTomorrow = 0;
  for (const p of posts) {
    if (!p.at) continue;
    const day = localDateKey(p.at, timezone);
    if (day === today && TODAY_STATUSES.has(p.status)) postsToday++;
    else if (day === tomorrow && TOMORROW_STATUSES.has(p.status)) scheduledTomorrow++;
  }
  return { today, tomorrow, postsToday, scheduledTomorrow, isGap: postsToday > 0 && scheduledTomorrow === 0, tomorrowStartsAt: tomorrowLocal.toJSDate() };
}
