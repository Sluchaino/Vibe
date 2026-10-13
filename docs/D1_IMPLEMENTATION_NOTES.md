# D1 — точная семантика контракта и ориентир реализации

Статус: формализация утверждённого D1-01–05 от 12.10.2026, а не новое ACCEPTED-решение. Источник — [DECISIONS.md](DECISIONS.md), [FIRST_SLICE_PROPOSAL.md](FIRST_SLICE_PROPOSAL.md). Wire-схемы и примеры — [d1.openapi.json](../contracts/d1.openapi.json), обзор — [contracts/README.md](../contracts/README.md).

Документ оформляет выбранные правила для Backend/Web. Остальные ARCHITECTURE/DATA_MODEL/SYNC_DESIGN/PLANNING_RULES остаются DRAFT за границами D1. Нет реализации auth, миграций или кода компонентов в этом поручении.

## Границы и зависимости

Сохраняется один проект backend/Vibe.Api T0, ASP.NET Core Identity, EF Core/PostgreSQL и Web React/TypeScript. Локальные API/Web работают на одном HTTPS origin через proxy. Координатор отвечает за рабочую PostgreSQL, TLS, версии пакетов, секреты двух локальных accounts и инструкции запуска.

Backend отвечает за авторизацию каждой цели/ссылки, закрытые DTO, копирование snapshots, DST, весь fixedWork, optimistic concurrency, общий per-user guard и атомарный operation result. Web отвечает за identity-scoped кэш/черновики, получение antiforgery, явное подтверждение fixed change, показ серверных конфликтов и полное сохранение введённых данных при отказе.

Нет Completion UI/таймера/статистики, recurrence/goals/templates, flexible/split, travel graph, solver/preview/confirm, mobile token flow, change-log/tombstones или offline resync. Они не подменяются фиктивными данными. Одно явно созданное место действительно одинаково для D1-задач; неизвестный путь между будущими местами не становится нулём.

## Полные DTO

Ниже все поля обязательны, если не помечены `?`. `T|null` допускает null, но само поле всё равно требуется. JSON camelCase; UUID/версии/cursor — string. Integer — integral JSON number в пределах Int32; минуты целые, приоритет 1–5. Boolean false обязан быть передан явно; отсутствие не эквивалентно false.

