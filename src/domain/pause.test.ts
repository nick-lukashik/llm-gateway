import { describe, expect, it } from 'vitest'
import { pauseSeconds } from './pause.js'

const now = new Date('2026-10-28T03:00:00Z') // a Wednesday
const fallback = 3600

describe('pauseSeconds', () => {
    it("reads Codex's reset time today or tomorrow, plus a minute", () => {
        expect(pauseSeconds("You've hit your usage limit. Try again at 5:03 AM.", now, fallback)).toBe(
            2 * 3600 + 3 * 60 + 60,
        )
        // 1:00 AM has passed: tomorrow, capped at 12 hours.
        expect(pauseSeconds('try again at 1:00 AM', now, fallback)).toBe(12 * 3600)
        expect(pauseSeconds('Try again at 12:30 PM', now, fallback)).toBe(9 * 3600 + 30 * 60 + 60)
    })

    it("reads Codex's dated reset and ignores one already past", () => {
        expect(pauseSeconds('try again at Oct 28th, 2026 1:28 PM.', now, fallback)).toBe(10 * 3600 + 28 * 60 + 60)
        // More than 12 hours away: capped.
        expect(pauseSeconds('try again at Oct 5th, 2027 1:28 PM', now, fallback)).toBe(12 * 3600)
        expect(pauseSeconds('try again at Oct 5th, 2026 1:28 PM', now, fallback)).toBe(fallback)
    })

    it("reads Claude's session and weekly resets", () => {
        expect(pauseSeconds("You've hit your session limit · resets 3:45am", now, fallback)).toBe(45 * 60 + 60)
        expect(pauseSeconds('resets 2am', now, fallback)).toBe(12 * 3600)
        expect(pauseSeconds('resets 5am', now, fallback)).toBe(2 * 3600 + 60)
        // Wednesday 03:00 → Thursday 12:00am is 21 hours: capped.
        expect(pauseSeconds('weekly limit · resets Thu 12:00am', now, fallback)).toBe(12 * 3600)
        // Same weekday, later today.
        expect(pauseSeconds('resets Wed 4:00am', now, fallback)).toBe(3600 + 60)
    })

    it('uses Retry-After (at most 6 hours) and falls back otherwise', () => {
        expect(pauseSeconds('MiniMax limit reached (retry after 120 s): busy', now, fallback)).toBe(120)
        expect(pauseSeconds('retry after 90000 s', now, fallback)).toBe(6 * 3600)
        expect(pauseSeconds('quota exceeded', now, fallback)).toBe(fallback)
        expect(pauseSeconds(null, now, fallback)).toBe(fallback)
    })
})
