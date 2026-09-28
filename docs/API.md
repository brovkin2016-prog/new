# REST API (обзор)

Базовый префикс: `/api`. Аутентификация: `Authorization: Bearer <JWT>`.
Полная интерактивная спека — Swagger на `/api/docs`.

## Auth
| Метод | Путь | Описание |
|------|------|----------|
| POST | `/auth/register` | регистрация |
| POST | `/auth/login` | логин → JWT |

## Projects
| Метод | Путь |
|------|------|
| GET/POST | `/projects` |
| GET/PATCH/DELETE | `/projects/:id` |

## Keywords
| Метод | Путь |
|------|------|
| GET/POST | `/projects/:projectId/keywords` |
| POST | `/projects/:projectId/keywords/bulk` — массовое добавление |
| PATCH/DELETE | `/keywords/:id` |

## Regions
| GET | `/regions` | справочник (`lr`, название) |

## Tasks
| Метод | Путь | Описание |
|------|------|----------|
| GET/POST | `/projects/:projectId/tasks` | список / создать |
| GET/PATCH/DELETE | `/tasks/:id` | |
| POST | `/tasks/:id/run` | запустить сейчас |
| POST | `/tasks/:id/pause` / `/resume` / `/stop` | управление |
| GET | `/tasks/:id/runs` | история запусков |
| POST | `/tasks/:id/runs/:runId/rerun` | повтор по шаблону |

Тело создания задачи:
```json
{
  "type": "positions|audit|semantics|competitors",
  "name": "string",
  "params": { "keywordIds": [], "regionCodes": [], "device": "desktop", "maxPages": 15 },
  "cron": "0 3 * * *"
}
```

## Positions
| GET | `/projects/:id/positions?keywordId=&regionCode=&from=&to=` | история позиций |

## Audit
| GET | `/runs/:runId/audit/pages` | обойдённые страницы + метрики |
| GET | `/runs/:runId/audit/broken-links` | битые ссылки |
| GET | `/runs/:runId/audit/issues` | тех. ошибки (robots, sitemap, дубли) |

## Semantics
| GET | `/projects/:id/semantics/core` | ядро + кластеры |
| POST | `/projects/:id/semantics/expand` | расширить по маркерам |
| GET | `/projects/:id/semantics/gaps` | пробелы vs конкуренты |

## Competitors
| GET | `/projects/:id/competitors?clusterId=` | топ конкурентов кластера |

## Reports
| GET | `/runs/:runId/report` | агрегированный отчёт (JSON) |
| GET | `/runs/:runId/report/export?format=csv|xlsx` | экспорт |

## Dashboard
| GET | `/dashboard/summary` | сводная статистика (кол-во задач, статусы, ошибки, ср. время) |
