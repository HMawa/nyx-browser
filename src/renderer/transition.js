/**
 * 模式切换动画：进隐私模式＝像素感染，回普通模式＝牛奶桶。
 *
 * 参数从查询串来（kind / duration / bucket / reduced），由主进程按用户偏好与
 * 系统「减少动效」算好再传进来——这里不做任何决策，只负责画。
 */
'use strict';

const params = new URLSearchParams(location.search);
const kind = params.get('kind') === 'exit' ? 'exit' : 'enter';
const bucketUrl = params.get('bucket') || '';
const reducedBySystem =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const reduced = params.get('reduced') === '1' || reducedBySystem;
const requested = Number(params.get('duration')) || 0;
const duration = Math.max(120, Math.min(1500, requested || (reduced ? 150 : 820)));

const stage = document.getElementById('stage');
const enterLayer = document.getElementById('enter');
const exitLayer = document.getElementById('exit');
const bucket = document.getElementById('bucket');

/** 与墨夜同一套深色：切换画面不该在浅色主题下露出别的颜色 */
const COLORS = ['#07090a', '#0d2a1c', '#2a2412', '#2a0f12'];

/**
 * 像素感染：格子（8–24px）从中心往外按噪声场依次点亮。
 * 用固定种子的伪随机，保证同样的窗口尺寸画出同样的图案，便于对比两张截图。
 */
function drawInfection() {
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
        at: dist * 0.82 + next() * 0.18,
        color: COLORS[Math.floor(next() * COLORS.length)],
      });
    }
  }
  cells.sort((a, b) => a.at - b.at);

  if (reduced) {
    // 减少动效：直接把整屏铺成底色，再淡入一次，不做扩散
    ctx.fillStyle = COLORS[0];
    ctx.fillRect(0, 0, width, height);
    enterLayer.style.opacity = '1';
    return;
  }

  const started = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - started) / duration);
    const shown = Math.floor(cells.length * t);
    for (let i = 0; i < shown; i += 1) {
      const item = cells[i];
      ctx.fillStyle = item.color;
      ctx.fillRect(item.x * cell, item.y * cell, cell, cell);
    }
    if (t < 1) requestAnimationFrame(step);
    else enterLayer.style.opacity = '1';
  };
  requestAnimationFrame(step);
}

/** 退出：牛奶桶弹出来、白闪一下，然后整层消失（由主进程按 duration 收窗口） */
function playExit() {
  if (bucketUrl) bucket.src = bucketUrl;
  exitLayer.classList.add('on');
  if (!reduced) {
    requestAnimationFrame(() => bucket.classList.add('pop'));
    setTimeout(() => {
      stage.style.transition = 'opacity 120ms linear';
      stage.style.opacity = '0';
      exitLayer.style.background = 'rgba(255, 255, 255, 0.92)';
    }, Math.max(120, duration - 220));
    return;
  }
  // 减少动效：不弹桶，直接白闪一下
  setTimeout(() => {
    exitLayer.style.background = 'rgba(255, 255, 255, 0.92)';
  }, Math.max(60, duration - 120));
}

if (kind === 'exit') playExit();
else drawInfection();
