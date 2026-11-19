// Five-field UTC cron: minute hour day-of-month month day-of-week. A field is a comma list of
// `*`, `n`, `a-b`, `*/s` or `a-b/s`; names and `n/s` are refused, so a typo never reads as a schedule.
type Cron = {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  dow: number[];
  // Vixie semantics: both day fields restricted means either may match, otherwise both must.
  eitherDay: boolean;
};

type Limits = [number, number];
const bounds: Limits[] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];
const longestMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const minute = 60_000;
const day = 86_400_000;
// Eight years reach the next 29 February from any date.
const lookbackDays = 2922;

const itemPattern = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/;

// The `*`, `n` or `a-b` part of an item as inclusive bounds, or undefined when outside the limits.
function span(range: string, [min, max]: Limits): Limits | undefined {
  if (range === "*") return [min, max];
  const [from = 0, to = from] = range.split("-").map(Number);
  return from >= min && to <= max && from <= to ? [from, to] : undefined;
}

// The numbers one comma item names, or undefined for anything else.
function item(text: string, limits: Limits) {
  const match = itemPattern.exec(text);
  if (!match) return;
  const [, range, step] = match as unknown as [string, string, string?];
  const bounds = span(range, limits);
  const by = Number(step ?? 1);
  // A step needs `*` or a range: `5/10` is refused.
  const bare = step !== undefined && !/[*-]/.test(range);
  if (!bounds || bare || by < 1) return;
  const [from, to] = bounds;
  return Array.from(
    { length: Math.floor((to - from) / by) + 1 },
    (_, i) => from + i * by,
  );
}

function field(text: string, limits: Limits) {
  const items = text.split(",").map((part) => item(part, limits));
  if (items.some((values) => !values)) return;
  return [...new Set(items.flat() as number[])].sort((a, b) => a - b);
}

function fields(parts: string[]) {
  const all = parts.map((part, i) => field(part, bounds[i]!));
  return all.every((values) => values !== undefined)
    ? (all as number[][])
    : undefined;
}

// Whether no listed day of month falls in any listed month, such as 31 February.
function neverOccurs(dom: number[], month: number[]) {
  return !month.some((m) => dom.some((d) => d <= longestMonth[m - 1]!));
}

function parse(schedule: string): Cron | undefined {
  const parts = schedule.trim().split(/\s+/);
  const values = parts.length === 5 ? fields(parts) : undefined;
  if (!values) return;
  const [minute, hour, dom, month, dow] = values as [
    number[],
    number[],
    number[],
    number[],
    number[],
  ];
  const anyDom = parts[2]!.startsWith("*");
  const anyDow = parts[4]!.startsWith("*");
  // A schedule no date can satisfy would never send; refuse it as invalid.
  if (!anyDom && anyDow && neverOccurs(dom, month)) return;
  return {
    minute,
    hour,
    dom,
    month,
    dow: [...new Set(dow.map((n) => n % 7))],
    eitherDay: !anyDom && !anyDow,
  };
}

function required(schedule: string) {
  const cron = parse(schedule);
  if (!cron) throw new Error(`Invalid cron schedule ${schedule}`);
  return cron;
}

/** Whether `schedule` is a valid five-field UTC cron that some date can satisfy. */
export function validCron(schedule: string) {
  return parse(schedule) !== undefined;
}

function dayMatches(cron: Cron, date: Date) {
  const dom = cron.dom.includes(date.getUTCDate());
  const dow = cron.dow.includes(date.getUTCDay());
  return (
    cron.month.includes(date.getUTCMonth() + 1) &&
    (cron.eitherDay ? dom || dow : dom && dow)
  );
}

/** The latest scheduled minute at or before `at`, in epoch milliseconds, or undefined when the
 * schedule has not fired in the last eight years.
 * @throws On an invalid schedule.
 */
export function lastFire(schedule: string, at: number) {
  const cron = required(schedule);
  const now = Math.floor(at / minute) * minute;
  const today = Math.floor(now / day) * day;
  for (let back = 0; back < lookbackDays; back++) {
    const start = today - back * day;
    if (!dayMatches(cron, new Date(start))) continue;
    const until = back === 0 ? (now - start) / minute : 1439;
    for (const h of cron.hour.filter((h) => h * 60 <= until).reverse()) {
      const cap = Math.min(59, until - h * 60);
      const m = cron.minute.findLast((m) => m <= cap);
      if (m !== undefined) return start + h * 3_600_000 + m * minute;
    }
  }
}

/** The shortest gap in minutes between two firings in a day, wrapping to the next day. A schedule
 * whose days are not consecutive may fire less often than this, never more often.
 * @throws On an invalid schedule.
 */
export function shortestGapMinutes(schedule: string) {
  const cron = required(schedule);
  const times = cron.hour
    .flatMap((h) => cron.minute.map((m) => h * 60 + m))
    .sort((a, b) => a - b);
  return Math.min(
    1440,
    ...times.map((t, i) => (times[i + 1] ?? times[0]! + 1440) - t),
  );
}
