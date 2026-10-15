# S1 — синхронизация текущего Backend/Web

Статус: **ACCEPTED / 15.10.2026**, пакет S1-01–06. Владелец выбрал «Утвердить S1 и реализовать (рекомендуется)»; разрешены описанный общий контракт и реализация Backend/Web. Основание: [DECISIONS.md, S1](DECISIONS.md). База — завершённый [C1](C1_STATUS.md), [текущий контракт](../contracts/d1.openapi.json), [PRODUCT](PRODUCT.md), [SYNC_DESIGN](SYNC_DESIGN.md), [DATA_MODEL](DATA_MODEL.md). Это ограниченная следующая часть R4, а не утверждение ADR-03/06 целиком или готовность Android offline-first.

## Что предлагается владельцу

Изменения задач, календаря и отметок на одном открытом Web-клиенте появляются на другом клиенте того же аккаунта. Открытый черновик сохраняется; при несовместимой правке пользователь видит свою редакцию и свежую серверную базу. Если ответ на отправку потерян или вкладка перезагрузилась, исходная команда остаётся в этом браузере и проверяется повтором с тем же opId.

Новая offline-очередь создания/редактирования задач, цепочки зависимых команд, запуск приложения без сети и Android сюда **не входят**. В уже открытой форме без сети можно сохранить черновик; новой серверной командой он становится только при явной отправке после восстановления сеанса/синхронизации. Измеренное время, статистика, удаление задач, таймер, batch/push API и solver не добавляются.

| ID / статус | Один рекомендуемый выбор |
| --- | --- |
| S1-01 ACCEPTED | Отдельная последовательность изменений на пользователя; существующие C1 команды, DTO, версии и dedup остаются. Реальное изменение, log и OperationResult атомарны под UserPlanState guard |
| S1-02 ACCEPTED | Два новых GET: материализованный согласованный bootstrap и постраничный delta; opaque cursors, фиксированная верхняя граница одного прохода, явный reset при потере истории |
| S1-03 ACCEPTED | Четыре sync-агрегата с полным replacement: settings, category, definition, occurrence. Вложенные Place/block/active Completion синхронизируются вместе с владельцем; null явно удаляет прежнюю вложенную проекцию |
| S1-04 ACCEPTED | Один publisher подтверждённого Web-state/cursor в памяти; reload начинает новый bootstrap. IndexedDB сохраняет отдельно черновики и максимум одну неподтверждённую/ожидающую refresh команду на аккаунт, без общей offline outbox |
| S1-05 ACCEPTED | Log: целевая очистка старого префикса через 7 суток; snapshot TTL 15 минут; OperationResults и история Completion не очищаются. После восстановления БД обязательна смена streamId и resync |
| S1-06 ACCEPTED | Ручные конфликты и frozen intent без автоматической подмены base/action/completionId; два настоящих Web-клиента, crash/retry/resync и независимое read-only reviewer перед готовностью |

Числа TTL/polling ниже — предлагаемые изменяемые параметры локальной разработки, не измеренные SLA и не обещание максимального offline периода.

## Предлагаемый общий API

Относительно `/api/v1`. Все GET требуют актуальную Identity cookie и возвращают `Cache-Control: no-store`; GET не требуют antiforgery/opId/If-Match. Bootstrap материализует временную read-проекцию, не меняет предметное состояние. Старые auth/команды/GET C1 не меняются; S1 нельзя реализовывать до выбора владельца и оформления live OpenAPI.

| GET / query | Правило / response |
| --- | --- |
| `/sync/bootstrap?pageSize=50` | Начало нового снимка; pageSize integer 1–100, default 50 → BootstrapPage |
| `/sync/bootstrap?cursor=<nextPageCursor>` | Следующая страница того же снимка; pageSize можно опустить или повторить исходный. Другое значение →400 invalidCursor |
| `/sync/changes?cursor=<asOfCursor-or-nextCursor>&pageSize=50` | Обязательный delta cursor; pageSize 1–100, default 50 → ChangesPage. Внутри одного ограниченного прохода размер фиксирован cursor; опущенное значение наследуется, другое →400 invalidCursor |