| Тип | Точная структура |
| --- | --- |
| FixedWorkDuration | {mode:"fixedWork", requiredWorkMinutes:int >0} |
| AvailabilityWindow | {daysOfWeek:DayOfWeek[], startLocalTime:HH:mm, endLocalTime:HH:mm, endDayOffset:0\|1} |
| ExceptionWindow | {startLocalTime:HH:mm, endLocalTime:HH:mm, endDayOffset:0\|1, startUtcOffset:±HH:mm, endUtcOffset:±HH:mm} |
| AvailabilityDateException | {localDate:YYYY-MM-DD, windows:ExceptionWindow[]} |
| AvailabilityRules | {timezone:IanaTimezone, windows:AvailabilityWindow[], dateExceptions:AvailabilityDateException[]} |
| ConstraintsSnapshot | {durationPolicy:FixedWorkDuration, splitAllowed:false, mobilityPolicy:"movable"\|"fixedAfterPlacement", availabilityRules:AvailabilityRules, placeId:UUID, requiredRestMinutes:0} |
| DefinitionFields | {title:string 1–200, description:string 0–4000, categoryId:UUID\|null, importance:"low"\|"normal"\|"high", difficulty:"light"\|"medium"\|"heavy", executionPriority:int 1–5, durationPolicy:FixedWorkDuration, splitAllowed:false, mobilityPolicy:"movable"\|"fixedAfterPlacement", availabilityRules:AvailabilityRules, placeId:UUID, requiredRestMinutes:0} |
| TaskDefinition | {id:UUID, ...DefinitionFields, serverVersion:Version} — поля DefinitionFields плоские, без вложенного поля definitionFields |
| CreateDefinitionRequest | {opId:UUID, id:UUID, ...DefinitionFields} |
| UpdateDefinitionRequest | {opId:UUID, ...DefinitionFields} |
| PlaceInput | {id:UUID, name:string 1–100} |
| Place | {id:UUID, name:string 1–100, serverVersion:Version} |
| UserSettings | {timezone:IanaTimezone, weekStartsOn:"monday", place:Place\|null, serverVersion:Version} |
| UpdateSettingsRequest | {opId:UUID, timezone:IanaTimezone, weekStartsOn:"monday", place:PlaceInput} |
| Category | {id:UUID, name:string 1–100, serverVersion:Version} |
| CreateCategoryRequest | {opId:UUID, id:UUID, name:string 1–100} |
| CalendarBlock | {id:UUID, occurrenceId:UUID, kind:"task", startInstant:UTC, endInstant:UTC, fixed:boolean, serverVersion:Version} |
| TaskOccurrence | {id:UUID, definitionId:UUID, logicalDate:YYYY-MM-DD, sourceDefinitionVersion:Version, constraintsSnapshot:ConstraintsSnapshot, remainingWorkMinutes:int >0, placementStatus:"unplanned"\|"planned", calendarBlock:CalendarBlock\|null, serverVersion:Version} |
| CreateOccurrenceRequest | {opId:UUID, id:UUID, definitionVersion:Version, logicalDate:YYYY-MM-DD} |
| UpdateOccurrenceRequest | {opId:UUID, logicalDate:YYYY-MM-DD, constraintsSnapshot:ConstraintsSnapshot, allowFixedChange:boolean} |
| PlanState | {planningInputRevision:Version, scheduleVersion:Version} |
| SettingsResponse | {settings:UserSettings, planState:PlanState} |
| CategoryResponse | {category:Category, planState:PlanState} |
| DefinitionResponse | {definition:TaskDefinition, planState:PlanState} |
| OccurrenceResponse | {occurrence:TaskOccurrence, planState:PlanState} |
| CategoryPage / DefinitionPage / OccurrencePage | {items:Category[] / TaskDefinition[] / TaskOccurrence[], nextCursor:string\|null, planState:PlanState} |
| CalendarResponse | {from:UTC, to:UTC, blocks:CalendarBlock[], occurrences:TaskOccurrence[], definitions:TaskDefinition[], planState:PlanState} |
| MeResponse | {userId:string, userName:string} |
| AntiforgeryResponse | {requestToken:string, headerName:"X-CSRF-TOKEN"} |
| LoginRequest | {userName:string 1–256, password:string 1–1024} |
| ProblemDetails | {type:string, title:string, status:int, detail:string, instance:string, code:ErrorCode, correlationId:string, fieldErrors?:map<string,string[]>, currentServerVersion?:Version, currentPlanState?:PlanState, currentSettings?:UserSettings, currentDefinition?:TaskDefinition, currentOccurrence?:TaskOccurrence, conflictingBlockIds?:UUID[], validUtcOffsets?:UtcOffset[]} |

DayOfWeek = monday/tuesday/wednesday/thursday/friday/saturday/sunday. DaysOfWeek непустой, уникальный, максимум 7. DateExceptions уникальны по localDate. Пустые/пробельные title и name отклоняются; значения не обрезаются молча.

String minLength/maxLength считают Unicode code points по JSON Schema. C#/JavaScript не должны заменить это количеством UTF-16 code units или байтов; например, один emoji считается одним символом. Это одинаковое wire-правило Backend/Web, а не разные ограничения клиентов.

Version — непрозрачная case-sensitive строка из ASCII A–Z/a–z/0–9/_/-, длина 1–200. Backend выбирает способ выпуска токена внутри этих wire-границ; это не пользовательские номера ревизий. UUID можно создавать клиентом для place/category/definition/occurrence/opId, UUID calendar block выдаёт сервер. Settings существует у account и не имеет клиентского id.

