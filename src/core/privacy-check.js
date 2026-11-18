/**
 * 隐私自检的判定引擎（纯逻辑）。
 *
 * 为什么要有这个模块：1.18.0 的主打是「本地隐私自检」，它必须能回答一个具体问题——
 * **这一页对外说的那些值，到底是被伪装过的，还是本机真值？** 而回答这个问题的前提是
 * 「真实值」由主进程给（`os.cpus()`、主显示器、显卡字符串），页面自报值只能当"被观察值"。
 *
 * 硬约束（漏一条这套自检就没有意义）：
 * 1. `judgeItem(id, observed, truth)` 的 `truth` 允许为 `null`，**为 null 必须判 `unknown`**，
 *    绝不许退化成"用 observed 当 truth"——那样自检就变成页面自查，假绿比不做更糟。
 * 2. `unknown` 不是"通过"：`worstLevel` 里它排第三档，界面上也不许染成绿色。
 * 3. 这里不联网、不读盘、不碰 electron，任何一项都能单测。
 *
 * 分级口径：`leak > suspect > unknown > masked > pass`（越靠前越糟）。
 */

'use strict';

const LEVELS = ['leak', 'suspect', 'unknown', 'masked', 'pass'];

const LEVEL_TEXT = {
  leak: { label: '泄漏', tone: 'bad', code: 'LEAK' },
  suspect: { label: '可疑', tone: 'warn', code: 'SUSPECT' },
  unknown: { label: '测不到', tone: 'neutral', code: 'UNKNOWN' },
  masked: { label: '已伪装', tone: 'ok', code: 'MASKED' },
  pass: { label: '正常', tone: 'ok', code: 'PASS' },
};

/** 四组自检项：组名给界面分组用，标题给每一行用。 */
const GROUPS = [
  { key: 'identity', title: '身份', about: '浏览器自报的身份、语言、时区与硬件规模' },
  { key: 'image', title: '图像与音频', about: '显卡型号、画布与音频指纹' },
  { key: 'network', title: '网络出口', about: '直连候选、出口地址与 DNS' },
  { key: 'behavior', title: '行为约束', about: '录屏检测、agent 限制、权限与缓存加密' },
];

const TITLES = {
  A1: 'User-Agent',
  A2: '客户端提示（UA-CH）与 UA 是否自洽',
  A3: '语言列表',
  A4: '时区与地区是否冲突',
  A5: 'CPU 核数',
  A6: '屏幕尺寸与像素比',
  B1: '显卡型号（WebGL）',
  B2: '画布指纹是否稳定',
  B3: '音频指纹',
  C1: 'WebRTC 直连候选',
  C2: '出口地址',
  C3: 'DNS 出口',
  D1: '录屏 / 被远控',
  D2: '隐私模式下 agent 读取',
  D3: '设备权限默认',
  D4: '隐私快照加密',
};

/** 每一项属于哪一组（界面分组用，顺序就是渲染顺序）。 */
const ITEM_GROUPS = {
  A1: 'identity',
  A2: 'identity',
  A3: 'identity',
  A4: 'identity',
  A5: 'identity',
  A6: 'identity',
  B1: 'image',
  B2: 'image',
  B3: 'image',
  C1: 'network',
  C2: 'network',
  C3: 'network',
  D1: 'behavior',
  D2: 'behavior',
  D3: 'behavior',
  D4: 'behavior',
};

/** 不许出现在词表与报告里的绝对化措辞（自检只证明它测到的面）。 */
const BANNED_PHRASES = ['100%', '绝对安全', '绝对不可追踪', '完全匿名', '无法被追踪'];

const SUSPECT_TAIL = '；（真实 Chrome 不会这样，缺一样东西反而更显眼）';

function hasText(value) {
  return typeof value === 'string' ? value.trim().length > 0 : value != null;
}

function str(value) {
  if (value == null) return '';
  return String(value).trim();
}

/** 把任意输入折成数组（字符串按逗号切）。 */
function asList(value) {
  if (Array.isArray(value)) return value.map((item) => str(item)).filter(Boolean);
  const text = str(value);
  if (!text) return [];
  return text.split(',').map((item) => item.trim()).filter(Boolean);
}

function sameText(left, right) {
  return str(left).toLowerCase() === str(right).toLowerCase();
}

function result(id, level, observed, truth, reason) {
  return {
    id,
    level,
    group: ITEM_GROUPS[id] || 'identity',
    title: TITLES[id] || id,
    observed,
    truth: truth === undefined ? null : truth,
    reason,
  };
}

/** 没拿到真实值：一律 unknown，绝不用被观察值顶替。 */
function unknownReason(id) {
  if (id === 'C3') return '浏览器测不到解析走了哪条链路，这一项恒为「测不到」，不是没做完。';
  return '没拿到这台机器的真实值，所以无法判断是被伪装过还是本来就一样——不猜。';
}

function judgeA1(observed, truth) {
  const ua = str(observed && observed.ua !== undefined ? observed.ua : observed);
  const real = str(truth);
  if (!reallText(ua)) return result('A1', 'unknown', ua, truth, unknownReason('A1'));
  if (/Electron\//i.test(ua) || /\bNyx\//i.test(ua)) {
    return result('A1', 'leak', ua, truth, 'UA 里带着 Electron / Nyx 字样，明确暴露这不是普通 Chrome。');
  }
  if (!real) return result('A1', 'unknown', ua, truth, unknownReason('A1'));
  if (sameText(ua, real)) return result('A1', 'leak', ua, truth, 'UA 与本机真实 UA 完全一致，等于对外自报身份。');
  return result('A1', 'masked', ua, truth, 'UA 已被换成 Chrome 口径，与本机真实值不同。');
}

