export interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  anyDay: boolean;
}

const RANGES = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["day of month", 1, 31],
  ["month", 1, 12],
  ["day of week", 0, 7],
] as const;

function parseField(field: string, label: string, min: number, max: number): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>();
  let restricted = false;
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    if (rangePart === undefined || rangePart === "") throw new Error(`cron ${label}: empty entry in "${field}"`);
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron ${label}: invalid step in "${part}"`);
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
      if (stepPart !== undefined) restricted = true;
    } else {
      restricted = true;
      const [a, b] = rangePart.split("-");
      lo = Number(a);
      hi = b === undefined ? (stepPart === undefined ? lo : max) : Number(b);
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
        throw new Error(`cron ${label}: "${part}" is outside ${min}-${max}`);
      }
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values, restricted };
}

export function parseCron(expression: string): CronSpec {
  const [minute, hour, dayOfMonth, month, dayOfWeek, ...rest] = expression.trim().split(/\s+/);
  if (minute === undefined || hour === undefined || dayOfMonth === undefined || month === undefined || dayOfWeek === undefined || rest.length > 0) {
    throw new Error(`cron expression "${expression}" must have 5 fields`);
  }
  const [minuteRange, hourRange, dayOfMonthRange, monthRange, dayOfWeekRange] = RANGES;
  const parsed = {
    minute: parseField(minute, ...minuteRange),
    hour: parseField(hour, ...hourRange),
    dayOfMonth: parseField(dayOfMonth, ...dayOfMonthRange),
    month: parseField(month, ...monthRange),
    dayOfWeek: parseField(dayOfWeek, ...dayOfWeekRange),
  };
  const dow = parsed.dayOfWeek.values;
  if (dow.has(7)) {
    dow.delete(7);
    dow.add(0);
  }
  return {
    minute: parsed.minute.values,
    hour: parsed.hour.values,
    dayOfMonth: parsed.dayOfMonth.values,
    month: parsed.month.values,
    dayOfWeek: dow,
    anyDay: parsed.dayOfMonth.restricted && parsed.dayOfWeek.restricted,
  };
}

export function cronMatches(spec: CronSpec, date: Date): boolean {
  if (!spec.minute.has(date.getMinutes()) || !spec.hour.has(date.getHours()) || !spec.month.has(date.getMonth() + 1)) return false;
  const domOk = spec.dayOfMonth.has(date.getDate());
  const dowOk = spec.dayOfWeek.has(date.getDay());
  return spec.anyDay ? domOk || dowOk : domOk && dowOk;
}
