import { App, Notice } from 'obsidian';
import type TaskViewsPlugin from '../main';
import type { TabConfig, TabGroup, TabGroupConfig } from '../types';
import { getFrontmatterValue, getTabGroup, normalizeFrontmatterValues } from '../types';
import { TAB_GROUPS } from '../settings';
import { TFEditModal } from './tf-edit-modal';
import { ConfirmModal } from './confirm-modal';
import { localizedTabLabel, t } from '../i18n';

/**
 * TaskFlow 配置弹窗（全局设置 + Tabs 管理）
 *
 * 三段式骨架由 TFEditModal 提供：标题固定、表单滚动、页脚常驻。
 */
export class TaskFlowConfigureModal extends TFEditModal {
	private plugin: TaskViewsPlugin;
	private onSave: () => Promise<void>;

	// 本地副本，点「保存」时才写回插件设置
	private localGlobalSettings: {
		inboxFilePath: string;
		excludedFolders: string;
	};
	private localTabs: TabConfig[];
	private tabsBody: HTMLElement | null = null;

	constructor(app: App, plugin: TaskViewsPlugin, onSave: () => Promise<void>) {
		super(app);
		this.plugin = plugin;
		this.onSave = onSave;
		this.localGlobalSettings = {
			inboxFilePath: plugin.settings.data.inboxFilePath,
			excludedFolders: plugin.settings.data.excludedFolders,
		};
		this.localTabs = JSON.parse(JSON.stringify(plugin.settings.data.globalTabs)) as TabConfig[];
	}

	protected renderContent(): void {
		const form = this.buildShell(t('modal.configTitle'));

		this.renderGlobalSettings(form);

		const tabsSection = form.createDiv( { cls: 'taskflow-config-section' });
		tabsSection.createEl('h3', { text: t('modal.tabsManage'), cls: 'taskflow-config-section-title' });
		this.tabsBody = tabsSection.createDiv( { cls: 'taskflow-config-tabs-body' });
		this.refreshTabs();
	}

	private renderGlobalSettings(container: HTMLElement): void {
		const section = container.createDiv( { cls: 'taskflow-config-section' });
		section.createEl('h3', { text: t('modal.general'), cls: 'taskflow-config-section-title' });

		this.addField({
			key: 'inboxFilePath',
			label: t('settings.inbox.title'),
			description: t('modal.inboxDesc'),
			type: 'text',
			placeholder: t('modal.inboxExample'),
			value: this.localGlobalSettings.inboxFilePath,
			validation: (v) => ((v as string).trim() ? null : t('modal.errPathEmpty')),
			onChange: (v) => {
				this.localGlobalSettings.inboxFilePath = v as string;
				this.markDirty();
			},
		});

		this.addField({
			key: 'excludedFolders',
			label: t('modal.excluded'),
			description: t('modal.excludedDesc'),
			type: 'text',
			placeholder: t('modal.excludedExample'),
			value: this.localGlobalSettings.excludedFolders,
			onChange: (v) => {
				this.localGlobalSettings.excludedFolders = v as string;
				this.markDirty();
			},
		});
	}

	/** 只重建 tab 列表本身，避免整个 section 被反复追加 */
	private refreshTabs(): void {
		const body = this.tabsBody;
		if (!body) return;
		body.empty();

		if (this.localTabs.length === 0) {
			body.createEl('p', { text: t('modal.noTabs'), cls: 'taskflow-config-empty' });
		} else {
			const list = body.createDiv( { cls: 'taskflow-config-tabs-list' });
			this.localTabs.forEach((tab, index) => {
				const item = list.createDiv( { cls: 'taskflow-config-tab-item' });

				const info = item.createDiv( { cls: 'taskflow-config-tab-info' });
				info.createSpan( {
					text: `${localizedTabLabel(tab)} (${getTabGroup(tab, this.plugin.settings.data.groups ?? [])})`,
					cls: 'taskflow-config-tab-label',
				});

				const actions = item.createDiv( { cls: 'taskflow-config-tab-actions' });
				actions
					.createEl('button', { text: t('common.edit'), cls: 'taskflow-config-tab-btn' })
					.addEventListener('click', () => this.openTabEditModal(tab, index));

				actions
					.createEl('button', {
						text: t('common.delete'),
						cls: 'taskflow-config-tab-btn taskflow-config-tab-delete',
					})
				.addEventListener('click', () => {
					new ConfirmModal(this.app, t('settings.confirm.deleteTab', { name: tab.label }), () => {
						this.localTabs.splice(index, 1);
						this.markDirty();
						this.refreshTabs();
					}).open();
				});
			});
		}

		body
			.createEl('button', {
				text: t('modal.addTab'),
				cls: 'taskflow-config-tab-btn taskflow-config-tab-add',
			})
			.addEventListener('click', () => this.openAddTabModal());
	}

