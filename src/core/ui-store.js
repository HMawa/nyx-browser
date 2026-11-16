'use strict';

/**
 * 界面偏好：顶栏元素显隐、界面主题一类的纯外观开关。
 * 落盘位置：<userData>/ui-preferences.json
 *
 * 只存布尔值与白名单内的枚举字符串，不含任何敏感信息；读取失败一律回落到默认值，
 * 保证界面永远有一份可用配置。
 */

const fs = require('fs');
const path = require('path');

/** 已知偏好项与默认值（键名白名单，写入时校验） */
const UI_PREF_DEFAULTS = {
  /** 顶栏是否显示出站链路徽标（直连 / 代理） */
  showLinkBadge: true,
  /** 顶栏是否显示隐私模式开关 */
  showModeSwitch: true,
  /**
   * 顶栏按钮是否带小字标签（清单 B1）。
   * 默认开：图标认不出来的时候，一行小字比 tooltip 更救急；认得出的人可以在外观里关掉。
   */
  toolbarLabels: true,
  /**
   * 动效档位（清单 B2）：calm 克制（默认）/ lively 活泼。
   * 只影响小按钮的过渡与按压缩放；系统开了「减少动效」时一律降到最短，不看这个值。
   */
  motionLevel: 'calm',
  /**
   * 模式切换动画（用户要求做成可关）：默认开。
   * 关掉之后切换是瞬时的——有人嫌动画碍事，也有人机器带不动透明窗口，这是他们该有的开关。
   */
  modeTransition: true,
  /** 界面主题：ink 墨夜 / aurora 极光 / paper 素纸 / quiet 静谧 / cream 奶白 / sea 海盐 */
  theme: 'ink',
  /** 下载保存目录；空字符串 = 跟随系统下载目录 */
  downloadDir: '',
  /** 下载前是否弹窗询问保存位置（false 时静默存到 downloadDir） */
  downloadAsk: true,
  /**
   * 隐私模式的出站方式（清单 B3）：
   *   'proxy'  默认，隐私模式强制经本机代理；
   *   'direct' 用户显式选择的「真实 IP」直连——只有用户在设置里勾选风险确认后
   *            才会写进这里，任何代码路径都不许自己把它改成 'direct'。
   */
  privacyLink: 'proxy',
  /**
   * 图形性能策略（清单 A5）：
   *   'low-power'        默认，核显优先（不请求高性能适配器）；
   *   'high-performance' 独显优先（用户显式选择）；
   *   'auto'             跟随系统，不加任何 GPU 偏好开关。
   * 只在下次启动生效（Chromium 的 GPU 选择发生在 ready 之前）。
   */
  gpuPolicy: 'low-power',

  /**
   * 页面摘要（清单 F）：默认**关闭**。
   * 它是纯抽取式的（不调生成式 API），但"要不要让 Nyx 读这一页"仍然应该由用户点开关决定。
   */
  digestEnabled: false,

  /**
   * 后台标签闲置多少分钟后休眠（清单 G）。0 = 不自动休眠。
   * 改完立刻生效（TabManager.setSleepAfterMs），不需要重启。
   */
  tabSleepMinutes: 30,

  /**
   * 设置页卡片的「铺开 / 收回」状态（清单 A1，v1.17.8）。
   *
   * 存成 JSON 字符串（`{"分区:标题slug":1}`）：界面偏好这条通道只收布尔值与字符串
   * （`nyx:ui:prefs-set` 的校验是刻意的，别为了这点小事放开它），所以键值对在这里
   * 序列化成一行文本，读的时候解析失败就按"一条都没记过"处理。
   * 值 1 = 用户亲手收起的卡片；**只记与分区默认不同的那些**，新卡片不会因为没人记过就意外被收起。
   */
  settingsFold: '',

  /**
   * 离线阅读缓存（候选③）：默认开启，但用户可以在「隐私与安全」里一键关掉。
   * 关掉时不只是以后不写，还会把已经落盘的正文快照一起清掉——
   * 普通模式的快照由这个开关说了算；隐私模式的快照另见 privateSnapshotEnabled。
   */
  offlineCacheEnabled: true,

  /**
   * 隐私模式的加密快照（用户第 2 项）：默认开启。
   *
   * 与普通模式刻意分开：普通模式存明文 page-cache.json，隐私模式存
   * private-cache.json 且整条加密（safeStorage → DPAPI），明面上只有地址哈希与时间。
   * 关掉之后隐私模式一条都不写；系统密钥不可用时也一条都不写（绝不退化成明文）。
   */
  privateSnapshotEnabled: true,

  /**
   * 离线缓存按站点收窄（用户第 5 项）。
   *
   * mode='all' 全存；mode='allowlist' 只存 cacheSiteAllow 里的站点。
   * 无论哪种模式，cacheSiteBlock 里的站点永远不存（黑名单优先，白名单不能豁免）。
   * 名单只做域名级：example.com 连子域一起算。
   */
  cacheSiteMode: 'all',
  cacheSiteAllow: [],
  cacheSiteBlock: [],

  /**
   * 隐私模式的快照按站点收窄（本轮新增）。
   *
   * 为什么另开一份而不是复用上面的名单：两份名单回答的是两个问题——
   * 上面那份管「普通模式要不要留明文正文」，这份管「隐私模式要不要留加密快照」。
   * 一个人完全可能希望「普通模式全存、隐私模式只存几个自己查资料的站点」，
   * 共用一个名单就会被其中一边的选择绑架。
   *
   * 语义与普通模式保持一致：block 永远优先，allowlist 模式下只存名单里的站点。
   */
  privateSiteMode: 'all',
  privateSiteAllow: [],
  privateSiteBlock: [],
};

