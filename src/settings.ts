import { App, PluginSettingTab, TFile, setIcon } from 'obsidian';
import type TaskViewsPlugin from './main';
import type { Board, OpenLocation, TabConfig, TabGroup, TabGroupConfig, TaskViewsSettings } from './types';
import {
	clampCoverPosition,
	COVER_DIR,
	DEFAULT_COMPACT_HIDE_BANNER,
	DEFAULT_COMPACT_HIDE_TITLE,
	DEFAULT_COMPACT_HIDE_TODAY_OVERVIEW,
	DEFAULT_COMPACT_HIDE_IMPORTANT_REMINDERS,
	DEFAULT_COMPACT_HIDE_STATS,
	DEFAULT_COVER_POSITION,
	DEFAULT_IMPORTANT_QUERY,
	DEFAULT_LANGUAGE,
	DEFAULT_OPEN_LOCATION,
	DEFAULT_SHOW_HEAD_TEXT,
	DEFAULT_SHOW_IMPORTANT_REMINDERS,
	DEFAULT_SHOW_STATS_CATEGORIES,
	DEFAULT_SHOW_TODAY_OVERVIEW,
	DEFAULT_COMPACT_NARROW,
	DEFAULT_COMPACT_SIDEBAR,
	DEFAULT_COMPACT_MOBILE,
	DEFAULT_PINNED_NOTE_PATHS,
	defaultSlogan,
	DEFAULT_WORKBENCH_TITLE,
	getTabGroup,
	normalizeQueryLines,
} from './types';
import { COVER_FILE, persistCoverImage, removeCoverImage, resolveCoverFile } from './cover';
import { TabEditModal } from './modals/board-config-modal';
import { GroupEditModal } from './modals/board-config-modal';
import { TFEditModal } from './modals/tf-edit-modal';
import { ConfirmModal } from './modals/confirm-modal';
import { isBuiltinSlogan, localizedTabLabel, t } from './i18n';
import type { LangSetting } from './i18n';
import { TASKFLOW_ICON_SVG } from './brand';
import { mountTrustedSvg } from './svg';

export const TAB_GROUPS: { id: TabGroup; label: string; icon: string }[] = [
	{ id: 'gtd', label: 'GTD', icon: 'inbox' },
	{ id: 'time', label: 'Time', icon: 'calendar' },
	{ id: 'tag', label: 'Tag', icon: 'tag' },
];

/* ═══════════════════════════════════════════════════════════════
   TF Settings UI Components
   ───────────────────────────────────────────────────────────────
   现代桌面应用风格（参考稿：设置面板_现代桌面应用风格）
     · renderTFRow        一行设置：左「标题 + 说明」，右控件
     · renderTFSwitch     iOS 风格开关（打开蓝灰 / 关闭浅灰）
     · renderTFFileSuggestRow  文件搜索下拉（输入即过滤、点选确认，杜绝手输路径出错）
     · renderTFAddRow     卡片底部的「+ 添加」行
   ═══════════════════════════════════════════════════════════════ */

/** 设置面板的分组（对应顶部图标标签栏） */
export type SettingsSectionId = 'general' | 'groups' | 'tabs' | 'about';

/**
 * 顶部导航项。**必须是函数而非常量**：label 走 t()，若在模块加载时就求值，
 * 之后用户在设置里切换语言，导航标签会一直停在旧语言上（常量不会重算）。
 */
function getSettingsSections(): ReadonlyArray<{ id: SettingsSectionId; label: string; icon: string }> {
	return [
		{ id: 'general', label: t('nav.general'), icon: 'settings' },
		{ id: 'groups', label: t('nav.groups'), icon: 'layers' },
		{ id: 'tabs', label: 'Tabs', icon: 'sliders-horizontal' },
		{ id: 'about', label: t('nav.about'), icon: 'info' },
	];
}

type TFButtonVariant = 'secondary' | 'ghost' | 'danger';

/** 「关于」页用到的外链 */
export const REPO_URL = 'https://github.com/ichris007/taskflow';
export const AUTHOR_SITE_URL = 'https://lifein.vip';

/** 单行设置：左侧「标题 + 说明」，右侧控件 */
interface TFRowConfig {
	title: string;
	description?: string;
	/** 往右侧控件区里填内容 */
	fill: (control: HTMLElement) => void;
}

function renderTFRow(container: HTMLElement, config: TFRowConfig): HTMLElement {
	const row = container.createDiv( { cls: 'tf-settings-row' });
	const main = row.createDiv( { cls: 'tf-settings-row-main' });
	main.createDiv( { cls: 'tf-settings-row-title', text: config.title });
	if (config.description) {
		main.createDiv( { cls: 'tf-settings-row-desc', text: config.description });
	}
	config.fill(row.createDiv( { cls: 'tf-settings-row-control' }));
	return row;
}

/** 行内小按钮：与输入框同高，比主按钮安静一档 */
function renderTFRowButton(
	control: HTMLElement,
	label: string,
	variant: TFButtonVariant,
	onClick: () => void,
): HTMLButtonElement {
	const btn = control.createEl('button', {
		cls: `tf-btn tf-btn-${variant}`,
		text: label,
		attr: { type: 'button' },
	});
	btn.addEventListener('click', onClick);
	return btn;
}

/** iOS 风格开关 */
interface TFSwitchConfig {
	checked: boolean;
	/** 开关左侧的小字，省略则只显示轨道 */
	caption?: string;
	/** 无障碍名称，同时作为 tooltip */
	label: string;
	onChange: (value: boolean) => void;
}

function renderTFSwitch(parent: HTMLElement, config: TFSwitchConfig): HTMLElement {
	const wrap = parent.createEl('label', { cls: 'tf-switch', attr: { title: config.label } });
	if (config.caption) {
		wrap.createSpan( { cls: 'tf-switch-caption', text: config.caption });
	}
	const input = wrap.createEl('input', {
		cls: 'tf-switch-input',
		attr: { type: 'checkbox', 'aria-label': config.label },
	});
	input.checked = config.checked;
	const track = wrap.createSpan( { cls: 'tf-switch-track' });
	track.createSpan( { cls: 'tf-switch-thumb' });
	input.addEventListener('change', () => config.onChange(input.checked));
	return wrap;
}

/**
 * 文件搜索下拉：输入即过滤 vault 里的 md 文件，点选确认。
 *
 * 存在的理由：让用户手输完整路径极易出错（目录分隔符、大小写、扩展名），
 * 错了还不会立刻报错，要等 quick add 写文件时才炸。改成搜索点选后，
 * **能选中的路径必然存在**。
 *
 * 不用 Obsidian 的 AbstractInputSuggest：它属较新 API 且渲染由主题接管，
 * 这里用原生 DOM 自己画，样式走 --tf-* 令牌，行为可控。
 */
interface TFFileSuggestConfig {
	app: App;
	value: string;
	placeholder?: string;
	/** 只有点选（或回车选中）才会回调 —— 手输但没选中不算数 */
	onPick: (path: string) => void;
}

const SUGGEST_MAX = 8;

