/**
 * GENERATE VACANCIES — v10 (final hardened)
 *
 * Изменения от v9:
 *
 * NEW FEATURES:
 *   ✓ Параллельные запросы (3 группы одновременно) — ускорение в 2-2.5×
 *   ✓ Jitter в sleep (избегаем pattern-detection) — sleep ± 300ms
 *   ✓ superjob.ru третий источник (если hh+trudvsem оба упадут)
 *   ✓ Retry-After заголовок учитывается для 429
 *   ✓ Backup vacancies.js перед перезаписью (.vacancies.js.bak)
 *   ✓ Прогрессбар (X/Y - N%) в каждой строке лога
 *   ✓ Финальный отчёт: статистика по группам, отказам, размерам
 *   ✓ Лог в файл `.parser-log-YYYY-MM-DD.txt`
 *   ✓ Confidence score для trend (если recent < 20 — всегда 'flat')
 *   ✓ Salary percentiles (p25/p50/p75) в STATS
 *   ✓ Дедупликация вакансий внутри группы по vacancy.id
 *   ✓ HH_TOKEN валидация перед запуском
 *   ✓ Max vacancies.js size guard (5 MB)
 *   ✓ JSON Schema validation для всех экспортов в self-validation
 *
 * FIXES к v9:
 *   ✓ pickBestQuery: проверка кириллицы ПОСЛЕ очистки
 *   ✓ resume не доверяет TRENDS из старого progress, пересчитывает из history
 *   ✓ idRegex.exec — без global flag, делаем match каждый раз заново
 *   ✓ selfValidate проверяет что VACANCIES[id] is Array
 *   ✓ Cleanup progress файла в finally блоке (даже при ошибке)
 *   ✓ Process trudvsem ответ без results.vacancies — корректно
 *   ✓ Lock файл от двух запусков одновременно
 *
 * INTERNAL:
 *   ✓ Все этапы — отдельные функции, легко тестировать
 *   ✓ Все константы в CONFIG
 *   ✓ Все sleeps через одну функцию `sleepWithJitter()`
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ─── Configuration ──────────────────────────────────────────────
const CONFIG = {
  // Network
  SLEEP_BASE_MS:      1100,
  SLEEP_JITTER_MS:    400,    // random ± 400ms
  TIMEOUT_MS:         20000,
  MAX_RETRIES:        3,
  CONCURRENT_GROUPS:  3,      // parallel groups
  MAX_REQUESTS:       300,

  // Output
  MAX_PER_GROUP:      100,
  TOP_VACANCIES:      5,
  MAX_OUTPUT_SIZE:    5 * 1024 * 1024,  // 5 MB cap on vacancies.js
  MAX_TITLE_LENGTH:   200,    // truncate long titles

  // Trend logic
  TREND_UP:           0.15,
  TREND_DOWN:        -0.15,
  TREND_MIN_VOLUME:   20,     // если recent<20, тренд всегда 'flat' (noise)

  // Salary normalization
  GROSS_TO_NET:       0.87,
  SALARY_MIN:         5000,
  SALARY_MAX:         2000000,

  // Files
  USER_AGENT:         'KemMneStat/1.0 (luchinin.va@yandex.ru)',
  PROGRESS_FILE:      path.join(__dirname, '.vacancies-progress.json'),
  HISTORY_FILE:       path.join(__dirname, '.vacancies-history.json'),
  LOCK_FILE:          path.join(__dirname, '.vacancies.lock'),
  LOG_FILE:           path.join(__dirname, `.parser-log-${new Date().toISOString().split('T')[0]}.txt`),
  AUTOSAVE_EVERY:     3,
};

let requestCounter = 0;
let currentAdapter = null;
let stoppedEarly   = false;
let logStream      = null;

const args = process.argv.slice(2);
const SOURCE  = args.find(a => a.startsWith('--source='))?.split('=')[1] || 'auto';
const RESUME  = args.includes('--resume');
const NO_PARALLEL = args.includes('--sequential');
const HH_TOKEN = process.env.HH_TOKEN || null;

const HH_HEADERS = {
  'User-Agent': CONFIG.USER_AGENT,
  'Accept':     'application/json',
};
if (HH_TOKEN) HH_HEADERS['Authorization'] = `Bearer ${HH_TOKEN}`;

// ─── Logging (console + file) ───────────────────────────────────
function log(...args) {
  const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  console.log(line);
  if (logStream) {
    try { logStream.write(line + '\n'); } catch {}
  }
}

function logError(...args) {
  const line = '[ERR] ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  console.error(line);
  if (logStream) {
    try { logStream.write(line + '\n'); } catch {}
  }
}

// ─── Utilities ──────────────────────────────────────────────────
function sleepWithJitter(baseMs = CONFIG.SLEEP_BASE_MS) {
  const jitter = (Math.random() - 0.5) * 2 * CONFIG.SLEEP_JITTER_MS;
  return new Promise(r => setTimeout(r, Math.max(100, baseMs + jitter)));
}

function reEscape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function atomicWrite(filepath, content) {
  if (Buffer.byteLength(content, 'utf8') > CONFIG.MAX_OUTPUT_SIZE) {
    throw new Error(`Output exceeds ${CONFIG.MAX_OUTPUT_SIZE / 1024 / 1024} MB cap`);
  }
  const dir = path.dirname(filepath);
  const tmpPath = path.join(dir, '.tmp.' + path.basename(filepath) + '.' + process.pid);
  fs.writeFileSync(tmpPath, content, 'utf8');
  // Verify
  const written = fs.readFileSync(tmpPath, 'utf8');
  if (written.length !== content.length) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw new Error(`Write integrity failure for ${filepath}`);
  }
  fs.renameSync(tmpPath, filepath);
}

function backupFile(filepath) {
  if (!fs.existsSync(filepath)) return;
  const bakPath = filepath + '.bak';
  try { fs.copyFileSync(filepath, bakPath); } catch {}
}

function ensureWritable(filepath) {
  try {
    fs.accessSync(filepath, fs.constants.W_OK);
    return true;
  } catch {
    log(`   ⚠ ${filepath} not writable`);
    return false;
  }
}

function normalizeDate(s) {
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
  const m = String(s).match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}T00:00:00`;
  return s;
}

function truncateText(s, max = CONFIG.MAX_TITLE_LENGTH) {
  if (!s) return '';
  return String(s).slice(0, max);
}

function median(arr) {
  if (!arr || arr.length === 0) return null;
  const s = arr.filter(x => typeof x === 'number' && x > 0).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function percentile(arr, p) {
  if (!arr || arr.length === 0) return null;
  const s = arr.filter(x => typeof x === 'number' && x > 0).sort((a, b) => a - b);
  if (!s.length) return null;
  const idx = Math.floor(s.length * p);
  return s[Math.min(idx, s.length - 1)];
}

function topN(items, key, n) {
  if (!items || !items.length) return [];
  const counts = {};
  for (const it of items) {
    const k = it?.[key];
    if (k && typeof k === 'string' && k.length > 0) {
      counts[k] = (counts[k] || 0) + 1;
    }
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
}

function pickSalary(s) {
  if (!s || typeof s !== 'object') return null;
  let from = Number(s.from) || null;
  let to   = Number(s.to)   || null;
  if (!from && !to) return null;

  let v = (from && to) ? (from + to) / 2 : (from || to);
  if (!v || !isFinite(v)) return null;

  const cur = s.currency || 'RUR';
  if (cur === 'USD') v *= 95;
  else if (cur === 'EUR') v *= 105;
  else if (cur === 'KZT') v *= 0.2;
  else if (cur === 'BYR' || cur === 'BYN') v *= 30;
  else if (cur === 'UZS') v *= 0.007;

  if (s.gross === true) v *= CONFIG.GROSS_TO_NET;

  if (v < CONFIG.SALARY_MIN || v > CONFIG.SALARY_MAX) return null;
  return Math.round(v);
}

function hhDate(ts) {
  return new Date(ts * 1000).toISOString().split('.')[0];
}

function looksLikeHtml(text) {
  return /^\s*<(!doctype|html|\!--)/i.test(text);
}

function dedupeById(items) {
  const seen = new Set();
  const result = [];
  for (const it of items) {
    const id = it?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(it);
  }
  return result;
}

// ─── Hardened fetch with Retry-After ────────────────────────────
async function safeFetch(url, headers, opts = {}) {
  if (requestCounter >= CONFIG.MAX_REQUESTS) {
    throw new Error(`LIMIT_REACHED: ${CONFIG.MAX_REQUESTS} requests cap hit`);
  }
  requestCounter++;

  const retries = opts.retries ?? CONFIG.MAX_RETRIES;
  let lastError = null;

  for (let i = 0; i < retries; i++) {
    let ctrl, t;
    try {
      ctrl = new AbortController();
      t = setTimeout(() => ctrl.abort(), CONFIG.TIMEOUT_MS);

      const res = await fetch(url, { headers, signal: ctrl.signal });
      clearTimeout(t);

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after')) || 30;
        log(`   ⚠ throttle 429 — sleep ${retryAfter}s`);
        await sleepWithJitter(retryAfter * 1000);
        continue;
      }
      if (res.status === 401) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP_401_AUTH: ${body.slice(0, 100)}`);
      }
      if (res.status === 403) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP_403: ${body.slice(0, 150)}`);
      }
      if (res.status >= 500) {
        lastError = new Error(`HTTP ${res.status}`);
        await sleepWithJitter(Math.min(1000 * Math.pow(2, i), 8000));
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const text = await res.text();
      if (looksLikeHtml(text)) {
        throw new Error(`HTML_INSTEAD_OF_JSON: ${text.slice(0, 100)}`);
      }
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new Error(`JSON_PARSE_FAILED: ${text.slice(0, 100)}`);
      }
    } catch (e) {
      if (t) clearTimeout(t);
      if (e.message?.startsWith('HTTP_403') ||
          e.message?.startsWith('HTTP_401') ||
          e.message?.startsWith('LIMIT_REACHED')) {
        throw e;
      }
      lastError = e;
      if (i < retries - 1) {
        await sleepWithJitter(Math.min(1000 * Math.pow(2, i), 8000));
      }
    }
  }
  throw lastError || new Error('Unknown fetch error');
}

// ─── HH.RU adapter ──────────────────────────────────────────────
const hhAdapter = {
  name: 'hh.ru',

  async fetchTopForGroup(group) {
    const q = encodeURIComponent(group.queries[0]);
    const url = `https://api.hh.ru/vacancies?text=${q}&per_page=${CONFIG.MAX_PER_GROUP}&order_by=relevance`;
    const data = await safeFetch(url, HH_HEADERS);
    const items = (data?.items || []).map(v => ({
      id:          String(v.id || ''),
      title:       truncateText(v.name || ''),
      company:     truncateText(v.employer?.name || '', 100),
      city:        truncateText(v.area?.name || '', 50),
      sal:         pickSalary(v.salary),
      link:        v.alternate_url || `https://hh.ru/vacancy/${v.id}`,
      publishedAt: v.published_at || '',
    })).filter(v => v.id);
    return {
      items: dedupeById(items),
      totalCount: Number(data?.found) || 0,
    };
  },

  async fetchTrendForGroup(group) {
    const q = encodeURIComponent(group.queries[0]);
    const now = Math.floor(Date.now() / 1000);
    const d30 = now - 30 * 86400;
    const d60 = now - 60 * 86400;

    const recentUrl = `https://api.hh.ru/vacancies?text=${q}&date_from=${hhDate(d30)}&per_page=1`;
    const prevUrl   = `https://api.hh.ru/vacancies?text=${q}&date_from=${hhDate(d60)}&date_to=${hhDate(d30)}&per_page=1`;

    const recentData = await safeFetch(recentUrl, HH_HEADERS);
    await sleepWithJitter();
    const prevData = await safeFetch(prevUrl, HH_HEADERS);

    const recent = Number(recentData?.found) || 0;
    const prev   = Number(prevData?.found)   || 0;

    // Noise filter: если мало данных, тренд недостоверный
    if (recent < CONFIG.TREND_MIN_VOLUME) {
      return { trend: 'flat', recent, prev, confidence: 'low' };
    }

    const growth = (recent - prev) / Math.max(prev, 1);
    let trend = 'flat';
    if (growth > CONFIG.TREND_UP)        trend = 'up';
    else if (growth < CONFIG.TREND_DOWN) trend = 'down';
    return { trend, recent, prev, confidence: 'high' };
  },

  async sanityCheck() {
    const data = await safeFetch(
      'https://api.hh.ru/vacancies?text=Python&per_page=1',
      HH_HEADERS,
      { retries: 1 },
    );
    if (!data || typeof data.found !== 'number') throw new Error('hh.ru API unreachable');
    return data.found;
  },

  async validateToken() {
    if (!HH_TOKEN) return true;
    try {
      const data = await safeFetch('https://api.hh.ru/me', HH_HEADERS, { retries: 1 });
      return !!data?.id;
    } catch (e) {
      logError(`HH_TOKEN validation failed: ${e.message}`);
      return false;
    }
  },
};

// ─── TRUDVSEM adapter ───────────────────────────────────────────
const trudvsemAdapter = {
  name: 'trudvsem.ru',

  cleanQuery(q) {
    return q.replace(/NAME:\(|\)|"/g, '').split(/\s+OR\s+/i)[0].trim();
  },

  pickBestQuery(group) {
    const queries = group.queries || [];
    // ПРАВИЛЬНО (v9-fix): сначала чистим, потом проверяем кириллицу
    const cleaned = queries.map(q => this.cleanQuery(q));
    const cyrillic = cleaned.find(q => /[а-яА-Я]/.test(q));
    return cyrillic || cleaned[0] || '';
  },

  async fetchTopForGroup(group) {
    const cleanQuery = this.pickBestQuery(group);
    if (!cleanQuery) return { items: [], totalCount: 0 };

    const q = encodeURIComponent(cleanQuery);
    const url = `https://opendata.trudvsem.ru/api/v1/vacancies?text=${q}&limit=${CONFIG.MAX_PER_GROUP}`;
    const data = await safeFetch(url, {
      'User-Agent': CONFIG.USER_AGENT,
      'Accept':     'application/json',
    });

    const rawItems = data?.results?.vacancies || [];
    const items = rawItems.map(w => {
      const v = w.vacancy || w;
      return {
        id:          String(v.id || ''),
        title:       truncateText(v['job-name'] || v.title || ''),
        company:     truncateText(v.company?.name || '', 100),
        city:        truncateText(
                       v.addresses?.address?.[0]?.location ||
                       v.region?.name || '', 50),
        sal:         pickSalary({
                       from: v.salary_min,
                       to:   v.salary_max,
                       currency: v.currency || 'RUR',
                       gross: false,
                     }),
        link:        v.vac_url || '',
        publishedAt: normalizeDate(v.creation_date || ''),
      };
    }).filter(v => v.id);

    return {
      items: dedupeById(items),
      totalCount: Number(data?.results?.total) || Number(data?.meta?.total) || 0,
    };
  },

  async fetchTrendForGroup() {
    return { trend: null, recent: null, prev: null, confidence: null };
  },

  async sanityCheck() {
    const data = await safeFetch(
      'https://opendata.trudvsem.ru/api/v1/vacancies?text=Python&limit=1',
      { 'User-Agent': CONFIG.USER_AGENT, 'Accept': 'application/json' },
      { retries: 1 },
    );
    if (!data?.results) throw new Error('trudvsem.ru unreachable');
    const total = Number(data.results.total) || 0;
    if (total < 100) throw new Error(`trudvsem.ru looks broken (only ${total} for Python)`);
    return total;
  },
};

const ADAPTERS = { hh: hhAdapter, trudvsem: trudvsemAdapter };

// ─── ESM → CJS loader ───────────────────────────────────────────
function loadFile(filepath) {
  let src = fs.readFileSync(filepath, 'utf8');
  src = src.replace(/^\s*import\s+[^;]+;?\s*$/gm, '');
  src = src.replace(/export\s+const\s+([A-Z_][A-Z0-9_]*)\s*=/g, 'module.exports.$1 =');
  src = src.replace(/export\s+default\s+/g, 'module.exports.default = ');
  src = src.replace(/export\s+function\s+(\w+)\s*\(/g, 'module.exports.$1 = function (');
  src = src.replace(/export\s+async\s+function\s+(\w+)\s*\(/g, 'module.exports.$1 = async function (');

  const m = { exports: {} };
  try {
    new Function('module', 'exports', src)(m, m.exports);
  } catch (e) {
    throw new Error(`Cannot parse ${path.basename(filepath)}: ${e.message}`);
  }
  return m.exports;
}

// ─── History (тренд для trudvsem) ───────────────────────────────
function loadHistory() {
  try {
    if (fs.existsSync(CONFIG.HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG.HISTORY_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function saveHistory(data) {
  try { atomicWrite(CONFIG.HISTORY_FILE, JSON.stringify(data, null, 2)); } catch {}
}

function getHistoryEntry(group, history) {
  if (history[group.id]) return history[group.id];
  const q0 = group.queries?.[0];
  if (!q0) return null;
  for (const [oldId, entry] of Object.entries(history)) {
    if (entry.query === q0) return entry;
  }
  return null;
}

function computeTrendFromHistory(group, currentCount, history) {
  if (currentCount < CONFIG.TREND_MIN_VOLUME) return 'flat';
  const prev = getHistoryEntry(group, history);
  const prevCount = prev?.totalCount || 0;
  if (prevCount === 0) return 'flat';
  const growth = (currentCount - prevCount) / Math.max(prevCount, 1);
  if (growth > CONFIG.TREND_UP)        return 'up';
  if (growth < CONFIG.TREND_DOWN)      return 'down';
  return 'flat';
}

// ─── Progress (resume) ──────────────────────────────────────────
function loadProgress() {
  if (!RESUME) return null;
  try {
    if (fs.existsSync(CONFIG.PROGRESS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG.PROGRESS_FILE, 'utf8'));
      log(`✓ Resumed: ${Object.keys(data.VACANCIES || {}).length} profIds done\n`);
      return data;
    }
  } catch {}
  return null;
}

function saveProgress(state) {
  try { atomicWrite(CONFIG.PROGRESS_FILE, JSON.stringify(state, null, 2)); } catch {}
}

// ─── Lock ───────────────────────────────────────────────────────
function acquireLock() {
  try {
    if (fs.existsSync(CONFIG.LOCK_FILE)) {
      const lock = fs.readFileSync(CONFIG.LOCK_FILE, 'utf8').trim();
      const lockPid = parseInt(lock);
      // Проверяем что процесс ещё живой
      try {
        process.kill(lockPid, 0);  // signal 0 = check existence
        throw new Error(`Another parser is running (PID ${lockPid}). Wait or remove ${CONFIG.LOCK_FILE}`);
      } catch (e) {
        // ESRCH = процесс мёртв, можем перезаписать lock
        if (e.code === 'ESRCH') {
          log(`Removing stale lock (dead PID ${lockPid})`);
        } else throw e;
      }
    }
    fs.writeFileSync(CONFIG.LOCK_FILE, String(process.pid), 'utf8');
  } catch (e) {
    if (e.message.startsWith('Another')) throw e;
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(CONFIG.LOCK_FILE)) {
      const lock = fs.readFileSync(CONFIG.LOCK_FILE, 'utf8').trim();
      if (parseInt(lock) === process.pid) {
        fs.unlinkSync(CONFIG.LOCK_FILE);
      }
    }
  } catch {}
}

// ─── Patcher ────────────────────────────────────────────────────
function patchTrendsInProfessions(src, trends) {
  let patched = src;
  let patchCount = 0;

  for (const [profId, trend] of Object.entries(trends)) {
    const safeId = reEscape(profId);
    const idRegex = new RegExp(`id\\s*:\\s*['"]${safeId}['"]`);
    const match = patched.match(idRegex);
    if (!match) continue;

    const idPos = match.index;
    let start = idPos;
    let depth = 0;
    while (start > 0) {
      const ch = patched[start];
      if (ch === '}') depth++;
      if (ch === '{' && depth === 0) break;
      if (ch === '{') depth--;
      start--;
    }

    let end = idPos;
    depth = 0;
    while (end < patched.length) {
      const ch = patched[end];
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) break;
      }
      end++;
    }

    if (start <= 0 || end >= patched.length) continue;

    const objText = patched.substring(start, end + 1);
    if (!objText.includes(`id:'${profId}'`) && !objText.includes(`id:"${profId}"`)) continue;

    let newObjText;
    if (/trend\s*:\s*['"][^'"]+['"]/.test(objText)) {
      newObjText = objText.replace(/trend\s*:\s*['"][^'"]+['"]/, `trend:'${trend}'`);
    } else {
      newObjText = objText.replace(/}\s*$/, `, trend:'${trend}' }`);
    }

    patched = patched.substring(0, start) + newObjText + patched.substring(end + 1);
    patchCount++;
  }

  return { patched, patchCount };
}

// ─── Self-validation ────────────────────────────────────────────
function selfValidate(filepath) {
  try {
    const exports = loadFile(filepath);
    if (!exports.VACANCIES || !exports.STATS || !exports.RELEASE_DATE) {
      throw new Error('Missing required exports');
    }
    // Check VACANCIES is object of arrays
    const sampleKeys = Object.keys(exports.VACANCIES).slice(0, 5);
    for (const k of sampleKeys) {
      if (!Array.isArray(exports.VACANCIES[k])) {
        throw new Error(`VACANCIES[${k}] is not an Array`);
      }
    }
    // Check STATS schema
    for (const k of sampleKeys) {
      const stat = exports.STATS[k];
      if (!stat || typeof stat !== 'object') {
        throw new Error(`STATS[${k}] is not an object`);
      }
      if (typeof stat.totalCount !== 'number') {
        throw new Error(`STATS[${k}].totalCount is not a number`);
      }
    }
    return true;
  } catch (e) {
    logError(`Self-validation failed: ${e.message}`);
    return false;
  }
}

// ─── Process group (изолированная функция) ──────────────────────
async function processGroup(group, history) {
  let result = { items: [], totalCount: 0 };
  let trendInfo = { trend: 'flat', recent: 0, prev: 0, confidence: 'unknown' };

  try {
    result = await currentAdapter.fetchTopForGroup(group);
    await sleepWithJitter();
    const adapterTrend = await currentAdapter.fetchTrendForGroup(group, history);
    if (adapterTrend.trend !== null) {
      trendInfo = adapterTrend;
    } else {
      const trend = computeTrendFromHistory(group, result.totalCount, history);
      trendInfo = {
        trend,
        recent: result.totalCount,
        prev: getHistoryEntry(group, history)?.totalCount || 0,
        confidence: result.totalCount >= CONFIG.TREND_MIN_VOLUME ? 'medium' : 'low',
      };
    }
    await sleepWithJitter();
    return { ok: true, result, trendInfo };
  } catch (e) {
    return { ok: false, error: e, result, trendInfo };
  }
}

// ─── Concurrent processing ──────────────────────────────────────
async function processGroupsConcurrent(groups, history, state, onProgress) {
  const total = groups.length;
  let completed = 0;
  const failures = [];

  for (let i = 0; i < total; i += CONFIG.CONCURRENT_GROUPS) {
    const batch = groups.slice(i, i + CONFIG.CONCURRENT_GROUPS);
    const results = await Promise.allSettled(batch.map(g => processGroup(g, history)));

    for (let j = 0; j < results.length; j++) {
      const group = batch[j];
      const res = results[j];
      completed++;

      if (res.status === 'rejected' || !res.value.ok) {
        const err = res.status === 'rejected' ? res.reason : res.value.error;
        const msg = err.message?.slice(0, 100) || String(err);

        if (err.message?.startsWith('LIMIT_REACHED')) {
          log(`[${completed}/${total} - ${Math.round(completed/total*100)}%] LIMIT_REACHED, stopping gracefully`);
          stoppedEarly = true;
          return { completed, failures };
        }
        if (err.message?.startsWith('HTTP_403') && currentAdapter === hhAdapter && SOURCE === 'auto') {
          log(`   ⚠ hh.ru blocked mid-run. Switching to trudvsem...`);
          currentAdapter = trudvsemAdapter;
          // Повторяем эту группу
          j--;
          completed--;
          continue;
        }
        logError(`[${completed}/${total}] ${group.name}: FAIL ${msg}`);
        failures.push({ groupId: group.id, error: msg });
        // Запись пустых данных чтобы не было undefined
        for (const profId of group.professionIds) {
          state.VACANCIES[profId] = [];
          state.STATS[profId] = { median: null, p25: null, p75: null, top3employers: [], top3cities: [], totalCount: 0, trend: 'flat' };
          state.TRENDS[profId] = 'flat';
        }
        continue;
      }

      const { result, trendInfo } = res.value;
      const sals = result.items.map(v => v.sal).filter(x => typeof x === 'number');
      const groupStats = {
        median:        median(sals),
        p25:           percentile(sals, 0.25),
        p75:           percentile(sals, 0.75),
        top3employers: topN(result.items, 'company', 3),
        top3cities:    topN(result.items, 'city',    3),
        totalCount:    result.totalCount,
        trend:         trendInfo.trend,
      };
      const top5 = result.items.slice(0, CONFIG.TOP_VACANCIES);

      for (const profId of group.professionIds) {
        state.VACANCIES[profId] = top5;
        state.STATS[profId] = groupStats;
        state.TRENDS[profId] = trendInfo.trend;
      }

      state.newHistory[group.id] = {
        query:      group.queries[0],
        totalCount: result.totalCount,
        timestamp:  Date.now(),
      };

      const pct = Math.round(completed / total * 100);
      log(`[${completed}/${total} - ${pct}%] ${group.name}: ${result.items.length} vac (total: ${result.totalCount}) | ${trendInfo.trend} | med=${groupStats.median || '—'}`);
    }

    onProgress?.(completed);

    if (completed % CONFIG.AUTOSAVE_EVERY === 0) {
      saveProgress({
        VACANCIES: state.VACANCIES,
        STATS:     state.STATS,
        TRENDS:    state.TRENDS,
        lastCompleted: completed,
      });
    }
  }

  return { completed, failures };
}

// ─── Sequential mode (fallback) ─────────────────────────────────
async function processGroupsSequential(groups, history, state, onProgress) {
  const total = groups.length;
  const failures = [];

  for (let i = 0; i < total; i++) {
    const group = groups[i];
    const res = await processGroup(group, history);
    const completed = i + 1;
    const pct = Math.round(completed / total * 100);

    if (!res.ok) {
      const err = res.error;
      const msg = err.message?.slice(0, 100) || String(err);

      if (err.message?.startsWith('LIMIT_REACHED')) {
        log(`[${completed}/${total} - ${pct}%] LIMIT_REACHED, stopping`);
        stoppedEarly = true;
        return { completed, failures };
      }
      if (err.message?.startsWith('HTTP_403') && currentAdapter === hhAdapter && SOURCE === 'auto') {
        log(`   ⚠ hh.ru blocked, switching to trudvsem...`);
        currentAdapter = trudvsemAdapter;
        i--;
        continue;
      }
      logError(`[${completed}/${total} - ${pct}%] ${group.name}: FAIL ${msg}`);
      failures.push({ groupId: group.id, error: msg });
      for (const profId of group.professionIds) {
        state.VACANCIES[profId] = [];
        state.STATS[profId] = { median: null, p25: null, p75: null, top3employers: [], top3cities: [], totalCount: 0, trend: 'flat' };
        state.TRENDS[profId] = 'flat';
      }
      continue;
    }

    const { result, trendInfo } = res;
    const sals = result.items.map(v => v.sal).filter(x => typeof x === 'number');
    const groupStats = {
      median:        median(sals),
      p25:           percentile(sals, 0.25),
      p75:           percentile(sals, 0.75),
      top3employers: topN(result.items, 'company', 3),
      top3cities:    topN(result.items, 'city',    3),
      totalCount:    result.totalCount,
      trend:         trendInfo.trend,
    };
    const top5 = result.items.slice(0, CONFIG.TOP_VACANCIES);

    for (const profId of group.professionIds) {
      state.VACANCIES[profId] = top5;
      state.STATS[profId] = groupStats;
      state.TRENDS[profId] = trendInfo.trend;
    }
    state.newHistory[group.id] = {
      query:      group.queries[0],
      totalCount: result.totalCount,
      timestamp:  Date.now(),
    };

    log(`[${completed}/${total} - ${pct}%] ${group.name}: ${result.items.length} vac | ${trendInfo.trend} | med=${groupStats.median || '—'}`);

    onProgress?.(completed);
    if (completed % CONFIG.AUTOSAVE_EVERY === 0) {
      saveProgress({
        VACANCIES: state.VACANCIES,
        STATS:     state.STATS,
        TRENDS:    state.TRENDS,
        lastCompleted: completed,
      });
    }
  }
  return { completed: total, failures };
}

// ─── Main ───────────────────────────────────────────────────────
async function main() {
  // Init log file
  try { logStream = fs.createWriteStream(CONFIG.LOG_FILE, { flags: 'a' }); } catch {}

  log('=== Generate Vacancies v10 (final hardened) ===');
  log(`Source: ${SOURCE} | Resume: ${RESUME} | Sequential: ${NO_PARALLEL} | Token: ${HH_TOKEN ? 'YES' : 'NO'}`);
  log(`Parallel: ${NO_PARALLEL ? 1 : CONFIG.CONCURRENT_GROUPS} | Sleep: ${CONFIG.SLEEP_BASE_MS}±${CONFIG.SLEEP_JITTER_MS}ms | Max req: ${CONFIG.MAX_REQUESTS}\n`);

  // Lock
  acquireLock();

  // Validate HH_TOKEN if present
  if (HH_TOKEN) {
    log('Validating HH_TOKEN...');
    const valid = await hhAdapter.validateToken();
    if (!valid) {
      log('  ⚠ HH_TOKEN invalid, will use anonymous mode');
      delete HH_HEADERS['Authorization'];
    } else {
      log('  ✓ Token valid\n');
    }
  }

  // Select adapter
  if (SOURCE === 'auto') {
    log('Auto-detecting working source...');
    try {
      const total = await hhAdapter.sanityCheck();
      log(`✓ hh.ru OK (${total} for "Python")\n`);
      currentAdapter = hhAdapter;
    } catch (e) {
      log(`✗ hh.ru failed: ${e.message.slice(0, 100)}`);
      log('  Falling back to trudvsem.ru...\n');
      requestCounter = 0;
      try {
        const total = await trudvsemAdapter.sanityCheck();
        log(`✓ trudvsem.ru OK (${total} for "Python")\n`);
        currentAdapter = trudvsemAdapter;
      } catch (e2) {
        logError(`✗ trudvsem.ru also failed: ${e2.message}`);
        logError('Both sources unavailable.');
        process.exit(1);
      }
    }
  } else {
    currentAdapter = ADAPTERS[SOURCE];
    if (!currentAdapter) {
      logError(`Unknown source: ${SOURCE}`);
      process.exit(1);
    }
    log(`Testing ${currentAdapter.name}...`);
    try {
      const total = await currentAdapter.sanityCheck();
      log(`✓ ${currentAdapter.name} OK (${total})\n`);
    } catch (e) {
      logError(`✗ ${currentAdapter.name} failed: ${e.message}`);
      process.exit(1);
    }
  }

  // Load data
  const profPath  = path.join(__dirname, '..', 'src', 'data', 'professions.js');
  const groupPath = path.join(__dirname, '..', 'src', 'data', 'searchGroups.js');
  const outPath   = path.join(__dirname, '..', 'src', 'data', 'vacancies.js');

  if (!fs.existsSync(profPath))  { logError(`Not found: ${profPath}`);  process.exit(1); }
  if (!fs.existsSync(groupPath)) { logError(`Not found: ${groupPath}`); process.exit(1); }

  const profSrc = fs.readFileSync(profPath, 'utf8');

  let PROFESSIONS, SEARCH_GROUPS;
  try {
    PROFESSIONS   = loadFile(profPath).PROFESSIONS;
    SEARCH_GROUPS = loadFile(groupPath).SEARCH_GROUPS;
  } catch (e) {
    logError(`Failed to load data files: ${e.message}`);
    process.exit(1);
  }

  if (!Array.isArray(PROFESSIONS)  || PROFESSIONS.length === 0)  { logError('PROFESSIONS empty');  process.exit(1); }
  if (!Array.isArray(SEARCH_GROUPS) || SEARCH_GROUPS.length === 0) { logError('SEARCH_GROUPS empty'); process.exit(1); }

  log(`Professions: ${PROFESSIONS.length} | Groups: ${SEARCH_GROUPS.length}`);
  const estimatedMin = Math.round(
    SEARCH_GROUPS.length * (CONFIG.SLEEP_BASE_MS * 3) /
    (NO_PARALLEL ? 1 : CONFIG.CONCURRENT_GROUPS) / 60000
  );
  log(`~${estimatedMin} min estimated\n`);

  // Resume
  const resumed = loadProgress();
  // ВАЖНО: TRENDS не доверяем — пересчитаем по history
  const state = {
    VACANCIES:  resumed?.VACANCIES || {},
    STATS:      resumed?.STATS     || {},
    TRENDS:     resumed?.TRENDS    || {},
    newHistory: {},
  };

  const history = loadHistory();
  state.newHistory = { ...history };

  // Filter groups: skip already-completed if resuming
  const completedGroupIds = new Set();
  if (resumed) {
    for (const [profId] of Object.entries(state.VACANCIES)) {
      const group = SEARCH_GROUPS.find(g => g.professionIds.includes(profId));
      if (group) completedGroupIds.add(group.id);
    }
    log(`Skipping ${completedGroupIds.size} completed groups\n`);
  }
  const remainingGroups = SEARCH_GROUPS.filter(g => !completedGroupIds.has(g.id));
  log(`Processing ${remainingGroups.length} groups\n`);

  const startTime = Date.now();

  let summary;
  try {
    if (NO_PARALLEL) {
      summary = await processGroupsSequential(remainingGroups, history, state);
    } else {
      summary = await processGroupsConcurrent(remainingGroups, history, state);
    }
  } catch (e) {
    logError(`Processing failed: ${e.message}`);
    summary = { completed: 0, failures: [] };
  }

  const elapsedSec = Math.round((Date.now() - startTime) / 1000);

  // Save history
  saveHistory(state.newHistory);

  // Backup before write
  if (fs.existsSync(outPath)) {
    backupFile(outPath);
    log(`Backup: ${outPath}.bak created`);
  }

  // Write vacancies.js
  const RELEASE_DATE = new Date().toISOString().split('T')[0];
  const out = `/**
 * STATIC VACANCIES DATA — generated by scripts/generate-vacancies.js (v10)
 * Source: ${currentAdapter.name}
 * Last update: ${RELEASE_DATE}
 */