	private openTabEditModal(tab: TabConfig, index: number): void {
		TFEditModal.launch(
			new TabEditModal(this.app, this.plugin, tab, (updatedTab) => {
				this.localTabs[index] = updatedTab;
				this.markDirty();
				this.refreshTabs();
			}),
			t('modal.editTabDialog'),
		);
	}

	private openAddTabModal(): void {
		const newTab: TabConfig = {
			id: `tab_${Date.now()}`,
			label: t('modal.newTab'),
			query: 'not done\ngroup by filename\nlimit 10',
			showSectionHeader: false,
			order: this.localTabs.length + 1,
			group: 'gtd',
		};
		TFEditModal.launch(
			new TabEditModal(
				this.app,
				this.plugin,
				newTab,
				(updatedTab) => {
					this.localTabs.push(updatedTab);
					this.markDirty();
					this.refreshTabs();
				},
				true,
			),
			t('modal.newTabDialog'),
		);
	}

	protected async doSave(): Promise<void> {
		this.plugin.settings.data.inboxFilePath = this.localGlobalSettings.inboxFilePath;
		this.plugin.settings.data.excludedFolders = this.localGlobalSettings.excludedFolders;
		this.plugin.settings.data.globalTabs = this.localTabs;
		await this.onSave();
		new Notice(t('toast.configSaved'));
	}
}

/**
 * Tab 编辑弹窗
 */
export class TabEditModal extends TFEditModal {
	private tab: TabConfig;
	private plugin: TaskViewsPlugin;
	private onSave: (tab: TabConfig) => void;

	constructor(
		app: App,
		plugin: TaskViewsPlugin,
		tab: TabConfig,
		onSave: (tab: TabConfig) => void,
		isNew = false,
	) {
		super(app);
		this.plugin = plugin;
		this.tab = { ...tab, showSectionHeader: tab.showSectionHeader ?? false };
		this.onSave = onSave;
		// 新建的 tab 即便没改过也要保存，否则「保存」会静默丢弃
		this.forceSave = isNew;
	}

	protected renderContent(): void {
		this.buildShell(this.forceSave ? t('modal.addTabBtn') : t('modal.editTabBtn'));

		this.addField({
			key: 'id',
			label: 'ID',
			description: t('modal.tabIdDesc'),
			type: 'readonly',
			value: this.tab.id,
			onChange: () => {},
		});

		this.addField({
			key: 'label',
			label: t('modal.label'),
			description: t('modal.labelDesc'),
			type: 'text',
			placeholder: t('modal.labelExample'),
			value: this.tab.label,
			validation: (v) => ((v as string).trim() ? null : t('modal.errLabelEmpty')),
			onChange: (v) => {
				this.tab.label = v as string;
				this.markDirty();
			},
		});

		this.addField({
			key: 'query',
			label: t('modal.query'),
			description: t('modal.queryDesc'),
			type: 'textarea',
			placeholder: t('modal.queryPlaceholder'),
			value: this.tab.query,
			rows: 5,
			validation: (v) => ((v as string).trim() ? null : t('modal.errQueryEmpty')),
			onChange: (v) => {
				this.tab.query = v as string;
				this.markDirty();
			},
		});

		// 分组下拉必须来自用户当前的分组配置，
		// 否则自建分组不在选项里，tab 会被悄悄改回内置分组
		const liveGroups = this.plugin.settings.data.groups?.length
			? this.plugin.settings.data.groups
			: TAB_GROUPS;

		this.addField({
			key: 'group',
			label: t('nav.groups'),
			description: t('modal.groupDesc'),
			type: 'dropdown',
			value: getTabGroup(this.tab, liveGroups),
			options: Object.fromEntries(liveGroups.map((g) => [g.id, g.label])),
			onChange: (v) => {
				this.tab.group = v as TabGroup;
				this.markDirty();
			},
		});

		this.addField({
			key: 'showSectionHeader',
			// 措辞与 Tabs 面板行上的开关保持一致（那边一直叫「显示标题」）
			label: t('settings.showHeader'),
			description: t('modal.showHeaderDesc'),
			type: 'toggle',
			value: this.tab.showSectionHeader,
			onChange: (v) => {
				this.tab.showSectionHeader = v as boolean;
				this.markDirty();
			},
		});

		this.addField({
			key: 'order',
			label: t('modal.order'),
			description: t('modal.orderDesc'),
			type: 'text',
			placeholder: t('modal.orderExample'),
			value: String(this.tab.order),
			validation: (v) => {
				const num = parseInt(v as string, 10);
				return !isNaN(num) && num > 0 ? null : t('modal.errOrder');
			},
			onChange: (v) => {
				const num = parseInt(v as string, 10);
				if (!isNaN(num) && num > 0) {
					this.tab.order = num;
					this.markDirty();
				}
			},
		});
	}