Тела GET не принимаются. Query имена/значения закрыты; duplicate/неизвестный query или нецелый/вне диапазона pageSize →400 validationFailed. Пустой, длиннее 2000 символов, испорченный, чужой или cursor другого назначения →400 invalidCursor; cursor нельзя переносить из D1 paging. Нет фильтров по дате/типу/календарю: иначе потерялось бы удаление элемента из прежней выборки.

Полные DTO; все перечисленные поля обязательны, объекты закрыты. UUID/time/entity DTO — ровно C1; новые массивы items/changes имеют максимум 100 элементов. SyncCursor — непустая непрозрачная строка длиной до 2000; клиент не разбирает/не сортирует её. Internal bigint sequence наружу не выдаётся и не превращается в JS number.

```typescript
type SyncItem =
  | { kind: "settings"; value: UserSettings }
  | { kind: "category"; value: Category }
  | { kind: "definition"; value: TaskDefinition }
  | { kind: "occurrence"; value: TaskOccurrence }; // только fresh C1
type SyncCursor = string;
interface BootstrapPage {
  protocol: "s1"; streamId: UUID; snapshotId: UUID;
  expiresAt: CompletionInstant;
  asOfCursor: SyncCursor; planState: PlanState;
  items: SyncItem[]; nextPageCursor: SyncCursor | null;
}
interface SyncChange {
  id: UUID; opId: UUID; item: SyncItem; planState: PlanState;
}
interface ChangesPage {
  protocol: "s1"; streamId: UUID;
  changes: SyncChange[]; nextCursor: SyncCursor; hasMore: boolean;
}
```

SyncChange — один committed шаг, а не команда/таймерное событие. Все нынешние C1 команды меняют один из четырёх агрегатов; PlanState относится к состоянию **после этого шага**. id стабилен для записи, opId служит сопоставлению/диагностике, не заменяет сохранённый command ACK. Новые сценарии, атомарно меняющие несколько агрегатов, потребуют отдельного согласованного расширения; S1 их не добавляет.

| SyncItem.kind | Ключ / точное применение |
| --- | --- |
| settings | Singleton аккаунта; целиком UserSettings, включая Place/null |
| category | value.id; заменить всю Category |
| definition | value.id; заменить весь TaskDefinition. Metadata остаются live; snapshots существующих occurrence не переписывать |
| occurrence | value.id; заменить весь TaskOccurrence, включая calendarBlock и только active completion |

Пользовательские удаления definition/category/occurrence не входят, новых DELETE/tombstone ресурсов нет. Уже существующий **unplace удаляет CalendarBlock**: следующий occurrence с calendarBlock=null обязательно удаляет старую вложенную копию/индекс блока клиента. Перенос целиком заменяет start/end; клиент убирает прежнее попадание в календарный диапазон. Аналогично completion=null после reopen убирает active проекцию, но не означает удаления факта на сервере. Клиент не ведёт независимую копию истории Completion; вся revoked история/context C1 остаётся в БД. Это протокольный эквивалент removal для единственных удаляемых вложенных данных S1.

Ошибки новых GET используют прежний ProblemDetails (без нового owner/data поля): 400 validationFailed/invalidCursor; 401 unauthorized; 410 **snapshotExpired** для правильно подписанного page cursor уже недоступного/истёкшего снимка; 410 **syncResetRequired** для правильно подписанного delta cursor старого streamId/позиции до retention floor либо обнаруженного отката head. Для bootstrap дополнительно предлагаются 429 **syncBootstrapBusy** при заполнении лимита снимков, 503 с тем же code при timeout guard/materialization и 409 **syncSnapshotTooLarge** при превышении предела элементов/байтов. 429/503 допускают retry с backoff; 409 требует показать предел, без автоматического бесконечного bootstrap. 403 forbidden — отказ доступа, если появился общий policy; antiforgery на GET не вводится. Нельзя отвечать 410 на чужой/неаутентичный cursor и раскрывать его владельца. Неизвестный текущему S1 клиенту protocol/kind/поле — остановить применение без продвижения cursor, показать требование обновить клиент. Новые read errors не входят в domain dedup.

