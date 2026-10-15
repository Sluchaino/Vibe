# S1 — точная реализация утверждённого wire-контракта

**ACCEPTED / 15.10.2026**, S1-01–06. Источник: ответ владельца «Утвердить S1 и реализовать (рекомендуется)», записанный координатором в [DECISIONS.md](DECISIONS.md). [Пакет S1](SYNC_SLICE_PROPOSAL.md) содержит исходное предложение; статус решения определяется DECISIONS. [Live OpenAPI](../contracts/d1.openapi.json), info.version=2.1.0, добавляет два GET к прежнему /api/v1. Это оформление выбранного пакета, не новая версия предметных C1 команд/сущностей. Реализация зависит от самостоятельной сверки координатором; готовность приложения этот документ не утверждает.

## Wire DTO и запросы

Ровно семь новых schemas: SyncProtocol, SyncItemKind, SyncCursor, SyncItem, BootstrapPage, SyncChange, ChangesPage. Object DTO закрыты; все поля ниже обязательны. В union каждая ветвь закрыта отдельно; value — существующий неизменённый C1 DTO. UUID/версии/UTC timestamps — существующие wire types; CompletionInstant ровно `YYYY-MM-DDTHH:mm:ss.fffZ`. Ни sequence, ни watermark/horizon bigint не выдаются JSON числом/строкой-позицией: они только внутри защищённого opaque cursor.

| Тип | Точная структура |
| --- | --- |
| SyncProtocol | string const `s1` |
| SyncItemKind | string enum `settings/category/definition/occurrence` |
| SyncCursor | string длиной 1–2000, opaque, сравнение только на равенство |
| SyncItem | `{kind:"settings",value:UserSettings}` или `{kind:"category",value:Category}` или `{kind:"definition",value:TaskDefinition}` или `{kind:"occurrence",value:TaskOccurrence}` |
| BootstrapPage | `{protocol,streamId:UUID,snapshotId:UUID,expiresAt:CompletionInstant,asOfCursor:SyncCursor,planState:PlanState,items:SyncItem[0..100],nextPageCursor:SyncCursor|null}` |
| SyncChange | `{id:UUID,opId:UUID,item:SyncItem,planState:PlanState}` |
| ChangesPage | `{protocol,streamId:UUID,changes:SyncChange[0..100],nextCursor:SyncCursor,hasMore:boolean}` |

`GET /api/v1/sync/bootstrap`: без cursor начинает/переиспользует снимок; с cursor —его следующая страница. `GET /api/v1/sync/changes` всегда требует delta cursor (asOfCursor или nextCursor). У обоих query только `cursor` и `pageSize`; тело не принимается, userId/opId/If-Match/CSRF не нужны. Identity проверяется при каждом GET, прежние CookieAuth/HTTPS/no-store сохраняются. Headers личного ответа/ошибки — Cache-Control и X-Correlation-ID; sync read не domain replay, не получает entity ETag/Location/Idempotency-Replayed.

| Случай pageSize | Поведение |
| --- | --- |
| Начальный bootstrap или tail delta без bound; параметр отсутствует | 50 |
| Bootstrap/bounded delta continuation; параметр отсутствует | Наследовать подписанный размер |
| Continuation; явный integer 1–100 | Совпадение —принять; отличается —400 invalidCursor |
| Неверный/non-integral/вне1–100 размер; duplicate/unknown query; тело GET | 400 validationFailed |

Поэтому SyncPageSize не имеет JSON Schema default: нельзя вставить50 вместо отсутствующего наследуемого размера. Отсутствие обязательного delta cursor —400 validationFailed; присутствующий пустой/длиннее2000/чужой/испорченный/не того purpose —400 invalidCursor. Не принимать D1 list cursor как sync cursor. Wire тип pageSize —integer Int32; JSON numeric policy C1 не меняется.

**Replacement:** settings singleton целиком включает Place/null; остальные индексируются по value.id. Definition metadata остаются live. Occurrence целиком включает block и только active Completion; `calendarBlock=null` обязательно удаляет старый вложенный блок/индекс/попадание в календарь. Новые start/end при move удаляют старое попадание. `completion=null` снимает active проекцию, не удаляет revoked историю/context. Root DELETE/tombstone/отдельных block/completion change kinds нет. Sync не содержит LegacyD1; они допустимы только в неизменённых исторических command replay ветвях C1.

## Ошибки и cursor purpose

Все ошибки — прежний закрытый ProblemDetails, только code enum расширен четырьмя значениями. Новых owner/data полей нет. Inline ограничения новых response media schemas фиксируют допустимые HTTP status/code; старые responses/examples не переписываются.

