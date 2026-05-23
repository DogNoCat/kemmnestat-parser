/**
 * GENERATE UNIVERSITIES — парсер вузов РФ
 *
 * Запуск:
 *   node scripts/generate-universities.js              — все источники
 *   node scripts/generate-universities.js --source=vuzoteka
 *   node scripts/generate-universities.js --source=minobr
 *   node scripts/generate-universities.js --resume     — продолжить с места обрыва
 *   node scripts/generate-universities.js --limit=100  — обработать только N вузов
 *
 * Источники:
 *   1. minobrnauki.gov.ru/opendata — официальный реестр аккредитованных вузов
 *   2. vuzoteka.ru — баллы ЕГЭ, направления, стоимость
 *
 * Анти-бан меры:
 *   - Случайные User-Agent из пула реальных браузеров
 *   - Случайные паузы 2-5 секунд между запросами
 *   - Лимит запросов на прогон (MAX_REQUESTS_PER_RUN)
 *   - Автосохранение прогресса каждые 10 вузов
 *   - Graceful exit на 403/429
 *   - Резервный источник если основной упал
 */

const fs   = require('fs');
const path = require('path');

// ─── Конфиг ────────────────────────────────────────────────────
const args = process.argv.slice(2);
const SOURCE = args.find(a => a.startsWith('--source='))?.split('=')[1] || 'vuzoteka';
const RESUME = args.includes('--resume');
const LIMIT  = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1]) || null;

const SLEEP_MIN = 2000;   // 2 сек минимум
const SLEEP_MAX = 5000;   // 5 сек максимум — случайная пауза
const TIMEOUT_MS = 25000;

const MAX_REQUESTS_PER_RUN = 1500; // безопасный лимит на 1 прогон

const PROGRESS_FILE = path.join(__dirname, '.uni-progress.json');
const AUTOSAVE_EVERY = 10;

let requestCounter = 0;
let consecutiveBans = 0;

// ─── Пул User-Agent (реальные браузеры) ────────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function randomSleep() {
  return SLEEP_MIN + Math.random() * (SLEEP_MAX - SLEEP_MIN);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Безопасный fetch ──────────────────────────────────────────
async function safeFetch(url, options = {}) {
  if (requestCounter >= MAX_REQUESTS_PER_RUN) {
    throw new Error(`LIMIT_REACHED: ${MAX_REQUESTS_PER_RUN} req cap hit`);
  }
  if (consecutiveBans >= 5) {
    throw new Error('IP_BANNED: 5 consecutive 403/429 errors');
  }
  requestCounter++;

  const headers = {
    'User-Agent':      randomUA(),
    'Accept':          options.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control':   'no-cache',
    ...(options.headers || {}),
  };

  const retries = options.retries || 2;
  for (let i = 0; i < retries; i++) {
    try {
      const ctrl = new AbortController();
      const t    = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const res  = await fetch(url, { headers, signal: ctrl.signal });
      clearTimeout(t);

      if (res.status === 429) {
        consecutiveBans++;
        console.log(`   ⚠ 429 throttle (${consecutiveBans}/5) — sleep 45s`);
        await sleep(45000);
        continue;
      }
      if (res.status === 403) {
        consecutiveBans++;
        const body = await res.text().catch(() => '');
        if (consecutiveBans >= 3) {
          throw new Error(`IP_BANNED: ${body.slice(0, 100)}`);
        }
        console.log(`   ⚠ 403 (${consecutiveBans}/5) — sleep 90s`);
        await sleep(90000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      consecutiveBans = 0; // reset on success
      return options.json ? await res.json() : await res.text();
    } catch (e) {
      if (e.message && (e.message.startsWith('IP_BANNED') || e.message.startsWith('LIMIT_REACHED'))) {
        throw e;
      }
      if (i === retries - 1) throw e;
      await sleep(3000 + Math.random() * 2000);
    }
  }
}

// ─── Прогресс ──────────────────────────────────────────────────
function loadProgress() {
  if (!RESUME) return { universities: {}, processedIds: [] };
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      console.log(`✓ Resumed: ${Object.keys(data.universities).length} unis already processed`);
      return data;
    }
  } catch {}
  return { universities: {}, processedIds: [] };
}

