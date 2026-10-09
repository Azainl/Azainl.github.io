/**
 * 把「轴向 × 方向」写到 <html> 上，供 effects.css 的变量驱动关键帧消费。
 *
 * 为什么要有这个模块：View Transitions 的根快照默认只做交叉淡化，
 * 方向完全由样式决定。而「点右边 → 内容往左走」这类语义只有点击时才知道
 * （Astro 的 sourceElement），所以必须在过渡开始前把它落到 DOM 上。
 *
 * 关键点：属性会被「交换」清掉。Astro 换文档时只保留少数白名单属性，
 * 自定义属性会被新文档覆盖 —— 若不显式带过去，动画会在中途失去方向。
 * 因此这里在 astro:before-swap 里把它写进 newDocument。
 */
import { resolveVtVector } from '../utils/vtAxis';

const AXIS_ATTR = 'data-vt-axis';
const BACK_ATTR = 'data-vt-back';
/** 略长于最长的一段动画（--vt-in-dur 320ms），确保清理不早于动画结束 */
const CLEAR_DELAY = 600;

declare global {
  interface Window {
    __vtAxisBound?: boolean;
    __vtAxisGen?: number;
  }
}

function setVector(axis: 'x' | 'y', back: boolean): void {
  const root = document.documentElement;
  if (axis === 'x') root.setAttribute(AXIS_ATTR, 'x');
  else root.removeAttribute(AXIS_ATTR);
  if (back) root.setAttribute(BACK_ATTR, '');
  else root.removeAttribute(BACK_ATTR);
}

function bind(): void {
  // 脚本在每次换页后会被重新执行；document 本身不会被替换，
  // 所以只绑一次，避免监听器叠加。
  if (window.__vtAxisBound) return;
  window.__vtAxisBound = true;

  document.addEventListener('astro:before-preparation', (event) => {
    const e = event as Event & {
      sourceElement?: Element;
      direction?: string;
      from?: URL;
      to?: URL;
    };
    const { axis, back } = resolveVtVector(
      e.sourceElement,
      String(e.direction ?? 'forward'),
      e.from?.pathname,
      e.to?.pathname,
    );
    // 作废上一次导航遗留的清理定时器
    window.__vtAxisGen = (window.__vtAxisGen ?? 0) + 1;
    setVector(axis, back);
  });

  // 把标记带进新文档，否则交换瞬间属性消失、动画中途失去方向
  document.addEventListener('astro:before-swap', (event) => {
    const e = event as Event & { newDocument?: Document };
    const newRoot = e.newDocument?.documentElement;
    if (!newRoot) return;
    for (const name of [AXIS_ATTR, BACK_ATTR]) {
      const v = document.documentElement.getAttribute(name);
      if (v === null) newRoot.removeAttribute(name);
      else newRoot.setAttribute(name, v);
    }
  });

  // 过渡结束后清干净，下一次导航从默认（纵向、前进）重新判定。
  // 用代号守卫：连点导航时，上一次的定时器不能在本次动画中途把
  // 属性清掉（否则本次过渡会突然退回默认方向）。
  document.addEventListener('astro:page-load', () => {
    const gen = (window.__vtAxisGen ?? 0) + 1;
    window.__vtAxisGen = gen;
    window.setTimeout(() => {
      if (window.__vtAxisGen !== gen) return;
      document.documentElement.removeAttribute(AXIS_ATTR);
      document.documentElement.removeAttribute(BACK_ATTR);
    }, CLEAR_DELAY);
  });
}

bind();
