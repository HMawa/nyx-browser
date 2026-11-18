'use strict';

/**
 * 全隐私模式的"会话级"防泄漏装配。
 *
 * 分工说明：这个模块只管主进程能改的东西（UA、语言、请求头、WebRTC 策略、
 * 预加载脚本参数）；页面内的 JS 层面（Canvas / WebGL / 字体 / 音频 / 时区 /
 * 屏幕 / 设备枚举）由 src/preload-tab.js 负责。两者共用同一个 profile 对象，
 * 保证"主进程说的"和"页面里报的"完全一致——不一致本身就是可被检测的指纹。
 *
 * 核心原则：所有伪装值都取自"代理出口的真实情况"（出口 IP 的国家 / 时区），
 * 而不是随便编一个。IP 在美国、时区报上海，比不伪装更容易被识别。
 */

const os = require('node:os');

/** 无法从出口信息推断时使用的兜底语言 */
const DEFAULT_LANGUAGE = 'en-US,en';

let cachedSeed = null;

/** 生成一次性的会话种子：所有噪声都基于它派生，保证同一会话内指纹稳定 */
function makeSeed() {
  if (cachedSeed) return cachedSeed;
  cachedSeed = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return cachedSeed;
}

/** 取本机 Chromium 主版本号：UA 里的版本必须与真实内核一致，否则一眼假 */
function chromiumMajor() {
  try {
    const chrome = String(process.versions.chrome || '');
    const major = chrome.split('.')[0];
    return /^\d+$/.test(major) ? major : '120';
  } catch {
    return '120';
  }
}

/** 平台串（与真实内核平台一致） */
function platformToken() {
  if (process.platform === 'win32') return 'Windows NT 10.0; Win64; x64';
  if (process.platform === 'darwin') return 'Macintosh; Intel Mac OS X 10_15_7';
  return 'X11; Linux x86_64';
}

/** 平台可读名（userAgentData.platform 用） */
function platformName() {
  if (process.platform === 'win32') return 'Windows';
  if (process.platform === 'darwin') return 'macOS';
  return 'Linux';
}

/**
 * navigator.platform 用的值。注意它和 userAgentData.platform 不是一回事：
 * 真 Chrome 在 Windows 上报的是 `Win32`，不是 `Windows`。两边写成同一个值，
 * 页面里一对比就露馅（Worker 里报的还是真的 Win32，主世界报 Windows，自相矛盾）。
 */
function navigatorPlatform() {
  if (process.platform === 'win32') return 'Win32';
  if (process.platform === 'darwin') return 'MacIntel';
  return 'Linux x86_64';
}

/**
 * Windows 版本号 → UA-CH 的 platformVersion。
 *
 * 这里只做"读得出就说、读不出就不说"：留空只是少一条信息，
 * 猜一个错的值反而和 UA、客户端提示里的其它字段对不上。
 */
function windowsPlatformVersion(release) {
  const build = Number(String(release || '').split('.')[2]);
  if (!Number.isFinite(build) || build <= 0) return '';
  if (build >= 26100) return '19.0.0'; // Windows 11 24H2
  if (build >= 22631) return '15.0.0'; // Windows 11 23H2
  if (build >= 22000) return '13.0.0'; // Windows 11 21H2 / 22H2
  if (build >= 10240) return '10.0.0'; // Windows 10
  return '';
}

/** 本机 Windows 版本对应的 UA-CH platformVersion；非 Windows 一律空串 */
function currentPlatformVersion() {
  if (process.platform !== 'win32') return '';
  try {
    return windowsPlatformVersion(os.release());
  } catch {
    return '';
  }
}

/**
 * 解析 Accept-Language：真 Chrome 的 `navigator.languages` 里**不含 `;q=`**，
 * 直接把请求头串塞给页面会得到 `["zh-HK","zh;q=0.9"]` 这种一眼假的东西。
 * 请求头照旧用原始串，只有页面里读到的列表要解析。
 */