Description — обязательная строка, пустая допустима. CategoryId — обязательное nullable поле. SourceDefinitionVersion копируется при создании и остаётся исходной после ручной правки snapshot. Metadata definition не копируются/не меняются PUT occurrence. Calendar aggregate возвращает текущие metadata definition отдельно от сохранённых occurrence constraints. У occurrence нет выдуманного completion/status done.

| Ветвь PlacementCommand | Точная структура |
| --- | --- |
| place | {opId, action:"place", baseScheduleVersion, allowFixedChange, localStart, timezone, utcOffset} |
| move | {opId, action:"move", baseScheduleVersion, allowFixedChange, localStart, timezone, utcOffset} |
| unplace | {opId, action:"unplace", baseScheduleVersion, allowFixedChange} |
| setFixed | {opId, action:"setFixed", baseScheduleVersion, allowFixedChange, fixed:boolean} |

Все поля каждой ветви обязательны; смешение ветвей/лишние startInstant/endInstant/blockId/owner отклоняются. If-Match — только HTTP header, в теле версию не дублируют. BaseScheduleVersion/definitionVersion передаются без кавычек.

Для C# wire UUID → Guid, длительность/приоритет → int, boolean → bool, версии/cursor/IANA → string. Nullable Guid используется только для categoryId; nullable Place/CalendarBlock — только на чтении. DateOnly и DateTimeOffset возможны внутри сервера, но wire сериализация должна точно следовать шаблонам OpenAPI. LocalStart не следует привязывать к timezone машины. Для TypeScript UUID/даты/версии/IANA — string, integer → number; PlacementCommand — discriminated union по action. Генератор и дополнительные библиотеки не выбраны. Nullable/ref/union схемы OpenAPI имеют приоритет над этой справочной записью.

Закрытые DTO, string enum, запрет числовых enum, duplicate JSON properties и обязательные поля проверяются сервером. Порядок свойств JSON не важен. Допустимость integer и даты проверяется по значению; OpenAPI regex проверяет форму, а не существование даты/зоны. Нельзя случайно получить bool=false/int=0 из отсутствующего поля и считать это явным выбором пользователя. При расширенном будущем DTO D1-клиент не сохраняет урезанную редакцию.

## Settings, snapshots и fixedWork

Первый GET settings возвращает реальные настроенные timezone/monday, place=null и ETag. PUT требует явного place.id/name и current If-Match. После создания id стабилен; имя можно изменить этим же PUT. Не вводятся координаты, несколько мест или «неизвестное = текущее место».

Каждая предметная ссылка принадлежит authenticated user. Отсутствующая/чужая categoryId/definitionId/placeId в constraints или фильтре даёт одинаковый 404 referenceNotFound. Отсутствующая/чужая целевая сущность маршрута даёт 404 notFound. Если собственная ссылка указывает неподдерживаемый другой Place, ответ 400 unsupportedConstraint. DTO place{id,name} в PUT settings задаёт создание/идентичность собственного единственного места: после создания любая попытка заменить его стабильный id даёт одинаковый 400 unsupportedConstraint без поиска чужих или отсутствующих id. Это соответствует описанию PUT и не раскрывает существование чужого Place.

Создание occurrence под guard сверяет переданную definitionVersion, затем копирует duration/split/mobility/availability/place/rest. Снимок может отличаться от текущего definition после его редактирования. Один definition допускает несколько manual occurrence одной logicalDate с различными UUID.

RemainingWorkMinutes = snapshot.durationPolicy.requiredWorkMinutes в D1, потому что фактов работы пока нет. Planned iff calendarBlock!=null; блок покрывает полный объём, иначе не создаётся. [start,end) — elapsed UTC, поэтому через DST 90 минут остаются ровно 90 минут, даже если локальное отображение меняется на 30/150 минут. Дорога/обязательный отдых/таймерные breaks не включаются в объём; пока они не поддержаны, соответствующий ввод отклоняется.