function renderTFFileSuggestRow(control: HTMLElement, config: TFFileSuggestConfig): void {
	const wrap = control.createDiv( { cls: 'tf-suggest' });
	const input = wrap.createEl('input', {
		cls: 'tf-field-input',
		attr: { type: 'text', placeholder: config.placeholder ?? '' },
	});
	input.value = config.value;

	const list = wrap.createDiv( { cls: 'tf-suggest-list' });

	let items: TFile[] = [];
	let itemEls: HTMLElement[] = [];
	let activeIndex = -1;

	const close = (): void => {
		list.setCssProps({ display: 'none' });
		items = [];
		itemEls = [];
		activeIndex = -1;
	};

	const setActive = (index: number): void => {
		activeIndex = index;
		itemEls.forEach((el, i) => el.toggleClass('is-active', i === index));
	};

	const select = (index: number): void => {
		const file = items[index];
		if (!file) return;
		input.value = file.path;
		close();
		config.onPick(file.path);
	};

	const render = (query: string): void => {
		const q = query.trim().toLowerCase();
		const pool = config.app.vault.getFiles().filter((f) => f.extension === 'md');
		items = (q ? pool.filter((f) => f.path.toLowerCase().includes(q)) : pool).slice(0, SUGGEST_MAX);
		itemEls = [];
		list.empty();
		list.setCssProps({ display: 'block' });

		if (items.length === 0) {
			list.createDiv( { cls: 'tf-suggest-empty', text: t('suggest.noMatch') });
			return;
		}

		for (let i = 0; i < items.length; i++) {
			const file = items[i];
			if (!file) continue;
			const item = list.createDiv( { cls: 'tf-suggest-item' });
			item.createDiv( {
				cls: 'tf-suggest-item-name',
				text: file.basename ?? file.name.replace(/\.md$/i, ''),
			});
			item.createDiv( { cls: 'tf-suggest-item-path', text: file.path });
			// 用 mousedown 而不是 click：mousedown 早于 input 的 blur，
			// 且 preventDefault 能保住焦点，否则列表会先被 blur 关掉、点击落空。
			item.addEventListener('mousedown', (e) => {
				e.preventDefault();
				select(i);
			});
			itemEls.push(item);
		}
		setActive(0);
	};

	input.addEventListener('focus', () => render(input.value));
	input.addEventListener('input', () => render(input.value));
	input.addEventListener('keydown', (e) => {
		if (list.style.display === 'none') {
			if (e.key === 'ArrowDown') {
				render(input.value);
				e.preventDefault();
			}
			return;
		}
		if (e.key === 'ArrowDown') {
			setActive(Math.min(activeIndex + 1, items.length - 1));
			e.preventDefault();
		} else if (e.key === 'ArrowUp') {
			setActive(Math.max(activeIndex - 1, 0));
			e.preventDefault();
		} else if (e.key === 'Enter') {
			select(activeIndex);
			e.preventDefault();
		} else if (e.key === 'Escape') {
			close();
			e.preventDefault();
		}
	});
	input.addEventListener('blur', () => close());
}

/** 卡片底部的添加行 */
function renderTFAddRow(container: HTMLElement, label: string, onClick: () => void): void {
	const row = container.createDiv( { cls: 'tf-settings-row is-add' });
	const btn = row.createEl('button', { cls: 'tf-settings-add-btn', attr: { type: 'button' } });
	setIcon(btn.createSpan({ cls: 'tf-settings-add-icon' }), 'plus');
	btn.createSpan({ cls: 'tf-settings-add-label', text: label });
	btn.addEventListener('click', onClick);
}

/** 空状态：一行灰字，不抢戏 */
function renderTFEmptyRow(container: HTMLElement, text: string): void {
	container.createDiv( { cls: 'tf-settings-empty', text });
}

/** 显示 Toast 通知 */
function showTFToast(message: string, type: 'success' | 'error' | 'info' = 'info'): void {
	// 移除现有 toast
	const existing = document.querySelector('.tf-toast');
	existing?.remove();

	const toast = createDiv();
	toast.className = `tf-toast tf-toast-${type}`;

	const icon = toast.createSpan( { cls: 'tf-toast-icon' });
	icon.textContent = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';
	// message 来自运行期（可能是错误文案），用 textContent 注入，绝不走 innerHTML
	toast.createSpan( { cls: 'tf-toast-content', text: message });
	const closeBtn = toast.createEl('button', {
		cls: 'tf-toast-close',
		attr: { type: 'button', 'aria-label': t('common.close') },
	});
	closeBtn.textContent = '✕';
	closeBtn.addEventListener('click', () => toast.remove());
	document.body.appendChild(toast);

	// 自动消失
	window.setTimeout(() => {
		toast.setCssProps({
			opacity: '0',
			transform: 'translateY(8px) scale(0.95)',
			transition: 'all 200ms ease',
		});
		window.setTimeout(() => toast.remove(), 200);
	}, 3000);
}

export function createDefaultTabs(): TabConfig[] {
	return [
		// ── GTD flow ──
		{
			id: 'gtd-inbox',
			label: t('defaultTab.inbox'),
			group: 'gtd',
			// `#group by filename` 是 Tasks 的注释行（`#` 开头整行不生效）：收集箱刻意不做分组
			query: normalizeQueryLines(`not done
			no due date
			no scheduled date
			status.type is not IN_PROGRESS
			no tags
			#group by filename
			short mode
			sort by created`),
			showSectionHeader: true,
			order: 1,
		},
		{
			id: 'gtd-next',
			label: t('defaultTab.next'),
			group: 'gtd',
			query: normalizeQueryLines(`not done
			status.type is not IN_PROGRESS
			tags includes #todo
			group by filename
			short mode
			hide toolbar
			sort by due
			limit 10`),
			showSectionHeader: true,
			order: 2,
		},
		{
			id: 'gtd-waiting',
			label: t('defaultTab.waiting'),
			group: 'gtd',
			query: normalizeQueryLines(`not done
			tag includes #waiting
			group by filename
			short mode
			hide toolbar
			limit 10`),
			showSectionHeader: false,
			order: 3,
		},
		{
			id: 'gtd-someday',
			label: t('defaultTab.someday'),
			group: 'gtd',
			query: normalizeQueryLines(`not done
			tag includes #someday
			group by filename
			short mode
			hide toolbar
			limit 10`),
			showSectionHeader: false,
			order: 4,
		},

		// ── Time-based flow ──
		{
			id: 'time-overdue',
			label: t('defaultTab.overdue'),
			group: 'time',
			query: normalizeQueryLines(`not done
			(scheduled before today) OR (due before today)
			group by filename
			short mode
			sort by due`),
			showSectionHeader: true,
			order: 5,
		},
		{
			id: 'time-today',
			label: t('defaultTab.today'),
			group: 'time',
			query: normalizeQueryLines(`not done
			(scheduled on today) OR (due on today)
			group by filename
			short mode
			sort by due`),
			showSectionHeader: true,
			order: 6,
		},
		{
			id: 'time-tomorrow',
			label: t('defaultTab.tomorrow'),
			group: 'time',
			query: normalizeQueryLines(`not done
			(scheduled on tomorrow) OR (due on tomorrow)
			group by filename
			short mode
			sort by due`),
			showSectionHeader: true,
			order: 7,
		},
		{
			id: 'time-week',
			label: t('defaultTab.week'),
			group: 'time',
			query: normalizeQueryLines(`not done
			(due after tomorrow)  OR (scheduled after tomorrow)
			(due before in 8 days) OR (scheduled before in 8 days)
			group by filename
			short mode
			sort by due
			limit 10`),
			showSectionHeader: false,
			order: 8,
		},
		{
			id: 'time-month',
			label: t('defaultTab.month'),
			group: 'time',
			query: normalizeQueryLines(`not done
			(due after in 7 days) OR (scheduled after in 7 days)
			(due before in 1 month) OR (scheduled before in 1 month)
			group by filename
			short mode
			sort by due
			limit 10`),
			showSectionHeader: false,
			order: 9,
		},

		// ── Tag-based flow ──
		{
			id: 'tag-work',
			label: t('defaultTab.work'),
			group: 'tag',
			query: normalizeQueryLines(`not done
			tag includes #work
			group by filename
			short mode
			limit 10`),
			showSectionHeader: true,
			order: 10,
		},
		{
			id: 'tag-life',
			label: t('defaultTab.life'),
			group: 'tag',
			query: normalizeQueryLines(`not done
			tag includes #life
			group by filename
			short mode
			limit 10`),
			showSectionHeader: true,
			order: 11,
		},
	];
}


