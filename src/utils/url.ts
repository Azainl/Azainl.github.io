/**
 * 站内路径统一加 `base` 前缀。
 *
 * 站点目前部署在根路径（`base` 未设置，`BASE_URL === '/'`），但 README 里提到的
 * GitHub Pages 项目站点需要 `base: '/仓库名/'`；一旦设置，所有硬编码的绝对路径
 * （`/posts/`、`/tags/`、`/rss.xml`…）都会失效。统一走这里就不会。
 */
export const BASE = import.meta.env.BASE_URL || '/';

/** 把以 `/` 开头的站内路径加上 base 前缀 */
export function url(path: string): string {
  return `${BASE}${path.replace(/^\//, '')}`;
}

/** 判断当前路径是否为首页（兼容 base 前缀） */
export function isHome(pathname: string): boolean {
  const target = BASE.replace(/\/$/, '');
  return pathname.replace(/\/$/, '') === target;
}
