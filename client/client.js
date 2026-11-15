/**
 * dsh-parallel-worktree — Web client half (hand-written __ModuleLoader__ bundle).
 *
 * Scope (MVP): a composer-dock chip that shows the worktree this conversation
 * lives in, plus a click-open panel listing every worktree of the repository
 * with per-row copy-path. Creation / removal stay on the /worktree command
 * surface (no extra write paths in the UI).
 *
 * Data channels (no polling, no timers):
 *   - on mount, one  /worktree status --json   -> drives the chip only
 *   - on open / refresh, one /worktree list --json -> drives the panel
 * Every execute() appends one command/run + command/done pair to the session
 * transcript, so calls are strictly user- or mount-triggered.
 *
 * Failure posture: if the client Remote command channel, the session id, or
 * the host /worktree command is unavailable, the component renders null
 * (invisible) instead of throwing — a composition mistake cannot blank the
 * conversation.composer.dock slot entry.
 */
window.__ModuleLoader__.load({
	id: 'dsh-parallel-worktree',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

			const NS = 'parallel-worktree';
			const SLOT = 'conversation.composer.dock';
			const ENTRY_ID = 'parallel-worktree-badge';
			/** 插件详情页的配置 slot：keyed，键是 bundle 的包名。 */
			const CONFIG_SLOT = 'plugins.bundle.config';
			const CONFIG_KEY = 'dsh-parallel-worktree';

		const zh = {
			'chip.aria': '\u5e76\u884c worktree\uff1a{name}\uff0c\u70b9\u51fb\u67e5\u770b\u5217\u8868',
			'panel.title': '\u5e76\u884c worktree',
			'panel.refresh': '\u5237\u65b0',
			'panel.close': '\u5173\u95ed',
			'panel.loading': '\u8bfb\u53d6\u4e2d\u2026',
			'panel.empty': '\u8fd9\u4e2a\u4ed3\u5e93\u6ca1\u6709\u5e76\u884c worktree\u3002',
			'panel.copy': '\u590d\u5236\u8def\u5f84',
			'panel.copied': '\u5df2\u590d\u5236',
			'panel.copyFailed': '\u590d\u5236\u5931\u8d25\uff0c\u8bf7\u624b\u52a8\u590d\u5236\u3002',
			'panel.dirty': '\u6709\u6539\u52a8',
			'panel.current': '\u5f53\u524d',
			'panel.base': '\u57fa\u7ebf {branch}',
			'chip.idle': '\u5e76\u884c worktree',
			'panel.notGit': '\u5f53\u524d\u76ee\u5f55\u4e0d\u662f git \u4ed3\u5e93\u7684\u68c0\u51fa\u76ee\u5f55\uff0c\u6216\u8be5\u4ed3\u5e93\u8fd8\u6ca1\u6709\u5e76\u884c worktree\u3002',
			'config.title': '\u63d2\u4ef6\u8bbe\u7f6e',
			'config.storageRoot': '\u5b58\u653e\u4f4d\u7f6e',
			'config.storageRootHint': 'worktree \u5b58\u653e\u6839\u76ee\u5f55\uff1b\u7a7a = \u4ed3\u5e93\u65c1 <repo>.wt/\uff1b\u652f\u6301 {repo} \u5360\u4f4d\u7b26',
			'config.layout': '\u5e03\u5c40',
			'config.layoutHint': 'sibling\uff1a\u4ed3\u5e93\u5916\uff08\u9ed8\u8ba4\uff09\uff1binside\uff1a\u4ed3\u5e93\u5185 .worktrees/\uff08\u81ea\u52a8\u5199 .gitignore\uff09',
			'config.dirName': 'inside \u76ee\u5f55\u540d',
			'config.dirNameHint': 'inside \u5e03\u5c40\u65f6\u4ed3\u5e93\u5185\u7684\u76ee\u5f55\u540d',
			'config.siblingSuffix': 'sibling \u540e\u7f00',
			'config.siblingSuffixHint': 'sibling \u5e03\u5c40\u65f6\u4ed3\u5e93\u540d\u540e\u7684\u540e\u7f00',
			'config.branchPrefix': '\u5206\u652f\u524d\u7f00',
			'config.branchPrefixHint': '\u521b\u5efa\u5206\u652f\u65f6\u7684\u524d\u7f00\uff1b\u7a7a = \u76f4\u63a5\u7528 worktree \u540d',
			'config.copyEnv': '\u590d\u5236\u7684\u73af\u5883\u6587\u4ef6',
			'config.copyEnvHint': '\u9017\u53f7\u5206\u9694\uff1b\u7a7a = \u4e0d\u590d\u5236\uff08\u5982 .env, .env.local\uff09',
			'config.linkNodeModules': '\u94fe\u63a5 node_modules',
			'config.linkNodeModulesHint': '\u521b\u5efa\u65f6\u9ed8\u8ba4\u628a\u4e3b\u4ed3\u5e93 node_modules \u94fe\u63a5\u8fdb\u65b0 worktree',
			'config.syncMode': '\u540c\u6b65\u7b56\u7565',
			'config.syncModeHint': '/worktree sync \u7684\u9ed8\u8ba4\u7b56\u7565',
			'config.baseBranch': '\u57fa\u51c6\u5206\u652f',
			'config.baseBranchHint': '\u9ed8\u8ba4\u57fa\u51c6\u5206\u652f\uff1b\u7a7a = \u81ea\u52a8\u63a2\u6d4b\u5f53\u524d\u5206\u652f',
			'config.save': '\u4fdd\u5b58',
			'config.revert': '\u653e\u5f03\u66f4\u6539',
			'config.saving': '\u4fdd\u5b58\u4e2d\u2026',
			'config.saved': '\u5df2\u4fdd\u5b58',
			'config.refused': '\u4fdd\u5b58\u88ab\u62d2\u7edd\uff08\u68c0\u67e5\u5404\u5b57\u6bb5\u53d6\u503c\u662f\u5426\u7b26\u5408\u7ea6\u675f\uff09',
			'config.readonly': '\u5f53\u524d profile \u4e0d\u63a5\u53d7\u5199\u5165\uff0c\u914d\u7f6e\u53ea\u8bfb\u3002',
			'config.loading': '\u914d\u7f6e\u8bfb\u53d6\u4e2d\u2026',
		};
		const en = {
			'chip.aria': 'Parallel worktree: {name}. Click to list worktrees.',
			'panel.title': 'Parallel worktrees',
			'panel.refresh': 'Refresh',
			'panel.close': 'Close',
			'panel.loading': 'Loading\u2026',
			'panel.empty': 'No parallel worktrees in this repository.',
			'panel.copy': 'Copy path',
			'panel.copied': 'Copied',
			'panel.copyFailed': 'Copy failed; copy the path manually.',
			'panel.dirty': 'modified',
			'panel.current': 'current',
			'panel.base': 'base {branch}',
			'chip.idle': 'Parallel worktrees',
			'panel.notGit': 'This folder is not inside a Git worktree repository, or it has no parallel worktrees yet.',
			'config.title': 'Plugin settings',
			'config.storageRoot': 'Storage location',
			'config.storageRootHint': 'Worktree storage root; empty = <repo>.wt/ next to the repo; {repo} placeholder supported',
			'config.layout': 'Layout',
			'config.layoutHint': 'sibling: outside the repo (default); inside: .worktrees/ inside (auto .gitignore)',
			'config.dirName': 'Inside directory name',
			'config.dirNameHint': 'Directory name inside the repo for the inside layout',
			'config.siblingSuffix': 'Sibling suffix',
			'config.siblingSuffixHint': 'Suffix appended to the repo name for the sibling layout',
			'config.branchPrefix': 'Branch prefix',
			'config.branchPrefixHint': 'Prefix for created branches; empty = use the worktree name directly',
			'config.copyEnv': 'Copied env files',
			'config.copyEnvHint': 'Comma separated; empty = copy nothing (e.g. .env, .env.local)',
			'config.linkNodeModules': 'Link node_modules',
			'config.linkNodeModulesHint': 'Link the main repo node_modules into new worktrees by default',
			'config.syncMode': 'Sync mode',
			'config.syncModeHint': 'Default strategy for /worktree sync',
			'config.baseBranch': 'Base branch',
			'config.baseBranchHint': 'Default base branch; empty = auto-detect the current branch',
			'config.save': 'Save',
			'config.revert': 'Discard changes',
			'config.saving': 'Saving…',
			'config.saved': 'Saved',
			'config.refused': 'Save refused (check each field against its constraints)',
			'config.readonly': 'The profile does not accept writes; settings are read-only.',
			'config.loading': 'Loading settings…',
		};

		const styles = {
			root: {
				position: 'relative',
				display: 'inline-flex',
				alignItems: 'center',
				font: 'inherit',
				fontSize: 12,
				lineHeight: '18px',
			},
			chip: {
				display: 'inline-flex',
				alignItems: 'center',
				gap: 6,
				maxWidth: 280,
				padding: '1px 8px',
				border: '1px solid var(--dsw-alias-border-l1, #00000014)',
				borderRadius: 999,
				background: 'var(--dsw-alias-bg-base, transparent)',
				color: 'var(--dsw-alias-state-business-primary, #4f73ff)',
				font: 'inherit',
				fontSize: 12,
				lineHeight: '18px',
				cursor: 'pointer',
			},
			chipName: {
				fontWeight: 600,
				overflow: 'hidden',
				textOverflow: 'ellipsis',
				whiteSpace: 'nowrap',
			},
			chipMeta: {
				color: 'var(--dsw-alias-label-caption, #8a8f98)',
				overflow: 'hidden',
				textOverflow: 'ellipsis',
				whiteSpace: 'nowrap',
			},
			panel: {
				position: 'absolute',
				bottom: 'calc(100% + 6px)',
				left: 0,
				zIndex: 40,
				width: 380,
				maxWidth: '80vw',
				maxHeight: 320,
				overflow: 'auto',
				padding: '8px 10px',
				background: 'var(--dsw-alias-bg-base, #ffffff)',
				border: '1px solid var(--dsw-alias-border-l2, #0000001f)',
				borderRadius: 8,
				boxShadow: '0 10px 28px #00000021',
				color: 'var(--dsw-alias-label-primary, #1f2329)',
				font: 'inherit',
				fontSize: 12,
				lineHeight: '18px',
			},
			head: {
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'space-between',
				gap: 8,
				marginBottom: 6,
			},
			title: { fontWeight: 600 },
			button: {
				font: 'inherit',
				fontSize: 12,
				padding: '1px 8px',
				borderRadius: 6,
				border: '1px solid var(--dsw-alias-border-l1, #00000014)',
				background: 'transparent',
				color: 'var(--dsw-alias-label-secondary, #6b7280)',
				cursor: 'pointer',
			},
			row: {
				padding: '6px 0',
				borderTop: '1px solid var(--dsw-alias-border-l1, #00000014)',
			},
			rowHead: {
				display: 'flex',
				alignItems: 'center',
				gap: 6,
				flexWrap: 'wrap',
			},
			name: {
				fontWeight: 600,
				color: 'var(--dsw-alias-label-primary, #1f2329)',
			},
			tag: { color: 'var(--dsw-alias-label-caption, #8a8f98)' },
			path: {
				fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
				color: 'var(--dsw-alias-label-secondary, #6b7280)',
				wordBreak: 'break-all',
			},
			note: { color: 'var(--dsw-alias-label-caption, #8a8f98)' },
			error: { color: 'var(--dsw-alias-state-error, #c93b3b)' },
			configPage: {
				display: 'flex',
				flexDirection: 'column',
				gap: 10,
				padding: '12px 0',
				font: 'inherit',
				fontSize: 12,
				lineHeight: '18px',
				color: 'var(--dsw-alias-label-primary, #1f2329)',
			},
			configRow: {
				display: 'flex',
				alignItems: 'center',
				gap: 10,
			},
			configLabel: {
				flex: '0 0 130px',
				textAlign: 'right',
				color: 'var(--dsw-alias-label-secondary, #6b7280)',
			},
			configInput: {
				flex: 1,
				maxWidth: 420,
				font: 'inherit',
				fontSize: 12,
				padding: '3px 8px',
				border: '1px solid var(--dsw-alias-border-l1, #00000014)',
				borderRadius: 6,
				background: 'var(--dsw-alias-bg-base, #ffffff)',
				color: 'inherit',
			},
			configHint: {
				flex: 1,
				minWidth: 160,
				color: 'var(--dsw-alias-label-caption, #8a8f98)',
				overflow: 'hidden',
				textOverflow: 'ellipsis',
				whiteSpace: 'nowrap',
			},
			configFooter: {
				display: 'flex',
				alignItems: 'center',
				gap: 8,
				marginTop: 2,
			},
			configStatus: {
				color: 'var(--dsw-alias-label-caption, #8a8f98)',
			},
			configNote: {
				color: 'var(--dsw-alias-label-caption, #8a8f98)',
			},
		};

		const noop = () => {};

		/** Current session snapshot from the client session store, when present. */
		function readSnapshot(ctx) {
			try {
				const sessions = ctx.sessions;
				if (sessions && sessions.list && typeof sessions.list.getSnapshot === 'function') {
					return sessions.list.getSnapshot();
				}
			} catch (error) {
				/* store absent or reshaping: treat as unknown, never throw */
			}
			return undefined;
		}

		/** Session id for command execution: slot props first, then the live selection. */
		function readSessionId(ctx, props) {
			try {
				if (props && typeof props.sessionId === 'string' && props.sessionId !== '') return props.sessionId;
			} catch (error) {
				/* props is a plain object in practice */
			}
			const snapshot = readSnapshot(ctx);
			if (snapshot && typeof snapshot.current === 'string' && snapshot.current !== '') return snapshot.current;
			return '';
		}

		/**
		 * Resolve the host command channel from the plugin context.
		 *
		 * The context is a proxy that throws on any property the plugin did not declare
		 * in `inject` ("cannot get property X without inject"). Reading `ctx.remote`
		 * therefore belongs inside a try: a channel we cannot reach must degrade to
		 * "render nothing", never crash the conversation.composer.dock slot entry.
		 * @returns {object|undefined} the command channel, or undefined when unavailable.
		 */
		function readCommands(ctx) {
			try {
				const remote = ctx && ctx.remote;
				const commands = remote && remote.commands;
				if (commands && typeof commands.execute === 'function') return commands;
			} catch (error) {
				/* ctx.remote not declared in inject, or the channel is absent */
			}
			return undefined;
		}

		/**
		 * Run one /worktree line through the host command channel.
		 * @returns {{ok: boolean, data?: object, message?: string, hint?: string, skipped?: boolean}}
		 *   skipped means the channel (not the host command) is missing: render nothing.
		 */
		function runCommand(ctx, sessionId, line) {
			const commands = readCommands(ctx);
			if (commands === undefined) return Promise.resolve({ ok: false, skipped: true });
			return Promise.resolve()
				.then(() => commands.execute(sessionId, line, []))
				.then((raw) => {
					if (!raw || raw.ok === false) {
						const error = raw && raw.error;
						const message = error && (error.message || error.code);
						return { ok: false, message: message ? String(message) : 'remote error' };
					}
					if (raw.value === undefined || raw.value === null) return { ok: false, skipped: true };
					const result = raw.value.result;
					if (!result) return { ok: false, skipped: true };
					let data;
					try {
						data = JSON.parse(String(result.text || ''));
					} catch (error) {
						data = undefined;
					}
					if (result.kind === 'error') {
						return {
							ok: false,
							message: String((data && data.message) || result.text || ''),
							hint: data && data.hint ? String(data.hint) : '',
						};
					}
					if (data && data.ok === false) {
						return {
							ok: false,
							message: String(data.message || ''),
							hint: data && data.hint ? String(data.hint) : '',
						};
					}
					return { ok: true, data: data };
				}, (error) => ({ ok: false, message: String((error && error.message) || error) }));
		}

		const CONFIG_FIELDS = [
			{ key: 'storageRoot', kind: 'text' },
			{ key: 'layout', kind: 'select', options: ['sibling', 'inside'] },
			{ key: 'dirName', kind: 'text' },
			{ key: 'siblingSuffix', kind: 'text' },
			{ key: 'branchPrefix', kind: 'text' },
			{ key: 'copyEnv', kind: 'list' },
			{ key: 'linkNodeModules', kind: 'check' },
			{ key: 'syncMode', kind: 'select', options: ['rebase', 'merge'] },
			{ key: 'baseBranch', kind: 'text' },
		];

		/**
		 * 插件设置页：渲染在「插件 → 并行 Worktree」详情页的 plugins.bundle.config
		 * slot 里。值与写通道自源：挂载时 ctx.remote.settings.describe() 取本 entry
		 * （ns = parallel-worktree）的 schema 解析值与 revision；保存走
		 * settings.mutate（revision 做围栏），写入落到 profile patch 的 config 节，
		 * 非 volatile 字段会触发插件重挂载。describe/mutate 不可用或命名空间缺失
		 * （Config schema 未加载）时渲染 null。
		 */
		function createConfigPage(ctx, t) {
			return function ParallelWorktreeConfigPage(props) {
				const tt = (key, params) => {
					let value;
					try {
						const fn = props && typeof props.t === 'function' ? props.t : t;
						value = fn(key, params);
					} catch (error) {
						value = undefined;
					}
					if (typeof value === 'string' && value !== key) return value;
					const fallback = typeof zh[key] === 'string' ? zh[key] : key;
					if (!params) return fallback;
					return fallback.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
				};

				const [view, setView] = React.useState(undefined);
				const [writable, setWritable] = React.useState(true);
				const [edits, setEdits] = React.useState({});
				const [status, setStatus] = React.useState('');
				const alive = React.useRef(true);

				React.useEffect(() => {
					alive.current = true;
					let cancelled = false;
					(async () => {
						try {
							const response = await ctx.remote.settings.describe();
							if (cancelled || !alive.current) return;
							if (response && response.ok && response.value) {
								setWritable(response.value.writable !== false);
								const row = (response.value.namespaces || []).find((item) => item.ns === NS);
								if (row) setView(row);
							}
						} catch (error) {
							/* settings 通道缺席：按契约渲染 null */
						}
					})();
					return () => { cancelled = true; alive.current = false; };
				}, []);

				if (view === undefined) return null;
				const value = view.value && typeof view.value === 'object' ? view.value : {};

				function display(key) {
					if (edits[key] !== undefined) return edits[key];
					const current = value[key];
					if (key === 'copyEnv') return Array.isArray(current) ? current.join(', ') : '';
					if (key === 'linkNodeModules') return current === true;
					return current === undefined || current === null ? '' : String(current);
				}

				function edit(key, raw) {
					setEdits((previous) => {
						const next = { ...previous };
						next[key] = key === 'linkNodeModules' ? raw === true
							: key === 'copyEnv'
								? String(raw).split(/[,\s]+/).map((item) => item.trim()).filter((item) => item !== '')
								: String(raw);
						return next;
					});
					setStatus('');
				}

				async function save() {
					const keys = Object.keys(edits);
					if (keys.length === 0) return;
					const ops = keys.map((key) => ({ op: 'set', path: [key], value: edits[key] }));
					setStatus(tt('config.saving'));
					let accepted = false;
					try {
						const response = await ctx.remote.settings.mutate(NS, ops, view.revision);
						accepted = Boolean(response && response.ok);
						if (accepted && response.value && typeof response.value === 'object') setView(response.value);
					} catch (error) {
						accepted = false;
					}
					if (!alive.current) return;
					setStatus(accepted ? tt('config.saved') : tt('config.refused'));
					if (accepted) setEdits({});
				}

				const dirty = Object.keys(edits).length > 0;
				const disabled = writable === false;

				return h(
					'div',
					{ style: styles.configPage, 'data-dsh-parallel-worktree-config': '' },
					h('div', { style: styles.title }, tt('config.title')),
					CONFIG_FIELDS.map((field) => h(
						'div',
						{ key: field.key, style: styles.configRow },
						h('label', { style: styles.configLabel, htmlFor: 'dsh-pwt-' + field.key, title: tt('config.' + field.key + 'Hint') }, tt('config.' + field.key)),
						field.kind === 'select'
							? h(
								'select',
								{
									id: 'dsh-pwt-' + field.key,
									style: styles.configInput,
									value: display(field.key),
									disabled,
									onChange: (event) => edit(field.key, event.target.value),
								},
								field.options.map((option) => h('option', { key: option, value: option }, option)),
							)
							: field.kind === 'check'
								? h('input', {
									id: 'dsh-pwt-' + field.key,
									type: 'checkbox',
									checked: display(field.key) === true,
									disabled,
									onChange: (event) => edit(field.key, event.target.checked),
								})
								: h('input', {
									id: 'dsh-pwt-' + field.key,
									type: 'text',
									style: styles.configInput,
									value: display(field.key),
									disabled,
									title: tt('config.' + field.key + 'Hint'),
									onChange: (event) => edit(field.key, event.target.value),
								}),
						h('span', { style: styles.configHint, title: tt('config.' + field.key + 'Hint') }, tt('config.' + field.key + 'Hint')),
					)),
					h(
						'div',
						{ style: styles.configFooter },
						disabled
							? h('span', { style: styles.configNote }, tt('config.readonly'))
							: [
								h(
									'button',
									{
										key: 'save',
										type: 'button',
										style: styles.button,
										disabled: !dirty || status === tt('config.saving'),
										onClick: () => { void save(); },
									},
									status === tt('config.saving') ? tt('config.saving') : tt('config.save'),
								),
								dirty ? h(
									'button',
									{
										key: 'revert',
										type: 'button',
										style: styles.button,
										onClick: () => { setEdits({}); setStatus(''); },
									},
									tt('config.revert'),
								) : null,
							],
						status !== '' && status !== tt('config.saving') ? h('span', { style: styles.configStatus, role: 'status' }, status) : null,
					),
				);
			};
		}

		/** Badge + popover component, closed over the plugin context and locale t. */
		function createBadge(ctx, t) {
			return function ParallelWorktreeBadge(props) {
				const tt = (key, params) => {
					let value;
					try {
						const fn = props && typeof props.t === 'function' ? props.t : t;
						value = fn(key, params);
					} catch (error) {
						value = undefined;
					}
					if (typeof value === 'string' && value !== key) return value;
					const fallback = typeof zh[key] === 'string' ? zh[key] : key;
					if (!params) return fallback;
					return fallback.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
				};

				const sessionId = readSessionId(ctx, props);
				const [badge, setBadge] = React.useState(null);
				const [open, setOpen] = React.useState(false);
				const [list, setList] = React.useState(null);
				const [loading, setLoading] = React.useState(false);
				const [error, setError] = React.useState('');
				const [probe, setProbe] = React.useState({ ready: false, count: 0 });
				const [mountError, setMountError] = React.useState('');
				const [copied, setCopied] = React.useState('');
				const alive = React.useRef(true);

				// One authoritative status read per mount (per session: the slot remounts on switch).
				React.useEffect(() => {
					alive.current = true;
					if (sessionId !== '') {
						runCommand(ctx, sessionId, '/worktree status --json').then((result) => {
							if (!alive.current || result.skipped === true) return;
							if (!result.ok) {
								setProbe({ ready: true, count: 0 });
								setMountError([result.message, result.hint].filter(Boolean).join(' \u00b7 '));
								return;
							}
							const status = result.data || {};
							if (status.inWorktree === true && status.worktree) {
								setBadge({
									name: String(status.worktree.name || ''),
									branch: String(status.worktree.branch || ''),
									path: String(status.worktree.path || ''),
								});
								setProbe({ ready: true, count: 0 });
								return;
							}
							setProbe({ ready: true, count: 0 });
							runCommand(ctx, sessionId, '/worktree list --json').then((listed) => {
								if (!alive.current) return;
								if (!listed.ok) {
									setMountError([listed.message, listed.hint].filter(Boolean).join(' \u00b7 '));
									return;
								}
								const snapshot = listed.data || {};
								const entries = Array.isArray(snapshot.worktrees) ? snapshot.worktrees : [];
								setProbe({ ready: true, count: entries.length });
							}, noop);
						}, noop);
					}
					return () => {
						alive.current = false;
					};
				}, []);

				function loadList() {
					if (sessionId === '') return Promise.resolve();
					setLoading(true);
					setError('');
					return runCommand(ctx, sessionId, '/worktree list --json').then((result) => {
						if (!alive.current) return;
						setLoading(false);
						if (!result.ok) {
							setList(null);
							if (result.skipped !== true) {
								setError([result.message, result.hint].filter(Boolean).join(' \u00b7 '));
							}
							return;
						}
						setMountError('');
						setList(result.data || null);
					});
				}

				function toggle() {
					if (!open) loadList();
					setOpen(!open);
				}

				function copyPath(target) {
					if (typeof target !== 'string' || target === '') return;
					try {
						const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
						if (clipboard && typeof clipboard.writeText === 'function') {
							clipboard.writeText(target).then(() => {
								if (alive.current) setCopied(target);
							}, () => {
								if (alive.current) setError(tt('panel.copyFailed'));
							});
							return;
						}
					} catch (error) {
						/* fall through to the error line */
					}
					setError(tt('panel.copyFailed'));
				}

				const rows = list && Array.isArray(list.worktrees) ? list.worktrees : [];
				const chipLabel = badge !== null ? (badge.name || tt('panel.title')) : tt('chip.idle');
				const chipMeta = badge !== null ? badge.branch : (probe.count > 0 ? String(probe.count) : '');
				const chipAria = badge !== null ? tt('chip.aria', { name: badge.name }) : tt('chip.idle');
				const chipTitle = badge !== null ? (badge.path || badge.name) : tt('chip.idle');
				const shownError = error !== '' ? error : mountError;
				const baseBranch = list && list.baseBranch ? String(list.baseBranch) : '';

				return h(
					'div',
					{
						style: styles.root,
						'data-dsh-parallel-worktree': '',
						'data-plugin': 'parallel-worktree',
					},
					h(
						'button',
						{
							type: 'button',
							style: styles.chip,
							'aria-expanded': open ? 'true' : 'false',
							'aria-haspopup': 'dialog',
							'aria-label': chipAria,
							title: chipTitle,
							onClick: toggle,
						},
						h('span', { 'aria-hidden': 'true' }, '\u26db'),
						h('span', { style: styles.chipName }, chipLabel),
						chipMeta !== '' ? h('span', { style: styles.chipMeta }, chipMeta) : null,
					),
					open
						? h(
							'div',
							{
								role: 'dialog',
								'aria-label': tt('panel.title'),
								'data-dsh-parallel-worktree-panel': '',
								style: styles.panel,
							},
							h(
								'div',
								{ style: styles.head },
								h('span', { style: styles.title }, tt('panel.title')),
								h(
									'span',
									null,
									h(
										'button',
										{ type: 'button', style: styles.button, onClick: loadList, disabled: loading },
										loading ? tt('panel.loading') : tt('panel.refresh'),
									),
									h(
										'button',
										{ type: 'button', style: Object.assign({}, styles.button, { marginLeft: 6 }), onClick: () => setOpen(false) },
										tt('panel.close'),
									),
								),
							),
							shownError !== '' ? h('div', { style: styles.error, role: 'alert' }, shownError) : null,
							baseBranch !== '' ? h('div', { style: styles.note }, tt('panel.base', { branch: baseBranch })) : null,
							!loading && rows.length === 0 ? h('div', { style: styles.note }, tt('panel.empty')) : null,
							probe.ready && probe.count === 0 && badge === null && shownError === '' ? h('div', { style: styles.note }, tt('panel.notGit')) : null,
							rows.map((row, index) => {
								const entry = row || {};
								const name = typeof entry.name === 'string' ? entry.name : '';
								const branch = typeof entry.branch === 'string' ? entry.branch : '';
								const target = typeof entry.path === 'string' ? entry.path : '';
								const isCurrent = badge !== null && badge.path !== '' && target === badge.path;
								return h(
									'div',
									{ key: name !== '' ? name : String(index), style: styles.row },
									h(
										'div',
										{ style: styles.rowHead },
										h('span', { style: styles.name }, name),
										branch !== '' ? h('span', { style: styles.tag }, branch) : null,
										entry.state ? h('span', { style: styles.tag }, String(entry.state)) : null,
										entry.dirty === true ? h('span', { style: styles.tag }, tt('panel.dirty')) : null,
										typeof entry.ahead === 'number' && entry.ahead > 0 ? h('span', { style: styles.tag }, '\u2191' + String(entry.ahead)) : null,
										typeof entry.behind === 'number' && entry.behind > 0 ? h('span', { style: styles.tag }, '\u2193' + String(entry.behind)) : null,
										isCurrent ? h('span', { style: styles.tag }, tt('panel.current')) : null,
									),
									h('div', { style: styles.path }, target),
									h(
										'div',
										null,
										h(
											'button',
											{ type: 'button', style: styles.button, onClick: () => copyPath(target) },
											copied !== '' && copied === target ? tt('panel.copied') : tt('panel.copy'),
										),
									),
								);
							}),
						)
						: null,
				);
			};
		}

		function apply(ctx) {
			ctx.effect(() => {
				try {
					return ctx.locale.register(NS, { zh: zh, en: en });
				} catch (error) {
					return noop;
				}
			}, NS + ': dictionaries');

			const bound = ctx && ctx.locale && typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : undefined;
			const t = (key, params) => {
				if (bound === undefined) return key;
				try {
					const value = bound(key, params);
					return typeof value === 'string' ? value : key;
				} catch (error) {
					return key;
				}
			};

			const Badge = createBadge(ctx, t);
			ctx.slots.inject(SLOT, () => ctx.slots.register({ name: SLOT, id: ENTRY_ID, order: 5, locale: NS }, Badge));

			// 插件设置页：注册到插件管理器的 keyed 配置 slot（键 = bundle 包名），
			// 详情页在描述与组件行之间渲染本组件。
			const ConfigPage = createConfigPage(ctx, t);
			ctx.slots.inject(CONFIG_SLOT, () => ctx.slots.register(
				{ name: CONFIG_SLOT, key: CONFIG_KEY, id: ENTRY_ID + '-config', locale: NS },
				ConfigPage,
			));
		}

		return {
			name: 'parallel-worktree-client',
			// `remote`（不只是 `remote.commands`）：readCommands 读父服务确认通道存在；
			// `remote.settings`：配置页的 describe/mutate 走它。上下文代理对未声明的
			// 属性读取一律抛错，所以逐级声明。
			inject: ['slots', 'locale', 'sessions', 'remote', 'remote.commands', 'remote.settings'],
			apply: apply,
		};
	},
});
