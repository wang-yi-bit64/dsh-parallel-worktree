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
		 * Run one /worktree line through the host command channel.
		 * @returns {{ok: boolean, data?: object, message?: string, hint?: string, skipped?: boolean}}
		 *   skipped means the channel (not the host command) is missing: render nothing.
		 */
		function runCommand(ctx, sessionId, line) {
			const remote = ctx && ctx.remote;
			const commands = remote && remote.commands;
			if (!commands || typeof commands.execute !== 'function') return Promise.resolve({ ok: false, skipped: true });
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
				const [copied, setCopied] = React.useState('');
				const alive = React.useRef(true);

				// One authoritative status read per mount (per session: the slot remounts on switch).
				React.useEffect(() => {
					alive.current = true;
					if (sessionId !== '') {
						runCommand(ctx, sessionId, '/worktree status --json').then((result) => {
							if (!alive.current || !result.ok) return;
							const data = result.data || {};
							if (data.inWorktree !== true || !data.worktree) return;
							setBadge({
								name: String(data.worktree.name || ''),
								branch: String(data.worktree.branch || ''),
								path: String(data.worktree.path || ''),
							});
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

				if (badge === null) return null;

				const rows = list && Array.isArray(list.worktrees) ? list.worktrees : [];
				const chipAria = tt('chip.aria', { name: badge.name });
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
							title: badge.path || badge.name,
							onClick: toggle,
						},
						h('span', { 'aria-hidden': 'true' }, '\u26db'),
						h('span', { style: styles.chipName }, badge.name || tt('panel.title')),
						badge.branch !== '' ? h('span', { style: styles.chipMeta }, badge.branch) : null,
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
							error !== '' ? h('div', { style: styles.error, role: 'alert' }, error) : null,
							baseBranch !== '' ? h('div', { style: styles.note }, tt('panel.base', { branch: baseBranch })) : null,
							!loading && rows.length === 0 ? h('div', { style: styles.note }, tt('panel.empty')) : null,
							rows.map((row, index) => {
								const entry = row || {};
								const name = typeof entry.name === 'string' ? entry.name : '';
								const branch = typeof entry.branch === 'string' ? entry.branch : '';
								const target = typeof entry.path === 'string' ? entry.path : '';
								const isCurrent = badge.path !== '' && target === badge.path;
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
		}

		return {
			name: 'parallel-worktree-client',
			inject: ['slots', 'locale', 'sessions', 'remote.commands'],
			apply: apply,
		};
	},
});
