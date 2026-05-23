/**
 * SEARCH GROUPS — оптимизация запросов к API сайтов трудоустройства
 *
 * Логика:
 *   - 220 профессий объединены в ~80 поисковых групп
 *   - Одна группа — один запрос на hh.ru/SuperJob/trudvsem
 *   - Результат группы распределяется по всем профессиям внутри
 *
 * Расчёт нагрузки на hh.ru:
 *   ~80 групп × 3 запроса (top-100 + recent trend + prev trend) = 240 запросов
 *   Обновление раз в 2 недели = 2 раза в месяц
 *   ИТОГО: ~480 запросов / месяц = ~16 запросов / день = 1 запрос каждые 90 минут
 *
 * Каждая группа имеет:
 *   - id            — машинный идентификатор
 *   - name          — человекочитаемое название (для UI/логов)
 *   - queries       — поисковые фразы (используем hh.ru синтаксис OR)
 *   - professionIds — какие профессии относятся к группе
 */

export const SEARCH_GROUPS = [
  // ─── IT (объединено в 8 групп вместо 36 проф) ─────────────────
  {
    id: 'dev-general',
    name: 'Программисты',
    queries: ['NAME:(разработчик OR программист OR developer)'],
    professionIds: ['frontend','backend','mobile-dev','1c-dev','game-dev','blockchain-dev','firmware-eng','tech-lead','solution-architect','ar-vr-dev','game-designer'],
  },
  {
    id: 'devops-cloud',
    name: 'DevOps / Cloud / SRE',
    queries: ['NAME:(devops OR sre OR cloud)'],
    professionIds: ['devops','cloud-eng','sre','network-eng'],
  },
  {
    id: 'data-ml',
    name: 'Данные и машинное обучение',
    queries: ['NAME:("data scientist" OR "data analyst" OR "machine learning" OR "ml engineer")'],
    professionIds: ['data-analyst','data-scientist','data-engineer','ml-eng','mlops-eng','nlp-eng','cv-eng','bi-developer','product-analyst'],
  },
  {
    id: 'cybersec',
    name: 'Кибербезопасность',
    queries: ['NAME:("информационная безопасность" OR cybersecurity OR "soc analyst" OR pentest)'],
    professionIds: ['cybersec','soc-analyst','smart-contract-auditor'],
  },
  {
    id: 'qa-test',
    name: 'QA / тестирование',
    queries: ['NAME:(qa OR тестировщик OR "quality assurance")'],
    professionIds: ['qa-eng','qa-automation'],
  },
  {
    id: 'analyst-it',
    name: 'IT-аналитики',
    queries: ['NAME:("системный аналитик" OR "бизнес аналитик" OR "business analyst")'],
    professionIds: ['sys-analyst','ba-it'],
  },
  {
    id: 'product-design',
    name: 'Продукт и дизайн интерфейсов',
    queries: ['NAME:("product manager" OR "ux ui" OR продакт)'],
    professionIds: ['product-manager','ux-ui','scrum-master'],
  },
  {
    id: 'iot-prompt',
    name: 'IoT и нейросетевые специалисты',
    queries: ['NAME:(iot OR "prompt engineer" OR "интернет вещей")'],
    professionIds: ['iot-eng','prompt-eng'],
  },

  // ─── MED (30 → 10 групп) ───────────────────────────────────
  {
    id: 'doctor-therapy',
    name: 'Терапевты и педиатры',
    queries: ['NAME:(терапевт OR педиатр)'],
    professionIds: ['therapist','pediatrician','paramedic'],
  },
  {
    id: 'doctor-surgical',
    name: 'Хирурги и узкие специалисты',
    queries: ['NAME:(хирург OR кардиолог OR невролог OR ортопед OR онколог OR уролог OR гинеколог)'],
    professionIds: ['surgeon','cardiologist','neurologist','orthopedist','oncologist','urologist','gynecologist','anesthesiologist','endocrinologist','gastroenterologist','hematologist','infectionist','dermatologist','allergist'],
  },
  {
    id: 'doctor-dental',
    name: 'Стоматологи',
    queries: ['NAME:(стоматолог OR dentist)'],
    professionIds: ['dentist'],
  },
  {
    id: 'pharmacy',
    name: 'Фармацевты',
    queries: ['NAME:(фармацевт OR провизор)'],
    professionIds: ['pharmacist'],
  },
  {
    id: 'nursing',
    name: 'Медсёстры и средний медперсонал',
    queries: ['NAME:("медсестра" OR "медицинская сестра" OR "медбрат" OR акушерка)'],
    professionIds: ['nurse','midwife','massage-therapist'],
  },
  {
    id: 'med-diag',
    name: 'Диагностика и лабораторная медицина',
    queries: ['NAME:(рентген OR МРТ OR радиолог OR эпидемиолог)'],
    professionIds: ['radiologist','mri-tech','epidemiologist'],
  },
  {
    id: 'optometry',
    name: 'Офтальмологи',
    queries: ['NAME:(офтальмолог OR optometrist)'],
    professionIds: ['optometrist'],
  },
  {
    id: 'psychiatry',
    name: 'Психиатры',
    queries: ['NAME:(психиатр)'],
    professionIds: ['psychiatrist'],
  },
  {
    id: 'rehabilitation',
    name: 'Реабилитация и физиотерапия',
    queries: ['NAME:(реабилитолог OR физиотерапевт OR логопед)'],
    professionIds: ['physiatrist','physiotherapist','speech-therapist-med'],
  },

  // ─── PSY (9 → 3) ──────────────────────────────────────────
  {
    id: 'psychologist-general',
    name: 'Психологи',
    queries: ['NAME:(психолог)'],
    professionIds: ['psychologist','school-psychologist','family-therapist','cbt-psy','corp-psy','sport-psy','forensic-psy','art-therapist','autism-aba'],
  },

  // ─── EDU (11 → 3) ─────────────────────────────────────────
  {
    id: 'teacher-school',
    name: 'Учителя',
    queries: ['NAME:(учитель OR преподаватель OR teacher)'],
    professionIds: ['teacher','methodologist','school-director','tutor','speech-coach','philologist','linguist'],
  },
  {
    id: 'teacher-kindergarten',
    name: 'Воспитатели и дефектологи',
    queries: ['NAME:(воспитатель OR дефектолог OR логопед OR тифлопедагог)'],
    professionIds: ['kindergarten-teacher','special-ed-teacher','speech-therapist','ped-psych'],
  },

  // ─── FIN (13 → 5) ─────────────────────────────────────────
  {
    id: 'fin-analyst',
    name: 'Финансовые аналитики',
    queries: ['NAME:("финансовый аналитик" OR "financial analyst")'],
    professionIds: ['fin-analyst','investment-banker','risk-manager','actuary','quant'],
  },
  {
    id: 'accountant',
    name: 'Бухгалтеры',
    queries: ['NAME:(бухгалтер OR accountant)'],
    professionIds: ['accountant'],
  },
  {
    id: 'auditor',
    name: 'Аудиторы',
    queries: ['NAME:(аудитор OR auditor OR комплаенс)'],
    professionIds: ['auditor','compliance','tax-consultant'],
  },
  {
    id: 'trader',
    name: 'Трейдеры',
    queries: ['NAME:(трейдер OR trader)'],
    professionIds: ['trader','crypto-trader','crypto-analyst'],
  },
  {
    id: 'insurance',
    name: 'Страховые агенты',
    queries: ['NAME:("страховой агент" OR "insurance agent")'],
    professionIds: ['insurance-agent'],
  },

  // ─── LAW (13 → 5) ─────────────────────────────────────────
  {
    id: 'lawyer-general',
    name: 'Юристы',
    queries: ['NAME:(юрист OR lawyer OR юрисконсульт)'],
    professionIds: ['lawyer','corp-lawyer','tax-lawyer','ip-lawyer','labor-lawyer','patent-attorney'],
  },
  {
    id: 'notary',
    name: 'Нотариусы',
    queries: ['NAME:(нотариус)'],
    professionIds: ['notary'],
  },
  {
    id: 'police',
    name: 'Полиция и силовики',
    queries: ['NAME:(полицейский OR следователь OR оперуполномоченный OR военный)'],
    professionIds: ['police-officer','military-officer','bailiff','criminologist','firefighter'],
  },
  {
    id: 'mediation',
    name: 'Медиаторы и судебные эксперты',
    queries: ['NAME:(медиатор OR mediator)'],
    professionIds: ['mediator'],
  },

  // ─── ENG (17 → 7) ─────────────────────────────────────────
  {
    id: 'eng-mech',
    name: 'Инженеры-механики',
    queries: ['NAME:("инженер механик" OR "инженер конструктор")'],
    professionIds: ['mech-eng','quality-eng','industrial-eng','process-eng'],
  },
  {
    id: 'eng-elec',
    name: 'Электрики и энергетики',
    queries: ['NAME:("инженер электрик" OR "электроэнергетик")'],
    professionIds: ['electrical-eng','renewable-eng','automation-eng'],
  },
  {
    id: 'eng-aero',
    name: 'Инженеры авиа и космос',
    queries: ['NAME:(авиастроение OR "ракетный двигатель" OR "космический инженер")'],
    professionIds: ['aerospace-eng'],
  },
  {
    id: 'eng-oil',
    name: 'Нефтегазовая инженерия',
    queries: ['NAME:("инженер нефтяник" OR "нефтегаз" OR "буровая")'],
    professionIds: ['oil-eng','pipeline-eng','mineral-eng'],
  },
  {
    id: 'eng-metal',
    name: 'Металлурги и сварщики',
    queries: ['NAME:(металлург OR сварщик)'],
    professionIds: ['metallurgist','welder-eng'],
  },
  {
    id: 'eng-robotics',
    name: 'Робототехника и автоматизация',
    queries: ['NAME:(робототехник OR мехатроник OR робот)'],
    professionIds: ['robotics-eng','drone-op'],
  },
  {
    id: 'eng-nuclear-naval',
    name: 'Ядерные и судовые инженеры',
    queries: ['NAME:("ядерная физика" OR "судовой механик" OR корабельный)'],
    professionIds: ['nuclear-eng','naval-eng'],
  },

  // ─── BLD (14 → 5) ─────────────────────────────────────────
  {
    id: 'construction',
    name: 'Строители',
    queries: ['NAME:(строитель OR прораб OR "инженер строитель" OR ПГС)'],
    professionIds: ['civil-eng','construction-eng','quantity-surveyor','tunneling-eng','sanitary-eng'],
  },
  {
    id: 'architect',
    name: 'Архитекторы и урбанисты',
    queries: ['NAME:(архитектор OR градостроитель OR урбанист)'],
    professionIds: ['architect','landscape-architect','urban-planner','interior-designer','landscape-designer','bim-manager'],
  },
  {
    id: 'cadastre',
    name: 'Геодезисты и кадастр',
    queries: ['NAME:(геодезист OR кадастровый OR "землеустроитель")'],
    professionIds: ['surveyor','cadastral-eng'],
  },
  {
    id: 'realestate',
    name: 'Недвижимость',
    queries: ['NAME:("управляющий недвижимостью" OR "property manager")'],
    professionIds: ['property-manager'],
  },

  // ─── ECO + AGR (15 → 5) ────────────────────────────────────
  {
    id: 'ecology',
    name: 'Экологи',
    queries: ['NAME:(эколог OR "охрана окружающей среды")'],
    professionIds: ['ecologist','forester','forest-eng','sustainability','esg-analyst','carbon-eng','gis-specialist','soil-scientist'],
  },
  {
    id: 'agriculture',
    name: 'Агрономы и животноводы',
    queries: ['NAME:(агроном OR зоотехник OR "сельское хозяйство")'],
    professionIds: ['agronomist','zootechnician','reindeer-herder','fish-tech','aquaculture'],
  },
  {
    id: 'veterinary',
    name: 'Ветеринары',
    queries: ['NAME:(ветеринар OR veterinary)'],
    professionIds: ['vet','vet-pharmacist'],
  },

  // ─── SOC (16 → 6) ─────────────────────────────────────────
  {
    id: 'hr',
    name: 'HR-специалисты',
    queries: ['NAME:("hr менеджер" OR "менеджер по персоналу" OR рекрутер)'],
    professionIds: ['hr-manager'],
  },
  {
    id: 'marketing-pr',
    name: 'Маркетинг и PR',
    queries: ['NAME:(маркетолог OR "pr менеджер" OR pr-менеджер)'],
    professionIds: ['marketer','pr-manager','pr-spec','smm-manager','event-manager'],
  },
  {
    id: 'translator',
    name: 'Переводчики',
    queries: ['NAME:(переводчик OR translator)'],
    professionIds: ['translator','diplomat','orientologist'],
  },
  {
    id: 'journalist',
    name: 'Журналисты',
    queries: ['NAME:(журналист OR корреспондент)'],
    professionIds: ['journalist','copywriter','content-manager'],
  },
  {
    id: 'culture',
    name: 'Культура: историки, музеи, библиотеки',
    queries: ['NAME:(историк OR библиотекарь OR "куратор музея" OR архивист)'],
    professionIds: ['historian','museum-curator','archivist','librarian'],
  },
  {
    id: 'sociology',
    name: 'Социологи и социальные работники',
    queries: ['NAME:(социолог OR "социальный работник")'],
    professionIds: ['sociologist','social-worker'],
  },

  // ─── ART (12 → 5) ─────────────────────────────────────────
  {
    id: 'design-graphic',
    name: 'Графические и индустриальные дизайнеры',
    queries: ['NAME:(дизайнер OR designer)'],
    professionIds: ['graphic-designer','industrial-designer','3d-modeler'],
  },
  {
    id: 'animation',
    name: 'Аниматоры и моушн-дизайнеры',
    queries: ['NAME:(аниматор OR моушн OR motion)'],
    professionIds: ['animator'],
  },
  {
    id: 'film-tv',
    name: 'Кино и ТВ',
    queries: ['NAME:(режиссёр OR оператор OR монтажёр OR видеограф)'],
    professionIds: ['film-director','sound-designer','videographer','photographer'],
  },
  {
    id: 'music',
    name: 'Музыканты',
    queries: ['NAME:(музыкант OR композитор OR саунд)'],
    professionIds: ['musician'],
  },
  {
    id: 'restorer',
    name: 'Реставраторы',
    queries: ['NAME:(реставратор)'],
    professionIds: ['restorer'],
  },

  // ─── FOOD (6 → 3) ─────────────────────────────────────────
  {
    id: 'chef',
    name: 'Повара и кондитеры',
    queries: ['NAME:(повар OR кондитер OR шеф)'],
    professionIds: ['chef','confectioner','food-tech'],
  },
  {
    id: 'restaurant',
    name: 'Ресторанный бизнес',
    queries: ['NAME:("ресторанный менеджер" OR официант OR администратор)'],
    professionIds: ['restaurant-manager','sommelier','barista'],
  },

  // ─── SPORT (8 → 2) ────────────────────────────────────────
  {
    id: 'fitness',
    name: 'Фитнес и тренеры',
    queries: ['NAME:(тренер OR инструктор OR фитнес)'],
    professionIds: ['trainer','fitness-trainer','yoga-instructor','sports-manager','sports-doc','nutritionist','sports-analyst'],
  },
  {
    id: 'esports',
    name: 'Киберспорт',
    queries: ['NAME:("киберспорт" OR esports OR streamer)'],
    professionIds: ['esport-coach'],
  },

  // ─── TRA (9 → 5) ──────────────────────────────────────────
  {
    id: 'logistics',
    name: 'Логисты',
    queries: ['NAME:(логист OR "supply chain" OR закупки)'],
    professionIds: ['logistician','supply-chain','customs-specialist'],
  },
  {
    id: 'aviation',
    name: 'Авиация',
    queries: ['NAME:(пилот OR бортпроводник OR "авиатехник")'],
    professionIds: ['pilot','aviation-tech'],
  },
  {
    id: 'rail',
    name: 'Железная дорога',
    queries: ['NAME:(машинист OR "путеец" OR железнодорожник)'],
    professionIds: ['railway-eng','rail-conductor'],
  },
  {
    id: 'driving',
    name: 'Водители и дорожники',
    queries: ['NAME:("инструктор по вождению" OR "дорожное движение")'],
    professionIds: ['driver-instructor','traffic-eng'],
  },

  // ─── SCI (11 → 3) ─────────────────────────────────────────
  {
    id: 'sci-natural',
    name: 'Учёные естественнонаучного направления',
    queries: ['NAME:(физик OR химик OR биолог OR геолог)'],
    professionIds: ['physicist','chemist','geologist','geophysicist','marine-biologist','biotech','bioinformatics','researcher','chemical-eng'],
  },
  {
    id: 'sci-math',
    name: 'Математики',
    queries: ['NAME:(математик OR mathematician)'],
    professionIds: ['mathematician','nuclear-phys'],
  },
];

// ── Утилиты ──────────────────────────────────────────────────

export function getGroupForProfession(profId) {
  return SEARCH_GROUPS.find(g => g.professionIds.includes(profId));
}

export function getGroupsCount() {
  return SEARCH_GROUPS.length;
}

export function getCoveredProfessions() {
  const set = new Set();
  for (const g of SEARCH_GROUPS) {
    for (const pid of g.professionIds) set.add(pid);
  }
  return set;
}
