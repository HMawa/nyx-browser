'use strict';

/**
 * 页面摘要（清单 F）：**纯抽取式**，不调用任何生成式 API。
 *
 * 为什么坚持抽取式：
 *  - 这个产品不做内置 AI/生成式功能（产品红线）。把正文里真实存在的句子挑出来、按信息量排序，
 *    能回答"这页在讲什么"，而且**每句话都能在页面上找到出处**，不会编造。
 *  - 摘要要跟抓包一起看：页面显示"提交成功"、接口其实 500 是常态，
 *    所以除了正文，还要把网络层的请求数、失败数、主要接口一起给出来。
 *
 * 模块纯逻辑、零 Electron，方便纯 Node 断言；真正去读页面的事交给 `buildExtractScript()`，
 * 由主进程丢进渲染进程执行。
 */

const DIGEST_LIMITS = {
  maxSentences: 8,
  maxChars: 1200,
  maxHeadings: 6,
  minSentenceLen: 10,
  maxNetworkHosts: 6,
  maxNetworkApis: 6,
};

/** 只做"哪些词不值得当作关键词"的粗筛，不做分词（中文按字/词边界混合处理没必要精确） */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'were', 'have', 'has', 'had',
  'you', 'your', 'our', 'but', 'not', 'can', 'will', 'would', 'there', 'their', 'they',
  '的', '了', '和', '是', '在', '我', '有', '就', '不', '人', '都', '一', '上', '也', '很', '到',
  '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这', '那', '为', '与', '及',
  '我们', '他们', '可以', '如果', '因为', '所以', '但是', '并且', '然后', '这个', '那个',
]);

/**
 * 在渲染进程里跑：把"可读正文"和标题抓出来。
 *
 * 注意：必须用 String.raw 拼接，普通模板串会把 /\n+/ 里的 \n 变成真换行，
 * 页面脚本直接语法错误（B 已经踩过一次，这里不再踩）。
 */
function buildExtractScript(options) {
  const limits = { ...DIGEST_LIMITS, ...(options || {}) };
  return String.raw`(() => {
  const LIMITS = ${JSON.stringify(limits)};
  const pick = () => {
    const selectors = ['article', 'main', '[role="main"]', '#content', '.content', '#main', 'body'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return document.body || null;
  };
  const clean = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  const root = pick();
  if (!root) return { ok: false, error: '页面上没有可读内容' };

  const headings = [];
  const seenHeading = new Set();
  root.querySelectorAll('h1, h2, h3').forEach((node) => {
    if (headings.length >= LIMITS.maxHeadings) return;
    const text = clean(node.innerText || node.textContent);
    if (!text || seenHeading.has(text)) return;
    seenHeading.add(text);
    headings.push(text);
  });

  // 段落按"行"收集：直接取 innerText 再切行，比扫每个 <p> 稳（很多站点正文在 div 里）
  const rawText = clean(root.innerText || root.textContent || '');
  const lines = [];
  const seen = new Set();
  String(root.innerText || root.textContent || '')
    .split(/\n+/)
    .forEach((line) => {
      const text = clean(line);
      if (text.length < LIMITS.minSentenceLen) return;
      if (seen.has(text)) return;
      seen.add(text);
      lines.push(text);
    });

  return {
    ok: true,
    url: location.href,
    title: clean(document.title),
    readyState: document.readyState,
    headings,
    text: rawText.slice(0, 20000),
    lines,
    lineCount: lines.length,
    textLength: rawText.length,
  };
})()`;
}

