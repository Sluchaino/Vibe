# Общий контракт D1 + C1 + S1 + R1 + U1

Статус: D1-01–05 утверждён 12.10.2026; C1-01–05, ревизия 2 с отменой, утверждён 13.10.2026 ответом владельца «Утвердить C1 с отменой и реализовать»; S1-01–06 утверждён 15.10.2026: «Утвердить S1 и реализовать (рекомендуется)». Основание — [DECISIONS.md](../docs/DECISIONS.md), [FIRST_SLICE_PROPOSAL.md](../docs/FIRST_SLICE_PROPOSAL.md), [COMPLETION_SLICE_PROPOSAL.md](../docs/COMPLETION_SLICE_PROPOSAL.md) и [SYNC_SLICE_PROPOSAL.md](../docs/SYNC_SLICE_PROPOSAL.md). R1 утверждён 17.10.2026: «Утвердить R1 и реализовать; дробление позже»; источник — запись R1 в DECISIONS и [RECURRENCE_SLICE_PROPOSAL.md](../docs/RECURRENCE_SLICE_PROPOSAL.md). U1 принят19.10.2026 ответом «Утвердить U1 и реализовать» на [UNIFIED_TASK_FORM_PROPOSAL.md](../docs/UNIFIED_TASK_FORM_PROPOSAL.md), запись U1 в DECISIONS. Остальные DRAFT ADR, Android, solver, таймер и статистика не утверждаются.

[d1.openapi.json](d1.openapi.json) — единственный источник путей, DTO, enum, обязательных полей и примеров. Имя файла сохранено; OpenAPI 3.1.0, `info.version=4.0.0` — U1 с совместным переходом live sync Backend/Web на s3, `/api/v1` — прежняя версия маршрута. [D1_IMPLEMENTATION_NOTES.md](../docs/D1_IMPLEMENTATION_NOTES.md), [утверждённый C1](../docs/COMPLETION_SLICE_PROPOSAL.md) и [S1_IMPLEMENTATION_NOTES.md](../docs/S1_IMPLEMENTATION_NOTES.md) и [R1_IMPLEMENTATION_NOTES.md](../docs/R1_IMPLEMENTATION_NOTES.md) и [U1_IMPLEMENTATION_NOTES.md](../docs/U1_IMPLEMENTATION_NOTES.md) определяют транзакционные и временные правила, которые не выражаются JSON Schema.

## Общие правила

Ниже сохранена база D1/C1/R1. U1 расширяет date/work/intent и live sync; точные действующие исключения перечислены в разделе U1 и [U1 notes](../docs/U1_IMPLEMENTATION_NOTES.md). Старые74 схемы остаются историческими/legacy ветвями.

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
| GET /task-definitions | pageSize?, cursor? → DefinitionPageU1 |
| POST /task-definitions | CreateDefinitionRequestU1 (или legacy) →201 DefinitionMutationResponseU1 |
| GET /task-definitions/{id} | — → DefinitionResponseU1; ETag definition |
| PUT /task-definitions/{id} | UpdateDefinitionRequestU1 (или legacy) + If-Match → DefinitionMutationResponseU1 |
| POST /task-definitions/{id}/occurrences | CreateOccurrenceRequestU1 (или legacy) →201 OccurrenceMutationResponseU1 |
| GET /occurrences | pageSize?, cursor?, definitionId?, logicalDateFrom?, logicalDateTo?, placementStatus?, completionStatus? → OccurrencePageU1 |
| GET /occurrences/{id} | — → OccurrenceResponseU1; ETag occurrence |
| PUT /occurrences/{id} | UpdateOccurrenceRequestU1 (или legacy) + If-Match → OccurrenceMutationResponseU1 |
| GET /calendar | from, to → CalendarResponseU1 |
| POST /occurrences/{id}/placement | PlacementCommand + If-Match → OccurrenceMutationResponseU1 |
| POST /occurrences/{id}/completion | CompleteOccurrenceRequest + If-Match →200 OccurrenceMutationResponseU1 |
| POST /occurrences/{id}/completion/reopen | ReopenOccurrenceRequest + If-Match → 200 OccurrenceResponse |
| POST /task-definitions/{id}/recurrence-rule | CreateRecurrenceRuleRequestU1 (или legacy) →201 RecurrenceMutationResponseU1; ETag rule |
| GET /recurrence-rules/{id} | — → RecurrenceResponseU1; ETag rule |
| POST /recurrence-rules/{id}/stop | StopRecurrenceRuleRequest + rule If-Match → RecurrenceMutationResponseU1 |
| GET /sync/bootstrap | pageSize?, cursor? → BootstrapPageV3; согласованный временный снимок s3 |
| GET /sync/changes | cursor, pageSize? → ChangesPageV3; fixed-H delta s3 |

