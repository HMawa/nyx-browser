'use strict';

/**
 * 权限管理：把「网页要什么就给什么（一律拒绝）」改成按模式分级。
 *
 *   正常模式：常规权限按站点请求弹原生确认，用户可授可拒：
 *             · 仅本次：只写本会话缓存，关掉标签页/重启即失效；
 *             · 始终允许：写入站点设备白名单（permission-whitelist.json），
 *               之后同一来源、同一权限项不再询问，可在设置页撤销。
 *   全隐私模式：除极少数与隐私无关的能力（全屏、剪贴板写入）外一律拒绝，
 *             不弹窗、不询问、也不看白名单——隐私模式下"少一个授权面"比"多一次询问"更重要。
 *
 * 关键实现点：
 *   1) Chromium 的权限有两套回调：请求式（异步、可弹窗）与校验式（同步、不能弹窗）。
 *      同步校验必须直接给答案，所以它只读缓存 + 白名单 + 模式基线；弹窗只发生在请求式回调里。
 *   2) 决策按「分区 + 来源 + 权限」缓存；白名单按「来源 + 设备项」持久化。
 *   3) media 请求按 details.mediaTypes 拆成 camera / microphone，避免一次"允许摄像头"
 *      顺手把麦克风也永久放行。
 *   4) 所有决策都写审计记录（不含任何凭据），供界面与验收脚本查看。
 */

const { dialog, desktopCapturer } = require('electron');
const {
  canonicalKeys,
  normalizeOrigin,
  grantWhitelist,
  revokeWhitelist,
  isWhitelisted,
  listWhitelist,
  summarizeWhitelist,
  DEVICE_LABELS,
} = require('./permission-store');

/** 基线取值 */
const ASK = 'ask';
const ALLOW = 'allow';
const DENY = 'deny';

/** 权限的中文名与风险说明（弹窗文案用） */
const PERMISSION_LABELS = {
  notifications: { title: '发送通知', detail: '网站可在系统通知中心弹出消息' },
  geolocation: { title: '获取你的地理位置', detail: '网站可读取设备定位，会暴露真实所在地区' },
  media: { title: '使用摄像头和麦克风', detail: '网站可拍摄画面、录制声音' },
  audioCapture: { title: '使用麦克风', detail: '网站可录制声音' },
  videoCapture: { title: '使用摄像头', detail: '网站可拍摄画面' },
  displayCapture: { title: '共享屏幕', detail: '网站可看到你的整个屏幕内容' },
  'display-capture': { title: '共享屏幕', detail: '网站可看到你的整个屏幕内容' },
  midi: { title: '使用 MIDI 设备', detail: '网站可访问本机 MIDI 设备' },
  midiSysex: { title: '使用 MIDI 系统独占接口', detail: '风险较高，通常没有必要' },
  clipboardRead: { title: '读取剪贴板', detail: '网站可读取你复制过的内容' },
  'clipboard-read': { title: '读取剪贴板', detail: '网站可读取你复制过的内容' },
  'clipboard-sanitized-write': { title: '写入剪贴板', detail: '网站可向你剪贴板写入内容' },
  pointerLock: { title: '锁定鼠标指针', detail: '常见于网页游戏与 3D 场景' },
  fullscreen: { title: '进入全屏', detail: '网站可全屏显示内容' },
  openExternal: { title: '打开外部应用', detail: '网站可唤起本机已安装的应用' },
  idleDetection: { title: '检测设备空闲状态', detail: '网站可推断你何时离开电脑' },
  'idle-detection': { title: '检测设备空闲状态', detail: '网站可推断你何时离开电脑' },
  hid: { title: '访问 HID 设备', detail: '网站可访问游戏手柄等外设' },
  serial: { title: '访问串口设备', detail: '网站可访问串口硬件' },
  usb: { title: '访问 USB 设备', detail: '网站可访问 USB 硬件' },
  bluetooth: { title: '访问蓝牙设备', detail: '网站可扫描并连接附近蓝牙设备' },
  'window-management': { title: '管理窗口', detail: '网站可查询并摆放你的窗口' },
  'storage-access': { title: '访问站点存储', detail: '跨站点访问该站的 Cookie 与存储' },
  'top-level-storage-access': { title: '访问站点存储', detail: '跨站点访问该站的 Cookie 与存储' },
  fileSystem: { title: '访问本地文件', detail: '网站可读写你选中的本地文件' },
  'file-system-access': { title: '访问本地文件', detail: '网站可读写你选中的本地文件' },
  keyboardLock: { title: '锁定键盘', detail: '全屏时可捕获全部按键' },
  'keyboard-lock': { title: '锁定键盘', detail: '全屏时可捕获全部按键' },
};

