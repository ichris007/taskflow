import { Notice, Plugin } from 'obsidian';
import {
	migrateSettings,
	TaskViewsSettingTab,
} from './settings';
import { TaskFlowView, VIEW_TYPE_TASKFLOW } from './view';
import type { TaskViewsSettings } from './types';
import { resolveLang, setUiLang } from './i18n';
import type { LangSetting } from './i18n';
import { TASKFLOW_ICON_SVG } from './brand';
import { mountTrustedSvg } from './svg';

export default class TaskFlowPlugin extends Plugin {
	settings!: TaskViewsSettings;

	async onload() {
		await this.loadSettings();
		// 语言要在任何界面渲染之前定下来：auto 跟随 Obsidian，zh/en 强制
		setUiLang(resolveLang(this.settings.language, this.app));

		this.registerView(
			VIEW_TYPE_TASKFLOW,
			(leaf) => new TaskFlowView(leaf, this),
		);

		this.addCommand({
			id: 'open-view',
			name: 'Open workbench',
			callback: () => this.activateView(),
		});

		// 左侧 Ribbon 图标：点一下就打开 TaskFlow（走同一个 activateView，位置跟随设置）
		const ribbonEl = this.addRibbonIcon('layout-dashboard', 'TaskFlow', () => {
			void this.activateView();
		});
		// 换成自绘品牌标识（蓝紫渐变圆角方块 + 两道白波），与设置面板「关于」页同一枚；
		// 挂载失败则保留上面的 layout-dashboard 兜底，不至于没有图标可点。
		if (mountTrustedSvg(ribbonEl, TASKFLOW_ICON_SVG)) {
			// addRibbonIcon 已经先塞了一个 lucide layout-dashboard 图标；
			// 某些主题不会自动隐藏它，于是会并排出现两个图标。挂载成功后把原始图标清掉，
			// 只留品牌标识。
			ribbonEl.querySelectorAll('svg:not(.tf-brand-mark)').forEach((el) => el.remove());
		} else {
			// 挂载失败：保留 addRibbonIcon 的 layout-dashboard 兜底图标，无需额外处理
		}

		this.addSettingTab(new TaskViewsSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			void this.activateView();
		});
	}

	onunload() {
		
	}

	private hasTasksPlugin(): boolean {
		const plugins = this.app.plugins.plugins;
		return !!plugins['obsidian-tasks-plugin'];
	}

	private async activateView() {
		// Dependency check happens here — not in onload() — because this runs
		// after onLayoutReady, when every enabled plugin is guaranteed to be
		// loaded. Checking in onload() races against plugin load order.
		if (!this.hasTasksPlugin()) {
			new Notice(
				'Tasks Companion Pane: The Tasks plugin (obsidian-tasks-group) must be installed and enabled.',
				10000,
			);
			return;
		}

		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_TASKFLOW);
		const existingLeaf = existing[0];
		if (existingLeaf) {
			void this.app.workspace.revealLeaf(existingLeaf);
			return;
		}

		// 打开位置跟随设置：主窗口（tab）或右侧边栏（right sidebar）
		const wantSidebar = this.settings?.data?.openLocation === 'sidebar';
		const leaf = wantSidebar
			? (this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf('tab'))
			: this.app.workspace.getLeaf('tab');
		if (leaf) {
			await leaf.setViewState({ type: VIEW_TYPE_TASKFLOW, active: true });
			void this.app.workspace.revealLeaf(leaf);
		}
	}

	async loadSettings() {
		const loaded = (await this.loadData()) as Partial<TaskViewsSettings> | null;
		this.settings = migrateSettings(loaded ?? {});
	}

	async saveSettings() {
		// Sort boards and globalTabs by order
		if (this.settings.data.boards) {
			this.settings.data.boards.sort((a, b) => a.order - b.order);
		}
		if (this.settings.data.globalTabs) {
			this.settings.data.globalTabs.sort((a, b) => a.order - b.order);
		}
		await this.saveData(this.settings);
		this.refreshAllViews();
	}

	/**
	 * 头部（工作台名 / slogan / 封面）的保存：只写盘，不重建界面。
	 *
	 * 存在的理由：拖动封面调位置时，松手若走 saveSettings()，会连带
	 * refreshAllViews() 把整个 shell（包括正在拖的那张图）销毁重建，
	 * 松手瞬间画面闪一下。封面位移是纯视觉状态，不需要重建。
	 */
	async saveHeadSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	refreshAllViews() {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TASKFLOW);
		for (const leaf of leaves) {
			const view = leaf.view as TaskFlowView;
			view.buildShell();
			void view.refresh();
		}
	}

	/**
	 * 就地同步底部统计栏「任务类别胶囊」的折叠/展开，不重建整个 shell。
	 * 设置面板改开关时调用：视图正开着的话立刻生效，省得要重载插件。
	 */
	/**
	 * 切换界面语言：立刻改全局语言并重建所有已打开的视图。
	 * 设置面板自己会 rebuildUI()，两边一起刷新，不用重载插件。
	 */
	applyLanguage(lang: LangSetting): void {
		this.settings.language = lang;
		setUiLang(resolveLang(lang, this.app));
		void this.saveData(this.settings);
		this.refreshAllViews();
	}

	applyStatsCategories(expanded: boolean) {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TASKFLOW);
		for (const leaf of leaves) {
			const view = leaf.view as TaskFlowView;
			view.applyStatsCategories(expanded);
		}
	}

	/** 紧凑模式设置变更后，立刻让所有已打开的视图按新设置 + 当前宽度重算（无需重建 DOM）。 */
	applyCompact() {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TASKFLOW);
		for (const leaf of leaves) {
			const view = leaf.view as TaskFlowView;
			view.applyCompactMode();
		}
	}
}
