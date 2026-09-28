# Архитектура

## Компоненты

```
                      ┌───────────────┐
                      │   Frontend    │  React + Vite (SPA)
                      │ dashboard/... │
                      └───────┬───────┘
                              │ REST /api
                      ┌───────▼───────┐        ┌──────────────┐
                      │   Backend     │◄──────►│  PostgreSQL  │  проекты, ключи,
                      │   NestJS API  │        │   + JSONB    │  задачи, отчёты
                      └───┬───────┬───┘        └──────────────┘
             enqueue jobs │       │ cron (@nestjs/schedule)
                      ┌───▼───────▼───┐        ┌──────────────┐
                      │  BullMQ       │◄──────►│    Redis     │
                      │  workers      │        └──────────────┘
                      └───┬───────────┘
       ┌──────────────────┼───────────────────────────┬───────────────┐
       ▼                  ▼                            ▼               ▼
 Yandex Search API   PageSpeed API              Wordstat /       Embeddings
 (позиции, SERP)     (LCP/FCP/TTFB)             Serpstat/Keys.so  (FastAPI +
                                                /Ahrefs           s-transformers)
```

## Поток задачи (task run)

1. Пользователь создаёт **Task** (тип: `positions | audit | semantics | competitors`)
   с параметрами и (опц.) cron-расписанием.
2. **SchedulerService** по cron кладёт job в очередь BullMQ; ручной запуск — тоже job.
3. Процессор очереди создаёт **TaskRun** (status `running`), вызывает доменный сервис.
4. Доменный сервис обращается к внешним API с rate-limit и retry.
5. Результаты пишутся в нормализованные таблицы (позиции, страницы, ссылки) и в
   агрегированный **Report** (JSONB).
6. TaskRun → `success | failed`, статистика в JSONB, ошибки логируются по шагам.

## Модули backend

| Модуль | Ответственность |
|--------|-----------------|
| `projects` | сайты пользователя (домен, целевой URL, настройки) |
| `keywords` | ключи проекта, привязка к регионам, теги |
| `regions` | справочник регионов Яндекса (`lr`) |
| `tasks` | CRUD задач, расписание, запуски, повтор по шаблону |
| `positions` | Yandex Search API, вычисление позиции, история |
| `audit` | краулер (лимиты, robots), битые ссылки, meta/H, скорость (PageSpeed) |
| `semantics` | расширение ядра (Wordstat + Suggest), кластеризация, интент, потенциал |
| `competitors` | адаптеры Keys.so/Serpstat/Ahrefs, SERP-конкуренты, пробелы, приоритезация |
| `reports` | агрегация отчётов, экспорт CSV/XLSX |
| `queue` | имена очередей, продюсер, процессоры |

## Кластеризация семантики

Двухуровневый подход (industry-standard):

1. **Hard-кластеризация по SERP** — если у двух фраз пересекается ≥ N URL в топ-10
   (из Search API), они в одном кластере. Не требует ML, отражает мнение Яндекса.
2. **Semantic refine (опц.)** — эмбеддинги (`sentence-transformers`,
   мультиязычная модель) для слияния близких по смыслу групп и определения интента.
   Вызывается по HTTP к сервису `embeddings/`. При недоступности — только SERP-метод.

## Оценка потенциала трафика

`traffic = frequency (Wordstat) × CTR(position)` по CTR-кривой (см.
`semantics/ctr-model.ts`). Для кластера суммируется по фразам с учётом целевой позиции.

## Приоритезация кластеров

`score = w1·norm(volume) + w2·commercialValue + w3·(1 − difficulty) + w4·competitorGap`
Веса настраиваются на проект. `difficulty` оценивается по силе доменов в топ-10.

## Локальный запуск без Docker

```bash
# 1) инфраструктура
docker compose up -d postgres redis embeddings
# 2) backend
cd backend && npm i && npx prisma migrate dev && npm run start:dev
# 3) frontend
cd frontend && npm i && npm run dev
```

## Надёжность

- **Rate-limit** на каждый внешний API (BullMQ limiter + per-provider).
- **Retry** с экспоненциальной задержкой на сетевые ошибки.
- **Graceful degradation**: нет ключа провайдера → модуль отключён, остальное работает.
- **Идемпотентность** запусков: TaskRun фиксирует вход/выход, повтор по шаблону.