function reallText(value) {
  return str(value).length > 0;
}

/**
 * 语言标签归一：小写、`_`→`-`、去掉 `;q=…` 尾巴、把带书写系统的折叠成两段。
 *
 * 为什么要它：`navigator.languages` 里可能是 `zh-Hans-CN`，而系统给的真实值是 `zh-CN`；
 * 直接拼字符串比较会恒不相等，于是「其实没伪装」被报成「已伪装」（真实的泄漏被藏起来了）。
 * 折叠规则：只保留「语言（-书写系统）-地区」里的语言与地区，`zh-Hans-CN` → `zh-cn`。
 */
function canonicalLanguage(tag) {
  let text = str(tag).trim().toLowerCase();
  if (!text) return '';
  const semi = text.indexOf(';');
  if (semi >= 0) text = text.slice(0, semi).trim();
  text = text.replace(/_/g, '-');
  const parts = text.split('-').filter(Boolean);
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0];
  // 四字母的中间段是书写系统（Hans/Hant/Latn…），判定与比较时不需要它
  const rest = parts.slice(1).filter((part) => part.length !== 4);
  return rest.length ? `${parts[0]}-${rest[rest.length - 1]}` : parts[0];
}

/** 语言 → 说得通的地区（只做最小的几个语种，够抓「中文本地化 + 美国时区」这类矛盾）。 */
const LANG_REGIONS = {
  zh: ['cn', 'hk', 'tw', 'mo', 'sg'],
  en: ['us', 'gb', 'au', 'ca', 'nz', 'ie', 'sg', 'in'],
  ja: ['jp'],
  ko: ['kr', 'kp'],
  de: ['de', 'at', 'ch'],
  fr: ['fr', 'be', 'ca', 'ch'],
  es: ['es', 'mx', 'ar', 'cl', 'co'],
  ru: ['ru', 'by', 'kz'],
  pt: ['pt', 'br'],
};

/** 时区 → 地区（取时区名里的城市，够用且不需要全量表）。 */
const TZ_REGIONS = {
  'asia/shanghai': 'cn',
  'asia/chongqing': 'cn',
  'asia/urumqi': 'cn',
  'asia/hong_kong': 'hk',
  'asia/macau': 'mo',
  'asia/taipei': 'tw',
  'asia/tokyo': 'jp',
  'asia/seoul': 'kr',
  'asia/singapore': 'sg',
  'europe/london': 'gb',
  'america/new_york': 'us',
  'america/chicago': 'us',
  'america/denver': 'us',
  'america/los_angeles': 'us',
  'america/toronto': 'ca',
  'australia/sydney': 'au',
  'europe/berlin': 'de',
  'europe/paris': 'fr',
  'europe/moscow': 'ru',
};

function regionOfLanguage(tag) {
  const canon = canonicalLanguage(tag);
  if (!canon) return { language: '', region: '' };
  const parts = canon.split('-');
  return { language: parts[0], region: parts.length > 1 ? parts[parts.length - 1] : '' };
}

function regionOfTimeZone(tz) {
  const key = str(tz).trim().toLowerCase();
  return TZ_REGIONS[key] || '';
}

function judgeA2(observed, truth) {
  const info = observed && typeof observed === 'object' ? observed : {};
  const uaPlatform = str(info.uaPlatform);
  const chPlatform = str(info.chPlatform);
  const chVersion = str(info.chVersion);
  const uaFull = str(info.uaFullVersion);
  if (!uaPlatform || !chPlatform) return result('A2', 'unknown', info, truth, unknownReason('A2'));
  // navigator.platform 报的是 `Win32` / `MacIntel` / `Linux x86_64`，不是 UA-CH 的 `Windows`：
  // 先按 JS 那套前缀归一，再和客户端提示比（早先只认 /windows/i，Win32 会被错判成 Linux）。
  const mapped = /^win/i.test(uaPlatform) ? 'Windows' : /^mac/i.test(uaPlatform) ? 'macOS' : 'Linux';
  if (!sameText(mapped, chPlatform)) {
    return result('A2', 'suspect', info, truth, `UA 说自己是 ${mapped}，客户端提示却说 ${chPlatform}，两边对不上${SUSPECT_TAIL}`);
  }
  // 版本这一层必须要拿到高熵值才有意义：普通 Chromium 上 uaFullVersion / fullVersionList 是空的，
  // 空值绝不能算「一致」——那会把「根本没测到」写成「通过」。
  if (!chVersion || !uaFull) {
    return result('A2', 'unknown', info, truth, '客户端提示的完整版本号没取到（浏览器只在高熵查询里才给），UCH 版本这一层无法核对。');
  }
  const chMajor = str(chVersion).split('.')[0];
  const uaMajor = str(uaFull).split('.')[0];
  if (chMajor !== uaMajor) {
    return result('A2', 'suspect', info, truth, `客户端提示报 ${chVersion}，UA 自己报 ${uaFull}，主版本号对不上${SUSPECT_TAIL}`);
  }
  return result('A2', 'pass', info, truth, `UA 与客户端提示自洽（主版本 ${chMajor} 一致）。`);
}

