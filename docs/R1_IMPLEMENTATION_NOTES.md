# R1 — точные правила реализации

Статус: оформление ACCEPTED R1 от 17.10.2026. Источник — [DECISIONS.md](DECISIONS.md), запись R1 и ответ владельца «Утвердить R1 и реализовать; дробление позже» на [RECURRENCE_SLICE_PROPOSAL.md](RECURRENCE_SLICE_PROPOSAL.md). Эти заметки конкретизируют выбранный пакет; новый предметный срез не добавляется. Live wire — [d1.openapi.json](../contracts/d1.openapi.json), OpenAPI 3.1.0 / `info.version=3.0.0`. D1/C1 и правила S1 сохраняются с описанным ниже переходом sync на s2.

## API и данные

Три операции относительно `/api/v1`:

| Метод / путь | Вход → результат |
| --- | --- |
| POST /task-definitions/{id}/recurrence-rule | CreateRecurrenceRuleRequest →201 RecurrenceResponse; ETag rule, Location /api/v1/recurrence-rules/{ruleId} |
| GET /recurrence-rules/{id} | →200 RecurrenceResponse; согласованный rule/PlanState, ETag rule |
| POST /recurrence-rules/{id}/stop | StopRecurrenceRuleRequest + rule If-Match →200 RecurrenceResponse |

Новые закрытые DTO, все перечисленные поля обязательны:

- `RecurrenceRule={id,definitionId,pattern:"weekly",daysOfWeek,timezone,startDate,endDate,enabled,generatedThrough,serverVersion}`.
- `CreateRecurrenceRuleRequest={opId,id,definitionVersion,pattern:"weekly",daysOfWeek,timezone,startDate,endDate}`; route id — definition, body id — новый rule.
- `StopRecurrenceRuleRequest={opId}`.
- `RecurrenceResponse={rule,planState}`; созданные occurrences читаются через прежние GET/sync.

UUID/версии — строки; версии сравниваются только на равенство. ETag — quoted rule.serverVersion. Dates — реальные YYYY-MM-DD в пределах 0001–9999; endDate nullable и включённая, endDate>=startDate. daysOfWeek — непустое unique множество из семи прежних enum значений; ответ канонически monday..sunday. timezone — явно выбранная IANA зона, неизменяемая независимо от последующего settings.timezone. generatedThrough nullable: последняя **просмотренная включённая дата**, в том числе без подходящего weekday. Это не дата последнего созданного occurrence.

У definition ровно одно правило, включая stopped. Наличие правила определяет recurring; TaskDefinition не получает mode/oneOff или recurrenceId. Прежние определения/ручные occurrences не мигрируют по эвристике количества. Старое ручное occurrence с той же logicalDate сохраняется отдельно: новая уникальность относится только к generated slot, не ко всем выполнениям definition. Правило, остановленное или исчерпавшее endDate, остаётся историей повторяющейся задачи; enabled=false устанавливает только stop. Редактирование/возобновление/удаление правила, monthly/every-N/exceptions, split/таймер/цели/Android не входят.

## Команды, версии и guard

Identity/antiforgery, закрытые тела/unknown query rejection, per-user opId/fingerprint и immutable replay остаются D1/C1. Auth/CSRF заново даже для replay; replay до текущих version/state checks. Ошибки предметной команды с валидным opId сохраняются атомарно без bumps/log; транспорт/401/403/непарсируемое JSON/невалидный opId — без записи. Новая редакция/разрешение конфликта получает новый opId. Сохранённые D1/C1 OperationResults не переписываются; legacy replay по-прежнему только ACK и authoritative refresh, не merge body/ETag в shadow.

Create: структурная DTO проверка → собственный target definition (иначе404 notFound) → definitionVersion (412 staleDefinition) → cross-field date/zone и уникальность. Неверная зона/диапазон/пустые/повторённые weekdays —400 validationFailed; неизвестные/неподдерживаемые поля отклоняются как прежде. Занятый rule id —409 idUnavailable; существующее правило этого definition, включая stopped,—409 **recurrenceAlreadyExists**. Если обе уникальности нарушены, idUnavailable проверяется первым. Чужой id не раскрывает владельца. Create не требует If-Match: база явно в definitionVersion.

Атомарно под существующим UserPlanState guard сохраняются rule + начальная порция slots/occurrences + версии/PlanState + OperationResult + sync rows/head. Create повышает planningInputRevision один раз, даже если startDate за горизонтом; scheduleVersion не меняется. Версии/результат относятся к состоянию на commit, последующий worker может уже изменить rule до доставки HTTP.

Stop: собственный target404 → If-Match428/412 staleEntity → enabled. Актуальное true→false повышает rule.version/planningInputRevision один раз и пишет один recurrence change. Актуальное false→false —200 canonical no-op без bumps/log, но с сохранённым результатом нового opId. Отсутствующий/stale If-Match не обходится stopped-состоянием. Ответ412 содержит currentServerVersion/ETag; для authoritative rule используется GET/sync. Все slots, occurrences, блоки, active/revoked Completion и scheduleVersion сохраняются.

