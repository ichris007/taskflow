import { TFile } from 'obsidian';
import { isBuiltinSlogan, t } from './i18n';
import type { LangSetting } from './i18n';

export type TaskStatus = 'todo' | 'in-progress' | 'done' | 'migrated' | 'cancel' | 'pending' | 'waiting';

export type TabGroup = string;

export interface TabConfig {
	id: string;
	label: string;
	query: string;
	showSectionHeader: boolean;
	order: number;
	group?: TabGroup;
}

export interface TabGroupConfig {
	id: string;
	label: string;
	icon: string;
	frontmatterProperty?: string;
	/** Empty/undefined means any non-empty value matches */
	frontmatterValues?: string[];
	/** Appended as `limit N` to every query in this group */
	taskLimit?: number;
}

/** Read a frontmatter property, falling back to a case-insensitive key match. */
export function getFrontmatterValue(frontmatter: Record<string, unknown> | undefined, property: string): unknown {
	if (!frontmatter) return undefined;
	if (property in frontmatter) return frontmatter[property];
	const lower = property.toLowerCase();
	const key = Object.keys(frontmatter).find((k) => k.toLowerCase() === lower);
	return key === undefined ? undefined : frontmatter[key];
}

/** Flatten a frontmatter value (list, comma-separated string, or wikilink) into non-empty strings. */
export function normalizeFrontmatterValues(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	if (Array.isArray(value)) return value.flatMap((item) => normalizeFrontmatterValues(item));
	if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return [];
	const parts = typeof value === 'string' ? value.split(/,(?![^[]*\]\])/) : [String(value)];
	return parts
		.map((part) => part.trim().replace(/^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/, '$1').trim())
		.filter((part) => part !== '');
}

export function matchesFrontmatterFilter(value: unknown, wanted: string[] | undefined): boolean {
	const values = normalizeFrontmatterValues(value);
	if (values.length === 0) return false;
	if (!wanted || wanted.length === 0) return true;
	const wantedSet = new Set(wanted.map((item) => item.toLowerCase()));
	return values.some((item) => wantedSet.has(item.toLowerCase()));
}

/**
 * 解析一个 tab 实际归属的分组。
 * 侧栏与设置面板必须共用同一条规则，否则两边看到的 tab 会不一致：
 *   - tab 没有 group 字段（旧数据）→ 落入第一个分组
 *   - tab 的 group 不在 groups 列表里（孤立数据）→ 落入第一个分组，
 *     而不是让它在界面上凭空消失
 */
export function getTabGroup(tab: TabConfig, groups: TabGroupConfig[]): TabGroup {
	const explicit = tab.group ?? 'gtd';
	if (!groups.length) return explicit;
	return groups.some((g) => g.id === explicit) ? explicit : groups[0]!.id;
}

export interface Task {
	file: TFile;
	line: number;
	indent: number;
	status: TaskStatus;
	description: string;
	scheduled: string | null;
	due: string | null;
	recurrence: string | null;
	priority: 'highest' | 'high' | 'normal' | 'low' | 'lowest';
	startDate: string | null;
	completionDate: string | null;
	createdDate: string | null;
	taskId: string | null;
	dependsOn: string | null;
	heading: string | null;   // nearest heading above this task in the source file
	children: Task[];
}

export interface CacheEntry {
	file: TFile;
	mtime: number;
	tasks: Task[];
}

export interface Board {
	id: string;
	name: string;
	icon: string;      // Obsidian icon name
	order: number;
	tabs?: TabConfig[]; // Optional: per-board tab config, falls back to globalTabs
}