// Default board (Dashboard)
export const DEFAULT_BOARD: Board = {
	id: 'dashboard',
	name: t('defaultGroup.dashboard'),
	icon: 'dashboard',
	order: 1,
};

/** 头部（工作台名 / slogan / 封面）的默认值，旧格式迁移时整组补齐 */
const HEAD_DEFAULTS = {
	workbenchTitle: DEFAULT_WORKBENCH_TITLE,
	workbenchSlogan: defaultSlogan(),
	coverImagePath: '',
	coverPosition: DEFAULT_COVER_POSITION,
	showCover: true,
	showTodayOverview: DEFAULT_SHOW_TODAY_OVERVIEW,
	showImportantReminders: DEFAULT_SHOW_IMPORTANT_REMINDERS,
	importantReminderQuery: DEFAULT_IMPORTANT_QUERY,
	showStatsCategories: DEFAULT_SHOW_STATS_CATEGORIES,
	showHeadText: DEFAULT_SHOW_HEAD_TEXT,
	openLocation: DEFAULT_OPEN_LOCATION,
};

export const DEFAULT_SETTINGS: TaskViewsSettings = {
	version: '',
	data: {
		inboxFilePath: 'Inbox.md',
		excludedFolders: 'System/Templates',
		globalTabs: createDefaultTabs(),
		boards: [DEFAULT_BOARD],
		groups: TAB_GROUPS,
		workbenchTitle: DEFAULT_WORKBENCH_TITLE,
		workbenchSlogan: defaultSlogan(),
		coverImagePath: '',
		coverPosition: 50,
		showCover: true,
		showTodayOverview: DEFAULT_SHOW_TODAY_OVERVIEW,
		showImportantReminders: DEFAULT_SHOW_IMPORTANT_REMINDERS,
		importantReminderQuery: DEFAULT_IMPORTANT_QUERY,
		showStatsCategories: DEFAULT_SHOW_STATS_CATEGORIES,
		showHeadText: DEFAULT_SHOW_HEAD_TEXT,
		showFrontendLimit: false,
		openLocation: DEFAULT_OPEN_LOCATION,
		compactNarrow: DEFAULT_COMPACT_NARROW,
		compactSidebar: DEFAULT_COMPACT_SIDEBAR,
		compactMobile: DEFAULT_COMPACT_MOBILE,
		compactHideBanner: DEFAULT_COMPACT_HIDE_BANNER,
		compactHideTitle: DEFAULT_COMPACT_HIDE_TITLE,
		compactHideTodayOverview: DEFAULT_COMPACT_HIDE_TODAY_OVERVIEW,
		compactHideImportantReminders: DEFAULT_COMPACT_HIDE_IMPORTANT_REMINDERS,
		compactHideStats: DEFAULT_COMPACT_HIDE_STATS,
		pinnedNotePaths: DEFAULT_PINNED_NOTE_PATHS,
	},
	language: DEFAULT_LANGUAGE,
};

/**
 * Infer the group for a tab based on its id prefix when the stored tab has no
 * explicit group. Used to migrate pre-group tabs into the new three-group layout.
 */
function inferTabGroup(id: string): TabGroup {
	if (id.startsWith('gtd-') || id === 'overdue' || id === 'today' || id === 'tomorrow' || id === 'todo' || id === 'inprogress') {
		return 'gtd';
	}
	if (id.startsWith('time-') || id === 'week' || id === 'month') {
		return 'time';
	}
	if (id.startsWith('tag-')) {
		return 'tag';
	}
	return 'gtd';
}

/**
 * Migrate tabs from old format (missing order / group fields)
 */
export function migrateTabs(tabs: TabConfig[]): TabConfig[] {
	const defaultOrderMap = new Map<string, number>();
	createDefaultTabs().forEach((tab, index) => {
		defaultOrderMap.set(tab.id, tab.order);
	});

	return tabs.map((tab, index) => {
		let next = tab;
		if (next.order === undefined) {
			if (defaultOrderMap.has(next.id)) {
				next = { ...next, order: defaultOrderMap.get(next.id)! };
			} else {
				const maxDefaultOrder = Math.max(...createDefaultTabs().map(t => t.order));
				next = { ...next, order: maxDefaultOrder + index + 1 };
			}
		}
		if (next.group === undefined) {
			next = { ...next, group: inferTabGroup(next.id) };
		}
		// 旧版本默认查询带着源码缩进（每行一个 Tab），在设置面板里看着不是左对齐。
		// Tasks 按行解析、首尾空白无语义，读盘时统一抹平，不必等用户手动保存。
		if (typeof next.query === 'string' && next.query !== normalizeQueryLines(next.query)) {
			next = { ...next, query: normalizeQueryLines(next.query) };
		}
		return next;
	});
}

/**
 * 老配置只有总开关 `sidebarCompact`；拆成三个场景开关后做一次等价值迁移：
 * 若存盘里有旧总开关、且没有新的三个场景开关，则把三者都设成旧开关的值。
 */
function normalizeCompactTrigger(data: Record<string, unknown>): void {
	if (data.sidebarCompact !== undefined && data.compactNarrow === undefined) {
		const v = !!data.sidebarCompact;
		data.compactNarrow = v;
		data.compactSidebar = v;
		data.compactMobile = v;
		delete data.sidebarCompact;
	}
}

/**
 * Migrate settings from old format (flat) to new format (versioned with data wrapper)
 */