| HTTP / code | Значение |
| --- | --- |
| 400 validationFailed / invalidCursor | Правила DTO/query/cursor выше; malformed/negative/nonrepresentable positions, continuation A>H —invalidCursor |
| 401 unauthorized / 403 forbidden | Актуальная identity/общий policy; GET antiforgery не вводится |
| 409 syncSnapshotTooLarge | >5000 items или >16 MiB JSON payload; rollback, не truncated snapshot, не бесконечный retry |
| 410 snapshotExpired | Аутентичный owner page cursor, но snapshot отсутствует/истёк; новый bootstrap с сохранением pending |
| 410 syncResetRequired | Аутентичный owner delta cursor: старый stream, A<floor, текущий stream A>head/H>head; без nextCursor/пустого успеха |
| 429 syncBootstrapBusy | Уже 4 неистёкших retained snapshots и нет пригодного reuse |
| 503 syncBootstrapBusy | Guard wait>2s или materialization после захвата>5s; rollback |

Неаутентичный/чужой cursor даёт400 независимо от содержащихся в нём позиций. Сначала защитить owner/purpose, затем проверить форму/Int64 ranges и соответствие stream/head/floor. A=P допустим при floor=P. При валидном current-stream token впереди head требуется описанный stream reset до успешного resync; не clamp и не выдача меньшего head под прежним streamId.

Внутреннее разделение purposes: bootstrap-page и delta, также owner/protocol. Для согласования авторов использовать отдельные labels `Vibe.S1.BootstrapPage` и `Vibe.S1.Delta`, protocol `s1`, текущий owner. Это внутренние константы Data Protection, не дополнительный wire API. Page token связывает streamId/snapshotId/nextOrdinal/pageSize; delta token —streamId/after и optional horizon/pageSize. Наличие horizon задаёт continuation; tail cursor не содержит bound. Keys сохраняются как в C1. Примеры opaque-* в OpenAPI не являются подписанными рабочими tokens.

## Транзакции, snapshot и delta

1. Все существующие domain mutations сохраняют прежние parse/ownership/If-Match/инварианты C1, общий `UserPlanState FOR UPDATE` и dedup. У incomplete PUT references/date по-прежнему до Match; у active/toggle/placement Match-first. После реального принятого изменения под тем же guard увеличить **отдельный** LastSequence и атомарно сохранить entity/PlanState, полный SyncItem/post-change PlanState, стабильный change id/opId и OperationResult. Log нельзя строить из сегодняшних rows при выдаче страницы или из старого replay body.
2. CreateCategory создаёт change без input bump. Настоящие существующие записи с новой entity version дают change. Canonical C1 no-op, replay, mismatch, предметные ошибки и rollback не дают sequence/log/добавочных bumps. OperationResults ошибок остаются атомарными по D1. Sync reads/cleanup не меняют domain revisions.
3. Bootstrap под тем же guard читает head W/PlanState и полные четыре проекции, пишет header/items/pin W в одной короткой transaction. Writer того же owner ждёт; ни SQL transaction, ни lock не удерживаются между HTTP страницами. Порядок snapshot items: settings ровно один, затем category/definition/occurrence; внутри типа canonical lowercase UUID ordinal. Ordinal сохраняется в snapshot rows. Данные после commit приходят delta>W.
4. Initial bootstrap сначала удаляет expired snapshots под guard, переиспользует unexpired same stream/head/pageSize без продления TTL; иначе проверяет cap. Все страницы одного снимка имеют одинаковые streamId/snapshotId/expiresAt/asOfCursor/PlanState, стабильные items/ordinal. asOfCursor всегда после W, не после количества скачанных items. Staging публикуется только целиком на terminal page.
5. Tail delta фиксирует H=head. Stream/floor/log читаются одной consistent transaction; выдаются immutable rows `A<sequence≤H` по порядку. Содержимое/PlanState —после каждого committed шага. Смена PlanState у головы не даёт права смешать его с неполной страницей старого префикса.
6. hasMore=true —nextCursor после последней возвращённой записи, с прежними H/размером; false —tail после H, следующий запрос фиксирует новую границу. Append>H не попадает в текущий проход. Пустой успех не пропускает изменения/не уменьшает позицию. Sequence выдаётся под тем же guard вместе с commit, не отдельным global sequence до commit. Checked Int64 overflow откатывает запись, не wrap.