/** 中文句子切分：句末标点 + 换行都算边界（英文句点后跟空格也算） */
function splitSentences(text) {
  const raw = String(text || '');
  const parts = raw
    .replace(/\r/g, '\n')
    .split(/(?<=[。！？!?；;])|\n+|(?<=[.])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return parts;
}

/** 关键词：按 2-3 字的滑窗统计中文短语、按词统计英文，过滤停用词 */
function keywords(text, max) {
  const counts = new Map();
  const source = String(text || '').toLowerCase();
  const bump = (token) => {
    if (STOPWORDS.has(token)) return;
    counts.set(token, (counts.get(token) || 0) + 1);
  };

  // 英文/数字按词切
  for (const token of source.match(/[a-z0-9][a-z0-9_-]{2,}/g) || []) bump(token);

  // 中文按"连续的汉字段"生成 2-3 字滑窗。
  // 原先用贪婪的 {2,4} 一次吃 4 个字，会把「供应链延迟」切成「供应链延」这种跨词边界的假词；
  // 改成滑窗后「供应链」能被正确统计，再靠下面的"停用 n-gram"规则去掉它的短前缀。
  for (const run of source.match(/[\u4e00-\u9fa5]+/g) || []) {
    for (let len = 2; len <= 3; len += 1) {
      for (let i = 0; i + len <= run.length; i += 1) bump(run.slice(i, i + len));
    }
  }

  // 停用 n-gram：如果某个短词被一个更长的词完全包含、且出现次数一样，
  // 那它只是长词的前缀/后缀碎片，不该单独占一个关键词位。
  const entries = [...counts.entries()];
  const kept = entries.filter(([token, count]) => {
    const hasLonger = entries.some(
      ([other, otherCount]) => other.length > token.length && otherCount >= count && other.includes(token),
    );
    return !hasLonger;
  });

  return kept
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, max || 8)
    .map(([word, count]) => ({ word, count }));
}

/**
 * 抽取摘要：按"句子里的关键词权重 + 是否靠前"打分，取前 N 句但**保持原文顺序**。
 * 保持原文顺序很重要——打乱顺序的摘要是读不懂的。
 */
function summarize(raw, options) {
  const limits = { ...DIGEST_LIMITS, ...(options || {}) };
  const input = raw && typeof raw === 'object' ? raw : {};
  if (input.ok === false) {
    return {
      ok: false,
      error: input.error || '页面没有返回可读内容',
      title: '',
      url: '',
      headings: [],
      bullets: [],
      keywords: [],
      chars: 0,
      candidates: 0,
    };
  }
  const lines = Array.isArray(input.lines) && input.lines.length ? input.lines : splitSentences(input.text);
  const sentences = [];
  for (const line of lines) {
    for (const part of splitSentences(line)) {
      if (part.length >= limits.minSentenceLen) sentences.push(part);
      if (sentences.length >= 400) break;
    }
    if (sentences.length >= 400) break;
  }
  const words = keywords(sentences.join(' '), 12);

  // 一句话都没抽到就别装成功：主进程要靠 ok:false 给用户一个明确原因（DIGEST_EMPTY）
  if (!sentences.length) {
    return {
      ok: false,
      error: '这一页没有可读的正文（可能是图片页、纯脚本页，或者还没加载完）。',
      title: String(input.title || '').trim(),
      url: String(input.url || '').trim(),
      headings: (Array.isArray(input.headings) ? input.headings : []).slice(0, limits.maxHeadings),
      bullets: [],
      keywords: [],
      chars: 0,
      candidates: 0,
    };
  }

  const weights = new Map(words.map((item, index) => [item.word, words.length - index]));

  const scored = sentences.map((text, index) => {
    let score = 0;
    const lower = text.toLowerCase();
    for (const [word, weight] of weights) {
      if (lower.includes(word)) score += weight;
    }
    // 越靠前的句子通常是主旨（文章/文档都这样），给一点加成但不压过关键词
    score += Math.max(0, 3 - index * 0.1);
    // 太长的句子往往是导航/免责声明，扣一点
    if (text.length > 200) score -= 2;
    return { text, index, score };
  });

  const picked = scored
    .slice()
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limits.maxSentences)
    .sort((a, b) => a.index - b.index);

  const bullets = [];
  let used = 0;
  for (const item of picked) {
    if (used + item.text.length > limits.maxChars && bullets.length >= 3) break;
    bullets.push(item.text);
    used += item.text.length;
  }

  // 只出现一次的词大多是碎片；优先展示重复出现的词，实在没有就退回全部
  const repeated = words.filter((item) => item.count >= 2);
  const shownWords = (repeated.length ? repeated : words).slice(0, 8);

  return {
    ok: true,
    title: String(input.title || '').trim(),
    url: String(input.url || '').trim(),
    headings: (Array.isArray(input.headings) ? input.headings : []).slice(0, limits.maxHeadings),
    bullets,
    keywords: shownWords,
    chars: bullets.join('').length,
    candidates: sentences.length,
    truncated: (Array.isArray(input.text) ? false : String(input.text || '').length) > limits.maxChars,
  };
}

