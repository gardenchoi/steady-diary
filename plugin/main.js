'use strict';

/*
 * Steady 일기 — 옵시디언 플러그인 (빌드 없이 바로 쓰는 순수 JavaScript)
 * 오른쪽 패널에서 대화하면 일기 친구가 질문하고, 마치면 정리된 일기를
 * 일기/YYYY/MM/YYYY-MM-DD.md 에 저장하고 감정·고민·사람 페이지에 링크를 걸어요.
 */

const obsidian = require('obsidian');
const { Plugin, ItemView, PluginSettingTab, Setting, Modal, Notice, requestUrl, normalizePath, moment } = obsidian;

const VIEW_TYPE = 'steady-diary-chat';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const FIRST_MESSAGE = '오늘 하루는 어땠어요? 떠오르는 장면부터 편하게 얘기해 주세요.';

const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'anthropic/claude-sonnet-5',
  emotionFolder: '감정',
  topicFolder: '고민',
  peopleFolder: '사람',
  placeFolder: '장소',
  learningFolder: '배움',
  focusFile: 'Steady/이번 주.md',
  counselFile: 'Steady/상담 노트.md',
  pastEntries: 7,
};

const MODELS = {
  'anthropic/claude-sonnet-5': 'Claude Sonnet 5 (깊이 있게, 추천)',
  'anthropic/claude-haiku-4.5': 'Claude Haiku 4.5 (저렴하게)',
};

/* ---------- 도우미 ---------- */

function today() {
  // 새벽 4시 전이면 어제 일기로 쳐요.
  const now = moment();
  return now.hour() < 4 ? now.clone().subtract(1, 'day') : now;
}

function stripFrontmatter(text) {
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end >= 0) return text.slice(end + 4).trim();
  }
  return text.trim();
}

