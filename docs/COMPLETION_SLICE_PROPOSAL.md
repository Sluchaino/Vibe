# C1 — обратимая отметка выполнения в Web

Ревизия 2, **ACCEPTED / 13.10.2026**. Владелец ответил «Утвердить C1 с отменой и реализовать» на вопрос по этой ревизии; координатор записал C1 и точные границы в [DECISIONS.md](DECISIONS.md). Утверждены C1-01–05, описанные API/схема/правила и реализация Backend/Web. Уточнение C10 «нужна возможность снять отметку “Выполнено”» учтено. Ревизия 1 без отмены — **SUPERSEDED-PROPOSAL**, не принята владельцем.

Основание: [PRODUCT.md](PRODUCT.md), [DATA_MODEL.md](DATA_MODEL.md), [D1](FIRST_SLICE_PROPOSAL.md), [D1 notes](D1_IMPLEMENTATION_NOTES.md), [SYNC_DESIGN.md](SYNC_DESIGN.md), [live контракт D1+C1](../contracts/d1.openapi.json). Другие ADR не утверждаются. Разрешённая реализация следует оформленному общему контракту; ACCEPTED не означает, что код и проверки C1 уже выполнены.

Последующая локальная реализация завершена 14.10.2026. Фактические Backend/Web, migration, browser и reviewer результаты приведены в [C1_STATUS.md](C1_STATUS.md); нижние записи подготовки контракта относятся к работе architect, а не к итоговой проверке приложения.

## Что увидит владелец

Для одного выполнения — кнопки «Отметить выполненным» и «Снять отметку». Пример: у задачи «Читать» созданы выполнения за сегодня и за завтра. Отметка/снятие у сегодняшнего меняет только сегодняшнее; у завтрашнего статус не меняется.

Можно отметить → снять → отметить снова. История отметок/отмен сохраняется. Календарный блок остаётся на своём месте с прежней длительностью; ни отметка, ни снятие не освобождают время. Измеренное полезное время эти кнопки не создают.

## Утверждённый пакет ревизии 2

| ID / статус | Выбор владельца |
| --- | --- |
| C1-01 ACCEPTED | Ручная аттестация полного fixedWork конкретного occurrence. Новый Completion с серверными UUID/version и completedAt UTC; не выводить фактические минуты из N/блока |
| C1-02 ACCEPTED | Ровно ноль или один действующий факт; revoked факты не удаляются. Reopen отменяет конкретный активный id, следующее complete создаёт новый id. При active remaining=0, без active remaining=N текущего snapshot |
| C1-03 ACCEPTED | Блок/его version и расписание не меняются при complete/reopen, остаются занятыми и участвуют в overlap. При active snapshot/logicalDate/placement read-only; после reopen снова обычные D1 действия |
| C1-04 ACCEPTED | Два targeted POST с occurrence If-Match/opId/guard; старый запрос отмены не применяется к новой отметке. Только реальный переход меняет occurrence version/input revision; schedule/block не меняются |
| C1-05 ACCEPTED | Согласованно обновить Backend/Web и закрытые occurrence DTO на /api/v1; сохранить legacy replay bytes/refresh. Additive таблица истории с ownership FK и partial unique active; фильтр completionStatus до paging |

Удаление/прямая правка фактов, освобождение резерва, timer/work intervals, статистика/цели, sync, Android и solver остаются вне C1. Отмена ручной отметки **больше не отложена**.

## Данные и интерфейс

