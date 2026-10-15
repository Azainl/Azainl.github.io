/**
 * 结构化数据（JSON-LD）的共享构造器。
 *
 * T-02 / T-03 / T-18 三处都要产出 JSON-LD：标签页与分页页的聚合语义、
 * 文章页的面包屑、以及 BlogPosting 的 image。此前每个页面各写一份对象字面量，
 * 字段口径（是否带 inLanguage、url 怎么算、position 从几开始）容易漂移。
 * 这里只放**可复用的纯函数**，不放任何页面特有字段。
 */
import { SITE } from '../consts';

/**
 * 把结构化数据序列化成**可安全内联进 <script> 的 JSON 字符串**。
 *
 * 危险来自 <script> 是 HTML 的「原始文本元素」：它的内容在遇到第一个
 * `</script` 时就结束，且**不解码 HTML 实体**。因此当文章标题/描述里
 * 含有 `</script>`（写一篇讲 HTML 转义的文章就会自然出现）时，
 * 裸 JSON.stringify 会提前闭合脚本标签，把剩余 JSON 当成 HTML 解析 ——
 * 既是标记结构破坏，也是一个注入点。
 *
 * 修法是**JSON 层的 \u 转义，而不是 HTML 实体**：script 内不解码实体，
 * 写 `&lt;` 只会让 JSON 里多出一段字面量 `&lt;`（数据被改坏），
 * 而 `\u003c` 是合法的 JSON 转义，解析后仍是 `<`，语义完全不变。
 * 转义 `&` 与 U+2028/U+2029 同理：前者防止实体被二次解释，
 * 后者虽不闭合标签，但部分 JSON 解析器会因它报错。
 *
 * JSON 结构字符（`{}` `[]` `:` `,` 数字与裸字面量）不含这五个字符，
 * 故整体替换不会破坏 JSON 结构。
 */
export function safeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

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