function unique(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const v = String(raw || '').trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/** 파일·링크 이름으로 쓸 수 없는 글자 빼기 */
function safeName(name) {
  return String(name || '').replace(/[\\/:*?"<>|#^\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 대화 원문: 구분선 한 줄 아래에 Q(질문)·A(내 대답)를 그대로. 한눈에 보이게 펼쳐 둬요. */
function transcriptText(messages) {
  const lines = messages.map((m) => (m.role === 'user' ? '**A.** ' : '**Q.** ') + String(m.content).trim().replace(/\s*\n\s*/g, ' '));
  // 구분선 앞에 빈 줄이 있어야 제목으로 바뀌지 않아요.
  return '\n---\n\n' + lines.join('\n\n') + '\n';
}

function isTranscriptLine(line) {
  return line.startsWith('**Q.** ') || line.startsWith('**A.** ');
}

function errorMessage(status) {
  if (status === 401) return 'OpenRouter API 키가 올바르지 않아요. 플러그인 설정에서 확인해 주세요.';
  if (status === 402) return 'OpenRouter 크레딧이 부족하거나 키 사용 한도에 도달했어요.';
  if (status === 429) return '요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요.';
  return 'AI 응답 오류예요 (' + status + ').';
}

async function callAI(settings, messages, options) {
  const opts = options || {};
  if (!settings.apiKey) throw new Error('플러그인 설정에서 OpenRouter API 키를 먼저 넣어 주세요.');
  const body = { model: settings.model, max_tokens: opts.maxTokens || 10000, messages: messages };
  if (opts.schema) {
    body.response_format = { type: 'json_schema', json_schema: { name: 'diary', strict: true, schema: opts.schema } };
  }
  let res;
  try {
    res = await requestUrl({
      url: ENDPOINT,
      method: 'POST',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + settings.apiKey, 'X-Title': 'Steady Diary' },
      body: JSON.stringify(body),
      throw: false,
    });
  } catch (e) {
    throw new Error('인터넷 연결을 확인해 주세요.');
  }
  if (res.status < 200 || res.status >= 300) throw new Error(errorMessage(res.status));
  const data = res.json;
  const choice = data && data.choices && data.choices[0];
  const content = choice && choice.message && choice.message.content;
  if (!content) throw new Error('응답이 비어 있어요. 다시 시도해 주세요.');
  // 길이 한도에 걸려 잘렸으면 숨기지 않고 알려요. (정리용 JSON은 잘리면 어차피 다시 시도해야 해요)
  if (choice.finish_reason === 'length') {
    if (opts.schema) throw new Error('정리가 너무 길어서 중간에 잘렸어요. 다시 눌러 주세요.');
    return content + ' …(답이 길어서 잘렸어요)';
  }
  return content;
}

/* ---------- 보관함 읽기·쓰기 ---------- */

class DiaryStore {
  constructor(app, settings) {
    this.app = app;
    this.settings = settings;
  }

  /** 옵시디언 '일일 노트' 설정을 따라요. (예: 일기 / YYYY/MM/YYYY-MM-DD) */
  async dailySettings() {
    let folder = '';
    let format = 'YYYY-MM-DD';
    try {
      const raw = await this.app.vault.adapter.read(this.app.vault.configDir + '/daily-notes.json');
      const cfg = JSON.parse(raw);
      if (cfg.folder) folder = String(cfg.folder).trim();
      if (cfg.format) format = String(cfg.format).trim();
    } catch (e) {
      // 설정이 없으면 기본값
    }
    return { folder: folder, format: format };
  }

  async dailyPath(date) {
    const s = await this.dailySettings();
    const name = date.format(s.format);
    return normalizePath((s.folder ? s.folder + '/' : '') + name + '.md');
  }

  async read(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file ? this.app.vault.cachedRead(file) : '';
  }

  async ensureFolder(folderPath) {
    const parts = normalizePath(folderPath).split('/');
    let cur = '';
    for (const part of parts) {
      if (!part) continue;
      cur = cur ? cur + '/' + part : part;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try {
          await this.app.vault.createFolder(cur);
        } catch (e) {
          // 이미 있으면 괜찮아요
        }
      }
    }
  }

  /** 최근 일기 몇 편 (오늘 제외, 최신순) */
  async recentEntries(date) {
    const s = await this.dailySettings();
    const root = s.folder ? normalizePath(s.folder) + '/' : '';
    const todayName = date.format('YYYY-MM-DD');
    const files = this.app.vault.getMarkdownFiles()
      .filter((f) => (root ? f.path.startsWith(root) : true) && /^\d{4}-\d{2}-\d{2}$/.test(f.basename) && f.basename < todayName)
      .sort((a, b) => (a.basename < b.basename ? 1 : -1))
      .slice(0, this.settings.pastEntries);
    const out = [];
    for (const f of files) {
      // 지난 일기는 요약만 참고해요. (Q·A 원문 줄은 빼고)
      const text = stripFrontmatter(await this.app.vault.cachedRead(f))
        .split('\n').filter((line) => !isTranscriptLine(line) && line.trim() !== '---').join('\n').trim();
      if (text) out.push('### ' + f.basename + '\n' + text.slice(0, 1200));
    }
    return out;
  }

  /** 페이지 이름과 별명(aliases) */
  pagesIn(folder) {
    return this.app.vault.getMarkdownFiles()
      .filter((f) => f.path.startsWith(normalizePath(folder) + '/'))
      .map((f) => {
        const cache = this.app.metadataCache.getFileCache(f);
        const fm = (cache && cache.frontmatter) || {};
        const aliases = [].concat(fm.aliases || fm.alias || []).map(String).filter(Boolean);
        return { file: f, name: f.basename, aliases: aliases };
      });
  }

  /** 이미 있는 페이지 이름들 (같은 이름을 다시 쓰도록). 별명은 괄호로 알려줘요. */
  existingNames() {
    const list = (folder) => this.pagesIn(folder).map((p) => (p.aliases.length ? p.name + ' (별명: ' + p.aliases.join(', ') + ')' : p.name));
    return {
      emotions: list(this.settings.emotionFolder),
      topics: list(this.settings.topicFolder),
      people: list(this.settings.peopleFolder),
      places: list(this.settings.placeFolder),
      learnings: list(this.settings.learningFolder),
    };
  }

  /** 이름이나 별명으로 이미 있는 페이지 찾기 */
  findPage(name, folder) {
    const n = name.toLowerCase();
    const hit = this.pagesIn(folder).find((p) => p.name.toLowerCase() === n || p.aliases.some((a) => a.toLowerCase() === n));
    return hit ? hit.file : this.app.metadataCache.getFirstLinkpathDest(name, '');
  }

  /** 일기를 저장하고, 감정·고민·사람 페이지에 연결해요. 반환: 저장한 파일 경로 */
  async saveEntry(date, entry) {
    const path = await this.dailyPath(date);
    await this.ensureFolder(path.split('/').slice(0, -1).join('/'));
    let section = '## 📝 ' + entry.title + ' (' + moment().format('HH:mm') + ')\n\n' + entry.body.trim() + '\n';
    if (entry.lessons.length) {
      section += '\n**레슨런**\n' + entry.lessons.map((l) => '- ' + l).join('\n') + '\n';
    }
    if (entry.transcript && entry.transcript.length) {
      section += transcriptText(entry.transcript);
    }
    let file = this.app.vault.getAbstractFileByPath(path);
    if (file) {
      const before = await this.app.vault.read(file);
      await this.app.vault.modify(file, before.trimEnd() + '\n\n' + section);
    } else {
      file = await this.app.vault.create(path, section);
    }

    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm['날짜'] = date.format('YYYY-MM-DD');
      // 태그는 '종류'만, 정해진 것만 써요. 구체적인 건 링크로.
      fm.tags = unique([].concat(fm.tags || [], ['일기'], entry.lessons.length ? ['레슨런'] : []));
      fm['감정'] = unique([].concat(fm['감정'] || [], entry.emotions));
    });

    const noteLink = '[[' + file.basename + ']]';
    const line = '- ' + noteLink + ' ' + entry.summary.trim() + '\n';
    const groups = [
      [entry.emotions, this.settings.emotionFolder, '감정'],
      [entry.topics, this.settings.topicFolder, '고민'],
      [entry.people, this.settings.peopleFolder, '사람'],
      [entry.places, this.settings.placeFolder, '장소'],
      [entry.learnings, this.settings.learningFolder, '배움'],
    ];
    for (const g of groups) {
      for (const name of g[0]) await this.linkTopic(name, g[1], g[2], line);
    }
    return path;
  }

  /** 새 페이지의 처음 모양 (사용자가 쓰던 템플릿과 같은 틀) */
  newPageText(kind) {
    if (kind === '사람') {
      return '---\n생일:\n관계:\naliases: []\n---\n#사람\n\n### 알아둘 것\n- 좋아하는 것:\n- 싫어하는 것:\n- 가족·주변:\n- 최근 근황:\n- 내가 준 선물:\n\n### 기억\n';
    }
    if (kind === '배움') {
      return '---\n날짜:\n종류:\n강사:\n장소:\n---\n#배움\n\n## 핵심 3가지\n\n## 내가 적용할 것\n\n## 레슨런\n\n## 기억\n';
    }
    return '#' + kind + '\n\n## 기억\n';
  }

  /** 페이지가 없으면 만들고, 오늘 일기 한 줄을 맨 아래 '기억'에 덧붙여요. */
  async linkTopic(name, folder, kind, line) {
    const clean = safeName(name);
    if (!clean) return;
    let file = this.findPage(clean, folder);
    if (!file) {
      await this.ensureFolder(folder);
      const path = normalizePath(folder + '/' + clean + '.md');
      file = this.app.vault.getAbstractFileByPath(path);
      if (!file) file = await this.app.vault.create(path, this.newPageText(kind));
    }
    const text = await this.app.vault.read(file);
    if (text.includes(line.trim())) return;
    await this.app.vault.modify(file, text.trimEnd() + '\n' + line);
  }
}

