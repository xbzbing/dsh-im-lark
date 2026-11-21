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
.lark-version { margin-left: 8px; color: var(--dsw-alias-label-tertiary); font-size: 12px; font-weight: 400; letter-spacing: 0; vertical-align: middle; }
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
.lark-card-heading { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.lark-disclosure { flex: none; color: var(--dsw-alias-label-secondary); }
.lark-disclosure svg { transition: transform .15s ease; }
.lark-disclosure[aria-expanded="true"] svg { transform: rotate(180deg); }
.lark-credentials-body { display: flex; flex-direction: column; gap: 12px; }

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

.lark-field-row { display: grid; grid-template-columns: 96px minmax(0, 1fr); align-items: center; gap: 12px; }
.lark-field-row-label { color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
.lark-field-row-control { min-width: 0; }
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
.lark-inline-save { display: flex; align-items: center; gap: 8px; }
.lark-input-narrow { width: 88px; flex: none; }
.lark-unit { color: var(--dsw-alias-label-tertiary); font-size: 12px; }

@media (max-width: 560px) { .lark-field-row { grid-template-columns: 1fr; gap: 6px; } }

.lark-select { position: relative; min-width: 0; }
.lark-select-trigger {
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
  cursor: pointer; text-align: left;
}
.lark-select-trigger:disabled { cursor: default; }
.lark-select-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lark-select-menu {
  z-index: 1000;
  display: flex; flex-direction: column;
  padding: 4px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-panel);
  border: 1px solid var(--dsw-alias-border-l1);
}
.lark-select-option {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  height: 32px; padding: 0 8px;
  border-radius: var(--dsw-radius-sm);
  cursor: pointer;
}
.lark-select-option:hover, .lark-select-option[data-active="true"] { background: var(--dsw-alias-interactive-bg-hover); }
.lark-select-option[aria-selected="true"] { font-weight: 600; }

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
.lark-danger { color: var(--dsw-alias-state-error-primary); }

.lark-credentials { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(220px, .65fr); gap: 16px; align-items: stretch; }
.lark-credentials-main { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.lark-credentials-label { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.lark-register { display: flex; flex-direction: column; gap: 8px; height: 100%; box-sizing: border-box; border: 1px dashed var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md); padding: 14px; background: var(--dsw-alias-interactive-bg-hover); }
.lark-register-title { font-weight: 600; }
.lark-register-action { margin-top: auto; }
@media (max-width: 720px) { .lark-credentials { grid-template-columns: 1fr; } }
.lark-register-modal { display: flex; flex-direction: column; align-items: center; gap: 18px; padding: 4px 0 8px; text-align: center; }
.lark-register-info { display: flex; flex-direction: column; align-items: center; gap: 6px; max-width: 340px; }
.lark-register-waiting { font-weight: 600; font-size: 15px; line-height: 22px; }
.lark-register-modal .lark-card-hint { text-align: center; }
.lark-qr { width: 216px; height: 216px; flex: none; border-radius: 12px; background: #fff; padding: 10px; box-shadow: 0 0 0 1px var(--dsw-alias-border-l2), 0 1px 2px rgba(0, 0, 0, .06); }
.lark-modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
.lark-confirm-copy { color: var(--dsw-alias-label-secondary); font-size: 14px; line-height: 22px; }
.lark-confirm-copy p { margin: 0; }
.lark-confirm-copy p + p { margin-top: 12px; }
.lark-modal-fallback { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, .4); }
.lark-modal-fallback-panel { display: flex; flex-direction: column; gap: 12px; max-width: 440px; padding: 20px; border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #fff); }

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
