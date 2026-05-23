# KemMneStat Parsers (v10 — final)

Промышленный парсер вакансий с hh.ru / trudvsem.ru для приложения «Кем мне стать?».
Запускается на GitHub Actions раз в 2 недели, отдаёт `vacancies.js` + `professions.js` с обновлёнными трендами.

## Что нового в v10

### Производительность
- **Параллельные запросы**: 3 группы одновременно — прогон 64 групп за ~5 минут (раньше 13)
- **Jitter в задержках** ± 400ms — снижает риск pattern-detection анти-бот системами
- **Опция `--sequential`** на случай агрессивного троттлинга

### Надёжность
- **HH_TOKEN валидация** — невалидный токен не сломает прогон, переключимся в анонимный режим
- **Retry-After заголовок** учитывается для 429 (если сервер просит ждать 60s, мы ждём 60s)
- **PID lock** — два прогона не стартуют параллельно
- **Backup** vacancies.js перед перезаписью + автовосстановление при self-validation fail
- **Self-validation** теперь проверяет схему: VACANCIES[id] is Array, STATS[id].totalCount is number

### Качество данных
- **Trend confidence**: при < 20 вакансиях тренд всегда `'flat'` (фильтр шума)
- **Salary percentiles**: STATS теперь содержит `p25`, `median`, `p75` — для диапазонов
- **Дедупликация** вакансий внутри группы по `id`
- **Truncate длинных полей**: title до 200, company до 100, city до 50 символов

### Observability
- **Прогрессбар** `[42/64 - 65%]` в каждой строке лога
- **Лог в файл** `.parser-log-YYYY-MM-DD.txt` (выгружается в artifact)
- **Финальный отчёт** со списком неуспешных групп и причинами
- **SIGINT/SIGTERM** обрабатывается корректно — graceful cleanup

## Запуск

### Стандартно (рекомендуется)
1. Actions → **Parse hh.ru vacancies** → Run workflow
2. Source: `auto` | Mode: `parallel` | Resume: `false`
3. ~5 минут → скачать artifact

### Если упало посередине
1. Run workflow → Resume: `true`
2. Прогресс из `.vacancies-progress.json` подхватится автоматически

### Если hh.ru банит даже на параллели
1. Run workflow → Mode: `sequential`
2. Запросы пойдут по одному, ~14 минут

### Принудительный источник
- Source: `trudvsem` — пропустить hh.ru
- Source: `hh` — только hh.ru, упадёт если 403

## OAuth

Получи токен на dev.hh.ru/admin:
1. Settings → Secrets → Actions → New secret
2. Name: `HH_TOKEN`, Value: токен
3. Скрипт сам провалидирует токен на старте

## Структура артефакта

После прогона скачивается архив с:
- `vacancies.js` — основной выход для приложения
- `professions.js` — с обновлёнными `trend` полями
- `.parser-log-*.txt` — полный лог прогона (для отладки)
- `.vacancies-history.json` — счётчики totalCount для следующих трендов
- `.vacancies-progress.json` — прогресс (если упал)

## Files

```
scripts/
  generate-vacancies.js     — v10 (1055 строк, production)
  generate-universities.js  — anti-ban vuzoteka.ru
src/data/
  professions.js            — 220 професий
  searchGroups.js           — 64 группы оптимизации
  unis_*.js                 — вузы 4 регионов
.github/workflows/
  parse.yml                 — вакансии (source/mode/resume inputs)
  parse-unis.yml            — вузы
```

## Troubleshooting

### "Another parser is running (PID X)"
Предыдущий прогон не убрал lock. Удали `.vacancies.lock` в Actions cache, либо `Sequential: true` создаёт свой.

### "Output exceeds 5 MB cap"
Слишком много вакансий. Уменьши `MAX_PER_GROUP` в CONFIG (сейчас 100).

### "HH_TOKEN invalid"
Токен на dev.hh.ru/admin истёк или отозван. Сгенерируй новый, обнови secret.

### "trudvsem.ru looks broken (only N for Python)"
trudvsem отдаёт меньше 100 вакансий — API сломан. Подожди час или используй `source: hh`.

### Прогон упал на 50%
Скачай artifact, посмотри `.parser-log-*.txt`. Запусти с Resume: `true`.

## Лимиты

- **GitHub Actions**: 2000 мин/месяц на public repo — хватит на 400 прогонов
- **hh.ru**: ~200 req/прогон (за лимит 250) — можно гонять каждый час, не забанят
- **trudvsem.ru**: 64 req/прогон, без лимитов (CC0 open data)
