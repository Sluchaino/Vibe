# U1 — точные правила реализации

Статус: ACCEPTED,19.10.2026. Основание — [DECISIONS.md](DECISIONS.md), ответ владельца «Утвердить U1 и реализовать» на [UNIFIED_TASK_FORM_PROPOSAL.md](UNIFIED_TASK_FORM_PROPOSAL.md). Live [OpenAPI](../contracts/d1.openapi.json):3.1.0, info.version4.0.0. Это оформление выбранного пакета; Android/split/solver/production/commit/push не входят. Прежние [D1](D1_IMPLEMENTATION_NOTES.md), [C1](COMPLETION_SLICE_PROPOSAL.md), [S1](S1_IMPLEMENTATION_NOTES.md), [R1](R1_IMPLEMENTATION_NOTES.md) действуют вне явно перечисленных изменений.

## Wire и создание

Новых paths и атомарного общего create endpoint нет. Используются прежние definition→occurrence либо definition→rule команды. Единая форма собирает весь ввод до первого POST и сохраняет независимую durable continuation. Один пользовательский Create может вести последовательный UI workflow: следующий HTTP шаг только после authoritative ACK и catch-up предыдущего; durable intent записывается до каждого HTTP, один pending slot/CAS/identity guards соблюдаются. Ошибка/конфликт останавливает workflow; crash/reload восстанавливает шаг из confirmed state+намерения с теми же IDs, исходный unknown результат повторяет тот же opId. Definition ACK не является ACK occurrence/rule/placement. Показывать пользователю implementation DTO шаги не требуется. Не вводить массовую offline outbox зависимостей и не терять дату/часы после очистки submitted draft.

Fresh schemas: TaskDefinitionU1/CreateDefinitionRequestU1/UpdateDefinitionRequestU1; ConstraintsInputU1/ConstraintsSnapshotU1; TaskOccurrenceU1/CreateOccurrenceRequestU1/UpdateOccurrenceRequestU1; RecurrenceRuleU1/CreateRecurrenceRuleRequestU1; соответствующие ResponseU1/PageU1/CalendarResponseU1, MutationResponseU1/ProblemDetailsU1. Все object DTO/union ветви закрыты; wire поля явно required, nullable означает JSON null, не пропуск. Остальные metadata, Place/availability, splitAllowed=false и requiredRestMinutes=0 прежние. Пустое описание передаётся пустой строкой, категория null; только UI не требует от пользователя заполнить description/volume/time/date. UUID и opaque versions остаются строками.

- WorkOrigin=manual|interval|unspecified.
- ConstraintsInputU1: manual требует прежний положительный fixedWork N; interval/unspecified требуют durationPolicy=null. Определение interval хранит правило вычисления, не N одной выбранной даты.
- ConstraintsSnapshotU1: manual+fixedN, unspecified+null, interval+серверный fixedN либоnull при невозможности resolution.
- TaskOccurrenceU1 добавляет nullable logicalDate/remainingWorkMinutes, timeIntent/resolvedTiming/placementIssue.
- TimeIntent=null означает нет часов. Иначе {timezone,startLocalTime,endLocalTime,endDayOffset,startDisambiguation,endDisambiguation}; часы HH:mm nullable, offset Int32≥0≤3652058, disambiguation earlier|later|null.
- ResolvedTiming=null либо {startInstant,endInstant}; серверный сохранённый результат вычисления, **не блок/не занятость**.
- PlacementIssue=null либо invalidLocalTime|ambiguousLocalTime|workMismatch|placementConflict|outsideAvailability|outOfRange.

CreateOccurrenceRequestU1={opId,id,definitionVersion,logicalDate,timeIntent}; сервер копирует constraints и вычисляет intervalN. UpdateOccurrenceRequestU1={opId,logicalDate,constraintsSnapshot:ConstraintsInputU1,timeIntent,allowFixedChange}; interval input null, read snapshot N не отправляется как ручной объём. Definition input содержит workOrigin рядом с durationPolicy. ServerVersion/owner/resolvedTiming/placementIssue в изменяемых телах запрещены.