	protected doSave(): void {
		this.onSave(this.tab);
		this.plugin.refreshAllViews();
	}
}

/**
 * 分组编辑弹窗
 */
export class GroupEditModal extends TFEditModal {
	private group: TabGroupConfig;
	private onSave: (group: TabGroupConfig) => void;
	private valuesHost: HTMLElement | null = null;
	private valuesRefreshTimer: number | null = null;

	constructor(
		app: App,
		group: TabGroupConfig,
		onSave: (group: TabGroupConfig) => void,
	) {
		super(app);
		this.group = { ...group, frontmatterValues: group.frontmatterValues ? [...group.frontmatterValues] : undefined };
		this.onSave = onSave;
		this.forceSave = !group.id;
	}

	protected renderContent(): void {
		this.buildShell(this.forceSave ? t('modal.addGroup') : t('modal.editGroup'));

		this.addField({
			key: 'id',
			label: 'ID',
			description: t('modal.groupIdDesc'),
			type: this.group.id ? 'readonly' : 'text',
			placeholder: t('modal.groupIdExample'),
			value: this.group.id,
			validation: (v) => {
				if (!(v as string).trim()) return t('modal.errIdEmpty');
				if (!/^[a-z0-9-]+$/.test(v as string)) return t('modal.idRule');
				return null;
			},
			onChange: (v) => {
				this.group.id = String(v).toLowerCase().replace(/[^a-z0-9-]/g, '-');
				this.markDirty();
			},
		});

		this.addField({
			key: 'label',
			label: t('modal.label'),
			description: t('modal.labelDesc'),
			type: 'text',
			placeholder: t('modal.groupExample'),
			value: this.group.label,
			validation: (v) => ((v as string).trim() ? null : t('modal.errLabelEmpty')),
			onChange: (v) => {
				this.group.label = v as string;
				this.markDirty();
			},
		});

		this.addField({
			key: 'icon',
			label: t('modal.icon'),
			description: t('modal.iconDesc'),
			type: 'icon-picker',
			value: this.group.icon,
			onChange: (v) => {
				this.group.icon = (v as string) || 'folder';
				this.markDirty();
			},
		});

		this.addField({
			key: 'frontmatterProperty',
			label: t('modal.groupNoteProperty'),
			description: t('modal.groupNotePropertyDesc'),
			type: 'text',
			placeholder: t('modal.groupNotePropertyExample'),
			value: this.group.frontmatterProperty ?? '',
			onChange: (v) => {
				const property = (v as string).trim();
				if (property !== (this.group.frontmatterProperty ?? '')) {
					this.group.frontmatterValues = undefined;
				}
				this.group.frontmatterProperty = property || undefined;
				this.markDirty();
				this.scheduleValuesRefresh();
			},
		});

		this.valuesHost = this.formEl?.createDiv({ cls: 'tf-field' }) ?? null;
		this.renderValuesPicker();

		// 上限放到属性值筛选之后：笔记筛选属性(属性) 与 属性值筛选 紧邻，逻辑更顺
		this.addField({
			key: 'taskLimit',
			label: t('view.group.limit'),
			description: t('view.group.limitDesc'),
			type: 'text',
			placeholder: t('view.group.limit'),
			value: this.group.taskLimit != null ? String(this.group.taskLimit) : '',
			onChange: (v) => {
				const parsed = parseInt((v as string) ?? '', 10);
				this.group.taskLimit = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
				this.markDirty();
			},
		});
	}