export function migrateSettings(loaded: Partial<TaskViewsSettings>): TaskViewsSettings {
	// Check if already in new format (has .data)
	if (loaded.data) {
		const data = loaded.data;
		// Migrate tabs if needed (missing order)
		if (data.globalTabs) {
			data.globalTabs = migrateTabs(data.globalTabs);
		}
		// Ensure boards exist and dashboard present
		if (!data.boards || data.boards.length === 0) {
			data.boards = [DEFAULT_BOARD];
		} else {
			const hasDashboard = data.boards.some((b: Board) => b.id === 'dashboard');
			if (!hasDashboard) {
				data.boards = [DEFAULT_BOARD, ...data.boards];
			}
		}
		// Sort
		data.boards.sort((a, b) => a.order - b.order);
		if (data.globalTabs) {
			data.globalTabs.sort((a, b) => a.order - b.order);
		}
		// 老配置可能只带旧总开关 sidebarCompact：等价值拆成三个场景开关
		normalizeCompactTrigger(data as unknown as Record<string, unknown>);
		return {
			version: loaded.version ?? '',
			data: {
				inboxFilePath: data.inboxFilePath ?? DEFAULT_SETTINGS.data.inboxFilePath,
				excludedFolders: data.excludedFolders ?? DEFAULT_SETTINGS.data.excludedFolders,
				globalTabs: data.globalTabs ?? DEFAULT_SETTINGS.data.globalTabs,
				boards: data.boards,
					groups: data.groups ?? TAB_GROUPS,
				// 头部配置：老配置里没有这几个字段，一律补默认值，不能留 undefined
				workbenchTitle: data.workbenchTitle ?? DEFAULT_WORKBENCH_TITLE,
				workbenchSlogan: data.workbenchSlogan ?? defaultSlogan(),
				coverImagePath: data.coverImagePath ?? '',
				coverPosition: clampCoverPosition(data.coverPosition),
				showCover: data.showCover ?? true,
				// 面板模块：老配置没有这几个字段，一律补默认值，不能留 undefined
				showTodayOverview: data.showTodayOverview ?? DEFAULT_SHOW_TODAY_OVERVIEW,
				showImportantReminders: data.showImportantReminders ?? DEFAULT_SHOW_IMPORTANT_REMINDERS,
				importantReminderQuery: data.importantReminderQuery ?? DEFAULT_IMPORTANT_QUERY,
				// 底部统计栏：老配置没有这个字段，补默认（展开）
				showStatsCategories: data.showStatsCategories ?? DEFAULT_SHOW_STATS_CATEGORIES,
				// 头部文字与打开位置：老配置补默认（显示 / 主窗口）
				showHeadText: data.showHeadText ?? DEFAULT_SHOW_HEAD_TEXT,
			showFrontendLimit: data.showFrontendLimit ?? false,
		openLocation: data.openLocation === 'sidebar' ? 'sidebar' : 'main',
		// 紧凑模式：老配置没有这些字段，一律补默认（三场景默认开、模块默认隐藏）
		compactNarrow: data.compactNarrow ?? DEFAULT_COMPACT_NARROW,
		compactSidebar: data.compactSidebar ?? DEFAULT_COMPACT_SIDEBAR,
		compactMobile: data.compactMobile ?? DEFAULT_COMPACT_MOBILE,
		// 老配置只有总开关 sidebarCompact：等价值迁移成三个场景开关（见下方 normalizeCompactTrigger）
		compactHideBanner: data.compactHideBanner ?? DEFAULT_COMPACT_HIDE_BANNER,
			compactHideTitle: data.compactHideTitle ?? DEFAULT_COMPACT_HIDE_TITLE,
			compactHideTodayOverview: data.compactHideTodayOverview ?? DEFAULT_COMPACT_HIDE_TODAY_OVERVIEW,
			compactHideImportantReminders: data.compactHideImportantReminders ?? DEFAULT_COMPACT_HIDE_IMPORTANT_REMINDERS,
			compactHideStats: data.compactHideStats ?? DEFAULT_COMPACT_HIDE_STATS,
			pinnedNotePaths: data.pinnedNotePaths ?? DEFAULT_PINNED_NOTE_PATHS,
		},
		};
	}

	// Old format: flat structure
	const anyLoaded = loaded as Record<string, unknown>;
	let tabs = anyLoaded.tabs as TabConfig[] | undefined;
	let boards = anyLoaded.boards as Board[] | undefined;
	let globalTabs = anyLoaded.globalTabs as TabConfig[] | undefined;
	const inboxFilePath = anyLoaded.inboxFilePath as string | undefined;
	const excludedFolders = anyLoaded.excludedFolders as string | undefined;

	// If old format (tabs at root), move to globalTabs
	if (tabs && !globalTabs) {
		globalTabs = migrateTabs(tabs);
	}

	// If no boards array, create with default dashboard
	if (!boards || boards.length === 0) {
		boards = [DEFAULT_BOARD];
	} else {
		// Ensure dashboard exists
		const hasDashboard = boards.some((b: Board) => b.id === 'dashboard');
		if (!hasDashboard) {
			boards = [DEFAULT_BOARD, ...boards];
		}
	}

	const legacyData: Record<string, unknown> = {
		inboxFilePath: inboxFilePath ?? DEFAULT_SETTINGS.data.inboxFilePath,
		excludedFolders: excludedFolders ?? DEFAULT_SETTINGS.data.excludedFolders,
		globalTabs: globalTabs ?? DEFAULT_SETTINGS.data.globalTabs,
		boards: boards.sort((a, b) => a.order - b.order),
			groups: TAB_GROUPS,
		...HEAD_DEFAULTS,
		// 面板模块：老格式（扁平）一定没有，用默认常量补齐
		showTodayOverview: DEFAULT_SHOW_TODAY_OVERVIEW,
		showImportantReminders: DEFAULT_SHOW_IMPORTANT_REMINDERS,
		importantReminderQuery: DEFAULT_IMPORTANT_QUERY,
		showStatsCategories: DEFAULT_SHOW_STATS_CATEGORIES,
		showHeadText: DEFAULT_SHOW_HEAD_TEXT,
		showFrontendLimit: false,
		openLocation: DEFAULT_OPEN_LOCATION,
		compactNarrow: DEFAULT_COMPACT_NARROW,
		compactSidebar: DEFAULT_COMPACT_SIDEBAR,
		compactMobile: DEFAULT_COMPACT_MOBILE,
		// 顶号 legacy：老扁平格式可能带着旧总开关 sidebarCompact
		sidebarCompact: anyLoaded.sidebarCompact,
		compactHideBanner: DEFAULT_COMPACT_HIDE_BANNER,
		compactHideTitle: DEFAULT_COMPACT_HIDE_TITLE,
		compactHideTodayOverview: DEFAULT_COMPACT_HIDE_TODAY_OVERVIEW,
		compactHideImportantReminders: DEFAULT_COMPACT_HIDE_IMPORTANT_REMINDERS,
		compactHideStats: DEFAULT_COMPACT_HIDE_STATS,
		pinnedNotePaths: DEFAULT_PINNED_NOTE_PATHS,
	};
	// 若老配置带了旧总开关，等价值拆成三个场景开关
	normalizeCompactTrigger(legacyData);

	return {
		version: '',
		data: legacyData as unknown as TaskViewsSettings['data'],
		language: 'auto',
	};
}

export class SettingsManager {
	private plugin: TaskViewsPlugin;
	private contentEl: HTMLElement | null = null;
	/** 当前显示的设置分组 */
	private activeSection: SettingsSectionId = 'general';
	/** Tabs 面板里每个分组的折叠状态；未记录的按「默认折叠」处理 */
	private groupCollapsed: Record<string, boolean> = {};
	private heading = 'TaskFlow Settings';

	/** 分组默认折叠：分组一多，全展开要滚很久才能找到目标 */
	private isGroupCollapsed(groupId: string): boolean {
		return this.groupCollapsed[groupId] ?? true;
	}

	constructor(plugin: TaskViewsPlugin) {
		this.plugin = plugin;
	}

	/**
	 * 构建整个设置界面。
	 *
	 * 版式对齐参考稿「现代桌面应用风格」：顶部图标标签栏做分组导航，
	 * 每个分组是一张灰底圆角卡片，卡片内每行「左说明 / 右控件」。
	 */
	async constructUI(contentEl: HTMLElement, heading: string, section?: SettingsSectionId): Promise<void> {
		// 记住容器，增删改 tab 之后可以就地重建，避免面板显示与配置脱节
		this.contentEl = contentEl;
		this.heading = heading;
		if (section) this.activeSection = section;

		contentEl.empty();
		contentEl.addClass('taskflow-setting-tab');

		this.renderSectionNav(contentEl);

		const body = contentEl.createDiv( { cls: 'tf-settings-body' });
		switch (this.activeSection) {
			case 'groups':
				this.renderGroupsSection(body);
				break;
			case 'tabs':
				this.renderTabsSection(body);
				break;
			case 'about':
				this.renderAboutSection(body);
				break;
			case 'general':
			default:
				this.renderGeneralSection(body);
				break;
		}
	}

	/** 顶部图标标签栏：未激活只留图标，激活项才展开文字 + 指示条 */
	private renderSectionNav(contentEl: HTMLElement): void {
		const nav = contentEl.createDiv( {
			cls: 'tf-settings-nav',
			attr: { role: 'tablist', 'aria-label': this.heading },
		});

		for (const section of getSettingsSections()) {
			const isActive = section.id === this.activeSection;
			const item = nav.createEl('button', {
				cls: isActive ? 'tf-settings-nav-item is-active' : 'tf-settings-nav-item',
				attr: {
					type: 'button',
					role: 'tab',
					title: section.label,
					'aria-selected': isActive ? 'true' : 'false',
				},
			});
			setIcon(item.createSpan({ cls: 'tf-settings-nav-icon' }), section.icon);
			item.createSpan({ cls: 'tf-settings-nav-label', text: section.label });
			item.addEventListener('click', () => {
				if (this.activeSection === section.id) return;
				this.activeSection = section.id;
				if (this.contentEl) void this.constructUI(this.contentEl, this.heading);
			});
		}
	}

