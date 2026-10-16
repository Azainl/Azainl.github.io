/**
 * 系列的展示名 / URL slug / 一句话描述。
 *
 * 和 `src/data/tags.ts` 同样的思路：URL 里用英文 slug，中文只出现在页面上。
 * frontmatter 的 `series` 字段写这里的**展示名**（原文），链接走 slug。
 * 新增系列时在这里加一行即可。
 */
export interface SeriesMeta {
  /** 展示名（frontmatter 里写的原文） */
  name: string;
  /** 出现在 URL 里的英文 slug */
  slug: string;
  /** 系列页顶部的一句话描述 */
  description: string;
}

export const SERIES: SeriesMeta[] = [
  {
    name: 'Astro 博客实践',
    slug: 'astro-blog',
    description:
      '从一个空目录到上线：建站选型、写作发布流程、图片处理、构建提速、订阅源与发布前检查。',
  },
];

const byName = new Map(SERIES.map((s) => [s.name, s]));
const bySlug = new Map(SERIES.map((s) => [s.slug, s]));

/**
 * 系列名 → URL slug。
 * 未收录的新系列兜底生成（小写、空格转连字符），链接仍然可用，
 * 但中文系列名建议在这里补一行，URL 才不会变成百分号编码。
 */
export function seriesSlug(name: string): string {
  return byName.get(name)?.slug ?? name.trim().toLowerCase().replace(/\s+/g, '-');
}

/** slug → 展示名（系列页反查用） */
export function seriesName(slug: string): string {
  return bySlug.get(slug)?.name ?? slug;
}

/** 系列名 → 描述 */
export function seriesDescription(name: string): string {
  return byName.get(name)?.description ?? '同一主题下的系列文章';
}

/** slug → 描述 */
export function seriesDescriptionBySlug(slug: string): string {
  return bySlug.get(slug)?.description ?? '同一主题下的系列文章';
}
