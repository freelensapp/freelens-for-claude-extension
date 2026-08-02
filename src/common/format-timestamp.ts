/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Renderer-free helpers that format a prompt's timestamp the same way Freelens
// renders a resource's "Created" field: "<age> ago (<local ISO 8601>)", e.g.
// "16h 37m ago (2026-08-02T02:05:06+02:00)".
//
// The two building blocks reproduce `@freelensapp/utilities` (`formatDuration`
// and `formatInTimeZone`); that package is neither a Freelens host global nor
// re-exported by `@freelensapp/extensions`, so the logic is copied here to keep
// the output identical without pulling in a dependency.

// 400 Gregorian years have exactly 146097 days and 4800 months. moment used
// these ratios to normalize a duration into years/months/days; we reproduce
// them so the output matches Freelens' moment-based implementation.
const DAYS_TO_MONTHS = 4800 / 146097;
const MONTHS_TO_DAYS = 146097 / 4800;
const DAYS_PER_YEAR = 146097 / 400;

interface DurationParts {
  asSeconds: number;
  asMinutes: number;
  asHours: number;
  asDays: number;
  asYears: number;
  seconds: number;
  minutes: number;
  hours: number;
  days: number;
}

/** Breaks a millisecond duration into total and remainder components. */
function getDurationParts(timeValue: number): DurationParts {
  const totalSeconds = Math.floor(timeValue / 1000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const totalHours = Math.floor(totalMinutes / 60);
  const totalDays = Math.floor(totalHours / 24);

  const monthsFromDays = Math.floor(totalDays * DAYS_TO_MONTHS);

  return {
    asSeconds: timeValue / 1000,
    asMinutes: timeValue / 60000,
    asHours: timeValue / 3_600_000,
    asDays: timeValue / 86_400_000,
    asYears: timeValue / 86_400_000 / DAYS_PER_YEAR,
    seconds: totalSeconds % 60,
    minutes: totalMinutes % 60,
    hours: totalHours % 24,
    days: totalDays - Math.ceil(monthsFromDays * MONTHS_TO_DAYS),
  };
}

function getMeaningfulValues(values: number[], suffixes: string[], separator = " "): string {
  return values
    .map((a, i): [number, string] => [a, suffixes[i]])
    .filter(([dur]) => dur > 0)
    .map(([dur, suf]) => dur + suf)
    .join(separator);
}

/**
 * Formats a duration in milliseconds in a human-readable form, matching
 * Freelens' `formatDuration`. The "Created" field uses the non-compact form,
 * e.g. `16h 37m` rather than `16h`.
 */
export function formatDuration(timeValue: number, compact = true): string {
  const duration = getDurationParts(timeValue);
  const seconds = Math.floor(duration.asSeconds);
  const separator = compact ? "" : " ";

  if (seconds < 0) {
    return "0s";
  } else if (seconds < 60 * 2) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(duration.asMinutes);

  if (minutes < 10) {
    return getMeaningfulValues([minutes, duration.seconds], ["m", "s"], separator);
  } else if (minutes < 60 * 3) {
    if (!compact) {
      return getMeaningfulValues([minutes, duration.seconds], ["m", "s"]);
    }

    return `${minutes}m`;
  }

  const hours = Math.floor(duration.asHours);

  if (hours < 8) {
    return getMeaningfulValues([hours, duration.minutes], ["h", "m"], separator);
  } else if (hours < 48) {
    if (compact) {
      return `${hours}h`;
    }

    return getMeaningfulValues([hours, duration.minutes], ["h", "m"]);
  }

  const days = Math.floor(duration.asDays);

  if (days < 8) {
    if (compact) {
      return getMeaningfulValues([days, duration.hours], ["d", "h"], separator);
    }

    return getMeaningfulValues([days, duration.hours, duration.minutes], ["d", "h", "m"]);
  }

  const years = Math.floor(duration.asYears);

  if (years < 2) {
    if (compact) {
      return `${days}d`;
    }

    return getMeaningfulValues([days, duration.hours, duration.minutes], ["d", "h", "m"]);
  } else if (years < 8) {
    if (compact) {
      return getMeaningfulValues([years, duration.days], ["y", "d"], separator);
    }
  }

  if (compact) {
    return `${years}y`;
  }

  return getMeaningfulValues([years, duration.days, duration.hours, duration.minutes], ["y", "d", "h", "m"]);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Renders a date as an ISO 8601 string with the machine's local UTC offset,
 * e.g. `2026-08-02T02:05:06+02:00`. A zero offset collapses to `Z`, matching
 * Freelens' `formatInTimeZone` output.
 */
export function toLocalIso(date: Date): string {
  // `getTimezoneOffset` is minutes behind UTC (positive when local is behind),
  // so negate it to get the ISO sign convention.
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absMinutes = Math.abs(offsetMinutes);
  const offset = offsetMinutes === 0 ? "Z" : `${sign}${pad(Math.floor(absMinutes / 60))}:${pad(absMinutes % 60)}`;

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`
  );
}

/**
 * Formats a prompt's ISO timestamp for the hover tooltip, identical to the
 * "Created" field: `<age> ago (<local ISO 8601>)`. Returns the raw input when
 * it is not a parseable date. `now` is injectable for deterministic tests.
 */
export function formatPromptTimestamp(iso: string, now: number = Date.now()): string {
  const date = new Date(iso);
  const time = date.getTime();
  if (Number.isNaN(time)) return iso;
  return `${formatDuration(now - time, false)} ago (${toLocalIso(date)})`;
}