Worker, stop, definition/occurrence edits, placement, complete/reopen сериализуются тем же guard. Worker, выигравший до stop, сохраняет уже созданные будущие slots; выигравший stop запрещает следующую генерацию. Complete/reopen одного occurrence не влияет на правило/другие выполнения. Каждый generated occurrence имеет обычный изменяемый C1 snapshot; дальнейшая definition правка его не переписывает. Новые slots копируют актуальные definition constraints/sourceDefinitionVersion под guard. Placement/Completion/active targeting/readonly состояния соблюдают прежние D1/C1 guards.

## Горизонт и worker

При создании сохраняется внутренняя GenerationStartDate=max(startDate, локальная дата создания в rule.timezone). Backdated startDate допустима, но до GenerationStartDate история не создаётся. Этот boundary сохраняется; при смене timezone пользователя он не пересчитывается.

Один capture UTC now на порцию определяет today в зоне правила. Target=min(today+30 локальных календарных дат, endDate если есть, 9999-12-31): **31 дата включительно**, а не today+31. Арифметика через ограниченные DateOnly/DayNumber; без AddDays за год9999 и без UTC+24h. Если GenerationStartDate>target, порция пустая, generatedThrough остаётся null. В частности, будущий startDate за горизонтом не создаёт ранние slots и не продвигает watermark до startDate.

Начальная команда и каждый worker transaction просматривают не более31 последовательной даты. Первый день — GenerationStartDate либо день после generatedThrough. Последний — min(first+30,target). Каждый выбранный weekday создаёт ровно один slot и unplanned/incomplete occurrence с remaining=N, calendarBlock=null/completion=null. Constraints snapshot содержит полный fixedWork N, splitAllowed=false, requiredRestMinutes=0. No placement/UTC start не выводятся из weekday: DST gaps/overlaps решаются только при отдельном явном размещении прежним протоколом.

После простоя worker проходит все пропуски **после создания**, порциями≤31, не прыгает сразу на today. В одной порции generatedThrough идёт только вперёд до последней просмотренной даты, включая невыбранные дни; при откате часов target позади watermark — no-op. Если endDate достигнута, работа прекращается без удаления и без неявной смены enabled. Rule.version меняется при каждом реальном продвижении cursor. planningInputRevision повышается один раз на порцию с новыми occurrences, progress-only scan без новых occurrences его не меняет; scheduleVersion никогда не меняется генерацией. Нет прогресса — нет OperationResult/log/version bumps.

Для **каждой изменяющей worker-порции** обязательны новый внутренний UUID opId и OperationResult в той же transaction: status200/body RecurrenceResponse/quoted rule ETag/Location=null. Fingerprint имеет внутренний worker discriminator, недостижимый HTTP-командой; это не отдельный публичный endpoint. FK SyncChanges(UserId,OpId)→OperationResults сохраняется. Полный rollback включает result/slot/cursor/log/head. После commit повторный job перечитывает watermark, не создаёт дубликат даже с другим внутренним opId; уникальность слота — последний барьер. Локальная реализация worker обслуживает аккаунты/порции ограниченно, даёт stop/mutations занять guard и не держит одну transaction на весь backlog.

## Аддитивная схема и переход

RecurrenceRules: owner-composite id/FK definition, UNIQUE(UserId,DefinitionId); поля публичного rule + внутренняя GenerationStartDate. RecurrenceSlots: (UserId,RuleId,SlotDate) UNIQUE и owner FKs на rule/occurrence; UNIQUE(UserId,OccurrenceId). Slot key независим от rule.version, Completion и календарной даты блока. Ни существующий snapshot, ни старый manual occurrence для заполнения slot не захватываются.

SyncChanges получает Ordinal integer NOT NULL DEFAULT0 для старых single-item rows. Уникальность (UserId,StreamId,OpId) заменяется на (UserId,StreamId,OpId,Ordinal); старые id/sequence/opId/item/PlanState/timestamps и FK OperationResult сохраняются. В одной domain transaction выделяются consecutive sequences: rule первым, occurrences по slotDate; ordinal=0..n-1, максимум32rows на одну generation/create порцию. Все rows имеют один конечный post-command PlanState. Actual stop — одна row; no-op/replay/domain errors — ни одной. Existing single-item mutations пишут ordinal0.

Перед применением — backup/restore проверка координатора. Миграция добавляет таблицы/column и заменяет только необходимую уникальность индекса; не удаляет domain/OperationResults/Completion/log. Во время совместного cutover Backend/Web остановлены старые writers: **старые transient SyncSnapshots и SyncSnapshotItems discard**, затем создаются только s2 snapshots. Это технический кэш/pin, не пользовательская история. Не переиспользовать прежний s1 snapshot по stream/head/pageSize под новой оболочкой. Поток/sequence не сбрасываются из-за обновления формата; DB restore по-прежнему обязательно меняет streamId отдельной процедурой S1.

