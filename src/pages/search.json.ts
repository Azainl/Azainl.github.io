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
 * 迁移到 Pagefind 的提醒阈值。
 *
 * 当前实现是「整包下载 + `includes` 全串匹配」：索引体积随文章数线性增长，
 * 每篇约 1.7 KB。24 篇时 gzip 后仅约 11 KB，完全够用；到 80 篇约 134 KB
 * （gzip 约 38 KB）就开始值得换了——Pagefind 能分片按需加载并做中文分词。
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
    content: stripMarkdown(post.body ?? '').slice(0, 2000),
  }));

  if (items.length >= PAGEFIND_THRESHOLD) {
    const kb = Math.round(JSON.stringify(items).length / 1024);
    console.warn(
      `[search] 文章数已达 ${items.length} 篇，search.json 约 ${kb} KB。` +
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
