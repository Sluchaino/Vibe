# Общий контракт D1 + C1

Статус: D1-01–05 утверждён 12.10.2026; C1-01–05, ревизия 2 с отменой, утверждён 13.10.2026 ответом владельца «Утвердить C1 с отменой и реализовать». Основание — [DECISIONS.md](../docs/DECISIONS.md), [FIRST_SLICE_PROPOSAL.md](../docs/FIRST_SLICE_PROPOSAL.md) и [COMPLETION_SLICE_PROPOSAL.md](../docs/COMPLETION_SLICE_PROPOSAL.md). Остальные DRAFT ADR, Android, solver, таймер и статистика не утверждаются.

[d1.openapi.json](d1.openapi.json) — единственный источник путей, DTO, enum, обязательных полей и примеров. Имя файла сохранено; OpenAPI 3.1.0, `info.version=2.0.0` — новая редакция документа, `/api/v1` — прежняя версия маршрута. [D1_IMPLEMENTATION_NOTES.md](../docs/D1_IMPLEMENTATION_NOTES.md) и [утверждённый C1](../docs/COMPLETION_SLICE_PROPOSAL.md) определяют транзакционные и временные правила, которые не выражаются JSON Schema.

## Общие правила

- JSON использует camelCase; UUID и все версии — строки. Версии непрозрачны, сравнивать разрешено только на равенство. ETag — `serverVersion` в двойных кавычках.
- Каждый изменяемый DTO закрыт: неизвестные поля, неизвестные query-параметры, неподдерживаемые ограничения и противоречащие ветви команд отклоняются. Сервер не принимает owner/userId из тела.
- Отсутствующая/чужая ссылка даёт 404 `referenceNotFound` без раскрытия владельца. Другой собственный Place или попытка заменить существующий settings.place.id —400 `unsupportedConstraint`; принадлежность проверяется до объяснения возможностей чужого ресурса.
- Definition, occurrence, calendar block и факт завершения различаются. C1 добавляет отдельный ручной Completion и адресную отмену с историей; блок сам не завершает выполнение. Occurrence хранит собственный `constraintsSnapshot` и исходную `sourceDefinitionVersion`; правка definition не переписывает снимок.
- В D1 обязателен `durationPolicy={mode:"fixedWork",requiredWorkMinutes:N}`, `splitAllowed=false`, `requiredRestMinutes=0` и единственный явный `placeId`. Все эти поля передаются явно. Один блок покрывает полный N; не поместившийся объём остаётся незапланированным.
- День/неделя вычисляются в IANA зоне пользователя; начало недели — `monday`. Calendar читает UTC instant range, максимум 31 локальный день. Страницы списков содержат максимум 100 объектов.
- Все личные ответы и ошибки имеют `Cache-Control: no-store`. API возвращает JSON 401 вместо HTML redirect.

## Поверхность

| Метод / путь относительно /api/v1 | Request → response |
| --- | --- |
| GET /auth/antiforgery | — → AntiforgeryResponse |
| POST /auth/login | LoginRequest → MeResponse; Set-Cookie |
| POST /auth/logout | без тела → 204; cookie истекает |
| GET /me | — → MeResponse |
| GET /settings | — → SettingsResponse; ETag settings |
| PUT /settings | UpdateSettingsRequest + If-Match → SettingsResponse |
| GET /categories | pageSize?, cursor? → CategoryPage |
| POST /categories | CreateCategoryRequest → 201 CategoryResponse |
| GET /task-definitions | pageSize?, cursor? → DefinitionPage |
| POST /task-definitions | CreateDefinitionRequest → 201 DefinitionResponse |
| GET /task-definitions/{id} | — → DefinitionResponse; ETag definition |
| PUT /task-definitions/{id} | UpdateDefinitionRequest + If-Match → DefinitionResponse |
| POST /task-definitions/{id}/occurrences | CreateOccurrenceRequest → 201 OccurrenceResponse |
| GET /occurrences | pageSize?, cursor?, definitionId?, logicalDateFrom?, logicalDateTo?, placementStatus?, completionStatus? → OccurrencePage |
| GET /occurrences/{id} | — → OccurrenceResponse; ETag occurrence |
| PUT /occurrences/{id} | UpdateOccurrenceRequest + If-Match → OccurrenceResponse |
| GET /calendar | from, to → CalendarResponse |
| POST /occurrences/{id}/placement | PlacementCommand + If-Match → OccurrenceResponse |
| POST /occurrences/{id}/completion | CompleteOccurrenceRequest + If-Match → 200 OccurrenceResponse |
| POST /occurrences/{id}/completion/reopen | ReopenOccurrenceRequest + If-Match → 200 OccurrenceResponse |

Удалений нет; категории только читаются/создаются. Этого пакета достаточно для пути «войти → задать место → создать definition → создать occurrence → разместить → перезагрузить → прочитать сохранённое».

## Identity и replay

Web/API используют один HTTPS origin. Auth cookie `__Host-Vibe.Session` и antiforgery cookie `__Host-Vibe.Antiforgery` имеют HttpOnly, Secure, SameSite=Strict, Path=/ и не имеют Domain. Browser отправляет cookie; приложение передаёт `X-CSRF-TOKEN` из bootstrap. Antiforgery обязателен на всех POST/PUT, включая login/logout и replay. После смены identity bootstrap получают заново.

