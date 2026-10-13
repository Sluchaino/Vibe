export class IdentityState {
  epoch = 0
  userId: string | null = null
  private drafts = new Map<string, Map<string, unknown>>()
  activate(userId: string | null) { this.epoch++; this.userId = userId }
  getDraft<T>(userId: string, key: string): T | undefined { return this.drafts.get(userId)?.get(key) as T | undefined }
  setDraft<T>(userId: string, key: string, value: T) {
    let scope = this.drafts.get(userId)
    if (!scope) { scope = new Map(); this.drafts.set(userId, scope) }
    scope.set(key, structuredClone(value))
  }
  clearDraft(userId: string, key: string) { this.drafts.get(userId)?.delete(key) }
  clearIdentity(userId: string) { this.drafts.delete(userId) }
}
export const identityState = new IdentityState()