## Дата, границы и объём

logicalDate=null — действительно без даты. В All отдельная группа «Без даты»; today/week/month/custom исключают её. Нельзя заменить null сегодняшним днём. GET occurrences без date range включает null, любой logicalDateFrom/To исключает null в SQL до paging. Порядок/cursor UUID прежние, новых query нет. Date-only occurrence показывается карточкой соответствующего дня без занятого времени. Calendar GET по-прежнему возвращает aggregate только пересекающихся блоков; карточки без блока выводятся из sync shadow.

Для часов нужна logicalDate. Start относится к этой дате; end — date+явный endDayOffset. При null соответствующего часа disambiguation=null; при null end offset=0. Объект с двумя null часами запрещён: следует передать timeIntent=null. Ночь указывается явно offset1; меньший end не превращается в следующие сутки. DateOnly/DayNumber arithmetic checked, реальные даты0001–9999; offset не даёт права выйти за границу года9999. Все выходные instants — UTC прежнего формата; завершения по-прежнему отдельный миллисекундный CompletionInstant.

| Ввод | Результат |
| --- | --- |
| Нет часов, нет N | duration=null/unspecified, без блока |
| Дата без часов | Карточка дня; с N или без N, без блока |
| Только start или end, N не задан | Частичное timeIntent сохраняется, resolvedTiming=null/issue=null, без блока |
| Оба часа, объём автоматический | workOrigin=interval; сервер выводит N из полного elapsed интервала на эту дату |
| Start+manualN | Start resolve, end=start+N elapsed minutes; соседняя дата явно показана |
| End+manualN | End resolve, start=end−N; предыдущая дата явно показана |
| Оба часа+manualN | Интервал обязан точно равняться N; объём не меняется |

Полный разрешённый интервал требует endInstant>startInstant, целого положительного числа elapsed minutes≤2147483647. Никаких wall-clock subtraction/UTC+24h. Автоматический N не является измеренным полезным временем. Смена автоматических часов пересчитывает N; ручное N никогда не теряется/не масштабируется. Для полного interval намерения без явно введённого N UI выставляет interval, а не unspecified. На initial create/PUT interval origin без обоих часов и unspecified с двумя часами —400validationFailed без подмены provenance; manual без N/unspecified с N также400. Один час+unspecified допустим: null resolution/issue, без блока.

Definition edit может сделать уже существующее shared намерение несовместимым с новым происхождением объёма. Worker не зацикливается на400: future slot full-hours rule+новый unspecified сохраняет unknownN/workMismatch без блока с продвижением watermark; interval origin без полного shared намерения также сохраняет nullN/workMismatch. Старые slots не меняются, hidden manual→interval/default60 преобразования нет.

ResolvedTiming хранится отдельно даже если занятое время создать не удалось. Выведенные соседние даты показываются через полные instants в timeIntent.timezone и переживают reload. Shared rule хранит только введённые часы, не фиксирует выведенный end/start конкретной даты.

## DST и безопасное размещение

Локальные границы разрешаются в IANA зоне. Gap→invalidLocalTime. Overlap без disambiguation→ambiguousLocalTime; earlier/later выбирает соответствующий UTC instant. На обычной дате выбор игнорируется только как неактуальное предпочтение DST; не фиксирует старый UTC offset для всех сезонов. Производная от manualN граница получается UTC арифметикой, а не повторным независимым разрешением местного времени.

При новом U1 create occurrence и при генерации U1 rule slot выполняется **одна** resolution/auto-place попытка. Полные часы либо одна граница+manualN дают candidate. No hours/частичные unknown часы не создают candidate; resolvedTiming/issue=null. Для interval N вычисляется до проверки availability/overlap; при этих отказах snapshot сохраняет вычисленный N. При gap/overlap/range intervalN остаётся null; ручное N сохраняется всегда.

