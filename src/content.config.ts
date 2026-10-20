// Astro 7 移除了 legacy content collections（`type: 'content'`），
// 改用 Content Layer API：必须显式给一个 loader。
// `z` 也从 `astro:content` 挪到了 `astro/zod`。
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const posts = defineCollection({
  // 文件的 slug 由文件名推导，与旧的 `type: 'content'` 行为一致
  loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
  schema: z
    .object({
      title: z.string(),
      description: z.string(),
      date: z.coerce.date(),
      updated: z.coerce.date().optional(),
      tags: z.array(z.string()).default([]),
      draft: z.boolean().default(false),
      /** 精选：首页列表里的「推荐」标记，同时给相关文章轻微加权；不单独成块 */
      featured: z.boolean().default(false),
      /**
       * 系列名。同一系列的文章填同一个字符串，文章页会显示
       * 「本系列共 N 篇 · 第 k 篇」并给出系列内的上/下一篇。
       * 留空即视为独立文章，行为与加这个字段之前**完全一致**。
       */
      series: z.string().optional(),
      /** 系列内序号，从 1 开始。只有填了 series 才有意义（见下方 refine） */
      seriesOrder: z.number().int().positive().optional(),
    })
    // 只写 seriesOrder 不写 series 是明确的笔误：序号会变成无人消费的孤儿字段，
    // 作者以为排了序、页面却什么都不显示。在构建期直接报错，比静默忽略好。
    .refine((data) => data.seriesOrder === undefined || data.series !== undefined, {
      message: 'seriesOrder 必须与 series 同时出现（只写序号不写系列名不会生效）',
      path: ['seriesOrder'],
    }),
});

export const collections = { posts };
