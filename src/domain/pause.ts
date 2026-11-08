const months = [
    'jan',
    'feb',
    'mar',
    'apr',
    'may',
    'jun',
    'jul',
    'aug',
    'sep',
    'oct',
    'nov',
    'dec',
]
const weekdays = [
    'sun',
    'mon',
    'tue',
    'wed',
    'thu',
    'fri',
    'sat',
]

const MAX_PAUSE_SECONDS = 12 * 3600
const MAX_RETRY_AFTER_SECONDS = 6 * 3600
const MARGIN_SECONDS = 60

/**
 * Seconds a provider stays paused after a limit (ported from Work Finder):
 * Codex names the reset time, "try again at 5:03 AM" or with a date ("try
 * again at Oct 5th, 2026 1:28 PM"), Claude Code "resets 3:45pm" or with a
 * weekday ("resets Mon 12:00am"), all in the container's UTC, plus 60 s and
 * at most 12 hours; HTTP providers send Retry-After ("retry after N s", at
 * most 6 hours). Otherwise, or for a date already past, `fallback`.
 */
export function pauseSeconds(message: string | null, now: Date, fallback: number): number {
    const retryAfter = message?.match(/retry after (\d+) s/i)
    if (retryAfter) return Math.min(Number(retryAfter[1]), MAX_RETRY_AFTER_SECONDS)
    const until = (reset: Date) =>
        Math.min(Math.ceil((reset.getTime() - now.getTime()) / 1000) + MARGIN_SECONDS, MAX_PAUSE_SECONDS)
    const clock = message?.match(
        /try again at (?:([A-Z][a-z]{2})[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4}),? (?:at )?)?(\d{1,2}):(\d{2})\s*(AM|PM)/i,
    )
    if (clock) {
        const hours = (Number(clock[4]) % 12) + (clock[6]?.toUpperCase() === 'PM' ? 12 : 0)
        const month = clock[1] ? months.indexOf(clock[1].slice(0, 3).toLowerCase()) : -1
        const reset =
            month >= 0
                ? new Date(Date.UTC(Number(clock[3]), month, Number(clock[2]), hours, Number(clock[5])))
                : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, Number(clock[5])))
        if (month >= 0 && reset <= now) return fallback
        if (month < 0 && reset <= now) reset.setUTCDate(reset.getUTCDate() + 1)
        return until(reset)
    }
    const claude = message?.match(/resets (?:(sun|mon|tue|wed|thu|fri|sat)[a-z]* )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i)
    if (claude) {
        const hours = (Number(claude[2]) % 12) + (claude[4]?.toLowerCase() === 'pm' ? 12 : 0)
        const reset = new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, Number(claude[3] ?? 0)),
        )
        const weekday = claude[1] ? weekdays.indexOf(claude[1].toLowerCase()) : -1
        if (weekday >= 0) reset.setUTCDate(reset.getUTCDate() + ((weekday - reset.getUTCDay() + 7) % 7))
        if (reset <= now) reset.setUTCDate(reset.getUTCDate() + (weekday >= 0 ? 7 : 1))
        return until(reset)
    }
    return fallback
}
