'use strict';

/**
 * 内置代理内核（mihomo / Clash Meta）生命周期管理。
 *
 * 设计要点：
 *   - 只服务本机浏览器：绑 127.0.0.1 由 proxy-config.sanitize 保证；
 *   - 端口独占：混合端口与控制端口启动时动态探测，避开本机既有 Clash 客户端；
 *   - 控制接口全程 secret 鉴权；
 *   - 启动前先 `-t` 校验配置，坏配置不上线；
 *   - 退出即杀，不留后台进程（配合 main.js 的 before-quit）；
 *   - 内核 stdout/stderr 只进内存环形缓冲，不落盘，避免额外本地痕迹。
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { EventEmitter } = require('events');

const { sanitizeDetailed } = require('./proxy-config');

/** 首选端口：刻意避开 Clash Verge 的 7897 / 9090，降低同机冲突概率 */
const PREFERRED_MIXED_PORT = 7899;
const PREFERRED_CONTROLLER_PORT = 9099;

/** 内存日志缓冲上限（行） */
const LOG_BUFFER_MAX = 200;

/** 内核意外退出后的自动重启上限 */
const MAX_AUTO_RESTART = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 把内核 `-t` 的输出压成一行可读错误：优先取 level=error 那行，并剥掉尾部的
 * "configuration file ... test failed"，免得长路径把真正的原因挤出提示框。
 * @param {string} output
 * @returns {string}
 */
function summarizeVerifyOutput(output) {
  const lines = String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const errLine = lines.find((line) => line.includes('level=error')) || lines[0] || '内核未给出原因';
  return errLine
    .replace(/\s*configuration file[\s\S]*$/i, '')
    .replace(/\s+test failed\s*$/i, '')
    .trim();
}

/** 探测回环端口是否空闲 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/** 取一个可用端口：优先 preferred，被占用则依次后移，最后交给系统分配 */
async function pickPort(preferred, tries = 40) {
  for (let port = preferred; port < preferred + tries; port += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(port)) return port;
  }
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

class ProxyKernel extends EventEmitter {
  /**
   * @param {{binPath:string, runtimeDir:string}} opts
   */
  constructor({ binPath, runtimeDir }) {
    super();
    this.binPath = binPath;
    this.runtimeDir = runtimeDir;
    this.configPath = path.join(runtimeDir, 'config.yaml');
    // GeoIP/GeoSite 数据随包预置在内核程序同级的 geo 目录，启动前同步到工作目录
    this.geoDir = path.join(path.dirname(binPath), 'geo');

    this.child = null;
    this.mixedPort = null;
    this.controllerPort = null;
    this.secret = crypto.randomBytes(24).toString('hex');
    this.lastError = null;
    this.autoRestarts = 0;
    this.stopping = false;
    this.logs = [];
    this.sourceConfig = null;
    this.startedAt = null;
    /** 最近一次配置净化的过滤报告（广告节点识别结果），供界面展示 */
    this.lastFilter = null;
    /**
     * 手动绑定的出站网卡名；空串表示不写 interface-name，跟随系统默认路由。
     * 网卡名只在生成配置那一刻写入，改动后必须重建内核才会真正换出口。
     */
    this.interfaceName = '';
  }

  get running() {
    return Boolean(this.child && this.child.exitCode === null);
  }

  /** 供界面展示的内核状态快照（不含订阅内容与节点凭据） */
  getState() {
    return {
      running: this.running,
      mixedPort: this.mixedPort,
      controllerPort: this.controllerPort,
      startedAt: this.startedAt,
      lastError: this.lastError,
      autoRestarts: this.autoRestarts,
      filter: this.lastFilter,
      logs: this.logs.slice(-60),
    };
  }

