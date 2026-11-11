'use strict';

/**
 * 玻璃霓虹层 · 动效脚本
 * ------------------------------------------------------------------
 * 只做"锦上添花"的三件事，不触碰任何业务逻辑与 IPC：
 *   1. 滚动驱动：容器顶部霓虹进度条 + 卡片滚动渐显（含分组错峰）
 *   2. 指针跟随：玻璃卡片上的径向高光跟随鼠标
 *   3. 加载指示：检测到标签加载时，外壳顶部亮起扫描光条
 * 系统开启"减少动态效果"时整体静默，交由纯 CSS 呈现静态玻璃质感。
 */

(function () {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return;
  }

  /* ---------------- 1. 滚动进度条 ---------------- */

  const PROGRESS_SELECTORS = '.sec-scroll, .tb-pane.tb-scroll, .tb-drawer-body';

  function mountProgress(container) {
    if (container.dataset.fxProgress) return;
    container.dataset.fxProgress = '1';

    const bar = document.createElement('div');
    bar.className = 'fx-progress';
    container.appendChild(bar);

    let raf = 0;
    const update = () => {
      raf = 0;
      const max = container.scrollHeight - container.clientHeight;
      const ratio = max > 4 ? container.scrollTop / max : 0;
      bar.style.setProperty('--fx-progress', ratio.toFixed(4));
      bar.classList.toggle('fx-active', ratio > 0.001);
    };

    container.addEventListener(
      'scroll',
      () => {
        if (!raf) raf = requestAnimationFrame(update);
      },
      { passive: true }
    );
    update();
  }

  /* ---------------- 2. 卡片滚动渐显（同容器内错峰入场） ---------------- */

  const revealObserver =
    'IntersectionObserver' in window
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              entry.target.classList.add('fx-in');
              revealObserver.unobserve(entry.target);
            }
          },
          { threshold: 0.06 }
        )
      : null;

  function mountReveal(root) {
    if (!revealObserver) return;

    const cards = root.querySelectorAll('.info-card, .tb-group');
    const groups = new Map();
    for (const card of cards) {
      if (card.dataset.fxReveal) continue;
      card.dataset.fxReveal = '1';
      card.classList.add('fx-reveal');

      const key = card.parentElement || root;
      const index = groups.get(key) || 0;
      groups.set(key, index + 1);
      // 同组卡片按 40ms 逐个错峰，超过 8 张后不再累加，避免长列表尾巴等太久
      card.style.setProperty('--fx-delay', `${Math.min(index, 8) * 0.04}s`);
      revealObserver.observe(card);
    }
  }

  /* ---------------- 3. 指针跟随高光 ---------------- */

  const CARD_SELECTOR = '.tb-group, .info-card';
  let pointerRaf = 0;
  let pointerTarget = null;
  let pointerX = 0;
  let pointerY = 0;

  function flushPointer() {
    pointerRaf = 0;
    if (pointerTarget) {
      pointerTarget.style.setProperty('--fx-mx', `${pointerX}px`);
      pointerTarget.style.setProperty('--fx-my', `${pointerY}px`);
    }
  }

  document.addEventListener('pointermove', (event) => {
    const target = event.target && event.target.closest ? event.target.closest(CARD_SELECTOR) : null;
    if (!target) return;
    pointerTarget = target;
    const rect = target.getBoundingClientRect();
    pointerX = event.clientX - rect.left;
    pointerY = event.clientY - rect.top;
    if (!pointerRaf) pointerRaf = requestAnimationFrame(flushPointer);
  });

  /* ---------------- 4. 页面加载扫描光条 ---------------- */

  function mountLoadingWatcher() {
    const tabs = document.getElementById('tabs');
    if (!tabs) return;

    const sync = () => {
      const loading = !!tabs.querySelector('.tab-spinner');
      document.body.classList.toggle('fx-loading', loading);
    };

    new MutationObserver(sync).observe(tabs, { childList: true, subtree: true, attributes: true });
    sync();
  }

  /* ---------------- 初始化 ---------------- */

  function init(root) {
    root.querySelectorAll(PROGRESS_SELECTORS).forEach(mountProgress);
    mountReveal(root);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      init(document);
      mountLoadingWatcher();
    });
  } else {
    init(document);
    mountLoadingWatcher();
  }
})();