## Sync s2 и ограниченная публикация

Прежние семь s1 schemas/examples оставлены в OpenAPI как историческое описание. Live два GET используют SyncProtocolV2="s2", SyncItemKindV2/SyncItemV2, BootstrapPageV2/SyncChangeV2/ChangesPageV2. Имена V2 — компоненты документа; route остаётся /api/v1/sync/*. Новый kind recurrence несёт целый RecurrenceRule, включая stopped; прежние четыре aggregate replacement не меняются. Slot не передаётся отдельным item. Int64 sequence/ordinal/H не публикуются числом.

Новых query нет: только cursor/pageSize, initial default50,1..100; continuation наследует signed size, явное несоответствие400invalidCursor. Новый protected purpose **Vibe.S2.BootstrapPage** для страниц snapshot и **Vibe.S2.Delta** для asOf/delta. Все cursor привязаны к текущему owner/stream, bootstrap к snapshot/ordinal/pageSize, delta к after и optional horizon/pageSize. Старый s1/чужой/неподходящий purpose —400invalidCursor→bootstrap; тот же stream сам по себе не переводит pending в resetReview. Подлинный old stream/after<floor/after>head/H>head —410syncResetRequired; отрицательные/overflow/after>H —400invalidCursor. Backward cursor/пустой ложный успех запрещены.

Bootstrap материализуется под guard при committed head W; head не может оказаться внутри command group. Порядок settings/category/definition/occurrence/recurrence, внутри вида ordinal UUID; все pages одного snapshot публикуются вместе. **asOfCursor unbound после W**. Старые caps сохраняются и включают правила:4active snapshots/account,5000items/16MiB UTF8 payload, TTL15min, guard2s/build5s;409syncSnapshotTooLarge/429или503syncBootstrapBusy без partial snapshot. Автоудаление старых пользовательских occurrences для освобождения cap не входит.

Первый GET delta с unbound cursor после A captures **H=committed head**; protected page cursor сохраняет A/H/pageSize, append>H ждёт следующего прохода. hasMore=false возвращает **снова unbound cursor после H**, иначе будущие commits никогда не попадут в следующий проход. W и H — границы полностью committed групп. Horizon не pin: cleanup7суток может вызвать410 между страницами; snapshot pin/15min остаётся S1.

Одна команда может быть разделена pageSize=1, поэтому confirmed publisher **не применяет отдельные delta pages**. В каждой вкладке/account один serialized sync generation строит staging от последнего published shadow/cursor, собирает весь fixed-H проход, затем одним publish меняет shadow/cursor/PlanState. Одновременные ACK/GET/старые callbacks его не обходят; opaque entity versions не сортируются. Draft/base/frozen pending/target completionId не подставляются из нового shadow.

Routine local предел одного delta-прохода: **100 страниц,5000changes,16MiB суммы UTF8 JSON сериализованных change objects,30секунд monotonic elapsed** (включая ожидание сети). При достижении ровно предела terminal допускается; продолжение сверх лимита/timeout отменяет generation. До hasMore=false никакая часть не публикуется. Непрерывные записи не продлевают H/таймер.

При превышении discard staged pages и запустить **один** новый полный bootstrap+bounded catch-up; bootstrap публикуется только целиком и является безопасным отдельным committed W. Повторное превышение прекращает автоматический цикл: последняя целиком подтверждённая проекция остаётся видимой как stale, явный retry/backoff; freeze команды остаётся. Это не stream reset и не потеря pending. 401/смена owner прекращают публикацию и скрывают account UI; настоящий stream reset переводит любой незавершённый pending, включая acknowledgedRefresh, в resetReview. Никаких partialgroup publish/вечного retry/растущей памяти. После ACK pending освобождается только по прежнему CAS и успешному authoritative catch-up после ACK; bootstrap до ACK не доказывает результат. Caps — параметры локальной реализации, не новые SLA/retention promises.

## Приёмка и фактические проверки

Нужны meaningful server/Web проверки: unique slots и повтор worker; crash до/после commit result/log/cursor; same/different opId create/stop; stale definition/ETag и stopped no-op; stop/worker/definition edit/complete/reopen двух клиентов; owner isolation; независимые Completion и сохранённые блоки; no historical backfill; future start; end inclusive; catch-up нескольких порций; leap/year1/year9999/DST/смена settings.zone. Sync pageSize1 не публикует часть команды, terminal снова получает future writes; caps/постоянные записи/410/401/reset не зависают и не очищают frozen pending. Cutover сохраняет старые log/results и делает старый snapshot непригодным для reuse; old legacy replay не merge. SnapshotTooLarge показывает явное ограничение без потери истории.

В контрактной задаче не запускались build, migrations, HTTP и предметные тесты реализации. Фактические read-only проверки JSON/refs/examples фиксируются в contracts/README.md при передаче; результаты координатора маркируются отдельно.
