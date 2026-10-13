# Vibe — среда разработки Backend и Web

Обновлено 13.10.2026. Это факты о локальной среде; утверждённый объём D1 и фактическая приёмка описаны отдельно.

| Инструмент | Фактический результат |
| --- | --- |
| .NET SDK | Установлен 10.0.400; ASP.NET Core runtime 10.0.11. Обычный `dotnet --info` в sandbox не получил доступ к Service Control Manager; разрешённый повтор завершился успешно |
| Node.js | Доступен 24.19.0 из bundled runtime Codex |
| pnpm | Доступен 11.25.0 из bundled runtime Codex; отдельный npm в PATH не найден |
| Docker | CLI/engine 29.7.2; Docker Desktop запущен, проектный контейнер проверен |
| PostgreSQL | 18.6 в контейнере, loopback 54329, рабочая vibe и отдельная vibe_d1_tests; app role vibe без superuser/create privileges. Host psql не устанавливался |
| Backend packages | EF Core/Identity/Design/MVC.Testing 10.0.12, Npgsql EF 10.0.3, xUnit 2.9.3, runner 4.0.1, Test.Sdk 18.10.1; сборки и PostgreSQL-тесты выполнялись |
| Android | По сообщению владельца Kotlin/Android-среда отсутствуют; полный поиск SDK не проводился. Для начала Backend/Web они не нужны |
| Git | Исполняемый файл доступен; папка пока не Git-репозиторий. Коммиты не разрешены |

## Повторить проверку

Из папки проекта:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check_dev_environment.ps1
```

Скрипт только читает состояние. Он ищет инструменты в PATH и Node/pnpm в локальном runtime Codex; глобальные настройки и пакеты не меняет. Код 0 без `-RequireDatabase` означает доступность базовых команд. С этим флагом дополнительно требуется успешный SQL-запрос внутри проектного контейнера к vibe от ограниченной роли vibe, иначе exit2. Это socket-проверка; настоящий TCP доступ с private config отдельно подтверждают запуск Backend и PostgreSQL-тесты.

Для нового терминала вне Codex могут потребоваться отдельные Node.js/pnpm либо пути bundled runtime: скрипт показывает использованные пути. Системная установка не выполнялась.

## Порядок подготовки

1. T0 и D1 отдельно утверждены владельцем в DECISIONS.md. Общий D1 контракт находится в contracts/d1.openapi.json.
2. Выполнить scripts/prepare-local.ps1: Node создаёт случайные private secrets/accounts, затем PowerShell экспортирует локальную пару сертификат/ключ, если её ещё нет. Существующие конфигурация и пароли не перезаписываются; отсутствующие обязательные поля/несовпадающие TLS пути диагностируются.
3. Запустить Docker Desktop и docker compose up -d --wait. Compose использует PostgreSQL18 с фиксированным digest и named volume; initial script создаёт ограниченную app роль и отдельную тестовую БД. scripts/dev.ps1 backend явно применяет начальные migrations в Development.
4. Android Studio, JDK, Android SDK и эмулятор/устройство готовить перед этапом Android. Стек Kotlin/Compose/Room сохраняется.

Для T0 утверждены .NET 10 и React/TypeScript/Vite. .NET 10 относится к LTS по [официальной политике .NET](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core); требования к Node проверены по [официальной инструкции Vite](https://vite.dev/guide/) и метаданным пакета. Зафиксированы SDK10.0.400, React19.3.0, TypeScript7.0.2, Vite8.3.4 и @types/node24.19.2; Node24.19.0/pnpm11.25.0 доступны на этой машине. История T0 — DEVELOPMENT_STATUS.md, текущие проверки — D1_STATUS.md. Android/solver версии пока не выбраны.

## HTTPS и локальные файлы

Web: https://localhost:5173, preview: https://localhost:4173, API: https://localhost:5443. Пара PEM/key хранится в .tools/certs; private config и пароли — только под .tools, исключённой из исходников. Vite читает TLS на стороне Node, proxy проверяет CA и не отключает проверку сертификата.

12.10.2026 владелец отдельно разрешил доверие конкретному .NET сертификату CN=localhost (SHA-256 EF:EF:4D:42:D2:0D:45:BF:A4:20:CC:34:18:B9:10:56:A6:EA:E6:FD:73:8A:30:34:2A:C2:C0:D0:79:38:05:0D, срок до12.10.2027). Выполнены dotnet dev-certs https --trust и --check --trust; глобальные настройки Codex не менялись. На другом компьютере доверие добавляет владелец отдельно после подготовки.

После перемещения папки проекта абсолютные LocalHttps.CertificatePath/KeyPath в private config должны соответствовать новой .tools/certs. Подготовка сообщает несовпадение, не перезаписывая конфигурацию. Сохраняйте secrets и Docker volume; не сбрасывайте данные ради исправления пути.
