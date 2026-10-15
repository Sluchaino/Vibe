# Vibe

Персональный планировщик на ASP.NET Core/.NET 10, PostgreSQL/EF Core и React/TypeScript/Vite. Реализованы D1: вход, задачи, отдельные выполнения и ручной календарь день/неделя; C1: отметка «Выполнено», снятие отметки и сохранение истории; S1: обновление двух Web-клиентов, сохранение черновиков и восстановление отправки. Фактические проверки и ограничения — в [S1_STATUS.md](docs/S1_STATUS.md), история — в [C1_STATUS.md](docs/C1_STATUS.md) и [D1_STATUS.md](docs/D1_STATUS.md).

Публичный репозиторий: [Sluchaino/Vibe](https://github.com/Sluchaino/Vibe).

![Обратимая отметка выполнения Vibe — демонстрационные данные](docs/images/vibe-c1-completed.png)

## Подготовка

На этой машине .NET SDK 10.0.400 и Docker Desktop уже установлены; Node 24.19.0 и pnpm 11.25.0 доступны через runtime Codex. Скрипты находят Node/pnpm и в обычном PowerShell. Android Studio/Kotlin сейчас не требуются.

Из корня проекта:

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\prepare-local.ps1
docker compose up -d --wait
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 web -WebCommand install
~~~

Docker Desktop должен работать. Подготовка создаёт локальные секреты и два аккаунта в `.tools/local-development.json`, сохраняя существующие пароли. Начальная PostgreSQL содержит отдельную БД `vibe_d1_tests`; тесты используют только её и свои временные схемы. Не удаляйте Docker volume для повторного запуска.

Разовое доверие сертификату на этой машине добавлено 12.10.2026 по отдельному разрешению владельца. На другом компьютере после подготовки выполните `dotnet dev-certs https --trust` самостоятельно и подтвердите Windows-диалог. Подготовительный скрипт доверие автоматически не добавляет.

## Запуск

Для обычного запуска на уже подготовленной машине сначала откройте Docker Desktop и дождитесь его готовности. В первом PowerShell-окне перейдите в проект и запустите БД и Backend:

```powershell
Set-Location C:\MyApps\MyProjects\Vibe
docker compose up -d --wait db
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 backend
```

Откройте второе PowerShell-окно и запустите Web:

```powershell
Set-Location C:\MyApps\MyProjects\Vibe
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 web
```

Оставьте оба окна открытыми и откройте в обычном браузере <https://localhost:5173/>. Backend: <https://localhost:5443/health>. Оба компонента слушают loopback. Остановить процесс: `Ctrl+C` в его терминале. Если порт уже занят работающим Vibe, откройте указанный адрес либо сначала остановите старый экземпляр. Backend в Development применяет миграции через явный флаг скрипта; данные сохраняются в Docker volume. Повторять первоначальную подготовку и установку зависимостей при каждом запуске не нужно.

Имена пользователей и пароли смотрите в локальном `.tools/local-development.json`, разделе `LocalDevelopment.SeedUsers`. Они не публикуются в исходниках. В интерфейсе: войти → задать место → создать категорию/задачу → открыть «Выполнения задачи» → создать выполнение → «В календарь» → выбрать дату, время и смещение UTC. Закреплённое время переносится только после отдельного подтверждения.

Изменения из другого клиента поступают автоматически: видимая вкладка опрашивает сервер примерно раз в 5 секунд, а также при возвращении к ней и восстановлении сети. Ввод в открытой форме сохраняется отдельно от свежих серверных данных. При конфликте нужно сравнить редакции и явно выбрать новую основу для отправки.

Черновики и одна неподтверждённая отправка на аккаунт сохраняются в IndexedDB браузера. После перезагрузки войдите в тот же аккаунт и откройте «Сохранённое в браузере». Повтор использует первоначальную операцию, а более новый ввод хранится отдельно. Разные адреса Web имеют разные локальные хранилища. Очистка данных браузера удаляет эти черновики; пароли и cookie в IndexedDB не сохраняются. Если локальное хранилище недоступно, просмотр работает, но новая отправка блокируется. Полноценный запуск и редактирование без сети в S1 не входят.

Завершение: во вкладке «Задачи» у конкретного выполнения нажмите «Отметить выполненным» и подтвердите действие в открывшейся карточке. Можно также открыть блок в календаре. После отметки доступна кнопка «Снять отметку»; её снятие возвращает полный остаток и редактирование условий/размещения. Другие выполнения задачи сохраняют свой статус. Сам календарный блок остаётся занятым с прежней длительностью. Фильтр «Все / Не выполненные / Выполненные» показывает текущий статус. После обновления Backend/Web до C1 перезагрузите старые вкладки.

Первичная подготовка зависимостей Web или восстановление после удаления node_modules:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 web -WebCommand install
```

В текущем Codex Node/pnpm доступны из bundled runtime. `scripts/dev.ps1` умеет найти эти пути и из обычного терминала. На другом компьютере установить подходящие Node/pnpm и .NET SDK; проверить команды через [check_dev_environment.ps1](scripts/check_dev_environment.ps1). Скрипт проверки не заменяет сборку.

## Проверки

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check_dev_environment.ps1 -RequireDatabase
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-backend.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 web -WebCommand test
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 web -WebCommand build
```

Для локального production preview: `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 web -WebCommand preview`, адрес <https://localhost:4173/>; Backend должен работать. Dev/preview передают `/api` и `/health` через HTTPS proxy с проверкой конкретного локального сертификата. Health проверяет процесс; готовность PostgreSQL проверяется отдельно.

В Windows sandbox команды могут не иметь доступа к NuGet.Config, registry или localhost. Разрешённый запуск снаружи sandbox нужен для таких операций; это не ошибка кода и не повод расширять права reviewer. Глобальные настройки Codex не меняются.

## Разработка

Утверждены [T0, D1, C1 и S1](docs/DECISIONS.md); остальные ADR остаются предложениями. Общий контракт — [contracts/d1.openapi.json](contracts/d1.openapi.json). Рабочие роли — [AGENT_USAGE.md](docs/AGENT_USAGE.md) и [AGENTS.md](AGENTS.md); требования и план — [docs/README.md](docs/README.md). Android, полная работа без сети, таймер и автопланирование остаются последующими этапами. C1 опубликован в GitHub по GH-02; коммит и отправка S1 отдельно разрешены владельцем по GH-03. Local config/пароли, сертификаты, БД и кэши в репозиторий не входят; на другой машине подготовка создаёт собственные секреты.
