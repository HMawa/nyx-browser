/**
 * 模式切换动画：进隐私模式＝黑色从中心向四周扩散，回普通模式＝牛奶桶。
 *
 * 参数从查询串来（kind / duration / bucket / reduced），由主进程按用户偏好与
 * 系统「减少动效」算好再传进来——这里不做任何决策，只负责画。
 *
 * 两处口径（用户明确要的）：
 * 1. 进入动画是从**同一个中心点**向外一圈一圈长满，不是满屏随机闪烁；
 * 2. 颜色以**黑**为主，只在最外圈给一点点深灰，不能在屏幕上读出别的色调。
 */
'use strict';

const params = new URLSearchParams(location.search);
const kind = params.get('kind') === 'exit' ? 'exit' : 'enter';
const bucketUrl = params.get('bucket') || '';
const reducedBySystem =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const reduced = params.get('reduced') === '1' || reducedBySystem;
const requested = Number(params.get('duration')) || 0;
const duration = Math.max(120, Math.min(6000, requested || (reduced ? 150 : 5000)));

const stage = document.getElementById('stage');
const enterLayer = document.getElementById('enter');
const exitLayer = document.getElementById('exit');
const bucket = document.getElementById('bucket');

/** 以黑为主：最内圈纯黑，往外只走到深灰，不出现彩色 */
const RINGS = ['#000000', '#040506', '#08090a', '#0d0f11'];

/**
 * 从中心向外的扩散：每个格子按「到中心的距离」决定它什么时候亮，
 * 只叠极小的一点噪声，让边缘不至于像用圆规画的。
 * 用固定种子的伪随机，保证同样的窗口尺寸画出同样的图案，便于对比两张截图。
 */
function drawSpread() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = window.innerWidth;
  const height = window.innerHeight;
  stage.width = Math.round(width * dpr);
  stage.height = Math.round(height * dpr);
  stage.style.width = `${width}px`;
  stage.style.height = `${height}px`;

  const ctx = stage.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);

  const cell = Math.max(8, Math.min(24, Math.round(Math.min(width, height) / 46)));
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const cx = cols / 2;
  const cy = rows / 2;
  const maxDist = Math.hypot(cx, cy) || 1;

  let seed = 0x9e3779b9;
  const next = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const cells = [];
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / maxDist;
      cells.push({
        x,
        y,
        // 距离占绝对主导：同一圈同时亮；噪声只占 4%，不会破坏"从中心扩散"的观感
        at: dist * 0.96 + next() * 0.04,
        color: RINGS[Math.min(RINGS.length - 1, Math.floor(dist * RINGS.length))],
      });
    }
  }
  cells.sort((a, b) => a.at - b.at);

  if (reduced) {
    // 减少动效：不扫，直接铺满黑，再淡一次
    enterLayer.style.opacity = '1';
    return;
  }

  const started = performance.now();
  const trail = Math.max(6, Math.ceil(cells.length * 0.012));
  const step = (now) => {
    const t = Math.min(1, (now - started) / duration);
    // 缓出：前段推进快、末段收得慢，3 秒也不至于"开头就满是黑"
    const eased = 1 - Math.pow(1 - t, 2);
    const shown = Math.min(cells.length, Math.ceil(cells.length * eased));

    // 每帧整屏重画：先把整块擦成透明（这样还没覆盖到的地方能看见下面的页面，
    // 才看得出"黑色从中间往四周扩散"），再画已覆盖的格子，最后给前沿补一条浅灰。
    // （只"增量画新增格子"会让每一帧的前沿灰都留在屏上，累计几十帧后整屏都是灰的）
    ctx.clearRect(0, 0, width, height);
    for (let i = 0; i < shown; i += 1) {
      const item = cells[i];
      ctx.fillStyle = i >= shown - trail ? '#2b3035' : item.color;
      ctx.fillRect(item.x * cell, item.y * cell, cell, cell);
    }

    if (t < 1) requestAnimationFrame(step);
    else {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, width, height);
      enterLayer.style.opacity = '1';
    }
  };
  requestAnimationFrame(step);
}

/** 退出：牛奶桶弹出来、停一会儿、末尾白闪整层消失（由主进程按 duration 收窗口） */
function playExit() {
  if (bucketUrl) bucket.src = bucketUrl;
  exitLayer.classList.add('on');
  if (!reduced) {
    requestAnimationFrame(() => bucket.classList.add('pop'));
    // 5 秒里大部分时间留给"桶停在那儿"，最后 900ms 才白闪淡出
    const flashAt = Math.max(200, duration - 900);
    setTimeout(() => {
      exitLayer.classList.add('flash');
    }, flashAt);
    setTimeout(() => {
      stage.style.transition = 'opacity 320ms linear';
      stage.style.opacity = '0';
    }, flashAt + 220);
    return;
  }
  // 减少动效：不弹桶，直接白闪一下
  setTimeout(() => {
    exitLayer.style.background = 'rgba(255, 255, 255, 0.92)';
  }, Math.max(60, duration - 120));
}

if (kind === 'exit') playExit();
else drawSpread();
