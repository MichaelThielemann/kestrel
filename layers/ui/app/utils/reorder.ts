export function reorder<T>(arr: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) {
    return [...arr]
  }
  const result = [...arr]
  result.splice(to, 0, result.splice(from, 1)[0] as T)
  return result
}
