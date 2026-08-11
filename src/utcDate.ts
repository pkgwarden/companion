/** `YYYY-MM-DD` in UTC, or null when the value is not a usable date. */
export function formatUtcDate(value: string | number): string | null {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10)
}
