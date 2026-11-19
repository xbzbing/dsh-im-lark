/**
 * 面板的宿主共享模块与渲染原语。
 *
 * 打包产物是单文件（`lib/client.js`），平台模块由宿主的模块表通过 `require`
 * 注入；没有 JSX（tsconfig 未开 `jsx`），统一 `createElement`。
 */

import * as React from 'react';

export const { useCallback, useEffect, useMemo, useRef, useState } = React;

export const h = React.createElement as unknown as (type: any, props?: any, ...children: any[]) => any;

/** 取宿主模块表里的模块；取不到返回 null，面板降级而不是白屏。 */
export function optionalRequire(name: string): any {
  try {
    return require(name);
  } catch {
    return null;
  }
}
