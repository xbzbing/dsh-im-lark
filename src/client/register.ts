/**
 * 扫码创建应用的面板块：入口按钮、二维码/链接、过期提示与取消。
 *
 * 二维码在 host 端编码成模块矩阵，这里只负责画 SVG：白底 + 深色方块，保留
 * 4 个模块的静区。链接始终同时给出，扫码失败时还能复制到手机打开。
 */

import type { Translate } from './locales.ts';
import { h } from './platform.ts';
import { Button } from './ui.ts';

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

interface RegisterProps {
  registration: RegistrationSnapshot | null;
  busy: string;
  t: Translate;
  onStart(): void;
  onCancel(): void;
  onCopy(): void;
}

export function RegisterSection(props: RegisterProps) {
  const { registration, busy, t } = props;
  const waiting = registration?.state === 'waiting';

  return h(
    'div',
    { className: 'lark-register' },
    h(
      'div',
      { className: 'lark-register-head' },
      h('div', { className: 'lark-register-title' }, t('register.scan')),
      h(
        'div',
        { className: 'lark-actions' },
        waiting
          ? h(Button, { onClick: props.onCancel, disabled: busy !== '' }, busy === 'register-cancel' ? t('register.cancelling') : t('register.cancel'))
          : h(Button, { onClick: props.onStart, disabled: busy !== '', 'data-primary': 'true' }, busy === 'register' ? t('register.starting') : t('register.scan')),
      ),
    ),
    waiting && registration.url !== null
      ? h(WaitingPanel, { registration, t, onCopy: props.onCopy })
      : h('div', { className: 'lark-card-hint' }, t('register.scanHint')),
  );
}

function WaitingPanel(props: { registration: RegistrationSnapshot; t: Translate; onCopy(): void }) {
  const { registration, t } = props;
  const minutes =
    registration.expiresAt === null ? 10 : Math.max(1, Math.ceil((registration.expiresAt - Date.now()) / 60_000));

  return h(
    'div',
    { className: 'lark-register-body' },
    registration.qr === undefined || registration.qr === null
      ? null
      : h(QrCode, { qr: registration.qr, label: t('register.waiting') }),
    h(
      'div',
      { className: 'lark-register-info' },
      h('div', { className: 'lark-register-waiting' }, t('register.waiting')),
      h('div', { className: 'lark-card-hint' }, t('register.waitingHint')),
      h('div', { className: 'lark-card-hint' }, t('register.expires', { minutes })),
      h('div', { className: 'lark-register-link' }, h('a', { href: registration.url ?? '', target: '_blank', rel: 'noreferrer' }, registration.url)),
      h(
        'div',
        { className: 'lark-actions' },
        h('a', { className: 'lark-btn', href: registration.url ?? '', target: '_blank', rel: 'noreferrer' }, t('register.open')),
        h(Button, { onClick: props.onCopy }, t('register.copy')),
      ),
      h('div', { className: 'lark-card-hint' }, t('register.qrHint')),
    ),
  );
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