	/**
	 * 全局：按语义拆成 7 张卡片，从上到下依次是
	 *   1 插件默认打开位置   2 Inbox 文件路径   3 显示封面图 + 封面图片
	 *   4 工作台名 / slogan（含头部文字总开关）
	 *   5 面板模块（今日概览 / 重要提醒 / 查询）   6 底部统计栏   7 提醒
	 * 一张卡片一个语义块，滚动时一眼能定位到目标设置，不用在一长串行里找。
	 */
	private renderGeneralSection(body: HTMLElement): void {
		const data = this.plugin.settings.data;

		/* ── 卡片 0：界面语言 ──
		   放在最上面：它决定整个面板（乃至视图）用什么语言显示，
		   放下面会被一堆看不懂的文案挡住，等于没有。 */
		{
			const card = body.createDiv( { cls: 'tf-settings-card' });
			card.createDiv( { cls: 'tf-settings-card-caption', text: t('settings.lang.title') });
			const rows = card.createDiv( { cls: 'tf-settings-rows' });

			renderTFRow(rows, {
				title: t('settings.lang.title'),
				description: t('settings.lang.desc'),
				fill: (control) => this.renderLanguageSegment(control),
			});
		}

		/* ── 卡片 1：插件默认打开位置 ── */
		{
			const card = body.createDiv( { cls: 'tf-settings-card' });
			card.createDiv( { cls: 'tf-settings-card-caption', text: t('settings.open.title') });
			const rows = card.createDiv( { cls: 'tf-settings-rows' });

			renderTFRow(rows, {
				title: t('settings.open.subtitle'),
				description:
					t('settings.open.desc') +
					t('settings.open.desc2'),
				fill: (control) => this.renderOpenLocationSegment(control),
			});
		}

		/* ── 卡片 2：Inbox 文件路径 ── */
		{
			const card = body.createDiv( { cls: 'tf-settings-card' });
			card.createDiv( { cls: 'tf-settings-card-caption', text: t('settings.inbox.title') });
			const rows = card.createDiv( { cls: 'tf-settings-rows' });

			renderTFRow(rows, {
				title: t('settings.inbox.title'),
				description: t('settings.inbox.desc'),
				fill: (control) => {
					renderTFFileSuggestRow(control, {
						app: this.plugin.app,
						value: data.inboxFilePath,
						placeholder: t('settings.inbox.placeholder'),
						onPick: (path) => {
							data.inboxFilePath = path;
							void this.saveSettings().then(() => {
								this.rebuildUI();
								showTFToast(t('toast.inboxSet'), 'success');
							});
						},
					});
				},
			});
		}

		/* ── 卡片 3：显示封面图 + 封面图片 ── */
		{
			const card = body.createDiv( { cls: 'tf-settings-card' });
			card.createDiv( { cls: 'tf-settings-card-caption', text: t('settings.cover.title') });
			const rows = card.createDiv( { cls: 'tf-settings-rows' });

			renderTFRow(rows, {
				title: t('settings.cover.show'),
				description: t('settings.cover.showDesc'),
				fill: (control) => {
					renderTFSwitch(control, {
						checked: data.showCover,
						label: t('settings.cover.show'),
						onChange: (value) => {
							data.showCover = value;
							void this.saveSettings();
						},
					});
				},
			});

			renderTFRow(rows, {
				title: t('settings.cover.pick'),
				description: t('settings.cover.pickDesc', { file: COVER_FILE, dir: COVER_DIR }),
				fill: (control) => {
					const file = resolveCoverFile(this.plugin.app, data.coverImagePath);
					control.createSpan( {
						cls: 'tf-settings-row-desc',
						text: file ? file.name : t('settings.cover.none'),
					});

					const picker = control.createEl('input', {
						cls: 'tf-file-input-hidden',
						attr: { type: 'file', accept: 'image/*', 'aria-label': t('settings.cover.aria') },
					});
					picker.addEventListener('change', () => void this.pickCover(picker));

					renderTFRowButton(control, file ? t('settings.cover.change') : t('settings.cover.choose'), 'secondary', () => picker.click());
					if (file) {
						renderTFRowButton(control, t('common.remove'), 'danger', () => void this.clearCover());
					}
				},
			});
		}

		/* ── 卡片 4：工作台名 / slogan（含头部文字总开关）── */
		{
			const card = body.createDiv( { cls: 'tf-settings-card' });
			card.createDiv( { cls: 'tf-settings-card-caption', text: t('settings.head.title') });
			const rows = card.createDiv( { cls: 'tf-settings-rows' });

		renderTFRow(rows, {
			title: t('settings.head.textTitle'),
			description: t('settings.head.textDesc'),
			fill: (control) => {
				renderTFSwitch(control, {
					checked: data.showHeadText,
					label: t('settings.head.textTitle'),
					onChange: (value) => {
						data.showHeadText = value;
						void this.saveSettings();
					},
				});
			},
		});

		renderTFRow(rows, {
			title: t('settings.frontendLimit.show'),
			description: t('settings.frontendLimit.showDesc'),
			fill: (control) => {
				renderTFSwitch(control, {
					checked: data.showFrontendLimit,
					label: t('settings.frontendLimit.show'),
					onChange: (value) => {
						data.showFrontendLimit = value;
						void this.saveSettings();
					},
				});
			},
		});

			renderTFRow(rows, {
				title: t('settings.head.workbench'),
				description: t('settings.head.workbenchDesc', { def: DEFAULT_WORKBENCH_TITLE }),
				fill: (control) => {
					const input = control.createEl('input', {
						cls: 'tf-field-input',
						attr: {
							type: 'text',
							placeholder: DEFAULT_WORKBENCH_TITLE,
							'aria-label': t('settings.head.workbench'),
						},
					});
					input.value = data.workbenchTitle || DEFAULT_WORKBENCH_TITLE;
					input.addEventListener('change', () => {
						// 清空等于回到默认名，否则头部大字会整块消失
						const next = input.value.trim() || DEFAULT_WORKBENCH_TITLE;
						input.value = next;
						if (next === data.workbenchTitle) return;
						data.workbenchTitle = next;
						void this.saveSettings().then(() => showTFToast(t('toast.workbenchUpdated'), 'success'));
					});
				},
			});

			renderTFRow(rows, {
				title: 'Slogan',
				description: t('settings.head.sloganDesc'),
				fill: (control) => {
					const input = control.createEl('input', {
						cls: 'tf-field-input',
						attr: {
							type: 'text',
							placeholder: defaultSlogan(),
							'aria-label': 'Slogan',
						},
					});
					// 存的还是内置默认值时，框里留空、把默认文案放进 placeholder：
					// 一来用户一眼看到的是「当前语言下的默认值」，二来不会把中文默认值
					// 在英文界面里当成自定义文案显示出来。清空即「不要 slogan」。
					input.value = isBuiltinSlogan(data.workbenchSlogan) ? '' : (data.workbenchSlogan ?? '');
					input.addEventListener('change', () => {
						const next = input.value.trim();
						if (next === data.workbenchSlogan) return;
						data.workbenchSlogan = next;
						void this.saveSettings().then(() => showTFToast(t('toast.sloganUpdated'), 'success'));
					});
				},
			});
		}

		/* ── 卡片 5：面板模块（今日概览 / 重要提醒）──
		   两个模块都在快捷输入框上方、并排展示；关掉其一另一个占满整行，都关则整块不渲染。 */
		{
			const card = body.createDiv( { cls: 'tf-settings-card' });
			card.createDiv( {
				cls: 'tf-settings-card-caption',
				text: t('settings.panel.title'),
			});
			const rows = card.createDiv( { cls: 'tf-settings-rows' });

			renderTFRow(rows, {
				title: t('settings.panel.today'),
				description: t('settings.panel.todayDesc'),
				fill: (control) => {
					renderTFSwitch(control, {
						checked: data.showTodayOverview,
						label: t('settings.panel.today'),
						onChange: (value) => {
							data.showTodayOverview = value;
							void this.saveSettings();
						},
					});
				},
			});

			renderTFRow(rows, {
				title: t('settings.panel.important'),
				description: t('settings.panel.importantDesc'),
				fill: (control) => {
					renderTFSwitch(control, {
						checked: data.showImportantReminders,
						label: t('settings.panel.important'),
						onChange: (value) => {
							data.showImportantReminders = value;
							void this.saveSettings();
						},
					});
				},
			});

			renderTFRow(rows, {
				title: t('settings.panel.query'),
				description: t('settings.panel.queryDesc'),
				fill: (control) => {
					const ta = control.createEl('textarea', {
						cls: 'tf-field-textarea tf-important-query',
						attr: { rows: '4', 'aria-label': t('settings.panel.query'), placeholder: DEFAULT_IMPORTANT_QUERY },
					});
					ta.value = data.importantReminderQuery ?? DEFAULT_IMPORTANT_QUERY;
					ta.addEventListener('change', () => {
						data.importantReminderQuery = ta.value;
						void this.saveSettings().then(() => showTFToast(t('toast.queryUpdated'), 'success'));
					});
					renderTFRowButton(control, t('common.reset'), 'ghost', () => {
						ta.value = DEFAULT_IMPORTANT_QUERY;
						data.importantReminderQuery = DEFAULT_IMPORTANT_QUERY;
						void this.saveSettings().then(() => showTFToast(t('toast.queryReset'), 'success'));
					});
				},
			});
		}

		/* ── 卡片 6：底部统计栏 ── */
		{
			const card = body.createDiv( { cls: 'tf-settings-card' });
			card.createDiv( { cls: 'tf-settings-card-caption', text: t('settings.stats.title') });
			const rows = card.createDiv( { cls: 'tf-settings-rows' });

			renderTFRow(rows, {
				title: t('settings.stats.categories'),
				description: t('settings.stats.categoriesDesc'),
				fill: (control) => {
					renderTFSwitch(control, {
						checked: data.showStatsCategories,
						label: t('settings.stats.categories'),
						onChange: (value) => {
							data.showStatsCategories = value;
							void this.saveSettings();
							// 视图若已打开，就地同步折叠态，无需重载插件
							this.plugin.applyStatsCategories(value);
						},
					});
				},
			});
		}

	/* ── 卡片 6.5：紧凑模式 ──
	   触发是自动的：窄窗口（<360px）/ 侧边栏 / 移动端任一命中即进入紧凑，
	   三个场景字段（compactNarrow/Sidebar/Mobile）默认全开且不在面板露出，
	   避免让用户做不必要的决定；需要时仍可手改 data.json。
	   面板只留五个模块独立开关（封面 / 标题 / 今日概览 / 重要提醒 / 底部统计）：
	   用户可单独把某个模块留在紧凑界面里。开关为「独立显示」语义——
	   即便常规模式关了某模块，紧凑里也能单独打开它。
	   改完即时同步已打开的视图，无需重载插件。 */
	{
		const card = body.createDiv( { cls: 'tf-settings-card' });
		card.createDiv( { cls: 'tf-settings-card-caption', text: t('settings.compact.title') });
		const rows = card.createDiv( { cls: 'tf-settings-rows' });

		renderTFRow(rows, {
			title: t('settings.compact.hideBanner'),
			description: t('settings.compact.hideBannerDesc'),
			fill: (control) => {
				renderTFSwitch(control, {
					checked: data.compactHideBanner,
					label: t('settings.compact.hideBanner'),
					onChange: (value) => {
						data.compactHideBanner = value;
						void this.saveSettings();
						this.plugin.applyCompact();
					},
				});
			},
		});

		renderTFRow(rows, {
			title: t('settings.compact.hideTitle'),
			description: t('settings.compact.hideTitleDesc'),
			fill: (control) => {
				renderTFSwitch(control, {
					checked: data.compactHideTitle,
					label: t('settings.compact.hideTitle'),
					onChange: (value) => {
						data.compactHideTitle = value;
						void this.saveSettings();
						this.plugin.applyCompact();
					},
				});
			},
		});

		renderTFRow(rows, {
			title: t('settings.compact.hideTodayOverview'),
			description: t('settings.compact.hideTodayOverviewDesc'),
			fill: (control) => {
				renderTFSwitch(control, {
					checked: data.compactHideTodayOverview,
					label: t('settings.compact.hideTodayOverview'),
					onChange: (value) => {
						data.compactHideTodayOverview = value;
						void this.saveSettings();
						this.plugin.applyCompact();
					},
				});
			},
		});

		renderTFRow(rows, {
			title: t('settings.compact.hideImportantReminders'),
			description: t('settings.compact.hideImportantRemindersDesc'),
			fill: (control) => {
				renderTFSwitch(control, {
					checked: data.compactHideImportantReminders,
					label: t('settings.compact.hideImportantReminders'),
					onChange: (value) => {
						data.compactHideImportantReminders = value;
						void this.saveSettings();
						this.plugin.applyCompact();
					},
				});
			},
		});

		renderTFRow(rows, {
			title: t('settings.compact.hideStats'),
			description: t('settings.compact.hideStatsDesc'),
			fill: (control) => {
				renderTFSwitch(control, {
					checked: data.compactHideStats,
					label: t('settings.compact.hideStats'),
					onChange: (value) => {
						data.compactHideStats = value;
						void this.saveSettings();
						this.plugin.applyCompact();
					},
				});
			},
		});
	}

	/* ── 卡片 7：提醒 ── */
	{
		const card = body.createDiv( { cls: 'tf-settings-card' });
		card.createDiv( { cls: 'tf-settings-card-caption', text: t('settings.noticeTitle') });
		const note = card.createDiv( { cls: 'tf-settings-note' });
		setIcon(note.createSpan( { cls: 'tf-settings-note-icon' }), 'info');
		note.createSpan( {
			cls: 'tf-settings-note-text',
			text: t('settings.notice'),
		});
	}
	}