function parseAcceptLanguage(raw) {
  const source = String(raw == null ? '' : raw);
  const seen = new Set();
  const out = [];
  for (const item of source.split(',')) {
    const code = String(item).split(';')[0].trim();
    if (!code) continue;
    const key = code.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(code);
  }
  return out.length ? out : DEFAULT_LANGUAGE.split(',');
}

/** 计算某个 IANA 时区相对 UTC 的偏移（分钟，符号与 getTimezoneOffset 一致） */
function timezoneOffsetMinutes(timeZone, date = new Date()) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const map = {};
    for (const part of dtf.formatToParts(date)) map[part.type] = part.value;
    const asUTC = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      Number(map.hour === '24' ? '0' : map.hour),
      Number(map.minute),
      Number(map.second),
    );
    const local = Math.floor(date.getTime() / 1000) * 1000;
    // 注意符号：`Date.prototype.getTimezoneOffset()` 的口径是「本地比 UTC 慢多少分钟为正」，
    // 纽约（UTC-5）应当给 +300，东京（UTC+9）应当给 -540。
    // 之前这里写成 asUTC - local，符号正好反了：纽约会报 -300，页面里的偏移与
    // 「America/New_York」这个时区名自相矛盾（自检 A4 就是靠这条对不上的）。
    return Math.round((local - asUTC) / 60000);
  } catch {
    return null;
  }
}

