/**
 * 飞书机器人设置面板。
 *
 * 状态一律来自 host（面板不推断）：连接状态、核心是否可用、App ID 尾号都由
 * `status` 端点给；每个开关是显式动作，做完再用返回值刷新快照。
 *
 * 两条错误通道互不覆盖：`error` 属于动作失败，`notice` 属于成功回执；轮询失败
 * 只写 `error` 且不清掉 `notice`。
 */

import iconUrl from '../../assets/icon.svg';
import { ENDPOINTS, REFRESH_INTERVAL_MS } from './constants.ts';
import { dotOf, errorText, isContractMismatch } from './logic.ts';
import type { Translate } from './locales.ts';
import { h, useCallback, useEffect, useState } from './platform.ts';
import { ensureStyles } from './styles.ts';
import { Button, IconRefresh, Input, Switch } from './ui.ts';

interface Snapshot {
  contract: number;
  pluginVersion: string;
  status: {
    appIdTail: string | null;
    domain: string;
    enabled: boolean;
    superagent: boolean;
    connection: { state: string; reconnectAttempts?: number };
    coreAvailable: boolean;
    lastError?: string;
  };
  settings: {
    enabled: boolean;
    superagent: boolean;
    typingIndicator: boolean;
    replyStatus: boolean;
  };
  config: { domain: string; maxText: number };
}

