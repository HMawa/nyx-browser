'use strict';

/**
 * 图形性能策略（清单 A5）。
 *
 * 背景：默认把「光栅化 / 零拷贝 / 放开黑名单」全开之后，双显卡机器上 Chromium 很可能
 * 直接抓着独立显卡跑（实测机器上就是 3050），代价是发热、掉电快、风扇吵——而浏览一个
 * 网页并不需要独显。这里把选择权显式化：
 *
 *   low-power        核显优先（默认）：不请求高性能适配器，并显式请求低功耗适配器
 *   high-performance 独显优先：请求高性能适配器（玩游戏 / 看高码率视频才需要）
 *   auto             跟随系统：不加任何 GPU 偏好开关，由 Windows 图形设置决定
 *
 * 注意（必须诚实告知用户）：`force_low_power_gpu` 在 Windows 上未必被驱动层采纳，
 * 真正决定权在 Windows 的「图形设置 / 显卡控制面板」。所以本模块只负责"发出请求"，
 * 真实生效与否由启动后读回来的适配器信息说到底——取不到就写「未知」，绝不假装成功。
 */

/** 三档策略；`value` 落盘，`label/hint` 直接给界面用 */
const GPU_POLICIES = [
  {
    value: 'low-power',
    label: '节能（核显优先）',
    hint: '默认。不请求高性能显卡，尽量让集显合成画面：更省电、更凉、不抢独显。',
  },
  {
    value: 'high-performance',
    label: '高性能（独显优先）',
    hint: '向系统请求高性能显卡。画面更顺，但耗电、发热与风扇噪音都会上去。',
  },
  {
    value: 'auto',
    label: '跟随系统',
    hint: '不加任何显卡偏好开关，完全交给 Windows 的图形设置决定。',
  },
];

const DEFAULT_GPU_POLICY = 'low-power';

/** 厂商 ID → 可读名字（离线环境没有显卡型号库，只标注厂商标好） */
const GPU_VENDORS = {
  0x8086: 'Intel（多为核显）',
  0x10de: 'NVIDIA（独立显卡）',
  0x1002: 'AMD（核显或独显）',
  0x1022: 'AMD',
  0x1414: 'Microsoft（软件渲染 / 虚拟显卡）',
  0x5143: 'Qualcomm',
  0x13b5: 'ARM',
};

/** 把任意输入收敛成合法策略；非法/缺失一律回默认 */
function normalizeGpuPolicy(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return GPU_POLICIES.some((it) => it.value === text) ? text : DEFAULT_GPU_POLICY;
}

/** 某个策略对应的 Chromium 命令行开关（名字不带前导 `--`，正合 app.commandLine.appendSwitch） */
function gpuSwitches(policy) {
  switch (normalizeGpuPolicy(policy)) {
    case 'low-power':
      // 只请求低功耗，不请求高性能；两者不同时下发，避免自相矛盾
      return ['force_low_power_gpu'];
    case 'high-performance':
      return ['force_high_performance_gpu'];
    default:
      return [];
  }
}

/** 给界面用的一条策略描述 */
function describeGpuPolicy(policy) {
  const value = normalizeGpuPolicy(policy);
  const hit = GPU_POLICIES.find((it) => it.value === value);
  return hit || GPU_POLICIES[0];
}

/** 从 ui-preferences.json 同步读出策略（必须在 app ready 之前调用，所以不走 UiStore 的异步路径） */
function readGpuPolicyFromPrefs(prefs) {
  if (!prefs || typeof prefs !== 'object') return DEFAULT_GPU_POLICY;
  return normalizeGpuPolicy(prefs.gpuPolicy);
}

/**
 * 把 `app.getGPUInfo('basic')` 的结果整理成人能读的结论。
 *
 * 真实返回里 `gpuDevice` 是数组，每项含 `vendorId` / `deviceId` / `active`。
 * 我们不猜型号（离线没有型号库），只给厂商 + 十六进制 ID + 是否 active，
 * 并明确说明"这是 Chromium 眼里的适配器"，避免用户被一句"已启用独显"骗了。
 */
function summarizeGpuInfo(info) {
  const empty = {
    ok: false,
    activeName: '未知',
    activeVendor: '',
    activeDeviceId: '',
    deviceCount: 0,
    devices: [],
    note: '没有读到显卡信息（Chromium 未返回 gpuDevice）',
  };
  const devices = info && Array.isArray(info.gpuDevice) ? info.gpuDevice : [];
  if (!devices.length) return empty;

  const mapped = devices.map((dev) => {
    const vendorId = Number(dev && dev.vendorId) || 0;
    const deviceId = Number(dev && dev.deviceId) || 0;
    const vendor = GPU_VENDORS[vendorId] || `厂商 0x${vendorId.toString(16)}`;
    return {
      vendorId,
      deviceId,
      vendor,
      active: dev && dev.active === true,
      text: `${vendor}｜设备 0x${deviceId.toString(16)}${dev && dev.active === true ? '（当前使用）' : ''}`,
    };
  });

  // 优先取 active 的那张；没有 active 标记时退化为第一张，并如实说明
  const active = mapped.find((it) => it.active) || null;
  const chosen = active || mapped[0];
  return {
    ok: true,
    activeName: chosen.text,
    activeVendor: chosen.vendor,
    activeDeviceId: `0x${chosen.deviceId.toString(16)}`,
    deviceCount: mapped.length,
    devices: mapped,
    activeKnown: !!active,
    note: active
      ? '这是 Chromium 当前实际使用的适配器'
      : 'Chromium 没有标出当前使用哪张，这里显示的是第一张；实际用哪张由系统决定',
  };
}

module.exports = {
  GPU_POLICIES,
  DEFAULT_GPU_POLICY,
  GPU_VENDORS,
  normalizeGpuPolicy,
  gpuSwitches,
  describeGpuPolicy,
  readGpuPolicyFromPrefs,
  summarizeGpuInfo,
};