`opId` обязателен для settings/category/definition/occurrence/placement/complete/reopen. Login/logout — операции управления Identity-сеансом, без domain opId и без воспроизведения cookie/token из dedup. Это уточнение области предметных мутаций из пакета D1, подтверждённое координатором при оформлении контракта; новый auth-opId протокол не вводится.

Под общим guard пользователя сохраняются fingerprint и окончательный status/body/ETag/Location, атомарно с изменением либо с предметной ошибкой без изменения. Повтор идентичного opId воспроизводит прежний результат. Повтор с другим запросом — 409 `idempotencyMismatch`. Сохраняются предметные 400/404/409/412/428 при разбираемом JSON и валидном opId; транспорт, 401/403, неразбираемый JSON и невалидный/отсутствующий opId не сохраняются. Auth/antiforgery проверяются заново даже для replay. `Idempotency-Replayed` сообщает воспроизведение; клиент не затрёт свежий кэш старым ответом. Новая редакция/разрешение конфликта всегда получает новый opId. Автоматической очистки D1-history нет.

## Время и фиксация

Размещение задаёт `localStart` без offset, IANA `timezone` и явный `utcOffset`. Сервер проверяет их совместимость: gap отклоняется; overlap допускает только выбранный действительный offset. End выводится из N elapsed UTC minutes. Ручной ввод не сдвигается молча.

Availability сохраняет timezone, выбранные дни и локальные окна; `endDayOffset` описывает переход через полночь. Пустые обычные windows означают любые дни/время. DateExceptions дают явные границы/offset для конкретной даты, в том числе уточнение DST-границ. Полная семантика приведена в notes.

`effectiveFixed = block.fixed || snapshot.mobilityPolicy=="fixedAfterPlacement"`. Move/unplace закреплённого блока, снятие block.fixed и снятие защиты через PUT occurrence snapshot требуют `allowFixedChange=true`. `setFixed=false` не обходит fixedAfterPlacement. Подтверждение не разрешает нарушить объём, окна или отсутствие пересечений.

## Обратимая отметка C1

Complete тело — `{opId}`; reopen — `{opId,completionId}`. Оба закрыты, требуют occurrence If-Match и сохраняют блок/scheduleVersion. Факт содержит серверные id/version, source=manual, completedAt и revokedAt; UTC формат отдельный `YYYY-MM-DDTHH:mm:ss.fffZ`, без подстановки плановых минут в измеренное время.

Свежий TaskOccurrence обязательно содержит completionStatus и completion. Active факт имеет revokedAt=null; отсутствие active — completion=null/incomplete/remaining=N, наличие — completed/remaining=0. Полный N в snapshot и длительность сохранённого блока не меняются. При active PUT/все placement actions запрещены; после reopen обычные D1 guards. Редактирование definition не делает снимок исторических metadata.

Только реальные complete/reopen переходы повышают occurrence.version/planningInputRevision; block.version/scheduleVersion остаются прежними. Новый запрос сначала проверяет If-Match (428/412), затем состояние/target. Свежий повтор complete на active или reopen уже revoked id без нового active —200 canonical no-op без bumps. Старый revoked id при новом active —409 completionMismatch. Для отмены нового факта нужен его id и новое явное действие; исходные completedAt/context не меняются, revoked история не удаляется/не реактивируется.

GET occurrences добавляет необязательный completionStatus=incomplete|completed. Actionable unplanned использует `placementStatus=unplanned&completionStatus=incomplete`, оба фильтра применяются до paging. Без нового фильтра прежний placementStatus сохраняет смысл. Cursor включает новый фильтр, при смене фильтра UI начинает первую страницу; предел 100 и calendar range 31 день сохраняются.

Новые поля/remaining=0 изменяют закрытый D1 read-контракт; утверждён совместный переход Backend/Web с reload старых вкладок. Сохранённые OperationResults не переписываются. Для старого occurrence mutation replay спецификация разрешает точную LegacyD1 ветвь только при `Idempotency-Replayed=true`; свежие GET/результаты всегда C1. Отсутствие completion в legacy не означает incomplete. Клиент ACK подтверждает по opId и обязательно перечитывает authoritative occurrence/страницы/calendar, не применяя старое body/ETag/currentOccurrence — в том числе после late reopen A, когда уже создан факт B.

## Проверка и изменения

Проверки D1 перечислены в [notes](../docs/D1_IMPLEMENTATION_NOTES.md), C1 — в [утверждённом пакете](../docs/COMPLETION_SLICE_PROPOSAL.md). 13.10.2026 выполнена read-only проверка сохранённого JSON: openapi-spec-validator — PASS; 403 внутренних ссылки, 90 schema/media примеров с jsonschema FormatChecker и 24 отклоняемых C1 случая — PASS. Сверка с прежним D1 подтвердила неизменность четырёх auth/me paths, security schemes, 20 входных/placement/constraints/time схем и точность двух LegacyD1 схем. Итог: 15 paths, 20 operations, 57 schemas.

Проверка структуры JSON/ссылок/примеров не доказывает серверную реализацию. В этой контрактной задаче build, HTTP и предметные тесты C1 не запускались. Генератор клиентов/DTO, отдельные сервисы, новые auth flows и расширение общего API этим файлом не выбираются.

Изменения выбранной семантики или новые предметные возможности передаются координатору для выбора владельцем. Ручные C#/TypeScript DTO обязаны соответствовать OpenAPI; EF entities не служат wire DTO.