/* ---------- 대화 설정 ---------- */

function systemPrompt(date, context) {
  return [
    '너는 사용자의 일기 친구이자, 믿고 기대도 되는 심리상담가 같은 코치야. 더 풍부하고 솔직한 일기를 쓰도록 돕고, 필요할 땐 실제로 도움이 되는 조언을 해.',
    '- 한국어 해요체로, 따뜻하고 편하게. 평소엔 한 번에 질문 하나, 2~3문장 이내.',
    '- 흐름(대화에 맞춰 자연스럽게): 떠오르는 장면 → 무슨 일이 있었는지 → 그때의 감정 → 몸의 느낌 → 스쳐 간 생각 → 그게 나에게 어떤 의미인지.',
    '- 좋은 일도 흘려보내지 말고 왜 좋았는지, 무엇이 도움이 됐는지 물어봐.',
    '- 사용자는 나중에 기억을 잘 꺼내 쓰고 싶어 해. 대화 흐름을 해치지 않는 선에서 가끔:',
    '  · 사람이 나오면 그 사람에 대해 기억해 둘 만한 것(근황, 좋아하는 것, 들은 이야기)을 가볍게 물어봐.',
    '  · 여행·장소 이야기면 무엇이 구체적으로 좋았는지(풍경, 음식, 순간) 물어봐.',
    '  · 수업·워크샵에서 배운 거면 핵심 한두 가지와 어디에 써먹고 싶은지 물어봐.',
    '  · 교훈이 보이면 "다음엔 어떻게 하고 싶어요?"로 레슨런을 끌어내 줘.',
    '- 아래 지난 일기에서 이어지는 흐름이 보이면 부드럽게 짚어 줘 (예: "지난주에도 ~ 이야기했는데, 그때랑 비슷해요?").',
    '- 상담가처럼: 기본은 먼저 듣고 공감하고 질문으로 스스로 알아차리게 도와. 훈계나 판단은 하지 마.',
    '- 하지만 사용자가 해결책·조언을 원하거나("솔루션은 없냐", "어떻게 해야 해?") 같은 고민이 계속 맴돌면, 피하지 말고 구체적으로 도와줘.',
    '  "제 역할이 아니라서" 같은 말은 절대 하지 마.',
    '  · 근거 있는 방법에서 상황에 맞는 것 1~3개: 인지행동치료(생각 점검·재구성), 행동 활성화, 수용전념(ACT), 자기연민,',
    '    수면·회복 과학, 에너지·스트레스 관리, 문제 해결 단계 등. 아래 "상담 노트"가 있으면 그 내용을 우선 참고해.',
    '  · 각 방법은 "왜 도움이 되는지" 한 줄 + 오늘·이번 주에 해 볼 수 있는 아주 작은 행동으로. 지난 일기에서 보이는 패턴을 근거로 맞춤으로.',
    '  · 조언할 때는 짧은 목록을 써도 되고 2~3문장보다 길어도 돼. 끝에 "이 중에 해 볼 만한 게 있어요?"처럼 고르게 해.',
    '- 피로·체력 저하가 몇 주 넘게 이어지면 빈혈, 갑상선, 비타민 D, 수면무호흡, 우울감 같은 원인도 있을 수 있으니',
    '  병원 검진을 부드럽게 권해. 진단을 내리거나 약을 권하지는 마.',
    '- 이야기가 충분히 모였으면(보통 8~15번 주고받은 뒤) "오늘 하루에 제목을 붙인다면 뭐라고 하고 싶어요?"라고 물어서 사용자가 제목을 정하게 도와줘.',
    '  사용자가 고민하면 대화에서 나온 깨달음이나 장면으로 2~3개를 제안해 (예: "작은 성취를 알아본 날", "비 오는 날의 따뜻한 한 끼").',
    '  제목이 정해지면 "이제 [마치고 정리]를 누르면 일기로 정리할게요"라고 알려줘.',
    '- 자해·자살 생각 같은 위기 신호가 보이면 걱정된다고 솔직히 말하고, 자살예방상담전화 109(24시간), 정신건강위기상담 1577-0199를 안내하고, 믿을 수 있는 사람에게 연락해 보길 권해.',
    '',
    '오늘: ' + date.format('YYYY년 M월 D일') + ' ' + '일월화수목금토'.charAt(date.day()) + '요일',
    '이번 주 꼭 지킬 3가지: ' + (context.focus || '(없음)'),
    '오늘 노트에 이미 있는 내용(Steady 체크인 등):\n' + (context.todayNote || '(없음)'),
    '',
    '상담 노트 (사용자가 직접 모은 상담 원칙·책에서 배운 것. 조언할 때 우선 참고):\n' + (context.counsel || '(없음)'),
    '',
    '지난 일기 (최신순):\n' + (context.recent.length ? context.recent.join('\n\n') : '(아직 없음)'),
  ].join('\n');
}

const WRAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'title_options', 'body', 'summary', 'emotions', 'topics', 'people', 'places', 'learnings', 'lessons'],
  properties: {
    title: { type: 'string' },
    title_options: { type: 'array', items: { type: 'string' } },
    body: { type: 'string' },
    summary: { type: 'string' },
    emotions: { type: 'array', items: { type: 'string' } },
    topics: { type: 'array', items: { type: 'string' } },
    people: { type: 'array', items: { type: 'string' } },
    places: { type: 'array', items: { type: 'string' } },
    learnings: { type: 'array', items: { type: 'string' } },
    lessons: { type: 'array', items: { type: 'string' } },
  },
};

function wrapPrompt(names) {
  const known = (label, list) => '  ' + label + ': ' + (list.join(', ') || '(없음)');
  return [
    '아래 대화를 바탕으로 사용자의 일기를 써.',
    '- title: 대화에서 사용자가 제목을 정했으면 그 말 그대로. 안 정했으면 title_options의 첫 번째.',
    '- title_options: 제목 후보 3개. 감정 이름만으로("지친 마음") 짓지 말고, 그날의 깨달음이나 구체적인 장면·좋았던 순간으로',
    '  (예: "쉼의 중요성을 다시 배운 날", "비 오는 날의 따뜻한 한 끼"). 사용자가 정한 제목이 있으면 그걸 첫 번째에.',
    '- body: 오늘을 다정하게 돌아보는 짧은 1인칭 요약. 대화 원문 전체는 이 아래에 따로 그대로 붙으니, 여기서는 핵심만.',
    '  · 대화에 나온 사실과 감정만 써(없는 일을 지어내지 마). 핵심 장면, 그때의 감정과 생각(걱정 포함), 좋았던 것, 깨달음 위주로.',
    '  · 같은 이야기끼리 묶어 흐름 있게. 문단 2~3개, 짧고 또렷한 문장.',
    '  · 감정은 사용자가 말한 그대로 써. 순화하거나 좋게 바꾸지 마 (예: "괜히 겁먹었다"는 그대로 "괜히 겁먹었다").',
    '  · 대신 문장 전체의 결은 따뜻하고 긍정적으로. 나를 몰아세우는 해설을 덧붙이지 말고, 좋았던 것·고마운 것·잘 해낸 것을 살리고,',
    '    내일을 향한 다정한 한두 문장으로 마무리해.',
    '  · 사용자의 말투(반말/존댓말, 자주 쓰는 표현)는 살려.',
    '  · 감정·고민·사람·장소·배움이 처음 나올 때 [[이름]]으로 링크를 걸어. 링크 이름은 아래 목록에 쓴 이름과 똑같이.',
    '  사용자가 별명으로 불렀으면 [[원래이름|별명]] 형식으로.',
    '- summary: 오늘 일기 한 줄 요약 (연결된 페이지의 "기억"에 들어가요)',
    '- emotions: 오늘 느낀 감정 이름 (예: 불안, 뿌듯함, 서운함). 1~4개',
    '- topics: 반복될 만한 고민·관심 주제 (예: 이직, 건강, 관계). 0~3개',
    '- people: 이야기에 나온 사람. 이미 있는 사람이면 원래 이름(별명 말고)으로. 0~5개',
    '- places: 이야기에 나온 구체적인 장소 (도시·가게·여행지). 0~4개',
    '- learnings: 수업·워크샵·해커톤·책처럼 배운 것의 이름 (예: 주말 사진 수업). 0~2개',
    '- lessons: 오늘 얻은 레슨런(교훈·다음엔 이렇게), 사용자가 실제로 말한 것만. 없으면 []',
    '- 이미 있는 페이지 이름 (있으면 그대로 다시 써):',
    known('감정', names.emotions),
    known('고민', names.topics),
    known('사람', names.people),
    known('장소', names.places),
    known('배움', names.learnings),
  ].join('\n');
}

