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
      age: '{n}s ago',
      lastSeen: 'last poll {n}s ago',
      port: 'Port',
      clients: 'Clients',
      leases: 'Leases',
      pending: 'Pending calls',
      sessions: 'Live sessions',
      skills: 'Browser skills',
      audit: 'Audit log',
      allSessions: 'All sessions',
      allTabs: 'All tabs',
      filterSession: 'Session',
      filterTab: 'Tab',
      filterLimit: 'Calls',
      export: 'Export CSV',
      auditEmpty: 'No calls match these filters.',
      noSessions: 'No live sessions.',
      noSkills: 'No saved browser skills.',
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
      files: 'Files',
      dryRun: 'Dry run (resolve, do not act)',
      learned: '{n} learned',
      detailFailed: 'Could not read the skill',
      folder: 'Folder',
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
      age: '{n} 秒前',
      lastSeen: '上次轮询 {n} 秒前',
      port: '端口',
      clients: '客户端',
      leases: '租约',
      pending: '待处理调用',
      sessions: '活动会话',
      skills: '页面技能',
      audit: '审计日志',
      allSessions: '全部会话',
      allTabs: '全部标签页',
      filterSession: '会话',
      filterTab: '标签页',
      filterLimit: '条数',
      export: '导出 CSV',
      auditEmpty: '没有符合条件的调用。',
      noSessions: '没有活动会话。',
      noSkills: '还没有保存的页面技能。',
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
      files: '文件',
      dryRun: '只预检（只解析，不动页面）',
      learned: '学到 {n} 条',
      detailFailed: '读不到这个技能',
      folder: '目录',
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
      link: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        margin: '10px 0 0',
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
      },
      filters: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8, marginBottom: 8 },
      filterField: { display: 'grid', gap: 2 },
      select: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 6,
        padding: '3px 6px',
        fontSize: 12,
        fontFamily: 'inherit',
        maxWidth: 180,
      },
      detail: {
        marginTop: 8,
        paddingTop: 8,
        borderTop: '1px dashed var(--dsw-alias-border-l1)',
        display: 'grid',
        gap: 6,
      },
      folder: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' },
      pre: {
        margin: 0,
        maxHeight: 220,
        overflow: 'auto',
        padding: '6px 8px',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-base)',
        fontSize: 11,
        lineHeight: 1.45,
        whiteSpace: 'pre-wrap',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        color: 'var(--dsw-alias-label-secondary)',
      },
      check: { display: 'flex', alignItems: 'center', gap: 6 },
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

    function card(heading, ...children) {
      return h('section', { style: styles.card }, h('h2', { style: styles.cardHeading }, heading), ...children);
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
      const [dryRuns, setDryRuns] = React.useState({});
      const [openFiles, setOpenFiles] = React.useState(null);
      const [files, setFiles] = React.useState(null);
      const [log, setLog] = React.useState({ rows: [], error: null });
      const [filter, setFilter] = React.useState({ session: '', tab: '', limit: 100 });

      React.useEffect(() => {
        let alive = true;
        let timer;
        // The audit is read separately: it has its own filter, and the summary must stay small.
        const loadLog = async () => {
          const query = new URLSearchParams({ limit: String(filter.limit) });
          if (filter.session) query.set('session', filter.session);
          if (filter.tab) query.set('tab', String(filter.tab));
          try {
            const response = await fetch(`/nanobrowser/audit?${query}`, { cache: 'no-store' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            if (alive) setLog({ rows: payload.rows ?? [], error: null });
          } catch (error) {
            if (alive) setLog(previous => ({ ...previous, error: String(error?.message ?? error) }));
          }
        };
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
          await loadLog();
        };
        void load();
        timer = setInterval(load, 3000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [tick, filter]);

      const data = state.data;
      const hub = data?.hub;
      // How long ago the extension last polled: what makes "disconnected" say how bad it is, and "connected" say it
      // is live rather than merely true once.
      const linkAge = hub?.lastPollAt ? Math.max(0, Math.round((Date.now() - hub.lastPollAt) / 1000)) : null;
      const leases = hub?.leases ?? [];
      const leaseFor = id => leases.find(lease => lease.clientId === id);
      // The filters offer what the page can know: the live sessions and leases, plus whatever the audit itself mentions.
      const sessionIds = [
        ...new Set([...(data?.sessions ?? []).map(session => session.id), ...log.rows.map(row => row.sessionId)]),
      ].filter(Boolean);
      const tabIds = [
        ...new Set([
          ...(hub?.leases ?? []).map(lease => lease.tabId ?? lease.tabs?.[0]),
          ...log.rows.map(row => row.tabId),
        ]),
      ].filter(tab => tab !== undefined && tab !== null);

      /** Runs the skill on the session that holds a lease; its write steps still ask in the Chrome drawer. */
      const runSkillNow = async skill => {
        setRunState({ name: skill.name, busy: true, error: null, steps: [] });
        try {
          const response = await fetch('/nanobrowser/skill/run', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              name: skill.name,
              params: paramValues[skill.name] ?? {},
              dryRun: dryRuns[skill.name] === true,
            }),
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

      /** Downloads the filtered audit as CSV. The page fetches it, so the same guard applies as to every other read. */
      const exportLog = async () => {
        const query = new URLSearchParams({ format: 'csv', limit: String(filter.limit) });
        if (filter.session) query.set('session', filter.session);
        if (filter.tab) query.set('tab', String(filter.tab));
        try {
          const response = await fetch(`/nanobrowser/audit?${query}`, { cache: 'no-store' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const text = await response.text();
          const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
          const link = document.createElement('a');
          link.href = url;
          link.download = 'nanobrowser-audit.csv';
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (error) {
          setLog(previous => ({ ...previous, error: String(error?.message ?? error) }));
        }
      };

      /** Opens one skill's files: its SKILL.md, its recipe, and what it learned. Read-only; editing is a file job. */
      const toggleFiles = async skill => {
        if (openFiles === skill.name) {
          setOpenFiles(null);
          return;
        }
        setOpenFiles(skill.name);
        if (files?.name === skill.name && files.data) return;
        setFiles({ name: skill.name, busy: true, data: null, error: null });
        try {
          const response = await fetch(`/nanobrowser/skill?name=${encodeURIComponent(skill.name)}`, {
            cache: 'no-store',
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || payload.ok === false) throw new Error(payload.error ?? `HTTP ${response.status}`);
          setFiles({ name: skill.name, busy: false, data: payload, error: null });
        } catch (error) {
          setFiles({ name: skill.name, busy: false, data: null, error: String(error?.message ?? error) });
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
              'p',
              { style: styles.link },
              h('span', { style: styles.dot(hub?.connected === true) }),
              hub?.connected
                ? `${t('connected')}${linkAge === null ? '' : ` · ${t('age', { n: linkAge })}`}`
                : `${t('disconnected')}${linkAge === null ? '' : ` · ${t('lastSeen', { n: linkAge })}`}`,
            )
          : null,
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
                              `${t('steps', { n: skill.steps })}${skill.origin ? ` · ${skill.origin}` : ''}` +
                                (skill.learned ? ` · ${t('learned', { n: skill.learned })}` : ''),
                            ),
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              style: styles.smallButton,
                              onClick: () => void toggleFiles(skill),
                            },
                            t('files'),
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
                        openFiles === skill.name
                          ? h(
                              'div',
                              { style: styles.detail },
                              files?.busy
                                ? h('p', { style: styles.muted }, t('loading'))
                                : files?.error
                                  ? h('p', { style: styles.error }, `${t('detailFailed')}: ${files.error}`)
                                  : files?.data
                                    ? h(
                                        'div',
                                        { style: styles.detail },
                                        h('div', { style: styles.folder }, `${t('folder')}: ${files.data.dir}`),
                                        files.data.learned?.length
                                          ? h(
                                              'div',
                                              null,
                                              h(
                                                'div',
                                                { style: styles.rowMeta },
                                                t('learned', { n: files.data.learned.length }),
                                              ),
                                              files.data.learned.map((note, index) =>
                                                h('div', { key: index, style: styles.runLine }, note),
                                              ),
                                            )
                                          : null,
                                        h('pre', { style: styles.pre }, files.data.content ?? ''),
                                        h(
                                          'pre',
                                          { style: styles.pre },
                                          JSON.stringify(files.data.recipe ?? {}, null, 2),
                                        ),
                                      )
                                    : null,
                            )
                          : null,
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
                                'label',
                                { style: styles.check },
                                h('input', {
                                  type: 'checkbox',
                                  checked: dryRuns[skill.name] === true,
                                  onChange: event => {
                                    const checked = event.target.checked;
                                    setDryRuns(previous => ({ ...previous, [skill.name]: checked }));
                                  },
                                }),
                                h('span', { style: styles.fieldLabel }, t('dryRun')),
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
                t('audit'),
                h(
                  'div',
                  { style: styles.filters },
                  h(
                    'label',
                    { style: styles.filterField },
                    h('span', { style: styles.fieldLabel }, t('filterSession')),
                    h(
                      'select',
                      {
                        style: styles.select,
                        value: filter.session,
                        onChange: event => {
                          const session = event.target.value;
                          setFilter(previous => ({ ...previous, session }));
                        },
                      },
                      h('option', { value: '' }, t('allSessions')),
                      sessionIds.map(id => h('option', { key: id, value: id }, id.slice(0, 8))),
                    ),
                  ),
                  h(
                    'label',
                    { style: styles.filterField },
                    h('span', { style: styles.fieldLabel }, t('filterTab')),
                    h(
                      'select',
                      {
                        style: styles.select,
                        value: String(filter.tab),
                        onChange: event => {
                          const tab = event.target.value;
                          setFilter(previous => ({ ...previous, tab }));
                        },
                      },
                      h('option', { value: '' }, t('allTabs')),
                      tabIds.map(tab => h('option', { key: tab, value: String(tab) }, String(tab))),
                    ),
                  ),
                  h(
                    'label',
                    { style: styles.filterField },
                    h('span', { style: styles.fieldLabel }, t('filterLimit')),
                    h(
                      'select',
                      {
                        style: styles.select,
                        value: String(filter.limit),
                        onChange: event => {
                          const limit = Number(event.target.value) || 100;
                          setFilter(previous => ({ ...previous, limit }));
                        },
                      },
                      [50, 100].map(limit => h('option', { key: limit, value: String(limit) }, String(limit))),
                    ),
                  ),
                  h(
                    'button',
                    { type: 'button', style: styles.smallButton, onClick: () => void exportLog() },
                    t('export'),
                  ),
                ),
                log.error ? h('p', { style: styles.error }, log.error) : null,
                log.rows.length
                  ? log.rows
                      .slice()
                      .reverse()
                      .map(row => {
                        const target = targetLabel(row.args);
                        return h(
                          'div',
                          { key: row.callId },
                          h(
                            'div',
                            { style: styles.recentRow },
                            h(
                              'span',
                              { style: styles.recentTime, title: new Date(row.at).toLocaleString() },
                              new Date(row.at).toLocaleTimeString(),
                            ),
                            h('span', { 'aria-hidden': true }, row.ok === false ? '✗' : row.ok === true ? '✓' : '…'),
                            h('span', { style: styles.recentTool }, row.tool || ''),
                            target ? h('span', { style: styles.recentTarget }, target) : null,
                            row.tabId !== undefined
                              ? h('span', { style: styles.recentMeta }, t('tabShort', { tab: row.tabId }))
                              : null,
                            typeof row.ms === 'number' ? h('span', { style: styles.recentMeta }, `${row.ms} ms`) : null,
                            row.sessionId
                              ? h('span', { style: styles.recentMeta, title: row.sessionId }, row.sessionId.slice(0, 8))
                              : null,
                          ),
                          row.ok === false && row.text ? h('div', { style: styles.recentError }, row.text) : null,
                        );
                      })
                  : h('p', { style: styles.muted }, t('auditEmpty')),
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