/** 校验时区名是否被 Intl 认可（避免把无效时区注入页面） */
function isValidTimezone(timeZone) {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * 语言 → 代表性时区（只在"出口时区未知"时用来兜底对齐）。
 *
 * 为什么需要它：隐私画像会把语言换成画像里的值（比如 en-US），但如果出口没给出时区，
 * 真实时区就留在本机（Asia/Shanghai）——于是页面看到「语言 en-US + 时区上海」这种
 * 现实里不存在的组合。真实 Chrome 里语言与时区大体来自同一地区，这种自相矛盾
 * 本身就是一处可识别特征（自检 A4 就是这么判的）。
 * 出口给了时区时一律以出口为准，这张表只在出口未知时兜底。
 */
const LANGUAGE_TIMEZONE = {
  'en-us': 'America/New_York',
  'en-gb': 'Europe/London',
  'en-au': 'Australia/Sydney',
  'en-ca': 'America/Toronto',
  'en-nz': 'Pacific/Auckland',
  'en-in': 'Asia/Kolkata',
  'en-sg': 'Asia/Singapore',
  'en-ph': 'Asia/Manila',
  zh: 'Asia/Shanghai',
  'zh-cn': 'Asia/Shanghai',
  'zh-hk': 'Asia/Hong_Kong',
  'zh-tw': 'Asia/Taipei',
  'zh-sg': 'Asia/Singapore',
  ja: 'Asia/Tokyo',
  ko: 'Asia/Seoul',
  de: 'Europe/Berlin',
  fr: 'Europe/Paris',
  es: 'Europe/Madrid',
  it: 'Europe/Rome',
  pt: 'Europe/Lisbon',
  'pt-br': 'America/Sao_Paulo',
  ru: 'Europe/Moscow',
  nl: 'Europe/Amsterdam',
  pl: 'Europe/Warsaw',
  tr: 'Europe/Istanbul',
  uk: 'Europe/Kyiv',
  vi: 'Asia/Ho_Chi_Minh',
  th: 'Asia/Bangkok',
  id: 'Asia/Jakarta',
  ms: 'Asia/Kuala_Lumpur',
  hi: 'Asia/Kolkata',
  ar: 'Asia/Dubai',
};

/** 按语言挑一个代表性时区；认不出来就返回空串（空串表示"不伪装时区"，绝不瞎猜） */
function timezoneForLanguage(language) {
  // 传进来的可能是 `en-US,en` 这种整串 Accept-Language，先取第一个标签
  const first = String(language || '').split(',')[0];
  const tag = first.trim().toLowerCase().replace(/_/g, '-');
  if (!tag) return '';
  if (LANGUAGE_TIMEZONE[tag]) return LANGUAGE_TIMEZONE[tag];
  const primary = tag.split('-')[0];
  return LANGUAGE_TIMEZONE[primary] || '';
}

/** 国家码 → 语言列表（右侧回退与 proxy-service 的 languagesForCountry 保持一致） */
function languagesForCountryLite(country) {  const code = String(country || '').trim().toUpperCase();
  const table = {
    CN: 'zh-CN,zh,en',
    HK: 'zh-HK,zh,en',
    TW: 'zh-TW,zh,en',
    JP: 'ja,en',
    KR: 'ko,en',
    SG: 'en-SG,en,zh',
    US: 'en-US,en',
    GB: 'en-GB,en',
    CA: 'en-CA,en,fr',
    AU: 'en-AU,en',
    DE: 'de-DE,de,en',
    FR: 'fr-FR,fr,en',
    NL: 'nl-NL,nl,en',
    RU: 'ru-RU,ru,en',
    BR: 'pt-BR,pt,en',
    IN: 'en-IN,en,hi',
    TR: 'tr-TR,tr,en',
    VN: 'vi-VN,vi,en',
    TH: 'th-TH,th,en',
    MY: 'ms-MY,ms,en',
    ID: 'id-ID,id,en',
    PH: 'en-PH,en,fil',
    UA: 'uk-UA,uk,ru',
    PL: 'pl-PL,pl,en',
    ES: 'es-ES,es,en',
    IT: 'it-IT,it,en',
    SE: 'sv-SE,sv,en',
    CH: 'de-CH,de,fr,en',
    AE: 'ar-AE,ar,en',
    IL: 'he-IL,he,en',
  };
  return table[code] || DEFAULT_LANGUAGE;
}

class PrivacyHardening {
  /**
   * @param {object} [options]
   * @param {(entry:{level:string,text:string}) => void} [options.log]
   */
  constructor({ log = () => {} } = {}) {
    this.log = log;
    /** 当前生效的 profile（null 表示尚未构建） */
    this.profile = null;
    /** 上一次构建过的 profile（退出隐私模式后仍保留，供界面回显"上次生效口径"） */
    this.lastProfile = null;
    /** 已下发过请求头策略的分区 */
    this.headerAttached = new Set();
  }

  /**
   * 构建一份隐私 profile。
   *
   * @param {object} options
   * @param {object|null} options.egress 出口画像（来自 ProxyService.egressProfile()）
   * @param {boolean} [options.egressUnknown] 出口信息是否未知（未知时不伪装时区，只做其余加固）
   */
  buildProfile({ egress = null, egressUnknown = false } = {}) {
    const major = chromiumMajor();
    const ua = `Mozilla/5.0 (${platformToken()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;

    const country = egress && egress.country ? egress.country : '';
    const timezoneCandidate = egress && egress.timezone ? egress.timezone : '';
    const timezone = isValidTimezone(timezoneCandidate) ? timezoneCandidate : '';
    const acceptLanguage =
      (egress && egress.language ? egress.language : '') || languagesForCountryLite(country);

    // 出口国家未知时仍按最中性的取值做"对齐"，并在状态里标注，界面上要提示用户
    const resolvedLanguage = acceptLanguage || DEFAULT_LANGUAGE;
    // 出口给了可信时区就以出口为准；出口未知时，时区跟语言取同一地区——
    // 「语言 en-US + 时区上海」这种组合现实里不存在，比不伪装时区更容易被认出来。
    const alignedTz = isValidTimezone(timezone) && !egressUnknown
      ? timezone
      : timezoneForLanguage(resolvedLanguage);
    const spoofTimezone = isValidTimezone(alignedTz);

    const profile = {
      mode: 'private',
      seed: makeSeed(),
      ua,
      // UA 里写的是 `Chrome/<主版本>.0.0.0`，但客户端提示（userAgentData）里的
      // fullVersionList 必须给完整版本号，否则两边一对就不一致。
      chromeMajor: major,
      chromeVersion: String(process.versions.chrome || ''),
      // 两个"平台"分开存：`platform` 给 UA-CH（Windows），
      // `navigatorPlatform` 给 navigator.platform（Win32）。真 Chrome 就是这么分工的。
      platform: platformName(),
      navigatorPlatform: navigatorPlatform(),
      platformVersion: currentPlatformVersion(),
      country,
      timezone: spoofTimezone ? alignedTz : '',
      timezoneOffset: spoofTimezone ? timezoneOffsetMinutes(alignedTz) : null,
      acceptLanguage: resolvedLanguage,
      languages: parseAcceptLanguage(resolvedLanguage),
      exitIp: egress ? egress.ip : null,
      exitIsp: egress ? egress.isp : '',
      exitAsn: egress ? egress.asn : '',
      egressUnknown: Boolean(egressUnknown) || !spoofTimezone,
      builtAt: Date.now(),
    };

    this.profile = profile;
    return profile;
  }

  /** 页面预加载脚本的启动参数：把 profile 里页面需要的部分带过去 */
  preloadArgs(profile) {
    const active = profile || this.profile;
    if (!active) return ['--nyx-mode=private'];

    const args = [
      '--nyx-mode=private',
      `--nyx-seed=${active.seed}`,
      `--nyx-lang=${active.languages.join(',')}`,
      `--nyx-ua=${encodeURIComponent(active.ua)}`,
      `--nyx-platform=${active.platform}`,
      // 客户端提示要用完整版本号；主版本 / 完整版本必须是同一版的两种写法
      `--nyx-chrome=${active.chromeVersion || active.chromeMajor}`,
    ];
    if (active.platformVersion) args.push(`--nyx-platform-version=${active.platformVersion}`);
    if (active.timezone) {
      args.push(`--nyx-tz=${active.timezone}`);
      args.push(`--nyx-tz-offset=${active.timezoneOffset}`);
    }
    return args;
  }

  /** 正常模式的预加载参数：不做任何伪装，只保留表单自动填充 */
  normalArgs() {
    return ['--nyx-mode=normal'];
  }

  /**
   * 页面预加载脚本的结构化配置（随 nyx:tab:config 同步 IPC 下发）。
   *
   * 与 preloadArgs() 是同一份数据的两种载体：argv 在 sandbox 渲染进程里不保证可见，
   * 结构化下发的对象才是页面侧配置的**权威来源**；argv 仅作为兜底。
   * 两份载体必须由同一个 profile 派生，任何一处单独改都会造成"主进程说的"与
   * "页面里报的"不一致——不一致本身就是可被检测的指纹。
   */
  preloadConfig(profile) {
    const active = profile || this.profile;
    if (!active) return { mode: 'private' };
    return {
      mode: 'private',
      seed: active.seed,
      tz: active.timezone || '',
      tzOffset: active.timezoneOffset,
      languages: active.languages.slice(),
      ua: active.ua,
      platform: active.platform,
      chrome: active.chromeMajor,
      country: active.country || '',
      egressUnknown: Boolean(active.egressUnknown),
    };
  }

  /** 请求头集合按名替换（不区分大小写，避免 Chromium 侧键名大小写差异导致漏改） */
  static setHeader(headers, name, value) {
    const existing = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
    headers[existing || name] = value;
  }

  /** 请求头集合按名删除 */
  static deleteHeader(headers, name) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
    }
  }

  /**
   * 把 profile 下发到 Session：改写 UA 与接受语言，并接管请求头。
   *
   * UA 里的 Chromium 主版本取自真实内核，所以 Sec-CH-UA 等客户端提示头与服务端
   * 看到的 UA 不会互相矛盾——Electron 特征（Electron/x.y.z 段）则被彻底抹掉。
   */
  applySession(ses, profile) {
    const active = profile || this.profile;
    if (!ses || !active) return { ok: false, error: '缺少会话或 profile' };

    try {
      // UA/语言空串 = 恢复默认；绝不能传 null/undefined（Electron 参数校验抛 conversion failure）
      ses.setUserAgent(active.ua || '', active.acceptLanguage || '');
    } catch (err) {
      return { ok: false, error: `UA 下发失败：${err.message}` };
    }

    if (typeof ses.setSpellCheckerEnabled === 'function') ses.setSpellCheckerEnabled(false);

    const tag = ses.storagePath || 'memory';
    if (this.headerAttached.has(tag)) return { ok: true, reused: true };
    this.headerAttached.add(tag);

    try {
      ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
        const headers = { ...details.requestHeaders };
        const major = active.chromeMajor;

        // 与页面内 navigator.userAgent 保持同一份值，避免头 / JS 两处不一致
        // （Chromium 的 UA-CH 头也必须跟着改，否则 Sec-CH-UA 声称的版本或品牌
        //   与 UA 矛盾，属于最容易被抓的"头 / JS 不一致"）
        PrivacyHardening.setHeader(headers, 'User-Agent', active.ua);
        PrivacyHardening.setHeader(headers, 'Accept-Language', active.acceptLanguage);
        PrivacyHardening.setHeader(
          headers,
          'Sec-CH-UA',
          `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not?A_Brand";v="24"`,
        );
        PrivacyHardening.setHeader(headers, 'Sec-CH-UA-Mobile', '?0');
        PrivacyHardening.setHeader(headers, 'Sec-CH-UA-Platform', `"${active.platform}"`);

        // 只属于 Electron / 桌面外壳的头：出现即暴露"这不是普通 Chrome"
        PrivacyHardening.deleteHeader(headers, 'X-Client-Data');
        PrivacyHardening.deleteHeader(headers, 'X-Requested-With');
        PrivacyHardening.deleteHeader(headers, 'X-Electron-Version');

        callback({ requestHeaders: headers });
      });
    } catch (err) {
      return { ok: false, error: `请求头策略装配失败：${err.message}` };
    }

    this.lastApplied = { at: Date.now(), ua: active.ua, acceptLanguage: active.acceptLanguage };
    return { ok: true };
  }

  /** WebRTC 策略：隐私模式禁止非代理 UDP，防止真实 IP 经 STUN 泄漏 */
  webrtcPolicy(mode) {
    return mode === 'private' ? 'disable_non_proxied_udp' : 'default';
  }

  /** 现状快照（界面与验收脚本用，不含密钥类信息） */
  status() {
    const summarize = (item) => ({
      ua: item.ua,
      acceptLanguage: item.acceptLanguage,
      timezone: item.timezone || '(未对齐)',
      timezoneOffset: item.timezoneOffset,
      country: item.country,
      exitIp: item.exitIp,
      egressUnknown: item.egressUnknown,
      builtAt: item.builtAt,
      seed: item.seed.slice(0, 4) + '****',
    });

    const active = this.profile;
    if (!active) {
      // 退出隐私模式后 profile 已被复位（下一次进隐私模式必须重建），
      // 但"上次生效口径"仍回显，便于用户确认残留是否清干净。
      return {
        mode: 'normal',
        hardened: false,
        last: this.lastProfile ? summarize(this.lastProfile) : null,
      };
    }

    return { mode: 'private', hardened: true, ...summarize(active) };
  }

  /**
   * 离开隐私模式时清掉 profile，避免下次误用旧值。
   *
   * 语义上必须"复位 + 留痕"：复位保证下次进入隐私模式一定重新构建 profile
   * （否则会复用旧的出口时区 / 种子，等于用着上一次会话的指纹）；
   * 留痕（lastProfile）只用于界面回显，不参与任何装配。
   */
  reset() {
    if (this.profile) this.lastProfile = this.profile;
    this.profile = null;
    cachedSeed = null;
    return { ok: true };
  }
}

module.exports = {
  PrivacyHardening,
  chromiumMajor,
  platformToken,
  platformName,
  navigatorPlatform,
  windowsPlatformVersion,
  currentPlatformVersion,
  parseAcceptLanguage,
  timezoneOffsetMinutes,
  isValidTimezone,
  languagesForCountryLite,
  DEFAULT_LANGUAGE,
};