- Active означает `revokedAt=null`. Отмена один раз заполняет серверный revokedAt и меняет Completion.serverVersion; id/occurrenceId/source/completedAt и внутренний контекст факта неизменны. Отменённый факт никогда не активируется снова.
- CompletedAt и revokedAt — серверное UTC время принятия соответствующего действия: `YYYY-MM-DDTHH:mm:ss.fffZ`, миллисекунда. Они не равны logicalDate/границам блока или измеренному времени работы. Часы не выбирают победителя; порядок защищён guard/версиями, а не предположением монотонности wall clock.
- При отметке сервер сохраняет внутреннюю неизменяемую копию `{logicalDate,sourceDefinitionVersion,constraintsSnapshot}`. После reopen и последующих D1 правок старое подтверждение сохраняет прежний смысл/плановый N. Это контекст аттестации, не usefulSeconds/таймер/измеренная длительность.
- Complete/reopen не меняют logicalDate, snapshot, sourceDefinitionVersion, block UUID/start/end/fixed/version. RequiredWorkMinutes=N не обнуляется. При active остаток 0; после reopen остаток N, а не предполагаемые «неотработанные минуты».
- UI разделяет завершение и размещение. `placementStatus=planned|unplanned` определяется только блоком. Calendar показывает elapsed `(end-start)/60000=N`, а не remaining=0; DST не меняет N.
- При active PUT occurrence и все `place|move|unplace|setFixed`, включая no-op/allowFixedChange=true, запрещены. После reopen применяются D1 duration/availability/fixed/overlap guards; снятие отметки не снимает фиксацию блока.
- Снятие отменяет отметку, а не откатывает условия/календарь к старой копии. После reopen разрешённые осознанные D1 правки остаются обычными правками. Другие occurrence/definition не меняются.
- В карточке — текущий статус, «Отмечено выполненным …» для active и кнопка снятия. После действий — authoritative refresh. Статусы других выполнений не угадываются и не меняются массово.
- Metadata definition остаются live по D1. Новый исторический snapshot названий/категорий/характеристик, просмотр полной истории и статистика не добавляются; отменённая история сохраняется в БД для последующего согласованного использования.

Будущий блок после отметки остаётся занят и конфликтует с новой задачей. Снять отметку можно; освобождение/перенос после снятия возможно только отдельными обычными D1 действиями пользователя.

## Точный API

Оба POST: Identity/cookie/`X-CSRF-TOKEN`, обязательный `If-Match: "occurrenceVersion"`, owner из сеанса; ответ **200 OccurrenceResponse**, ETag occurrence и Idempotency-Replayed. BaseScheduleVersion/allowFixedChange не нужны: расписание не меняется.

`POST /api/v1/occurrences/{id}/completion` — закрытый CompleteOccurrenceRequest:

```json
{"opId":"60000000-0000-4000-8000-000000000010"}
```

`POST /api/v1/occurrences/{id}/completion/reopen` — закрытый ReopenOccurrenceRequest; completionId берётся из актуального active факта:

```json
{"opId":"60000000-0000-4000-8000-000000000011","completionId":"70000000-0000-4000-8000-000000000010"}
```

У обоих только указанные обязательные UUID поля. Клиент не задаёт completedAt/revokedAt/source/owner/минуты или новый Completion id. Лишние body/query поля отклоняются. Факт читается существующими GET occurrence/list/calendar; отдельный CRUD/history endpoint в C1 не нужен.

| DTO / query | Точное изменение |
| --- | --- |
| Completion | Все обязательны: `{id:UUID,occurrenceId:UUID,completedAt:CompletionInstant,revokedAt:CompletionInstant\|null,source:"manual",serverVersion:opaque string}` |
| TaskOccurrence C1 | Поля D1 сохранены; обязательны новые `completionStatus:"incomplete"\|"completed"` и `completion:Completion\|null`; remainingWorkMinutes integer ≥0 |
| OccurrenceResponse | `{occurrence:TaskOccurrence C1,planState:PlanState}`; ETag относится к occurrence |
| ProblemDetails | D1 формат плюс codes `occurrenceCompleted` и `completionMismatch`; currentOccurrence/currentServerVersion/ETag только текущего владельца |
| GET /occurrences | Необязательный `completionStatus=incomplete\|completed`, отсутствие —все статусы; прежние фильтры D1 сохраняются |
| GET /occurrences/{id}, страницы, calendar.occurrences | C1 projection с **только active** Completion либо null, из того же согласованного read-снимка |

Completion=null ⇔ incomplete и remaining=N; Completion!=null ⇔ completed и remaining=0, вложенный revokedAt всегда null. Исторические revoked rows не загружаются вместо active и не расширяют все страницы бесконечной историей. DTO не доверяет клиентскому userId.