export interface TaskViewsData {
	inboxFilePath: string;
	excludedFolders: string;
	globalTabs: TabConfig[]; // Global default tabs
	boards: Board[];         // All boards (including default dashboard)
	groups: TabGroupConfig[]; // Available tab groups
	/* ── 头部（工作台头部横幅）───────────────────────────
	   对应 Lyra 的 wbTitle + banner：名字可自定义，封面图可换可移除。 */
	workbenchTitle: string;  // 头部大字，也是「工作台名」
	workbenchSlogan: string; // 头部大字右侧那句说明文案
	coverImagePath: string;  // 封面图在 vault 内的路径，'' = 未设置
	/**
	 * 封面图纵向显示位置，0 = 露图片顶部、100 = 露图片底部、50 = 居中。
	 *
	 * 刻意用百分比而不是像素位移：窗口/面板宽度变化时，容器高度是按比例
	 * 缩放的，像素位移不会跟着缩放，于是固定位移会相对容器"漂移"，把图片
	 * 边缘拖离容器边框、露出空白（Lyra 的封面就有这个毛病）。百分比在任何
	 * 尺寸下都指向图片的同一个位置，配合 object-fit:cover 永远不会露底。
	 */
	coverPosition: number;
	/** 是否显示头部封面图。false = 不渲染封面区域（工作台名与日期时间始终显示，不受此开关影响） */
	showCover: boolean;
	/* ── 面板模块（视图顶部、快捷输入框上方，与今日概览并排）──────────────
	   两个模块都位于 add-to-inbox 输入框「上方」，并排展示：
	     - 今日概览：今日待办/今日完成/进行中/逾期/本周完成 + 今日/本周完成率双环
	     - 重要提醒：复用 Tasks 插件渲染的「最该关注的任务」列表（高度上限 3 条）
	   关掉其中一个，另一个自动占满整行；两个都关则整块不渲染。 */
	/** 是否显示「今日概览」模块 */
	showTodayOverview: boolean;
	/** 是否显示「重要提醒」模块 */
	showImportantReminders: boolean;
	/** 「重要提醒」模块的 Tasks 查询，原样交给 Tasks 插件渲染（插件不做任何注入） */
	importantReminderQuery: string;
	/* ── 底部统计栏 ──────────────────────────────────────────────
	   控制最下方的「任务类别胶囊」（overdue/in-progress/todo/cancel/done/total）
	   是否展开。关闭（折叠）时底部只剩进度条 + 百分比，整体更矮。
	   视图里点「Statistics」标题行也能就地折叠/展开，两边共用这一个状态。 */
	/** 是否展开底部统计栏的任务类别胶囊；false = 折叠，只留进度条与百分比 */
	showStatsCategories: boolean;
	/* ── 头部文字与打开位置 ────────────────────────────────────── */
	/**
	 * 头部「工作台名 + slogan + 右侧日期时间」是否显示。
	 * false = 整条文字横幅不渲染（时钟定时器也不挂），封面区域不受此开关影响。
	 */
	showHeadText: boolean;
	/** 是否在分组视图顶部显示「任务上限」输入框；false = 不显示（默认），此时上限仍由分组配置里的 taskLimit 决定 */
	showFrontendLimit: boolean;
	/** 插件默认打开位置：主窗口（main）或右侧边栏（sidebar） */
	openLocation: 'main' | 'sidebar';
	/* ── 紧凑模式（侧边栏 / 窄屏 / 移动端）────────────────────────
	   视图容器宽度小于阈值时自动收起占用垂直/水平空间大的模块，
	   让任务列表在侧边栏里也能看清。总开关 + 各模块独立开关：
	   总开关关则任何宽度都保持完整界面；总开关开且宽度够宽也不压缩。 */
	/** 紧凑模式总开关：窄视图下自动收起大模块；false = 始终完整界面 */
	sidebarCompact: boolean;
	/** 紧凑模式下是否隐藏封面横幅（只控封面图，不影响下方的标题行） */
	compactHideBanner: boolean;
	/** 紧凑模式下是否隐藏标题行（工作台名 + slogan + 右侧日期时间） */
	compactHideTitle: boolean;
	/** 紧凑模式下是否隐藏「今日概览」面板 */
	compactHideTodayOverview: boolean;
	/** 紧凑模式下是否隐藏「重要提醒」面板 */
	compactHideImportantReminders: boolean;
	/** 紧凑模式下是否隐藏底部统计栏 */
	compactHideStats: boolean;
	/** 笔记选择器里「按分组各自收藏」的笔记 path 列表：分组 id → 该组收藏的笔记 path 数组（per-group 收藏） */
	pinnedNotePaths: Record<string, string[]>;
}

/** 打开位置：主窗口 / 右侧边栏 */
export type OpenLocation = 'main' | 'sidebar';

export interface TaskViewsSettings {
	version: string;
	data: TaskViewsData;
	/** 界面语言：auto = 跟随 Obsidian 系统语言，也可固定 zh / en。老配置没有则视为 auto */
	language?: LangSetting;
}

/* ═══════════════════════════════════════════════════════════════════════════
   头部（工作台头部横幅）常量与纯工具
   ───────────────────────────────────────────────────────────────────────────
   放在 types.ts 而不是 settings.ts：view.ts 需要它们，而 settings.ts 会连带
   引入两个弹窗模块，让视图去 import 设置面板属于自找耦合。这里零依赖。
   ═══════════════════════════════════════════════════════════════════════════ */

/** 头部大字的默认文案，同时也是「工作台名」的默认值 */
export const DEFAULT_WORKBENCH_TITLE = 'TaskFlow';

/** slogan 默认值。**做成函数**：模块级常量会在语言切换前就定死，切换后不再变。 */
export function defaultSlogan(): string {
	return t('default.slogan');
}

/**
 * 头部 slogan 的最终文案：把「存下来的值」解析成「该显示什么」。
 *
 * 四种情况（undefined 与空串必须区分开，别合并）：
 *   - 字段整个缺失（老 data.json）→ 内置默认值（老配置不能因为没这个字段就空一块）
 *   - 空串 → 空（用户在设置里清空 = 不要 slogan，只显示工作台名）
 *   - 等于任一历史内置默认值 → 取当前语言的默认值（见 isBuiltinSlogan 的说明）
 *   - 其它 → 用户自己写的，原样显示
 */
