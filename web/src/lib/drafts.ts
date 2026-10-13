export interface VersionedDraft<Value, Base> { value: Value; base: Base }
export function openDraft<Value, Base>(saved: VersionedDraft<Value, Base> | undefined, value: Value, currentBase: Base): VersionedDraft<Value, Base> {
  // A fresh GET on reopen is not permission to overwrite a newer version with
  // old input. Only explicit user rebase can replace the stored baseline.
  return structuredClone(saved ?? { value, base: currentBase })
}
export function rebaseDraft<Value, Base>(draft: VersionedDraft<Value, Base>, currentBase: Base): VersionedDraft<Value, Base> { return { value: structuredClone(draft.value), base: structuredClone(currentBase) } }
