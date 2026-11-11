'use strict';

/**
 * Nyx —— 硬件能力探测（GPU 加速 + NPU 本地 AI）
 *
 * 职责：
 *   1. GPU：读取 Chromium GPU 特性状态与设备信息，供设置中心展示
 *      "硬件加速"是否生效（合成 / WebGL / 光栅化 / 视频解码）；
 *   2. NPU：用 PowerShell 枚举 ComputeAccelerator 设备类（NPU 统一注册
 *      在该类下，如 Intel AI Boost、AMD Ryzen AI、高通 Hexagon），
 *      并回退检查 CPU 名称，识别"神经处理单元"是否可用；
 *   3. 纯只读探测，不修改任何系统设置；探测失败时如实返回 unavailable。
 */

const { app } = require('electron');
const { execFile } = require('node:child_process');

/** PowerShell 探测 NPU：优先设备类，回退 CPU 名称匹配 */
function probeNpu() {
  return new Promise((resolve) => {
    const ps = [
      "$ErrorActionPreference='SilentlyContinue'",
      // 1) 计算加速器类（NPU 设备统一入口）
      '$np=@(Get-PnpDevice -Class ComputeAccelerator -PresentOnly | Select-Object -ExpandProperty FriendlyName)',
      // 2) 回退：Intel Core Ultra 的 AI Boost / AMD Ryzen AI 可能走 CPU 侧
      '$cpu=(Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)',
      'if($np.Count -gt 0){ $np -join "|" } elseif($cpu -match "AI Boost|Ryzen AI|NPU|Neural"){ "CPU-NPU:" + $cpu } else { "" }',
    ].join('; ');

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 15000, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return resolve(null);
        const line = String(stdout || '').trim();
        if (!line) return resolve(null);
        const parts = line.split('|').map((s) => s.trim()).filter(Boolean);
        resolve(parts.length ? parts : null);
      },
    );
  });
}

/** PowerShell 兜底：Chromium basic 信息取不到显卡名时，用 WMI 补设备名与驱动版本 */
function probeGpuDevice() {
  return new Promise((resolve) => {
    const ps = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$virtual = 'OrayIddDriver|IddDriver|Mirror|Virtual|Remote|Basic Display|Microsoft 基本显示|RDP|Indirect Display'",
      'Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.Name -and $_.Name -notmatch $virtual } | ForEach-Object { $_.Name + "||" + $_.DriverVersion } | Select-Object -First 1',
    ].join('; ');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 12000, encoding: 'utf8' }, (err, stdout) => {
      if (err) return resolve(null);
      const line = String(stdout || '').trim();
      if (!line) return resolve(null);
      const idx = line.indexOf('||');
      if (idx <= 0) return resolve(null);
      resolve({ device: line.slice(0, idx), driver: line.slice(idx + 2) || '' });
    });
  });
}

/** GPU 特性中文名映射（app.getGPUFeatureStatus 返回的 key → 中文文案） */
const GPU_FEATURE_LABELS = {
  '2d_canvas': '2D 画布',
  gpu_compositing: 'GPU 合成',
  webgl: 'WebGL',
  webgl2: 'WebGL2',
  rasterization: '光栅化',
  video_decode: '视频解码',
  video_encode: '视频编码',
  'gpu_rasterization': 'GPU 光栅化',
  'multiple_raster_threads': '多线程光栅化',
};

/** 组装硬件状态快照（只读） */
async function getHardwareStatus() {
  const out = {
    ok: true,
    gpu: { available: false, device: '', vendor: '', driverVersion: '', features: {}, accelerated: false },
    npu: { available: false, devices: [], note: '' },
  };

  try {
    const info = await app.getGPUInfo('basic');
    const dev = info && info.gpuDevice && info.gpuDevice[0];
    if (dev && dev.deviceName) {
      out.gpu.available = true;
      out.gpu.device = dev.deviceName;
      out.gpu.vendor = dev.vendorId ? `0x${dev.vendorId.toString(16).toUpperCase()}` : '';
      out.gpu.driverVersion = dev.driverVersion || '';
    } else {
      // basic 模式偶尔取不到设备名（驱动信息在别的字段），用 WMI 兜底
      const wmi = await probeGpuDevice();
      if (wmi) {
        out.gpu.available = true;
        out.gpu.device = wmi.device;
        out.gpu.driverVersion = wmi.driver;
      }
    }
  } catch (err) {
    out.gpu.note = `GPU 信息读取失败：${err.message}`;
  }

  try {
    const features = app.getGPUFeatureStatus();
    if (features && typeof features === 'object') {
      for (const key of Object.keys(features)) {
        const label = GPU_FEATURE_LABELS[key];
        if (!label) continue;
        const value = features[key];
        out.gpu.features[label] =
          value === 'enabled' || value === 'accelerated' || value === 'enabled_force';
      }
      out.gpu.accelerated =
        out.gpu.features['GPU 合成'] || out.gpu.features['WebGL'] || out.gpu.features['视频解码'];
    }
  } catch (err) {
    // 特性状态拿不到不阻塞整体返回
  }

  const npuDevices = await probeNpu();
  if (npuDevices && npuDevices.length) {
    out.npu.available = true;
    out.npu.devices = npuDevices;
    out.npu.note =
      '检测到本地神经处理单元。当前版本浏览器内核暂未开放 WebNN 接口，后续版本将把 AI 能力（翻译 / 摘要 / 填表）落到 NPU 侧执行，本机数据不出设备。';
  }

  return out;
}

module.exports = { getHardwareStatus, probeNpu };
