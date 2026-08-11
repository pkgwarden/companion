export interface PollOptions {
  timeoutMs: number
  intervalMs: number
  sleep?: (ms: number) => Promise<void>
}

export interface PollOutcome<T> {
  ok: boolean
  value: T
  attempts: number
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Polling, never sleeping: a fixed sleep either flakes or wastes minutes across a dozen stages. */
export async function pollFor<T>(
  probe: () => T | Promise<T>,
  accept: (value: T) => boolean,
  options: PollOptions,
): Promise<PollOutcome<T>> {
  const sleep = options.sleep ?? realSleep
  const deadline = Date.now() + options.timeoutMs
  let attempts = 0
  let value = await probe()
  attempts += 1
  while (!accept(value)) {
    if (Date.now() >= deadline || attempts * options.intervalMs >= options.timeoutMs) {
      return { ok: false, value, attempts }
    }
    await sleep(options.intervalMs)
    value = await probe()
    attempts += 1
  }
  return { ok: true, value, attempts }
}
