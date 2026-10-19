import { getPublishedPosts } from '../utils/posts';

/** 把 Markdown 正文转成适合搜索的纯文本 */
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ') // 成对剔除代码块（含闭合围栏）
    .replace(/`[^`]*`/g, ' ') // 行内代码
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // 图片保留 alt 文字
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接保留文字
    .replace(/^#{1,6}\s*/gm, '') // 标题符号
    .replace(/^>\s?/gm, '') // 引用符号
    .replace(/^[-*+]\s+/gm, '') // 无序列表符号
    .replace(/^\d+\.\s+/gm, '') // 有序列表符号
    .replace(/(\*\*|__|\*|_|`|~~)/g, '') // 强调、行内代码、删除线
    .replace(/\|/g, ' ') // 表格竖线
    .replace(/<[^>]+>/g, ' ') // HTML 标签
    .replace(/\s+/g, ' ') // 压缩空白
    .trim();
}

/**
 * 正文截断长度（T-21，2026-10-19 定）。
 *
 * 选 500 字依据是实测而非估算（见 docs/后续功能开发计划.md §1.3）：
 * 32 篇正文 strip 后最短 337 字、中位 555 字、最长 897 字，500 字已覆盖绝大多数正文；
 * 而 content 字段占 `search.json` 原始字节的 84%。截到 500 字后：
 *   raw 59049 → 49905 B（-15.5%）、gzip 26546 → 22629 B（-14.8%），32 篇中被截 19 篇。
 *
 * 口径说明：验收统一用 **gzip**。规划原文「100 篇 < 100 KB」没写口径，
 * 用 raw 口径必须截到 240 字（等于砍掉一半正文），gzip 口径 500 字在 100 篇时约 69 KB 即达标。
 * 客户端 `snippet()` 只取命中位置前后各 100 字左右，500 字不影响摘要可读性。
 */
const CONTENT_LIMIT = 500;

/**
 * 迁移到 Pagefind 的提醒阈值。
 *
 * 当前实现是「整包下载 + `includes` 全串匹配」：索引体积随文章数线性增长。
 * 实测 32 篇时 raw 49.9 KB / gzip 22.1 KB，单篇约 1.56 KB（500 字档）。
 * 按此推算 80 篇约 raw 125 KB / gzip 55 KB、100 篇约 raw 156 KB / gzip 69 KB，
 * 到那时值得换成 Pagefind（分片按需加载 + 中文分词）。
 *
 * 这里只报警、不阻断构建：阈值到了就该有人做决定，但不该让发布挂掉。
 * 迁移步骤见 docs/操作文档.md 第 6.4 节。
 */
const PAGEFIND_THRESHOLD = 80;

export async function GET() {
  const posts = await getPublishedPosts();

  const items = posts.map((post) => ({
    slug: post.id,
    title: post.data.title,
    description: post.data.description,
    date: post.data.date.toISOString(),
    tags: post.data.tags,
    // 索引只需要够搜索用，正文截断避免文件随文章数线性膨胀
    // Content Layer API 里 body 是 string | undefined（条目也可能只有 data）
    content: stripMarkdown(post.body ?? '').slice(0, CONTENT_LIMIT),
  }));

  // 体积口径必须用 Buffer.byteLength：JSON.stringify(...).length 数的是 UTF-16 码元，
  // 中文各占 1 个码元但 UTF-8 编成 3 字节，实测会低报 2.4 倍（24 KB vs 59 KB）。
  const bytes = Buffer.byteLength(JSON.stringify(items), 'utf8');

  if (items.length >= PAGEFIND_THRESHOLD) {
    const kb = Math.round(bytes / 1024);
    console.warn(
      `[search] 文章数已达 ${items.length} 篇，search.json 约 ${kb} KB（raw；` +
        `gzip 通常只有 raw 的 45%，约 ${Math.round(bytes * 0.45 / 1024)} KB）。` +
        `该考虑迁移到 Pagefind 了（分片索引 + 中文分词），步骤见 docs/操作文档.md 6.4。`,
    );
  }

  return new Response(JSON.stringify(items), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