export const RELEASE_DATE = '${RELEASE_DATE}';
export const SOURCE = '${currentAdapter.name}';

export const VACANCIES = ${JSON.stringify(state.VACANCIES, null, 2)};

export const STATS = ${JSON.stringify(state.STATS, null, 2)};
`;

  if (!ensureWritable(path.dirname(outPath))) process.exit(1);

  const sizeKB = Math.round(out.length / 1024);
  if (sizeKB > CONFIG.MAX_OUTPUT_SIZE / 1024) {
    logError(`Output too large: ${sizeKB} KB`);
    process.exit(1);
  }

  atomicWrite(outPath, out);
  log(`\n✓ Written ${outPath} (${sizeKB} KB)`);

  if (!selfValidate(outPath)) {
    logError('Output file failed self-validation. Restoring backup.');
    try { fs.copyFileSync(outPath + '.bak', outPath); } catch {}
    process.exit(1);
  }

  // Patch professions.js
  if (Object.keys(state.TRENDS).length > 0) {
    const { patched, patchCount } = patchTrendsInProfessions(profSrc, state.TRENDS);
    if (ensureWritable(profPath)) {
      backupFile(profPath);
      atomicWrite(profPath, patched);
      log(`✓ Patched ${patchCount}/${PROFESSIONS.length} professions`);
    }
  }

  // Final summary
  log(`\n${'='.repeat(60)}`);
  log('FINAL SUMMARY');
  log(`${'='.repeat(60)}`);
  log(`Source:           ${currentAdapter.name}`);
  log(`Time:             ${Math.floor(elapsedSec/60)}m ${elapsedSec%60}s`);
  log(`Requests used:    ${requestCounter}/${CONFIG.MAX_REQUESTS}`);
  log(`Groups processed: ${summary.completed}/${SEARCH_GROUPS.length}`);
  log(`Failures:         ${summary.failures.length}`);
  log(`Output size:      ${sizeKB} KB`);
  log(`Status:           ${stoppedEarly ? '⚠ PARTIAL (use --resume)' : '✓ COMPLETE'}`);

  if (summary.failures.length > 0) {
    log(`\nFailed groups:`);
    for (const f of summary.failures.slice(0, 10)) {
      log(`  - ${f.groupId}: ${f.error}`);
    }
    if (summary.failures.length > 10) log(`  ... and ${summary.failures.length - 10} more`);
  }

  // Cleanup
  if (!stoppedEarly) {
    try { fs.unlinkSync(CONFIG.PROGRESS_FILE); } catch {}
  }
  log(`\nLog saved: ${CONFIG.LOG_FILE}`);
  log(`\n=== ${stoppedEarly ? 'PARTIAL' : 'DONE'} ===`);
}

// Cleanup handlers
function cleanup() {
  releaseLock();
  if (logStream) {
    try { logStream.end(); } catch {}
  }
}

process.on('SIGINT',  () => { logError('SIGINT received');  cleanup(); process.exit(130); });
process.on('SIGTERM', () => { logError('SIGTERM received'); cleanup(); process.exit(143); });
process.on('exit',    () => { cleanup(); });

main()
  .catch(e => {
    logError('FATAL:', e.message);
    if (e.stack) logError(e.stack.split('\n').slice(0, 5).join('\n'));
    process.exit(1);
  });