Рабочий unplanned: `placementStatus=unplanned&completionStatus=incomplete`. SQL фильтрует до OrderBy/Take(pageSize+1); старый placementStatus без нового фильтра по-прежнему включает completed без блока. После reopen выполнение без блока снова появляется в рабочем списке. Все/completed показывают соответствующие текущие состояния, не число исторических отметок.

Новый фильтр включён в identity/kind/filter cursor. Смена фильтра сбрасывает страницу; старый D1 cursor с теми же прежними параметрами продолжает all-status список, с новым фильтром —400 invalidCursor. UUID order/лимит 100 и mutable paging D1 сохраняются.

## Переходы, targeting и гонки

Для нового opId: закрытый DTO → собственный target/404 → **If-Match первым** → проверка состояния/targeted Completion. Для reopen lookup completionId ограничен owner+этим occurrence; отсутствующий/чужой/относящийся к другому occurrence факт —404 referenceNotFound. Target occurrence отсутствующий/чужой —404 notFound.

| Команда на свежем ETag | Результат / версии |
| --- | --- |
| complete без active | Новый факт/id/context; occurrence.version и planningInputRevision увеличить |
| complete при active | 200 с тем же canonical active; только новый operation result, без bumps |
| reopen с id текущего active | Один раз поставить revokedAt/новую fact version; occurrence.version и planningInputRevision увеличить; active=null |
| reopen с уже revoked id этого occurrence и **без нового active** | 200 текущего incomplete состояния, без новых timestamps/bumps; не откатывать последующие D1 правки |
| reopen старого id, когда появился другой active | 409 completionMismatch с currentOccurrence/ETag; новый факт не отменять |
| PUT/placement при active | 409 occurrenceCompleted после If-Match; after reopen —D1 |

Старый ETag у **любого нового** complete/reopen/PUT/placement даёт 412 staleEntity до этих правил, даже если операция кажется эквивалентной. Missing If-Match —428. У active placement проверяет completion до baseScheduleVersion; PUT —до новых snapshot references/availability. Структурно неверный DTO по-прежнему 400.

Same opId/fingerprint возвращает **исходные bytes/status/ETag** до проверки сегодняшней версии/состояния; different payload/path/If-Match/query —409 idempotencyMismatch. Changing intent/base/target требует нового opId. Authentication/CSRF повторно обязательны. Окончательные предметные ошибки сохраняются без bumps по D1; transport/401/403/invalid JSON/opId —нет.

Пример защиты: complete A → reopen R(A) → complete B. Поздний identical R возвращает старый ACK с incomplete, **не пишет** и не отменяет B. Новая R2(A) со старым ETag —412; R3(A) со свежим ETag —409 completionMismatch. Чтобы отменить B, пользователь перечитывает состояние и явно отправляет новый opId с B.id/current ETag. Автоматически подменять target A на B нельзя.

Две новые команды на одной базе сериализуются guard: реально изменившая состояние первая увеличивает occurrence version, вторая получает 412. Если первая —logical no-op без bumps, вторая может пройти на той же базе; uniqueness/state rules всё равно действуют. Complete/complete создают один active; reopen/reopen отменяют один раз. После победившего complete placement/PUT с той же базой —412, с новой —409; после reopen на новой базе D1 действия разрешены. Reopen против fresh complete на active допускает либо no-op complete затем reopen, либо reopen затем stale complete —согласно guard, без воскрешения старого факта.

Каждый реальный переход, fact history/version, occurrence version, input revision и result —одна PostgreSQL transaction. ScheduleVersion и block/version **не меняются** при complete/reopen/no-op/replay. Чтения occurrence/active/block/planState остаются согласованными D1 snapshots.

Ошибки 400/401/403/404/412/428 и D1 formatting сохраняются; новые 409 occurrenceCompleted/completionMismatch, прежний idempotencyMismatch. Нельзя выводить полезные минуты или квалификацию будущих недельных целей из счётчика complete/reopen.