function judgeA3(observed, truth, ctx) {
  const list = asList(observed && observed.languages !== undefined ? observed.languages : observed);
  if (!list.length) return result('A3', 'unknown', list, truth, unknownReason('A3'));
  if (list.some((item) => /;q=/i.test(item))) {
    return result('A3', 'suspect', list, truth, `语言列表里混进了 q 值（${list.join(', ')}），真实浏览器不会这样${SUSPECT_TAIL}`);
  }
  const real = asList(truth);
  if (!real.length) return result('A3', 'unknown', list, truth, unknownReason('A3'));
  // 逐项归一后再比：`zh-Hans-CN` 与 `zh-CN` 是同一种语言，拼字符串比会恒不相等，
  // 那样「本机语言原样暴露」就会被错报成「已伪装」——真实泄漏被藏起来，比误报更糟。
  const normList = list.map(canonicalLanguage).filter(Boolean);
  const normReal = real.map(canonicalLanguage).filter(Boolean);
  const same = normList.join(',') === normReal.join(',');
  const mode = str(ctx && ctx.mode).toLowerCase();
  if (same) {
    return result('A3', 'leak', list, truth, `语言列表与本机真实设置一致（${normReal.join(', ')}），没有伪装。`);
  }
  if (mode === 'private') {
    return result('A3', 'masked', list, truth, `语言列表已换成画像里的值（本机是 ${normReal.join(', ')}）。`);
  }
  return result('A3', 'leak', list, truth, `普通模式不伪装语言：页面读到的 ${normList.join(', ')} 与真实设置 ${normReal.join(', ')} 不同，说明它读到了绕开系统设置的顺序。`);
}

function judgeA4(observed, truth) {
  const info = observed && typeof observed === 'object' ? observed : {};
  const tz = str(info.timezone);
  const offset = info.offsetMinutes;
  const langs = asList(info.languages);
  if (!tz) return result('A4', 'unknown', info, truth, unknownReason('A4'));
  if (!langs.length) {
    return result('A4', 'unknown', info, truth, '语言列表没读到，时区与地区是否冲突无法核对。');
  }
  // 早先只拦「中文 + America/」，画像给的是 en-US + Asia/Shanghai 时反而判 pass——
  // 这里改成双向查表：语言说自己在哪个地区、时区说自己在哪个地区，两边不打架才算正常。
  const tzRegion = regionOfTimeZone(tz);
  const langInfo = regionOfLanguage(langs[0]);
  if (tzRegion && langInfo.region) {
    if (!sameText(tzRegion, langInfo.region)) {
      return result('A4', 'suspect', info, truth, `语言是 ${langs[0]}（地区 ${langInfo.region.toUpperCase()}），时区却说在 ${tz}（地区 ${tzRegion.toUpperCase()}），两边对不上${SUSPECT_TAIL}`);
    }
  } else if (tzRegion && langInfo.language) {
    const allowed = LANG_REGIONS[langInfo.language] || [];
    if (allowed.length && !allowed.includes(tzRegion)) {
      return result('A4', 'suspect', info, truth, `${langInfo.language} 通常不会配 ${tz}，这种组合不像真实用户${SUSPECT_TAIL}`);
    }
  }
  if (Number.isFinite(Number(offset))) {
    const minutes = Number(offset);
    // 只是粗略核对：真实偏移必须和时区名对得上（UTC+8 是 -480 分钟）。
    const expected = offsetOfZone(tz);
    if (expected !== null && Math.abs(minutes - expected) > 60) {
      return result('A4', 'suspect', info, truth, `时区写 ${tz}，但偏移是 ${minutes} 分钟，两者矛盾（这个时区应该接近 ${expected} 分钟）`);
    }
  }
  if (!tzRegion && !langInfo.region) {
    return result('A4', 'unknown', info, truth, `时区 ${tz} 与语言 ${langs[0]} 都不在已知对照表里，无法判断是否矛盾。`);
  }
  if (!tzRegion) {
    // 只有语言带地区、时区却不认识：这时说「没矛盾」等于给了一个没有依据的通过。
    return result('A4', 'unknown', info, truth, `时区 ${tz} 不在已知对照表里，无法核对它和语言 ${langs[0]} 是否一致。`);
  }
  return result('A4', 'pass', info, truth, '时区、语言与偏移之间没有明显矛盾。');
}

/** 常见时区名的标准偏移（分钟，UTC+8 记 -480，与 Date#getTimezoneOffset 同号）。 */
function offsetOfZone(tz) {
  const key = str(tz).trim().toLowerCase();
  const table = {
    'asia/shanghai': -480,
    'asia/hong_kong': -480,
    'asia/taipei': -480,
    'asia/singapore': -480,
    'asia/tokyo': -540,
    'asia/seoul': -540,
    'europe/london': 0,
    'america/new_york': 300,
    'america/chicago': 360,
    'america/denver': 420,
    'america/los_angeles': 480,
    'europe/berlin': -60,
    'europe/paris': -60,
    'australia/sydney': -600,
  };
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
}

function judgeA5(observed, truth) {
  const cores = Number(observed && observed.cores !== undefined ? observed.cores : observed);
  const real = Number(truth);
  if (!Number.isFinite(cores)) return result('A5', 'unknown', observed, truth, unknownReason('A5'));
  if (!Number.isFinite(real) || real <= 0) return result('A5', 'unknown', cores, truth, unknownReason('A5'));
  if (cores === real) {
    return result('A5', 'leak', cores, truth, `页面读到的核数 ${cores} 与本机真实核数一致。`);
  }
  return result('A5', 'masked', cores, truth, `页面读到的核数 ${cores} 与真实核数 ${real} 不同。`);
}

