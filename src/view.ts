import { App, Component, ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import type TaskViewsPlugin from './main';
import type { TabConfig, TabGroup, TabGroupConfig, Task } from './types';
import {
	clampCoverPosition,
	DEFAULT_IMPORTANT_QUERY,
	getTabGroup,
	getFrontmatterValue,
	matchesFrontmatterFilter,
	resolveSlogan,
	DEFAULT_WORKBENCH_TITLE,
} from './types';
import { persistCoverImage, removeCoverImage, resolveCoverFile } from './cover';
import { defaultBannerSvg } from './brand';
import { mountTrustedSvg } from './svg';
import { formatHeadClock, lunarCN, weekdayName } from './lunar';
import { getUiLang, localizedTabLabel, t } from './i18n';
import { ScanCache } from './cache-manager';

export const VIEW_TYPE_TASKFLOW = 'taskflow-view';

type TabId = string;

/**
 * Tasks 插件的查询结果**不是同步写进容器的**：它内部通过 child 组件在后续
 * tick 里渲染，所以 `MarkdownRenderer.render()` 的 Promise resolve 时，
 * `.task-list-item` 往往还不存在。而且它还会在自身缓存失效后**重新渲染**
 * 同一个容器（例如某条任务被勾掉、或文件被修改）。
 *
 * 因此「本 tab 有没有任务」不能靠一次定时轮询去猜——会和 Tasks 的真实渲染
 * 时序竞态，表现为空状态「出现得很随机、和任务状态对不上」。
 *
 * 正确做法：每个 tab 的 body 挂一个 `MutationObserver`，由**真实 DOM 变化**
 * 驱动空状态判定：
 * - 任务项一出现，立刻撤掉空状态（不等待，保证有任务时绝不留空状态）；
 * - 任务项消失后，等容器「静默」EMPTY_QUIET_MS 毫秒没再变动，才显示空状态
 *   （避免渲染中途的瞬时空窗误触发）。
 * 这样无论「无→有」「有→无」还是 Tasks 自身后续重渲染，空状态都稳定跟随
 * 容器里是否真的有 `.task-list-item`，且天然双向、无竞态。
 */
const EMPTY_QUIET_MS = 250;

/**
 * Tasks 的 `show tree` 指令在 7.12.0 引入，且 Tasks 侧默认是关闭的。
 * 低于这个版本注入会变成未知指令（Tasks 会在结果里报一行错误），所以必须卡版本。
 */
const TASKS_PLUGIN_ID = 'obsidian-tasks-plugin';

/**
 * Tasks 插件实例的最小类型（只取统计需要的 `getTasks`）。
 * 运行时拿不到官方类型（插件未作为依赖），用结构化最小接口描述，
 * 既能消掉 `any` 引发的 `no-unsafe-*`，又不耦合具体插件版本。
 */
interface TasksPluginLike {
	getTasks: () => unknown[];
}

/** Tasks 单条任务的最小类型（统计只关心 status / dueDate / doneDate）。 */
interface TasksTaskLike {
	status?: { type?: string };
	dueDate?: unknown;
	doneDate?: unknown;
}

/**
 * 列出 Tasks 插件的**候选**实例，交给调用方按能力挑。
 *
 * 社区文档里的标准写法是 `app.plugins.plugins[id]`（`app.plugins` 是 `Plugins`
 * 对象，实例在它下面的 map 里）。但本项目历史桩、以及实测环境里
 * `app.plugins[id]` 也能取到 —— 两种形态都存在，所以**不做二选一**，
 * 而是都列出来：谁能提供需要的能力就用谁。
 * 这样既不会把已跑通的统计口径改坏，也能覆盖标准形态。
 */
function getTasksPluginCandidates(app: App): TasksPluginLike[] {
	const plugins = app.plugins;
	const candidates: unknown[] = [plugins.plugins[TASKS_PLUGIN_ID], plugins[TASKS_PLUGIN_ID]];
	return candidates.filter(
		(p): p is TasksPluginLike =>
			typeof (p as { getTasks?: unknown })?.getTasks === 'function',
	);
}

/**
 * 底部统计的数据形状（与 Tasks 插件的 StatusType 对齐）。
 * 不再使用 task-flow 自写的 8 类 status 字符串，改走 Tasks 解析器的口径。
 */
type StatStatus =
	| 'TODO' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED' | 'ON_HOLD' | 'NON_TASK' | 'EMPTY';

interface StatTask {
	statusType: StatStatus;
	due: string | null; // YYYY-MM-DD 或 null
	doneDate: string | null; // 完成日期 YYYY-MM-DD（Tasks 的 doneDate / 自带解析的 completionDate），用于「今日完成 / 本周完成」
}

/** Tasks 插件不可用时回退到自带扫描，把旧 status 字符串映射到 StatusType 词汇。
 *  migrated/pending/waiting 在 Tasks 里并无对应类型，统一并入 TODO（未完成任务）。 */
const FALLBACK_STATUS_MAP: Record<string, StatStatus> = {
	'todo': 'TODO',
	'in-progress': 'IN_PROGRESS',
	'done': 'DONE',
	'cancel': 'CANCELLED',
	'migrated': 'TODO',
	'pending': 'TODO',
	'waiting': 'TODO',
};

/** 把 due 日期统一成 YYYY-MM-DD 字符串：Tasks 的 Moment 用 .format，自带解析已是字符串。 */
function dueToStr(due: unknown): string | null {
	if (!due) return null;
	if (typeof due === 'string') return due;
	// Tasks 用 Moment 对象，Moment.format 是函数；用结构化判断避免 any 调用
	const momentLike = due as { format?: unknown };
	if (typeof momentLike.format === 'function') {
		return (momentLike.format as (fmt: string) => string)('YYYY-MM-DD');
	}
	return null;
}

function flattenOwn(tasks: Task[]): Task[] {
	return tasks.flatMap((t) => [t, ...flattenOwn(t.children)]);
}

function getToday(): string {
	const d = new Date();
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	const dd = String(d.getDate()).padStart(2, '0');
	return `${yyyy}-${mm}-${dd}`;
}

function pad2(n: number): string {
	return String(n).padStart(2, '0');
}

/** YYYY-MM-DD 加减 n 天，返回 YYYY-MM-DD（字符串比较即可判定先后） */
function addDaysStr(yyyyMmDd: string, n: number): string {
	const parts = yyyyMmDd.split('-').map(Number);
	const y = parts[0] ?? 0;
	const m = parts[1] ?? 1;
	const d = parts[2] ?? 1;
	const dt = new Date(y, m - 1, d + n);
	return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

/** 本周一（周一为一周起点）的 YYYY-MM-DD */
function weekStartStr(today: string): string {
	const parts = today.split('-').map(Number);
	const y = parts[0] ?? 0;
	const m = parts[1] ?? 1;
	const d = parts[2] ?? 1;
	// getDay(): 日=0 周=6 → 转成 周一=0
	const dow = (new Date(y, m - 1, d).getDay() + 6) % 7;
	return addDaysStr(today, -dow);
}

/** 头部时间每 30 秒自刷一次：够用，又不至于频繁唤醒定时器 */
const HEAD_CLOCK_INTERVAL_MS = 30_000;

/**
 * 编辑触发的刷新节奏（见 scheduleRefresh）：
 * - 统计立即可见（短防抖），底部胶囊随改动更新；
 * - 内容等 vault 安静后才重渲染（长防抖）。
 * 大 vault 上每个 tab 的 Tasks 渲染都要整库解析，连发改动时若每次都重跑会占满主线程卡死。
 */
const STATS_DEBOUNCE_MS = 400;
const CONTENT_IDLE_MS = 1200;
/** 计数徽标去抖：DOM 变动期间只算一次，而不是每次 mutation 都 querySelectorAll 全表 */
const COUNT_DEBOUNCE_MS = 40;

/**
 * 统计到 0 个任务时的重试延迟（毫秒），按顺序各试一次。
 *
 * 视图 `onOpen()` 里立刻就会 refresh 一次，而 Tasks 插件的索引往往还没建好 ——
 * 这时它的 `getTasks()` 返回空数组，直接定性成「vault 里没有任务」是错的。
 * 所以拿到 0 先按这几档延迟重试几次，等 Tasks 就绪；重试耗尽仍为 0 才提示。
 */
const ZERO_RETRY_DELAYS = [800, 2000, 5000];

/**
 * 单个 tab 的 Tasks 渲染超过这个毫秒数就打一条 warn（带 tab 名和 query）。
 * 只是诊断，不打断渲染——卡死类问题最难的是定位「到底哪一条 query 慢」，
 * 有了这条日志，用户贴控制台就能直接指到具体 tab。
 */
const RENDER_SLOW_MS = 1500;

export class TaskFlowView extends ItemView {
	private plugin: TaskViewsPlugin;
	private statTasks: StatTask[] = [];
	private activeGroup: TabGroup = 'gtd';
	private activeTab: TabId = 'gtd-inbox';
	private activeTabByGroup: Record<string, TabId> = {};
	private selectedGroupNotePaths: Record<string, string> = {};
	private groupNoteSelectorEl: HTMLElement | null = null;
	private cacheManager: ScanCache;

	// Group tab elements
	private groupBtns: Record<string, HTMLElement> = {};

	// Tab elements
	private tabBtns: Record<TabId, HTMLElement> = {};
	private tabPanels: Record<TabId, HTMLElement> = {};
	private tabBodies: Record<TabId, HTMLElement> = {};
	private tabCounts: Record<TabId, HTMLElement> = {};
	private tabCollapsed: Record<TabId, boolean> = {};
	// 每个 tab 所属分组（构建时快照，切换分组时用它决定显示哪些 tab）
	private tabGroups: Record<TabId, TabGroup> = {};
	// 分组下没有 tab 时的占位提示
	private emptyGroupEl: HTMLElement | null = null;
	/** 占位提示里的分组名标题 —— 切换一级 tab 时要跟着改文案 */
	private emptyGroupTitleEl: HTMLElement | null = null;
	/** 渲染轮次：异步等待期间若又触发了新一轮 refresh，旧轮次就放弃后续 DOM 操作 */
	private renderEpoch = 0;
	/** 每个 body 上「静默后判定为空」的待定定时器，避免重复排程 */
	private emptyTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
	/**
	 * 每个渲染点专属的生命周期组件（key：`tab:<id>` / `important`）。
	 *
	 * `MarkdownRenderer.render()` 的第 5 个参数是「父组件」，Tasks 的 QueryRenderer
	 * 会 addChild 到它上面并注册 vault 监听，**只有 unload() 才会卸掉**。
	 * 以前这里一直传 `this`（整个 View），而 `body.empty()` 只清 DOM、不卸载子组件，
	 * 于是每切一次 tab / 每重建一次界面就留下一批活着的 Tasks 渲染器：
	 * 文件一改动它们全体重跑整库查询，越用越卡，最后表现为「点某个 tab 直接卡死」。
	 * 现在每个渲染点独占一个 Component，重渲染前先卸载旧的。
	 */
	private renderComponents = new Map<string, Component>();

	// Stats elements
	private statsEl: HTMLElement | null = null;
	private statsChevron: HTMLElement | null = null;
	private progressFill: HTMLElement | null = null;
	private statsPct: HTMLElement | null = null;
	private pillOverdue: HTMLElement | null = null;
	private pillInProgress: HTMLElement | null = null;
	private pillTodo: HTMLElement | null = null;
	private pillCancel: HTMLElement | null = null;
	private pillDone: HTMLElement | null = null;
	private pillTotal: HTMLElement | null = null;

	// 今日概览（Today overview）元素引用：只在 showTodayOverview 时构建
	private toTodoEl: HTMLElement | null = null;
	private toDoneEl: HTMLElement | null = null;
	private toInProgressEl: HTMLElement | null = null;
	private toOverdueEl: HTMLElement | null = null;
	private toWeekEl: HTMLElement | null = null;
	private toRingTodayDial: HTMLElement | null = null;
	private toRingTodayText: HTMLElement | null = null;
	private toRingWeekDial: HTMLElement | null = null;
	private toRingWeekText: HTMLElement | null = null;

	// 重要提醒（Important reminders）模块
	private importantBodyEl: HTMLElement | null = null;
	private importantMoreEl: HTMLElement | null = null;
	/** 「更多任务」展开态：默认折叠（最多显示 3 条），点击展开看全部；每次重渲染复位成折叠 */
	private importantExpanded = false;
	/** 空状态静默判定定时器 */
	private importantEmptyTimer: ReturnType<typeof setTimeout> | null = null;

	// Header (workbench banner)
	private headTimeEl: HTMLElement | null = null;
	private headMetaEl: HTMLElement | null = null;
	/** window.setInterval 的句柄（DOM 环境是 number，不是 Node 的 Timeout） */
	private headClockTimer: number | null = null;

	/** 刷新调度：保证同一时刻只有一个刷新在跑，避免大 vault 上多次整库解析并发占满主线程 */
	private refreshBusy = false;
	private refreshQueued = false;
	private statsTimer: ReturnType<typeof setTimeout> | null = null;
	private contentTimer: ReturnType<typeof setTimeout> | null = null;
	/** 「统计到 0 个任务」的重试定时器与已重试次数（等 Tasks 插件建好索引） */
	private zeroRetryTimer: ReturnType<typeof setTimeout> | null = null;
	private zeroRetries = 0;
	/** 每个 body 的计数去抖定时器 */
	private countTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
	/** 已挂载空状态观察者的 tab body（幂等，避免重复挂 MutationObserver） */
	private observedBodies = new WeakSet<HTMLElement>();
	/** 已挂载观察者的「重要提醒」body */
	private observedImportantBodies = new WeakSet<HTMLElement>();

	constructor(leaf: WorkspaceLeaf, plugin: TaskViewsPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.cacheManager = new ScanCache(plugin.app);
		this.syncActiveTab();
	}

	// ── Group / tab resolution ──────────────────────────

	/** 当前配置里的分组列表 */
	private getGroups(): TabGroupConfig[] {
		return this.plugin.settings.data.groups || [];
	}

	/** 某个分组下的 tab，按 order 排序。与设置面板使用同一条归属规则。 */
	private getTabsForGroup(group: TabGroup): TabConfig[] {
		const groups = this.getGroups();
		return [...this.getTabs()]
			.filter((t) => getTabGroup(t, groups) === group)
			.sort((a, b) => a.order - b.order);
	}

	private getGroupNoteFiles(group: TabGroup): TFile[] {
		const config = this.getGroups().find((item) => item.id === group);
		const property = config?.frontmatterProperty?.trim();
		if (!property) return [];
		return this.app.vault.getMarkdownFiles()
			.filter((file) => matchesFrontmatterFilter(
				getFrontmatterValue(this.app.metadataCache.getFileCache(file)?.frontmatter, property),
				config?.frontmatterValues,
			))
			.sort((left, right) => left.path.localeCompare(right.path));
	}

	private getSelectedGroupNote(group: TabGroup): TFile | undefined {
		const selectedPath = this.selectedGroupNotePaths[group];
		return this.getGroupNoteFiles(group).find((file) => file.path === selectedPath);
	}

	private renderGroupNoteSelector(): void {
		const host = this.groupNoteSelectorEl;
		if (!host) return;
		host.empty();
		const group = this.getGroups().find((item) => item.id === this.activeGroup);
		if (!group) return;
		if (group.frontmatterProperty?.trim()) this.renderGroupNoteSelect(host, group);
		this.renderGroupLimitInput(host, group);
	}

	private renderGroupLimitInput(host: HTMLElement, group: TabGroupConfig): void {
		const input = host.createEl('input', {
			cls: 'tasks-view-group-limit-input',
			attr: {
				type: 'number',
				min: '1',
				step: '1',
				placeholder: t('view.group.limit'),
				title: t('view.group.limitDesc'),
				'aria-label': t('view.group.limitDesc'),
			},
		});
		input.value = group.taskLimit ? String(group.taskLimit) : '';
		input.addEventListener('change', () => {
			const parsed = parseInt(input.value, 10);
			const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
			input.value = limit ? String(limit) : '';
			if (limit === group.taskLimit) return;
			group.taskLimit = limit;
			void this.plugin.saveHeadSettings();
			void this.renderActiveTabGuarded();
		});
	}

	private renderGroupNoteSelect(host: HTMLElement, group: TabGroupConfig): void {
		const files = this.getGroupNoteFiles(this.activeGroup);
		let selectedPath = this.selectedGroupNotePaths[this.activeGroup];
		if (!files.some((file) => file.path === selectedPath)) {
			selectedPath = files[0]?.path ?? '';
			this.selectedGroupNotePaths[this.activeGroup] = selectedPath;
		}

		const select = host.createEl('select', {
			cls: 'tasks-view-group-note-select',
			attr: { 'aria-label': t('view.group.selectNote', { group: group.label }) },
		});
		if (files.length === 0) {
			select.createEl('option', { text: t('view.group.noMatchingNotes') });
			select.disabled = true;
			return;
		}
		for (const file of files) {
			select.createEl('option', { text: file.path.replace(/\.md$/i, ''), value: file.path });
		}
		select.value = selectedPath;
		select.addEventListener('change', () => {
			this.selectedGroupNotePaths[this.activeGroup] = select.value;
			void this.renderActiveTabGuarded();
		});
	}

	/**
	 * 让 activeGroup / activeTab / activeTabByGroup 始终指向真实存在的分组与 tab。
	 * 设置面板里删除或改组 tab 之后，旧的记忆值会失效，必须在重建界面时校正，
	 * 否则会出现"分组有 tab 但界面空白"的错位。
	 */
	private syncActiveTab(): void {
		const groups = this.getGroups();

		for (const g of groups) {
			const tabs = this.getTabsForGroup(g.id);
			if (tabs.length === 0) {
				delete this.activeTabByGroup[g.id];
				continue;
			}
			const remembered = this.activeTabByGroup[g.id];
			if (!remembered || !tabs.some((t) => t.id === remembered)) {
				this.activeTabByGroup[g.id] = tabs[0]!.id;
			}
		}

		if (groups.length > 0 && !groups.some((g) => g.id === this.activeGroup)) {
			this.activeGroup = groups[0]!.id;
		}

		const activeTabs = this.getTabsForGroup(this.activeGroup);
		this.activeTab = activeTabs.length > 0
			? (this.activeTabByGroup[this.activeGroup] ?? activeTabs[0]!.id)
			: '';
	}

	getViewType(): string { return VIEW_TYPE_TASKFLOW; }
	getDisplayText(): string { return 'TaskFlow'; }
	getIcon(): string { return 'checkmark'; }

	async onOpen(): Promise<void> {
		this.addAction('settings', 'TaskFlow settings', () => {
			this.app.setting.open();
			this.app.setting.openTabById('taskflow');
		});

		this.buildShell();
		await this.refresh();
		this.registerVaultWatcher();
	}

	async onClose(): Promise<void> {
		this.stopHeadClock();
		if (this.statsTimer) window.clearTimeout(this.statsTimer);
		if (this.contentTimer) window.clearTimeout(this.contentTimer);
		this.clearZeroRetry();
		// 必须显式卸载：Tasks 的渲染器挂着 vault 监听，只关视图不清它们会一直重跑查询
		this.unloadAllRenderComponents();
		this.cacheManager.clear();
	}

	// ── Shell (built once) ──────────────────────────────

	public buildShell() {
		// 重建界面会丢掉所有 body 引用，上一批 Tasks 渲染器必须随之卸载，
		// 否则每保存一次设置就泄漏一批（它们还挂着 vault 监听）
		this.unloadAllRenderComponents();
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('tasks-view-container');

		// Clear cached element references to avoid stale DOM pointers
		this.groupBtns = {};
		this.tabBtns = {};
		this.tabPanels = {};
		this.tabBodies = {};
		this.tabCounts = {};
		this.tabCollapsed = {};
		this.tabGroups = {};
		this.emptyGroupEl = null;
		this.emptyGroupTitleEl = null;
		// 重建前先停掉上一轮的时钟：容器马上要 empty()，留着旧定时器只会
		// 让它每 30s 去写已经不在文档里的元素，纯属泄漏。挂不挂由下面按
		// showHeadText 决定。
		this.stopHeadClock();
		this.headTimeEl = null;
		this.headMetaEl = null;

		// 底部统计栏：重建时复位，避免 applyStatsCategories 操作到已被替换的旧 DOM
		this.statsEl = null;
		this.statsChevron = null;

		// 面板模块（今日概览 / 重要提醒）元素引用：每次重建都复位，避免指向旧 DOM
		this.toTodoEl = null;
		this.toDoneEl = null;
		this.toInProgressEl = null;
		this.toOverdueEl = null;
		this.toWeekEl = null;
		this.toRingTodayDial = null;
		this.toRingTodayText = null;
		this.toRingWeekDial = null;
		this.toRingWeekText = null;
		this.importantBodyEl = null;
		this.importantMoreEl = null;
		this.importantExpanded = false;
		if (this.importantEmptyTimer) {
			window.clearTimeout(this.importantEmptyTimer);
			this.importantEmptyTimer = null;
		}

		// 校正当前分组 / 当前 tab（设置里删过或改过组之后旧值可能失效）
		this.syncActiveTab();

		// 头部横幅：封面与文字各一个开关，两个都关时整条横幅不渲染。
		this.renderWorkbenchHead(container);
		// 时钟只在文字行真的存在时挂：文字关掉还挂定时器，纯属白烧 CPU。
		if (this.headTimeEl) {
			this.startHeadClock();
		}

		// 主内容区
		const main = container.createDiv( { cls: 'tasks-view-main' });

		// 面板模块（今日概览 / 重要提醒）：都在快捷输入框「上方」、并排展示。
		// 关掉其中一个，另一个自动占满整行；两个都关则整块不渲染。
		const data = this.plugin.settings.data;
		if (data.showTodayOverview || data.showImportantReminders) {
			const panels = main.createDiv( { cls: 'tf-panels' });
			if (data.showTodayOverview) this.renderTodayOverview(panels);
			if (data.showImportantReminders) this.renderImportantModule(panels);
		}

		this.renderQuickAdd(main);
		this.renderGroupTabs(main);
		this.renderTabs(main);
		this.buildStatsShell(main);
	}

	/* ═══ Header (workbench banner) ═══════════════════════════════════════
	   参考稿（Lyra 的 wb-banner + wb-head）：上面一条封面图，下面一行为文字，
	   左侧是工作台名 + slogan，右侧是日期时间与星期/农历。

	   与参考实现唯一的实质差异在封面：参考实现用 `height:auto` 的图片配
	   像素级 translateY 调位置，窗口一缩放，按比例缩放的容器与不缩放的像素
	   位移就对不上，图片边缘会被拖离容器、露出空白。这里改用
	   `object-fit:cover` + 百分比 `object-position`，任何尺寸下都严丝合缝。
	   ══════════════════════════════════════════════════════════════════ */

	private renderWorkbenchHead(container: HTMLElement): void {
		const data = this.plugin.settings.data;
		// 封面与文字各有一个开关：两个都关时整条头部横幅不渲染（连 DOM 都不建）。
		const showCover = data.showCover ?? true;
		const showText = data.showHeadText ?? true;
		if (!showCover && !showText) return;

		const head = container.createDiv( { cls: 'tf-head' });
		// 两个都开时头部是「封面 + 文字」；只开文字则没有图片区域；只开封面则没有文字行。
		head.toggleClass('is-cover-only', showCover && !showText);
		head.toggleClass('is-text-only', showText && !showCover);
		if (showCover) {
			this.renderCover(head);
		}
		if (showText) {
			this.renderHeadText(head);
		}
	}

	/** 文字行：左「工作台名 + slogan」，右「日期时间 + 星期/农历」 */
	private renderHeadText(head: HTMLElement): void {
		const data = this.plugin.settings.data;
		const row = head.createDiv( { cls: 'tf-head-row' });

		const left = row.createDiv( { cls: 'tf-head-left' });
		const title = (data.workbenchTitle ?? '').trim() || DEFAULT_WORKBENCH_TITLE;
		left.createDiv( { cls: 'tf-head-title', text: title });

		const slogan = resolveSlogan(data.workbenchSlogan);
		if (slogan) left.createDiv( { cls: 'tf-head-slogan', text: slogan });

		const right = row.createDiv( { cls: 'tf-head-right' });
		this.headTimeEl = right.createDiv( { cls: 'tf-head-time' });
		this.headMetaEl = right.createDiv( { cls: 'tf-head-meta' });
		this.renderHeadClock();
	}

	/**
	 * 右侧「日期时间 + 星期」。日期格式与星期名都跟随界面语言：
	 * 中文「2026/09/21 12:01 / 星期一 · 农历 八月初十」，英文「Sep 21, 2026 12:01 / Monday」。
	 * 农历是中文专有，英文界面下整段不出现（否则会冒出「Monday · lunar 八月初十」这种混排）。
	 */
	private renderHeadClock(): void {
		if (!this.headTimeEl || !this.headMetaEl) return;
		const now = new Date();
		const lang = getUiLang();
		this.headTimeEl.setText(formatHeadClock(now, lang));
		const lunar = lang === 'zh' ? lunarCN(now) : '';
		this.headMetaEl.setText(weekdayName(now, lang) + (lunar ? t('head.lunarSep') + lunar : ''));
	}

	private startHeadClock(): void {
		this.stopHeadClock();
		this.headClockTimer = window.setInterval(
			() => this.renderHeadClock(),
			HEAD_CLOCK_INTERVAL_MS,
		);
	}

	private stopHeadClock(): void {
		if (this.headClockTimer === null) return;
		window.clearInterval(this.headClockTimer);
		this.headClockTimer = null;
	}

	/**
	 * 横幅区（原「封面」）。三种状态：用户自己的图 / 没放图（内置默认横幅）/ 图没了（回退默认横幅）。
	 * 悬停时右上角浮出「上传横幅 · 更换横幅 · 移除」，按住图片上下拖可改显示位置。
	 */
	private renderCover(head: HTMLElement): void {
		const data = this.plugin.settings.data;
		const cover = head.createDiv( { cls: 'tf-head-cover' });

		const file = resolveCoverFile(this.app, data.coverImagePath);
		if (!file) this.mountDefaultBanner(cover);

		if (file) {
			cover.addClass('has-cover');

			const img = cover.createEl('img', {
				cls: 'tf-head-cover-img',
				attr: { alt: '', draggable: 'false' },
			});
			img.src = this.app.vault.getResourcePath(file);
			this.applyCoverPosition(img, data.coverPosition);

			// 图在渲染之后被删/移走 → 退回默认横幅，别留一张破图
			img.addEventListener('error', () => {
				img.remove();
				cover.removeClass('has-cover');
				this.mountDefaultBanner(cover);
			});

			this.bindCoverDrag(img, cover);
		}

		const bar = cover.createDiv( { cls: 'tf-head-cover-bar' });

		// 隐藏的文件选择器：不画在界面上，由下面的按钮 click() 唤起
		const picker = cover.createEl('input', {
			cls: 'tf-head-cover-file',
			attr: { type: 'file', accept: 'image/*' },
		});
		picker.addEventListener('change', () => void this.onCoverPicked(picker));

		const pick = bar.createEl('button', {
			cls: 'tf-head-cover-btn',
			text: file ? t('head.changeBanner') : t('head.uploadBanner'),
			attr: { type: 'button' },
		});
		pick.addEventListener('click', () => picker.click());

		if (file) {
			const remove = bar.createEl('button', {
				cls: 'tf-head-cover-btn',
				text: t('common.remove'),
				attr: { type: 'button' },
			});
			remove.addEventListener('click', () => void this.onCoverRemoved());
		}
	}

	/**
	 * 挂内置默认横幅（自绘 SVG，不写文件）。
	 * 用户名下没放横幅图时用它顶上，头部不留一块灰底占位；幂等 —— 反复调用只挂一次，
	 * 图片加载失败回退时也走这里。
	 */
	private mountDefaultBanner(cover: HTMLElement): void {
		if (cover.querySelector('.tf-head-cover-default')) return;
		cover.addClass('is-default-banner');
		const holder = cover.createDiv( { cls: 'tf-head-cover-default' });
		// 受信任的内置默认横幅 SVG（仓库内写死，非用户输入）挂到封面占位；
		// 挂载失败（极少数环境）回退时也走这里，不能把整个头部拖崩。
		if (!mountTrustedSvg(holder, defaultBannerSvg(t('banner.line')))) {
			console.error('[TaskFlow] 默认横幅渲染失败');
			cover.removeClass('is-default-banner');
			holder.remove();
		}
	}

	/**
	 * 把纵向位置写成 CSS 变量，作为 object-position 的 Y 分量：
	 * 0% 露图片顶部、100% 露底部。用百分比而非像素位移，是封面在窗口缩放时
	 * 不脱开容器的关键（像素位移不随尺寸缩放）。
	 */
	private applyCoverPosition(img: HTMLElement, position: number): void {
		img.style.setProperty('--tf-cover-pos', `${clampCoverPosition(position)}%`);
	}

	/** 按住封面上下拖：改的是「露出图片的哪一段」，不是把图片整体挪走 */
	private bindCoverDrag(img: HTMLElement, cover: HTMLElement): void {
		img.addEventListener('mousedown', (event: MouseEvent) => {
			if (event.button !== 0) return;
			event.preventDefault();

			const data = this.plugin.settings.data;
			const startY = event.clientY;
			const height = Math.max(1, cover.getBoundingClientRect().height);
			const startPos = clampCoverPosition(data.coverPosition);
			let dragging = false;

			const move = (ev: MouseEvent) => {
				const dy = ev.clientY - startY;
				// 4px 阈值：只点一下不算拖，否则会莫名其妙跳位
				if (!dragging && Math.abs(dy) < 4) return;
				dragging = true;
				// 往下拖 = 想看图片更靠上的部分 = 位置百分比减小
				data.coverPosition = clampCoverPosition(startPos - (dy / height) * 100);
				this.applyCoverPosition(img, data.coverPosition);
			};

			const up = () => {
				document.removeEventListener('mousemove', move);
				document.removeEventListener('mouseup', up);
				// 只写盘不重建：走 saveSettings() 会把正在拖的这张图销毁重建，界面会闪
				if (dragging) void this.plugin.saveHeadSettings();
			};

			document.addEventListener('mousemove', move);
			document.addEventListener('mouseup', up);
		});
	}

	private async onCoverPicked(picker: HTMLInputElement): Promise<void> {
		const file = picker.files?.[0];
		// 先清空：不清的话，再选同一个文件不会再触发 change
		picker.value = '';
		if (!file) return;

		try {
			await persistCoverImage(this.plugin, file);
			new Notice(t('toast.bannerUpdated'));
		} catch (error) {
			console.error('[TaskFlow] 保存横幅失败:', error);
			new Notice(
				t('toast.bannerSaveFail') + (error instanceof Error ? error.message : String(error)),
			);
		}
	}

	private async onCoverRemoved(): Promise<void> {
		try {
			await removeCoverImage(this.plugin);
			new Notice(t('toast.bannerRemoved'));
		} catch (error) {
			console.error('[TaskFlow] 移除横幅失败:', error);
			new Notice(
				t('toast.bannerRemoveFail') + (error instanceof Error ? error.message : String(error)),
			);
		}
	}

	/**
	 * 渲染第一层分组 tab (动态从 settings 加载)
	 */
	private renderGroupTabs(container: HTMLElement) {
		const bar = container.createDiv( { cls: 'tasks-view-group-bar' });
		const segment = bar.createDiv( { cls: 'tasks-view-group-segment' });

		for (const g of this.getGroups()) {
			const btn = segment.createEl('button', {
				cls: 'tasks-view-group-btn' + (this.activeGroup === g.id ? ' is-active' : ''),
				attr: { title: g.label }
			});
			setIcon(btn.createSpan('tasks-view-group-icon'), g.icon);
			btn.createSpan({ cls: 'tasks-view-group-label', text: g.label });
			btn.addEventListener('click', () => this.switchGroup(g.id));
			this.groupBtns[g.id] = btn;
		}
		this.groupNoteSelectorEl = bar.createDiv({ cls: 'tasks-view-group-note-selector' });
		this.renderGroupNoteSelector();
	}

	/**
	 * 切换分组 tab
	 */
	private switchGroup(group: TabGroup) {
		if (group === this.activeGroup) return;
		this.activeGroup = group;
		this.syncActiveTab();

		for (const g of this.getGroups()) {
			const btn = this.groupBtns[g.id];
			if (btn) btn.toggleClass('is-active', g.id === group);
		}

		this.applyTabVisibility();
		this.renderGroupNoteSelector();

		// 新分组的激活 tab 内容尚未渲染过，必须渲染一次，否则面板是空的
		// （renderQueries 现在只渲染激活 tab，所以是懒渲染的关键入口）
		void this.renderActiveTabGuarded();
	}

	/**
	 * 只显示当前分组的 tab，并在其中高亮 activeTab。
	 * 所有分组的 tab 都在 DOM 里（一起构建），靠这个方法来切换可见性。
	 */
	private applyTabVisibility(): void {
		let hasVisibleTab = false;

		for (const id of Object.keys(this.tabBtns)) {
			const inGroup = this.tabGroups[id] === this.activeGroup;
			const isActive = inGroup && id === this.activeTab;
			if (inGroup) hasVisibleTab = true;

			const btn = this.tabBtns[id];
			if (btn) {
				btn.toggleClass('is-hidden', !inGroup);
				btn.toggleClass('is-active', isActive);
			}
			const panel = this.tabPanels[id];
			if (panel) panel.toggleClass('is-hidden', !isActive);
		}

		if (this.emptyGroupEl) this.emptyGroupEl.toggleClass('is-hidden', hasVisibleTab);
		// 文案要跟着当前一级 tab 实时更新（切分组时提示里的分组名常常变）
		this.updateEmptyGroupLabel();
	}


	/**
	 * 构建所有分组的全部 tab。
	 *
	 * 之前这里只构建"当前分组"的 tab，切到别的分组时那些 tab 根本不存在，
	 * 于是一级 tab 显示、二级 tab 空白 —— 和设置面板里列出的 tab 对不上。
	 * 现在一次性全部构建，切分组时只切可见性。
	 */
	private renderTabs(container: HTMLElement) {
		const groups = this.getGroups();
		const sortedTabs = [...this.getTabs()].sort((a, b) => a.order - b.order);

		// Tab bar
		const tabBar = container.createDiv( { cls: 'tasks-view-tab-bar' });
		const segment = tabBar.createDiv( { cls: 'tasks-view-tab-segment' });

		// Tab panels (scroll area per tab)
		const panelWrap = container.createDiv( { cls: 'tasks-view-tab-panels' });

		for (const tab of sortedTabs) {
			const group = getTabGroup(tab, groups);
			this.tabGroups[tab.id] = group;

			const btn = segment.createEl('button', { cls: 'tasks-view-tab-btn', text: localizedTabLabel(tab) });
			btn.addEventListener('click', () => this.switchTab(tab.id));
			this.tabBtns[tab.id] = btn;
			this.tabCollapsed[tab.id] = false;

			const panel = panelWrap.createDiv( { cls: 'tasks-view-tab-panel tasks-view-scroll' });
			this.tabPanels[tab.id] = panel;

			// Build single section for each tab (ensure showSectionHeader has default)
			const tabWithDefault = { ...tab, showSectionHeader: tab.showSectionHeader ?? true };
			this.buildTabSection(panel, tabWithDefault);
		}

		// 分组下没有 tab 时的占位提示（避免整块空白）
		this.emptyGroupEl = panelWrap.createDiv( { cls: 'tasks-view-empty-group' });
		this.emptyGroupEl.createDiv( { cls: 'tasks-view-empty-group-icon', text: '🗂' });
		this.emptyGroupTitleEl = this.emptyGroupEl.createDiv( {
			cls: 'tasks-view-empty-group-title',
		});
		this.emptyGroupEl.createDiv( {
			cls: 'tasks-view-empty-group-desc',
			text: t('empty.noTabsHint'),
		});

		this.applyTabVisibility();
	}

	/**
	 * 占位提示里的分组名必须跟着当前一级 tab 走。
	 *
	 * 之前文案在 renderTabs 里只算一次（当时拿到的是构建瞬间的 activeGroup），
	 * 于是切到别的空分组时，提示里仍写着最初那个分组的名字（如「GTD 下还没有 Tab」）。
	 */
	private updateEmptyGroupLabel(): void {
		if (!this.emptyGroupTitleEl) return;
		const label = this.getGroups().find((g) => g.id === this.activeGroup)?.label ?? t('common.thisGroup');
		this.emptyGroupTitleEl.setText(t('view.empty.noTabsInGroup', { name: label }));
	}

	private buildTabSection(panel: HTMLElement, tab: { id: TabId; label: string; showSectionHeader?: boolean }) {
		const section = panel.createDiv( { cls: 'tasks-view-section' });

		// Header with chevron
		const header = section.createDiv( { cls: 'tasks-view-section-header' });
		const chevron = header.createDiv( { cls: 'tasks-view-section-chevron' });
		setIcon(chevron, 'chevron-down');

		header.createSpan( { cls: 'tasks-view-section-title', text: localizedTabLabel(tab) });

		const count = header.createSpan( { cls: 'tasks-view-section-count', text: '0' });
		this.tabCounts[tab.id] = count;

		const body = section.createDiv( { cls: 'tasks-view-section-body' });
		this.tabBodies[tab.id] = body;
		this.observeBody(body, tab);

		// Collapse toggle (only if header is enabled)
		if (tab.showSectionHeader) {
			header.addEventListener('click', () => {
				const current = this.tabCollapsed[tab.id] ?? false;
				this.tabCollapsed[tab.id] = !current;
				body.toggleClass('is-collapsed', !current);
				setIcon(chevron, !current ? 'chevron-right' : 'chevron-down');
			});
		} else {
			// 「不显示标题」就要真的把整行藏掉。以前这里只隐藏了箭头、标题照常显示，
			// 于是界面上留着一个「标题 + 数量 0」的怪东西 —— 数量徽标就长在标题行里，
			// 标题既然不该出现，它和它的计数自然也不该出现。
			header.addClass('is-hidden');
		}
	}

	private switchTab(id: TabId) {
		if (id === this.activeTab) return;
		this.activeTab = id;
		this.activeTabByGroup[this.activeGroup] = id;
		this.applyTabVisibility();
		// 懒渲染：只渲染刚切到的 tab（其余 tab 内容首次切到时才渲染，避免全量重渲染）
		void this.renderActiveTabGuarded();
	}

	// ── Refresh (re-runs on every file change) ──────────

	/**
	 * 刷新：扫描 → 渲染各 tab 的查询 → 更新底部统计。
	 *
	 * 每一步都必须独立容错。以前这里任意一步抛错（最常见的是某条 query
	 * 让 Tasks 插件渲染失败），整个 refresh 就中断在 updateStats 之前，
	 * 底部统计永远停在初始的 "0 xxx" —— 「统计全是零」就是这么来的。
	 * 现在无论前面炸成什么样，统计都一定会被刷新。
	 */
	async refresh() {
		if (this.refreshBusy) {
			this.refreshQueued = true;
			return;
		}
		this.refreshBusy = true;
		try {
			await this.runRefresh();
		} finally {
			this.refreshBusy = false;
		}
		if (this.refreshQueued) {
			this.refreshQueued = false;
			void this.refresh();
		}
	}

	/**
	 * refresh() 的实际工作：重算统计 + 重渲染所有 tab 内容（整库解析最重的一步）。
	 * 打开视图、保存设置时走这条完整路径；编辑触发的增量更新则拆成
	 * refreshStats() / refreshContent() 两条更轻的路径（见 scheduleRefresh）。
	 */
	private async runRefresh(): Promise<void> {
		let source: 'tasks' | 'own' = 'own';
		try {
			const result = await this.getVaultTasks();
			this.statTasks = result.tasks;
			source = result.source;
		} catch (error) {
			console.error('[TaskFlow] 获取任务失败，沿用上一次结果:', error);
			this.statTasks = this.statTasks ?? [];
		}

		if (this.statTasks.length > 0) {
			// 拿到任务了：Tasks 插件已就绪，取消并清零「0 任务」重试
			this.clearZeroRetry();
		} else {
			console.warn(
				`[TaskFlow] 统计到 0 个任务（数据来自${source === 'tasks' ? 'Tasks 插件' : '自带扫描'}）` +
					' —— 若 vault 里确实有任务，请确认 Tasks 插件已启用，' +
					'且它的 Global Filter / Global Query 没有把任务过滤掉。',
			);
			// 视图刚打开时 Tasks 的索引常常还没建好，先重试几次再下结论
			this.scheduleZeroRetry();
		}

		try {
			await this.renderQueries();
		} catch (error) {
			console.error('[TaskFlow] 渲染查询失败:', error);
		}

		// 重要提醒模块（独立的 Tasks 渲染点）：模块关闭时内部直接返回，无副作用。
		// 仍受单飞锁保护，不会与完整刷新并发。每次刷新多一次整库解析（可接受）。
		try {
			await this.renderImportantReminders();
		} catch (error) {
			console.error('[TaskFlow] 渲染重要提醒失败:', error);
		}

		this.updateStats();
	}

	/**
	 * 编辑触发（vault 任意 md 文件改动）的刷新调度。
	 * - 统计：短防抖后立即可见（底部胶囊随改动更新）。
	 * - 内容：等 vault 安静 CONTENT_IDLE_MS 后才重渲染所有 tab —— 大 vault 上
	 *   每个 tab 的 Tasks 渲染都要整库解析，连发改动时若每次都重跑会占满主线程卡死。
	 *   后台同步/批量写入期间列表短暂落后，停手后自动追上，是可接受的取舍。
	 */
	private scheduleRefresh(): void {
		if (this.statsTimer) window.clearTimeout(this.statsTimer);
		this.statsTimer = window.setTimeout(() => void this.refreshStats(), STATS_DEBOUNCE_MS);
		if (this.contentTimer) window.clearTimeout(this.contentTimer);
		this.contentTimer = window.setTimeout(() => void this.refreshContent(), CONTENT_IDLE_MS);
	}

	/**
	 * 统计为 0 时的延迟重试。
	 *
	 * `onOpen()` 里会立刻 refresh 一次，而 Tasks 插件此时往往还没建好索引，
	 * `getTasks()` 便返回空数组。若不重试，统计就停在 0 —— 而刷新只在打开视图、
	 * 保存设置、vault 文件改动时触发，用户不动文件的话它永远不会恢复。
	 * 所以按 ZERO_RETRY_DELAYS 各试一次；拿到任务后由 clearZeroRetry() 清零。
	 */
	private scheduleZeroRetry(): void {
		if (this.zeroRetries >= ZERO_RETRY_DELAYS.length) return; // 重试已用尽，不再打扰
		const delay = ZERO_RETRY_DELAYS[this.zeroRetries];
		this.zeroRetries++;
		if (this.zeroRetryTimer) window.clearTimeout(this.zeroRetryTimer);
		this.zeroRetryTimer = window.setTimeout(() => {
			this.zeroRetryTimer = null;
			void this.refresh();
		}, delay);
	}

	/** 取消并清零「统计到 0 个任务」的重试（拿到任务 / 视图关闭时调用）。 */
	private clearZeroRetry(): void {
		if (this.zeroRetryTimer) {
			window.clearTimeout(this.zeroRetryTimer);
			this.zeroRetryTimer = null;
		}
		this.zeroRetries = 0;
	}

	/** 仅刷新底部统计（不重渲染任务列表内容）。单飞，避免与完整刷新并发。 */
	private async refreshStats(): Promise<void> {
		if (this.refreshBusy) return; // 完整刷新正在进行，它会顺带刷新统计
		this.refreshBusy = true;
		try {
			try {
				const result = await this.getVaultTasks();
				this.statTasks = result.tasks;
				// 拿到任务 → Tasks 已就绪，取消并清零「0 任务」重试
				if (result.tasks.length > 0) this.clearZeroRetry();
			} catch (error) {
				console.error('[TaskFlow] 获取任务失败，沿用上一次结果:', error);
				this.statTasks = this.statTasks ?? [];
			}
			this.updateStats();
		} finally {
			this.refreshBusy = false;
		}
	}

	/** 仅重渲染任务列表内容（统计由 refreshStats 负责）。单飞；若正忙则稍后重试一次。 */
	private async refreshContent(): Promise<void> {
		if (this.refreshBusy) {
			if (this.contentTimer) window.clearTimeout(this.contentTimer);
			this.contentTimer = window.setTimeout(() => void this.refreshContent(), CONTENT_IDLE_MS);
			return;
		}
		this.refreshBusy = true;
		try {
			await this.renderQueries();
		} catch (error) {
			console.error('[TaskFlow] 渲染查询失败:', error);
		}

		// 重要提醒模块（独立的 Tasks 渲染点）：模块关闭时内部直接返回，无副作用。
		// 仍受单飞锁保护，不会与完整刷新并发。每次刷新多一次整库解析（可接受）。
		try {
			await this.renderImportantReminders();
		} catch (error) {
			console.error('[TaskFlow] 渲染重要提醒失败:', error);
		} finally {
			this.refreshBusy = false;
		}
	}

	/**
	 * 取一个干净的渲染组件：先把同一个渲染点**上一次**的组件卸载掉。
	 * 不卸载的话，旧的 Tasks 渲染器仍挂着 vault 监听，会一直重跑查询。
	 */
	private freshRenderComponent(key: string): Component {
		const prev = this.renderComponents.get(key);
		if (prev) {
			try {
				prev.unload();
			} catch (error) {
				console.error(`[TaskFlow] 卸载旧渲染组件失败（${key}）:`, error);
			}
			this.renderComponents.delete(key);
		}
		const comp = new Component();
		comp.load();
		this.renderComponents.set(key, comp);
		return comp;
	}

	/**
	 * 卸载不在 keep 里的渲染组件。
	 * 隐藏的 tab 不需要实时响应 vault 事件（切到时会重新渲染），
	 * 留着只会让每次文件改动都带上它们一起重跑整库查询。
	 */
	private pruneRenderComponents(keep: Set<string>): void {
		for (const [key, comp] of [...this.renderComponents]) {
			if (keep.has(key)) continue;
			try {
				comp.unload();
			} catch (error) {
				console.error(`[TaskFlow] 卸载渲染组件失败（${key}）:`, error);
			}
			this.renderComponents.delete(key);
		}
	}

	/** 视图关闭 / 界面重建：全部卸载，一个不留 */
	private unloadAllRenderComponents(): void {
		for (const [key, comp] of [...this.renderComponents]) {
			try {
				comp.unload();
			} catch (error) {
				console.error(`[TaskFlow] 卸载渲染组件失败（${key}）:`, error);
			}
		}
		this.renderComponents.clear();
	}

	private async renderQueries() {
		const epoch = ++this.renderEpoch;
		this.renderGroupNoteSelector();

		// 只渲染「当前激活的 tab」：非激活 tab 的面板被 display:none 隐藏，
		// 用户切到时才按需渲染（见 switchTab / switchGroup）。大 vault 上每个 tab 的
		// Tasks 渲染都要整库解析，全量渲染会让单次刷新随 tab 数量线性变重 → 卡死。
		const tab = this.getTabs().find((t) => t.id === this.activeTab);
		if (!tab) return;
		const body = this.tabBodies[tab.id];
		if (!body) return;
		const groupConfig = this.getGroups().find((item) => item.id === this.activeGroup);
		const hasNoteSelector = Boolean(groupConfig?.frontmatterProperty?.trim());
		const selectedNote = hasNoteSelector ? this.getSelectedGroupNote(this.activeGroup) : undefined;

		// 确保 observer 在位（buildTabSection 已挂，这里幂等兜底）
		this.observeBody(body, tab);

		// 单个 tab 渲染失败不能连累其它 tab
		try {
			body.empty();
			// 空状态标记现在挂在 section 上（见 renderEmptyState），重渲染前从 section 清掉
			const sec0 = body.parentElement;
			if (sec0) sec0.removeClass('tasks-view-empty-state');

			// 生命周期：本 tab 用专属组件（旧的先卸载），并把其它 tab 的渲染器卸掉。
			// 以前统一传 this（整个 View）且从不卸载 → 每切一次 tab 就多一批活着的
			// Tasks 渲染器，文件一改动它们全体重跑整库查询 → 越用越卡、最后点不动。
			const key = 'tab:' + tab.id;
			const comp = this.freshRenderComponent(key);
			this.pruneRenderComponents(new Set([key, 'important']));
			if (hasNoteSelector && !selectedNote) {
				this.renderEmptyState(body, tab);
				return;
			}

			// 查询文本原样交给 Tasks（树状与否完全由 query 自己决定）。
			// Only exception: the group limit is appended last so it overrides any limit in the query.
			const groupLimit = groupConfig?.taskLimit;
			const query = groupLimit ? `${tab.query}\nlimit ${groupLimit}` : tab.query;
			const t0 = performance.now();
			await MarkdownRenderer.render(
				this.app,
				'```tasks\n' + query + '\n```',
				body,
				selectedNote?.path ?? '',
				comp,
			);
			const ms = performance.now() - t0;
			if (ms > RENDER_SLOW_MS) {
				console.warn(
					`[TaskFlow] Tab「${localizedTabLabel(tab)}」渲染耗时 ${ms.toFixed(0)}ms` +
						`（超过 ${RENDER_SLOW_MS}ms，多半是这条 query 太重）:\n${tab.query}`,
				);
			}
			// 空状态的最终判定交给 MutationObserver：任务项出现就立刻撤，
			// 彻底没任务且容器静默后才显示。这里不再做任何定时猜测。
			if (epoch !== this.renderEpoch) return;
		} catch (error) {
				console.error(`[TaskFlow] Tab「${tab.label}」渲染失败:`, error);
				if (epoch !== this.renderEpoch) return;
			// 渲染炸了：容器里不会有 .task-list-item，observer 静默后会显示空状态。
			// 主动补一次，避免极端情况下漏判。
			this.renderEmptyState(body, tab);
		}
	}

	/**
	 * 单飞地渲染「当前激活 tab」（懒渲染：切到才渲染，避免一次刷新渲染全部 tab）。
	 * 与完整刷新共用 refreshBusy 单飞锁：若完整刷新正在进行，本次只需排队，
	 * 待其结束后由队列再跑一次（此时 activeTab 已是用户刚切到的那个）。
	 */
	private async renderActiveTabGuarded(): Promise<void> {
		if (this.refreshBusy) {
			this.refreshQueued = true;
			return;
		}
		this.refreshBusy = true;
		try {
			await this.renderQueries();
		} catch (error) {
			console.error('[TaskFlow] 渲染激活 tab 失败:', error);
		} finally {
			this.refreshBusy = false;
		}
		if (this.refreshQueued) {
			this.refreshQueued = false;
			void this.refresh();
		}
	}

	/**
	 * 给某个 tab 的 body 挂一个 MutationObserver，由真实 DOM 变化驱动空状态。
	 * 幂等：同一 body 只挂一次。
	 */
	private observeBody(body: HTMLElement, tab: { id: TabId; label: string }): void {
		if (this.observedBodies.has(body)) return;
		this.observedBodies.add(body);

		const onMutate = () => {
			// 计数只取决于 DOM 现状，但全表 querySelectorAll 很贵（列表越大越慢），
			// 所以去抖——变动平息后才算一次，而不是每次 mutation 都扫一遍。
			// 多算一次没有副作用，能兜住「Tasks 写完 DOM 之后计数停在 0」这类时序意外。
			this.scheduleCount(tab.id, body);

			if (body.querySelector('.task-list-item')) {
				// 任务项已出现：立刻撤掉空状态（不等待静默），并取消待定的空状态判定
				const pending = this.emptyTimers.get(body);
				if (pending) {
					window.clearTimeout(pending);
					this.emptyTimers.delete(body);
				}
				this.removeEmptyState(body);
				this.scheduleCount(tab.id, body);
				return;
			}

			// 暂时没有任务项：等容器静默 EMPTY_QUIET_MS 毫秒再判定，
			// 避免 Tasks 渲染中途的瞬时空窗误显示空状态。
			// 若静默期间又有任务项出现，下面的检查会放弃显示。
			if (body.parentElement?.querySelector('.tasks-view-empty')) return; // 已经显示了，无需重排

			const prev = this.emptyTimers.get(body);
			if (prev) window.clearTimeout(prev);
			const timer = window.setTimeout(() => {
				this.emptyTimers.delete(body);
				if (body.querySelector('.task-list-item')) return; // 静默期间又出现，放弃
				this.renderEmptyState(body, tab);
			}, EMPTY_QUIET_MS);
			this.emptyTimers.set(body, timer);
		};

		const observer = new MutationObserver(onMutate);
		observer.observe(body, { childList: true, subtree: true });
	}

	/**
	 * 取底部统计用的任务集合，并标明数据来自哪一侧（供日志诊断）。
	 *
	 * 优先用 Tasks 插件自己的解析器（`getTasks()`）：这样统计口径与 tab 列表完全一致，
	 * 且自动按用户的「自定义状态」设置归类、overdue 只算 due（见 updateStats）。
	 * Tasks 插件未安装/未启用时，回退到自带扫描（旧口径，且不读排除文件夹设置）。
	 *
	 * **空结果不能直接采信**（这是「统计一直是 0」的根因）：`getTasks()` 返回空数组
	 * 而不是抛错，是很常见的情况 ——
	 *   ① 视图 `onOpen()` 立刻刷新，Tasks 的索引可能还没建好；
	 *   ② Tasks 的 Global Filter / Global Query 把任务全过滤了。
	 * 以前只要返回的是数组（含空数组）就 `return`，于是统计停在 0 且再也不恢复。
	 * 现在只有 Tasks 侧拿到**非空**结果才直接用，为空一律再走自带扫描兜底。
	 */
	private async getVaultTasks(): Promise<{ tasks: StatTask[]; source: 'tasks' | 'own' }> {
		// 两种形态都列出来，取第一个真正提供 getTasks() 的（候选已按能力过滤）
		const tasksPlugin = getTasksPluginCandidates(this.app)[0];
		const getTasks = tasksPlugin?.getTasks;
		let fromPlugin: StatTask[] | null = null;
		if (typeof getTasks === 'function') {
			try {
				const raw = getTasks.call(tasksPlugin);
				if (Array.isArray(raw)) {
					fromPlugin = raw.map((t): StatTask => {
						const task = t as TasksTaskLike;
						return {
							statusType: (task.status?.type ?? 'TODO') as StatStatus,
							due: dueToStr(task.dueDate),
							doneDate: dueToStr(task.doneDate),
						};
					});
				}
			} catch (error) {
				console.error('[TaskFlow] 调用 Tasks.getTasks() 失败，回退到自带扫描:', error);
			}
		}
		// 只有 Tasks 侧确实给了任务才直接用 —— 它的口径与 tab 列表一致，优先。
		if (fromPlugin && fromPlugin.length > 0) {
			return { tasks: fromPlugin, source: 'tasks' };
		}
		// 兜底：Tasks 插件不存在 / 调用失败 / 返回了空数组，都改用自带扫描。
		const own = await this.cacheManager.getAllTasks(this.plugin.settings.data);
		const tasks = flattenOwn(own).map((t): StatTask => ({
			statusType: FALLBACK_STATUS_MAP[t.status] ?? 'TODO',
			due: dueToStr(t.due),
			doneDate: t.completionDate ?? null,
		}));
		if (fromPlugin) {
			// 能走到这里，说明 Tasks 是「返回了空数组」而不是抛错 —— 单独记一条，
			// 让用户能分清是 Tasks 侧过滤掉了，还是 vault 里真的没有任务。
			console.warn(
				`[TaskFlow] Tasks.getTasks() 返回 0 个任务，已回退到自带扫描（扫到 ${tasks.length} 个）。` +
					'若 vault 里确实有任务，请检查 Tasks 的 Global Filter / Global Query 是否把它们过滤掉了。',
			);
		}
		return { tasks, source: 'own' };
	}

	private updateStats(): void {
		let overdue = 0;
		let inProgress = 0;
		let todo = 0;
		let cancel = 0;
		let done = 0;

		/* 今日概览累加器。
		   两个完成率环共用一条口径，否则会互相打架（曾出现「今日 25% 而本周 100%」
		   这种矛盾读数：当时本周用的是「本周完成数 ÷ 本周未完成数」，纯粹是拿完成数
		   除以未完成数，分母根本不是分母）：

		     完成率 = 该周期内完成数 ÷ (该周期内完成数 + 该周期内到期却未完成数)

		   分子的「完成数」按完成日算、分母的「未完成数」按到期日算，两者都以
		   周期为界（今日 = 今天，本周 = 本周一~周日）。这样今日的两个算子都被
		   本周完全包含 —— 本周 100% 就意味着今天该做的也都做完了，不会再自相矛盾。 */
		let todayTodo = 0; // 今天到期、仍未完成（=「今日待办」，不含更早的逾期）
		let todayDone = 0; // 完成日 = 今天
		let weekUndone = 0; // 本周到期、仍未完成
		let weekDone = 0; // 完成日落在本周

		const today = getToday();
		const ws = weekStartStr(today);
		const we = addDaysStr(ws, 6);

		for (const t of this.statTasks) {
			const isDone = t.statusType === 'DONE';
			const isCancelled = t.statusType === 'CANCELLED';
			const isReal = t.statusType !== 'NON_TASK' && t.statusType !== 'EMPTY';

			switch (t.statusType) {
				case 'IN_PROGRESS':
					inProgress++;
					break;
				case 'DONE':
					done++;
					break;
				case 'CANCELLED':
					cancel++;
					break;
				case 'TODO':
				case 'ON_HOLD':
					// 用户选择不在胶囊里单列「搁置」，并入待办
					todo++;
					break;
				// NON_TASK / EMPTY 不是真实任务，不计入统计
			}

			// overdue：有到期日、早于今天、且未完成（DONE/CANCELLED/NON_TASK/EMPTY 不计）
			if (
				isReal &&
				!isDone &&
				!isCancelled &&
				t.due !== null &&
				t.due < today
			) {
				overdue++;
			}

			// 今日概览的「未完成」侧：只认周期内的到期日（今天 / 本周）。
			// 更早的逾期任务只进「逾期」胶囊，不再被算进今日分母 —— 否则积压几个月的
			// 老任务会把「今日完成率」长期压在个位数，和本周口径也对不上。
			if (isReal && !isDone && !isCancelled && t.due !== null) {
				if (t.due === today) todayTodo++;
				if (t.due >= ws && t.due <= we) weekUndone++;
			}
			// 完成口径只看 DONE，且要有完成日期
			if (isDone && t.doneDate !== null) {
				if (t.doneDate === today) todayDone++;
				if (t.doneDate >= ws && t.doneDate <= we) weekDone++;
			}
		}

		// total = 所有真实任务（排除 NON_TASK / EMPTY）；百分比分母再去掉已取消
		const total = this.statTasks.filter(
			(t) => t.statusType !== 'NON_TASK' && t.statusType !== 'EMPTY',
		).length;
		const denom = total - cancel;
		const progress = done + inProgress * 0.5;
		const pct = denom > 0 ? Math.round((progress / denom) * 100) : 0;

		// 更新进度条
		if (this.progressFill) this.progressFill.style.width = `${pct}%`;
		if (this.statsPct) this.statsPct.setText(`${pct}%`);

		// 更新统计卡片数量（名称在 buildStatsShell 中固定，此处只刷数字）
		if (this.pillOverdue) this.pillOverdue.setText(String(overdue));
		if (this.pillInProgress) this.pillInProgress.setText(String(inProgress));
		if (this.pillTodo) this.pillTodo.setText(String(todo));
		if (this.pillCancel) this.pillCancel.setText(String(cancel));
		if (this.pillDone) this.pillDone.setText(String(done));
		// Total 卡片（所有真实任务总数）
		if (this.pillTotal) this.pillTotal.setText(String(total));

		// ── 今日概览（只在模块被构建时刷新，元素引用为空则跳过）──
		// 两个环同一条公式：完成 ÷（完成 + 到期未完成）。分母为 0 时显示「—」而不是
		// 0%：该周期本来就没有到期任务，0% 会被误读成「一个都没完成」。
		const todayDenom = todayDone + todayTodo;
		const weekDenom = weekDone + weekUndone;
		const todayRate = todayDenom > 0 ? Math.round((todayDone / todayDenom) * 100) : null;
		const weekRate = weekDenom > 0 ? Math.round((weekDone / weekDenom) * 100) : null;

		if (this.toTodoEl) this.toTodoEl.setText(String(todayTodo));
		if (this.toDoneEl) this.toDoneEl.setText(String(todayDone));
		if (this.toInProgressEl) this.toInProgressEl.setText(String(inProgress));
		if (this.toOverdueEl) {
			this.toOverdueEl.setText(String(overdue));
			// 逾期为 0 时不标红，避免「全绿里一个红 0」的视觉噪音
			this.toOverdueEl.parentElement?.toggleClass('is-alert', overdue > 0);
		}
		if (this.toWeekEl) this.toWeekEl.setText(String(weekDone));

		if (this.toRingTodayDial && this.toRingTodayText) {
			this.toRingTodayDial.style.setProperty('--p', String(todayRate ?? 0));
			this.toRingTodayText.setText(todayRate === null ? '—' : `${todayRate}%`);
		}
		if (this.toRingWeekDial && this.toRingWeekText) {
			this.toRingWeekDial.style.setProperty('--p', String(weekRate ?? 0));
			this.toRingWeekText.setText(weekRate === null ? '—' : `${weekRate}%`);
		}
	}

	// ── 任务计数 / 空状态（任务列表本身交给 Tasks 插件渲染，这里只管空状态与计数） ──

	/** section 头部的数量徽标＝实际渲染出的任务项数（此前永远停在 0）。 */
	private updateTabCount(tabId: TabId, container: HTMLElement): void {
		const el = this.tabCounts[tabId];
		if (!el) return;
		el.setText(String(container.querySelectorAll('.task-list-item').length));
	}

	/** 计数去抖：DOM 变动期间只算一次全表，避免每次 mutation 都 querySelectorAll（列表越大越慢）。 */
	private scheduleCount(tabId: TabId, body: HTMLElement): void {
		const prev = this.countTimers.get(body);
		if (prev) window.clearTimeout(prev);
		this.countTimers.set(
			body,
			window.setTimeout(() => this.updateTabCount(tabId, body), COUNT_DEBOUNCE_MS),
		);
	}

	/**
	 * 撤掉空状态（自愈时用）。
	 *
	 * ⚠️ 空状态节点挂在 section 上（body 的父级），**不在** body 内 ——
	 * 这样 `renderQueries()` 里的 `body.empty()` 只清 Tasks 内容槽，碰不到空状态，
	 * 「空 → 空」刷新时 body 不产生任何 mutation、observer 不触发、📭 完全不动，
	 * 面板高度也就不再上下跳（这是「无任务 tab 抖动」的根因修复）。
	 */
	private removeEmptyState(container: HTMLElement): void {
		const section = container.parentElement ?? container;
		const emptyEl = section.querySelector('.tasks-view-empty');
		if (emptyEl) emptyEl.remove();
		section.removeClass('tasks-view-empty-state');
	}

	private renderEmptyState(
		container: HTMLElement,
		tab: { id: TabId; label: string },
	): void {
		// 空状态节点放在 section（body 的父级），与 Tasks 内容槽平级 ——
		// 见 removeEmptyState 的说明：这是「无任务 tab 刷新抖动」的根因修复。
		const section = container.parentElement ?? container;
		// 幂等：已显示空状态就不再重复创建（observer 会在每次变动时回调）。
		// 这个守卫同时兜住「空 → 空」刷新：body.empty() 不碰 section 里的空节点，
		// observer 回调到这里直接 return，空状态从头到尾是同一个 DOM 节点，零重建。
		if (section.querySelector('.tasks-view-empty')) return;
		// Clear container and add empty state styling
		section.classList.add('tasks-view-empty-state');

		const emptyEl = section.createDiv( { cls: 'tasks-view-empty' });

		// Icon
		emptyEl.createDiv( { cls: 'tasks-view-empty-icon' }).textContent = '📭';

		// Title
		emptyEl.createEl('h3', {
			cls: 'tasks-view-empty-title',
			text: t('empty.noTasks')
		});

		// Description
		emptyEl.createEl('p', {
			cls: 'tasks-view-empty-desc',
			text: t('view.empty.noMatch', { label: localizedTabLabel(tab) })
		});

		// Action button
		const actionBtn = emptyEl.createEl('button', {
			cls: 'tasks-view-empty-btn tf-btn tf-btn-primary',
			text: t('empty.newTask')
		});
		actionBtn.addEventListener('click', () => {
			// Focus on the quick add input
			const input = this.containerEl.querySelector('.tasks-view-quick-add-input') as HTMLInputElement;
			if (input) {
				input.focus();
			}
		});

		this.updateTabCount(tab.id, container);
	}

	// ── Vault watcher ───────────────────────────────────

	private registerVaultWatcher() {
		// 文件修改监听：编辑触发的增量刷新走 scheduleRefresh（统计立即可见、
		// 内容延迟到 vault 安静后重渲染），避免大 vault 上每次改动都重跑整库解析卡死。
		this.registerEvent(
			this.app.vault.on('modify', async (file) => {
				if (!(file instanceof TFile) || file.extension !== 'md') return;
				this.scheduleRefresh();
			}),
		);

		// 文件重命名/移动监听：迁移缓存键
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile && file.extension === 'md') {
					this.cacheManager.migrateCacheKey(oldPath, file.path);
				}
			})
		);

		// Frontmatter edits change which notes the group note selector offers
		this.registerEvent(
			this.app.metadataCache.on('changed', () => {
				const group = this.getGroups().find((item) => item.id === this.activeGroup);
				if (!group?.frontmatterProperty?.trim()) return;
				const before = this.selectedGroupNotePaths[this.activeGroup];
				this.renderGroupNoteSelector();
				if (this.selectedGroupNotePaths[this.activeGroup] !== before) {
					void this.renderActiveTabGuarded();
				}
			}),
		);
	}

	// ── Quick add ───────────────────────────────────────

	private renderQuickAdd(container: HTMLElement) {
		const wrap = container.createDiv( { cls: 'tasks-view-quick-add' });

		const topRow = wrap.createDiv( { cls: 'tasks-view-quick-add-top' });
		const input = topRow.createEl('input', {
			cls: 'tasks-view-quick-add-input',
			attr: { placeholder: 'Add to inbox…', type: 'text' },
		});


		const settingsBtn = topRow.createEl('button', {
			cls: 'tasks-view-settings-btn',
			attr: { 'aria-label': 'TaskFlow settings' },
		});
		setIcon(settingsBtn, 'settings');
		settingsBtn.addEventListener('click', () => {
			this.app.setting.open();
			this.app.setting.openTabById('taskflow');
		});

		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				const text = input.value.trim();
				if (text) {
					void this.addToInbox(text);
					input.value = '';
				}
			} else if (e.key === 'Escape') {
				input.value = '';
				input.blur();
			}
		});
	}

	/**
	 * 获取简短的文件名用于显示
	 */
	private getShortFileName(path: string): string {
		const parts = path.split('/');
		return parts[parts.length - 1] || path;
	}

	private async addToInbox(text: string) {
		const { inboxFilePath } = this.plugin.settings.data;
		const vault = this.app.vault;

		try {
			let file = vault.getFileByPath(inboxFilePath);
			if (!file) {
				// 创建新文件
				file = await vault.create(inboxFilePath, '');
			}

			const existing = await vault.read(file);
			const newLine = `- [ ] ${text}`;
			const updated = existing.endsWith('\n') || existing === ''
				? existing + newLine + '\n'
				: existing + '\n' + newLine + '\n';
			await vault.modify(file, updated);

			// 成功反馈
			this.showQuickAddFeedback(true, 'Task added successfully');

		} catch (error) {
			console.error('[TaskFlow] Failed to add task to inbox:', error);
			this.showQuickAddFeedback(false, `Failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}

	/**
	 * 显示 Quick Add 反馈消息
	 */
	private showQuickAddFeedback(success: boolean, message: string) {
		// 查找 Quick Add 区域的输入框
		const input = this.containerEl.querySelector('.tasks-view-quick-add-input') as HTMLInputElement;
		if (!input) return;

		// 获取 Quick Add 容器（输入框的祖父元素）
		const quickAddContainer = input.parentElement?.parentElement as HTMLElement;
		if (!quickAddContainer) return;

		// 确保容器有相对定位
		const containerStyle = quickAddContainer.style;
		if (containerStyle.position !== 'relative' && containerStyle.position !== 'absolute') {
			quickAddContainer.setCssProps({ position: 'relative' });
		}

		// 创建反馈元素
		const feedback = createDiv();
		feedback.className = `tasks-view-quick-add-feedback ${success ? 'success' : 'error'}`;
		feedback.textContent = message;
		feedback.style.cssText = `
			position: absolute;
			top: 100%;
			left: 0;
			margin-top: 4px;
			padding: 6px 12px;
			border-radius: 4px;
			font-size: var(--font-ui-small);
			z-index: 100;
			animation: tasks-view-feedback-fade-in 0.2s ease;
			background: ${success ? 'var(--color-green)' : 'var(--color-red)'};
			color: ${success ? 'var(--text-on-accent)' : 'var(--text-normal)'};
		`;

		quickAddContainer.appendChild(feedback);

		// 2秒后自动消失
		window.setTimeout(() => {
			feedback.setCssProps({ opacity: '0', transition: 'opacity 0.3s ease' });
			window.setTimeout(() => feedback.remove(), 300);
		}, 2000);
	}

	// ── Stats ───────────────────────────────────────────

	private buildStatsShell(container: HTMLElement) {
		const statsEl = container.createDiv( { cls: 'tasks-view-stats' });
		this.statsEl = statsEl;

		// Footer header: 标题 + 百分比 + 折叠箭头。
		// 整行可点：单击就地折叠/展开下方的任务类别胶囊（折叠后只剩进度条与百分比）。
		const header = statsEl.createEl('button', {
			cls: 'tasks-view-stats-header',
			attr: { type: 'button', 'aria-label': t('stats.toggleAria') },
		});
		header.createSpan( { cls: 'tasks-view-stats-label', text: t('stats.title') });
		this.statsPct = header.createSpan( { cls: 'tasks-view-stats-pct', text: '0%' });
		this.statsChevron = header.createSpan( { cls: 'tasks-view-stats-chevron' });
		header.addEventListener('click', () => {
			void this.toggleStatsCategories();
		});

		const barWrap = statsEl.createDiv( { cls: 'tasks-view-progress-bar' });
		this.progressFill = barWrap.createDiv( { cls: 'tasks-view-progress-fill' });
		this.progressFill.setCssProps({ width: '0%' });
		const pills = statsEl.createDiv( { cls: 'tasks-view-stat-pills' });

		// 每个统计项 = 一张卡片：圆点（::before）+ 数量 + 名称。
		// 返回 count 元素，供 updateStats 刷新数字；名称在此固定。
		const makePill = (mod: string, name: string): HTMLElement => {
			const pill = pills.createSpan( { cls: `tasks-view-stat-pill tasks-view-stat-pill--${mod}` });
			const count = pill.createSpan( { cls: 'tasks-view-stat-count', text: '0' });
			pill.createSpan( { cls: 'tasks-view-stat-name', text: name });
			return count;
		};

		// 按照指定顺序创建统计卡片
		this.pillOverdue = makePill('overdue', 'overdue');
		this.pillInProgress = makePill('in-progress', 'in progress');
		this.pillTodo = makePill('todo', 'todo');
		this.pillCancel = makePill('cancel', 'cancel');
		this.pillDone = makePill('done', 'done');
		// Total 卡片（最后）
		this.pillTotal = makePill('total', 'total');

		// 初始折叠态取自设置（老配置缺这个字段时默认展开，与改动前一致）
		this.applyStatsCategories(this.plugin.settings.data.showStatsCategories ?? true);
	}

	/**
	 * 应用底部「任务类别胶囊」的折叠/展开。
	 * expanded=false → 隐藏胶囊，底部只剩进度条 + 百分比，整体更矮。
	 * 只切一个 class + 换箭头，不重建 DOM、也不重算统计，所以点一下是瞬时的。
	 */
	applyStatsCategories(expanded: boolean): void {
		const el = this.statsEl;
		if (!el) return;
		el.toggleClass('is-collapsed', !expanded);
		if (this.statsChevron) {
			setIcon(this.statsChevron, expanded ? 'chevron-down' : 'chevron-right');
		}
		const header = el.querySelector('.tasks-view-stats-header');
		header?.setAttribute('aria-expanded', expanded ? 'true' : 'false');
	}

	/** 单击标题行：就地切换折叠/展开，并把结果写回设置保存下来。 */
	private async toggleStatsCategories(): Promise<void> {
		const data = this.plugin.settings.data;
		const next = !data.showStatsCategories;
		data.showStatsCategories = next;
		this.applyStatsCategories(next);
		await this.plugin.saveHeadSettings();
	}

	// ============ 面板模块：今日概览 / 重要提醒 ============

	/**
	 * 今日概览卡片（位于快捷输入框上方、重要提醒左侧，并行展示）。
	 * 统计口径完全对齐 Lyra：今日待办 / 今日完成 / 进行中 / 逾期 / 本周完成，
	 * 外加「今日」「本周」两个完成率环（口径见 updateStats）。数字由 updateStats() 刷新。
	 */
	private renderTodayOverview(container: HTMLElement): void {
		const card = container.createDiv( { cls: 'tf-today' });

		// 双环：今日完成率 / 本周完成率（置于左侧）
		const rings = card.createDiv( { cls: 'tf-today-rings' });
		const today = this.renderRing(rings, t('panel.todayRate'));
		this.toRingTodayDial = today.dial;
		this.toRingTodayText = today.text;
		const week = this.renderRing(rings, t('panel.weekRate'));
		this.toRingWeekDial = week.dial;
		this.toRingWeekText = week.text;

		// 5 个指标：成两列，置于双环右侧
		const stats = card.createDiv( { cls: 'tf-today-stats' });
		this.toTodoEl = this.makeTodayStat(stats, 'tf-today-todo', t('panel.todayTodo'));
		this.toDoneEl = this.makeTodayStat(stats, 'tf-today-done', t('panel.doneToday'));
		this.toInProgressEl = this.makeTodayStat(stats, 'tf-today-progress', t('panel.inProgress'));
		this.toOverdueEl = this.makeTodayStat(stats, 'tf-today-overdue', t('defaultTab.overdue'));
		this.toWeekEl = this.makeTodayStat(stats, 'tf-today-week', t('panel.doneWeek'));
	}

	/**
	 * 一个完成率环：conic-gradient 圆盘（用 --p 控制进度角度）+ 中心文字 + 下方标签。
	 * 用 conic-gradient 而非 SVG，规避 SVG 命名空间在 Obsidian / 测试桩下两套行为的问题。
	 */
	private renderRing(container: HTMLElement, label: string): { dial: HTMLElement; text: HTMLElement } {
		const ring = container.createDiv( { cls: 'tf-ring' });
		const dial = ring.createDiv( { cls: 'tf-ring-dial' });
		dial.createDiv( { cls: 'tf-ring-hole' });
		const text = dial.createDiv( { cls: 'tf-ring-text', text: '0%' });
		ring.createDiv( { cls: 'tf-ring-label', text: label });
		return { dial, text };
	}

	/** 一个指标 chip：大数字 + 小标签。返回数字元素供 updateStats 刷新。 */
	private makeTodayStat(container: HTMLElement, mod: string, name: string): HTMLElement {
		const item = container.createDiv( { cls: `tf-today-stat ${mod}` });
		const count = item.createDiv( { cls: 'tf-today-stat-count', text: '0' });
		item.createDiv( { cls: 'tf-today-stat-name', text: name });
		return count;
	}

	/**
	 * 重要提醒卡片（位于快捷输入框上方、今日概览右侧，并行展示）。
	 * 列表完全交给 Tasks 插件渲染（与二级 tab 同一套管线，插件不注入任何指令）。
	 * 高度上限 3 条：超出则隐藏 4 条起的内容并显示「更多任务」；少于 3 条按实际高度；无滚动条。
	 * 这里只搭骨架 + 挂 observer；内容由 renderImportantReminders()（refresh 流程）填入。
	 */
	private renderImportantModule(container: HTMLElement): void {
		const card = container.createDiv( { cls: 'tf-important' });

		const body = card.createDiv( { cls: 'tf-important-body' });
		this.importantBodyEl = body;

		const more = card.createDiv( { cls: 'tf-important-more is-hidden' });
		more.textContent = t('panel.more');
		more.addEventListener('click', () => {
			this.importantExpanded = !this.importantExpanded;
			this.applyImportantTruncation(body);
		});
		this.importantMoreEl = more;

		this.observeImportantBody(body);
	}

	/**
	 * 渲染「重要提醒」的 Tasks 查询结果。
	 * 查询原样交给 Tasks（一个字都不改）。module 关闭或 body 未构建时直接返回。
	 */
	private async renderImportantReminders(): Promise<void> {
		const body = this.importantBodyEl;
		if (!body) return;
		// 每次重渲染复位成折叠态（最多 3 条）；展开是用户的临时操作，不应跨刷新保留
		this.importantExpanded = false;
		const query = (this.plugin.settings.data.importantReminderQuery || '').trim() || DEFAULT_IMPORTANT_QUERY;
		try {
			body.empty();
			// 与 tab 同理：重要提醒也用专属渲染组件，重渲染前先卸载旧的
			const comp = this.freshRenderComponent('important');
			this.pruneRenderComponents(new Set(['important', 'tab:' + this.activeTab]));
			await MarkdownRenderer.render(
				this.app,
				'```tasks\n' + query + '\n```',
				body,
				'',
				comp,
			);
			// 兜底：Tasks 同步落地时 observer 可能已错过最佳时机，显式再应用一次
			this.applyImportantTruncation(body);
		} catch (error) {
			console.error('[TaskFlow] 重要提醒渲染失败:', error);
			this.renderImportantEmpty(body);
		}
	}

	/**
	 * 给重要提醒 body 挂 MutationObserver（幂等）：由真实 DOM 变化同时驱动
	 * 空状态判定与「最多 3 条」截断 —— 与二级 tab 的 observer 思路一致，不复用
	 * tab 计数那套（重要提醒不需要数量徽标）。
	 */
	private observeImportantBody(body: HTMLElement): void {
		if (this.observedImportantBodies.has(body)) return;
		this.observedImportantBodies.add(body);

		const onMutate = () => {
			const hasItems = body.querySelector('.task-list-item');
			if (hasItems) {
				this.removeImportantEmpty(body);
				this.applyImportantTruncation(body);
				return;
			}
			// 暂时没有任务项：等容器静默 EMPTY_QUIET_MS 再判定为空，避免渲染中途误显
			if (this.importantEmptyTimer) window.clearTimeout(this.importantEmptyTimer);
			this.importantEmptyTimer = window.setTimeout(() => {
				this.importantEmptyTimer = null;
				if (!body.querySelector('.task-list-item')) this.renderImportantEmpty(body);
			}, EMPTY_QUIET_MS);
		};

		const observer = new MutationObserver(onMutate);
		observer.observe(body, { childList: true, subtree: true });
	}

	/**
	 * 截断：最多显示 3 条；超出的（含嵌套）隐藏，并显示「更多任务」；
	 * 展开态则全部显示。少于等于 3 条时「更多任务」隐藏。
	 * 用 display:none 而非 max-height+滚动 —— 严格满足「不要滚动条」与「按实际高度」。
	 */
	private applyImportantTruncation(body: HTMLElement): void {
		const more = this.importantMoreEl;
		const items = Array.from(body.querySelectorAll<HTMLElement>('.task-list-item'));
		if (items.length === 0) {
			if (more) more.addClass('is-hidden');
			return;
		}
		const MAX = 3;
		if (items.length <= MAX) {
			items.forEach((it) => it.setCssProps({ display: '' }));
			if (more) {
				more.addClass('is-hidden');
				more.textContent = t('panel.more');
			}
			return;
		}
		if (this.importantExpanded) {
			items.forEach((it) => it.setCssProps({ display: '' }));
			if (more) {
				more.removeClass('is-hidden');
				more.textContent = t('panel.collapse');
			}
		} else {
			items.forEach((it, i) => it.setCssProps({ display: i < MAX ? '' : 'none' }));
			if (more) {
				more.removeClass('is-hidden');
				more.textContent = t('panel.moreCount', { n: items.length - MAX });
			}
		}
	}

	/** 重要提醒为空时的占位（Tasks 查询确实没结果，或渲染中途静默） */
	private renderImportantEmpty(body: HTMLElement): void {
		// 与二级 tab 同理：空状态节点挂在 card（body 的父级），避免重渲染时抖动
		const card = body.parentElement ?? body;
		if (card.querySelector('.tf-important-empty')) return;
		const empty = card.createDiv( { cls: 'tf-important-empty' });
		empty.createDiv( { cls: 'tf-important-empty-icon', text: '🔔' });
		empty.createDiv( { cls: 'tf-important-empty-title', text: t('panel.importantEmpty') });
		empty.createDiv( {
			cls: 'tf-important-empty-desc',
			text: t('panel.emptyImportant'),
		});
		if (this.importantMoreEl) this.importantMoreEl.addClass('is-hidden');
	}

	private removeImportantEmpty(body: HTMLElement): void {
		const card = body.parentElement ?? body;
		const empty = card.querySelector('.tf-important-empty');
		if (empty) empty.remove();
	}

	// ============ Tab access ============

/**
 * 获取所有 tabs（直接使用 globalTabs；board 抽象已移除）
 */
private getTabs(): TabConfig[] {
	return this.plugin.settings.data.globalTabs || [];
}
}