## Журнал, bootstrap и cursors

**Транзакция записи.** В прежнем command runner сначала auth/CSRF/parse, затем `UserPlanState FOR UPDATE`, fingerprint/replay и неизменённые проверки C1. На успешном реальном изменении: увеличить отдельный LastSequence, создать стабильный change id, записать полный fresh SyncItem и post-change PlanState, OperationResult и изменённые сущности в **одной PostgreSQL transaction**. Проекции log фиксируются при commit, страницы не перечитывают вместо них нынешние live entities. Ошибка сериализации log откатывает всю команду. Порядок commit задаёт тот же per-user guard, не global sequence/время клиента.

Sequence **не равен planningInputRevision**: createCategory не повышает input, но даёт изменение feed. Все существующие успешные записи с новой entity version журналируются; специально определённые C1 canonical no-op, replay, idempotencyMismatch, окончательные предметные ошибки и rollback не создают log/sequence и не получают дополнительных revision bumps. Сохранение результата ошибки остаётся атомарным по D1. Старый replay не получает искусственный новый change. Sync-команды чтения/cleanup не меняют PlanState.

**Bootstrap.** Начальный GET берёт тот же per-user guard, читает stream/head W, PlanState и все четыре типа проекций, материализует header/items снимка и pin W в одной transaction. Domain writers этого пользователя ждут до commit; нет БД transaction, удерживаемой между HTTP страницами. Новые записи после commit имеют sequence>W. В снимке settings ровно один; дальше category/definition/occurrence, каждый тип по canonical lowercase UUID ordinal order. Ordinal каждой строки сохраняется. Page cursors связаны с owner/protocol/streamId/snapshotId/следующим ordinal/pageSize; подписаны/защищены существующим Data Protection с отдельным purpose.

Все страницы несут одинаковые snapshotId/streamId/asOfCursor/PlanState/expiresAt; asOfCursor означает delta **после W**, не после последней скачанной страницы. Bootstrap никак не продвигает старый активный confirmed cache частями: клиент собирает новую staging generation, проверяет цепочку/DTO/ссылки и публикует полный снимок только при nextPageCursor=null. Empty user всё равно получает settings и PlanState. Потерянную страницу повторяют с тем же page cursor; начальный запрос без cursor может переиспользовать неизменный снимок, но смешивать разные snapshotId нельзя.

**Предлагаемые MVP пределы bootstrap:** максимум 4 неистёкших сохранённых снимка на аккаунт (включая уже выданную последнюю страницу), 5000 SyncItem и 16 MiB суммарных UTF-8 ItemJson+PlanStateJson на снимок; это максимум 20 000 snapshot item rows/64 MiB JSON payload на аккаунт плюс служебные строки/индексы. Под guard сначала убрать истёкшие снимки, затем переиспользовать готовый снимок того же stream/head/pageSize без продления TTL; иначе проверить cap 4 и вернуть 429 без вытеснения действующего снимка. Читать не больше оставшегося лимита+1 строк и считать байты до сохранения; превышение →409 с rollback, без частичного header/items/pin. Ожидание guard максимум 2 секунды, вся materialization после захвата максимум 5 секунд с отменой и rollback →503; длительность измеряется monotonic/DB timeouts. Эти локальные настраиваемые пределы входят в PROPOSED выбор и проверяются на границах, не являются SLA; слишком большой аккаунт продолжает иметь прежний C1 API, S1 не выдаёт усечённый «полный» снимок.

**Delta.** Cursor защищает owner, protocol/purpose, streamId, after=A и, для продолжения, horizon H/pageSize. Первый tail запрос фиксирует H=LastSequence. Читается одна согласованная read transaction: проверить stream/floor, взять неизменяемые записи `A < sequence ≤ H` по возрастанию. Все страницы этого прохода используют тот же H; новые commit>H попадут в следующий проход. Нет пропусков из-за позднего commit с заранее выданным номером: номер меняется под guard и коммитится вместе с данными.