function judgeA6(observed, truth) {
  const info = observed && typeof observed === 'object' ? observed : {};
  const width = Number(info.width);
  const height = Number(info.height);
  const dpr = Number(info.dpr);
  const real = truth && typeof truth === 'object' ? truth : null;
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return result('A6', 'unknown', info, truth, unknownReason('A6'));
  }
  if (!real || !Number.isFinite(Number(real.width))) {
    return result('A6', 'unknown', info, null, unknownReason('A6'));
  }
  const realDpr = Number(real.scaleFactor);
  if (!Number.isFinite(dpr) || !Number.isFinite(realDpr)) {
    return result('A6', 'unknown', info, real, '像素比（页面报告的或系统缩放的）没拿到，无法判断是否被伪装。');
  }
  if (width === Number(real.width) && height === Number(real.height)) {
    return result('A6', 'suspect', info, real, '屏幕尺寸与主显示器完全一致，真实 Chrome 通常遇到的是缩放后的可用区域，一模一样反而少见。');
  }
  // 早先这里写反了：像素比和系统缩放**不一致**反而判 pass。真实浏览器的 devicePixelRatio
  // 就是系统缩放（1.5 倍缩放报 1.5），对不上说明只改了尺寸没改缩放，是更显眼的组合。
  if (Math.abs(dpr - realDpr) > 0.01) {
    return result('A6', 'suspect', info, real, `像素比 ${dpr} 与系统缩放 ${realDpr} 不一致，只改尺寸不改缩放反而更显眼${SUSPECT_TAIL}`);
  }
  return result('A6', 'pass', info, real, '屏幕尺寸已被调整过，像素比与系统缩放一致。');
}

function judgeB1(observed, truth) {
  const info = observed && typeof observed === 'object' ? observed : {};
  const renderer = str(info.renderer);
  const vendor = str(info.vendor);
  const real = str(truth);
  if (!renderer && !vendor) return result('B1', 'unknown', info, truth, unknownReason('B1'));
  const name = `${vendor} ${renderer}`.trim();
  if (!real) return result('B1', 'unknown', info, null, unknownReason('B1'));
  const realKey = real.toLowerCase();
  const gpuWord = renderer.toLowerCase().match(/\((?:[^,]+,\s*)?([^()]+?)\s+direct3d/i);
  const model = gpuWord ? gpuWord[1].toLowerCase().replace(/\(r\)|\(tm\)/g, '').trim() : '';
  if (model && realKey.includes(model)) {
    return result('B1', 'leak', info, truth, `WebGL 报出来的型号（${model}）正是本机显卡。`);
  }
  if (realKey && name && realKey.includes(name.toLowerCase())) {
    return result('B1', 'leak', info, truth, 'WebGL 报出来的串与本机显卡完全一致。');
  }
  return result('B1', 'masked', info, truth, 'WebGL 报出来的是统一口径的型号，不是本机显卡。');
}

function judgeB2(observed, truth) {
  const info = observed && typeof observed === 'object' ? observed : {};
  const first = str(info.hashA);
  const second = str(info.hashB);
  if (!first || !second) return result('B2', 'unknown', info, truth, '两次画布取样没都拿到，判不了稳定性。');
  if (first !== second) {
    return result('B2', 'suspect', info, truth, `同一张画布两次取样的哈希不一样（${first} / ${second}）——不稳定的指纹本身就是可识别特征${SUSPECT_TAIL}`);
  }
  return result('B2', 'pass', info, truth, '同一张画布两次取样哈希一致，指纹是稳定的。');
}

function judgeB3(observed, truth) {
  const info = observed && typeof observed === 'object' ? observed : {};
  const value = str(info.sum);
  if (!value) return result('B3', 'unknown', info, truth, unknownReason('B3'));
  const real = str(truth);
  if (real && value === real) return result('B3', 'leak', info, truth, '音频指纹与本机真实值一致。');
  if (!real) return result('B3', 'unknown', info, null, unknownReason('B3'));
  return result('B3', 'masked', info, truth, '音频输出已被加上扰动，与本机真实值不同。');
}

function judgeC1(observed, truth) {
  const candidates = asList(observed && observed.candidates !== undefined ? observed.candidates : observed);
  const leaked = candidates.filter((item) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|fd[0-9a-f]{2}:)/i.test(item));
  if (!candidates.length) {
    return result('C1', 'pass', candidates, truth, '没拿到任何直连候选（要么没有 WebRTC，要么被拦下了）。');
  }
  if (leaked.length) {
    return result('C1', 'leak', candidates, truth, `WebRTC 吐出了内网地址（${leaked.join('、')}），别人能据此定位到你所在的网络。`);
  }
  return result('C1', 'pass', candidates, truth, '拿到的候选都是公网地址，没有内网地址泄漏。');
}

function judgeC2(observed, truth) {
  const info = observed && typeof observed === 'object' ? observed : {};
  // 注意：这里不能拿整个 observed 当兜底——观察值本身就是对象，转成字符串会得到
  // "[object Object]" 这种非空值，出口地址为空时会被误判成"有地址"。
  const address = str(info.address !== undefined ? info.address : info.egress !== undefined ? info.egress : typeof observed === 'string' ? observed : '');
  if (!address) {
    return result('C2', 'unknown', info, truth, '代理没给出出口地址（未连接或还没取到），这一项只能算测不到。');
  }
  if (truth && str(truth) === address) {
    return result('C2', 'pass', info, truth, `出口地址 ${address} 与代理上报一致。`);
  }
  return result('C2', 'pass', info, truth, `出口地址 ${address}（来自代理状态，不是向第三方探测来的）。`);
}