Удалений нет; категории только читаются/создаются. Этого пакета достаточно для пути «войти → задать место → создать definition → создать occurrence → разместить → перезагрузить → прочитать сохранённое».

## Identity и replay

Web/API используют один HTTPS origin. Auth cookie `__Host-Vibe.Session` и antiforgery cookie `__Host-Vibe.Antiforgery` имеют HttpOnly, Secure, SameSite=Strict, Path=/ и не имеют Domain. Browser отправляет cookie; приложение передаёт `X-CSRF-TOKEN` из bootstrap. Antiforgery обязателен на всех POST/PUT, включая login/logout и replay. После смены identity bootstrap получают заново.

`opId` обязателен для settings/category/definition/occurrence/placement/complete/reopen и R1 create-rule/stop. Login/logout — операции управления Identity-сеансом, без domain opId и без воспроизведения cookie/token из dedup. Это уточнение области предметных мутаций из пакета D1, подтверждённое координатором при оформлении контракта; новый auth-opId протокол не вводится.

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

## Синхронизация S1

Следующие абзацы описывают сохранённую базу S1. В R1 live GET используют s2 и V2 schemas; прежние s1 schemas/examples оставлены исторически, правила перехода ниже.

Добавлены семь schemas: SyncProtocol, SyncItemKind, SyncCursor, SyncItem, BootstrapPage, SyncChange, ChangesPage. SyncItem полностью заменяет settings/category/definition/occurrence существующими C1 DTO; calendarBlock=null удаляет прежний вложенный блок, completion=null снимает active проекцию, не server history. С1 пути/DTO/примеры/replay не меняются, кроме добавления четырёх error codes для новых GET.

Initial pageSize default50, диапазон1–100; continuation наследует размер из защищённого cursor, явный другой размер даёт400. Поэтому SyncPageSize не содержит безусловный schema.default. Bootstrap page/delta purpose раздельны, owner/stream защищены; Int64 sequence остаётся внутри opaque cursor. Старый/утраченный cursor даёт явный400/410, новый snapshot не уничтожает pending.

Bootstrap под общим guard материализует immutable snapshot/head/PlanState и pin; terminal page публикуется целиком. Delta фиксирует horizon H; append>H ждёт следующего прохода. Log/data/result атомарны; category имеет свой sequence без input bump, no-op/replay/ошибки не создают changes. Cleanup: 7 суток, TTL15 минут; snapshot pin защищает floor, delta horizon его не удерживает. Пределы snapshot/account4, items5000/16MiB на снимок, guard/build2/5s; 429/503 syncBootstrapBusy, 409 syncSnapshotTooLarge без partial snapshot. Это выбранные локальные параметры, не SLA.

Confirmed Web shadow/cursor имеет единственного publisher в каждой вкладке, хранится в памяти; reload запускает bootstrap. IndexedDB отдельно сохраняет drafts/одну frozen pending-команду на account/origin с CAS. ACK/старый GET не merge в synced shadow; новые base/action/completionId не подставляются молча. Restore обязательно меняет streamId; любой незавершённый pending, включая acknowledgedRefresh, требует resetReview. OperationResults/Completion history не чистятся. Полная offline outbox, Android и solver остаются за границей S1; подробности и проверки — [S1 notes](../docs/S1_IMPLEMENTATION_NOTES.md).

## Повторения R1 и sync s2

`RecurrenceRule` отделён от definition/occurrence: id, definitionId, pattern="weekly", daysOfWeek (1–7 unique), IANA timezone, startDate, nullable inclusive endDate, enabled, nullable generatedThrough и opaque serverVersion. `CreateRecurrenceRuleRequest` добавляет opId/id/definitionVersion к конфигурации; `StopRecurrenceRuleRequest={opId}`; `RecurrenceResponse={rule,planState}`. Все четыре DTO закрыты и все поля обязательны. Наличие правила, включая stopped, определяет recurring; нового oneOff/mode поля у TaskDefinition нет.

Create атомарно сохраняет правило и начальную порцию генерации. По definitionVersion —412 staleDefinition; занятый id —409 idUnavailable; уже существующее правило definition —409 recurrenceAlreadyExists. Stop проверяет rule If-Match до состояния (428/412), false с актуальной версией —canonical200 no-op; true→false сохраняет уже созданные future occurrences, блоки и Completion. История/opId/replay остаются immutable; новый stop после worker требует актуальную базу и новый opId.