Диапазоны cursor проверяются до чтения страницы: отрицательные/непредставимые позиции и continuation с A>H →400 invalidCursor; аутентичный owner cursor старого streamId →410 syncResetRequired. Для аутентичного cursor текущего streamId A>head или H>head →410 syncResetRequired без nextCursor/пустого успеха: это обнаруженный откат потока, требуется описанная смена streamId до успешного resync, а не clamp позиции или движение назад под прежним id. Неаутентичный/чужой cursor всегда 400, независимо от его содержимого.

nextCursor стоит после последней возвращённой записи; если hasMore=true, хранит тот же H/размер. Последняя страница hasMore=false выдаёт tail cursor после H без bound; пустой ответ допустим и не продвигает позицию за непрочитанные изменения. Не выдавать H как применённую позицию первой неполной страницы. PlanState клиента берётся из bootstrap или последнего применённого SyncChange, **не из более свежего server head**, если страница ещё не дошла до него. Повтор страницы безопасен: serialized coordinator применяет её только к ожидаемому исходному cursor/generation; старый ответ после продвижения/смены аккаунта отбрасывается.

**Retention/cleanup.** Предложение: `FeedRetentionDays=7`, `BootstrapTtlMinutes=15`; cleanup периодически и под тем же per-user guard удаляет истёкшие снимки, затем только непрерывный старый префикс log, атомарно повышая PrunedThrough. PrunedThrough=P означает: cursor A=P ещё допустим, A<P →410. Не сбрасывать LastSequence, не вычислять floor по MIN оставшихся строк в пустом журнале.

При выборе старого префикса остановиться на первой записи, которая ещё не достигла порога; нельзя взять MAX(sequence) всех «старых» timestamp: после коррекции UTC часов даты могут идти не по sequence. Неистёкший snapshot держит pin: P не выше его W. Начало bootstrap и cleanup делят guard, поэтому pin не появляется после уже совершённого prune своего W. TTL проверяется сервером; clock не задаёт порядок изменений/конфликтов. Snapshot TTL не продлевается каждой страницей.

Обычный in-flight delta проход **не держит бесконечный pin**. Read transaction видит согласованные floor+rows; если cleanup между страницами прошёл дальше after клиента, следующая страница возвращает 410 и нужен bootstrap. Нельзя молча перескочить на floor/H. Истечение TTL/retention не удаляет локальные pending/черновики. Число «7 суток» не обещает непрерывную доступность delta при смене epoch/ключей или коррекции часов.

## Минимальное хранение и совместимость

Это схема предложения, не созданная EF migration/SQL:

| Новая таблица | Поля / ограничения |
| --- | --- |
| SyncStreams | UserId PK/FK account; StreamId UUID, LastSequence bigint≥0, PrunedThrough bigint в [0,LastSequence]; UNIQUE(UserId,StreamId) |
| SyncChanges | UserId,StreamId,Sequence составной PK; ChangeId UUID; OpId UUID; ItemJson jsonb, PlanStateJson jsonb, RecordedAtUtc timestamptz. FK(UserId,StreamId)→SyncStreams; FK(UserId,OpId)→OperationResults; UNIQUE(UserId,StreamId,ChangeId) и UNIQUE(UserId,StreamId,OpId) |
| SyncSnapshots | UserId,Id составной PK; StreamId,WatermarkSequence,PlanStateJson,AsOfCursor,PageSize,CreatedAtUtc,ExpiresAtUtc; ownership FK на SyncStreams; индекс expiry/pin |
| SyncSnapshotItems | UserId,SnapshotId,Ordinal составной PK; ItemJson jsonb; составной ownership FK→SyncSnapshots |

Все query/FK/log/snapshot принадлежат authenticated owner; userId не принимается в wire. Запись ItemJson создаётся только из его проверенных entities, без cookie/паролей/CSRF/private Completion context. Источники UTC timestamps серверные; sequence/versions не зависят от часов. Checked overflow bigint приводит к rollback, не wrap/reuse. No destructive cascade по предметным данным.

