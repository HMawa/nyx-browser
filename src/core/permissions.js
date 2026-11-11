'use strict';

/**
 * 权限管理：把「网页要什么就给什么（一律拒绝）」改成按模式分级。
 *
 *   正常模式：常规权限按站点请求弹原生确认，用户可授可拒，并可选"记住本会话选择"。
 *   全隐私模式：除极少数与隐私无关的能力（全屏、剪贴板写入）外一律拒绝，
 *             不弹窗、不询问——隐私模式下"少一个授权面"比"多一次询问"更重要。
 *
 * 关键实现点：
 *   1) Chromium 的权限有两套回调：请求式（异步、可弹窗）与校验式（同步、不能弹窗）。
 *      同步校验必须直接给答案，所以它只读缓存 + 模式基线；弹窗只发生在请求式回调里。
 *   2) 决策按「分区 + 来源 + 权限」缓存，避免同一站点反复弹窗。
 *   3) 所有决策都写审计记录（不含任何凭据），供界面与验收脚本查看。
 */

const { dialog, desktopCapturer } = require('electron');

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
  'storage-access': ALLOW,
  openExternal: ASK,
  // 风险高且极少有人真心需要，正常模式也给拒绝
  midiSysex: DENY,
  'window-management': ALLOW,
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
   * @param {(ctx:object) => Promise<{granted:boolean, remember?:boolean}>} [options.prompt]
   *        弹窗实现，默认走 Electron 原生对话框；测试时可注入替身
   */
  constructor({ getWindow = () => null, log = () => {}, prompt = null } = {}) {
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

      const cached = this.cache.get(this.keyOf(ses, origin, permission));
      if (cached !== undefined) {
        this.record({ mode: current, origin, permission, granted: cached, via: 'cache' });
        callback(cached);
        return;
      }

      const baseline = baselineFor(current, permission);
      if (baseline === DENY || current === 'private') {
        const granted = baseline === ALLOW;
        this.record({ mode: current, origin, permission, granted, via: granted ? 'baseline' : 'deny-all' });
        callback(granted);
        return;
      }
      if (baseline === ALLOW) {
        this.record({ mode: current, origin, permission, granted: true, via: 'baseline' });
        callback(true);
        return;
      }

      // baseline === ASK：弹原生确认
      this.askUser({ origin, permission, mode: current })
        .then(({ granted, remember }) => {
          if (remember) this.cache.set(this.keyOf(ses, origin, permission), granted);
          this.record({
            mode: current,
            origin,
            permission,
            granted,
            via: 'prompt',
            remember: Boolean(remember),
          });
          callback(granted);
        })
        .catch(() => callback(false));
    });

    // 校验式：同步回答，不能弹窗；只认缓存与模式基线
    ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
      const current = modeOf();
      const origin = originOf(requestingOrigin);
      const cached = this.cache.get(this.keyOf(ses, origin, permission));
      if (cached !== undefined) return cached;
      const baseline = baselineFor(current, permission);
      if (baseline === ALLOW) return true;
      if (baseline === DENY || current === 'private') return false;
      // 询问类：请求式回调会弹窗并把结果写进缓存，校验式这里先给"否"
      return false;
    });

    // 屏幕共享：正常模式弹窗后由用户选择，隐私模式一律拒绝
    if (typeof ses.setDisplayMediaRequestHandler === 'function') {
      ses.setDisplayMediaRequestHandler(
        async (request, callback) => {
          const current = modeOf();
          const origin = originOf(request && request.securityOrigin);
          if (current === 'private') {
            this.record({ mode: current, origin, permission: 'displayCapture', granted: false, via: 'deny-all' });
            callback(null);
            return;
          }

          const cached = this.cache.get(this.keyOf(ses, origin, 'displayCapture'));
          let granted = cached;
          if (granted === undefined) {
            const answer = await this.askUser({ origin, permission: 'displayCapture', mode: current });
            granted = answer.granted;
            if (answer.remember) this.cache.set(this.keyOf(ses, origin, 'displayCapture'), granted);
          }
          this.record({ mode: current, origin, permission: 'displayCapture', granted, via: 'display-media' });
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

  /** 弹原生确认；返回 {granted, remember} */
  async askUser({ origin, permission, mode }) {
    const meta = labelFor(permission);
    const payload = { origin, permission, mode, title: meta.title, detail: meta.detail };

    if (this.customPrompt) return this.customPrompt(payload);

    const parent = this.getWindow();
    const options = {
      type: 'question',
      buttons: ['允许', '拒绝'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: '权限请求',
      message: `${origin} 请求：${meta.title}`,
      detail: `${meta.detail}\n\n模式：${mode === 'private' ? '全隐私模式' : '正常模式'}\n来源：${origin}`,
      checkboxLabel: '记住该选择（本会话内不再询问）',
      checkboxChecked: true,
    };

    const result = parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);

    return { granted: result.response === 0, remember: Boolean(result.checkboxChecked) };
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

  /** 清空本会话内记住的授权 */
  clearCache() {
    this.cache.clear();
    return { ok: true, cleared: true };
  }

  /** 概要：按模式统计"记住的授权"数量 */
  summary() {
    let allow = 0;
    let deny = 0;
    for (const value of this.cache.values()) {
      if (value) allow += 1;
      else deny += 1;
    }
    return { rememberedAllow: allow, rememberedDeny: deny, decisions: this.decisions.length, cacheSize: this.cache.size };
  }
}

module.exports = { PermissionManager, PERMISSION_LABELS, NORMAL_BASELINE, PRIVATE_BASELINE, baselineFor, originOf };
