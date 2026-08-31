import { describe, expect, test } from 'bun:test'
import { createGracefulShutdown } from './graceful-shutdown'

describe('Bun graceful shutdown', () => {
  test('drains before force-closing in-flight requests', async () => {
    const calls: Array<boolean | undefined> = []
    let finishDrain: (() => void) | undefined
    const draining = new Promise<void>((resolve) => {
      finishDrain = resolve
    })
    const shutdown = createGracefulShutdown(
      {
        stop: (closeActiveConnections) => {
          calls.push(closeActiveConnections)
          return closeActiveConnections ? Promise.resolve() : draining
        },
      },
      {
        gracePeriodMs: 1,
        log: { log: () => {}, error: () => {} },
      },
    )

    shutdown('SIGTERM')
    expect(calls).toEqual([undefined])

    await Bun.sleep(5)
    expect(calls).toEqual([undefined, true])
    finishDrain?.()
  })

  test('handles repeated termination signals only once', () => {
    const calls: Array<boolean | undefined> = []
    const shutdown = createGracefulShutdown(
      {
        stop: (closeActiveConnections) => {
          calls.push(closeActiveConnections)
          return Promise.resolve()
        },
      },
      { log: { log: () => {}, error: () => {} } },
    )

    shutdown('SIGTERM')
    shutdown('SIGINT')

    expect(calls).toEqual([undefined])
  })
})
