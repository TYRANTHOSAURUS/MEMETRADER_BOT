/** Safe time formatter — returns '—' for missing/invalid timestamps */
export function fmtTime(ts: number | undefined | null, slice: [number, number] = [11, 19]): string {
  if (!ts || isNaN(ts)) return '—'
  try {
    return new Date(ts).toISOString().slice(slice[0], slice[1])
  } catch {
    return '—'
  }
}
