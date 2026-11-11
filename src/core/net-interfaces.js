/**
 * 本机出站网卡枚举与校验。
 *
 * 「手动选择网卡上网」的实际落点是：把所选网卡名写进内核配置的 `interface-name`，
 * 内核后续所有出站连接（含 DNS 解析）都从该网卡发出；不写则跟随系统默认路由。
 *
 * 本模块只做两件事：列出可选网卡、校验所选网卡是否仍在位。
 * 不读也不改任何系统网络设置，不申请任何提权。
 *
 * 数据来源：
 *   1) os.networkInterfaces()——适配器名、IPv4、MAC（零外部命令，跨平台）；
 *   2) PowerShell Get-NetRoute——系统默认出口网卡（仅 Windows，失败即降级为空）。
 * 二者按适配器名对齐；该名称与内核 `interface-name` 接受的名称一致（实测可用）。
 */

const { execFile } = require('node:child_process');
const os = require('node:os');

/**
 * 虚拟 / 隧道类适配器的命名特征。
 * 这类网卡照样可以指定（例如刻意走 Tailscale 出口），所以只标注不隐藏，
 * 由界面折叠分组展示，避免用户误把虚拟交换当成物理网卡。
 */
const VIRTUAL_PATTERNS = [
  /vEthernet/i,
  /Hyper-V/i,
  /Tailscale/i,
  /ZeroTier/i,
  /WireGuard/i,
  /OpenVPN/i,
  /TAP-/i,
  /Wintun/i,
  /Radmin/i,
  /Npcap/i,
  /Loopback/i,
  /Bluetooth/i,
  /Virtual/i,
  /VPN/i,
];

/** PowerShell 查询超时：一条默认路由查询正常在几百毫秒内返回 */
const PS_TIMEOUT_MS = 6000;

/** 判断适配器名是否像虚拟网卡 */
function looksVirtual(name) {
  const text = String(name || '');
  return VIRTUAL_PATTERNS.some((re) => re.test(text));
}

/** 判断地址项是否 IPv4（family 在不同 Node 版本可能是 4 或 'IPv4'） */
function isIPv4(addr) {
  return Boolean(addr) && (addr.family === 4 || addr.family === 'IPv4');
}

/**
 * 查询系统默认出口网卡名。
 *
 * Windows 下取路由度量最小的默认路由所绑的接口名；查询失败（非 Windows、
 * 无权限、命令被拦截）一律返回空串，界面据此回落到"由系统决定"的表述。
 *
 * @returns {Promise<string>}
 */
function defaultInterfaceName() {
  if (process.platform !== 'win32') return Promise.resolve('');

  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$routes = Get-NetRoute -DestinationPrefix "0.0.0.0/0" | Sort-Object RouteMetric, InterfaceMetric',
    '$best = $routes | Select-Object -First 1',
    'if ($best) { (Get-NetAdapter -InterfaceIndex $best.InterfaceIndex).Name }',
  ].join('; ');

  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: PS_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        if (err) {
          resolve('');
          return;
        }
        const first = String(stdout || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)[0];
        resolve(first || '');
      },
    );
  });
}

/**
 * 列出本机可用于出站绑定的网卡。
 *
 * 只保留"已启用且有非回环 IPv4"的适配器：没有地址的网卡给不了出口，
 * 列出来只会让用户选了之后踩 `interface not found`。
 *
 * @returns {Promise<{ok:boolean, items:Array<object>, defaultName:string, error?:string}>}
 */
async function listInterfaces() {
  let raw;
  try {
    raw = os.networkInterfaces();
  } catch (err) {
    return { ok: false, items: [], defaultName: '', error: `读取网卡列表失败：${err.message}` };
  }

  const defaultName = await defaultInterfaceName();
  const items = [];

  for (const [name, addrs] of Object.entries(raw)) {
    const v4 = Array.isArray(addrs) ? addrs.filter(isIPv4) : [];
    const usable = v4.find((addr) => !addr.internal);
    if (!usable) continue;

    items.push({
      name,
      ipv4: usable.address || '',
      netmask: usable.netmask || '',
      mac: typeof usable.mac === 'string' ? usable.mac.toUpperCase() : '',
      virtual: looksVirtual(name),
      isDefault: Boolean(defaultName) && name === defaultName,
    });
  }

  // 默认出口优先，物理网卡优先，最后按名称排序，保证下拉框顺序稳定可预期
  items.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    if (a.virtual !== b.virtual) return a.virtual ? 1 : -1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });

  return { ok: true, items, defaultName };
}

/**
 * 校验网卡名是否仍然在位（写配置前的把关）。
 *
 * 内核的行为是"非法网卡名不阻断启动"：名字不存在时进程照样起来，只在真实拨号
 * 时报 `interface not found`（连 DNS 都解析不了）。所以必须在写配置前自己确认。
 *
 * @param {string} name
 * @returns {Promise<{ok:boolean, item?:object, error?:string}>}
 */
async function findInterface(name) {
  const target = String(name || '').trim();
  if (!target) return { ok: false, error: '未指定网卡' };

  const listed = await listInterfaces();
  if (!listed.ok) return { ok: false, error: listed.error };

  const hit = listed.items.find((item) => item.name === target);
  if (!hit) return { ok: false, error: `未找到可用网卡「${target}」，请刷新列表后重选` };
  return { ok: true, item: hit };
}

module.exports = { listInterfaces, findInterface, defaultInterfaceName, looksVirtual };
