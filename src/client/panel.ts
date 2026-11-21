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
import { ConfirmDialog } from './confirm.ts';
import { ENDPOINTS, REFRESH_INTERVAL_MS, REGISTER_POLL_MS } from './constants.ts';
import { dotOf, errorText, isContractMismatch } from './logic.ts';
import type { Translate } from './locales.ts';
import { h, useCallback, useEffect, useRef, useState } from './platform.ts';
import { RegisterDialog, RegisterEntry } from './register.ts';
import type { RegistrationSnapshot } from './register.ts';
import { ensureStyles } from './styles.ts';
import { Button, IconCheck, IconChevronDown, IconRefresh, Input, MenuSurface, Switch } from './ui.ts';

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
    directBusyMode: 'queue' | 'steer';
    directWorkspaceId: string;
    questionReminders: boolean;
    questionDelayMinutes: number;
  };
  reminders: {
    pendingQuestions: number;
    pendingApprovals: number;
    lastError?: { at: number; message: string };
  };
  config: { domain: string; maxText: number };
}

/** 面板的工作区候选；宿主没有这个服务时 available=false。 */
interface WorkspaceCatalog {
  items: { id: string; title: string; path: string }[];
  available: boolean;
  reason?: string;
  defaultId: string;
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
  const [registration, setRegistration] = useState<RegistrationSnapshot | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  /** 清除凭据的确认框：原生 confirm 是系统外观，和面板主题不一致。 */
  const [clearOpen, setClearOpen] = useState(false);
  /** 对话框是否还开着：发起授权是异步的，关掉之后回来的结果要自己取消。 */
  const registerOpenRef = useRef(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceCatalog | null>(null);
  /** 提醒延迟的草稿：首次读到设置时填一次，之后不覆盖用户输入。 */
  const [delay, setDelay] = useState<string | null>(null);

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

  const loadWorkspaces = useCallback(async () => {
    try {
      setWorkspaces(await rpcCall<WorkspaceCatalog>(ENDPOINTS.workspacesList));
    } catch {
      // 工作区列表读不到只影响选择器；面板其它部分照常可用。
    }
  }, [rpcCall]);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  const delayValue = snapshot?.settings.questionDelayMinutes;
  useEffect(() => {
    if (delayValue === undefined) return;
    setDelay((current) => current ?? String(delayValue));
  }, [delayValue]);

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

  const startRegistration = () => {
    registerOpenRef.current = true;
    setRegisterOpen(true);
    void run('register', async () => {
      const result = await rpcCall<{ registration: RegistrationSnapshot }>(ENDPOINTS.registerStart, { domain });
      setRegistration(result.registration);
      // 生成期间对话框已被关掉：别把二维码留在 host 上等它过期。
      if (!registerOpenRef.current) cancelRegistration();
    });
  };

  const cancelRegistration = () => {
    void run('register-cancel', async () => {
      const result = await rpcCall<{ registration: RegistrationSnapshot }>(ENDPOINTS.registerCancel);
      setRegistration(result.registration);
    });
  };

  /** 关对话框就结束这次授权：二维码不该在后台继续有效。 */
  const closeRegistration = () => {
    registerOpenRef.current = false;
    setRegisterOpen(false);
    if (registration?.state === 'waiting') cancelRegistration();
  };

  const registrationState = registration?.state;
  useEffect(() => {
    if (registrationState !== 'waiting') return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async (): Promise<void> => {
      try {
        const result = await rpcCall<{ registration: RegistrationSnapshot }>(ENDPOINTS.registerPoll);
        if (disposed) return;
        setRegistration((current) =>
          current === null ? current : { ...current, ...result.registration, qr: result.registration.qr ?? current.qr },
        );
        if (result.registration.state === 'done') {
          registerOpenRef.current = false;
          setRegisterOpen(false);
          setNotice(t('register.done', { appId: result.registration.appIdTail ?? '' }));
          await refresh(true);
        } else if (result.registration.state === 'error') {
          setError(result.registration.error ?? t('register.failed'));
        }
      } catch (cause) {
        if (!disposed) setError(errorText(t, cause));
      } finally {
        if (!disposed) timer = setTimeout(tick, REGISTER_POLL_MS);
      }
    };

    timer = setTimeout(tick, REGISTER_POLL_MS);
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [registrationState, rpcCall, refresh, t]);

  const saveSettings = (patch: Record<string, unknown>) =>
    run('settings', async () => rpcCall<Snapshot>(ENDPOINTS.setSettings, patch));

  const toggle = (key: 'enabled' | 'superagent' | 'typingIndicator' | 'replyStatus' | 'questionReminders', value: boolean) => {
    void saveSettings({ [key]: value });
  };

  /** 独立模式的设置（插话 / 工作区）：保存后立即用返回值刷新。 */
  const saveDirect = (patch: { directBusyMode?: 'steer' | 'queue'; directWorkspaceId?: string }) => {
    void run('direct', async () => rpcCall<Snapshot>(ENDPOINTS.setSettings, patch), t('common.saved'));
  };

  const delayText = (delay ?? '').trim();
  const delayNumber = Number(delayText);
  const delayValid = /^\d+$/u.test(delayText) && delayNumber >= 0 && delayNumber <= 120;

  const saveDelay = () => {
    if (!delayValid) return;
    void run(
      'delay',
      async () => {
        const result = await rpcCall<Snapshot>(ENDPOINTS.setSettings, { questionDelayMinutes: delayNumber });
        setDelay(String(delayNumber));
        return result;
      },
      t('common.saved'),
    );
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
    if (snapshot?.status.appIdTail === null || snapshot === null) return;
    setClearOpen(true);
  };

  const confirmClearCredentials = () => {
    setClearOpen(false);
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
  const busySave =
    busy === 'credentials' || busy === 'probe' || busy === 'clear' || busy === 'register' || busy === 'register-cancel';

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
        h(
          'div',
          { className: 'lark-hero-title' },
          t('panel.title'),
          snapshot === null ? null : h('span', { className: 'lark-version' }, `v${snapshot.pluginVersion}`),
        ),
        h('div', { className: 'lark-hero-sub' }, t('panel.subtitle')),
      ),
      h(
        'div',
        { className: 'lark-actions', style: { marginLeft: 'auto' } },
        h(Pill, { tone: toneOf(state), dot: true }, t(stateKey(state))),
        h(Button, { variant: 'ghost', onClick: () => void refresh(), disabled: busy !== '', title: t('panel.refresh') }, h(IconRefresh, null)),
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
            variant: 'outline',
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
      h(RegisterDialog, {
        open: registerOpen,
        registration,
        busy,
        t,
        onClose: closeRegistration,
        onCancel: cancelRegistration,
        onRetry: startRegistration,
      }),
      h(ConfirmDialog, {
        open: clearOpen,
        title: t('credentials.clearTitle'),
        lines: [t('credentials.clearHint', { appId: status?.appIdTail ?? '' }), t('credentials.clearWarning')],
        cancelLabel: t('common.cancel'),
        confirmLabel: t('credentials.clearConfirm'),
        closeLabel: t('common.close'),
        onCancel: () => setClearOpen(false),
        onConfirm: confirmClearCredentials,
      }),
      h(
        'div',
        { className: 'lark-credentials' },
        h(
          'div',
          { className: 'lark-credentials-main' },
          h('div', { className: 'lark-credentials-label' }, t('credentials.manual')),
          fieldRow(
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
          fieldRow(
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
          fieldRow(
            t('credentials.domain'),
            h(PlatformSelect, { value: domain, onChange: (next: string) => setDomain(next), t }),
          ),
          h(
            'div',
            { className: 'lark-actions' },
            h(Button, { variant: 'primary', disabled: busySave, onClick: saveCredentials }, busy === 'credentials' ? t('credentials.saving') : t('credentials.save')),
            h(Button, { variant: 'outline', disabled: busySave, onClick: probe }, busy === 'probe' ? t('credentials.probing') : t('credentials.probe')),
            h(Button, { variant: 'outline', className: 'lark-danger', disabled: busySave || status?.appIdTail === null, onClick: clearCredentials }, t('credentials.clear')),
          ),
        ),
        h(RegisterEntry, { busy, t, onOpen: startRegistration }),
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

    h(
      'section',
      { className: 'lark-card' },
      h('div', { className: 'lark-card-title' }, t('direct.title')),
      h('div', { className: 'lark-card-hint' }, t('direct.hint')),
      toggleRow(
        h(Switch, {
          checked: settings?.directBusyMode === 'steer',
          disabled: settings?.superagent === true || busy !== '',
          onChange: (value: boolean) => saveDirect({ directBusyMode: value ? 'steer' : 'queue' }),
          label: t('direct.steer'),
        }),
        t('direct.steer'),
        t('direct.steerHint'),
      ),
      fieldRow(
        t('direct.workspace'),
        h(MenuSelect, {
          value: settings?.directWorkspaceId ?? '',
          options: workspaceOptions(workspaces, settings?.directWorkspaceId ?? '', t),
          disabled: settings?.superagent === true || workspaces?.available !== true || busy !== '',
          onChange: (next: string) => {
            saveDirect({ directWorkspaceId: next });
            void loadWorkspaces();
          },
        }),
      ),
      h(
        'div',
        { className: 'lark-card-hint' },
        workspaces?.available === false
          ? workspaces.reason ?? t('direct.workspaceUnavailable')
          : t('direct.workspaceHint'),
      ),
    ),

    h(
      'section',
      { className: 'lark-card' },
      h('div', { className: 'lark-card-title' }, t('reminder.title')),
      h('div', { className: 'lark-card-hint' }, t('reminder.hint')),
      toggleRow(
        h(Switch, {
          checked: settings?.questionReminders === true,
          disabled: settings?.superagent === true || busy !== '',
          onChange: (value: boolean) => toggle('questionReminders', value),
          label: t('reminder.enabled'),
        }),
        t('reminder.enabled'),
        settings?.superagent === true ? t('reminder.coreHint') : t('reminder.enabledHint'),
      ),
      fieldRow(
        t('reminder.delay'),
        h(
          'div',
          { className: 'lark-inline-save' },
          h(Input, {
            className: 'lark-input lark-input-narrow',
            value: delay ?? '',
            inputMode: 'numeric',
            disabled: settings?.superagent === true || settings?.questionReminders !== true,
            onChange: (event: any) => setDelay(event.target.value),
          }),
          h('span', { className: 'lark-unit' }, t('common.minutes')),
          h(
            Button,
            {
              variant: 'outline',
              disabled: busy !== '' || settings?.superagent === true || settings?.questionReminders !== true || !delayValid,
              onClick: saveDelay,
            },
            t('common.save'),
          ),
        ),
      ),
      delayText !== '' && !delayValid
        ? h('div', { className: 'lark-banner', 'data-tone': 'error' }, t('reminder.delayInvalid'))
        : null,
      (snapshot?.reminders.pendingQuestions ?? 0) + (snapshot?.reminders.pendingApprovals ?? 0) > 0
        ? h(
            'div',
            { className: 'lark-card-hint' },
            t('reminder.pending', {
              questions: snapshot?.reminders.pendingQuestions ?? 0,
              approvals: snapshot?.reminders.pendingApprovals ?? 0,
            }),
          )
        : null,
      snapshot?.reminders.lastError === undefined
        ? null
        : h('div', { className: 'lark-card-hint' }, snapshot.reminders.lastError.message),
    ),
  );
}

/** 工作区下拉的候选：默认项固定在最前；已选但已被删掉的工作区仍然显示。 */
function workspaceOptions(catalog: WorkspaceCatalog | null, current: string, t: Translate) {
  const options: { value: string; label: string }[] = [{ value: '', label: t('direct.workspaceDefault') }];
  for (const item of catalog?.items ?? []) options.push({ value: item.id, label: item.title });
  if (current !== '' && !options.some((option) => option.value === current)) {
    options.push({ value: current, label: t('direct.workspaceMissing') });
  }
  return options;
}

function row(label: string, value: unknown) {
  return h('div', { className: 'lark-row' }, h('span', { className: 'lark-row-label' }, label), h('span', { className: 'lark-row-value' }, value));
}

/** 一行一个字段：label 定宽在左，控件吃满剩余宽度。 */
function fieldRow(label: string, control: unknown) {
  return h(
    'div',
    { className: 'lark-field-row' },
    h('span', { className: 'lark-field-row-label' }, label),
    h('div', { className: 'lark-field-row-control' }, control),
  );
}

const DOMAIN_OPTIONS = ['feishu', 'lark'] as const;

interface SelectOption {
  value: string;
  label: string;
}

/** 浮层选择：宿主 MenuSurface + 固定定位；取不到原语时退回原生 select。 */
function MenuSelect(props: {
  value: string;
  options: readonly SelectOption[];
  onChange(next: string): void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const { value, options, onChange, disabled = false, placeholder = '' } = props;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [box, setBox] = useState<{ left: number; top: number; width: number } | null>(null);
  const triggerRef = useRef<any>(null);
  const menuRef = useRef<any>(null);

  const labelOf = (next: string) => options.find((option) => option.value === next)?.label ?? placeholder;

  const show = () => {
    if (disabled) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    setBox({ left: rect.left, top: rect.bottom + 4, width: rect.width });
    setActive(Math.max(0, options.findIndex((option) => option.value === value)));
    setOpen(true);
  };

  const pick = (next: string) => {
    setOpen(false);
    onChange(next);
    triggerRef.current?.focus?.();
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: any) => {
      if (triggerRef.current?.contains(event.target) === true) return;
      if (menuRef.current?.contains(event.target) === true) return;
      setOpen(false);
    };
    const onKeyDown = (event: any) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus?.();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive((index) => (index + step + options.length) % Math.max(1, options.length));
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        const option = options[active];
        if (option !== undefined) pick(option.value);
      } else if (event.key === 'Tab') {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, active, value, onChange, options, disabled]);

  if (MenuSurface === null) {
    return h(
      'select',
      { className: 'lark-input', value, disabled, onChange: (event: any) => onChange(event.target.value) },
      options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
    );
  }

  return h(
    'div',
    { className: 'lark-select' },
    h(
      'button',
      {
        ref: triggerRef,
        type: 'button',
        className: 'lark-input lark-select-trigger',
        disabled,
        'aria-haspopup': 'listbox',
        'aria-expanded': open,
        onClick: () => (open ? setOpen(false) : show()),
      },
      h('span', { className: 'lark-select-value' }, labelOf(value)),
      IconChevronDown === null ? null : h(IconChevronDown, { size: 14 }),
    ),
    open && box !== null
      ? h(
          MenuSurface,
          {
            ref: menuRef,
            className: 'lark-select-menu',
            role: 'listbox',
            tabIndex: -1,
            style: { position: 'fixed', left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px` },
          },
          options.map((option, index) =>
            h(
              'div',
              {
                key: option.value,
                className: 'lark-select-option',
                role: 'option',
                'aria-selected': option.value === value,
                'data-active': index === active,
                onPointerEnter: () => setActive(index),
                onClick: () => pick(option.value),
              },
              h('span', null, option.label),
              option.value === value && IconCheck !== null ? h(IconCheck, { size: 14 }) : null,
            ),
          ),
        )
      : null,
  );
}

/** 平台选择：飞书（中国）/ Lark（国际）。 */
function PlatformSelect(props: { value: string; onChange(next: string): void; t: Translate }) {
  const options = DOMAIN_OPTIONS.map((domain) => ({
    value: domain,
    label: props.t(domain === 'lark' ? 'credentials.domainLark' : 'credentials.domainFeishu'),
  }));
  return h(MenuSelect, { value: props.value, options, onChange: props.onChange });
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
