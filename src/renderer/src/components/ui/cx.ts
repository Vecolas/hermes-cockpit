/** Junta classes ignorando falsy — sem dep (clsx-lite). */
export function cx(...parts: Array<string | false | null | undefined | 0>): string {
  return parts.filter(Boolean).join(' ')
}