export function resolveSlogan(stored: string | null | undefined): string {
	if (stored === undefined || stored === null) return defaultSlogan();
	const value = stored.trim();
	if (!value) return '';
	if (isBuiltinSlogan(value)) return defaultSlogan();
	return value;
}

/** 封面图在库内的存放目录。以 `_` 开头，与用户的正常笔记文件夹区分开（用 a/b/c 选项时自建的可见文件夹）。 */
export const COVER_DIR = '_taskflow';

/** 封面纵向位置的默认值（居中） */
export const DEFAULT_COVER_POSITION = 50;

/**
 * 归一化 Tasks 查询语法的「每行排版」：逐行去掉首尾空白，再去掉整体首尾空行。
 *
 * 为什么必须做：默认查询写在带缩进的模板字符串里（`createDefaultTabs()` 内
 * 的对象字面量），源码缩进会被原样带进查询结果 —— 于是设置面板的文本框里
 * 每行都顶着一个 Tab，**看起来不是左对齐**。Tasks 语法本身按行解析，首尾空白
 * 没有语义，所以这里可以安全地抹平。
 *
 * 同时用于读写两侧：`createDefaultTabs()` 生成时归一化，`migrateTabs()` 读存盘
 * 数据时也归一化了，这样老用户已保存的、带缩进的查询一加载就被修好，不必等到手动保存。
 * 注意只处理「首尾空白」，行内的多个空格（例如 `(a)  OR (b)`）原样保留，不替用户改写内容。
 */
export function normalizeQueryLines(query: string): string {
	if (typeof query !== 'string' || !query) return '';
	return query
		.split('\n')
		.map((line) => line.trim())
		.join('\n')
		.trim();
}

/** 「重要提醒」模块的默认查询：尚未完成、有到期日、已过期，按到期日排序，最多 10 条。
 *  即「最该先看的一批」；用户可在设置面板改成任意 Tasks 查询（如按优先级 / 标签）。
 *  short mode 与其它内置 tab 保持一致：列表里只留任务文字，日期等元信息hover 可见。 */
export const DEFAULT_IMPORTANT_QUERY = [
	'not done',
	'has due date',
	'due before today',
	'short mode',
	'sort by due',
	'limit 10',
].join('\n');

/** 面板模块（今日概览 / 重要提醒）显示开关的默认值：默认都开 */
export const DEFAULT_SHOW_TODAY_OVERVIEW = true;
export const DEFAULT_SHOW_IMPORTANT_REMINDERS = true;

/** 底部统计栏「任务类别胶囊」默认展开（与改动前的样式一致） */
export const DEFAULT_SHOW_STATS_CATEGORIES = true;

/** 头部文字（工作台名 / slogan / 日期时间）默认显示 */
export const DEFAULT_SHOW_HEAD_TEXT = true;

/** 插件默认打开位置：主窗口 */
export const DEFAULT_OPEN_LOCATION: OpenLocation = 'main';

/** 紧凑模式：窄视图下自动收起大模块。总开关默认开（侧边栏/移动端体验更好）。 */
export const DEFAULT_SIDEBAR_COMPACT = true;

/** 紧凑模式下默认隐藏的模块（用户可在设置里单独打开）。 */
export const DEFAULT_COMPACT_HIDE_BANNER = true;
export const DEFAULT_COMPACT_HIDE_TITLE = true;
export const DEFAULT_COMPACT_HIDE_TODAY_OVERVIEW = true;
export const DEFAULT_COMPACT_HIDE_IMPORTANT_REMINDERS = true;
export const DEFAULT_COMPACT_HIDE_STATS = true;

/** 笔记选择器按分组收藏的笔记：默认不收藏任何（per-group 空数组） */
export const DEFAULT_PINNED_NOTE_PATHS: Record<string, string[]> = {};

/**
 * 触发紧凑模式的容器宽度阈值（px）。
 * 侧边栏默认宽度 300–350，窄分屏与移动端（≤400）都会命中，主窗口不会。
 * 同时作为「一级 tab 只显示图标」的判定点：低于它空间不够放 icon+文字。
 */
export const COMPACT_WIDTH_THRESHOLD = 360;

/** 界面语言默认跟随 Obsidian 系统语言 */
export const DEFAULT_LANGUAGE: LangSetting = 'auto';

/** 把封面纵向位置夹到 0-100；配置被手改坏时不至于把图片顶出容器 */
export function clampCoverPosition(value: unknown): number {
	const n = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(n)) return DEFAULT_COVER_POSITION;
	return Math.min(100, Math.max(0, n));
}