function judgeD1(observed, truth) {
  const detected = Boolean(observed && typeof observed === 'object' ? observed.detected : observed);
  if (detected) {
    return result('D1', 'suspect', observed, truth, '这台机器上有录屏 / 远程控制类程序在跑，进隐私模式前请先确认是你自己开的。');
  }
  return result('D1', 'pass', observed, truth, '没检测到已知的录屏或远程控制程序。');
}

function judgeD2(observed, truth) {
  const blocked = observed && typeof observed === 'object' ? observed.blocked : observed;
  if (blocked === true) return result('D2', 'pass', observed, truth, '隐私模式下 agent 读取页面内容被拒绝，符合预期。');
  if (blocked === false) return result('D2', 'leak', observed, truth, '隐私模式下 agent 竟然能读到页面内容，这是缺陷。');
  return result('D2', 'unknown', observed, truth, unknownReason('D2'));
}

function judgeD3(observed, truth) {
  const info = observed && typeof observed === 'object' ? observed : {};
  const allowed = asList(info.allowed);
  const risky = allowed.filter((item) => /^(storage-access|window-management|geolocation|notifications|midi)$/i.test(item));
  if (!allowed.length && info.known === false) return result('D3', 'unknown', info, truth, unknownReason('D3'));
  if (risky.length) {
    return result('D3', 'leak', info, truth, `隐私模式下这些权限仍然默认放行：${risky.join('、')}。`);
  }
  return result('D3', 'pass', info, truth, '高敏感权限在隐私模式里都不是默认放行。');
}

function judgeD4(observed, truth) {
  const info = observed && typeof observed === 'object' ? observed : {};
  if (info.encrypted === true) return result('D4', 'pass', info, truth, '隐私快照是整条加密落盘的。');
  if (info.enabled === false) return result('D4', 'pass', info, truth, '隐私快照没开，也就没有明文可泄露。');
  if (info.encrypted === false) {
    return result('D4', 'leak', info, truth, '隐私快照开着，但读到的不是加密内容。');
  }
  return result('D4', 'unknown', info, truth, unknownReason('D4'));
}

/**
 * 必须和本机真实值比较的那几项：真实值拿不到时只能判 unknown。
 * 其余项靠自身逻辑判定（直连候选、画布稳定性、出口地址、UA-CH 自洽、行为约束），
 * 不该因为"没拿到真实值"就被连累成测不到。
 */
const TRUTH_REQUIRED = new Set(['A1', 'A3', 'A5', 'A6', 'B1', 'B3']);

const JUDGES = {
  A1: judgeA1,
  A2: judgeA2,
  A3: judgeA3,
  A4: judgeA4,
  A5: judgeA5,
  A6: judgeA6,
  B1: judgeB1,
  B2: judgeB2,
  B3: judgeB3,
  C1: judgeC1,
  C2: judgeC2,
  C3: judgeC3,
  D1: judgeD1,
  D2: judgeD2,
  D3: judgeD3,
  D4: judgeD4,
};
/** C3 恒为测不到：浏览器没有可信途径知道解析走了哪条链路。 */
function judgeC3(observed, truth) {
  return result('C3', 'unknown', observed === undefined ? null : observed, truth, '浏览器测不到 DNS 解析走了哪条链路，这一项恒为「测不到」，不是没做完。');
}

/**
 * 判定一项。
 *
 * @param {string} id 项编号（A1…D4）
 * @param {*} observed 被观察值（页面上/主进程里实测到的）
 * @param {*} truth 真实值；`null` 表示"这台机器上拿不到"，此时必须判 unknown
 * @param {{mode?:string}} [ctx] 上下文：`mode` 是 `normal` 还是 `private`（同样的差异，两种模式下含义相反）
 * @returns {{id:string, group:string, level:string, title:string, observed:*, truth:*, reason:string}}
 */
function judgeItem(id, observed, truth, ctx) {
  const key = str(id).toUpperCase();
  const judge = JUDGES[key];
  if (!judge) {
    return result(key || '?', 'unknown', observed === undefined ? null : observed, truth, '没有这一项的判定规则。');
  }
  // 只有"要和本机真实值比大小/比字符串"的项才受这条硬约束；别的项（直连候选、画布稳定性、
  // 出口地址、自洽性、行为约束）本来就不依赖真实值，判的时候不许被它连累成 unknown。
  if (TRUTH_REQUIRED.has(key) && (truth === null || truth === undefined)) {
    return result(key, 'unknown', observed === undefined ? null : observed, null, unknownReason(key));
  }
  const judged = judge(observed, truth, ctx || {});
  return judged;
}

/** 最坏的档位（leak 最糟）。 */
function worstLevel(rows) {
  const list = Array.isArray(rows) ? rows : [];
  for (const level of LEVELS) {
    if (list.some((row) => row && row.level === level)) return level;
  }
  return 'unknown';
}

function countLevels(rows) {
  const counts = { leak: 0, suspect: 0, unknown: 0, masked: 0, pass: 0 };
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row && Object.prototype.hasOwnProperty.call(counts, row.level)) counts[row.level] += 1;
  }
  return counts;
}

/** 一句话结论：三档，绝不出现分数。 */
function summarize(rows) {
  const counts = countLevels(rows);
  const worst = worstLevel(rows);
  let headline;
  if (counts.leak > 0) {
    headline = `发现 ${counts.leak} 项泄漏：这一页把本机真实信息暴露出去了。`;
  } else if (counts.suspect > 0) {
    headline = `有 ${counts.suspect} 项可疑：不一致的组合本身就是特征，建议按明细逐项看。`;
  } else if (counts.masked > 0) {
    headline = `没发现泄漏；${counts.masked} 项已伪装、${counts.unknown} 项测不到、${counts.pass} 项正常。`;
  } else {
    headline = `没发现泄漏；${counts.unknown} 项测不到、${counts.pass} 项正常。`;
  }
  return { counts, headline, worstLevel: worst };
}