/** 正常模式基线：常规能力放行或询问，高风险的询问 */
const NORMAL_BASELINE = {
  notifications: ASK,
  geolocation: ASK,
  media: ASK,
  audioCapture: ASK,
  videoCapture: ASK,
  displayCapture: ASK,
  'display-capture': ASK,
  midi: ASK,
  pointerLock: ASK,
  keyboardLock: ASK,
  'keyboard-lock': ASK,
  hid: ASK,
  serial: ASK,
  usb: ASK,
  bluetooth: ASK,
  'idle-detection': ASK,
  idleDetection: ASK,
  fileSystem: ASK,
  'file-system-access': ASK,
  'top-level-storage-access': ASK,
  // 无隐私含义、且弹窗会打扰使用的，直接放行
  fullscreen: ALLOW,
  'clipboard-sanitized-write': ALLOW,
  openExternal: ASK,
  // 跨站读存储 / 摆布窗口：正常模式也改成询问。
  // 前者等于让别的站点读这一站的 Cookie 与存储，后者能让网页挪动你的窗口；
  // 都不是"打开网页就该给"的能力（安全审计 P2）。
  'storage-access': ASK,
  'window-management': ASK,
  // 风险高且极少有人真心需要，正常模式也给拒绝
  midiSysex: DENY,
};

/** 全隐私模式基线：默认全拒，只留与隐私无关的两项 */
const PRIVATE_BASELINE = {
  fullscreen: ALLOW,
  'clipboard-sanitized-write': ALLOW,
};

/** 默认决策（未列出的权限） */
function baselineFor(mode, permission) {
  const table = mode === 'private' ? PRIVATE_BASELINE : NORMAL_BASELINE;
  if (Object.prototype.hasOwnProperty.call(table, permission)) return table[permission];
  // 未登记的权限：正常模式谨慎询问，隐私模式直接拒绝
  return mode === 'private' ? DENY : ASK;
}

function labelFor(permission) {
  const meta = PERMISSION_LABELS[permission];
  if (meta) return meta;
  if (DEVICE_LABELS[permission]) {
    return {
      title: DEVICE_LABELS[permission],
      detail: permission === 'camera'
        ? '网站可拍摄画面'
        : permission === 'microphone'
          ? '网站可录制声音'
          : '网站可看到你的屏幕内容',
    };
  }
  return { title: `授予「${permission}」权限`, detail: '该权限未在本机登记说明，请自行判断是否信任此站点' };
}

/** 从 URL 里取来源，取不到就回一个可读标识 */
function originOf(rawUrl) {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return String(rawUrl || '未知来源').slice(0, 120);
  }
}

class PermissionManager {
  /**
   * @param {object} [options]
   * @param {() => Electron.BrowserWindow|null} [options.getWindow] 原生弹窗的父窗口
   * @param {(entry:object) => void} [options.log] 审计回调
   * @param {(ctx:object) => Promise<{granted:boolean, scope?:string, remember?:boolean}>} [options.prompt]
   *        弹窗实现，默认走 Electron 原生对话框；测试时可注入替身
   * @param {Array} [options.whitelist] 已持久化的白名单条目
   * @param {(entries:Array) => void} [options.saveWhitelist] 持久化回调（失败要抛错）
   * @param {string} [options.whitelistError] 读取白名单时的错误说明
   */
  constructor({
    getWindow = () => null,
    log = () => {},
    prompt = null,
    whitelist = [],
    saveWhitelist = null,
    whitelistError = '',
  } = {}) {
    this.getWindow = getWindow;
    this.log = log;
    this.customPrompt = typeof prompt === 'function' ? prompt : null;
    /** 决策缓存：`${partition}|${origin}|${permission}` → boolean */
    this.cache = new Map();
    /** 审计轨迹 */
    this.decisions = [];
    this.mode = 'normal';
    /** 已装配的分区，避免重复挂监听 */
    this.attached = new Set();
    /** 展示名映射：partition → 'normal' | 'private' */
    this.partitionMode = new Map();
    /** 站点设备白名单（持久化） */
    this.whitelist = Array.isArray(whitelist) ? whitelist.slice() : [];
    this.saveWhitelist = typeof saveWhitelist === 'function' ? saveWhitelist : null;
    this.whitelistError = String(whitelistError || '');
  }

  /** 切换工作模式：隐私模式下不再弹窗，直接拒绝 */
  setMode(mode) {
    this.mode = mode === 'private' ? 'private' : 'normal';
  }