PUT occurrence при существующем блоке проверяет полную длительность и допустимость блока против нового снимка. Несовместимое изменение даёт 409 invalidExistingPlacement. Никаких скрытых move/unplace/resize; пользователь сначала явно снимает блок отдельной командой, затем меняет snapshot и размещает заново. LogicalDate — ручная метка, не constraint дня размещения; перенос сам её не меняет.

## Время, окна и DST

UTC — строго YYYY-MM-DDTHH:mm:00Z. LocalStart — YYYY-MM-DDTHH:mm:00, без offset/Z. LocalTime — HH:mm, без 24:00. UTC offset — ±HH:mm, не -00:00; ±14 допускает только :00. Сервер проверяет действительность offset в указанной IANA зоне, а не только диапазон.

1. Разобрать localStart как реальную локальную дату/минуту без timezone машины.
2. Получить все подходящие offset из базы IANA. Ноль вариантов →400 invalidLocalTime; никогда не сдвигать gap.
3. При нескольких вариантах пользователь явно выбирает один; запрос содержит utcOffset. Не выбранный/недействительный offset →400 invalidUtcOffset; ответ может сообщить validUtcOffsets.
4. Вывести startInstant и endInstant=startInstant+N elapsed minutes. При невозможном представлении даты отклонить ввод, без переполнения/округления.
5. Проверить полный UTC-интервал против snapshot availability и всего пользовательского расписания.

Пример overlap Europe/Berlin 25.10.2026 02:30 допускает +02:00 (00:30Z) или +01:00 (01:30Z). Gap 29.03.2026 02:30 не допускает ни одного offset. Это ручная политика; автоматическая политика повторений остаётся отдельным решением.

В AvailabilityWindow daysOfWeek относятся к дате начала окна. EndDayOffset=0 требует start<end. EndDayOffset=1 требует end<=start и задаёт окно следующего дня, максимум 24 локальных часа. Полный день — 00:00→00:00 +1. Пятница 22:00→02:00 +1 включает хвост субботы независимо от наличия отдельного субботнего окна.

DateException заменяет обычные окна, начинающиеся в своей localDate; пустой список запрещает их. Чтобы запретить хвост ночного окна предыдущей даты, явно изменить исключение предыдущей даты. Это делает нормализацию через полночь однозначной.

Windows=[] без исключений — любые дни/время, никаких искусственных DST-границ. При наличии исключений конкретная localDate получает её окна вместо обычного неограниченного дня. Если обычные ограниченные окна существуют, сервер разрешает их обе локальные границы в snapshot.timezone. Gap/overlap любой используемой границы требует исключения этой даты с явными действительными start/end offset. Exception не делает несуществующую границу действительной: её localTime надо выбрать явно в допустимом времени.

Нормализованные окна рассматриваются как полуоткрытые UTC-интервалы. Пересекающиеся/соприкасающиеся допустимые окна объединяются; весь блок должен поместиться в одном результирующем непрерывном разрешённом интервале. Определённое допустимое окно не блокируется нерелевантной неоднозначной границей другого окна. Если размещение может быть оправдано только окном с неопределённой границей, вернуть 400 ambiguousAvailabilityBoundary. За пределами определённых окон —400 outsideAvailability.

Availability.timezone хранится в snapshot и не переписывается сменой UserSettings.timezone. Placement.timezone описывает ручной ввод, availability.timezone — ограничения, settings.timezone — отображение и границы календаря. Это три роли одного формата IANA, не три взаимозаменяемых значения.

GET calendar использует from/to UTC и возвращает все блоки с start<to && end>from без обрезания. При from>=to ошибка 400. Лимит — 31 различная локальная дата в settings.timezone, чей день пересекает [from,to). Исключённое to ровно в начале следующего дня не включает этот день. День DST может быть 23/25 часов; client/server не используют UTC+24h как замену локальному дню.

## Fixed и явное ручное намерение

EffectiveFixed = CalendarBlock.fixed OR snapshot.mobilityPolicy=="fixedAfterPlacement". Первое place создаёт пользовательский block.fixed=false; второй режим защищает время через snapshot.

