import type { Post } from './posts';

/**
 * 系列（series）—— 一组按阅读顺序排列的文章。
 *
 * 设计约束：**没填 `series` 的文章，行为必须与加这个功能之前完全一致**。
 * 因此所有函数在"没有系列"时都返回空值/空数组，调用方据此整块隐藏，
 * 不留空标题、不生成空页面。
 */

/**
 * 系列内排序用的键。
 *
 * `seriesOrder` 是可选的：作者可能只填了 series 没填序号。那种情况下
 * 退到发布日期——但用一个远大于任何真实序号的哨兵值，让**填了序号的文章
 * 始终排在只填了系列名、没填序号的文章前面**，而不是跟它们混在一起按日期穿插。
 * 这样"部分填了序号"的系列看起来仍然是作者预期的顺序，而不是忽前忽后。
 */
const NO_ORDER = Number.MAX_SAFE_INTEGER;

function orderOf(post: Post): number {
  return post.data.seriesOrder ?? NO_ORDER;
}

/**
 * 取某个系列的全部文章，按 seriesOrder 升序。
 * 序号相同（或都没填）时用日期、再用 id 兜底，保证不同机器上顺序一致。
 */
export function getSeriesPosts(posts: Post[], name: string): Post[] {
  return posts
    .filter((post) => post.data.series === name)
    .sort(
      (a, b) =>
        orderOf(a) - orderOf(b) ||
        a.data.date.valueOf() - b.data.date.valueOf() ||
        a.id.localeCompare(b.id),
    );
}

/** 站点上真实存在的系列：系列名 → 该系列的文章（已排序）。按系列首篇日期倒序排列。 */
export function getUsedSeries(posts: Post[]): Map<string, Post[]> {
  const names = new Set<string>();
  for (const post of posts) {
    if (post.data.series) names.add(post.data.series);
  }

  const map = new Map<string, Post[]>();
  for (const name of names) {
    map.set(name, getSeriesPosts(posts, name));
  }

  return new Map(
    [...map.entries()].sort(
      (a, b) => b[1][0].data.date.valueOf() - a[1][0].data.date.valueOf(),
    ),
  );
}

/**
 * 系列内的一致性检查。系列是手写 frontmatter 维护的，容易漏、容易重号，
 * 而这些错误**不会让构建失败**——页面照常渲染，只是顺序不对或计数不对，
 * 静默地错下去。这里把问题显式列出来，交给回归断言去卡。
 */
export interface SeriesIssue {
  series: string;
  kind: 'duplicate-order' | 'missing-order' | 'single-member';
  detail: string;
}

export function checkSeries(posts: Post[]): SeriesIssue[] {
  const issues: SeriesIssue[] = [];

  for (const [name, list] of getUsedSeries(posts)) {
    if (list.length < 2) {
      issues.push({
        series: name,
        kind: 'single-member',
        detail: `只有 1 篇（${list[0].id}）——系列至少要有 2 篇才有意义`,
      });
    }

    const seen = new Map<number, string>();
    for (const post of list) {
      const order = post.data.seriesOrder;
      if (order === undefined) {
        issues.push({
          series: name,
          kind: 'missing-order',
          detail: post.id,
        });
        continue;
      }
      const previous = seen.get(order);
      if (previous) {
        issues.push({
          series: name,
          kind: 'duplicate-order',
          detail: `第 ${order} 篇被 ${previous} 与 ${post.id} 同时占用`,
        });
      } else {
        seen.set(order, post.id);
      }
    }
  }

  return issues;
}

/** 当前文章在系列中的位置与前后邻居（系列导航用）。非系列文章返回 null。 */
export interface SeriesContext {
  name: string;
  /** 系列全部文章，已按 seriesOrder 排序 */
  posts: Post[];
  /** 当前文章在系列中的序号，从 1 开始（展示用） */
  position: number;
  total: number;
  /** 系列内的上一篇（按阅读顺序在前） */
  previous: Post | null;
  next: Post | null;
}

export function getSeriesContext(posts: Post[], current: Post): SeriesContext | null {
  const name = current.data.series;
  if (!name) return null;

  const list = getSeriesPosts(posts, name);
  const index = list.findIndex((post) => post.id === current.id);
  if (index < 0) return null;

  return {
    name,
    posts: list,
    position: index + 1,
    total: list.length,
    previous: index > 0 ? list[index - 1] : null,
    next: index < list.length - 1 ? list[index + 1] : null,
  };
}