Cutover: кратко остановить прежний writer, добавить таблицы и streamId/нулевые counters существующим аккаунтам, затем включить **все** логирующие writer paths вместе. Существующие данные попадают в bootstrap; OperationResults не разбираются для backfill log. Новые accounts получают SyncStreams вместе с исходным domain state до доступа к API. Старые C1 read/command DTO и ответы не расширяются новыми обязательными полями; после выбора S1 добавляются только paths/schemas/codes. Старый C1 Web может работать прежним способом; поддерживаемый S1 Web обновляется вместе с API.

**Dedup horizon:** в S1 нет автоматического удаления OperationResults, в том числе legacy D1. Это сознательно оставляет прежний горизонт повторов без нового срока истечения; log retention 7 суток его не ограничивает. Повтор после log expiry сначала переживает resync, затем использует **тот же opId/fingerprint** и исходный результат. Нельзя считать удалённый log разрешением отправить новую команду. Долгосрочная очистка результатов/Completion и полный срок Android offline требуют будущего согласованного протокола; S1 не обещает бесконечный production SLA.

После restore БД/отката потока до возобновления API оператор **обязан сменить streamId**, очистить старые sync log/snapshots и сбросить counters в одной контролируемой процедуре; предметные сущности, доступные OperationResults и Completion history не чистятся. Иначе восстановленные sequence могут повториться, а клиент пропустит изменения. Один и тот же streamId нельзя вернуть вместе с меньшим head. Старый подписанный cursor →410; если изменились ключи защиты и он не читается —400 invalidCursor, тоже новый bootstrap без потери pending.

Restore может утратить и более поздние OperationResults: новый streamId переводит **любой незавершённый pending**, включая acknowledgedRefresh/conflict/rejected, в resetReview; ранее известный успех тоже мог отсутствовать в backup. Нельзя автоматически retry, освободить slot или объявить успех по старому ACK. Показываются frozen intent, известный прежний исход и новый снимок. Только явное действие пользователя «Повторить исходную отправку» может снова отправить её неизменённой: найденный результат replay, отсутствующий —обычная команда со старыми guards. Разрешение для нового streamId фиксируется отдельно от frozen fingerprint; повторного молчаливого review не происходит. Не обещать восстановление потерянных backup данных синхронизацией.

## Ограниченный Web-клиент

В каждой вкладке один SyncCoordinator на активный account — **единственный publisher** её подтверждённого WorkspaceState: нормализованные settings/categories/definitions/occurrences, PlanState, cursor и generation меняются одной синхронной заменой state. Между вкладками общий только IndexedDB pending slot/хранилище черновиков, не publisher/generation. Это небольшой необходимый refactor текущих независимых HTTP-read кэшей, не выбор полной durable реплики.

- Confirmed state и cursor хранятся вместе **в памяти**, cursor отдельно в localStorage/IndexedDB не сохраняется. После reload — новый bootstrap; crash не оставляет сохранённый cursor без его данных. Bootstrap/delta/identity переключения сериализованы; поздний ответ чужой generation/owner не публикуется.
- Списки и календарь вычисляются из одного confirmed state; фильтры incomplete/completed/placement/definition/date применяются перед локальным «Показать ещё». Серверные C1 list filters/pageSize/31-local-day calendar пределы остаются. Ни ACK, ни обычный GET, ни текущие C1 afterSuccess full refresh не merge в synced shadow: они могут запросить coordinator catch-up. Opaque версии нельзя сортировать, чтобы «выбрать свежую».
- Начальный bootstrap/resync приостанавливает **новые отправки**. Уже отправленная команда может commit до/после W: её данные окажутся в snapshot либо delta>W. Pending/черновик не удаляется при замене confirmed state. Пока идёт bootstrap, ACK может только изменить состояние своего pending, не staging/cursor.
- После любого ACK/окончательной ошибки старое body/ETag/currentOccurrence, включая legacy replay, не становится новой базой. Coordinator завершает старый bounded проход и запускает **новый** tail проход уже после получения ACK; только завершённое чтение этой границы снимает «требует обновления». Ошибка чтения сохраняет этот статус. Совпавший opId в feed не удаляет pending вместо ACK.
- Предложенный polling: 5 секунд у видимой вкладки, catch-up также при focus/online/ручном «Обновить» и после ACK; при скрытой вкладке можно остановить polling. Retry чтения — backoff/jitter 1→30 секунд; 401 останавливает до входа. Это локальные настройки, не доставка за гарантированные 5 секунд. BroadcastChannel только сигналит перечитать, не передаёт доверенное состояние.