/* ---------- 채팅 패널 ---------- */

class ChatView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.messages = [];
    this.busy = false;
    this.system = '';
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return '일기 대화'; }
  getIcon() { return 'notebook-pen'; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('steady-diary');

    const header = root.createDiv({ cls: 'sd-header' });
    header.createDiv({ cls: 'sd-title', text: '📝 일기 대화' });
    const actions = header.createDiv({ cls: 'sd-actions' });
    this.newBtn = actions.createEl('button', { text: '새 대화' });
    this.finishBtn = actions.createEl('button', { text: '마치고 정리', cls: 'mod-cta' });
    this.newBtn.onclick = () => this.confirmNew();
    this.finishBtn.onclick = () => this.confirmFinish();

    this.list = root.createDiv({ cls: 'sd-messages' });
    this.errorEl = root.createDiv({ cls: 'sd-error' });

    const inputRow = root.createDiv({ cls: 'sd-input' });
    this.input = inputRow.createEl('textarea', { attr: { rows: '2', placeholder: '말하거나 입력하세요 (Enter 보내기, Shift+Enter 줄바꿈)' } });
    this.sendBtn = inputRow.createEl('button', { text: '➤', cls: 'sd-send', attr: { 'aria-label': '보내기' } });
    this.sendBtn.onclick = () => this.send();
    this.input.addEventListener('keydown', (e) => {
      // 한글 조합 중에는 보내지 않아요.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.send();
      }
    });

    await this.start();
  }

  async start() {
    this.messages = [{ role: 'assistant', content: FIRST_MESSAGE }];
    this.errorEl.setText('');
    this.render();
    const date = today();
    this.date = date;
    const store = this.plugin.store();
    const context = {
      focus: stripFrontmatter(await store.read(this.plugin.settings.focusFile)).replace(/^#.*$/gm, '').trim().replace(/\n+/g, ' / '),
      counsel: stripFrontmatter(await store.read(this.plugin.settings.counselFile)).slice(0, 6000),
      todayNote: stripFrontmatter(await store.read(await store.dailyPath(date))).slice(0, 2000),
      recent: await store.recentEntries(date),
    };
    this.date = date;
    this.system = systemPrompt(date, context);
  }

  render() {
    this.list.empty();
    for (const m of this.messages) {
      const row = this.list.createDiv({ cls: 'sd-row ' + (m.role === 'user' ? 'sd-mine' : 'sd-theirs') });
      row.createDiv({ cls: 'sd-bubble', text: m.content });
    }
    if (this.busy) this.list.createDiv({ cls: 'sd-row sd-theirs' }).createDiv({ cls: 'sd-bubble sd-typing', text: '…' });
    const talked = this.messages.some((m) => m.role === 'user');
    this.finishBtn.disabled = !talked || this.busy;
    this.sendBtn.disabled = this.busy;
    this.list.scrollTop = this.list.scrollHeight;
  }

  async send() {
    const text = this.input.value.trim();
    if (!text || this.busy) return;
    this.input.value = '';
    this.messages.push({ role: 'user', content: text });
    this.busy = true;
    this.errorEl.setText('');
    this.render();
    try {
      const reply = await callAI(this.plugin.settings, [{ role: 'system', content: this.system }].concat(this.messages), { maxTokens: 10000 });
      this.messages.push({ role: 'assistant', content: reply.trim() });
    } catch (e) {
      this.errorEl.setText(e.message);
    }
    this.busy = false;
    this.render();
    this.input.focus();
  }

  confirmNew() {
    const talked = this.messages.some((m) => m.role === 'user');
    if (!talked) return;
    new ConfirmModal(this.app, '새 대화를 시작할까요?', '지금 대화는 저장되지 않아요.', '새로 시작', () => this.start()).open();
  }

  confirmFinish() {
    new ConfirmModal(this.app, '대화를 마치고 일기로 정리할까요?', '정리한 일기를 저장하기 전에 먼저 보여드려요.', '정리하기', () => this.wrapUp()).open();
  }

  async wrapUp() {
    this.busy = true;
    this.errorEl.setText('');
    this.render();
    try {
      const store = this.plugin.store();
      const transcript = this.messages.map((m) => (m.role === 'user' ? '나: ' : '일기 친구: ') + m.content).join('\n');
      const raw = await callAI(
        this.plugin.settings,
        [{ role: 'system', content: wrapPrompt(store.existingNames()) }, { role: 'user', content: transcript }],
        { maxTokens: 12000, schema: WRAP_SCHEMA },
      );
      const entry = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      entry.emotions = unique(entry.emotions).map(safeName).filter(Boolean);
      entry.topics = unique(entry.topics).map(safeName).filter(Boolean);
      entry.people = unique(entry.people).map(safeName).filter(Boolean);
      entry.places = unique(entry.places).map(safeName).filter(Boolean);
      entry.learnings = unique(entry.learnings).map(safeName).filter(Boolean);
      entry.lessons = unique(entry.lessons);
      this.busy = false;
      this.render();
      new PreviewModal(this.app, entry, async (edited) => {
        const path = await store.saveEntry(this.date, Object.assign({}, edited, { transcript: this.messages }));
        new Notice('일기를 저장했어요: ' + path);
        await this.app.workspace.openLinkText(path, '', false);
        await this.start();
      }).open();
    } catch (e) {
      this.busy = false;
      this.errorEl.setText(e.message && e.message.includes('JSON') ? '정리하는 중 오류가 났어요. 다시 눌러 주세요.' : e.message);
      this.render();
    }
  }
}