	onClose(): void {
		if (this.valuesRefreshTimer !== null) window.clearTimeout(this.valuesRefreshTimer);
		super.onClose();
	}

	private scheduleValuesRefresh(): void {
		if (this.valuesRefreshTimer !== null) window.clearTimeout(this.valuesRefreshTimer);
		this.valuesRefreshTimer = window.setTimeout(() => {
			this.valuesRefreshTimer = null;
			this.renderValuesPicker();
		}, 300);
	}

	private collectPropertyValues(property: string): string[] {
		const values = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const raw = getFrontmatterValue(this.app.metadataCache.getFileCache(file)?.frontmatter, property);
			for (const value of normalizeFrontmatterValues(raw)) values.add(value);
		}
		return [...values].sort((a, b) => a.localeCompare(b));
	}

	private renderValuesPicker(): void {
		const host = this.valuesHost;
		if (!host) return;
		host.empty();
		const property = this.group.frontmatterProperty?.trim();
		if (!property) {
			host.hide();
			return;
		}
		host.show();

		const labelText = host.createEl('label', { cls: 'tf-field-label' }).createDiv({ cls: 'tf-field-label-text' });
		labelText.createSpan({ cls: 'tf-field-name', text: t('modal.groupNoteValues') });
		labelText.createSpan({ cls: 'tf-field-desc', text: t('modal.groupNoteValuesDesc') });

		const selected = new Set(this.group.frontmatterValues ?? []);
		// Keep previously saved values visible even if no note currently uses them
		const options = [...new Set([...this.collectPropertyValues(property), ...selected])]
			.sort((a, b) => a.localeCompare(b));

		const dropdown = host.createDiv({ cls: 'tf-field-input-wrapper' }).createEl('details', { cls: 'tf-multiselect' });
		const summary = dropdown.createEl('summary', { cls: 'tf-field-select tf-multiselect-summary' });
		const updateSummary = () => {
			summary.textContent = selected.size
				? [...selected].join(', ')
				: t('modal.groupNoteValuesAny');
		};
		updateSummary();

		const list = dropdown.createDiv({ cls: 'tf-multiselect-list' });
		if (options.length === 0) {
			list.createDiv({ cls: 'tf-multiselect-empty', text: t('modal.groupNoteValuesNone') });
			return;
		}
		const search = list.createEl('input', {
			cls: 'tf-multiselect-search',
			attr: { type: 'text', placeholder: t('view.group.searchNote'), 'aria-label': t('view.group.searchNote') },
		});
		search.addEventListener('input', () => {
			const q = search.value.trim().toLowerCase();
			list.querySelectorAll('.tf-multiselect-option').forEach((row) => {
				const el = row as HTMLElement;
				const text = (el.textContent ?? '').toLowerCase();
				el.style.display = !q || text.includes(q) ? '' : 'none';
			});
		});
		for (const value of options) {
			const row = list.createEl('label', { cls: 'tf-multiselect-option' });
			const checkbox = row.createEl('input', { attr: { type: 'checkbox' } });
			checkbox.checked = selected.has(value);
			row.createSpan({ text: value });
			checkbox.addEventListener('change', () => {
				if (checkbox.checked) selected.add(value);
				else selected.delete(value);
				this.group.frontmatterValues = selected.size ? [...selected] : undefined;
				updateSummary();
				this.markDirty();
			});
		}
	}

	protected doSave(): void {
		this.onSave(this.group);
	}
}
