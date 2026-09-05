/**
 * 标签的展示名 / URL slug / 一句话描述。
 *
 * 以前 URL 直接用中文原文（`/tags/性能优化/`），中文路径在部分 CDN、代理和
 * Windows CI 上会有编码问题；现在改成英文 slug，旧 URL 在 astro.config.mjs
 * 里配了重定向。新增标签时在这里加一行即可。
 */
export interface TagMeta {
  /** 展示名（frontmatter 里写的原文） */
  name: string;
  /** 出现在 URL 里的英文 slug */
  slug: string;
  /** 标签页顶部的一句话描述 */
  description: string;
}

export const TAGS: TagMeta[] = [
  { name: '前端', slug: 'frontend', description: '前端开发相关内容' },
  { name: '效率', slug: 'productivity', description: '让工作更高效的方法' },
  { name: '工具', slug: 'tools', description: '效率工具与使用技巧' },
  { name: '写作', slug: 'writing', description: '写作方法与长期练习' },
  { name: 'Astro', slug: 'astro', description: 'Astro 框架相关实践' },
  { name: '性能优化', slug: 'performance', description: '页面加载与构建产物的优化实践' },
  { name: '思考', slug: 'thinking', description: '对技术、写作与生活的思考' },
  { name: '随笔', slug: 'essays', description: '生活中的零散想法与记录' },
  { name: '阅读', slug: 'reading', description: '读书笔记与阅读记录' },
  { name: '终端', slug: 'terminal', description: '终端、命令行与 Shell 用法' },
  { name: '流程规范', slug: 'workflow', description: '开发流程、协作与发布规范' },
  { name: 'SEO', slug: 'seo', description: '搜索引擎优化与站点可见性' },
];

const byName = new Map(TAGS.map((t) => [t.name, t]));
const bySlug = new Map(TAGS.map((t) => [t.slug, t]));

/**
 * 标签名 → URL slug。
 * 未收录的新标签兜底生成（小写、空格转连字符），链接仍然可用，
 * 但中文标签建议在这里补一行，URL 才不会变成百分号编码。
 */
export function tagSlug(tag: string): string {
  return byName.get(tag)?.slug ?? tag.trim().toLowerCase().replace(/\s+/g, '-');
}

/** slug → 展示名（标签详情页反查用） */
export function tagName(slug: string): string {
  return bySlug.get(slug)?.name ?? slug;
}

/** 标签名 → 描述 */
export function tagDescription(tag: string): string {
  return byName.get(tag)?.description ?? '关于该主题的文章';
}

/** slug → 描述 */
export function tagDescriptionBySlug(slug: string): string {
  return bySlug.get(slug)?.description ?? '关于该主题的文章';
}
