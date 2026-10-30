import type { ProblemDetails } from '../api/types.ts'

export function bootstrapBusyMessage(problem: Pick<ProblemDetails, 'code' | 'status'>): string | null {
  return problem.code === 'syncBootstrapBusy' && (problem.status === 429 || problem.status === 503)
    ? 'Сервер занят подготовкой начальной загрузки. Повторите позже кнопкой «Обновить». Данные и черновики сохранены.'
    : null
}