	/** 「主窗口 / 右侧边栏」二选一：分段控件，选中项有底色 + 图标 */
	/** 界面语言：跟随系统 / 中文 / English 三选一，切换后立刻重建面板与所有视图 */
	private renderLanguageSegment(control: HTMLElement): void {
		const current: LangSetting = this.plugin.settings.language ?? 'auto';
		const seg = control.createDiv( {
			cls: 'tf-segmented tf-segmented-wide',
			attr: { role: 'group', 'aria-label': t('settings.lang.title') },
		});

		const options: { value: LangSetting; label: string; icon: string }[] = [
			{ value: 'auto', label: t('settings.lang.follow'), icon: 'globe' },
			{ value: 'zh', label: t('settings.lang.zh'), icon: 'languages' },
			{ value: 'en', label: t('settings.lang.en'), icon: 'languages' },
		];

		for (const opt of options) {
			const isActive = current === opt.value;
			const btn = seg.createEl('button', {
				cls: isActive ? 'tf-segmented-btn is-active' : 'tf-segmented-btn',
				attr: { type: 'button', 'aria-pressed': isActive ? 'true' : 'false' },
			});
			setIcon(btn.createSpan({ cls: 'tf-segmented-btn-icon' }), opt.icon);
			btn.createSpan({ cls: 'tf-segmented-btn-label', text: opt.label });
			btn.addEventListener('click', () => {
				if (current === opt.value) return;
				this.plugin.applyLanguage(opt.value);
				this.rebuildUI();
			});
		}
	}

