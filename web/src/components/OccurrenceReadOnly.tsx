import type { TaskOccurrence, UserSettings } from '../api/types'
import { completionTimeLabel } from '../lib/time'
import { OccurrenceSummary } from './RecordSummary'
import { Panel } from './shared'

export function OccurrenceReadOnly({ title, occurrence, settings, onClose }: { title: string; occurrence: TaskOccurrence; settings: UserSettings; onClose: () => void }) {
  return <Panel title={title} onClose={onClose}><div className="notice" role="status"><strong>Выполнение завершено</strong>{occurrence.completion && <p>Отмечено {completionTimeLabel(occurrence.completion.completedAt, settings.timezone)} · {settings.timezone}</p>}<p>Условия и размещение доступны для просмотра. Сначала снимите отметку выполнения, чтобы изменять их. Блок и его фиксация сохраняются.</p></div><OccurrenceSummary occurrence={occurrence} settings={settings} /></Panel>
}