Локальные параметры, выбранные пакетом, не SLA: FeedRetentionDays=7, BootstrapTtlMinutes=15, retained snapshots/account=4 (включая уже отданную последнюю страницу), MaxSnapshotItems=5000, MaxSnapshotPayloadBytes=16*1024*1024, guard wait=2s, build после lock=5s. Сумма bytes —UTF-8 ItemJson+PlanStateJson, не обещанный физический размер jsonb/индексов. На аккаунт не более20 000 snapshot item rows/64MiB JSON payload плюс overhead. Читать максимум remaining items+1 и считать bytes до сохранения; превышение/timeout отменяет transaction без частичного header/items/pin. Длительности —monotonic/DB timeout. C1 API не отказывает только потому, что S1 snapshot достиг локального предела; усечённый «полный» снимок не разрешён.

Cleanup под тем же guard удаляет expired snapshots, затем непрерывный старый префикс log и атомарно повышает PrunedThrough. Активный snapshot pin W запрещает floor>W. Не сбрасывать head; при пустом log не выводить floor из MIN(rows). UTC может идти назад: остановиться на первой ещё нестарой записи, не брать MAX(sequence) произвольно выбранных старых timestamp. Page reads видят согласованную версию floor+rows. У delta horizon нет бесконечного pin; cleanup между страницами может дать410, тогда новый bootstrap без потери drafts/pending. Snapshot TTL не продлевается запросами.

## Additive schema и restore

Только выбранные новые таблицы; этот документ не создаёт EF migration и не выполняет SQL:

| Таблица | Обязательная модель |
| --- | --- |
| SyncStreams | UserId PK/FK account; StreamId UUID; LastSequence bigint≥0; PrunedThrough bigint в [0,LastSequence]; UNIQUE(UserId,StreamId) |
| SyncChanges | PK(UserId,StreamId,Sequence); ChangeId UUID; OpId UUID; ItemJson/PlanStateJson jsonb; RecordedAtUtc timestamptz; ownership FK на SyncStreams и (UserId,OpId)→OperationResults; UNIQUE(UserId,StreamId,ChangeId/OpId) отдельно |
| SyncSnapshots | PK(UserId,Id); StreamId,WatermarkSequence,PlanStateJson,AsOfCursor,PageSize,CreatedAtUtc,ExpiresAtUtc; ownership FK на SyncStreams; expiry/pin index |
| SyncSnapshotItems | PK(UserId,SnapshotId,Ordinal); ItemJson jsonb; composite ownership FK на SyncSnapshots |

Все projection references —из проверенных entities текущего владельца; в JSON/логах нет auth/CSRF/password/private Completion context. Cutover с остановленным прежним writer: добавить таблицы/stream с нулевым head/floor, затем включить все journal writer paths вместе. Старые domain rows/results/history/версии не переписываются. Bootstrap покрывает начальные данные, log не backfill из OperationResults. Новые accounts получают stream вместе с исходным domain state до доступа к API.

OperationResults **не очищаются**; 7-дневный log не ограничивает прежний dedup horizon. После retention resync исходная отправка остаётся тем же opId/fingerprint; старый ACK/ошибка остаются точными, включая LegacyD1. История Completion/revocation/context не чистится и не становится статистикой/таймером.

После DB restore/отката, до возобновления API, обязательна смена streamId и контролируемое удаление старых sync log/snapshots/reset counters; доступные domain/results/history не чистятся. Старый stream не возвращается с меньшим head. Старый decryptable token →410; утраченные keys →400 и bootstrap, без удаления pending. Любой незавершённый pending, **включая acknowledgedRefresh/conflict/rejected**, переходит в resetReview: backup мог потерять и известный успех/result. Нельзя освободить slot/автоматически retry по старому ACK. Явный повтор исходной отправки сохраняет fingerprint; разрешение для нового stream фиксируется отдельно. Синхронизация не восстанавливает потерянные backup данные.

### Локальная процедура оператора после восстановления БД

Остановить все экземпляры API и восстановить согласованную резервную копию. Схема должна уже содержать миграцию S1; reset сам миграции не применяет. Сохранить приватные настройки и ключи Data Protection. Из корня репозитория в PowerShell выполнить для подготовленной локальной Development-среды:

```powershell
$env:ASPNETCORE_ENVIRONMENT = 'Development'
$env:VIBE_LOCAL_CONFIG = Join-Path (Get-Location) '.tools\local-development.json'
$env:DOTNET_CLI_HOME = Join-Path (Get-Location) '.tools\dotnet-home'
$env:NUGET_PACKAGES = Join-Path (Get-Location) '.tools\nuget'
dotnet run --project backend/Vibe.Api/Vibe.Api.csproj --configuration Release --no-build --no-launch-profile -- --SyncMaintenance:ResetAllStreams=true --SyncMaintenance:Confirmation=API_STOPPED_AFTER_RESTORE
```

