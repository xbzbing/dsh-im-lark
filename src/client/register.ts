/**
 * 扫码创建应用：凭据卡片里的入口行，以及点开后的授权对话框。
 *
 * 二维码在 host 端编码成模块矩阵，这里只负责画 SVG：白底 + 深色方块，保留
 * 4 个模块的静区。授权链接不在界面上显示，只在「在飞书中打开」时交给浏览器；
 * 手机上直接用飞书扫码即可。
 */

import type { Translate } from './locales.ts';
import { h } from './platform.ts';
import { Button, Modal } from './ui.ts';

export interface QrMatrix {
  size: number;
  modules: number[];
}

export interface RegistrationSnapshot {
  state: 'idle' | 'waiting' | 'done' | 'error';
  url: string | null;
  expiresAt: number | null;
  error: string | null;
  appIdTail: string | null;
  /** 只有 `register.start` 的回执带二维码，轮询不重复传。 */
  qr?: QrMatrix | null;
}

interface EntryProps {
  busy: string;
  t: Translate;
  onOpen(): void;
}

/** 凭据卡片右栏：扫码创建入口，点开才发起授权。 */
export function RegisterEntry(props: EntryProps) {
  return h(
    'div',
    { className: 'lark-register' },
    h('div', { className: 'lark-register-title' }, props.t('register.scan')),
    h('div', { className: 'lark-card-hint' }, props.t('register.scanHint')),
    h(
      'div',
      { className: 'lark-register-action' },
      h(Button, { variant: 'outline', onClick: props.onOpen, disabled: props.busy !== '' }, props.t('register.entryAction')),
    ),
  );
}

interface DialogProps {
  open: boolean;
  registration: RegistrationSnapshot | null;
  busy: string;
  t: Translate;
  onClose(): void;
  onCancel(): void;
  onRetry(): void;
}

export function RegisterDialog(props: DialogProps) {
  const { registration, t } = props;
  const waiting = registration?.state === 'waiting';
  const failed = registration?.state === 'error';

  return h(
    Modal,
    {
      open: props.open,
      onClose: props.onClose,
      closeLabel: t('register.close'),
      title: t('register.scan'),
      footer: h(
        'div',
        { className: 'lark-modal-actions' },
        ...(waiting
          ? [
              h(
                Button,
                { variant: 'outline', onClick: props.onCancel, disabled: props.busy !== '' },
                props.busy === 'register-cancel' ? t('register.cancelling') : t('register.cancel'),
              ),
              h(Button, { variant: 'primary', onClick: () => openInFeishu(registration?.url ?? null) }, t('register.open')),
            ]
          : failed
            ? [
                h(Button, { variant: 'outline', onClick: props.onClose }, t('register.close')),
                h(Button, { variant: 'primary', onClick: props.onRetry }, t('register.retry')),
              ]
            : [h(Button, { variant: 'outline', onClick: props.onClose }, t('register.close'))]),
      ),
    },
    h(RegisterBody, { registration, t }),
  );
}

function RegisterBody(props: { registration: RegistrationSnapshot | null; t: Translate }) {
  const { registration, t } = props;
  if (registration?.state === 'waiting' && registration.qr) {
    const minutes = registration.expiresAt === null ? 10 : Math.max(1, Math.ceil((registration.expiresAt - Date.now()) / 60_000));
    return h(
      'div',
      { className: 'lark-register-modal' },
      h(QrCode, { qr: registration.qr, label: t('register.waiting') }),
      h(
        'div',
        { className: 'lark-register-info' },
        h('div', { className: 'lark-register-waiting' }, t('register.waiting')),
        h('div', { className: 'lark-card-hint' }, t('register.waitingHint')),
        h('div', { className: 'lark-card-hint' }, t('register.expires', { minutes })),
        h('div', { className: 'lark-card-hint' }, t('register.qrHint')),
      ),
    );
  }
  if (registration?.state === 'error') {
    return h('div', { className: 'lark-card-hint' }, registration.error ?? t('register.failed'));
  }
  if (registration?.state === 'done') {
    return h('div', { className: 'lark-card-hint' }, t('register.done', { appId: registration.appIdTail ?? '' }));
  }
  return h('div', { className: 'lark-card-hint' }, t('register.starting'));
}

/** 同机装了飞书时可以直接唤起；手机上还是扫码。 */
function openInFeishu(url: string | null): void {
  if (url === null || url === '' || typeof window === 'undefined') return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** 模块矩阵 → SVG path；一个模块一条 1×1 的矩形子路径。 */
export function QrCode(props: { qr: QrMatrix; label: string }) {
  const { size, modules } = props.qr;
  const parts: string[] = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (modules[y * size + x] === 1) parts.push(`M${x} ${y}h1v1h-1z`);
    }
  }
  const quiet = 4;
  const edge = size + quiet * 2;

  return h(
    'svg',
    {
      className: 'lark-qr',
      viewBox: `${-quiet} ${-quiet} ${edge} ${edge}`,
      role: 'img',
      'aria-label': props.label,
      shapeRendering: 'crispEdges',
    },
    h('rect', { x: -quiet, y: -quiet, width: edge, height: edge, fill: '#fff' }),
    h('path', { d: parts.join(''), fill: '#000' }),
  );
}
