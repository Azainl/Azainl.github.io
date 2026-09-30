// 生成社交分享用的 OG 图（PNG，1200×630）。
//
// 为什么是「预生成 + 提交进仓库」而不是构建时生成：
//   1. og:image 必须是最常见的 PNG/JPEG —— Facebook / Twitter / LinkedIn 都
//      不支持 SVG，之前全站只挂 public/og.svg，等于分享出去没有预览图；
//   2. 构建时生成需要 sharp（astro 的 optionalDependency）和一套中文字体，
//      而 GitHub Actions 的 ubuntu runner 默认没有 CJK 字体，中文会渲染成方框；
//   3. 预生成后产物是普通静态文件，CI 上零额外依赖、零字体依赖，且肉眼可验。
//
// 代价：新增/改标题后要重新跑一次 `npm run og`。漏跑不会挂——运行时会由
// src/utils/posts.ts 的 ogImageUrl() 回退到全站默认 /og.png。
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// 注意：不要写成 dirname(fileURLToPath(new URL('..', import.meta.url)))——
// fileURLToPath 会保留结尾反斜杠，dirname 再吃掉一层就跑到项目外面去了。
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const POSTS_DIR = `${ROOT}/src/content/posts`;
const OUT_DIR = `${ROOT}/public/og`;

const sharp = (await import('sharp')).default;

// 与 src/styles/global.css 的设计令牌保持一致
const BG = '#f7f7f4';
const INK = '#1a1a1e';
const INK_3 = '#6f6f77';
const ACCENT = '#c5321a';

const CJK = "'PingFang SC','Microsoft YaHei','Hiragino Sans GB','Noto Sans CJK SC',sans-serif";

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** 粗略估算显示宽度：CJK 记 1em，其余记 0.55em */
const widthOf = (s) => [...s].reduce((w, ch) => w + (/[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.55), 0);

/** 按可用宽度折行，超出 maxLines 时末行加省略号 */
function wrap(text, maxEm, maxLines) {
  const chars = [...text];
  const lines = [];
  let cur = '';
  let curW = 0;
  for (const ch of chars) {
    const w = widthOf(ch);
    if (curW + w > maxEm && cur) {
      lines.push(cur);
      cur = '';
      curW = 0;
      if (lines.length === maxLines) break;
    }
    cur += ch;
    curW += w;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  // 放不下的部分用省略号收尾
  const consumed = lines.join('').length;
  if (consumed < chars.length) {
    let last = lines[lines.length - 1] ?? '';
    last = [...last].slice(0, Math.max(1, [...last].length - 1)).join('') + '…';
    lines[lines.length - 1] = last;
  }
  return lines;
}

/** 画一张卡片：站名 + 标题（最多 2 行）+ 底部元信息 */
function card({ site, title, meta }) {
  const titleLines = wrap(title, 15.5, 2);
  const titleSize = titleLines.length > 1 ? 62 : 70;
  const titleSvg = titleLines
    .map((line, i) => `<text x="80" y="${300 + i * (titleSize + 14)}" font-family="${CJK}" font-size="${titleSize}" font-weight="700" fill="${INK}">${esc(line)}</text>`)
    .join('\n  ');
  const lines = titleLines.length;
  const metaY = lines > 1 ? 300 + titleSize + 14 + titleSize + 30 : 300 + titleSize + 66;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <rect width="1200" height="630" fill="${BG}"/>
  <path d="M1112 386a148 148 0 1 0 118 238 162 162 0 0 1-118-238z" fill="${ACCENT}"/>
  <text x="80" y="118" font-family="${CJK}" font-size="30" fill="${INK_3}">${esc(site)}</text>
  ${titleSvg}
  <text x="80" y="${metaY}" font-family="${CJK}" font-size="28" fill="${INK_3}">${esc(meta)}</text>
  <text x="80" y="560" font-family="Georgia,serif" font-size="26" font-style="italic" fill="${INK_3}">notes on code, reading and life</text>
</svg>`;
}

async function render(svg, outPath) {
  const png = await sharp(Buffer.from(svg), { density: 300 })
    .resize(1200, 630)
    .png({ compressionLevel: 9, palette: true, quality: 90 })
    .toBuffer();
  writeFileSync(outPath, png);
  return png.length;
}

// ---- 读文章 frontmatter ----
const g = (fm, key) => (fm.match(new RegExp(`^${key}:\\s*"?(.*?)"?\\s*$`, 'm')) ?? [])[1] ?? '';
const posts = readdirSync(POSTS_DIR)
  .filter((f) => f.endsWith('.md'))
  .map((f) => {
    const fm = (readFileSync(`${POSTS_DIR}/${f}`, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/) ?? [])[1] ?? '';
    let tags = [];
    try { tags = JSON.parse(g(fm, 'tags') || '[]'); } catch {}
    return { slug: f.replace(/\.md$/, ''), title: g(fm, 'title'), date: g(fm, 'date'), tags };
  })
  .sort((a, b) => a.date.localeCompare(b.date));

mkdirSync(OUT_DIR, { recursive: true });

const SITE_TITLE = '山月 · 个人博客';
let total = 0;

const defSize = await render(
  card({ site: SITE_TITLE, title: '写点东西，留给自己，也留给路过的人。', meta: 'https://azainl.github.io' }),
  `${ROOT}/public/og.png`,
);
total += defSize;
console.log(`og.png${' '.repeat(12)} ${defSize} B`);

for (const p of posts) {
  const meta = [p.date, p.tags.map((t) => `#${t}`).join(' ')].filter(Boolean).join('  ·  ');
  const size = await render(card({ site: SITE_TITLE, title: p.title, meta }), `${OUT_DIR}/${p.slug}.png`);
  total += size;
  console.log(`og/${p.slug}.png${' '.repeat(Math.max(1, 34 - p.slug.length))} ${size} B`);
}

// 清理已经不存在文章的残留图（改名/删文后残留的 OG 图会被搜索引擎缓存住）
const slugs = new Set(posts.map((p) => p.slug));
let removed = 0;
for (const f of readdirSync(OUT_DIR)) {
  if (f.endsWith('.png') && !slugs.has(f.replace(/\.png$/, ''))) {
    rmSync(`${OUT_DIR}/${f}`);
    console.log(`已删除残留 OG 图: og/${f}`);
    removed++;
  }
}

// 生成清单：运行时（src/utils/posts.ts）靠它判断某篇文章有没有专属分享图，
// 从而避免在构建期读文件系统——路径解析在任何环境下都稳。
const manifest = `// 本文件由 scripts/generate-og.mjs 自动生成，请勿手工修改。
// 内容：public/og/ 下已生成专属分享图的文章 slug。
// 重新生成：npm run og
export const OG_SLUGS: string[] = [
${posts.map((p) => `  '${p.slug}',`).join('\n')}
];
`;
writeFileSync(`${ROOT}/src/data/og-manifest.ts`, manifest);
console.log(`已写入 src/data/og-manifest.ts（${posts.length} 个 slug）`);

console.log(`\n共 ${posts.length + 1} 张，合计 ${(total / 1024).toFixed(0)} KB`);
console.log('别忘了：改了文章标题要重跑 npm run og。');
