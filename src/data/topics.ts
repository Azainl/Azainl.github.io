/**
 * 专题（topics）—— 人工编排的跨标签阅读合集。
 *
 * 三种「把文章组织起来」的方式，边界必须清楚：
 * - **标签**：文章说自己属于哪个主题（frontmatter 的 tags），自动汇总，只增不减。
 * - **系列**：一组有先后顺序的文章（frontmatter 的 series + seriesOrder），成员自己知道属于它。
 * - **专题**：我想让读者按什么顺序读这几篇。只在这份文件里存在，文章本身不知道自己被编进了专题。
 *
 * 所以专题**不自动聚类、不做推荐算法、不复制标签页**。跨标签正是它存在的理由：
 * 一个专题可以把「工具」「阅读」「思考」里的文章挑出来排成一条线，而任何单个标签页都做不到。
 *
 * 新增专题：在 TOPICS 里加一项，posts 写**文章 id**（= src/content/posts 下的文件名去掉 .md）。
 * 指向不存在或还没发布的 id、同一篇重复出现、或跨不到 3 个标签，都会让 `npm run check` 报错
 * （校验逻辑在 src/utils/topics.ts 的 checkTopics）。
 */
export interface TopicMeta {
  /** 展示名 */
  name: string;
  /** 出现在 URL 里的英文 slug */
  slug: string;
  /** 一句话导语，索引页与详情页共用 */
  description: string;
  /** 按推荐阅读顺序排列的文章 id */
  posts: string[];
}

export const TOPICS: TopicMeta[] = [
  {
    name: '上线前后要管的事',
    slug: 'ship-it',
    description:
      '一次发布牵动的从来不只是正文。动手前先确认回得去，再依次收拾图片、包体积、构建、head，最后交给脚本看一遍。',
    posts: [
      'backup-habit',
      'image-optimization',
      'astro-image-optimization',
      'bundle-size-optimization',
      'astro-build-optimization',
      'head-meta',
      'preflight-checks',
    ],
  },
  {
    name: '工具的手感',
    slug: 'tool-craft',
    description:
      '清单上多一个工具，不等于快一点。这七篇讲的是反过来做：把少数几件东西用熟，读到它们各自的形状。',
    posts: [
      'worn-in-tools',
      'powershell-toolbox',
      'terminal-aliases-functions',
      'cli-find-with-rg-fzf',
      'dotfiles-management',
      'vscode-workflow',
      'git-commit-message',
    ],
  },
  {
    name: '写作这件事',
    slug: 'writing-habit',
    description:
      '从为什么动笔到怎么让文章自己出现在订阅列表里。六篇按一条真实的写作流程排下来，不是技巧清单。',
    posts: [
      'why-i-write',
      'hello-world',
      'markdown-toolchain',
      'writing-short',
      'draft-publish-workflow',
      'rss-customization',
    ],
  },
  {
    name: '少一点，好一点',
    slug: 'less-but-better',
    description:
      '功能、字数、类型、注意力，都是先加容易先减难。六篇围绕同一件事：把该有的留下，把其余的拿掉。',
    posts: [
      'small-site',
      'simplicity-in-code',
      'typescript-daily-tips',
      'focus-and-rest',
      'reading-mid-2026',
      'mythical-man-month',
    ],
  },
];

const bySlug = new Map(TOPICS.map((topic) => [topic.slug, topic]));

/** slug → 专题元数据（页面反查用）。未收录返回 undefined，让调用方决定兜底。 */
export function topicBySlug(slug: string): TopicMeta | undefined {
  return bySlug.get(slug);
}

/** slug → 展示名。 */
export function topicName(slug: string): string {
  return bySlug.get(slug)?.name ?? slug;
}

/** slug → 导语。 */
export function topicDescription(slug: string): string {
  return bySlug.get(slug)?.description ?? '一个跨标签的阅读合集';
}