Worker расширяет постоянное правило до today+30 в его зоне:31 локальная дата включительно, endDate/год9999 ограничивают target. Порция≤31 последовательной даты, без истории до max(startDate,creationLocalDate), с catch-up пропусков после создания. generatedThrough —последняя просмотренная дата, включая невыбранный weekday. Будущий startDate за горизонтом оставляет null/без ранних occurrences. Каждый slot создаёт обычное unplanned/incomplete C1 occurrence с полным N; timezone не меняется от settings, DST не превращает date-only slot в неявное размещение.

UserPlanState guard атомарно связывает rule/slots/occurrences/versions/OperationResult/log/head. Каждая реальная worker порция имеет внутренний opId/OperationResult; FK сохраняется. Single-item log теперь допускает несколько consecutive rows одного opId с internal ordinal0..n-1, rule первым, occurrences по дате; старые rows получают ordinal0 без переписывания history. Новый kind recurrence —полный rule replacement; прежние четыре C1 aggregate формы не меняются. Подробности input/schedule bumps, schema и guards —[R1 notes](../docs/R1_IMPLEMENTATION_NOTES.md).

Live schemas: SyncProtocolV2 const "s2", SyncItemKindV2, SyncItemV2, BootstrapPageV2, SyncChangeV2, ChangesPageV2; SyncCursor общий opaque string. Query всё те же cursor/pageSize. Purpose Vibe.S2.BootstrapPage/Vibe.S2.Delta; bootstrap asOf и terminal delta cursor **unbound**, первый delta captures H, continuation сохраняет H/pageSize, terminal вновь unbound после H для будущих writes. Int64 наружу не выходит. При совместном cutover старые transient snapshots/items discard; domain/log/results и streamId сохраняются. Старые s1 cursors дают400invalidCursor→bootstrap, это само по себе не stream reset. Restore меняет streamId и сохраняет прежние resetReview guards.

Delta pages одного fixed-H прохода staging до hasMore=false, без публикации части command group. Локальный cap100pages/5000changes/16MiB UTF8 JSON changes/30s monotonic: discard staging →один bootstrap/catch-up →при повторном превышении stale/явный retry, без вечного цикла/очистки pending. Append>H не продлевает проход. Snapshot caps5000items/16MiB включают правила; история для освобождения места не удаляется. Старый ACK/GET/legacy body не merge в shadow; draft/base/frozen pending/CAS/401/owner/reset rules S1 сохраняются.

Web создаёт definition и rule отдельными явными существующим/новым шагами, без обещания общей HTTP атомарности; frozen pending/сохранённая continuation не превращаются в outbox dependency chain. Дробление, auto placement серии, rule edit/resume/delete, every-N/monthly/exceptions, weekly goals, Android не входят. Полный R1 не равен всему F06.

## Единая форма U1 и sync s3

Nullable date/work — действительные состояния. `logicalDate=null` попадает в All/«Без даты», любой date range исключает null до paging; дата без часов —карточка без занятия времени. Новых query нет. Часы/объём60/09:00 не подставляются.

`WorkOrigin=manual|interval|unspecified`. Definition и ConstraintsInputU1 используют manual+fixedN либо interval/unspecified+null; intervalN вычисляет сервер на каждую дату в ConstraintsSnapshotU1. Incomplete remaining=N/null, completed0, reopenN/null. Полный knownN и существующие блоки не сокращаются, фактические минуты не выдумываются.

`TimeIntent={timezone,startLocalTime,endLocalTime,endDayOffset,startDisambiguation,endDisambiguation}` либоnull; часы nullable, явный offset задаёт ночь/соседние дни, earlier/later/null разрешает overlap. Один час без N сохраняется как partial без блока. Start+N/end+N выводят вторую границу; полный interval выводит elapsedN; ручной N при двух часах должен совпасть. `ResolvedTiming={startInstant,endInstant}` либоnull сохраняет результат и соседние даты даже при конфликте; он сам не block. `PlacementIssue` сообщает gap/overlap/workMismatch/conflict/availability/range без скрытого shift/retry.

CreateOccurrenceRequestU1={opId,id,definitionVersion,logicalDate,timeIntent}. Новое тело делает одну auto-place попытку под guard: при конфликте/DST occurrence201 сохраняется unplanned с reason; partial сохраняется без блока. UpdateOccurrenceRequestU1={opId,logicalDate,constraintsSnapshot:ConstraintsInputU1,timeIntent,allowFixedChange}: PUT сохраняет/пересчитывает intent/N, не auto-place и не меняет block. Прежние active/incomplete/If-Match/protection guards остаются.

