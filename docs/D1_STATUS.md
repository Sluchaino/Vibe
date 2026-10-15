# Vibe — результат реализации D1

Этот отчёт фиксирует границу D1 на 13.10.2026. Последующий C1 с обратимой отметкой выполнения реализован и проверен 14.10.2026; текущий результат — [C1_STATUS.md](C1_STATUS.md).

Обновлено 13.10.2026. D1 ACCEPTED 12.10.2026 по явному ответу владельца; общие ADR вне этого пакета остаются DRAFT. Реализация локального D1 завершена: требуемые проверки выполнены, существенные замечания исправлены автором, повторный reviewer подтвердил закрытие. Результат передаётся владельцу как локальное Web-демо с приведёнными ниже ограничениями.

## Реализация

- Backend: 18 операций по [OpenAPI](../contracts/d1.openapi.json), Identity с Secure/HttpOnly/Strict cookies и antiforgery, PostgreSQL/EF Core, начальная миграция, ownership FK и per-user transaction guard.
- Задача, конкретное выполнение и календарный блок разделены. Снимок условий сохраняется независимо от будущих правок задачи. FixedWork размещается целиком; подтверждение фиксации не отменяет проверку окон/пересечений/версий.
- ETag/If-Match, scheduleVersion и opId; повтор успеха/окончательной ошибки сохраняет исходный результат. Точные числовые значения, нормализованные маршруты, строгие даты/offset, DST и ночные окна.
- Web: вход/выход, место/зона, категории, полные формы задач/выполнений, пагинация, день/неделя, place/move/unplace/setFixed, сравнение конфликта и явный выбор новой базы.
- Проектные scripts, Docker compose с PostgreSQL 18.6 и фиксированным digest, случайные локальные секреты. Код роли backend/frontend записывали последовательно без Git/worktree; architect анализировал контракт, coordinator владел общими файлами/lock и проверками.

## Фактические проверки координатора

| Проверка | Результат |
| --- | --- |
| Backend Release + PostgreSQL | 28 passed, 0 failed, 0 skipped; повтор через test-backend.ps1 также 28 passed. Отдельная vibe_d1_tests, собственная случайная schema; рабочая vibe не очищается |
| OpenAPI | openapi-spec-validator 0.9.0 в изолированной .tools среде: OK; первоначальные 13 paths / 18 операций / 49 schemas и 70 examples проверены architect ограниченным checker |
| Web TypeScript/tests/build | frozen install PASS до правок без изменения зависимостей. Последняя версия: TypeScript PASS, 29/29 Node tests PASS, Vite production build PASS через scripts/dev.ps1. Включены поздний ACK/error, identity после dispatch, unmount/refresh, double submit; добавлены 6 CSRF/auth race и 2 placement action regression |
| HTTPS запуск | API localhost:5443 и Web localhost:5173 запущены scripts/dev.ps1. Health 200, настоящий HTTPS login/settings 200, no-store и защищённые cookies проверены |
| PostgreSQL/инфраструктура | Docker engine 29.7.2, PostgreSQL18.6, role vibe без superuser/createdb/createrole; initial migration применена, после перезапуска новых миграций нет |
| Секреты/подготовка | PowerShell parse: 0 errors. prepare-local.ps1 повторно PASS; hash всех пяти private файлов до/после совпадает. Изолированные synthetic fixtures без нужных полей или с неверными TLS paths дают диагностический отказ без перезаписи. Четыре production assets просканированы: локальные passwords/private key отсутствуют |
| Vite FS/TLS | На dev 5173 и preview 4173: HTTPS / и /health 200, anonymous /api/v1/me 401. Private config, encoded .tools, @fs private path, .env, .pem/.key/.pfx дают 403. Публичный README вне web: dev 403; preview возвращает только index.html SPA fallback, 823 bytes |
| Перезапуск/preview | API перезапущен scripts/dev.ps1: migration up-to-date. Существующий browser cookie сохранил вход Anna и блок 10:00–11:30; собранный preview 4173 показал тот же календарь |
| Финальный вход/выход и документация | После auth-правок реальный logout → login Anna PASS, сохранённый блок показан. Финальный desktop повторно clientWidth=scrollWidth=1265. 56 локальных Markdown-ссылок существуют; временные проверочные вкладки и preview остановлены |
| Живой браузер | Вход → место → категория → задача high/light/priority4/90min → выполнение → размещение → явный fixed move → reload: сохранён полный блок 10:00–11:30 |
| Две вкладки | Старый draft сохранил базу после close/reopen; конкурирующая правка дала конфликт. Показаны обе полные редакции; explicit rebase и отдельное сохранение приняли выбранный draft |
| Финальный placement conflict | A открыл move 10:00/+03:00, B подтвердил unplace. В A получен staleEntity; после просмотра/принятия новой базы исходный move видим как недоступный. Submit без нового выбора показывает объяснение; дата/offset сохранены. Явный выбор place сохранил полный 90-min блок; reload показал 10:00–11:30. [Состояние после rebase](images/vibe-d1-placement-rebase.png) |
| CSRF race | Управляемый fetch/deferred test: первый POST Anna 403 → задержанный /me Anna → cookie Boris без epoch/Broadcast → token Boris → свежий /me Boris. Второй POST отсутствует; original opId/pending остаётся у Anna. Отдельно initial send, obsolete bootstrap/reset, logout/login/restore |
| Смена аккаунта | Данные Anna скрылись в первой вкладке после входа Boris во второй. Задачи/черновик Anna отсутствовали у Boris; после возврата Anna её draft восстановился |
| Размеры | 390: clientWidth=scrollWidth=375, день визуально проверен; 1280: clientWidth=scrollWidth=1265, неделя визуально проверена. Override сброшен. [Desktop](images/vibe-d1-desktop.png), [mobile](images/vibe-d1-mobile.png) |

