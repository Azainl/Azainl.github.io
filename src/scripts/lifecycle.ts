/**
 * 客户端脚本的统一生命周期入口。
 *
 * 以前 reveal / backButton / Header / search 各自监听 `astro:page-load`、
 * 各自用 `dataset.inited` 去重，其中 Header 还把主题切换的绑定塞进了
 * `#header-search` 的守卫里（两个不相干的关注点耦合）。
 *
 * 现在统一在这里注册一次 `astro:page-load`，其他模块导出 init 交给它调度。
 */
type InitFn = () => void;

const inits: InitFn[] = [];
let listening = false;

/** 注册一个"每次页面就绪后执行"的初始化函数 */
export function onPageLoad(fn: InitFn): void {
  inits.push(fn);
  if (listening) return;
  listening = true;
  document.addEventListener('astro:page-load', () => {
    for (const init of inits) {
      try {
        init();
      } catch {
        // 单个模块出错不应该连带其他模块的初始化一起挂掉
      }
    }
  });
}
