export type StoppableServer = {
  stop(closeActiveConnections?: boolean): Promise<void>
}

export function createGracefulShutdown(
  server: StoppableServer,
  {
    gracePeriodMs = 25_000,
    log = console,
    dispose,
  }: {
    gracePeriodMs?: number
    log?: Pick<Console, 'log' | 'error'>
    /** Release request-scoped services after the server has drained. */
    dispose?: () => Promise<void>
  } = {},
): (signal: string) => void {
  let shuttingDown = false

  return (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.log(`Received ${signal}; draining Onara requests.`)

    const forceStop = setTimeout(() => {
      log.error(
        `Onara shutdown exceeded ${gracePeriodMs}ms; closing active connections.`,
      )
      void server.stop(true)
    }, gracePeriodMs)

    void server
      .stop()
      .then(async () => {
        await dispose?.()
        clearTimeout(forceStop)
        log.log('Onara server stopped.')
      })
      .catch((error) => {
        clearTimeout(forceStop)
        log.error(
          `Onara server shutdown failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
        process.exitCode = 1
      })
  }
}
