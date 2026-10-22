import type { Post } from './posts';
import { TOPICS, type TopicMeta } from '../data/topics';

/**
 * 专题（topic）的解析与校验。
 *
 * 和 series 一样分两层：`src/data/topics.ts` 描述**意图**（我想让读者怎么读），
 * 这里把意图**兑现成文章对象**，并把兑现不了的情况显式列出来。
 *
 * 兑现不了的典型原因：文章 id 打错、文章还是 draft、文章被删了。
 * 这些错误**都不会让构建失败**——页面照常渲染，只是少一篇、顺序对不上，
 * 静默地错下去。所以 checkTopics() 把它们列出来交给回归断言去卡。
 */

/** 专题内的一篇文章 */
export interface ResolvedTopic {
  meta: TopicMeta;
  /** 按 meta.posts 的顺序解析出来的文章；找不到的 id 不在其中 */
  posts: Post[];
  /** 专题覆盖到的标签（去重，保持首次出现顺序） */
  tags: string[];
}

/**
 * 把专题数据解析成文章对象。
 *
 * **顺序以 meta.posts 为准**，不重新按日期排——人工编排的意义就在这里。
 * 缺失的 id 直接跳过（不抛错），留给 checkTopics() 报告，页面仍可渲染。
 */
export function resolveTopics(posts: Post[]): ResolvedTopic[] {
  const byId = new Map(posts.map((post) => [post.id, post]));

  return TOPICS.map((meta) => {
    const resolved: Post[] = [];
    for (const id of meta.posts) {
      const post = byId.get(id);
      if (post) resolved.push(post);
    }

    const tags: string[] = [];
    for (const post of resolved) {
      for (const tag of post.data.tags) {
        if (!tags.includes(tag)) tags.push(tag);
      }
    }

    return { meta, posts: resolved, tags };
  });
}

/** 单个专题的解析结果（页面用）。slug 未收录返回 undefined。 */
export function getTopic(posts: Post[], slug: string): ResolvedTopic | undefined {
  return resolveTopics(posts).find((topic) => topic.meta.slug === slug);
}

/**
 * 专题数据的健康检查。
 *
 * 阈值与任务书的触发条件一致：**每个专题至少 3 个不同标签或至少 6 篇文章**。
 * 达不到说明这个专题还没长成——要么再攒几篇，要么干脆别上线，
 * 而不是让读者点进去看到一篇半的东西。
 */
export interface TopicIssue {
  topic: string;
  kind: 'missing-post' | 'duplicate-post' | 'too-thin';
  detail: string;
}

export const TOPIC_MIN_TAGS = 3;
export const TOPIC_MIN_POSTS = 6;

export function checkTopics(posts: Post[]): TopicIssue[] {
  const issues: TopicIssue[] = [];
  const byId = new Map(posts.map((post) => [post.id, post]));

  for (const { meta, posts: resolved, tags } of resolveTopics(posts)) {
    const seen = new Set<string>();
    for (const id of meta.posts) {
      if (seen.has(id)) {
        issues.push({
          topic: meta.name,
          kind: 'duplicate-post',
          detail: `${id} 在同一专题里出现了两次`,
        });
        continue;
      }
      seen.add(id);

      if (!byId.has(id)) {
        issues.push({
          topic: meta.name,
          kind: 'missing-post',
          detail: `${id} 不是已发布的文章`,
        });
      }
    }

    if (tags.length < TOPIC_MIN_TAGS && resolved.length < TOPIC_MIN_POSTS) {
      issues.push({
        topic: meta.name,
        kind: 'too-thin',
        detail: `${resolved.length} 篇 / ${tags.length} 个标签，至少要 ${TOPIC_MIN_POSTS} 篇或 ${TOPIC_MIN_TAGS} 个标签`,
      });
    }
  }

  return issues;
}
