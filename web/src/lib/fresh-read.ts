// ACKs (including old/legacy replay bodies) never become current read models.
export async function freshAfterAcknowledgement<T>(readCurrent: () => Promise<T>, refreshRelated: () => Promise<void>, scopeCurrent: () => boolean, publish: (value: T) => void) {
  await refreshRelated()
  if (!scopeCurrent()) return false
  const current = await readCurrent()
  if (!scopeCurrent()) return false
  publish(current)
  return true
}
