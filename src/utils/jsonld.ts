/**
 * 结构化数据（JSON-LD）的共享构造器。
 *
 * T-02 / T-03 / T-18 三处都要产出 JSON-LD：标签页与分页页的聚合语义、
 * 文章页的面包屑、以及 BlogPosting 的 image。此前每个页面各写一份对象字面量，
 * 字段口径（是否带 inLanguage、url 怎么算、position 从几开始）容易漂移。
 * 这里只放**可复用的纯函数**，不放任何页面特有字段。
 */
import { SITE } from '../consts';

/** 站内绝对地址：结构化数据里必须是绝对 URL（相对路径对爬虫无意义） */
export function absUrl(path: string, site: URL | undefined): string {
  return new URL(path, site).href;
}

export interface Crumb {
  /** 面包屑末级不带链接时传 undefined（层级仍在，只是没有 url） */
  path?: string;
  name: string;
}

/**
 * 面包屑。position 从 1 连续递增 —— 这是 schema.org 的硬要求，
 * 跳号会让富结果校验失败，因此由本函数统一生成，调用方只给层级。
 */
export function breadcrumbList(crumbs: Crumb[], site: URL | undefined): Record<string, unknown> {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((crumb, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: crumb.name,
      ...(crumb.path === undefined ? {} : { item: absUrl(crumb.path, site) }),
    })),
  };
}

/** 站点实体：多处 JSON-LD 都要引用「这个站是谁的」，口径保持一致 */
export function webSiteRef(site: URL | undefined): Record<string, unknown> {
  return {
    '@type': 'WebSite',
    name: SITE.title,
    url: absUrl('/', site),
  };
}

/**
 * 列表型聚合页（标签页 / 分页页）。
 * itemListElement 必须来自**页面真实渲染的同一份数据**，否则结构化数据
 * 会与可见内容不一致 —— 那是搜索质量指南明确禁止的做法。
 */
export function collectionPage(opts: {
  name: string;
  description: string;
  path: string;
  posts: { id: string; data: { title: string } }[];
  site: URL | undefined;
}): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: opts.name,
    description: opts.description,
    url: absUrl(opts.path, opts.site),
    inLanguage: SITE.locale,
    isPartOf: webSiteRef(opts.site),
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: opts.posts.length,
      itemListElement: opts.posts.map((post, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        url: absUrl(`/posts/${post.id}/`, opts.site),
        name: post.data.title,
      })),
    },
  };
}
