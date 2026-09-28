# pf.sites-s.ru — сервис SEO-аудита сайтов под Яндекс

Веб-сервис для аудита сайтов, проверки позиций в Яндексе, анализа семантического
ядра и конкурентов. Построен на **официальных API** вместо скрейпинга и антидетекта —
это надёжнее, легально и **не искажает Метрику/Вебмастер**.

> ⚠️ **О подходе.** Сервис намеренно **не содержит** эмуляции живого пользователя,
> ротации фингерпринтов, stealth-плагинов и резидентных прокси для обхода антибота
> Яндекса. Такой обход нарушает ToS Яндекса, ломается при каждом обновлении их
> антибота и даёт «грязные» данные. Вместо этого используются санкционированные
> источники: **Yandex Search API**, **Wordstat API**, **PageSpeed Insights API**,
> **Keys.so / Serpstat / Ahrefs API**. Подробнее — [docs/COMPLIANCE.md](docs/COMPLIANCE.md).

---

## Возможности

| Блок | Что делает | Источник данных |
|------|-----------|-----------------|
| **Позиции** | Позиция сайта по ключам, регион (`lr`), устройство, история | Yandex Search API v2 |
| **Аудит сайта** | Краулинг своего сайта с лимитами, битые ссылки (4xx/5xx), meta, H1–H6, robots/sitemap, дубли, редиректы | Собственный краулер (identifiable UA) |
| **Скорость** | LCP, FCP, TTFB, TTI по реально обойдённым страницам | PageSpeed Insights API (Lighthouse) |
| **Семантика** | Расширение ядра, кластеризация (SERP-пересечение + эмбеддинги), интент | Wordstat API + Search API + embeddings-сервис |
| **Конкуренты** | Топ-10 по кластеру, их ключи/позиции/страницы, пробелы, потенциал трафика | Search API + Keys.so / Serpstat / Ahrefs |
| **Задачи** | Создание/запуск/пауза/стоп, cron-расписание, история, повтор по шаблону | BullMQ + @nestjs/schedule |
| **Отчёты** | Дашборд, детальные отчёты, экспорт CSV/XLSX | PostgreSQL JSONB + exceljs |

---

## Стек и обоснование

- **Backend — NestJS (TypeScript).** Единый язык с фронтом, строгая модульность и DI,
  готовая интеграция с BullMQ и cron, удобные guards/pipes/DTO-валидация. Для сервиса
  из ~7 доменных модулей это даёт меньше boilerplate, чем FastAPI + ручная сборка DI.
- **Frontend — React + Vite + TypeScript.** Максимальная экосистема таблиц/графиков
  (TanStack Table, Recharts), общие типы с бэкендом, быстрый dev-сервер.
- **PostgreSQL + JSONB.** Реляционная часть (проекты, ключи, задачи) + гибкие отчёты
  в JSONB без отдельного документного хранилища.
- **Redis + BullMQ.** Очереди задач, повторные попытки, rate-limit к внешним API,
  распределение нагрузки во времени.
- **Prisma.** Единая декларативная схема данных + типобезопасный клиент + миграции.
- **Embeddings-сервис (Python/FastAPI + sentence-transformers).** Отдельный микросервис
  для семантической близости фраз; вызывается бэкендом по HTTP. Изолирует тяжёлые ML-зависимости.

---

## Структура репозитория

```
.
├── backend/            NestJS API + воркеры очередей
│   ├── prisma/         schema.prisma (модель данных)
│   └── src/
│       ├── config/     конфигурация из ENV
│       ├── prisma/     PrismaService
│       ├── queue/      имена очередей, продюсер
│       └── modules/
│           ├── projects/     проекты (сайты)
│           ├── keywords/     ключевые слова
│           ├── regions/      регионы Яндекса (lr)
│           ├── tasks/        задачи + расписание + запуски
│           ├── positions/    Yandex Search API, позиции
│           ├── audit/        краулер, битые ссылки, meta, скорость
│           ├── semantics/    Wordstat, кластеризация, потенциал
│           ├── competitors/  адаптеры Keys.so/Serpstat/Ahrefs, пробелы
│           └── reports/      агрегация + экспорт CSV/XLSX
├── frontend/           React SPA (дашборд, задачи, отчёты)
├── embeddings/         Python FastAPI + sentence-transformers
├── docs/               ARCHITECTURE / COMPLIANCE / API / VPS_SETUP
└── docker-compose.yml  postgres + redis + backend + frontend + embeddings
```

---

## Быстрый старт

```bash
cp .env.example .env            # заполнить ключи API (см. ниже)
docker compose up -d --build    # поднимет postgres, redis, backend, frontend, embeddings
docker compose exec backend npx prisma migrate deploy
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:3000/api
- Swagger: http://localhost:3000/api/docs

Локально без Docker — см. `backend/README` шаги в [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Необходимые ключи API

| Переменная | Для чего | Обязателен |
|------------|----------|-----------|
| `YANDEX_SEARCH_API_KEY`, `YANDEX_SEARCH_FOLDER_ID` | позиции (Yandex Search API v2) | да |
| `PAGESPEED_API_KEY` | LCP/FCP/TTFB | для метрик скорости |
| `WORDSTAT_OAUTH_TOKEN` | частотность | для семантики |
| `SERPSTAT_API_KEY` / `KEYSSO_API_KEY` / `AHREFS_API_TOKEN` | конкуренты | хотя бы один |
| `EMBEDDINGS_URL` | кластеризация по смыслу | опционально (fallback на SERP-пересечение) |

Без ключа соответствующий модуль корректно отключается (graceful degradation),
остальные работают.

---

## Как сервис не искажает Метрику и Вебмастер

1. **Позиции берутся из Yandex Search API** — запросы идут к API Яндекса, а не с
   ботовыми визитами на ваш сайт. В Метрике вашего сайта таких визитов нет вовсе.
2. **Краулер аудита** ходит по вашему сайту с фиксированным User-Agent
   `PF-SiteAudit/1.0 (+https://pf.sites-s.ru/bot)` и заголовком `X-PF-Audit: 1`.
   Добавьте этот UA в фильтр «Роботы» Метрики — визиты аудита не попадут в отчёты.
3. **Лимиты краула** (10–15 страниц/сессия, задержки, `robots.txt`) исключают
   нагрузку, которую Вебмастер мог бы счесть аномальной.

Подробности и настройка фильтров — [docs/COMPLIANCE.md](docs/COMPLIANCE.md).
