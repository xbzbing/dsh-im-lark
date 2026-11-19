/**
 * 面板样式（一次性注入）。
 *
 * 颜色、圆角、层级全部取自 DSH 设计令牌；品牌感只靠图标，不把整页染色。层次
 * 用边框、间距和字号建立，避免一屏灰色大卡片。
 */

const STYLE_ID = 'dsh-im-lark-styles';

export const STYLES = `
.lark-root {
  box-sizing: border-box;
  width: min(100%, 720px);
  margin: 0 auto;
  padding: 4px 0 32px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family, inherit);
  font-size: 13px;
  line-height: 20px;
}
.lark-root *, .lark-root *:before, .lark-root *:after { box-sizing: border-box; }

.lark-hero { display: flex; align-items: center; gap: 12px; }
.lark-hero-icon { width: 36px; height: 36px; flex: none; }
.lark-hero-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.lark-hero-title { font-size: 16px; font-weight: 600; line-height: 24px; }
.lark-hero-sub { color: var(--dsw-alias-label-tertiary); }

.lark-card {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-l1, transparent);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.lark-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.lark-card-title { font-weight: 600; font-size: 13px; }
.lark-card-hint { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }

.lark-rows { display: flex; flex-direction: column; gap: 8px; }
.lark-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.lark-row-label { color: var(--dsw-alias-label-secondary); }
.lark-row-value { display: inline-flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
.lark-mono { font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }

.lark-pill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 1px 8px; border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px; line-height: 18px;
}
.lark-pill[data-tone="ok"] { color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary)); }
.lark-pill[data-tone="warn"] { color: var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-secondary)); }
.lark-pill[data-tone="bad"] { color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-secondary)); }
.lark-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

.lark-field { display: flex; flex-direction: column; gap: 6px; }
.lark-field-label { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.lark-input {
  width: 100%;
  padding: 6px 10px;
  border-radius: var(--dsw-radius-sm);
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-specific-input-major, transparent);
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 13px;
  line-height: 20px;
  outline: none;
}
.lark-input:focus { border-color: var(--dsw-alias-state-business-primary); }
.lark-input[data-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }

.lark-grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
@media (max-width: 560px) { .lark-grid-2 { grid-template-columns: 1fr; } }

.lark-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.lark-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 12px;
  border-radius: var(--dsw-radius-sm);
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: inherit; font-size: 13px; line-height: 20px;
  cursor: pointer;
}
.lark-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.lark-btn:disabled { opacity: .5; cursor: default; }
.lark-btn[data-primary="true"] {
  border-color: transparent;
  background: var(--dsw-alias-button-info-fill);
  color: var(--dsw-alias-label-on-color);
}
.lark-btn[data-danger="true"] { color: var(--dsw-alias-state-error-primary); }

.lark-toggle { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.lark-toggle-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.lark-toggle-hint { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }

.lark-banner {
  border-radius: var(--dsw-radius-md);
  padding: 8px 12px;
  font-size: 12px;
  line-height: 18px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.lark-banner[data-tone="error"] {
  color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-primary));
  background: var(--dsw-alias-state-error-bg, var(--dsw-alias-interactive-bg-hover));
}
.lark-banner[data-tone="ok"] { color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary)); }

.lark-loading { display: flex; align-items: center; gap: 10px; color: var(--dsw-alias-label-tertiary); padding: 24px 0; }
.lark-spinner {
  width: 16px; height: 16px; border-radius: 50%;
  border: 2px solid var(--dsw-alias-border-l2);
  border-top-color: var(--dsw-alias-state-business-primary);
  animation: lark-spin .8s linear infinite;
}
@keyframes lark-spin { to { transform: rotate(360deg); } }
`;

/** 注入一次样式；HMR 重放时按 id 去重。 */
export function ensureStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-im-lark';
  tag.dataset.pluginCss = STYLE_ID;
  tag.textContent = STYLES;
  document.head.appendChild(tag);
}