function describeLevel(level) {
  const item = LEVEL_TEXT[level] || LEVEL_TEXT.unknown;
  return { label: item.label, tone: item.tone, code: item.code };
}

function groupRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return GROUPS.map((group) => ({
    ...group,
    rows: list.filter((row) => row && (row.group || ITEM_GROUPS[row.id]) === group.key),
  }));
}

function formatValue(value) {
  if (value == null) return '—';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  if (typeof value === 'object') {
    const parts = Object.keys(value)
      .filter((key) => value[key] !== undefined && value[key] !== null && value[key] !== '')
      .map((key) => `${key}=${value[key]}`);
    return parts.length ? parts.join(' · ') : '—';
  }
  const text = String(value);
  return text.length ? text : '—';
}

function normalizeMeta(meta) {
  const input = meta && typeof meta === 'object' ? meta : {};
  return {
    version: str(input.version) || '未知版本',
    electron: str(input.electron) || '未知',
    chromium: str(input.chromium) || '未知',
    at: str(input.at) || '未知时间',
    identity: str(input.identity) || '未知',
    kernelRunning: Boolean(input.kernelRunning),
  };
}

/** 从「真实值」里收集需要隐藏的字符串（报告默认脱敏，见 buildReport 的 redact）。 */
function secretStrings(rows) {
  const found = new Set();
  const add = (value) => {
    const text = str(value).trim();
    if (!text) return;
    // 纯数字（核数 24、宽度 1707）短到 2 位也得藏——判定理由里会原样写出来；
    // 字符串类要求 3 位以上，否则「en」「US」这种会误伤正文。
    if (/^\d+$/.test(text) ? text.length >= 2 : text.length >= 3) found.add(text);
  };
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const truth = row.truth;
    if (truth === null || truth === undefined) continue;
    if (Array.isArray(truth)) truth.forEach((item) => add(item));
    else if (typeof truth === 'object') Object.keys(truth).forEach((key) => add(truth[key]));
    else add(truth);
  }
  return Array.from(found);
}

function scrub(text, secrets) {
  let out = str(text);
  for (const secret of secrets) {
    if (!secret) continue;
    if (/^\d+$/.test(secret)) {
      // 数字要带边界，否则 24 会把时间戳里的 2024 也打坏
      out = out.replace(new RegExp(`(^|[^\\d.])${secret}(?![\\d.])`, 'g'), (whole, before) => `${before}—`);
    } else if (out.indexOf(secret) >= 0) {
      out = out.split(secret).join('—');
    }
  }
  return out;
}

/**
 * 脱敏时这一行的观察值要不要一起藏。
 *
 * 两类都要藏：① 泄漏/可疑项的观察值本来就等于真实值；② A1/A3/A5/A6/B1 这几个"身份面"的观察值
 * 即使是被伪装后的假值，也在描述这台机器的特征组合（UA、语言、核数、屏幕、显卡），
 * 存证是要随仓库公开的，没必要把它们带出去。
 */
const HIDE_OBSERVED_ALWAYS = new Set(['A1', 'A3', 'A5', 'A6', 'B1']);

function shouldHideObserved(row, redact) {
  if (!redact) return false;
  if (row.level === 'leak' || row.level === 'suspect') return true;
  return HIDE_OBSERVED_ALWAYS.has(str(row.id).toUpperCase());
}

/**
 * 人读的 Markdown 报告（只进剪贴板，不落盘）。
 *
 * 默认**脱敏**：这份报告会被复制、被贴进工单、被存进仓库，所以「真实值」一列默认写「已隐藏」，
 * 泄漏项/可疑项里本来就等于真实值的观察值也一并隐藏，理由文字里带到的真实数字也会被打掉。
 * 排障时用 `{ redact: false }`（`scripts/privacy-audit.js --raw`）在本地生成原始版，**不要分享**。
 */
function buildReport(rows, meta, options) {
  const info = normalizeMeta(meta);
  const summary = summarize(rows);
  const redact = !options || options.redact !== false;
  const secrets = redact ? secretStrings(rows) : [];
  const lines = [];
  lines.push('# Nyx 隐私自检报告');
  lines.push('');
  lines.push(`- 版本：${info.version}`);
  lines.push(`- Electron：${info.electron}｜Chromium：${info.chromium}`);
  lines.push(`- 时间：${info.at}`);
  lines.push(`- 身份档：${info.identity}｜代理内核：${info.kernelRunning ? '在运行' : '未运行'}`);
  if (redact) {
    lines.push('- 脱敏：**已隐藏本机真实值**。这份报告可以安全分享；需要排障请在本地用 `npm run privacy:audit --raw` 生成，不要直接分享原始版。');
  }
  lines.push('');
  lines.push(`**结论**：${summary.headline}`);
  lines.push('');
  const hiddenTruth = redact ? '—（已隐藏）' : '';
  const hiddenObserved = '—（与真实值相同，已隐藏）';
  for (const group of groupRows(rows)) {
    if (!group.rows.length) continue;
    lines.push(`## ${group.title}`);
    lines.push('');
    lines.push('| 项 | 结果 | 观察值 | 真实值 | 说明 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const row of group.rows) {
      const level = describeLevel(row.level);
      const observedText = shouldHideObserved(row, redact) ? hiddenObserved : formatValue(row.observed);
      const truthText = redact ? hiddenTruth : formatValue(row.truth);
      const reasonText = redact ? scrub(row.reason, secrets) : row.reason;
      lines.push(`| ${row.title || row.id} | ${level.label} | ${observedText} | ${truthText} | ${reasonText} |`);
    }
    lines.push('');
  }
  lines.push('这只是一次自检：它只证明它测到的面。TLS 指纹、HTTP/2 帧序、字体全量枚举都不在范围内。');
  return lines.join('\n');
}