/* ---------- 창 ---------- */

class ConfirmModal extends Modal {
  constructor(app, title, text, okLabel, onOk) {
    super(app);
    this.titleText = title;
    this.text = text;
    this.okLabel = okLabel;
    this.onOk = onOk;
  }

  onOpen() {
    this.titleEl.setText(this.titleText);
    this.contentEl.createEl('p', { text: this.text });
    const row = this.contentEl.createDiv({ cls: 'modal-button-container' });
    row.createEl('button', { text: '계속 이야기하기' }).onclick = () => this.close();
    const ok = row.createEl('button', { text: this.okLabel, cls: 'mod-cta' });
    ok.onclick = () => {
      this.close();
      this.onOk();
    };
  }

  onClose() { this.contentEl.empty(); }
}

class PreviewModal extends Modal {
  constructor(app, entry, onSave) {
    super(app);
    this.entry = entry;
    this.onSave = onSave;
  }

  onOpen() {
    const e = this.entry;
    this.modalEl.addClass('steady-diary-preview');
    this.titleEl.setText('이렇게 저장할까요?');
    const c = this.contentEl;
    c.createEl('label', { text: '제목 (후보를 누르거나 직접 고쳐요)' });
    const options = unique([e.title].concat(e.title_options || []));
    const chips = c.createDiv({ cls: 'sd-title-options' });
    const title = c.createEl('input', { type: 'text', value: e.title, cls: 'sd-field' });
    options.forEach((opt) => {
      const chip = chips.createEl('button', { text: opt, cls: 'sd-chip' });
      chip.onclick = () => { title.value = opt; };
    });
    c.createEl('label', { text: '일기 (직접 고쳐도 돼요)' });
    const body = c.createEl('textarea', { cls: 'sd-field sd-body' });
    body.value = e.body;
    const meta = c.createDiv({ cls: 'sd-meta' });
    meta.createDiv({ text: '감정: ' + (e.emotions.join(', ') || '없음') });
    meta.createDiv({ text: '고민·주제: ' + (e.topics.join(', ') || '없음') });
    meta.createDiv({ text: '사람: ' + (e.people.join(', ') || '없음') });
    meta.createDiv({ text: '장소: ' + (e.places.join(', ') || '없음') });
    meta.createDiv({ text: '배움: ' + (e.learnings.join(', ') || '없음') });
    meta.createDiv({ text: '레슨런: ' + (e.lessons.join(' / ') || '없음') });
    meta.createDiv({ text: '한 줄 요약: ' + e.summary });
    const row = c.createDiv({ cls: 'modal-button-container' });
    row.createEl('button', { text: '취소' }).onclick = () => this.close();
    const save = row.createEl('button', { text: '저장', cls: 'mod-cta' });
    save.onclick = async () => {
      save.disabled = true;
      try {
        await this.onSave(Object.assign({}, e, { title: title.value.trim() || e.title, body: body.value }));
        this.close();
      } catch (err) {
        new Notice('저장하지 못했어요: ' + err.message);
        save.disabled = false;
      }
    };
  }