**IndexedDB — отдельная предлагаемая часть S1.** Browser DB `Vibe.S1` version 1: `drafts` с ключом [userId,draftId], `pending` с ключом userId. Draft содержит resource/kind, исходную base/PlanState, ввод и local revision. Pending содержит неизменные userId/opId/method/path/query/body/quoted If-Match/null, submitted draftId/revision и streamId; отдельно статус `unconfirmed|acknowledgedRefresh|conflict|rejected|resetReview`. Пароли, cookie и CSRF туда не пишутся. Все значения текущих C1 чисел Int32 сохраняются без потери, query/body/target не «улучшаются» при retry.

Перед первым fetch одна завершённая IndexedDB transaction сохраняет frozen команду и соответствующий черновик; если запись не удалась, отправка не начинается, UI сообщает, что безопасное восстановление недоступно. Разрешена максимум одна неразрешённая команда аккаунта на этот browser origin, включая вкладки: transaction проверяет свободный slot. Можно продолжить другой черновик, отправить следующую команду —после разрешения slot. Это устраняет необходимость зависимостей/compaction общей outbox; два разных браузера всё равно конкурируют через серверные guards.

Каждое обновление/освобождение slot — IndexedDB transaction с CAS по userId+opId+локальному pendingRevision+ожидаемому status, затем увеличением pendingRevision. Поздний ACK/failure/catch-up старой команды не удаляет новый opId и не понижает acknowledgedRefresh/conflict/rejected/resetReview в unconfirmed; неудачный CAS перечитывает slot, а не повторяет старый переход вслепую. DraftId создаётся UUID отдельно для каждого редактора и уникален между вкладками; после reload сохранённый draft восстанавливается явным выбором по его id, не неявным присоединением/записью в чужой редактор. Очистка draft дополнительно сравнивает submitted revision, чтобы сохранить новый ввод.

Network timeout/401/5xx/закрытие вкладки не превращают команду в успех и не меняют её. После восстановления **того же подтверждённого /me пользователя** и bootstrap/catch-up при том же streamId повтор доставляет исходную команду; свежий CSRF допустим вне fingerprint. Окончательный 400/404/409/412/428 сохраняет отказ/ввод, не retry loop. Успех переводит в acknowledgedRefresh, crash в этом состоянии возобновляет чтение, а не повторную новую команду. Slot освобождается после catch-up; конфликт/validation требует явного выбора/редактирования с новым opId. Неудостоверенный запрос нельзя просто выкинуть и отправить заново как «новый».

Pull обновляет server shadow, но не base/payload черновика и frozen команды. Изменившийся serverVersion/PlanState помечает конфликт; пользователь видит обе редакции. `SettingsForm key=serverVersion` при quiet pull **нельзя** применять для сброса формы: стабильный ключ editor/account, сохранённые draft/base отдельно от props, никакой автоматической rebase. Для новых правок во время отправки повышается local draft revision: поздний ACK очищает только свой opId/submitted revision, не более новый ввод. Разные редакторы имеют разные draftId, вкладка не подменяет чужой draft.

Обнаруженный на другом клиенте active Completion делает текущую confirmed карточку read-only, но сохраняет начатый черновик. Новая отправка этого ввода всё равно требует прежних C1 guards/явного выбора; не превращается в reopen сама. Complete A→reopen A→complete B сохраняет C1 историю/длительность занятого блока; late reopen A не retarget на B. Таймерных минут не возникает.

