import type { RecurrenceRule, SyncChange } from '../src/api/types.ts'
import { occurrenceFixture } from './completion-fixture.ts'
import { plan } from './sync-fixture.ts'
export function rule(overrides: Partial<RecurrenceRule> = {}): RecurrenceRule { return { id: 'a0000000-0000-4000-8000-000000000001', definitionId: occurrenceFixture().definitionId, timeIntent: null, pattern: 'weekly', daysOfWeek: ['monday', 'wednesday'], timezone: 'Europe/Berlin', startDate: '2026-10-17', endDate: null, enabled: true, generatedThrough: '2026-11-16', serverVersion: 'rule_1', ...overrides } as RecurrenceRule }
export function ruleChange(overrides: Partial<RecurrenceRule> = {}): SyncChange { return { id: crypto.randomUUID(), opId: crypto.randomUUID(), item: { kind: 'recurrence', value: rule(overrides) }, planState: plan } }