	private renderOpenLocationSegment(control: HTMLElement): void {
		const data = this.plugin.settings.data;
		const seg = control.createDiv( {
			cls: 'tf-segmented',
			attr: { role: 'group', 'aria-label': t('settings.open.title') },
		});

		const options: { value: OpenLocation; label: string; icon: string }[] = [
			{ value: 'main', label: t('settings.open.main'), icon: 'layout-dashboard' },
			{ value: 'sidebar', label: t('settings.open.sidebar'), icon: 'panel-right' },
		];

		for (const opt of options) {
			const isActive = data.openLocation === opt.value;
			const btn = seg.createEl('button', {
				cls: isActive ? 'tf-segmented-btn is-active' : 'tf-segmented-btn',
				attr: { type: 'button', 'aria-pressed': isActive ? 'true' : 'false' },
			});
			setIcon(btn.createSpan({ cls: 'tf-segmented-btn-icon' }), opt.icon);
			btn.createSpan({ cls: 'tf-segmented-btn-label', text: opt.label });
			btn.addEventListener('click', () => {
				if (data.openLocation === opt.value) return;
				data.openLocation = opt.value;
				void this.saveSettings().then(() => this.rebuildUI());
			});
		}
	}

	/** 关于：插件简介 + GitHub 仓库 + 作者。纯展示页，不写任何设置项。 */
	private renderAboutSection(body: HTMLElement): void {
		/* 卡片 1：TaskFlow 简介 */
		{
			const card = body.createDiv( { cls: 'tf-settings-card' });
			card.createDiv( { cls: 'tf-settings-card-caption', text: t('about.introTitle') });

		const hero = card.createDiv( { cls: 'tf-about-hero' });
		// 与 Ribbon 用同一个品牌图标，界面前后呼应；挂载失败回落 layout-dashboard
		const mark = hero.createDiv( { cls: 'tf-about-mark' });
		if (!mountTrustedSvg(mark, TASKFLOW_ICON_SVG)) {
			setIcon(mark, 'layout-dashboard');
		}
			const heroText = hero.createDiv( { cls: 'tf-about-hero-text' });
			heroText.createDiv( { cls: 'tf-about-title', text: 'TaskFlow' });
			heroText.createDiv( { cls: 'tf-about-subtitle', text: t('default.slogan') });

		card.createDiv( { cls: 'tf-about-text', text: t('about.intro1') });
		card.createDiv( { cls: 'tf-about-text', text: t('about.intro2') });
		card.createDiv( { cls: 'tf-about-text', text: t('about.intro3') });
		}

		/* 卡片 2：Github Repository */
		{
			const card = body.createDiv( { cls: 'tf-settings-card' });
			card.createDiv( { cls: 'tf-settings-card-caption', text: 'Github Repository' });
			const rows = card.createDiv( { cls: 'tf-settings-rows' });

			renderTFRow(rows, {
				title: t('about.githubTitle'),
				description: t('about.githubDesc'),
				fill: (control) => this.renderLinkButton(control, REPO_URL, 'github', t('about.githubBtn')),
			});
		}

		/* 卡片 3：作者 */
		{
			const card = body.createDiv( { cls: 'tf-settings-card' });
			card.createDiv( { cls: 'tf-settings-card-caption', text: t('about.authorTitle') });
			const rows = card.createDiv( { cls: 'tf-settings-rows' });

			for (const line of [
				t('about.author1'),
				t('about.author2'),
				t('about.author3'),
			]) {
				const item = rows.createDiv( { cls: 'tf-about-bullet' });
				item.createSpan( { cls: 'tf-about-bullet-dot', text: '•' });
				item.createSpan( { cls: 'tf-about-bullet-text', text: line });
			}

			renderTFRow(rows, {
				title: t('about.moreTitle'),
				description: t('about.moreDesc'),
				fill: (control) =>
					this.renderLinkButton(control, AUTHOR_SITE_URL, 'link', t('about.moreBtn')),
			});
		}
	}

	/** 「关于」页的外链：图标按钮 + 可点网址，点击走系统浏览器打开 */
	private renderLinkButton(control: HTMLElement, href: string, icon: string, label: string): void {
		const btn = control.createEl('a', {
			cls: 'tf-link-btn',
			attr: { href, target: '_blank', rel: 'noopener noreferrer' },
		});
		setIcon(btn.createSpan({ cls: 'tf-link-btn-icon' }), icon);
		btn.createSpan({ cls: 'tf-link-btn-label', text: label });
		// Obsidian 里裸 <a> 不一定会跳浏览器，显式开一次更稳
		btn.addEventListener('click', (e) => {
			e.preventDefault();
			window.open(href, '_blank');
		});
		// 网址只在按钮上出现一次：早先按钮旁还跟了一行裸网址，两处重复且割裂
	}

	/** 设置面板里选封面：与视图头部的「插入封面」走同一套存取逻辑 */
	private async pickCover(picker: HTMLInputElement): Promise<void> {
		const file = picker.files?.[0];
		// 先清空：不清的话，再选同一个文件不会再触发 change
		picker.value = '';
		if (!file) return;
		try {
			await persistCoverImage(this.plugin, file);
			this.rebuildUI();
			showTFToast(t('toast.bannerUpdated'), 'success');
		} catch (error) {
			console.error('[TaskFlow] 保存横幅失败:', error);
			showTFToast(
				t('toast.bannerSaveFail') + (error instanceof Error ? error.message : String(error)),
				'error',
			);
		}
	}

	private async clearCover(): Promise<void> {
		try {
			await removeCoverImage(this.plugin);
			this.rebuildUI();
			showTFToast(t('toast.bannerRemoved'), 'success');
		} catch (error) {
			console.error('[TaskFlow] 移除横幅失败:', error);
			showTFToast(
				t('toast.bannerRemoveFail') + (error instanceof Error ? error.message : String(error)),
				'error',
			);
		}
	}

	/** 分组管理：每行一个分组 */
	private renderGroupsSection(body: HTMLElement): void {
		const data = this.plugin.settings.data;
		const card = body.createDiv( { cls: 'tf-settings-card' });
		const rows = card.createDiv( { cls: 'tf-settings-rows' });

		for (const group of data.groups) {
			const isBuiltIn = ['gtd', 'time', 'tag'].includes(group.id);
			const tabCount = data.globalTabs.filter(
				(tab) => getTabGroup(tab, data.groups) === group.id,
			).length;

			renderTFRow(rows, {
				title: group.label,
				description: t('settings.group.idLine', {
					id: group.id,
					count: tabCount,
					suffix: isBuiltIn ? t('common.builtinSuffix') : '',
				}),
				fill: (control) => {
					renderTFRowButton(control, t('common.edit'), 'secondary', () => this.openGroupEditModal(group));
					if (!isBuiltIn) {
						renderTFRowButton(control, t('common.delete'), 'danger', () => this.confirmDeleteGroup(group));
					}
				},
			});
		}

		renderTFAddRow(card, t('settings.addGroup'), () => this.openAddGroupModal());
	}

