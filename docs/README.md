# Документация Vibe

Обновлено 14 октября 2026 года. Архитектура в целом остаётся DRAFT; отдельно утверждены T0, D1 и C1 с реализацией Backend/Web. Эти решения и их границы записаны в DECISIONS.md. Локальный C1 реализован и проверен; Android остаётся последующим этапом.

| Документ | Назначение |
| --- | --- |
| [AGENT_USAGE.md](AGENT_USAGE.md) | Инструкция владельцу: выбор ролей, готовые поручения, управление работой |
| [PRODUCT.md](PRODUCT.md) | Требования владельца, сценарии, качества продукта, открытые вопросы |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Предлагаемые компоненты, границы, общий API, технические ограничения |
| [DATA_MODEL.md](DATA_MODEL.md) | Сущности, связи, инварианты и различия понятий |
| [PLANNING_RULES.md](PLANNING_RULES.md) | Жёсткие/мягкие ограничения, длительность, дорога, отдых, перепланирование |
| [SYNC_DESIGN.md](SYNC_DESIGN.md) | Локальная очередь, версии, конфликты, защита расписания |
| [ROADMAP.md](ROADMAP.md) | Этапы, зависимости, первый MVP и критерии готовности |
| [DECISIONS.md](DECISIONS.md) | Заданные ограничения и предложения ADR для утверждения |
| [AGENT_SETUP.md](AGENT_SETUP.md) | Формат Codex, запуск команды, проверка и ограничения среды |
| [SETUP_VALIDATION.md](SETUP_VALIDATION.md) | Фактические результаты проверки настройки |
| [DEV_ENVIRONMENT.md](DEV_ENVIRONMENT.md) | Инструменты Backend/Web, проверка среды и отложенная подготовка Android |
| [FIRST_SLICE_PROPOSAL.md](FIRST_SLICE_PROPOSAL.md) | Утверждённые пакеты T0 и D1 |
| [DEVELOPMENT_STATUS.md](DEVELOPMENT_STATUS.md) | Что действительно создано, собрано и проверено на этапе T0 |
| [D1_STATUS.md](D1_STATUS.md) | Реализация, проверки и ограничения текущего D1 |
| [D1_IMPLEMENTATION_NOTES.md](D1_IMPLEMENTATION_NOTES.md) | Точные wire/transaction/time правила выбранного пакета |
| [COMPLETION_SLICE_PROPOSAL.md](COMPLETION_SLICE_PROPOSAL.md) | Утверждённый C1 ревизии 2: обратимая отметка конкретного выполнения, сохранение истории и календарного блока |
| [C1_STATUS.md](C1_STATUS.md) | Реализация C1, фактические проверки и ограничения |
| [contracts/README.md](../contracts/README.md) | Общий OpenAPI D1 и примеры |

Обозначения: **REQ** — исходное требование владельца, перенесённое для сверки; **PROPOSED** — предложение команды; **OPEN** — нужен выбор владельца. Ни один документ целиком не считается утверждённым до явной записи решения в DECISIONS.md.

Порядок чтения: PRODUCT → DECISIONS → FIRST_SLICE_PROPOSAL → D1_IMPLEMENTATION_NOTES → contracts/d1.openapi.json для текущей реализации. ARCHITECTURE/DATA_MODEL/PLANNING_RULES/SYNC_DESIGN/ROADMAP описывают также будущий продукт. Правила команды — [AGENTS.md](../AGENTS.md), запуск — [README.md](../README.md), код — [Backend](../backend/Vibe.Api/Program.cs) и [Web](../web/src/App.tsx).
