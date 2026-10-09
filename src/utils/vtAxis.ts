/**
 * 页面切换的「轴向 × 方向」判定。
 *
 * 背景：站点原先只有纵向动画（列表 → 文章）。但站内有一类**左右切换**：
 *   翻页  ← 上一页 / 下一页 →        列表  更新的文章(左) / 更早的文章(右)
 * 它们本质是横向翻阅，却套用了纵向（上下推）的动画 —— 方向与操作不符。
 *
 * 规则（与「哪来哪去」一致）：
 *   · 新内容从**被点击控件所在的那一侧**进来。
 *     点右侧（下一页 →、更早的文章）→ 内容向左走，新页从右入。
 *     点左侧（← 上一页、更新的文章）→ 内容向右走，新页从左入。
 *   · 因此「回退」不是另写一套动画，而是前进的**精确镜像**（见 effects.css 的取负）。
 *
 * 方向不取自 Astro 的 history 判定：点「← 上一页」是一次普通链接跳转，
 * Astro 会把它标成 forward，但从翻页语义上它必须与「下一页」互为镜像。
 * 所以具名控件上的声明优先。
 */

export type VtAxis = 'x' | 'y';

export interface VtVector {
  /** 'x' = 左右切换；'y' = 上下（列表 → 文章） */
  axis: VtAxis;
  /** true = 后退（前进的镜像） */
  back: boolean;
}

/** 路径是否属于分页序列（'/' 或 '/page/N/'） */
export function isPagedPath(pathname: string): boolean {
  return pathname === '/' || /^\/page\/\d+\/?$/.test(pathname);
}

export function resolveVtVector(
  source: Element | null | undefined,
  astroDirection: string,
  from?: string,
  to?: string,
): VtVector {
  const astroBack = astroDirection === 'back';
  const el =
    source && typeof (source as Element).closest === 'function'
      ? ((source as Element).closest('[data-vt-axis]') as Element | null)
      : null;

  if (!el) {
    // 没有点击元素（浏览器返回/前进键、键盘操作）：按 URL 形态推断。
    // 两端都是分页地址 → 这是一次左右翻阅，轴向应为横向，
    // 否则返回键会把横向动画又变回上下推。
    if (from && to && isPagedPath(from) && isPagedPath(to)) {
      return { axis: 'x', back: astroBack };
    }
    return { axis: 'y', back: astroBack };
  }

  const axis: VtAxis = el.getAttribute('data-vt-axis') === 'x' ? 'x' : 'y';
  const dir = el.getAttribute('data-vt-dir');
  if (dir === 'prev') return { axis, back: true };
  if (dir === 'next') return { axis, back: false };
  return { axis, back: astroBack };
}