  onClose() { this.contentEl.empty(); }
}

/* ---------- 설정 ---------- */

class SettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const el = this.containerEl;
    el.empty();
    el.createEl('h2', { text: 'Steady 일기' });

    new Setting(el)
      .setName('OpenRouter API 키')
      .setDesc('sk-or-로 시작하는 키. 이 보관함의 플러그인 설정 파일에만 저장돼요.')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setPlaceholder('sk-or-...').setValue(this.plugin.settings.apiKey).onChange(async (v) => {
          this.plugin.settings.apiKey = v.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(el)
      .setName('AI 모델')
      .addDropdown((d) => {
        Object.keys(MODELS).forEach((k) => d.addOption(k, MODELS[k]));
        d.setValue(this.plugin.settings.model).onChange(async (v) => {
          this.plugin.settings.model = v;
          await this.plugin.saveSettings();
        });
      });

    const folder = (name, key) => new Setting(el).setName(name).addText((t) =>
      t.setValue(this.plugin.settings[key]).onChange(async (v) => {
        this.plugin.settings[key] = v.trim() || DEFAULT_SETTINGS[key];
        await this.plugin.saveSettings();
      }));
    folder('감정 페이지 폴더', 'emotionFolder');
    folder('고민·주제 페이지 폴더', 'topicFolder');
    folder('사람 페이지 폴더', 'peopleFolder');
    folder('장소 페이지 폴더', 'placeFolder');
    folder('배움 페이지 폴더', 'learningFolder');

    el.createEl('p', {
      text: '일기 파일 위치는 옵시디언 설정 → 일일 노트의 "새 파일 위치"와 "날짜 형식"을 따라요.',
      cls: 'setting-item-description',
    });
  }
}

/* ---------- 플러그인 ---------- */

module.exports = class SteadyDiaryPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, (leaf) => new ChatView(leaf, this));
    this.addRibbonIcon('notebook-pen', '일기 대화 열기', () => this.openChat());
    this.addCommand({ id: 'open-diary-chat', name: '일기 대화 열기', callback: () => this.openChat() });
    this.addSettingTab(new SettingsTab(this.app, this));
  }

  store() {
    return new DiaryStore(this.app, this.settings);
  }

  async openChat() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) || this.app.workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};