На явном create occurrence/rule структурные/cross-field ошибки (date null с часами, zone mismatch, неподдерживаемые поля) —400 без нового ресурса. Если на выбранной initial logicalDate/startDate все границы разрешимы и их интервал неположителен/нецелый либо противоречит manualN, также400 без ресурса. Это проверка согласованности введённых значений, не перенос/исправление. Gap/неразрешённый overlap не мешают сохранить намерение и дают unplanned+issue. На последующих rule dates любое несоответствие сохраняет слот без блока; worker не откатывает всю серию из-за одного дня.

Разрешимый candidate проверяется по прежним availability и отсутствию пересечений. Неразрешённые/неподтверждённые границы availability дают outsideAvailability («Не удалось подтвердить разрешённое окно»), не замалчиваются. Выход дат/instants из представимого диапазона→outOfRange; несовпадение N/положительности→workMismatch. Конфликт→placementConflict; не выдавать данные другого пользователя. При отказе HTTP201 всё равно сохраняет occurrence с видимой placementIssue, без block; остальные slots/chunk продолжаются. При успехе block покрывает **полный N**, planned=true, issue=null; fixed=false, защита через прежний snapshot.mobilityPolicy fixedAfterPlacement. Сама настройка фиксации без блока не занимает время.

Конфликты проверяются под UserPlanState guard против committed DB **и уже добавленных tracked blocks текущей порции**. Даты обрабатываются по slotDate ascending; поздний candidate не перезаписывает ранний/чужой block. Job не двигает/не растягивает блоки, не освобождает чужое время, не повторяет auto-place старого slot после исчезновения конфликта. Решение —явная правка/размещение владельца прежними действиями. Catch-up после простоя сохраняет заданные после создания даты, даже если они уже в прошлом: это календарный план, не факт работы/Completion.

PUT occurrence вычисляет/сохраняет новый intent/resolution/intervalN, **не делает auto-place**. Новый resolved candidate без блока размещается отдельной явной placement командой. Предыдущий placementIssue при смене намерения очищается либо заменяется текущей resolution issue; block не меняется. Existing block требует date!=null, прежнего полного N/availability; несовместимость409invalidExistingPlacement. Сначала явный unplace, затем изменение, затем явный place. Active: Match-first→occurrenceCompleted до новых references; incomplete: D1 references/date→Match. allowFixedChange не обходит active/protection.

Manual placement сохраняет прежний localStart+IANA+explicit utcOffset протокол и schedule guard. При null logicalDate/N новый place/move400validationFailed: сначала явный PUT даты/N либо разрешимого interval. Никаких скрытых даты/60минут. Manual place/move не переписывает предпочтение timeIntent/resolvedTiming; успех очищает issue. Unplace/setFixed не запускают auto retry. Пользователь может намеренно разместить известный полный N в другое время; исходное намерение не является блоком.

## Weekly и everyN

RecurrenceRuleU1 — закрытый union. Weekly сохраняет R1 поля и добавляет nullable timeIntent. Interval вместо daysOfWeek содержит intervalDays:Int32≥1 и anchorDate; startDate=anchorDate, endDate nullable/inclusive. Selected date либо явно показанный день создания в зоне становятся frozen anchor **до команды**; сервер не подставляет текущий день молча. Weekly presets —наборы дней; interval не пересекается с weekday filter. No repeat создаёт одно occurrence, отдельного одноразового mode поля нет.

Timezone shared intent совпадает с rule.timezone и фиксирована независимо от settings. EveryN phase=(slot.DayNumber−anchor.DayNumber)%N==0; вычислять в checked Int64, не AddDays(N). Boundary GenerationStartDate=max(startDate,local creationDate) предотвращает pre-creation backfill, но **не становится новым anchor**. Future start за today+30 не продвигает generatedThrough/не создаёт ранних slots. Catch-up≤31 последовательной даты/transaction, horizon today..today+30 включительно, endDate/year9999 clamp, generatedThrough —последняя просмотренная дата, а не matching slot.