function saveProgress(state) {
  try {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.log(`   ⚠ autosave fail: ${e.message}`);
  }
}

// ─── HTML парсинг (простой) ────────────────────────────────────
function decodeHtml(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .trim();
}

function stripTags(s) {
  return decodeHtml(s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
}

// ─── ADAPTER: MINOBRNAUKI (реестр аккредитованных вузов) ──────
const minobrAdapter = {
  name: 'minobrnauki.gov.ru',

  async sanityCheck() {
    const data = await safeFetch(
      'https://opendata.minobrnauki.gov.ru/opendata/7710539135-rsicheck/data.json',
      { json: true, retries: 1 },
    );
    return Array.isArray(data) ? data.length : 0;
  },

  async fetchAllUniversities() {
    // Реестр всех аккредитованных образовательных организаций
    const url = 'https://opendata.minobrnauki.gov.ru/opendata/7710539135-rsicheck/data.json';
    const data = await safeFetch(url, { json: true });

    if (!Array.isArray(data)) return [];

    return data
      .filter(u => u.OOName && u.OORegion)
      .map(u => ({
        id:        slugifyVuz(u.OOName),
        name:      u.OOName,
        short:     u.OOShortName || '',
        city:      u.OOAddrCity || '',
        region:    u.OORegion || '',
        type:      detectType(u.OOName),
        link:      u.OOWebSite || '',
        ogrn:      u.OOOgrn || '',
        inn:       u.OOInn || '',
        directions: [],  // заполняется на втором этапе через vuzoteka
      }));
  },
};

// ─── ADAPTER: VUZOTEKA.RU ──────────────────────────────────────
const vuzotekaAdapter = {
  name: 'vuzoteka.ru',

  async sanityCheck() {
    const html = await safeFetch('https://vuzoteka.ru/', { retries: 1 });
    return html.length;
  },

  /**
   * Поиск страницы вуза на vuzoteka по названию.
   * Возвращает URL карточки или null.
   */
  async findUniversityUrl(name) {
    const q = encodeURIComponent(name);
    const html = await safeFetch(`https://vuzoteka.ru/search?text=${q}`);
    // Парсим первую ссылку вида /вуз/...
    const m = html.match(/href="(\/[а-яa-z0-9-]+\/[а-яa-z0-9-]+)"/i);
    return m ? 'https://vuzoteka.ru' + m[1] : null;
  },

  /**
   * Парсинг карточки вуза → проходные баллы и направления.
   */
  async fetchUniversityDetails(url) {
    const html = await safeFetch(url);

    const directions = [];

    // Ищем блоки направлений по структуре vuzoteka:
    // <tr> с кодом ФГОС, названием, баллом
    const codeRegex = /\b(\d{2}\.\d{2}\.\d{2})\b[^<]*<[^>]*>([^<]+)<[^>]*>[\s\S]*?(\d{3})\s*бал/g;
    let match;
    while ((match = codeRegex.exec(html)) !== null) {
      directions.push({
        code:   match[1],
        name:   stripTags(match[2]),
        score:  parseInt(match[3]),
        budget: true,
        cost:   0,
      });
    }

    // Стоимость платного обучения
    const costRegex = /(\d{2,4})\s*(?:000|тыс\.?)\s*(?:руб|₽)/gi;
    let cm = html.match(costRegex);
    const cost = cm ? parseInt(cm[0]) : 0;

    return { directions, paidCost: cost };
  },
};

// ─── Утилиты ───────────────────────────────────────────────────
function slugifyVuz(name) {
  // Извлекаем аббревиатуру из названия типа «Московский (МГУ)»
  const abbr = name.match(/\(([А-ЯA-Z]{2,10})\)/);
  if (abbr) return abbr[1].toLowerCase();

  return name.toLowerCase()
    .replace(/[^a-zа-я0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

function detectType(name) {
  if (/колледж|техникум|училище/i.test(name)) return 'col';
  return 'uni';
}

// ─── Основной цикл ─────────────────────────────────────────────
async function main() {
  console.log('=== Generate Universities (anti-ban) ===');
  console.log(`Source: ${SOURCE} | Resume: ${RESUME} | Limit per run: ${MAX_REQUESTS_PER_RUN}`);
  console.log(`Sleep: ${SLEEP_MIN}-${SLEEP_MAX} ms (random)`);
  if (LIMIT) console.log(`Universities limit: ${LIMIT}`);
  console.log('');

  // Этап 1: загрузка списка вузов
  // Минобр часто недоступен с GitHub Actions из-за гео-ограничений — сразу читаем из репо
  console.log('Stage 1: Loading universities list...');
  let registry = loadExistingUnis();

  if (registry.length === 0) {
    console.log('  No existing files found. Trying minobrnauki.gov.ru...');
    try {
      registry = await minobrAdapter.fetchAllUniversities();
      console.log(`  ✓ Loaded ${registry.length} from minobr registry`);
    } catch (e) {
      console.error(`  ✗ Minobr failed: ${e.message}`);
    }
  } else {
    console.log(`  ✓ Loaded ${registry.length} universities from repo files`);
  }

  if (registry.length === 0) {
    console.error('\n✗ No universities to process. Make sure src/data/unis_*.js files exist in the repo.');
    console.error('  Copy unis_moscow.js, unis_spb_south.js, unis_ural_siberia.js, unis_fareast.js');
    console.error('  from the main KemMneStat project to this repo and rerun.');
    process.exit(1);
  }

  if (LIMIT) registry = registry.slice(0, LIMIT);

  // Этап 2: обогащение деталями через vuzoteka.ru
  const state = loadProgress();
  const remaining = registry.filter(u => !state.processedIds.includes(u.id));

  console.log(`Stage 2: Enriching ${remaining.length} unis via vuzoteka.ru`);
  console.log(`Estimated time: ${Math.round(remaining.length * (SLEEP_MIN + SLEEP_MAX) / 2 / 60000)} min\n`);

  let processed = 0;
  let aborted = false;

  for (const uni of remaining) {
    if (requestCounter >= MAX_REQUESTS_PER_RUN) {
      console.log(`\n⚠ LIMIT_REACHED — stop, save progress`);
      aborted = true;
      break;
    }

    try {
      const vurl = await vuzotekaAdapter.findUniversityUrl(uni.name);
      if (vurl) {
        await sleep(randomSleep());
        const details = await vuzotekaAdapter.fetchUniversityDetails(vurl);
        uni.directions = details.directions;
        uni.paidCost = details.paidCost;
      }
      state.universities[uni.id] = uni;
      state.processedIds.push(uni.id);
      processed++;
      console.log(`[${processed}/${remaining.length}] ${uni.id} (${uni.short || uni.name.slice(0, 40)}): ${uni.directions.length} dirs`);
    } catch (e) {
      if (e.message?.startsWith('IP_BANNED') || e.message?.startsWith('LIMIT_REACHED')) {
        console.log(`\n⚠ ${e.message}`);
        aborted = true;
        break;
      }
      console.log(`[${processed + 1}/${remaining.length}] ${uni.id}: SKIP (${e.message.slice(0, 60)})`);
    }

    if (processed % AUTOSAVE_EVERY === 0) {
      saveProgress(state);
    }

    await sleep(randomSleep());
  }

  saveProgress(state);

  // Этап 3: запись в файлы по регионам
  console.log('\nStage 3: Writing to data files...');
  writeRegionFiles(state.universities);

  console.log(`\nRequests used: ${requestCounter}/${MAX_REQUESTS_PER_RUN}`);
  console.log(`Universities processed: ${Object.keys(state.universities).length}`);
  if (aborted) {
    console.log('\nRun with --resume to continue from where it stopped.');
  } else {
    try { fs.unlinkSync(PROGRESS_FILE); } catch {}
    console.log('\n=== DONE ===');
  }
}

// ─── Группировка по регионам и запись файлов ──────────────────
function writeRegionFiles(universities) {
  const list = Object.values(universities);

  const buckets = {
    moscow:       [],
    spb_south:    [],
    ural_siberia: [],
    fareast:      [],
  };

  for (const u of list) {
    buckets[bucketForRegion(u.region)].push(u);
  }

  for (const [bucket, items] of Object.entries(buckets)) {
    const filepath = path.join(__dirname, '..', 'src', 'data', `unis_${bucket}.js`);
    const varName = `UNIS_${bucket.toUpperCase()}`;
    const statsName = `UNIS_${bucket.toUpperCase()}_STATS`;

    const content = `/**
 * Universities — ${bucket}
 * Generated by scripts/generate-universities.js
 * Last update: ${new Date().toISOString().split('T')[0]}
 */

export const ${varName} = [
${items.map(u => formatUni(u)).join('\n')}
];

export const ${statsName} = {
  total:        ${varName}.length,
  universities: ${varName}.filter(u => u.type === 'uni').length,
  colleges:     ${varName}.filter(u => u.type === 'col').length,
  regions:      [...new Set(${varName}.map(u => u.region))],
};
`;

    fs.writeFileSync(filepath, content, 'utf8');
    console.log(`  ✓ ${filepath} (${items.length} unis)`);
  }
}

function bucketForRegion(region) {
  const r = (region || '').toLowerCase();
  if (r.includes('москва') || r.includes('московская')) return 'moscow';
  if (r.includes('петербург') || r.includes('ленинград') || r.includes('калинин') ||
      r.includes('краснодар') || r.includes('ростов') || r.includes('крым') ||
      r.includes('севастополь') || r.includes('татарстан') || r.includes('волгоград') ||
      r.includes('нижегор') || r.includes('воронеж') || r.includes('саратов') ||
      r.includes('самар') || r.includes('ставрополь') || r.includes('астрахан') ||
      r.includes('башкорт')) {
    return 'spb_south';
  }
  if (r.includes('приморск') || r.includes('якут') || r.includes('хабаровск') ||
      r.includes('амурск') || r.includes('сахалин') || r.includes('камчат') ||
      r.includes('магадан') || r.includes('забайкал') || r.includes('тыва') ||
      r.includes('чукот') || r.includes('иркутск') || r.includes('бурят')) {
    return 'fareast';
  }
  return 'ural_siberia';
}

function formatUni(u) {
  const dirs = (u.directions || []).map(d =>
    `    {code:'${d.code}', name:'${escapeJs(d.name)}', score:${d.score || 0}, budget:${d.budget !== false}, cost:${d.cost || 0}}`,
  ).join(',\n');

  return `{
  id:'${u.id}', short:'${escapeJs(u.short || '')}',
  name:'${escapeJs(u.name)}',
  city:'${escapeJs(u.city || '')}', region:'${escapeJs(u.region || '')}', type:'${u.type || 'uni'}',
  link:'${u.link || ''}',
  profIds:[],
  dirs:[
${dirs}
  ],
},`;
}

function escapeJs(s) {
  return (s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function loadExistingUnis() {
  console.log('  Fallback: loading existing unis from src/data/unis_*.js');
  const files = ['unis_moscow.js', 'unis_spb_south.js', 'unis_ural_siberia.js', 'unis_fareast.js'];
  const all = [];
  for (const f of files) {
    const filepath = path.join(__dirname, '..', 'src', 'data', f);
    if (!fs.existsSync(filepath)) continue;
    try {
      let src = fs.readFileSync(filepath, 'utf8');
      src = src.replace(/^\s*import\s+[^;]+;?\s*$/gm, '');
      src = src.replace(/export\s+const\s+(\w+)\s*=/g, 'module.exports.$1 =');
      const m = { exports: {} };
      new Function('module', 'exports', src)(m, m.exports);
      const varName = Object.keys(m.exports).find(k => k.startsWith('UNIS_') && !k.endsWith('_STATS'));
      if (varName && Array.isArray(m.exports[varName])) {
        all.push(...m.exports[varName]);
      }
    } catch (e) {
      console.log(`     ⚠ Could not load ${f}: ${e.message.slice(0, 60)}`);
    }
  }
  return all;
}

main().catch(e => {
  console.error('\nFATAL:', e.message);
  process.exit(1);
});