Place допустим только без блока; move/unplace/setFixed — только при существующем. Иначе 409 invalidPlacementState. Move сохраняет UUID и fixed блока. Unplace снимает весь блок и сохраняет весь объём occurrence. SetFixed изменяет только пользовательский флаг, без скрытого переноса.

Move/unplace effectiveFixed блока требуют allowFixedChange=true. Снятие block.fixed=true→false требует true. При fixedAfterPlacement setFixed=false не снимает защиту policy. PUT snapshot, меняющий fixedAfterPlacement→movable у размещённого occurrence, тоже требует true: иначе возник бы обход подтверждения через редактирование снимка. Подтверждение UI должно быть отдельным действием пользователя, не постоянно включённым флагом.

AllowFixedChange не разрешает пересечение/неполный объём/недопустимое окно/чужую ссылку и не меняет версии автоматически. После подтверждения concurrency проверяется как обычно.

## Версии, согласованность и записи

ETag — один сильный quoted token serverVersion. If-Match не допускает *, W/, несколько тегов и unquoted token в D1. Отсутствие —428 preconditionRequired; несовпадение —412 staleEntity. Создание occurrence использует body.definitionVersion, несовпадение —412 staleDefinition. Placement дополнительно сверяет baseScheduleVersion: 409 staleSchedule.

| Успешная операция | Entity versions | planningInputRevision | scheduleVersion |
| --- | --- | --- | --- |
| Create category | новая category | без изменения | без изменения |
| PUT settings | settings и созданный/изменённый Place | увеличить | без изменения |
| Create/PUT definition | definition | увеличить | без изменения |
| Create/PUT occurrence | occurrence | увеличить | без изменения |
| place/move/setFixed | occurrence и созданный/изменённый block | увеличить | увеличить |
| unplace | occurrence; блок удалён | увеличить | увеличить |
| Replay / предметный отказ | не изменять | не изменять | не изменять |

Успешные mutating commands с новым opId могут повышать versions даже при совпадающих значениях; клиент не делает вывод об изменениях по величине токена. Ответ сообщает сохранённые значения. Category — справочник, создание не меняет входы задач/расписание; categoryId уже записывается в definition отдельной версионируемой командой.

Все влияющие на план записи сериализуются общим guard UserPlanState текущего пользователя в короткой PostgreSQL transaction. Практический вариант внутри выбранного одного проекта — блокировать эту строку SELECT ... FOR UPDATE. Entity checks, schedule check, DST/availability/overlap, запись блоков/occurrence, обе revision и operation result находятся в одной транзакции. Проверить ETag или отсутствие пересечений до транзакции недостаточно.

Читающие ответы entity+planState и calendar aggregate берутся из одного согласованного состояния. Для одного SQL достаточно его snapshot; для нескольких SQL нужна короткая согласованная read transaction. Это требование wire-согласованности D1, не утверждение всей архитектуры будущего solver snapshot. Дорогого solver и длинной транзакции расчёта нет.

Overlap вычисляется по UTC: existing.start<candidate.end && existing.end>candidate.start, исключая собственный перемещаемый block. Касание границ допустимо. Принятый plan не имеет пересечений пользователя; разные accounts независимы.

## Fingerprint, окончательные ошибки и replay

Replay scope — authenticated user + opId, не deviceId, не глобальный opId и не одно endpoint. Уникальность этой пары обеспечивает БД. Параллельные одинаковые операции получают один результат; другой account не получает ни результат, ни признак существования чужого opId.

Fingerprint включает HTTP method, нормализованный resolved path с resource UUID, все query-параметры (в том числе неподдерживаемые), If-Match с различением отсутствующего значения и полный JSON body без поля opId. Учитываются definitionVersion/baseScheduleVersion/allowFixedChange и неизвестные поля: нельзя повторить opId, удалив отвергнутую часть запроса. Query duplicates и JSON duplicate properties отклоняются, не выбирается произвольно первое/последнее значение.

