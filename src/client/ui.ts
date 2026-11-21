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

/** 宿主对话框。取不到时退回一个够用的遮罩，流程不至于中断。 */
export const Modal: any =
  UI.Modal ??
  function ModalFallback({ open, onClose, title, children, footer }: any) {
    if (!open) return null;
    return h(
      'div',
      { className: 'lark-modal-fallback', role: 'dialog', 'aria-modal': 'true' },
      h(
        'div',
        { className: 'lark-modal-fallback-panel' },
        h('div', { className: 'lark-register-title' }, title),
        children,
        footer,
        h('button', { type: 'button', className: 'lark-btn', onClick: onClose }, '×'),
      ),
    );
  };

export const StateDot: any =
  UI.StateDot ??
  function StateDotFallback() {
    return null;
  };

/** 宿主菜单浮层。取不到时为 null，调用方退回原生控件而不是白屏。 */
export const MenuSurface: any = UI.MenuSurface ?? null;

export const IconRefresh: any = UI.IconRefreshOutlineRegular ?? (() => null);
export const IconCheck: any = UI.IconCheckOutlineRegular ?? (() => null);
/** 没有箭头就不画，比画一个空图标干净。 */
export const IconChevronDown: any = UI.IconChevronDownOutlineRegular ?? null;