Команда меняет только sync streams/log/snapshots, завершается без HTTP listener и не удаляет предметные данные, OperationResults или Completion history. При ошибке API не запускать: устранить причину и повторить reset для всех аккаунтов. После успешного выхода снова запустить Backend обычным `scripts/dev.ps1 backend`. Пользователь в клиенте просматривает свежие данные и оставшуюся отправку; повтор после reset выполняется только явной кнопкой. Эта процедура не нужна при обычном перезапуске или применении additive миграции. Она проверена интеграционными тестами на выделенной БД; рабочая БД ради демонстрации не откатывалась.

## Web compatibility и зависимости реализации

В каждой вкладке один coordinator активного account —единственный publisher memory confirmed state+cursor+generation. Старые GET/afterSuccess/ACK не merge в него; только просят catch-up. Reload всегда начинает новый bootstrap, cursor отдельно не сохраняется. Bootstrap блокирует новые dispatch, уже начатый commit приходит в snapshot либо delta>W. Pending живёт отдельно; ACK не пишет staging.

После ACK сначала закончить старый bounded проход, затем завершить новый tail проход, начатый уже после ACK; только он снимает «требует обновления». Legacy/current mutation body не источник свежей базы. Чужая/stale generation и поздняя старая страница не публикуются; opaque entity versions не сортировать.

IndexedDB Vibe.S1/v1: drafts[userId,draftId] и один pending[userId]. Перед первым fetch завершить transaction frozen command+draft; ошибка storage запрещает отправку. Pending сохраняет прежние opId/base/action/target/query/body; каждый переход/clear —CAS по owner+opId+pendingRevision+ожидаемому status в одной transaction. Поздние ACK/failure не удаляют новую команду/новый revision и не понижают финальный status. DraftId UUID отдельный для каждого editor/вкладки, reload восстанавливает draft явным выбором. SettingsForm нельзя remount по serverVersion при quiet pull; draft/base не меняются от новых props. ACK очищает лишь submitted draft revision; новый ввод остаётся.

Переключение account/401 останавливает private state/dispatch; другой account не видит/не доставляет прежние pending. Никаких auth secrets в IndexedDB. Browser очистка/eviction не исключаются; slot/drop/upgrade/privacy правила остаются выбранными S1. Нет dependent queues/compaction/offline startup/Android. Polling visible=5s и read retry backoff1..30s —локальные параметры, не SLA.

C1 сохраняется: active occurrence read-only, reopen targeting старого id не меняется на новый, full N/fixed/time reservations не теряются. Settings timezone меняет отображение/UTC range одной projection generation, не двигает blocks/availability/logicalDate; localDate view остаётся, range —IANA/DST с пределами дат1/9999. S1 не добавляет solver/confirm, не ослабляет revisions/будущую stale proposal защиту.

## Фактические проверки

До оформления прочитаны актуальные AGENTS/docs/DECISIONS и выбранный пакет; сохранена исходная структура C1 OpenAPI для сравнения. Изменены только live контракт, contracts/README.md и данный новый файл; wire заморожен перед интеграцией.

Координатор выполнил полный OpenAPI validator и проверку refs/examples текущего файла: PASS, 474 ссылки /119 примеров, 17 paths /22 operations /64 schemas. Дополнительно координатор выполнил68 negative cases (лишние/отсутствующие поля, неизвестные protocol/kind, cursor bounds и размеры массивов) —PASS. Это фактические проверки координатора, не повторный запуск architect.

Architect выполнил read-only структурное сравнение: все15 прежних paths, 56 прежних schemas и прежние parameters/responses/headers/security schemes/servers неизменны; ProblemDetails отличается только добавлением4 code enum. Все7 object forms новых DTO (3 объекта и4 union ветви) имеют additionalProperties=false и required для всех properties. SyncPageSize не имеет безусловного default —PASS. Проверка15 локальных ссылок/whitespace двух документов и git diff --check контрактных файлов —PASS. Дополнительный локальный jsonschema checker architect не запустился из-за недоступного в этом sandbox Python runtime; полный validator/negative checks координатор успешно запустил вне sandbox. Установки/изменения .tools этим агентом не выполнялись.

Build/БД/HTTP/двухклиентские/runtime/reviewer проверки реализации этим агентом не запускались; они остаются зависимостью приёмки реализации по S1.