  /**
   * 给某个 Session 装上权限策略。
   * @param {Electron.Session} ses
   * @param {'normal'|'private'} mode
   */
  attach(ses, mode) {
    const tag = `${ses.storagePath || 'memory'}#${mode}`;
    if (this.attached.has(tag)) return;
    this.attached.add(tag);
    this.partitionMode.set(ses, mode);

    const modeOf = () => this.partitionMode.get(ses) || this.mode;

    // 请求式：唯一可以弹原生确认的入口
    ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const current = modeOf();
      const origin = originOf(
        (details && (details.requestingUrl || details.requestingOrigin)) ||
          (webContents && webContents.getURL && webContents.getURL()) ||
          '',
      );
      const keys = canonicalKeys(permission, details && details.mediaTypes);
      const baseline = baselineFor(current, permission);

      if (baseline === ALLOW) {
        this.record({ mode: current, origin, permission, keys, granted: true, via: 'baseline' });
        callback(true);
        return;
      }
      if (baseline === DENY || current === 'private') {
        this.record({ mode: current, origin, permission, keys, granted: false, via: 'deny-all' });
        callback(false);
        return;
      }

      const cached = this.cachedDecision(ses, origin, permission, keys);
      if (cached !== undefined) {
        this.record({ mode: current, origin, permission, keys, granted: cached, via: 'cache' });
        callback(cached);
        return;
      }

      const normalized = normalizeOrigin(origin);
      if (!normalized) {
        // 没有可持久化的 http(s) 来源：只能弹一次，不写白名单
        this.askUser({ origin, permission, keys, mode: current, allowPersistent: false })
          .then(({ granted, scope }) => {
            this.remember(ses, origin, permission, keys, granted);
            this.record({ mode: current, origin, permission, keys, granted, via: 'prompt', scope });
            callback(granted);
          })
          .catch(() => callback(false));
        return;
      }

      if (isWhitelisted(this.whitelist, normalized, keys)) {
        this.remember(ses, origin, permission, keys, true);
        this.record({ mode: current, origin, permission, keys, granted: true, via: 'whitelist' });
        callback(true);
        return;
      }

      // baseline === ASK：弹原生确认（拒绝 / 仅本次 / 始终允许）
      this.askUser({ origin, permission, keys, mode: current, allowPersistent: true })
        .then(({ granted, scope }) => {
          this.remember(ses, origin, permission, keys, granted);
          let persistError = '';
          if (granted && scope === 'always') {
            const saved = this.addWhitelist(normalized, keys);
            if (!saved.ok) persistError = saved.error;
          }
          this.record({
            mode: current,
            origin,
            permission,
            keys,
            granted,
            via: 'prompt',
            scope,
            ...(persistError ? { persistError } : {}),
          });
          callback(granted);
        })
        .catch(() => callback(false));
    });

    // 校验式：同步回答，不能弹窗；只认缓存、白名单与模式基线。
    //
    // 注意：对"询问类"必须返回 false。返回 true 会让 Chromium 认为已授权，
    // 站点在弹窗前就能通过 enumerateDevices 拿到真实设备名与 deviceId
    // （temp/perm-probe.js 实测）。代价是 Permissions API 会显示 denied，
    // 这是 Electron 无法表达 prompt 的已知限制，不能为了好看而泄露设备清单。
    ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
      const current = modeOf();
      const origin = originOf(requestingOrigin);
      // Chromium 对 permissions.query / 设备枚举常常只给 "media"，
      // 具体是摄像头还是麦克风在 details.mediaType 里；不看它会一次放行两种设备。
      const mediaType = details && (details.mediaType === 'video' || details.mediaType === 'audio')
        ? [details.mediaType]
        : undefined;
      const keys = canonicalKeys(permission, mediaType);
      if (current === 'private') {
        return baselineFor(current, permission) === ALLOW;
      }
      const cached = this.cachedDecision(ses, origin, permission, keys);
      if (cached !== undefined) return cached;
      const baseline = baselineFor(current, permission);
      if (baseline === ALLOW) return true;
      if (baseline === DENY) return false;
      const normalized = normalizeOrigin(origin);
      if (normalized && isWhitelisted(this.whitelist, normalized, keys)) return true;
      // 询问类：请求式回调会弹窗并把结果写进缓存，校验式这里先给"否"
      return false;
    });

    // 屏幕共享：正常模式弹窗后由用户选择，隐私模式一律拒绝。
    // 屏幕共享刻意不写白名单、不支持"始终允许"——静默共享整块主屏的风险太高。
    if (typeof ses.setDisplayMediaRequestHandler === 'function') {
      ses.setDisplayMediaRequestHandler(
        async (request, callback) => {
          const current = modeOf();
          const origin = originOf(request && request.securityOrigin);
          if (current === 'private') {
            this.record({ mode: current, origin, permission: 'displayCapture', keys: ['screen'], granted: false, via: 'deny-all' });
            callback(null);
            return;
          }

          const cached = this.cache.get(this.keyOf(ses, origin, 'displayCapture'));
          let granted = cached;
          let scope = 'once';
          if (granted === undefined) {
            const answer = await this.askUser({
              origin,
              permission: 'displayCapture',
              keys: ['screen'],
              mode: current,
              allowPersistent: false,
            });
            granted = answer.granted;
            scope = answer.granted ? 'once' : 'deny';
            this.remember(ses, origin, 'displayCapture', ['screen'], granted);
          }
          this.record({ mode: current, origin, permission: 'displayCapture', keys: ['screen'], granted, via: 'display-media', scope });
          if (!granted) {
            callback(null);
            return;
          }
          try {
            const sources = await desktopCapturer.getSources({ types: ['screen'] });
            const primary = sources[0];
            if (!primary) {
              callback(null);
              return;
            }
            callback({ video: primary, audio: 'loopback' });
          } catch {
            callback(null);
          }
        },
        { useSystemPicker: true },
      );
    }

    // HID / USB / 串口等设备级授权
    if (typeof ses.setDevicePermissionHandler === 'function') {
      ses.setDevicePermissionHandler((details) => {
        const current = modeOf();
        const permission = String((details && details.deviceType) || 'usb');
        const origin = originOf(details && details.origin);
        if (current === 'private') {
          this.record({ mode: current, origin, permission, granted: false, via: 'deny-all' });
          return false;
        }
        const normalized = normalizeOrigin(origin);
        if (normalized && isWhitelisted(this.whitelist, normalized, canonicalKeys(permission))) {
          return true;
        }
        const cached = this.cache.get(this.keyOf(ses, origin, permission));
        return cached === true;
      });
    }
  }

  /** 缓存键 */
  keyOf(ses, origin, permission) {
    const part = ses && ses.storagePath ? ses.storagePath : 'memory';
    return `${part}|${origin}|${permission}`;
  }

  /** 从缓存里读一次决策：按设备项读；media 的原始名会混淆摄像头与麦克风，不能当整包结果 */
  cachedDecision(ses, origin, permission, keys) {
    // media 一次请求可能只带 video，若把 |media| 当成整包授权，
    // 下一次要麦克风时就会连问都不问直接放行。所以 media 只认拆分后的设备项。
    const split = permission === 'media';
    const raw = split ? undefined : this.cache.get(this.keyOf(ses, origin, permission));
    if (raw !== undefined) return raw;
    if (!keys.length) return undefined;
    let allTrue = true;
    for (const key of keys) {
      const value = this.cache.get(this.keyOf(ses, origin, key));
      if (value === false) return false;
      if (value !== true) allTrue = false;
    }
    return allTrue ? true : undefined;
  }

  /** 把一次决策写进本会话缓存（拆分后的设备项；media 不写原始名，避免跨设备连带） */
  remember(ses, origin, permission, keys, granted) {
    if (permission !== 'media') this.cache.set(this.keyOf(ses, origin, permission), granted);
    for (const key of keys) this.cache.set(this.keyOf(ses, origin, key), granted);
  }

  /**
   * 弹原生确认；返回 {granted, scope}。
   * scope：'deny' | 'once' | 'always'；屏幕共享等不允许持久的场景强制降级为 once。
   */
  async askUser({ origin, permission, keys, mode, allowPersistent = true }) {
    const list = Array.isArray(keys) && keys.length ? keys : [permission];
    const titles = Array.from(new Set(list.map((key) => labelFor(key).title)));
    const title = titles.join('和');
    const detail = list
      .map((key) => {
        const meta = labelFor(key);
        return `${DEVICE_LABELS[key] || meta.title}：${meta.detail}`;
      })
      .join('\n');

    const payload = {
      origin,
      permission,
      keys: list.slice(),
      mode,
      title,
      detail,
      allowPersistent: Boolean(allowPersistent),
    };

    if (this.customPrompt) {
      const answer = await this.customPrompt(payload);
      const granted = Boolean(answer && answer.granted);
      let scope = answer && answer.scope;
      if (!['deny', 'once', 'always'].includes(scope)) {
        scope = granted ? (answer && answer.remember ? 'always' : 'once') : 'deny';
      }
      if (scope === 'always' && !allowPersistent) scope = 'once';
      return { granted, scope };
    }

    const parent = this.getWindow();
    const buttons = allowPersistent ? ['拒绝', '仅本次', '始终允许'] : ['拒绝', '仅本次'];
    const options = {
      type: 'question',
      buttons,
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: '权限请求',
      message: `${origin} 请求：${title}`,
      detail: [
        detail,
        '',
        `模式：${mode === 'private' ? '全隐私模式' : '正常模式'}`,
        `来源：${origin}`,
        '',
        allowPersistent
          ? '「仅本次」：关掉标签页或重启浏览器后失效。\n「始终允许」：写入站点设备白名单，同一来源、同一设备不再询问；可在 设置 → 隐私与安全 里撤销。'
          : '「仅本次」：只对这次请求有效。',
        '隐私模式下这些权限一律拒绝，不会询问。',
      ].join('\n'),
    };

    const result = parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);

    const response = Number(result.response);
    const granted = response === 1 || response === 2;
    const scope = response === 2 ? 'always' : response === 1 ? 'once' : 'deny';
    return { granted, scope };
  }

  /** 写审计记录（不记录任何页面内容与凭据） */
  record(entry) {
    const item = { at: Date.now(), ...entry };
    this.decisions.push(item);
    if (this.decisions.length > 500) this.decisions.shift();
    try {
      this.log(item);
    } catch {
      /* 审计失败不影响主流程 */
    }
    return item;
  }

  /** 决策清单（供界面与验收脚本查看） */
  list(limit = 50) {
    return this.decisions.slice(-limit).reverse();
  }

  /** 清空本会话内记住的授权（不碰白名单） */
  clearCache() {
    this.cache.clear();
    return { ok: true, cleared: true };
  }

  /** 当前持久化白名单（界面只读视图） */
  whitelistEntries() {
    return listWhitelist(this.whitelist);
  }

  /** 写入白名单并持久化；保存失败时白名单仍在内存里生效，但必须让界面看见错误 */
  addWhitelist(origin, keys) {
    const normalized = normalizeOrigin(origin);
    if (!normalized) return { ok: false, error: '来源不是 http(s)，不能写入白名单' };
    this.whitelist = grantWhitelist(this.whitelist, normalized, keys);
    const saved = this.persistWhitelist();
    return saved.ok ? { ok: true, entries: this.whitelistEntries() } : saved;
  }

  /** 撤销某来源的某个权限；不传 key 表示撤销整个来源。撤销后本会话缓存也一起失效 */
  revokeWhitelist(origin, key) {
    const normalized = normalizeOrigin(origin);
    if (!normalized) return { ok: false, error: '来源不合法' };
    this.whitelist = revokeWhitelist(this.whitelist, normalized, key);
    // 只清这个来源的会话缓存：撤销必须立刻生效，否则同一会话里"撤销了还在放行"
    for (const cacheKey of Array.from(this.cache.keys())) {
      if (cacheKey.includes(`|${normalized}|`)) this.cache.delete(cacheKey);
    }
    const saved = this.persistWhitelist();
    return saved.ok ? { ok: true, entries: this.whitelistEntries() } : saved;
  }

  /** 清空白名单（会话缓存一并清空，避免"名单清了但这次会话还在放行"） */
  clearWhitelist() {
    this.whitelist = [];
    this.cache.clear();
    const saved = this.persistWhitelist();
    return saved.ok ? { ok: true, entries: [] } : saved;
  }

  /** 持久化；失败时记下错误并把错误返回给调用方 */
  persistWhitelist() {
    if (!this.saveWhitelist) return { ok: true };
    try {
      this.saveWhitelist(this.whitelist);
      this.whitelistError = '';
      return { ok: true };
    } catch (err) {
      this.whitelistError = err && err.message ? err.message : String(err);
      return { ok: false, error: this.whitelistError };
    }
  }

  /** 概要：按模式统计"记住的授权"数量与白名单规模 */
  summary() {
    let allow = 0;
    let deny = 0;
    for (const value of this.cache.values()) {
      if (value) allow += 1;
      else deny += 1;
    }
    const white = summarizeWhitelist(this.whitelist);
    return {
      rememberedAllow: allow,
      rememberedDeny: deny,
      decisions: this.decisions.length,
      cacheSize: this.cache.size,
      whitelistSites: white.sites,
      whitelistKinds: white.kinds,
    };
  }
}

module.exports = {
  PermissionManager,
  PERMISSION_LABELS,
  NORMAL_BASELINE,
  PRIVATE_BASELINE,
  baselineFor,
  originOf,
};