export function LarkSettingsPanel(props: any) {
  ensureStyles();

  const t = props.t as Translate;
  const rpcCall = props.rpcCall as <T = Snapshot>(endpoint: string, payload?: unknown) => Promise<T>;

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [domain, setDomain] = useState('feishu');

  const applySnapshot = useCallback((next: Snapshot) => {
    setSnapshot(next);
    setDomain((current) => (current === '' ? next.status.domain : current));
  }, []);

  const refresh = useCallback(async (quiet = false) => {
    try {
      const next = await rpcCall<Snapshot>(ENDPOINTS.status);
      applySnapshot(next);
      if (!quiet) setError('');
    } catch (cause) {
      setError(errorText(t, cause));
    } finally {
      setLoading(false);
    }
  }, [applySnapshot, rpcCall, t]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh(true);
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const run = async (name: string, work: () => Promise<Snapshot | void>, success?: string) => {
    setBusy(name);
    setError('');
    setNotice('');
    try {
      const result = await work();
      if (result !== undefined) applySnapshot(result);
      if (success !== undefined) setNotice(success);
    } catch (cause) {
      setError(errorText(t, cause));
    } finally {
      setBusy('');
    }
  };

  const saveSettings = (patch: Record<string, unknown>) =>
    run('settings', async () => rpcCall<Snapshot>(ENDPOINTS.setSettings, patch));

  const toggle = (key: 'enabled' | 'superagent' | 'typingIndicator' | 'replyStatus', value: boolean) => {
    void saveSettings({ [key]: value });
  };

  const saveCredentials = () => {
    if (appId.trim() === '') {
      setError(t('credentials.appIdRequired'));
      return;
    }
    const firstSetup = snapshot?.status.appIdTail === null;
    if (appSecret.trim() === '' && firstSetup) {
      setError(t('credentials.appSecretRequired'));
      return;
    }
    void run(
      'credentials',
      async () =>
        rpcCall<Snapshot>(ENDPOINTS.saveCredentials, {
          appId: appId.trim(),
          ...(appSecret.trim() === '' ? {} : { appSecret: appSecret.trim() }),
          domain,
        }),
      t('credentials.saved'),
    ).then(() => setAppSecret(''));
  };

  const probe = () => {
    if (appId.trim() === '') {
      setError(t('credentials.appIdRequired'));
      return;
    }
    void run('probe', async () => {
      const result = await rpcCall<{ check: { ok: boolean; botName?: string; error?: string } }>(ENDPOINTS.probe, {
        appId: appId.trim(),
        ...(appSecret.trim() === '' ? {} : { appSecret: appSecret.trim() }),
        domain,
      });
      if (!result.check.ok) throw new Error(result.check.error ?? t('error.generic'));
      setNotice(
        result.check.botName === undefined
          ? t('credentials.probeOkNoName')
          : t('credentials.probeOk', { name: result.check.botName }),
      );
    });
  };

  const clearCredentials = () => {
    if (typeof window !== 'undefined' && !window.confirm(`${t('credentials.clear')}?`)) return;
    void run('clear', async () => rpcCall<Snapshot>(ENDPOINTS.clearCredentials), t('credentials.cleared'));
  };

  if (loading) {
    return h('div', { className: 'lark-root' }, h('div', { className: 'lark-loading' }, h('span', { className: 'lark-spinner' }), t('panel.loading')));
  }

  if (isContractMismatch(snapshot)) {
    return h('div', { className: 'lark-root' }, h('div', { className: 'lark-banner', 'data-tone': 'error' }, t('error.contract')));
  }

  const settings = snapshot?.settings;
  const status = snapshot?.status;
  const state = status?.connection.state ?? 'idle';
  const domainLabel = (snapshot?.config.domain ?? 'feishu') === 'lark' ? t('credentials.domainLark') : t('credentials.domainFeishu');
  const busySave = busy === 'credentials' || busy === 'probe' || busy === 'clear';

  return h(
    'div',
    { className: 'lark-root' },
    h(
      'div',
      { className: 'lark-hero' },
      h('img', { className: 'lark-hero-icon', src: iconUrl, alt: '' }),
      h(
        'div',
        { className: 'lark-hero-text' },
        h('div', { className: 'lark-hero-title' }, t('panel.title')),
        h('div', { className: 'lark-hero-sub' }, t('panel.subtitle')),
      ),
      h(
        'div',
        { className: 'lark-actions', style: { marginLeft: 'auto' } },
        h(Pill, { tone: toneOf(state), dot: true }, t(stateKey(state))),
        h(Button, { onClick: () => void refresh(), disabled: busy !== '', title: t('panel.refresh') }, h(IconRefresh, null)),
      ),
    ),

    error === '' ? null : h('div', { className: 'lark-banner', 'data-tone': 'error' }, error),
    notice === '' ? null : h('div', { className: 'lark-banner', 'data-tone': 'ok' }, notice),
    status?.lastError === undefined ? null : h('div', { className: 'lark-banner' }, status.lastError),

    h(
      'section',
      { className: 'lark-card' },
      h(
        'div',
        { className: 'lark-card-head' },
        h('div', { className: 'lark-card-title' }, t('status.title')),
        h(
          Button,
          {
            onClick: () => void run('reconnect', async () => rpcCall<Snapshot>(ENDPOINTS.reconnect)),
            disabled: busy !== '',
          },
          busy === 'reconnect' ? t('status.reconnecting') : t('status.reconnect'),
        ),
      ),
      h(
        'div',
        { className: 'lark-rows' },
        row(t('status.connection'), h(Pill, { tone: toneOf(state), dot: true }, t(stateKey(state)))),
        row(t('status.appId'), h('span', { className: 'lark-mono' }, status?.appIdTail === null ? t('status.notConfigured') : `…${status?.appIdTail ?? ''}`)),
        row(t('status.domain'), domainLabel),
      ),
      toggleRow(h(Switch, { checked: settings?.enabled === true, onChange: (value: boolean) => toggle('enabled', value), label: t('status.enabled') }), t('status.enabled'), t('status.enabledHint')),
      // 核心不可用时没有可接入的对象，直接不显示这个开关，避免一个永远打不开的控件。
      status?.coreAvailable === true
        ? toggleRow(
            h(Switch, {
              checked: settings?.superagent === true,
              onChange: (value: boolean) => toggle('superagent', value),
              label: t('status.superagent'),
            }),
            t('status.superagent'),
            t('status.superagentHint'),
          )
        : null,
    ),

    h(
      'section',
      { className: 'lark-card' },
      h('div', { className: 'lark-card-title' }, t('credentials.title')),
      h('div', { className: 'lark-card-hint' }, t('credentials.hint')),
      h(
        'div',
        { className: 'lark-grid-2' },
        field(
          t('credentials.appId'),
          h(Input, {
            className: 'lark-input',
            value: appId,
            placeholder: 'cli_…',
            spellCheck: false,
            autoComplete: 'off',
            onChange: (event: any) => setAppId(event.target.value),
          }),
        ),
        field(
          t('credentials.appSecret'),
          h(Input, {
            className: 'lark-input',
            type: 'password',
            value: appSecret,
            placeholder: snapshot?.status.appIdTail === null ? '' : t('credentials.appSecretPlaceholder'),
            autoComplete: 'new-password',
            onChange: (event: any) => setAppSecret(event.target.value),
          }),
        ),
      ),
      field(
        t('credentials.domain'),
        h(
          'select',
          {
            className: 'lark-input',
            value: domain,
            onChange: (event: any) => setDomain(event.target.value),
          },
          h('option', { value: 'feishu' }, t('credentials.domainFeishu')),
          h('option', { value: 'lark' }, t('credentials.domainLark')),
        ),
      ),
      h(
        'div',
        { className: 'lark-actions' },
        h(Button, { 'data-primary': 'true', disabled: busySave, onClick: saveCredentials }, busy === 'credentials' ? t('credentials.saving') : t('credentials.save')),
        h(Button, { disabled: busySave, onClick: probe }, busy === 'probe' ? t('credentials.probing') : t('credentials.probe')),
        h(Button, { 'data-danger': 'true', disabled: busySave || status?.appIdTail === null, onClick: clearCredentials }, t('credentials.clear')),
      ),
    ),

    h(
      'section',
      { className: 'lark-card' },
      h('div', { className: 'lark-card-title' }, t('behavior.title')),
      toggleRow(
        h(Switch, { checked: settings?.typingIndicator === true, onChange: (value: boolean) => toggle('typingIndicator', value), label: t('behavior.typing') }),
        t('behavior.typing'),
        t('behavior.typingHint'),
      ),
      toggleRow(
        h(Switch, { checked: settings?.replyStatus === true, onChange: (value: boolean) => toggle('replyStatus', value), label: t('behavior.replyStatus') }),
        t('behavior.replyStatus'),
        t('behavior.replyStatusHint'),
      ),
    ),
  );
}

function row(label: string, value: unknown) {
  return h('div', { className: 'lark-row' }, h('span', { className: 'lark-row-label' }, label), h('span', { className: 'lark-row-value' }, value));
}

function field(label: string, control: unknown) {
  return h('label', { className: 'lark-field' }, h('span', { className: 'lark-field-label' }, label), control);
}

function toggleRow(control: unknown, title: string, hint: string) {
  return h(
    'div',
    { className: 'lark-toggle' },
    h('div', { className: 'lark-toggle-text' }, h('span', null, title), h('span', { className: 'lark-toggle-hint' }, hint)),
    control,
  );
}

function Pill(props: { tone?: string; dot?: boolean; children?: unknown }) {
  return h(
    'span',
    { className: 'lark-pill', 'data-tone': props.tone },
    props.dot === true ? h('span', { className: 'lark-dot', 'aria-hidden': 'true' }) : null,
    props.children,
  );
}

function toneOf(state: string): string | undefined {
  const dot = dotOf(state);
  if (dot === 'done') return 'ok';
  if (dot === 'error') return 'bad';
  if (dot === 'ongoing') return 'warn';
  return undefined;
}

function stateKey(state: string): 'state.idle' | 'state.connecting' | 'state.connected' | 'state.reconnecting' | 'state.failed' {
  switch (state) {
    case 'connected':
      return 'state.connected';
    case 'connecting':
      return 'state.connecting';
    case 'reconnecting':
      return 'state.reconnecting';
    case 'failed':
      return 'state.failed';
    default:
      return 'state.idle';
  }
}