Новые slots копируют актуальный definition/sourceDefinitionVersion под guard, затем interval intent выводит per-date N в новом snapshot. ManualN одинаков и не сокращается; при DST только одной введённой границы выведенный второй wall time может отличаться по датам. При двух введённых часах automatic N может отличаться из-за DST. Existing occurrences/blocks/Completion не пересчитываются от definition/timezone/worker.

Rule create/read/stop paths прежние, по одному rule/definition включаяstopped. Initial create проверяет definitionVersion; stop Match-first/новый opId, stopped canonical no-op. Stop сохраняет все future occurrences и auto-created blocks. Rule edit/resume/delete/split/monthly не добавляются.

## Атомарность, ревизии и история

Guard, ownership, exact canonical fingerprint и per-user dedup остаются D1. Перед любой legacy адаптацией вычисляется fingerprint исходных method/resolvedpath/query/If-Match/body; повтор replay до актуальных version/state checks. Не добавлять поля во frozen pending и не пересчитывать base/opId. HTTP401/403/транспорт/JSON/opId правила прежние. Новые успешные команды возвращают U1; старый OperationResult сохраняет status/body/ETag/Location точно, включая старую ошибку/currentOccurrence. MutationResponseU1 допускает старые closed ветви **только replay**, не fresh read. ACK требует sync catch-up, не merge тела.

- Create definition/actual definition edit: прежний input bump.
- Create occurrence: input+1; schedule+1 только если создан block.
- Create rule: input+1 на всю начальную порцию; schedule+1 если появился хотя бы один block.
- Worker chunk с новыми occurrences: input+1, schedule+1 если появились blocks; progress-only watermark —rule.version/log без input/schedule bumps.
- PUT occurrence: input bump, без schedule; block никогда не меняется.
- Complete/reopen: occurrence/input bump только при реальном переходе; block/schedule прежние. Unknown incomplete remaining=null, completed0, reopen сноваnull. KnownN соответственно N/0/N; объём/длина блока не фактические минуты.
- Stop: input bump только true→false, schedule прежний. Replay/no-op/domain error не дают log/bumps.

Worker сохраняет свой внутренний opId+OperationResult200 RecurrenceResponseU1/ETag/Location=null вместе с rule/slot/occurrence/block/revisions/log/head. Existing FK OperationResult и unique(UserId,StreamId,OpId,Ordinal) сохраняются. Rule row первым, occurrences по slotDate; block вложен, отдельного sync item нет. Максимум32 single-item rows/порцию; все rows имеют конечный post-command PlanState. Atomic rollback не оставляет slot/result/block/head частично. Stop/definition edit/placement/complete/reopen используют тот же guard.

Новые Completion context фиксируют nullable logicalDate/sourceDefinitionVersion/полный U1 snapshot и timeIntent/resolvedTiming на момент отметки. Не добавлять фактические минуты. Старые immutable Completion/context, revoked история и старые sourceDefinitionVersion не дополняются/переписываются. Правила адресной отмены completionId/late replay/одногоactive C1 сохраняются; active snapshot/placement readonly.

## Аддитивная миграция и s3

Nullable Occurrences.LogicalDate; новые nullable timeIntent/resolvedTiming/placementIssue columns (jsonb/string) у occurrence, nullable sharedTimeIntent и pattern/intervalDays/anchorDate у rule. Старый rule читается weekly с intent=null; старый definition/snapshot без workOrigin читается manual с прежним N. Старый JSON **не backfill/rewrite**, старые block/Completion/log/results/versions не меняются. Новые constraints сохраняются U1 только новой командой. Частичное намерение и resolved interval сохраняются на сервере, не только в draft. Composite ownership FK/unique slot и существующие positive fixedN constraints сохраняются с nullable ветвью.

