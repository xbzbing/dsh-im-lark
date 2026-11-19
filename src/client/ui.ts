/**
 * 面板用到的宿主原语。取不到时退回朴素实现：插件是可选能力，白屏比少几个
 * 圆角严重得多。
 */

import { h, optionalRequire } from './platform.ts';

const UI = (optionalRequire('@deepseek-ai/dsh-client-ui-primitives') ?? {}) as Record<string, any>;

export const Button: any =
  UI.Button ??
  function ButtonFallback(props: any) {
    return h('button', { type: 'button', ...props }, props.children);
  };

export const Switch: any =
  UI.Switch ??
  function SwitchFallback({ checked, onChange, label, disabled }: any) {
    return h('input', {
      type: 'checkbox',
      checked,
      disabled,
      'aria-label': label,
      onChange: (event: any) => onChange?.(event.target.checked),
    });
  };

export const Input: any = UI.Input ?? function InputFallback(props: any) {
  return h('input', props);
};

export const StateDot: any =
  UI.StateDot ??
  function StateDotFallback() {
    return null;
  };

export const IconRefresh: any = UI.IconRefreshOutlineRegular ?? (() => null);
export const IconCheck: any = UI.IconCheckOutlineRegular ?? (() => null);
