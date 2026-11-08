import { describe, expect, it } from 'vitest'
import { Semaphore } from './semaphore.js'

const forever = {
    maxWaitMs: 60_000,
    onTimeout: () => new Error('timeout'),
}

describe('Semaphore', () => {
    it('runs up to its limit and hands slots on first in, first out', async () => {
        const slots = new Semaphore(2)
        const a = await slots.acquire(forever)
        const b = await slots.acquire(forever)
        expect(slots.inFlight).toBe(2)
        const order: string[] = []
        const c = slots.acquire(forever).then(release => {
            order.push('c')
            return release
        })
        const d = slots.acquire(forever).then(release => {
            order.push('d')
            return release
        })
        expect(slots.waiting).toBe(2)
        b()
        b() // a second release of the same slot does nothing
        const releaseC = await c
        expect(order).toEqual([
            'c',
        ])
        expect(slots.inFlight).toBe(2)
        a()
        const releaseD = await d
        expect(order).toEqual([
            'c',
            'd',
        ])
        releaseC()
        releaseD()
        expect(slots.inFlight).toBe(0)
        expect(slots.waiting).toBe(0)
    })

    it('gives up after the longest wait', async () => {
        const slots = new Semaphore(1)
        const held = await slots.acquire(forever)
        await expect(
            slots.acquire({
                maxWaitMs: 20,
                onTimeout: () => new Error('no slot'),
            }),
        ).rejects.toThrow('no slot')
        expect(slots.waiting).toBe(0)
        held()
        expect(slots.inFlight).toBe(0)
    })

    it('drops a waiter whose caller left, and refuses the whole queue on demand', async () => {
        const slots = new Semaphore(1)
        const held = await slots.acquire(forever)
        const leaving = new AbortController()
        const left = slots.acquire({
            ...forever,
            signal: leaving.signal,
        })
        const refused = [
            slots.acquire(forever),
            slots.acquire(forever),
        ]
        leaving.abort(new Error('gone'))
        await expect(left).rejects.toThrow('gone')
        slots.rejectWaiting(() => new Error('paused'))
        for (const waiter of refused) await expect(waiter).rejects.toThrow('paused')
        expect(slots.waiting).toBe(0)
        held()
        expect(slots.inFlight).toBe(0)
        // Free again: the next caller gets a slot at once.
        ;(await slots.acquire(forever))()
    })
})