Weekly rule добавляет shared timeIntent; interval rule вместо daysOfWeek имеет intervalDays/anchorDate=startDate. Дата привязки явно выбрана/показана и frozen, phase не сдвигается после downtime; horizon31/catch-up≤31/unique slots прежние. Новые slots с полным временем пытаются разместиться, DB+tracked overlaps проверяются вместе. ManualN неизменен, automaticN per-date elapsed. Failed slot остаётся, stop сохраняет будущие blocks/Completion. Input/schedule bumps один раз на command/chunk, schedule только при новых blocks.

Все прежние74 schemas/results/log/history сохраняются. Fresh read refs *U1, legacy closed input принимается отдельной ветвью, fingerprint берётся до адаптации. Legacy createOccurrence/createRule остаются без auto-place; legacy PUT сохраняет имеющийся intent. Exact replay никогда не нормализуется/не merge в shadow. Старые drafts/frozen pending сохраняют ID/opId/base; последовательный UI workflow после одного Create допускается только после authoritative ACK+catch-up, с durable continuation до каждого HTTP и остановкой при ошибке, без массовой offline dependency outbox.

Live sync теперь s3: SyncProtocolV3/SyncItemV3/BootstrapPageV3/SyncChangeV3/ChangesPageV3. Пять прежних kinds; старый ItemJson нормализуется **в копии самого historical row**, не из нынешней entity: manual provenance, null intent/resolution/issue. Stored rows/versions/PlanState не переписываются. Совместный cutover discards только transient snapshots/items, s1/s2 purposes→400invalidCursor/bootstrap, streamId не меняется. Fixed-H/terminal-unbound, whole-pass staging/caps, retention/pins/429 exact-head reuse/resetReview/CAS/401 guards сохранены. Подробности —[U1 notes](../docs/U1_IMPLEMENTATION_NOTES.md).

## Проверка и изменения

Проверки D1 перечислены в [notes](../docs/D1_IMPLEMENTATION_NOTES.md), C1 — в [утверждённом пакете](../docs/COMPLETION_SLICE_PROPOSAL.md), S1 — в [S1 notes](../docs/S1_IMPLEMENTATION_NOTES.md). 13.10.2026 выполнена read-only проверка сохранённого JSON: openapi-spec-validator — PASS; 403 внутренних ссылки, 90 schema/media примеров с jsonschema FormatChecker и 24 отклоняемых C1 случая — PASS. Сверка с прежним D1 подтвердила неизменность четырёх auth/me paths, security schemes, 20 входных/placement/constraints/time схем и точность двух LegacyD1 схем. Итог C1: 15 paths, 20 operations, 57 schemas.

15.10.2026 полный validator координатора для S1 —PASS: 474 ссылки/119 примеров, 17 paths/22 operations/64 schemas; дополнительно68 negative cases —PASS. Структурная сверка architect сохранила все C1 paths и прежние схемы/примеры, кроме добавления4 code enum; новые object DTO/union ветви закрыты. Ограничение дополнительного локального Python checker и незапущенные проверки реализации указаны в S1 notes.

17.10.2026 R1: собственная read-only проверка сохранённого JSON parse/local refs —PASS (567 ссылок); структурная совместимость —PASS для всех15 D1/C1 paths и63 прежних schemas, в ProblemDetails только добавлен recurrenceAlreadyExists. Исторические S1 schemas/examples сохранены. Проверены12 закрытых object DTO/union ветвей, все обязательные поля и уникальность25 operationId;20 примеров новых schemas и64 negative cases (лишние/пропущенные поля, days/pattern/protocol/kind/array caps) —PASS собственным ограниченным schema checker. Он не заменяет полный JSON Schema validator. Координатор отдельно выполнил сохранённым .tools/openapi-venv check-c1-contract.py: OpenAPI/567refs/150examples с FormatChecker —PASS;20paths/25operations/74schemas.

19.10.2026 U1: координатор фактически выполнил full OpenAPI validator/765refs/212examples с FormatChecker —PASS;20paths/25operations/104schemas. Strict compatibility всех74 прежних schemas —PASS. Собственная read-only проверка сохранённого JSON: parse/765refs,28 новых closed object/union форм,53 примера новых schemas и181 negative case —PASS ограниченным schema checker, который не заменяет полный validator. Все74 legacy schemas и прежние response components/parameters/headers/security schemes сохранены структурно. Build/migrations/HTTP этим агентом не запускались.

Проверка структуры JSON/ссылок/примеров не доказывает серверную реализацию. В этой контрактной задаче build, HTTP и предметные тесты C1 не запускались. Генератор клиентов/DTO, отдельные сервисы, новые auth flows и расширение общего API этим файлом не выбираются.

Изменения выбранной семантики или новые предметные возможности передаются координатору для выбора владельцем. Ручные C#/TypeScript DTO обязаны соответствовать OpenAPI; EF entities не служат wire DTO.
