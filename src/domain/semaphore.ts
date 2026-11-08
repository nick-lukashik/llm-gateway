type Waiter = {
    grant: () => void
    fail: (error: unknown) => void
}

/**
 * Calls at once to one provider, the rest wait first in, first out. A waiter
 * gives up after `maxWaitMs`, when its caller leaves (`signal`), or when the
 * whole queue is refused (`rejectWaiting`, a provider that hit its limit).
 */
export class Semaphore {
    private active = 0
    private readonly queue: Waiter[] = []

    constructor(readonly limit: number) {
        if (!Number.isInteger(limit) || limit < 1) throw new Error('Semaphore limit must be a positive integer')
    }

    get inFlight() {
        return this.active
    }

    get waiting() {
        return this.queue.length
    }

    /** Resolves with `release` once a slot is held; call it exactly once. */
    acquire(options: { maxWaitMs: number; onTimeout: () => Error; signal?: AbortSignal }): Promise<() => void> {
        const { signal } = options
        if (signal?.aborted) return Promise.reject(signal.reason)
        if (this.active < this.limit && this.queue.length === 0) {
            this.active++
            return Promise.resolve(this.releaser())
        }
        return new Promise((resolve, reject) => {
            let timer: NodeJS.Timeout | undefined
            const settle = () => {
                clearTimeout(timer)
                signal?.removeEventListener('abort', onAbort)
                const index = this.queue.indexOf(waiter)
                if (index >= 0) this.queue.splice(index, 1)
            }
            const waiter: Waiter = {
                grant: () => {
                    settle()
                    resolve(this.releaser())
                },
                fail: error => {
                    settle()
                    reject(error)
                },
            }
            const onAbort = () => waiter.fail(signal?.reason)
            timer = setTimeout(() => waiter.fail(options.onTimeout()), options.maxWaitMs)
            signal?.addEventListener('abort', onAbort, {
                once: true,
            })
            this.queue.push(waiter)
        })
    }

    /** Refuses every waiting caller with `error`; running calls go on. */
    rejectWaiting(error: () => Error) {
        for (const waiter of [
            ...this.queue,
        ])
            waiter.fail(error())
    }

    private releaser() {
        let released = false
        return () => {
            if (released) return
            released = true
            const next = this.queue[0]
            // The slot passes straight to the next waiter: `active` stays the same.
            if (next) next.grant()
            else this.active--
        }
    }
}
