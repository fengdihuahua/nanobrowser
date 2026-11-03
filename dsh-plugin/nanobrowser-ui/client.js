// The Web-side half of the Nanobrowser bundle: a left-sidebar entry and the page it opens.
//
// The page is a read-only control plane view. It polls one same-origin, authenticated summary from the Host; chat,
// approvals and skill execution stay in the Chrome side panel and in the model's tools.

window.__ModuleLoader__.load({
  id: '@local/nanobrowser-ui',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'nanobrowser';
    const PANEL_ID = 'nanobrowser';
    let t = key => key;

    const en = {
      panel: 'Nanobrowser',
      title: 'Nanobrowser',
      subtitle: 'Your Chrome, controlled by this Harness.',
      hub: 'Browser hub',
      connected: 'Connected',
      disconnected: 'Disconnected',
      port: 'Port',
      clients: 'Clients',
      leases: 'Leases',
      pending: 'Pending calls',
      sessions: 'Live sessions',
      skills: 'Browser skills',
      recent: 'Recent browser calls',
      noSessions: 'No live sessions.',
      noSkills: 'No saved browser skills.',
      noRecent: 'No browser calls yet.',
      noLease: 'no tab lease',
      lease: 'tab {tab}',
      steps: '{n} steps',
      refresh: 'Refresh',
      tabShort: 'tab {tab}',
      run: 'Run',
      runStart: 'Start',
      running: 'Running…',
      runCancel: 'Cancel',
      runNeedsLease: 'Attach a tab in a session first.',
      runFailed: 'Run failed',
      runDone: 'Done in {ms} ms',
      loading: 'Loading…',
      offline: 'The Nanobrowser host is not reachable.',
      note: 'Chat and approvals live in the Chrome side panel: open it and click DSH.',
    };
    const zh = {
      panel: 'Nanobrowser',
      title: 'Nanobrowser',
      subtitle: '这个 Harness 控制你的 Chrome。',
      hub: '浏览器 Hub',
      connected: '已连接',
      disconnected: '未连接',
      port: '端口',
      clients: '客户端',
      leases: '租约',
      pending: '待处理调用',
      sessions: '活动会话',
      skills: '页面技能',
      recent: '最近浏览器调用',
      noSessions: '没有活动会话。',
      noSkills: '还没有保存的页面技能。',
      noRecent: '还没有浏览器调用。',
      noLease: '没有标签租约',
      lease: '标签 {tab}',
      steps: '{n} 步',
      refresh: '刷新',
      tabShort: '标签 {tab}',
      run: '运行',
      runStart: '开始',
      running: '运行中…',
      runCancel: '取消',
      runNeedsLease: '请先在某个会话里 attach 一个标签页。',
      runFailed: '运行失败',
      runDone: '完成，用时 {ms} 毫秒',
      loading: '加载中…',
      offline: 'Nanobrowser 宿主不可达。',
      note: '聊天和审批在 Chrome 侧边栏：打开它并点击 DSH。',
    };

    const styles = {
      root: {
        height: '100%',
        overflow: 'auto',
        boxSizing: 'border-box',
        padding: '24px 28px',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        fontSize: 14,
      },
      header: { display: 'flex', alignItems: 'flex-start', gap: 12 },
      title: { margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em' },
      subtitle: { margin: '4px 0 0', fontSize: 13, color: 'var(--dsw-alias-label-secondary)' },
      button: {
        marginLeft: 'auto',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 8,
        padding: '4px 10px',
        fontSize: 12,
        cursor: 'pointer',
      },
      grid: {
        display: 'grid',
        gap: 12,
        marginTop: 18,
        gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 12,
        padding: '12px 14px',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      cardHeading: {
        margin: '0 0 8px',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-secondary)',
      },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '4px 0' },
      rowLabel: { color: 'var(--dsw-alias-label-secondary)', fontSize: 13 },
      rowValue: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 },
      dot: connected => ({
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: 999,
        background: connected ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)',
      }),
      rowBox: { padding: '6px 0', borderTop: '1px solid var(--dsw-alias-border-l1)' },
      rowMain: { minWidth: 0 },
      rowTitle: { fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      rowMeta: {
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      rowDescription: { marginTop: 2, fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.4 },
      recentRow: { display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 0', fontSize: 12 },
      recentTool: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
      recentTarget: {
        color: 'var(--dsw-alias-label-secondary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        maxWidth: 220,
      },
      recentMeta: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, whiteSpace: 'nowrap' },
      recentTime: { marginLeft: 'auto', color: 'var(--dsw-alias-label-secondary)', fontSize: 11, whiteSpace: 'nowrap' },
      recentError: {
        margin: '0 0 4px 22px',
        fontSize: 11,
        color: 'var(--dsw-alias-state-error-primary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      muted: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-secondary)' },
      smallButton: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 7,
        padding: '2px 8px',
        fontSize: 11,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      form: { marginTop: 6, display: 'grid', gap: 6 },
      field: { display: 'grid', gap: 2 },
      fieldLabel: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
      input: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 6,
        padding: '3px 6px',
        fontSize: 12,
        fontFamily: 'inherit',
      },
      runLine: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', display: 'flex', gap: 6 },
      runOk: { color: 'var(--dsw-alias-state-success-primary)' },
      runBad: { color: 'var(--dsw-alias-state-error-primary)' },
      error: { margin: '12px 0 0', fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
      note: {
        margin: '18px 0 0',
        paddingLeft: 10,
        borderLeft: '2px solid var(--dsw-alias-brand-primary)',
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
        lineHeight: 1.5,
      },
    };

    function PanelIcon() {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3 }),
        h('path', { d: 'M3 8h18' }),
        h('path', { d: 'M7 6.5h.01M10 6.5h.01' }),
        h('path', { d: 'M8 13l2.5 2L8 17' }),
        h('path', { d: 'M13 17h3' }),
      );
    }

    function card(heading, children) {
      return h('section', { style: styles.card }, h('h2', { style: styles.cardHeading }, heading), children);
    }

    /** The one thing a call was aimed at, from its bounded arguments. */
    function targetLabel(args) {
      if (!args) return '';
      if (typeof args.url === 'string') return args.url;
      if (typeof args.name === 'string') return `«${args.name}»`;
      if (typeof args.ref === 'string') return args.ref;
      if (typeof args.text === 'string') return `«${args.text.slice(0, 40)}»`;
      if (typeof args.value === 'string') return `= ${args.value.slice(0, 40)}`;
      return '';
    }

    function row(label, ...children) {
      return h(
        'div',
        { style: styles.row },
        h('span', { style: styles.rowLabel }, label),
        h('span', { style: styles.rowValue }, ...children),
      );
    }

    function PanelPage() {
      const [state, setState] = React.useState({ status: 'loading', data: null, error: null });
      const [tick, setTick] = React.useState(0);
      const [openSkill, setOpenSkill] = React.useState(null);
      const [paramValues, setParamValues] = React.useState({});
      const [runState, setRunState] = React.useState(null);

      React.useEffect(() => {
        let alive = true;
        let timer;
        const load = async () => {
          try {
            const response = await fetch('/nanobrowser/summary', { cache: 'no-store' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (alive) setState({ status: 'ready', data, error: null });
          } catch (error) {
            if (alive) {
              setState(previous => ({
                status: previous.data ? 'ready' : 'error',
                data: previous.data,
                error: String(error?.message ?? error),
              }));
            }
          }
        };
        void load();
        timer = setInterval(load, 3000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [tick]);

      const data = state.data;
      const hub = data?.hub;
      const leases = hub?.leases ?? [];
      const leaseFor = id => leases.find(lease => lease.clientId === id);

      /** Runs the skill on the session that holds a lease; its write steps still ask in the Chrome drawer. */
      const runSkillNow = async skill => {
        setRunState({ name: skill.name, busy: true, error: null, steps: [] });
        try {
          const response = await fetch('/nanobrowser/skill/run', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: skill.name, params: paramValues[skill.name] ?? {} }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || payload.ok === false) {
            throw new Error(payload.error ?? payload.result?.text ?? `HTTP ${response.status}`);
          }
          const result = payload.result ?? {};
          setRunState({
            name: skill.name,
            busy: false,
            error: null,
            steps: result.data?.steps ?? [],
            durationMs: result.data?.durationMs,
          });
          setTick(value => value + 1);
        } catch (error) {
          setRunState({ name: skill.name, busy: false, error: String(error?.message ?? error), steps: [] });
        }
      };

      return h(
        'div',
        { style: styles.root },
        h(
          'header',
          { style: styles.header },
          h(
            'div',
            null,
            h('h1', { style: styles.title }, t('title')),
            h('p', { style: styles.subtitle }, t('subtitle')),
          ),
          h(
            'button',
            { type: 'button', style: styles.button, onClick: () => setTick(value => value + 1) },
            t('refresh'),
          ),
        ),
        state.error ? h('p', { style: styles.error }, `${t('offline')} ${state.error}`) : null,
        data
          ? h(
              'div',
              { style: styles.grid },
              card(
                t('hub'),
                row(
                  t('connected'),
                  h('span', { style: styles.dot(hub.connected) }),
                  hub.connected ? t('connected') : t('disconnected'),
                ),
                row(t('port'), String(hub.port)),
                row(t('clients'), t('clients', { n: hub.clients })),
                row(t('leases'), t('leases', { n: leases.length })),
                row(t('pending'), t('pending', { n: hub.pendingCalls })),
              ),
              card(
                t('sessions'),
                data.sessions.length
                  ? data.sessions.map(session => {
                      const lease = leaseFor(session.id);
                      return h(
                        'div',
                        { key: session.id, style: styles.rowBox },
                        h(
                          'div',
                          { style: styles.rowMain },
                          h('div', { style: styles.rowTitle }, session.title || session.id),
                          h(
                            'div',
                            { style: styles.rowMeta },
                            `${session.running ? '● ' : ''}${session.status}` +
                              (lease ? ` · ${t('lease', { tab: lease.tabId ?? '?' })}` : ` · ${t('noLease')}`),
                          ),
                        ),
                      );
                    })
                  : h('p', { style: styles.muted }, t('noSessions')),
              ),
              card(
                t('skills'),
                data.skills.length
                  ? data.skills.map(skill => {
                      const open = openSkill === skill.name;
                      const busy = runState?.name === skill.name && runState.busy === true;
                      const values = paramValues[skill.name] ?? {};
                      const result = runState?.name === skill.name ? runState : null;
                      return h(
                        'div',
                        { key: skill.name, style: styles.rowBox },
                        h(
                          'div',
                          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                          h(
                            'div',
                            { style: styles.rowMain },
                            h('div', { style: styles.rowTitle }, skill.name),
                            h(
                              'div',
                              { style: styles.rowMeta },
                              `${t('steps', { n: skill.steps })}${skill.origin ? ` · ${skill.origin}` : ''}`,
                            ),
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              style: styles.smallButton,
                              onClick: () => setOpenSkill(open ? null : skill.name),
                            },
                            open ? t('runCancel') : t('run'),
                          ),
                        ),
                        skill.description ? h('div', { style: styles.rowDescription }, skill.description) : null,
                        open
                          ? h(
                              'div',
                              { style: styles.form },
                              ...(skill.params ?? []).map(param =>
                                h(
                                  'label',
                                  { key: param.name, style: styles.field },
                                  h('span', { style: styles.fieldLabel }, param.name + (param.required ? '' : '?')),
                                  h('input', {
                                    style: styles.input,
                                    value: values[param.name] ?? '',
                                    onChange: event => {
                                      const value = event.target.value;
                                      setParamValues(previous => ({
                                        ...previous,
                                        [skill.name]: { ...(previous[skill.name] ?? {}), [param.name]: value },
                                      }));
                                    },
                                  }),
                                ),
                              ),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  style: styles.smallButton,
                                  disabled: busy,
                                  onClick: () => runSkillNow(skill),
                                },
                                busy ? t('running') : t('runStart'),
                              ),
                              result && result.error
                                ? h('p', { style: styles.error }, `${t('runFailed')}: ${result.error}`)
                                : null,
                              result && result.steps.length
                                ? h(
                                    'div',
                                    null,
                                    h(
                                      'div',
                                      { style: styles.rowMeta },
                                      typeof result.durationMs === 'number'
                                        ? t('runDone', { ms: result.durationMs })
                                        : '',
                                    ),
                                    result.steps.map(step =>
                                      h(
                                        'div',
                                        { key: step.id, style: styles.runLine },
                                        h(
                                          'span',
                                          { style: step.ok ? styles.runOk : styles.runBad },
                                          step.ok ? '✓' : '✗',
                                        ),
                                        h('span', null, `${step.id ?? ''} · ${step.tool ?? ''}`),
                                        h('span', null, step.text ?? ''),
                                      ),
                                    ),
                                  )
                                : null,
                            )
                          : null,
                      );
                    })
                  : h('p', { style: styles.muted }, t('noSkills')),
              ),
              card(
                t('recent'),
                data.recent.length
                  ? data.recent
                      .slice()
                      .reverse()
                      .map((row, index) => {
                        const target = targetLabel(row.args);
                        return h(
                          'div',
                          { key: index },
                          h(
                            'div',
                            { style: styles.recentRow },
                            h('span', { 'aria-hidden': true }, row.ok === false ? '✗' : row.ok === true ? '✓' : '…'),
                            h('span', { style: styles.recentTool }, row.tool || ''),
                            target ? h('span', { style: styles.recentTarget }, target) : null,
                            row.tabId !== undefined
                              ? h('span', { style: styles.recentMeta }, t('tabShort', { tab: row.tabId }))
                              : null,
                            typeof row.ms === 'number' ? h('span', { style: styles.recentMeta }, `${row.ms} ms`) : null,
                            h('span', { style: styles.recentTime }, new Date(row.at).toLocaleTimeString()),
                          ),
                          row.ok === false && row.text ? h('div', { style: styles.recentError }, row.text) : null,
                        );
                      })
                  : h('p', { style: styles.muted }, t('noRecent')),
              ),
            )
          : h('p', { style: styles.muted }, t('loading')),
        h('p', { style: styles.note }, t('note')),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'nanobrowser: dictionaries');
        t = ctx.locale.bind(NS);
        ctx.slots.inject('main', function* () {
          yield ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, PanelPage);
        });
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 10,
              label: () => t('panel'),
              locale: NS,
            },
            PanelIcon,
          ),
        );
      },
    };
  },
});