До миграции backup+restore проверяет координатор; technical legacy-column/JSON hashes должны совпасть после additive migration. Остановить старые writers на cutover. Только transient SyncSnapshots/Items discard, чтобы не reuse старую форму; domain/OperationResults/Completion/log/streamId не сбрасывать. Изменение формата само не DB restore. Данные R1/UX/port configuration не трогать.

Live GET sync protocol=s3: SyncProtocolV3/SyncItemV3/BootstrapPageV3/SyncChangeV3/ChangesPageV3. Те же5kinds. Purpose Vibe.S3.BootstrapPage/Vibe.S3.Delta, прежние owner bindings/cursor/pageSize наследование. Старыйs1/s2 token400invalidCursor→bootstrap, pending не удаляется; настоящий stream reset переводит любой незавершённый pending вresetReview по S1.

При чтении старого immutable log нормализовать **копию того ItemJson**: definition добавить manual; occurrence constraints добавить manual, timeIntent/resolvedTiming/issue=null; recurrence добавить intent=null. Сохранить historical id/opId/opaqueversion/logsequence/порядок/postPlanState, никогда не строить old change из нынешней entity. C1 feed уже содержит completionStatus/completion; не придумывать их из старого D1 replay —replay не является log source. Новые s3 item проходят strict U1 validation. Unknown/malformed stored shape не пропускать и не продвигать cursor; явный отказ вместо потери изменения.

Прежние fixed-H semantics/caps сохраняются: bootstrap committedW/asOfUNBOUND; первыйdelta capturesH, continuation хранитH/pageSize, terminal сноваUNBOUNDafterH. Staging всего bounded прохода, no partialgroup publish;100pages/5000changes/16MiB/30s →discard, одинbootstrap/catch-up, затемstale/явныйretry. Snapshot4/account/TTL15min/5000items/16MiB, guard2s/build5s, exact-head reuse и429/503/409 прежние; U1 не вводит eviction/stale snapshot fallback. Retention7суток/pins/reset процедуры прежние.

Confirmed state единственный publisher; новая nullabledate/work не создаёт отдельный GET cache. Legacy GET/read-adapter при тех же entity versions не сортируется как новая редакция. Old/new ACK не merge, освобождение pending только после authoritative tail после ACK и CAS. Старые frozen requests принимаются точными legacy ветвями: definition→manualN, createOccurrence безintent→старыйunplanned, updateOccurrence безintent→сохранить нынешнийintent; новая U1 правка может очистить его только explicitnull. Старый R1 createRule→weekly+nullintent, не auto-place. Legacy snapshot PUT на уже U1 interval/context подчиняется обычным guards, не обходит fullN/active. Existing drafts открываются по прежнему draftId; old N/start/weekly settings сохраняются, не превращаются в новые defaults. Если результат pending ещё неизвестен, миграция UI не переупаковывает его в новый DTO.

## Проверки и передача

Meaningful проверки реализации: undated All/Без даты и SQL filters beforepaging; unknown/partial/persisted intent; start+N/end+N/overnight explicitoffset; manualN mismatch; DST gap/overlap/elapsedN; boundaryyears1/9999/overflow; everyNphase/downtime/nobackfill; oldrule без внезапныхblocks; batch tracked-block overlap; failedslot сохраняется; schedule/input bumps одинраз; complete/reopenunknown и lateoldreplay; двухклиентныеcrash/CAS/старыеdrafts/pending; immutablelegacyJSON/hash migration; s3 historical log projection без current entity lookup; oldtokens/caps/401/reset.

В этой контрактной задаче build/migrations/HTTP/предметные тесты не запускались. Координатор фактически выполнил сохранённым Python checker OpenAPI/765refs/212examples с FormatChecker —PASS,20paths/25operations/104schemas; strict compatibility всех74legacycomponents —PASS. Собственные read-only JSON/reference/closed schema проверки перечислены в contracts/README при передаче.
