# Avatar Twitch OAuth

## Setup

1. Copy `.env.example` to `.env` and fill credentials:
   - `TWITCH_CLIENT_ID`
   - `TWITCH_CLIENT_SECRET`
   - optional: `TWITCH_SCOPES` (default `chat:read`)
2. Install deps:
   ```bash
   npm install
   ```
3. Provide infrastructure services:
   - **Redis 6+** (обязательно!) для распределённого состояния, event bus и блокировок (`REDIS_URL`, `REDIS_REQUIRED=true`)
   - SQLite для хранения пользователей и данных
4. Run:
   ```bash
   npm run start
   ```
5. Open `http://localhost:3000` and click "Вход".

Tokens and user are saved into `data.sqlite` for later chat access.

## Масштабируемость

Проект поддерживает одновременную работу 20–50+ стримеров благодаря:

### Ключевые улучшения

1. **Redis для распределённого состояния** — состояние ботов и игр хранится в Redis, что позволяет горизонтальное масштабирование
2. **Асинхронная очередь для БД** — SQLite операции выполняются через очередь, не блокируя event loop
3. **Динамический поллинг DonationAlerts** — параметры поллинга автоматически масштабируются по количеству стримеров
4. **Ленивая загрузка кэша** — пользователи загружаются по требованию вместо глобальной загрузки
5. **Мониторинг Redis** — health checks и метрики для отслеживания состояния системы

### Переменные окружения для масштабирования

```bash
# Redis (обязательно для масштабирования)
REDIS_URL=redis://localhost:6379
REDIS_REQUIRED=true
REDIS_TLS=false

# Параметры БД
DB_CONCURRENCY=4  # Количество параллельных операций БД

# Параметры поллинга DonationAlerts
DA_POLL_INTERVAL_MS=5000       # Базовый интервал опроса
DA_POLL_CONCURRENCY=4          # Базовый уровень параллелизма
DA_POLL_LOCK_TTL_MS=4500       # TTL блокировок
```

### Мониторинг

Эндпоинт `/health` предоставляет информацию о состоянии системы:
- Состояние Redis
- Метрики поллинга
- Статус масштабируемости

### Горизонтальное масштабирование

Система поддерживает запуск нескольких экземпляров приложения за балансировщиком:
- Redis обеспечивает координацию между экземплярами
- Redlock предотвращает дублирование обработки донатов
- Состояние игр синхронизируется через Redis