Logout/401/смена identity останавливают coordinator/dispatch и скрывают private state; локальные черновики/команда остаются только в namespace исходного account. До подтверждения /me их нельзя показывать/отправлять другому аккаунту. В UI явно обозначить «сохранено в этом браузере»; очистка локальных данных аккаунта доступна только после разрешения uncertain slot с объяснением потери локальных черновиков. Upgrade IndexedDB выполняется transactionally; unsupported version/blocked upgrade/quota запрещают новую отправку, не молча удаляют store. Не считать browser storage защищённым от очистки пользователем/eviction; запроса persistent-storage permission и service worker S1 не добавляет.

При 410/invalid stored cursor сохраняются drafts/pending, текущая подтверждённая копия помечается stale; новый snapshot загружается отдельно и целиком заменяет только confirmed state/cursor. При смене streamId любой незавершённый pending требует описанного resetReview. Reload без доступного /me не открывает private workspace; запуска полностью без сети S1 не обещает.

## Время, план и границы

Settings timezone change применяется вместе с новым confirmed state: выбранная календарная localDate сохраняется, UTC from/to пересчитываются по новой IANA зоне, не ±24h. Старый calendar range/cache больше не источник истины. Block UTC start/end/N не двигаются, availability timezone и logicalDate не переписываются. Проверить DST/границы 1/9999; не представимый range даёт явную ошибку вместо переноса даты.

S1 не создаёт proposal/confirm API. Сохраняются input/schedule revisions и общий guard: будущий preview должен считаться stale при изменении соответствующей revision, а наличие локального pending запрещает считать его основанным на чистой базе. Полученный по sync новый PlanState не даёт права автоматически принять план/подменить base. Полный stale-confirm тест относится к будущему solver срезу; сейчас проверяется отсутствие ослабления C1 ревизий/If-Match.

Существенные альтернативы: polling существующих GET проще, но не даёт одного checkpoint/согласованного bootstrap; live пагинация без materialization смешивает состояния. Полная IndexedDB replica + offline outbox лучше покрывает F13-подобные сценарии, но требует порядка зависимостей/migrations/расширенного UX и здесь отложена. Invalidation-only feed уменьшает payload, но повторные GET затрудняют доказательство согласованности и удаления из старых выборок. Пока предпочтительны четыре полные проекции, временный bootstrap и небольшой frozen pending store. Цена — полная начальная загрузка/память, короткий user guard при materialization, хранение OperationResults без очистки; объём данных/нагрузку надо измерить, SLA не выбран.

## Проверяемая приёмка после выбора

1. Реальный PostgreSQL и два независимых Web-клиента/профиля одного аккаунта: category/create/edit definition/create occurrence/place/move/unplace/fixed/complete/reopen видны после catch-up. Категория даёт sequence при неизменном input; другие аккаунты не видят ни данных, ни opId/cursor.
2. pageSize=1, конкурентные записи между страницами bootstrap/delta, потеря/повтор страницы: terminal bootstrap равен состоянию W, delta после W без пропусков/дублей. Append после H ждёт нового прохода; ни page cursor, ни head не продвигают confirmed позицию раньше применения.
3. Crash/rollback между entity/log/result/sequence; потеря ACK после commit и duplicate delivery: один предметный эффект/одна log запись, ошибки/no-op/replay без новых changes. Старые D1 legacy bytes неизменны; исходный ACK не откатывает свежий shadow.
4. Unplace удаляет прежний блок/календарное попадание, move убирает старое; complete/reopen оставляют прежние N/fixed/version блока. История A/revoke/B и контекст сохранены; old target не отменяет B.
5. Два клиента с одной базой и открытыми черновиками settings/definition/occurrence/placement/complete/reopen: 412/409 по C1; quiet pull не remount SettingsForm/не меняет draft base. Новые edits во время старого ACK сохраняются.
6. Crash до IDB commit не отправляет команду; после local commit/до fetch и после server commit/до ACK —reload/bootstrap/тот же opId. После ACK/до catch-up при том же streamId —только чтение. Две вкладки не создают два frozen slot; CAS не даёт старым ACK/failure/освобождению понизить status или удалить новый opId; разные draftId и явное восстановление не перезаписывают соседнюю вкладку.
7. Retention floor граница A=P/P−1, пустой log, pin snapshot и cleanup под guard; expiry между страницами/во время чтения; bounded delta без pin получает 410 без пропуска. Перевод UTC часов вперёд/назад не меняет sequence/победителя и не удаляет нестарую середину по MAX timestamp.
8. Forced stream reset/restore с повторным старым sequence: смена streamId →resync/resetReview для всех незавершённых статусов, включая acknowledgedRefresh; при утрате operation result нет ложного обещания dedup. Corrupt/foreign/type-mismatched cursor, A>head/A>H/H>head и доступ после logout проверяются: явный 400/410 без обратного nextCursor/пустого успеха.
9. Timezone/DST/ночные блоки/даты 1 и 9999, фильтры completed/unplanned и локальная пагинация, authoritative metadata: после catch-up оба клиента равны одному snapshot. Начальный объём больше двух страниц; cap 4/reuse/expiry, 5000/5001 items, byte boundary/+1, timeout lock/build дают предусмотренный отказ без partial snapshot/pin и бесконечного writer lock.
10. Additive schema сохраняет C1 rows/версии/OperationResults/Completion history; OpenAPI schemas/examples и контрактные Backend/Web tests, TypeScript/build, живой сценарий двух клиентов, затем технически read-only reviewer. Незапущенные проверки отмечаются; Android/F13/solver готовыми не объявляются.