Fingerprint не включает cookie, password из login (login вообще вне dedup), CSRF token, correlationId, транспортные заголовки или порядок JSON object properties. Canonical representation сохраняет массивы в исходном порядке, точные значения/null/отсутствующие поля, а integral numeric values нормализует без округления; invalid большие numeric tokens нельзя пропускать через потерявший точность JS double. В хранилище сохраняется hash, а не полный исходный запрос. Выбор hash/library внутри Backend не меняет API.

Порядок обработки:

1. Проверить текущую authentication (401) и antiforgery (403). Они не сохраняются в operation history.
2. Разобрать JSON и валидный UUID opId. Неразбираемый JSON, duplicate properties, отсутствие/невалидность opId —400, без записи. У login/logout нет domain opId. Отклонение транспорта до разбора тела не записывается.
3. Взять per-user guard, вычислить fingerprint и найти прежний результат. При совпадении сразу вернуть его; не переоценивать текущую entity version/availability/schedule. При несовпадении вернуть 409 idempotencyMismatch, не заменять прежнюю запись.
4. Для нового opId проверить закрытый DTO/ограничения, принадлежность цели и ссылок, If-Match (сначала entity 412), затем schedule (409), остальные предметные инварианты.
5. Окончательную предметную ошибку 400/404/409/412/428 сохранить под guard и commit без изменения entities/revisions. Тело ошибки и его correlationId относятся к исходному результату; header X-Correlation-ID относится к текущему HTTP-запросу.
6. При успехе atomically commit изменение и status/body/ETag/Location. После потери ответа повтор получает этот результат.
7. При инфраструктурном сбое/rollback окончательная запись не создаётся. Если ответ потерян после commit, следующая доставка обнаружит сохранённый результат.

Fingerprint mismatch не перезаписывает исходный operation result. При смене If-Match/baseScheduleVersion/полей после конфликта нужен новый opId. Повтор прежнего rejected opId остаётся прежним отказом, даже если новые условия теперь позволили бы действие. Error-result c current resource/revisions тоже может устареть.

Idempotency-Replayed=false для исходного окончательного предметного результата, true для replay. Status/body/ETag/Location сохраняются; auth cookie/token никогда не сохраняются/не воспроизводятся. HTTP Cache-Control остаётся no-store. История D1 не очищается автоматически; срок mobile offline и resync остаются отдельным решением.

Так как версии непрозрачны, Web не сравнивает их «больше/меньше». При позднем replay/ACK после нового локального действия он отмечает операцию подтверждённой и перечитывает ресурс/календарь либо оставляет актуальный identity-scoped кэш нетронутым. Старый ответ не затирает новые server data/unsaved draft.

## Ошибки и UI

Все ожидаемые ошибки — application/problem+json с type/title/status/detail/instance/code/correlationId; поле fieldErrors опционально. Детали не содержат секретов и чужих ресурсов.

| HTTP | Устойчивые code |
| --- | --- |
| 400 | validationFailed, unsupportedConstraint, invalidCursor, rangeTooLarge, invalidLocalTime, invalidUtcOffset, ambiguousAvailabilityBoundary, outsideAvailability |
| 401 | unauthorized; login: invalidCredentials, включая lockout без перечисления accounts |
| 403 | invalidAntiforgery, forbidden |
| 404 | notFound, referenceNotFound |
| 409 | idUnavailable, idempotencyMismatch, staleSchedule, fixedChangeRequiresConfirmation, invalidPlacementState, placementConflict, invalidExistingPlacement |
| 412 | staleEntity, staleDefinition |
| 428 | preconditionRequired |

Known unsupported constraints (flexible, split=true, rest>0, recurrence/goals/templates, другой собственный Place) —400 unsupportedConstraint, а не подмена допустимым DTO. Неизвестное изменяемое поле/enum/дата/число —400 validationFailed. Все ссылки проверяются, даже если список ресурсов уже фильтруется по user.