  /**
   * 指定出站网卡（空值 = 跟随系统默认路由）。
   *
   * 这里只记参数、不碰内核进程：网卡名是在净化配置时写进 interface-name 的，
   * 想让新网卡真正生效必须重建内核，由 ProxyService 统一编排。
   * @param {string} name 网卡名（如「以太网 4」）；空串表示清除绑定
   * @returns {string} 记下的网卡名
   */
  setOutboundInterface(name) {
    this.interfaceName = String(name || '').trim();
    return this.interfaceName;
  }

  _recordLog(stream, chunk) {
    const text = String(chunk).trimEnd();
    if (!text) return;
    this.logs.push({ at: Date.now(), stream, text });
    if (this.logs.length > LOG_BUFFER_MAX) this.logs.splice(0, this.logs.length - LOG_BUFFER_MAX);
    this.emit('log', { stream, text });
  }

  /**
   * 用内核自身校验配置，避免带着坏配置启动。
   * @param {string} configPath
   */
  verifyConfig(configPath) {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.binPath, ['-t', '-d', this.runtimeDir, '-f', configPath], {
        cwd: this.runtimeDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      proc.stdout.on('data', (chunk) => {
        output += chunk.toString();
      });
      proc.stderr.on('data', (chunk) => {
        output += chunk.toString();
      });

      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
        reject(new Error('内核配置校验超时'));
      }, 20000);

      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(output.trim());
        else reject(new Error(`内核配置校验未通过：${summarizeVerifyOutput(output)}`));
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`无法执行内核程序：${err.message}`));
      });
    });
  }

  /**
   * 预检订阅配置：净化 → 落临时校验文件 → 内核 `-t` 校验。
   *
   * 全程不碰 this.configPath、不碰在跑的内核进程，用途是「换源/刷新前先确认新配置
   * 可用」：校验不过就直接返回失败，原有内核继续服务，不会因为一次坏订阅把浏览器
   * 的代理整体停掉。
   *
   * @param {string} rawConfig 订阅原文
   * @returns {Promise<{ok:boolean, mixedPort?:number, controllerPort?:number,
   *   report?:object, text?:string, error?:string}>}
   */
  async precheck(rawConfig) {
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    // 预检用的临时目录同样需要 geo 数据：缺文件时内核会去联网下载，慢则十几秒、
    // 断网则直接失败，会把一份本来合法的配置误判成"校验不过"。
    this._ensureGeoData();

    const mixedPort = await pickPort(PREFERRED_MIXED_PORT);
    const controllerPort = await pickPort(PREFERRED_CONTROLLER_PORT);
    const report = sanitizeDetailed(rawConfig, {
      mixedPort,
      controllerPort,
      secret: this.secret,
      interfaceName: this.interfaceName,
    });

    const probePath = `${this.configPath}.precheck`;
    fs.writeFileSync(probePath, report.text, 'utf8');

    try {
      await this.verifyConfig(probePath);
      return { ok: true, mixedPort, controllerPort, report, text: report.text };
    } catch (err) {
      return { ok: false, error: err.message, report, text: report.text };
    } finally {
      try {
        fs.unlinkSync(probePath);
      } catch {
        /* 临时校验文件不存在或已被清理，忽略 */
      }
    }
  }

  /**
   * 启动内核。
   * @param {string} rawConfig 订阅原文
   * @param {{prepared?:object}} [opts] prepared 为 precheck() 的成功结果，复用其端口与净化产物
   */
  async start(rawConfig, { prepared = null } = {}) {
    if (this.running) return this.getState();

    this.sourceConfig = rawConfig;
    this.stopping = false;
    this.lastError = null;

    fs.mkdirSync(this.runtimeDir, { recursive: true });
    this._ensureGeoData();

    let report;
    if (prepared && prepared.ok && prepared.report) {
      this.mixedPort = prepared.mixedPort;
      this.controllerPort = prepared.controllerPort;
      report = prepared.report;
    } else {
      this.mixedPort = await pickPort(PREFERRED_MIXED_PORT);
      this.controllerPort = await pickPort(PREFERRED_CONTROLLER_PORT);
      report = sanitizeDetailed(rawConfig, {
        mixedPort: this.mixedPort,
        controllerPort: this.controllerPort,
        secret: this.secret,
        interfaceName: this.interfaceName,
      });
    }
    this.lastFilter = {
      at: Date.now(),
      filtered: report.filtered,
      groupRefs: report.groupRefs,
      stats: report.filterStats,
      warnings: report.warnings,
      dnsHardened: report.dnsHardened,
    };
    fs.writeFileSync(this.configPath, report.text, 'utf8');

    await this.verifyConfig(this.configPath);
    await this._spawn();
    await this._waitReady();

    this.startedAt = Date.now();
    this.emit('started', this.getState());
    return this.getState();
  }

  /**
   * 预置 GeoIP / GeoSite 数据。
   *
   * mihomo 首次加载 GEOIP 规则时会自行从 GitHub 下载 geoip.metadb，而该站在本机
   * 网络下不可达（实测连接被重置），内核会因 geo 数据缺失直接起不来。因此把数据
   * 随包预置在 vendor/mihomo/geo，启动前同步到内核工作目录；文件已存在即不再联网。
   */
  _ensureGeoData() {
    if (!this.geoDir || !fs.existsSync(this.geoDir)) return;

    for (const name of fs.readdirSync(this.geoDir)) {
      try {
        const src = path.join(this.geoDir, name);
        const dst = path.join(this.runtimeDir, name);
        if (!fs.statSync(src).isFile()) continue;
        if (fs.existsSync(dst) && fs.statSync(dst).size === fs.statSync(src).size) continue;
        fs.copyFileSync(src, dst);
      } catch {
        // 单文件失败不阻断启动，交给内核自身的配置校验报错
      }
    }
  }

  async _spawn() {
    const child = spawn(this.binPath, ['-d', this.runtimeDir, '-f', this.configPath], {
      cwd: this.runtimeDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk) => this._recordLog('stdout', chunk));
    child.stderr.on('data', (chunk) => this._recordLog('stderr', chunk));

    child.on('exit', (code, signal) => {
      const wasRunning = this.child === child;
      if (wasRunning) this.child = null;
      this.emit('exit', { code, signal });

      if (this.stopping || !wasRunning) return;

      // 非主动停止：尝试自动拉起，避免浏览器在用而内核悄悄掉线
      if (this.autoRestarts < MAX_AUTO_RESTART && this.sourceConfig) {
        this.autoRestarts += 1;
        this.lastError = `内核异常退出（code=${code}），正在自动重启（第 ${this.autoRestarts} 次）`;
        this.emit('error', new Error(this.lastError));
        setTimeout(() => {
          this.start(this.sourceConfig).catch((err) => {
            this.lastError = `自动重启失败：${err.message}`;
            this.emit('error', err);
          });
        }, 800);
      } else {
        this.lastError = `内核已停止（code=${code}），自动重启次数已达上限`;
        this.emit('error', new Error(this.lastError));
      }
    });

    child.on('error', (err) => {
      this.lastError = `内核启动失败：${err.message}`;
      this.emit('error', err);
    });

    this.child = child;
  }

  /** 轮询内核控制接口，直到其真正就绪 */
  async _waitReady(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let lastErr = null;
    while (Date.now() < deadline) {
      if (!this.running) throw new Error('内核进程已退出');
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.api('GET', '/version');
        return;
      } catch (err) {
        lastErr = err;
        // eslint-disable-next-line no-await-in-loop
        await sleep(250);
      }
    }
    throw new Error(`内核未在 ${timeoutMs}ms 内就绪：${lastErr ? lastErr.message : '未知原因'}`);
  }

  /** 调用内核控制接口（带 secret 鉴权） */
  api(method, apiPath, body) {
    return new Promise((resolve, reject) => {
      if (!this.controllerPort) {
        reject(new Error('内核尚未启动'));
        return;
      }

      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = http.request(
        {
          host: '127.0.0.1',
          port: this.controllerPort,
          method,
          path: apiPath,
          timeout: 8000,
          headers: {
            Authorization: `Bearer ${this.secret}`,
            ...(payload
              ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
              : {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if ((res.statusCode || 0) >= 400) {
              reject(new Error(`内核接口 ${apiPath} 返回 HTTP ${res.statusCode}`));
              return;
            }
            if (!text) {
              resolve(null);
              return;
            }
            try {
              resolve(JSON.parse(text));
            } catch {
              resolve(text);
            }
          });
          res.on('error', reject);
        },
      );

      req.on('timeout', () => req.destroy(new Error(`内核接口 ${apiPath} 超时`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** 节点 / 代理组清单 */
  async proxies() {
    const data = await this.api('GET', '/proxies');
    return data && data.proxies ? data.proxies : {};
  }

  /** 当前配置概览（模式等） */
  async configs() {
    return this.api('GET', '/configs');
  }

  /** 切换某个策略组选中的节点 */
  async select(groupName, nodeName) {
    return this.api('PUT', `/proxies/${encodeURIComponent(groupName)}`, { name: nodeName });
  }

  /**
   * 节点延迟测速。
   *
   * 不把失败一律压成 -1，而是区分「超时」与「不可用」：界面要能分别标出
   * 「超时」「不可用」两种红色态，而不是都显示成同一个占位符。
   *
   * @param {string} nodeName 节点名
   * @param {string} testUrl 测速目标
   * @param {number} [timeoutMs] 内核侧测速超时
   * @returns {Promise<{delay:number, status:'ok'|'timeout'|'unavailable', message?:string}>}
   */
  async delay(nodeName, testUrl = 'http://www.gstatic.com/generate_204', timeoutMs = 5000) {
    const query = `?url=${encodeURIComponent(testUrl)}&timeout=${timeoutMs}`;
    try {
      const data = await this.api('GET', `/proxies/${encodeURIComponent(nodeName)}/delay${query}`);
      const delay = data && typeof data.delay === 'number' ? data.delay : -1;
      if (delay > 0) return { delay, status: 'ok' };
      return { delay: -1, status: 'unavailable', message: '节点未返回有效延迟' };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      if (/408|timeout|超时/i.test(message)) {
        return { delay: -1, status: 'timeout', message: '测速超时' };
      }
      if (/40[34]|不可用|unavailable/i.test(message)) {
        return { delay: -1, status: 'unavailable', message: '节点不可用' };
      }
      return { delay: -1, status: 'unavailable', message };
    }
  }

  /** 通过内核查询当前出口（用于「出口自检」） */
  async currentEgress() {
    return this.api('GET', '/connections');
  }

  /** 停止内核，确保不留后台进程 */
  async stop() {
    const child = this.child;
    this.stopping = true;
    this.child = null;

    if (!child) {
      this.mixedPort = null;
      this.controllerPort = null;
      return;
    }

    const exited = new Promise((resolve) => {
      child.once('exit', () => resolve(true));
      setTimeout(() => resolve(false), 3500);
    });

    try {
      child.kill();
    } catch {
      /* ignore */
    }

    const ok = await exited;
    if (!ok && child.pid) {
      // 兜底强杀，杜绝内核残留
      try {
        spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true });
      } catch {
        /* ignore */
      }
      await sleep(400);
    }

    this.mixedPort = null;
    this.controllerPort = null;
    this.startedAt = null;
    this.autoRestarts = 0;
    this._removeConfigFile();
    this.emit('stopped');
  }

  /** 内核配置文件含节点凭据，停止后即删，避免长期落盘 */
  _removeConfigFile() {
    try {
      if (fs.existsSync(this.configPath)) fs.unlinkSync(this.configPath);
    } catch {
      /* ignore */
    }
  }
}

module.exports = {
  ProxyKernel,
  PREFERRED_MIXED_PORT,
  PREFERRED_CONTROLLER_PORT,
  pickPort,
  isPortFree,
};