/**
 * 结构化报告（字段固定，方便随版本存档比对）。
 *
 * 同样默认脱敏：真值换成占位符、泄漏/可疑项的观察值也换掉；差异比对只看 `level`，不受影响。
 */
function buildReportJson(rows, meta, options) {
  const info = normalizeMeta(meta);
  const summary = summarize(rows);
  const redact = !options || options.redact !== false;
  const secrets = redact ? secretStrings(rows) : [];
  return {
    kind: 'nyx-privacy-audit',
    version: info.version,
    electron: info.electron,
    chromium: info.chromium,
    at: info.at,
    identity: info.identity,
    kernelRunning: info.kernelRunning,
    redacted: redact,
    counts: summary.counts,
    headline: summary.headline,
    worstLevel: summary.worstLevel,
    groups: groupRows(rows).map((group) => ({
      key: group.key,
      title: group.title,
      rows: group.rows.map((row) => {
        return {
          id: row.id,
          level: row.level,
          title: row.title || row.id,
          observed: redact
            ? shouldHideObserved(row, true)
              ? '—（已隐藏）'
              : row.observed === undefined
                ? null
                : row.observed
            : row.observed === undefined
              ? null
              : row.observed,
          truth: redact ? '—（已隐藏）' : row.truth === undefined ? null : row.truth,
          reason: redact ? scrub(row.reason, secrets) : row.reason,
        };
      }),
    })),
  };
}

/** 对两份 JSON 报告比差异（存证脚本写「与上一版差异行」用）。 */
function diffReports(current, previous) {
  const now = new Map();
  const before = new Map();
  const flatten = (report) => {
    const map = new Map();
    const groups = report && Array.isArray(report.groups) ? report.groups : [];
    for (const group of groups) {
      for (const row of Array.isArray(group.rows) ? group.rows : []) {
        map.set(row.id, row.level);
      }
    }
    return map;
  };
  for (const [key, value] of flatten(current)) now.set(key, value);
  for (const [key, value] of flatten(previous)) before.set(key, value);
  const lines = [];
  for (const [id, level] of now) {
    if (!before.has(id)) lines.push(`${id} 新增（${describeLevel(level).label}）`);
    else if (before.get(id) !== level) lines.push(`${id} ${describeLevel(before.get(id)).label} → ${describeLevel(level).label}`);
  }
  for (const id of before.keys()) {
    if (!now.has(id)) lines.push(`${id} 本版缺失`);
  }
  return lines;
}

/**
 * 在页面主世界里跑的那段观测脚本（返回一个 Promise）。
 *
 * 为什么放在这个模块里：它只是"字符串"，没有任何 electron/fs 依赖，可以在这里被断言检查
 * （比如"不许联网""不许把结果传出去"）；主进程只负责把字符串塞进页面并收结果。
 *
 * 约束：脚本里不许出现反引号（会截断外层的模板字符串），也不许发起任何网络请求
 * （WebRTC 只收候选，不设 STUN/TURN 服务器，拿到的是本机网卡地址）。
 */