Конфликты 409/412 дают только current user data. StaleEntity возвращает currentServerVersion и текущую соответствующую сущность; staleDefinition — definition. StaleSchedule — currentPlanState. PlacementConflict — conflictingBlockIds текущего пользователя. Для version errors ETag относится к текущей соответствующей сущности, не к всему ProblemDetails.

Web сохраняет введённые поля при validation/conflict и даёт явное действие для ручного выбора/повтора с новой базой и новым opId. Network failure повторяет тот же смысл/opId. При 401 несохранённый ввод сохраняется только в scope старого аккаунта; вход другого account никогда не доставляет его мутации. Два account не делят кэш, cursor, opId result или черновики.

## Local-development auth config

Параметры выбраны координатором для локальной разработки 12.10.2026: SessionHours=24, MaxFailedAccessAttempts=5, LockoutMinutes=15. Это изменяемые параметры config, не SLA и не новое ACCEPTED-решение. Рекомендация автору для однозначного TTL — SlidingExpiration=false; координатор может выбрать другой local режим без изменения DTO. Session lifetime проверяется управляемым временем; при включении sliding renewal отдельно проверить idle и absolute lifetime.

Ключи защиты cookies должны сохраняться между локальными перезапусками в каталоге рабочего проекта вне исходников/репозитория, доступном процессу пользователя. Точный путь, режим доступа и локальный trust TLS принадлежат настройке координатора. Не выводить секреты в OpenAPI, config source или логи.

Два accounts подготавливаются из local secrets; публичной регистрации/recovery/email нет. Login/lockout не раскрывают существование account. HTTPS и Secure/Strict не ослабляются из-за proxy. GET antiforgery доступен анонимно; POST login проверяет анонимный/current-identity token. После login/logout старый token не используют под новой identity, bootstrap получают снова. Logout без текущего сеанса даёт 401 и Web всё равно очищает cache предыдущей identity.

## Небольшая структура реализации — рекомендация авторам

В одном существующем backend проекте достаточно разнести wire DTO/endpoints, сценарии/валидацию D1, PostgreSQL persistence и auth configuration. Можно использовать Features/D1, Data и Auth без новых проектов, сервисов и научных алгоритмов. Общая мутация проходит один command runner: authentication/CSRF → parse → guard/replay → validation/version checks → mutation/error result → commit.

DTO не привязывать к EF entities. Constraints snapshot хранится отдельно от live definition. Unique user+opId, occurrence→zero/one block и ownership обеспечиваются БД/предметной транзакцией. Индексы и EF mapping выбирает Backend в пределах выбранного поведения; опасных миграций/удалений нет. Версии не зависят от часов клиента.

Web может иметь один API helper для cookies/antiforgery/ProblemDetails/ETag, небольшой identity-scoped state и формы settings/definition/manual occurrence/calendar. API helper принимает отдельные opId/If-Match и не генерирует новый opId при автоматическом retry. При changing payload пользовательская новая попытка генерирует новый opId. Таймер/solver и month не добавляются.

Это рекомендации размера реализации, не новые утверждённые границы модулей. Автор кода может выбрать эквивалентную простую структуру без изменения общего контракта.

## Необходимые проверки реализации

Список ниже составлен architect до реализации; его первоначальные команды приведены в следующем разделе. Фактические интеграционные проверки координатора после реализации и оставшиеся ограничения записаны отдельно в [D1_STATUS.md](D1_STATUS.md).

