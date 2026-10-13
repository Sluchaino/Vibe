# Общий контракт D1

Статус: формализация выбранного владельцем 12.10.2026 пакета D1-01–05. Основание — [DECISIONS.md](../docs/DECISIONS.md) и [FIRST_SLICE_PROPOSAL.md](../docs/FIRST_SLICE_PROPOSAL.md). Формализация не утверждает остальные DRAFT ADR и не добавляет Android, solver или Completion UI.

[d1.openapi.json](d1.openapi.json) — единственный источник путей, DTO, enum, обязательных полей и примеров. OpenAPI 3.1.0; `info.version=1.0.0` — версия документа, `/api/v1` — версия маршрута. [D1_IMPLEMENTATION_NOTES.md](../docs/D1_IMPLEMENTATION_NOTES.md) определяет транзакционные и временные правила, которые не выражаются JSON Schema.

## Общие правила

- JSON использует camelCase; UUID и все версии — строки. Версии непрозрачны, сравнивать разрешено только на равенство. ETag — `serverVersion` в двойных кавычках.
- Каждый изменяемый DTO закрыт: неизвестные поля, неизвестные query-параметры, неподдерживаемые ограничения и противоречащие ветви команд отклоняются. Сервер не принимает owner/userId из тела.
- Отсутствующая/чужая ссылка даёт 404 `referenceNotFound` без раскрытия владельца. Другой собственный Place или попытка заменить существующий settings.place.id —400 `unsupportedConstraint`; принадлежность проверяется до объяснения возможностей чужого ресурса.
- Definition, occurrence, calendar block и факт завершения различаются. D1 не создаёт Completion. Occurrence хранит собственный `constraintsSnapshot` и исходную `sourceDefinitionVersion`; правка definition не переписывает снимок.
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
| GET /occurrences | pageSize?, cursor?, definitionId?, logicalDateFrom?, logicalDateTo?, placementStatus? → OccurrencePage |
| GET /occurrences/{id} | — → OccurrenceResponse; ETag occurrence |
| PUT /occurrences/{id} | UpdateOccurrenceRequest + If-Match → OccurrenceResponse |
| GET /calendar | from, to → CalendarResponse |
| POST /occurrences/{id}/placement | PlacementCommand + If-Match → OccurrenceResponse |

Удалений нет; категории только читаются/создаются. Этого пакета достаточно для пути «войти → задать место → создать definition → создать occurrence → разместить → перезагрузить → прочитать сохранённое».

## Identity и replay

Web/API используют один HTTPS origin. Auth cookie `__Host-Vibe.Session` и antiforgery cookie `__Host-Vibe.Antiforgery` имеют HttpOnly, Secure, SameSite=Strict, Path=/ и не имеют Domain. Browser отправляет cookie; приложение передаёт `X-CSRF-TOKEN` из bootstrap. Antiforgery обязателен на всех POST/PUT, включая login/logout и replay. После смены identity bootstrap получают заново.

`opId` обязателен для settings/category/definition/occurrence/placement. Login/logout — операции управления Identity-сеансом, без domain opId и без воспроизведения cookie/token из dedup. Это уточнение области предметных мутаций из пакета D1, подтверждённое координатором при оформлении контракта; новый auth-opId протокол не вводится.

Под общим guard пользователя сохраняются fingerprint и окончательный status/body/ETag/Location, атомарно с изменением либо с предметной ошибкой без изменения. Повтор идентичного opId воспроизводит прежний результат. Повтор с другим запросом — 409 `idempotencyMismatch`. Сохраняются предметные 400/404/409/412/428 при разбираемом JSON и валидном opId; транспорт, 401/403, неразбираемый JSON и невалидный/отсутствующий opId не сохраняются. Auth/antiforgery проверяются заново даже для replay. `Idempotency-Replayed` сообщает воспроизведение; клиент не затрёт свежий кэш старым ответом. Новая редакция/разрешение конфликта всегда получает новый opId. Автоматической очистки D1-history нет.

## Время и фиксация

Размещение задаёт `localStart` без offset, IANA `timezone` и явный `utcOffset`. Сервер проверяет их совместимость: gap отклоняется; overlap допускает только выбранный действительный offset. End выводится из N elapsed UTC minutes. Ручной ввод не сдвигается молча.

Availability сохраняет timezone, выбранные дни и локальные окна; `endDayOffset` описывает переход через полночь. Пустые обычные windows означают любые дни/время. DateExceptions дают явные границы/offset для конкретной даты, в том числе уточнение DST-границ. Полная семантика приведена в notes.

`effectiveFixed = block.fixed || snapshot.mobilityPolicy=="fixedAfterPlacement"`. Move/unplace закреплённого блока, снятие block.fixed и снятие защиты через PUT occurrence snapshot требуют `allowFixedChange=true`. `setFixed=false` не обходит fixedAfterPlacement. Подтверждение не разрешает нарушить объём, окна или отсутствие пересечений.

## Проверка и изменения

Проверки и их фактический статус перечислены в [notes](../docs/D1_IMPLEMENTATION_NOTES.md). Проверка структуры JSON/ссылок/примеров не доказывает серверную реализацию. Генератор клиентов/DTO, отдельные сервисы, новые auth flows и расширение общего API этим файлом не выбираются.

Изменения выбранной семантики или новые предметные возможности передаются координатору для выбора владельцем. Ручные C#/TypeScript DTO обязаны соответствовать OpenAPI; EF entities не служат wire DTO.