Полный браузерный сценарий и размеры проверены до последних lifecycle-правок; эти правки отдельно прошли регрессионные тесты, TypeScript/build и реальный reload/preview после перезапуска API. Браузерное заполнение native date через fill само по себе не вызвало React change; проверка выполнена настоящими ArrowUp/ArrowDown, предпросмотр и сохранённое время совпали. Это наблюдение об инструменте проверки, а не подтверждённый дефект приложения.

## Ревью

Официальный CLI-сеанс 01a1311d-d7f9-7793-875e-b5d81f75c3e4 делегировал тому же custom reviewer без наследования истории. До чтения и на повторе подтверждены фактические sandbox read-only и approval never. Файлы/секреты не менялись; builds/tests/migrations reviewer не запускал.

Первоначальные canonical/decimal/newline/max-date замечания исправлены автором и проверены 28 тестами. Architect дополнительно нашёл giant exponent, minimum-date window, resolved path/login slash, Place oracle и различие target/reference 404; исправлены в том же пакете. Повторный reviewer не выявил существенных дефектов Backend; сообщил P2 о неполной подсказке первого запуска и P3 о недиагностированной неполной config. Координатор исправил scripts и проверил их фактически.

Полное Web-ревью выявило P1: retry после CSRF bootstrap мог отправить ввод Anna под новой cookie Boris, и P2: placement rebase сохранял недопустимый для новой базы action. Frontend исправил оба без изменения общего API/lock; координатор выполнил 29 tests/check/build, точную P1-цепочку через управляемый transport test и реальный P2-сценарий двух вкладок. Повторное целевое ревью: обе находки закрыты, новых actionable P0–P3 в scope нет. Проверены actual wiring шести целевых файлов и необходимые shared/lifecycle-связи; повторного полного обзора Backend не выполнялось. Reviewer выполнял только статический анализ, 29 tests и браузерные результаты принадлежат координатору.

## Ограничения

Черновики/pending разделены по userId в памяти вкладки и не переживают её перезагрузку/закрытие. Серверные данные сохраняются в PostgreSQL; Web offline/outbox не заявляются. Android, Completion/таймер/статистика, sync/change-log, solver, split/flexible, дорога/отдых, повторения/цели и месяц остаются следующими этапами.

Это локальная разработка. Production/backup/performance/a11y audit не выполнены. После завершения D1 владелец 13.10.2026 отдельно поручил первый коммит и публикацию исходников в публичный [Sluchaino/Vibe](https://github.com/Sluchaino/Vibe), GH-01. Проверка кандидатов публикации исключила live passwords, GitHub tokens, private keys, local DB/config и build caches. Изображения документации содержат синтетические демо-данные; local .tools не публикуется. Windows sandbox ограничивает некоторые сетевые/CLI операции; разрешённые запускаемые проверки выполнялись снаружи, reviewer оставался read-only.
