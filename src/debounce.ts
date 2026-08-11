/** Long enough that a typed word is one catalog call, short enough to feel like search-as-you-type. */
export const CATALOG_SEARCH_DEBOUNCE_MS = 250

export class Debouncer {
  private readonly delayMs: number
  private pending: ReturnType<typeof setTimeout> | null = null

  constructor(delayMs: number) {
    this.delayMs = delayMs
  }

  schedule(action: () => void): void {
    this.cancel()
    this.pending = setTimeout(() => {
      this.pending = null
      action()
    }, this.delayMs)
  }

  cancel(): void {
    if (this.pending !== null) {
      clearTimeout(this.pending)
      this.pending = null
    }
  }
}
