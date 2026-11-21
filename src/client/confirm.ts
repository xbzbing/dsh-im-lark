/**
 * 破坏性操作的确认对话框。
 *
 * 不用原生 `window.confirm`：那是浏览器自己的外观（系统语言、系统按钮），和
 * 面板的 DSH 主题割裂。这里照 DSH 自带确认弹窗的式样组装宿主的 `Modal`：
 * warning 标题、正文一到两段说明、底部「取消 / 确认」，初始焦点落在取消上。
 */

import { Fragment, h } from './platform.ts';
import { Button, Modal } from './ui.ts';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** 正文段落：第一段讲清动作，第二段讲后果。 */
  lines: string[];
  cancelLabel: string;
  confirmLabel: string;
  closeLabel: string;
  onCancel(): void;
  onConfirm(): void;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  return h(
    Modal,
    {
      open: props.open,
      tone: 'warning',
      title: props.title,
      closeLabel: props.closeLabel,
      onClose: props.onCancel,
      footer: h(
        Fragment,
        null,
        h(Button, { variant: 'outline', 'data-modal-autofocus': true, onClick: props.onCancel }, props.cancelLabel),
        h(Button, { variant: 'primary', onClick: props.onConfirm }, props.confirmLabel),
      ),
    },
    h(
      'div',
      { className: 'lark-confirm-copy' },
      props.lines.map((line, index) => h('p', { key: index }, line)),
    ),
  );
}