/** 枚举型偏好的合法取值（键 → 允许值）。
 *  与 theme-nyx.css 里 <html data-theme="…"> 的取值必须一一对应。 */
const UI_PREF_ENUMS = {
  theme: ['ink', 'aurora', 'paper', 'quiet', 'cream', 'sea'],
  privacyLink: ['proxy', 'direct'],
  gpuPolicy: ['low-power', 'high-performance', 'auto'],
  cacheSiteMode: ['all', 'allowlist'],
  privateSiteMode: ['all', 'allowlist'],
  /** 动效档位（清单 B2）；系统「减少动效」在渲染层再降一档，不改这里存的值 */
  motionLevel: ['calm', 'lively'],
};

class UiStore {
  /**
   * @param {{stateDir:string}} opts
   */
  constructor({ stateDir }) {
    this.statePath = path.join(stateDir, 'ui-preferences.json');
    this.state = null;
  }

  load() {
    if (this.state) return this.state;

    let loaded = null;
    try {
      if (fs.existsSync(this.statePath)) {
        loaded = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      }
    } catch {
      loaded = null; // 文件损坏按默认值处理，不阻断启动
    }

    const merged = Object.assign({}, UI_PREF_DEFAULTS, loaded && typeof loaded === 'object' ? loaded : {});

    // 只保留白名单键；枚举键按 UI_PREF_ENUMS 校验，其余键类型必须与默认值一致，
    // 防止脏数据污染内存
    for (const key of Object.keys(merged)) {
      if (!(key in UI_PREF_DEFAULTS)) {
        // 原实现此处为 merged[key] = UI_PREF_DEFAULTS[key]，但该键不在默认表里，
        // 取到的是 undefined —— 键并未删除（JSON.stringify 会丢弃 undefined，所以磁盘上看不出来，
        // 但内存对象里一直带着它），与"只保留白名单键"的注释相反。delete 才是注释的本意。
        delete merged[key];
      } else if (UI_PREF_ENUMS[key]) {
        // 枚举键放行字符串，但取值必须在白名单内
        if (!UI_PREF_ENUMS[key].includes(merged[key])) merged[key] = UI_PREF_DEFAULTS[key];
      } else if (typeof merged[key] !== typeof UI_PREF_DEFAULTS[key]) {
        merged[key] = UI_PREF_DEFAULTS[key];
      }
    }

    this.state = merged;
    this.save();
    return this.state;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /** 界面用快照 */
  get() {
    return Object.assign({}, this.load());
  }

  /** 写入单项偏好；键名与取值都必须在白名单内 */
  set(key, value) {
    if (!(key in UI_PREF_DEFAULTS)) return { ok: false, error: `未知的偏好项：${key}` };

    // 枚举键按允许值校验，其余键仍要求与默认值同类型
    if (UI_PREF_ENUMS[key]) {
      if (!UI_PREF_ENUMS[key].includes(value)) {
        return { ok: false, error: `取值不合法：${value}` };
      }
    } else if (typeof value !== typeof UI_PREF_DEFAULTS[key]) {
      return { ok: false, error: '取值类型不合法' };
    }

    const state = this.load();
    state[key] = value;
    if (!this.save()) return { ok: false, error: '写入失败，请检查用户目录权限' };
    return { ok: true, ui: this.get() };
  }
}

module.exports = { UiStore, UI_PREF_DEFAULTS, UI_PREF_ENUMS };