function buildObserverScript() {
  const lines = [
    '(function () {',
    '  var out = {};',
    '  function str(v) { return v === undefined || v === null ? "" : String(v); }',
    '  try { out.ua = str(navigator.userAgent); } catch (e) { out.ua = ""; }',
    '  try {',
    '    var d = navigator.userAgentData;',
    '    out.chPlatform = d ? str(d.platform) : "";',
    '    out.uaFullVersion = d ? str(d.uaFullVersion) : "";',
    '    out.chVersion = "";',
    // 注意：低熵 API 上 fullVersionList / uaFullVersion 在真实 Chromium 里是**空的**，
    // 必须走下面 getHighEntropyValues 才拿得到；这里只留初值，别拿它当结论。
    '  } catch (e) {}',
    '  try { out.uaPlatform = str(navigator.platform); } catch (e) { out.uaPlatform = ""; }',
    '  try { out.language = str(navigator.language); } catch (e) { out.language = ""; }',
    '  try { out.languages = Array.prototype.slice.call(navigator.languages || []); } catch (e) { out.languages = []; }',
    '  try { out.timezone = str(Intl.DateTimeFormat().resolvedOptions().timeZone); } catch (e) { out.timezone = ""; }',
    '  try { out.offsetMinutes = new Date().getTimezoneOffset(); } catch (e) { out.offsetMinutes = null; }',
    '  try { out.cores = Number(navigator.hardwareConcurrency) || 0; } catch (e) { out.cores = 0; }',
    '  try { out.deviceMemory = Number(navigator.deviceMemory) || 0; } catch (e) { out.deviceMemory = 0; }',
    '  try {',
    '    out.width = Number(window.screen.width) || 0;',
    '    out.height = Number(window.screen.height) || 0;',
    '    out.dpr = Number(window.devicePixelRatio) || 1;',
    '  } catch (e) {}',
    '  function hash(text) {',
    '    var h = 2166136261;',
    '    for (var i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }',
    '    return (h >>> 0).toString(16);',
    '  }',
    '  function paintOnce() {',
    '    var canvas = document.createElement("canvas");',
    '    canvas.width = 220;',
    '    canvas.height = 60;',
    '    var ctx = canvas.getContext("2d");',
    '    ctx.textBaseline = "top";',
    '    ctx.font = \'16px "Arial"\';',
    '    ctx.fillStyle = "#f60";',
    '    ctx.fillRect(10, 5, 100, 20);',
    '    ctx.fillStyle = "#1a5";',
    '    ctx.fillText("Nyx canvas 0123", 12, 26);',
    '    return canvas.toDataURL();',
    '  }',
    '  try { out.hashA = hash(paintOnce()); } catch (e) { out.hashA = ""; }',
    '  try { out.hashB = hash(paintOnce()); } catch (e) { out.hashB = ""; }',
    '  try {',
    '    var probe = document.createElement("canvas");',
    '    var gl = probe.getContext("webgl");',
    '    var dbg = gl ? gl.getExtension("WEBGL_debug_renderer_info") : null;',
    '    out.vendor = gl ? str(gl.getParameter(dbg ? dbg.UNMASKED_VENDOR_WEBGL : gl.VENDOR)) : "";',
    '    out.renderer = gl ? str(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) : "";',
    '  } catch (e) { out.vendor = ""; out.renderer = ""; }',
    '  return new Promise(function (resolve) {',
    '    var done = false;',
    '    function finish() { if (!done) { done = true; resolve(out); } }',
    '    var budget = setTimeout(finish, 900);',
    '    var pending = 3;',
    '    function settled() { pending -= 1; if (pending <= 0) { clearTimeout(budget); finish(); } }',
    // 客户端提示的高熵字段：低熵只有 brand 与 major，完整版本号必须显式要一次。
    // 拿不到就让 chVersion / uaFullVersion 保持空，判定那边会按「测不到」处理，绝不填空当一致。
    '    var chStarted = false;',
    '    try {',
    '      var ud = navigator.userAgentData;',
    '      if (ud && typeof ud.getHighEntropyValues === "function") {',
    '        chStarted = true;',
    '        ud.getHighEntropyValues(["uaFullVersion", "fullVersionList", "platformVersion", "architecture", "bitness", "model"]).then(function (high) {',
    '          try {',
    '            if (high) {',
    '              out.uaFullVersion = str(high.uaFullVersion) || out.uaFullVersion;',
    '              out.platformVersion = str(high.platformVersion);',
    '              out.architecture = str(high.architecture);',
    '              out.bitness = str(high.bitness);',
    '              var list = high.fullVersionList || [];',
    '              for (var i = 0; i < list.length; i += 1) {',
    '                var brand = list[i] || {};',
    '                if (/Chromium/i.test(str(brand.brand))) out.chVersion = str(brand.version);',
    '              }',
    '            }',
    '          } catch (e) {}',
    '          settled();',
    '        }).catch(function () { settled(); });',
    '      }',
    '    } catch (e) { chStarted = false; }',
    '    if (!chStarted) settled();',
    // 音频：离线渲染一段，取样本和（只在本机比对，不上传）
    '    try {',
    '      var Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;',
    '      if (!Ctx) { settled(); } else {',
    '        var actx = new Ctx(1, 2048, 44100);',
    '        var osc = actx.createOscillator();',
    '        osc.type = "triangle";',
    '        osc.frequency.value = 440;',
    '        var comp = actx.createDynamicsCompressor();',
    '        osc.connect(comp);',
    '        comp.connect(actx.destination);',
    '        osc.start(0);',
    '        actx.startRendering().then(function (buffer) {',
    '          try {',
    '            var data = buffer.getChannelData(0);',
    '            var sum = 0;',
    '            for (var i = 0; i < data.length; i += 1) sum += Math.abs(data[i]);',
    '            out.audioSum = Math.round(sum * 1000) / 1000;',
    '          } catch (e) { out.audioSum = null; }',
    '          settled();',
    '        }).catch(function () { settled(); });',
    '      }',
    '    } catch (e) { settled(); }',
    // WebRTC：不配 STUN/TURN，只收本机候选（能直接看出是否漏内网地址）
    '    try {',
    '      var Peer = window.RTCPeerConnection;',
    '      if (!Peer) { settled(); } else {',
    '        var pc = new Peer({ iceServers: [] });',
    '        var found = [];',
    '        pc.onicecandidate = function (event) {',
    '          if (!event || !event.candidate) return;',
    '          var cand = str(event.candidate.candidate || "");',
    '          var m = cand.match(/\\b(\\d{1,3}(?:\\.\\d{1,3}){3})\\b/);',
    '          if (m && found.indexOf(m[1]) < 0) found.push(m[1]);',
    '        };',
    '        try { pc.createDataChannel("nyx"); } catch (e) {}',
    '        pc.createOffer().then(function (offer) { return pc.setLocalDescription(offer); }).catch(function () {});',
    '        setTimeout(function () {',
    '          out.webrtcCandidates = found.slice(0);',
    '          try { pc.close(); } catch (e) {}',
    '          settled();',
    '        }, 600);',
    '      }',
    '    } catch (e) { settled(); }',
    '  });',
    '})()',
  ];
  return lines.join('\n');
}

module.exports = {
  BANNED_PHRASES,
  GROUPS,
  ITEM_GROUPS,
  LEVELS,
  TITLES,
  buildObserverScript,
  buildReport,
  buildReportJson,
  canonicalLanguage,
  countLevels,
  describeLevel,
  diffReports,
  groupRows,
  judgeItem,
  normalizeMeta,
  regionOfLanguage,
  regionOfTimeZone,
  summarize,
  worstLevel,
};