	/**
	 * Tabs 管理：一个分组一张卡片，标题通栏带背景色，可折叠。
	 * 默认折叠 —— 分组一多，展开状态下要滚很久才能找到目标分组。
	 */
	private renderTabsSection(body: HTMLElement): void {
		const data = this.plugin.settings.data;

		for (const group of data.groups) {
			const card = body.createDiv( { cls: 'tf-settings-card' });

			const collapsed = this.isGroupCollapsed(group.id);
			const header = card.createEl('button', {
				cls: 'tf-settings-group-header',
				attr: { type: 'button', 'aria-expanded': collapsed ? 'false' : 'true' },
			});
			const chevron = header.createSpan( { cls: 'tf-settings-group-chevron' });
			setIcon(chevron, collapsed ? 'chevron-right' : 'chevron-down');
			header.createSpan( { cls: 'tf-settings-group-title', text: group.label });
			// 折叠时也看得见该组有几个 tab，不用逐个展开去找
			const groupTabCount = data.globalTabs.filter(
				(tab) => getTabGroup(tab, data.groups) === group.id,
			).length;
			header.createSpan( {
				cls: 'tf-settings-group-count',
				text: t('settings.group.tabCount', { n: groupTabCount }),
			});

			const content = card.createDiv( { cls: 'tf-settings-group-content' });
			content.toggleClass('is-collapsed', collapsed);

			header.addEventListener('click', () => {
				const next = !this.isGroupCollapsed(group.id);
				this.groupCollapsed[group.id] = next;
				content.toggleClass('is-collapsed', next);
				setIcon(chevron, next ? 'chevron-right' : 'chevron-down');
				header.setAttribute('aria-expanded', next ? 'false' : 'true');
			});

			const rows = content.createDiv( { cls: 'tf-settings-rows' });

			const groupTabs = data.globalTabs
				.filter((tab) => getTabGroup(tab, data.groups) === group.id)
				.sort((a, b) => a.order - b.order);

			if (groupTabs.length === 0) {
				renderTFEmptyRow(rows, t('settings.noTabs'));
			}

		for (const tab of groupTabs) {
			renderTFRow(rows, {
				title: localizedTabLabel(tab),
				description: this.describeTab(tab),
				fill: (control) => {
					// 章节头开关直接落在行上：以前必须开弹窗才能改
					renderTFSwitch(control, {
						checked: Boolean(tab.showSectionHeader),
						caption: t('settings.showHeader'),
						label: t('settings.tab.headerToggle', { label: localizedTabLabel(tab) }),
							onChange: (value) => {
								tab.showSectionHeader = value;
								void this.saveSettings().then(() => {
									this.plugin.refreshAllViews();
									showTFToast(value ? t('toast.headerShown') : t('toast.headerHidden'), 'success');
								});
							},
						});
						renderTFRowButton(control, t('common.edit'), 'secondary', () => this.openTabEditModal(tab));
						renderTFRowButton(control, t('common.delete'), 'danger', () => this.confirmDeleteTab(tab));
					},
				});
			}

			renderTFAddRow(content, t('settings.tab.addToGroup', { group: group.label }), () =>
				this.openAddTabModal(group.id),
			);
		}
	}

	/** 行的说明文字：查询摘要 + 顺序 */
	private describeTab(tab: TabConfig): string {
		const firstLine = tab.query.split('\n')[0]?.trim() ?? '';
		return t('settings.tab.metaLine', { query: firstLine, order: tab.order });
	}

	/** 确认删除分组 */
	private confirmDeleteGroup(group: { id: string; label: string }): void {
		new ConfirmModal(
			this.plugin.app,
			t('settings.confirm.deleteGroup', { name: group.label }),
			() => {
				const data = this.plugin.settings.data;
				data.globalTabs = data.globalTabs.filter(
					(tab) => getTabGroup(tab, data.groups) !== group.id,
				);
				const index = data.groups.findIndex((g) => g.id === group.id);
				if (index !== -1) data.groups.splice(index, 1);

				void this.saveSettings().then(() => {
					this.plugin.refreshAllViews();
					this.rebuildUI();
					showTFToast(t('toast.groupDeleted'), 'success');
				});
			},
		).open();
	}

	/** 确认删除 Tab */
	private confirmDeleteTab(tab: TabConfig): void {
		new ConfirmModal(
			this.plugin.app,
			t('settings.confirm.deleteTab', { name: localizedTabLabel(tab) }),
			() => {
				const index = this.plugin.settings.data.globalTabs.indexOf(tab);
				if (index === -1) return;
				this.plugin.settings.data.globalTabs.splice(index, 1);

				void this.saveSettings().then(() => {
					this.plugin.refreshAllViews();
					this.rebuildUI();
					showTFToast(t('toast.tabDeleted'), 'success');
				});
			},
		).open();
	}

	/** 就地重建设置面板：列表与配置保持一致，并停在当前分组 */
	private rebuildUI(): void {
		if (this.contentEl) void this.constructUI(this.contentEl, this.heading);
	}

	// ============================================
	// 辅助方法
	// ============================================

	private async saveSettings(): Promise<void> {
		await this.plugin.saveSettings();
	}

	/** 打开编辑 tab 的模态框 */
	private openTabEditModal(tab: TabConfig): void {
		TFEditModal.launch(
			new TabEditModal(this.plugin.app, this.plugin, tab, (updatedTab: TabConfig) => {
				const index = this.plugin.settings.data.globalTabs.findIndex((t) => t.id === tab.id);
				if (index === -1) return;
				this.plugin.settings.data.globalTabs[index] = updatedTab;
				void this.saveSettings().then(() => {
					this.plugin.refreshAllViews();
					this.rebuildUI();
					showTFToast(t('toast.tabUpdated'), 'success');
				});
			}),
			t('modal.editTabDialog'),
		);
	}

	/** 打开添加新 tab 的模态框 */
	private openAddTabModal(groupId: TabGroup): void {
		const newTab: TabConfig = {
			id: `tab_${Date.now()}`,
			label: t('settings.newTab'),
			query: 'not done\ngroup by filename\nlimit 10',
			showSectionHeader: false,
			order: this.plugin.settings.data.globalTabs.length + 1,
			group: groupId,
		};
		// 新建：即使一个字都没改，点「保存」也要落盘（forceSave）
		TFEditModal.launch(
			new TabEditModal(
				this.plugin.app,
				this.plugin,
				newTab,
				(updatedTab: TabConfig) => {
					this.plugin.settings.data.globalTabs.push(updatedTab);
					void this.saveSettings().then(() => {
						this.plugin.refreshAllViews();
						this.rebuildUI();
						showTFToast(t('toast.tabCreated'), 'success');
					});
				},
				true,
			),
			t('modal.newTabDialog'),
		);
	}

	/** 打开编辑分组的模态框 */
	private openGroupEditModal(group: TabGroupConfig): void {
		const modal = new GroupEditModal(this.plugin.app, group, (updatedGroup) => {
			const index = this.plugin.settings.data.groups.findIndex((g) => g.id === group.id);
			if (index === -1) return;
			this.plugin.settings.data.groups[index] = updatedGroup;
			void this.saveSettings().then(() => {
				this.plugin.refreshAllViews();
				this.rebuildUI();
				showTFToast(t('toast.groupUpdated'), 'success');
			});
		});
		TFEditModal.launch(modal, t('modal.editGroupDialog'));
	}

	/** 打开添加新分组的模态框 */
	private openAddGroupModal(): void {
		const modal = new GroupEditModal(this.plugin.app, { id: '', label: '', icon: 'folder' }, (updatedGroup) => {
			// 生成唯一 ID
			const baseId = updatedGroup.id.toLowerCase().replace(/[^a-z0-9]/g, '-');
			let uniqueId = baseId;
			let counter = 1;
			while (this.plugin.settings.data.groups.some((g) => g.id === uniqueId)) {
				uniqueId = `${baseId}-${counter}`;
				counter++;
			}
			updatedGroup.id = uniqueId;

			this.plugin.settings.data.groups.push(updatedGroup);
			void this.saveSettings().then(() => {
				this.plugin.refreshAllViews();
				this.rebuildUI();
				showTFToast(t('toast.groupCreated'), 'success');
			});
		});
		TFEditModal.launch(modal, t('modal.newGroupDialog'));
	}

}


export class TaskViewsSettingTab extends PluginSettingTab {
	plugin: TaskViewsPlugin;
	private settingsManager: SettingsManager;

	constructor(app: App, plugin: TaskViewsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.settingsManager = new SettingsManager(plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("taskflow-setting-tab");
		void this.settingsManager.constructUI(containerEl, "TaskFlow Settings");
	}

	hide(): void {
		// No cleanup needed currently
	}
}