/**
 * 网络摘要：把抓包记录压成"多少次请求、几个失败、主要接口是什么"。
 *
 * 之所以必须带上失败数：页面常常显示"成功"，真正的失败藏在 XHR/fetch 里。
 * @param {object[]} records `toolbox.list()` 里的 brief 数组
 */
function summarizeNetwork(records, options) {
  const limits = { ...DIGEST_LIMITS, ...(options || {}) };
  const list = Array.isArray(records) ? records : [];
  const hostCount = new Map();
  const apiCount = new Map();
  let failed = 0;
  let pending = 0;
  let totalBytes = 0;

  for (const rec of list) {
    const host = String((rec && rec.host) || '').trim();
    if (host) hostCount.set(host, (hostCount.get(host) || 0) + 1);
    if (rec && rec.failed) failed += 1;
    if (rec && rec.finished === false) pending += 1;
    if (rec && typeof rec.size === 'number' && rec.size > 0) totalBytes += rec.size;
    const url = String((rec && rec.url) || '');
    const type = String((rec && rec.type) || '');
    if (!host) continue;
    // 只把 XHR / Fetch 当"接口"，静态资源堆进 API 列表会把重点淹掉
    if (['xhr', 'fetch'].indexOf(type.toLowerCase()) === -1) continue;
    let pathname = '';
    try {
      pathname = new URL(url).pathname || '/';
    } catch {
      pathname = url;
    }
    const key = `${host}${pathname}`;
    apiCount.set(key, (apiCount.get(key) || 0) + 1);
  }

  const hosts = [...hostCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limits.maxNetworkHosts)
    .map(([host, count]) => ({ host, count }));
  const apis = [...apiCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limits.maxNetworkApis)
    .map(([key, count]) => ({ key, count }));

  return {
    ok: true,
    total: list.length,
    failed,
    pending,
    hosts,
    apis,
    bytes: totalBytes,
    // 只有"有失败"或"还没结束"才值得在摘要里显眼说出来
    warning:
      failed > 0
        ? `有 ${failed} 个请求失败——页面显示成功不代表接口成功`
        : pending > 0
          ? `还有 ${pending} 个请求没结束，结论可能还不完整`
          : '',
  };
}

/** 复制用的纯文本（侧栏展示与剪贴板内容一致，避免两边说法不一样） */
function buildDigestText(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const page = data.page || {};
  const net = data.network || {};
  const lines = [];
  if (page.title) lines.push(`标题：${page.title}`);
  if (page.url) lines.push(`地址：${page.url}`);
  if (Array.isArray(page.headings) && page.headings.length) {
    lines.push('', '小标题：');
    for (const item of page.headings) lines.push(`- ${item}`);
  }
  if (Array.isArray(page.bullets) && page.bullets.length) {
    lines.push('', '摘要（抽取自页面原文）：');
    for (const item of page.bullets) lines.push(`- ${item}`);
  }
  if (Array.isArray(page.keywords) && page.keywords.length) {
    lines.push('', `关键词：${page.keywords.map((item) => item.word).join('、')}`);
  }
  if (net && typeof net.total === 'number') {
    lines.push('', `网络：${net.total} 个请求，失败 ${net.failed || 0} 个`);
    if (Array.isArray(net.hosts) && net.hosts.length) {
      lines.push(`主要域名：${net.hosts.map((item) => `${item.host}(${item.count})`).join('、')}`);
    }
    if (Array.isArray(net.apis) && net.apis.length) {
      lines.push('主要接口：');
      for (const item of net.apis) lines.push(`- ${item.key} ×${item.count}`);
    }
    if (net.warning) lines.push(`注意：${net.warning}`);
  }
  return lines.join('\n');
}

/** 开关关着的时候也要给出可读的原因，不许静默不干活 */
function digestDisabledPayload() {
  return {
    ok: false,
    code: 'DIGEST_DISABLED',
    error: '页面摘要没有开启。它默认是关闭的，需要你在设置 → Agent 访问 或侧栏里手动打开。',
  };
}

module.exports = {
  DIGEST_LIMITS,
  buildDigestText,
  buildExtractScript,
  digestDisabledPayload,
  keywords,
  splitSentences,
  summarize,
  summarizeNetwork,
};