- Вход/antiforgery bootstrap/logout; missing/wrong token; account separation и foreign targets/links/cursor/opId; real 401 без redirect.
- Воспроизводимый PostgreSQL путь создания/снимка/размещения/перезапуска; place=null до выбора и стабильный id после него.
- Независимые importance/difficulty/executionPriority; PUT definition сохраняет старый occurrence snapshot; PUT occurrence не меняет metadata.
- FixedWork 90 против окна 60 отклоняется без partial block/потери объёма; full 90 elapsed minutes через DST; split/flexible/rest/repeat/goals/unknown field не обнуляются.
- DST gap/overlap, неправильный offset, неоднозначные оконные границы и явное exception; ночное окно и соприкосновение двух блоков.
- Две вкладки на одном ETag: один accepted; placement конкурирует на occurrence ETag и scheduleVersion под guard; нет overlapping committed blocks.
- Fixed move/unplace/unfix и обход через PUT snapshot; explicit confirmation не обходит иные ограничения.
- Commit с потерянным ответом, concurrent same opId, payload/If-Match/query mismatch, replay успеха и окончательной ошибки, rollback без operation record, сохранение history между перезапусками.
- Старый replay после свежей мутации не затирает кэш; конфликт сохраняет ввод и разрешается новым opId/базой.
- TTL=24h, 5 failed attempts / lockout=15min, secret redaction, persisted cookie keys, Secure/Strict через HTTPS proxy.

## Фактическая проверка файлов

На этапе оформления прочитаны AGENTS.md, docs/README.md, PRODUCT.md, DECISIONS.md, FIRST_SLICE_PROPOSAL.md, DATA_MODEL.md, SYNC_DESIGN.md, PLANNING_RULES.md, ARCHITECTURE.md. До создания назначенных файлов проверено их отсутствие. Изменены только contracts/d1.openapi.json, contracts/README.md и этот документ.

Выполнен `python -B -c` со стандартной библиотекой: строгий JSON parse без duplicate keys/NaN, разрешение всех локальных `$ref`, уникальность operationId, соответствие path parameters, наличие обязательного antiforgery у POST/PUT и существование локальных Markdown-ссылок. Финальная редакция повторно проверена после явного добавления 400 для неизвестных query на auth bootstrap/me/settings: PASS; 13 paths, 18 операций, 49 schemas, 346 разрешённых ссылок (73 уникальные), все 18 операций документируют 400.

Выполнен `node -e` с ограниченным read-only checker: 70 schema/request/response examples соответствуют используемым ref/type/required/additionalProperties/const/enum/oneOf/anyOf/pattern/bounds/arrays/UUID/date правилам, PASS. Это проверка использованного подмножества JSON Schema, не полноценный OpenAPI validator. `jsonschema` и `openapi_spec_validator` проверены через importlib и отсутствуют; зависимости не устанавливались.

Отдельный `node -e` проверил 8 утверждений для приведённых Europe/Berlin gap/overlap, 23/25-часовых дней и 90 elapsed minutes по установленным Intl/IANA данным: PASS. Это проверка примеров документа, не серверной DST-реализации.

Build, установки, миграции, БД, auth и предметные тесты этим агентом не запускались. Reviewer-проверка передаётся координатору; до неё готовность D1 не объявляется. Полная сторонняя OAS-валидация не запускалась; результаты выше не заменяют её или интеграционные проверки.

Дополнение координатора 13.10.2026: после оформления и реализации установлен `openapi-spec-validator==0.9.0` в изолированной игнорируемой `.tools/openapi-venv` среде; полноценная проверка `contracts/d1.openapi.json` завершилась OK. Backend с настоящим PostgreSQL прошёл 28 тестов, финальный Web — 29 тестов, TypeScript и production build. После исправлений повторный reviewer подтвердил закрытие существенных находок. Эта запись относится к командам координатора и не изменяет первоначальный отчёт architect. Фактическая приёмка и ограничения — в D1_STATUS.md.

Официальные источники формата: [OpenAPI 3.1.0](https://spec.openapis.org/oas/v3.1.0.html), [HTTP If-Match/ETag](https://www.rfc-editor.org/rfc/rfc9110.html#name-if-match), [ASP.NET Core antiforgery](https://learn.microsoft.com/en-us/aspnet/core/security/anti-request-forgery?view=aspnetcore-10.0). Они поддерживают техническую форму контрактов; предметные решения Vibe берутся из принятого пакета.