## Закрытая совместимость и хранение

Новые поля/remaining=0 несовместимы с закрытым D1 read DTO. Утверждён совместный переход поддерживаемого Backend/Web на C1 при /api/v1 и reload старых вкладок; поддержка старого Web не обещается. Live OpenAPI оформлен в прежнем contracts/d1.openapi.json, info.version=2.0.0 — новая редакция документа, не новый маршрут.

Сохранённые OperationResults не переписываются/не очищаются. Контракт сохраняет legacy D1 ветвь для replay старых occurrence success/errors; свежие GET —только C1. Legacy разрешена только при Idempotency-Replayed=true и не означает incomplete при отсутствии новых полей. Любой поздний ACK, включая reopen после B, клиент подтверждает по opId и обязательно refresh читает occurrence/страницы/calendar, не применяя старое body/ETag/currentOccurrence. Неудачный refresh показывает требование обновления.

Ниже SQL-эскиз утверждённого пакета. При подготовке предложения он не выполнялся. Реализация 14.10.2026 использует добавочную EF migration [AddCompletionHistory](../backend/Vibe.Api/Data/Migrations/20261013233411_AddCompletionHistory.cs); фактические проверки применения и сохранности приведены в [C1_STATUS.md](C1_STATUS.md):

```sql
CREATE TABLE "Completions" (
  "UserId" text NOT NULL,
  "Id" uuid NOT NULL,
  "OccurrenceId" uuid NOT NULL,
  "CompletedAtUtc" timestamp with time zone NOT NULL,
  "RevokedAtUtc" timestamp with time zone NULL,
  "Source" text NOT NULL CHECK ("Source" = 'manual'),
  "OccurrenceSnapshotJson" jsonb NOT NULL,
  "Version" text NOT NULL,
  PRIMARY KEY ("UserId", "Id"),
  FOREIGN KEY ("UserId", "OccurrenceId")
    REFERENCES "TaskOccurrences" ("UserId", "Id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "UX_Completions_User_Occurrence_Active"
  ON "Completions" ("UserId", "OccurrenceId")
  WHERE "RevokedAtUtc" IS NULL;
```

Relation occurrence→facts —one-to-many history; active —вычисляемая zero/one projection, не полный one-to-one FK. Partial unique защищает все источники независимо от opId. Отмена меняет только revokedAt/version; context/исходный факт остаются. Оба timestamp нормализуются до UTC миллисекунды до записи; CHECK revokedAt>=completedAt **не вводится**, wall clock может корректироваться.

Up только добавляет таблицу/index/FK: не backfill/rewrite/delete snapshots/blocks/OperationResults. Не удалять revoked rows и не реактивировать их. Dangerous rollback после фактов требует отдельного решения; Source расширяется лишь будущим согласованным срезом.

## Альтернативы и приёмка

Физически удалить факт при снятии или реактивировать старый id при новой отметке проще, но теряет историю/контекст и повышает риск применения старой отмены к новой отметке. Рекомендуются revocation плюс новый id. Освобождение блока как часть toggle не выбрано: оно меняет календарь/fixed/overlap и требует отдельного намерения; нынешние две команды сохраняют блок.

Обязательные meaningful проверки после реализации:

1. Реальный PostgreSQL путь complete A → reopen A → complete B/reload/restart: N→0→N→0, A revoked/сохранён, B новый/active, другие occurrence неизменны; no usefulSeconds.
2. Planned/fixed/DST/будущий блок: на обоих переходах все поля/version и elapsed N сохранены, overlap остаётся; after reopen обычные D1 fixed/availability/duration guards.
3. Active snapshot/placement read-only: old base→412, current→409; after reopen D1 edits разрешены. Старый context A остаётся при смене logicalDate/N/source snapshot и новом B.
4. Same/different opId, потерянный ACK, old error replay, fresh no-op, **late reopen A после B** и late complete A после отмены: ACK не переписывает состояние; новый неправильный target не отменяет B.
5. Concurrent complete/complete, reopen/reopen, complete/reopen, complete/placement/PUT, reopen/placement/PUT: active максимум один, нужные реальные bumps, no-op/replay без bumps, без partial commit; schedule/block неизменны у toggle.
6. Target ownership/FK: другие account/occurrence/Completion ids и opId не дают доступ/запись; 401/CSRF/428; timestamp/server clock/DST и identity-scoped client pending/refresh. Коррекция UTC часов назад не должна блокировать reopen или заменить порядок guard/версий проверкой timestamp.
7. Фильтрация до pageSize=1, completed/unplanned и reopened, old cursor/смена фильтра; historical N календаря вместо0 и statuses других выполнений.
8. Additive migration сохраняет populated D1 rows/results/versions; partial unique разрешает многие revoked + один active и отвергает второй active/orphan/чужую связь. Legacy replay bytes сохранены; GET C1 и UI refresh не применяют старые body.
9. Полный OpenAPI check, meaningful Backend/Web tests, TypeScript/build и reviewer; фактические результаты сообщаются отдельно. Контрактные проверки выполнены ниже; проверки реализации этим агентом не запускались.

## Выбор владельца

> Утвердить новую ревизию C1: у каждого отдельного выполнения кнопки «Отметить выполненным» и «Снять отметку», с сохранением истории и календарного блока? Другие выполнения этой задачи сохраняют свой статус. Согласовать описанные API и безопасное добавление хранения и перейти к реализации Backend/Web.

Ответ владельца 13.10.2026: «Утвердить C1 с отменой и реализовать». Решение C1 в DECISIONS утверждает именно ревизию 2 и описанный пакет/API, а не только первоначальный запрос undo. Реализацию и reviewer-проверку координирует основной сеанс.

## Фактически выполнено

В ревизии 1 прочитаны текущие AGENTS/docs и Backend/Web; в ревизии 2 повторно прочитаны этот документ и DECISIONS с уточнением C10, статически сверены targeted lifecycle/legacy/guard и сохранение контекста. При подготовке предложения менялся только этот файл; прежние правки координатора сохранены. После утверждения C1 отдельным поручением разрешены также contracts/d1.openapi.json и contracts/README.md; другие файлы этим агентом не меняются.

Выполнен read-only `python -B -c`: 7 локальных ссылок, 23 строки таблиц, 2 JSON request примера, 5 PROPOSED ID, SUPERSEDED-PROPOSAL предыдущего варианта и SQL-эскиз только CREATE table/index с ownership FK/partial unique active —PASS. Статически разобраны повторные/конкурентные действия и late reopen после новой отметки; это не проверка реализации. `git status --short` показал лишь уже имевшиеся правки координатора DECISIONS/README и этот документ.

После утверждения оформлены live OpenAPI C1 и README. Выполнен read-only `.tools/openapi-venv/Scripts/python.exe -B -c`: строгий JSON без дублирующихся ключей/non-finite чисел, openapi-spec-validator, 403 внутренних ссылки, 90 schema/media примеров с jsonschema FormatChecker и 24 отклоняемых C1 случая —PASS. Отклоняются лишние поля обоих POST, отсутствующие opId/completionId, timestamp без точных UTC миллисекунд/с неверной датой, несовместимые completionStatus/remaining/completion, revoked факт вместо active, planned без блока и legacy DTO вместо fresh C1. У свежих completion POST проверены только C1 response и все предусмотренные HTTP ошибки. Итог: 15 paths, 20 operations, 57 schemas; info.version=2.0.0.

Структурная сверка с сохранённым D1: четыре auth/me paths и security schemes неизменны; 20 входных/placement/constraints/time схем неизменны; TaskOccurrenceLegacyD1 точен, OccurrenceResponseLegacyD1 отличается от прежнего только ссылкой на точную legacy occurrence схему —PASS. Сохранённый файл совпал с проверенной финальной структурой. Эти проверки не подтверждают SQL/guard/replay поведение сервера.

Source, миграции/БД, решения/index, Git index/ветки/commits/remotes этим агентом не менялись. Build/HTTP/предметные тесты C1 не запускались.
