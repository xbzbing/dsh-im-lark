/**
 * 面板的插件注册入口。
 *
 * 打包形态：`scripts/build.mjs` 用 esbuild 把本目录打成单个 `lib/client.js`，外层
 * 是 `window.__ModuleLoader__.load({ id, factory })`；`react` 与 `@deepseek-ai/*`
 * 保持 external，由宿主的模块表提供。
 *
 * 注册槽位只有一个：`plugins.bundle.config`，key 是包名——插件页按包名分发配置
 * 节，注册即表示这一页要显示。
 */

import { BUNDLE_CONFIG_SLOT, PACKAGE_NAME, PANEL_NS } from './constants.ts';
import { en, fallbackTranslate, zh } from './locales.ts';
import type { Translate } from './locales.ts';
import { createRpcCall } from './logic.ts';
import { LarkSettingsPanel } from './panel.ts';

export function apply(ctx: any): void {
  let t: Translate = fallbackTranslate;

  if (typeof ctx.locale?.register === 'function') {
    ctx.effect(() => {
      let unregister: unknown;
      try {
        unregister = ctx.locale.register(PANEL_NS, { zh, en });
      } catch (error) {
        // 命名空间已存在只可能是同一插件的另一份实例（HMR 未释放）。
        // 字典是同一份，复用即可；连 bind 都拿不到才继续抛。
        if (typeof ctx.locale.bind !== 'function') throw error;
        try {
          ctx.locale.bind(PANEL_NS);
        } catch {
          throw error;
        }
        return () => {};
      }
      return () => {
        if (typeof unregister === 'function') unregister();
      };
    }, 'dsh-im-lark: 面板文案');

    if (typeof ctx.locale.bind === 'function') t = ctx.locale.bind(PANEL_NS) as Translate;
  }

  const rpcCall = createRpcCall(ctx.connection);
  const dependencies = () => ({ t, rpcCall });

  if (typeof ctx.slots?.inject !== 'function' || typeof ctx.slots?.register !== 'function') return;

  ctx.effect(() => {
    const dispose = ctx.slots.inject(BUNDLE_CONFIG_SLOT, () =>
      ctx.slots.register(
        {
          name: BUNDLE_CONFIG_SLOT,
          key: PACKAGE_NAME,
          locale: PANEL_NS,
          inject: dependencies,
        },
        LarkSettingsPanel,
      ),
    );
    return () => dispose?.();
  }, 'dsh-im-lark: 插件页配置');
}

/** Cordis 客户端插件的名字：与包名一致（模块加载器的注册键也用它）。 */
export const name = PACKAGE_NAME;

/** 只依赖槽位、连接（RPC 载体）与文案。 */
export const inject = ['slots', 'connection', 'locale'] as const;