## Вопрос владельцу

> Утвердить S1: изменения в двух открытых Web-клиентах синхронизируются автоматически, ваши черновики сохраняются, а незавершённая отправка переживает перезагрузку в этом браузере? При конфликте выбор остаётся за вами. Согласовать описанные два API, журнал и временные снимки, сохранение черновиков/одной отправки в IndexedDB и перейти к реализации Backend/Web. Полная работа приложения без сети и Android остаются следующим этапом.

15.10.2026 владелец утвердил весь пакет и реализацию. Координатор записал S1 ACCEPTED в DECISIONS. Формулировка вопроса выше сохранена как источник выбора; выполненные проверки реализации будут записаны отдельно в S1_STATUS.md.

## Фактически выполнено при подготовке

15.10.2026 координатор независимо сверил пакет с C1 и уточнил пределы bootstrap, CAS между вкладками, восстановление pending и границы cursor. Затем официальный custom reviewer в отдельном CLI-сеансе с подтверждёнными `sandbox=read-only`, `approval=never` выполнил статическое ревью окончательного предложения и точечную сверку Backend/Web/контракта C1: конкретных замечаний P0–P3 не найдено. Сеанс `01a13f84-79d2-7093-8b92-ffca8d811bf6`, только локальные чтения, без записи/build/test/миграций. Это проверка предложения; реализация и её runtime/two-client проверки ещё не выполнены. Координатор также проверил локальные Markdown-ссылки: 88 проверено, 0 отсутствует. Следующий шаг — выбор владельцем всего S1-01–06 вместе с реализацией.

Прочитаны AGENTS, README/PRODUCT/DECISIONS, SYNC_DESIGN/DATA_MODEL/C1_STATUS, текущий live контракт и C1 Backend/Web. Статически сверены existing guard/OperationResults/RepeatableRead, отсутствие input bump у category, nested block/active Completion, память drafts и C1 refresh/SettingsForm key. Приложение, API, миграции, Git и другие документы не менялись; создан только этот PROPOSED файл.

Doc-only проверка штатными JavaScript/PowerShell средствами: 6 локальных ссылок существуют, 6 ID имеют статус PROPOSED, 7 используемых базовых DTO есть в live C1, fence сбалансирован, 10 сценариев приёмки —PASS. Независимая конечная JavaScript-модель дала 12 успешных утверждений для prefix/pin/floor, W→H/позднего append, removal/null, completion/reopen и отбрасывания старой страницы. Это проверка рассуждения на примере, не тест серверной/клиентской реализации. Python отсутствует в PATH; проверка выполнена доступными средствами без установок/.tools. git status показал только новый файл этого предложения. На момент первичной передачи architect runtime/two-client/build/OpenAPI/reviewer проверки S1 ещё не выполнялись; последующее статическое ревью записано выше. Live OpenAPI не менялся.
