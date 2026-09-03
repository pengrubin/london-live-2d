// Europe/London calendar days. TfL's date-window paths and the leaderboard's
// period buckets both key on the London civil day, which parts from the UTC
// day for one hour every summer night (BST = UTC+1). One formatter, one
// function — the offset formatter in nr-inference.ts answers a different
// question (wall-clock offset at an instant) and stays separate on purpose.

export const MS_PER_DAY = 86_400_000;

/** en-CA formats as YYYY-MM-DD, the form TfL paths and bucket keys expect. */
const LONDON_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' });

/** YYYY-MM-DD of the Europe/London calendar day containing `now`. */
export function londonDay(now: Date): string {
  return LONDON_DATE.format(now);
}
