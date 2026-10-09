/**
 * TaskFlow 双语支持（i18n）
 *
 * 设计要点：
 * 1. 所有面向用户的文案都走 `t(key)`，中文为基准表（ZH），英文为 EN。
 *    缺失的 key 会回落到中文，再缺失就直接返回 key —— 绝不让界面出现空白。
 * 2. 语言来源三档：auto（跟随 Obsidian 界面语言）/ zh / en，存在插件级设置里。
 * 3. `t()` 支持 `{name}` 占位符：t('a.b', { n: 3 }) 会把 "{n}" 换成 3。
 *    因此带变量的文案一律写成模板串再传 vars，不要在调用处做字符串拼接。
 */

import { getLanguage } from 'obsidian';

export type UiLang = 'zh' | 'en';
/** 设置项的三档取值：跟随系统 / 强制中文 / 强制英文 */
export type LangSetting = 'auto' | 'zh' | 'en';

const ZH: Record<string, string> = {
	'about.author1': '科技行业人才专家，15年老猎头，互联网/AI/机器人，面试超万人。',
	'about.author2': '生产力系统专家，专注16年+，打造高效工作和成长体系。',
	'about.author3': '自媒体全网同名：猎人科叔。',
	'about.authorTitle': '作者：猎人科叔',
	'about.githubBtn': '打开 GitHub 仓库',
	'about.githubDesc': '查看插件源代码、详细的使用说明、更新日志、问题反馈等。',
	'about.githubTitle': 'Github Repository',
	'about.intro1': 'TaskFlow 是一个面向 Obsidian Tasks 的行动工作台。',
	'about.intro2': '它不改变你任何既有的任务记录语法与查询逻辑，而是在任务列表之上，构建了一层动态的 “行动空间（Action Space）”。',
	'about.intro3': '它重新组织你的任务，让你从“管理有哪些事情要做”，转向“快速找到现在该做什么”。通过时间、GTD 和场景维度降低选择成本，让行动更快发生。',
	'about.introTitle': 'TaskFlow 简介',
	'about.moreBtn': '访问 lifein.vip',
	'about.moreDesc': '示例库、插件、脚本、经验等',
	'about.moreTitle': '更多关于科叔的 Obsidian 生产力与知识管理实践',
	'banner.line': '你不缺任务，你缺的是下一步。',
	'common.builtinSuffix': ' · 内置',
	'common.cancel': '取消',
	'common.confirm': '确定',
	'common.close': '关闭',
	'common.delete': '删除',
	'common.edit': '编辑',
	'common.remove': '移除',
	'common.reset': '恢复默认',
	'common.save': '保存',
	'common.thisGroup': '该分组',
	'default.slogan': '从管理任务，到选择行动。',
	'defaultGroup.dashboard': 'Dashboard',
	'defaultTab.drift': '漂移',
	'defaultTab.inbox': '收集',
	'defaultTab.life': '生活',
	'defaultTab.month': '本月',
	'defaultTab.next': '下一步',
	'defaultTab.overdue': '逾期',
	'defaultTab.someday': '将来',
	'defaultTab.today': '今日',
	'defaultTab.tomorrow': '明日',
	'defaultTab.waiting': '等待',
	'defaultTab.week': '本周',
	'defaultTab.work': '工作',
	'empty.newTask': '+ 新建任务',
	'empty.noTabsHint': '在设置面板的「Tabs 管理」里添加一个 Tab，它就会出现在这里。',
	'empty.noTasks': '这里暂时没有任务',
	'head.changeBanner': '更换横幅',
	'head.lunarSep': ' · 农历 ',
	'head.uploadBanner': '上传横幅',
	'modal.addGroup': '添加分组',
	'modal.addTab': '+ 添加新 tab',
	'modal.addTabBtn': '添加 Tab',
	'modal.configTitle': 'TaskFlow 配置',
	'modal.editGroup': '编辑分组',
	'modal.editGroupDialog': '分组编辑弹窗',
	'modal.editTabBtn': '编辑 Tab',
	'modal.editTabDialog': 'Tab 编辑弹窗',
	'modal.editTitle': '编辑弹窗',
	'modal.errIdEmpty': 'ID 不能为空',
	'modal.errLabelEmpty': '标签不能为空',
	'modal.errOrder': '请输入大于 0 的整数',
	'modal.errPathEmpty': '文件路径不能为空',
	'modal.errQueryEmpty': '查询不能为空',
	'modal.excluded': '排除文件夹',
	'modal.excludedDesc': '逗号分隔的文件夹路径，这些文件夹中的文件不会被任务扫描',
	'modal.excludedExample': '例如：System/Templates, 附件',
	'modal.fixFields': '请先修正标红的字段',
	'modal.general': '全局设置',
	'modal.groupDesc': '将此 tab 分配到哪个分组',
	'modal.groupExample': '例如：自定义、项目、团队',
	'modal.groupIdDesc': '分组的唯一标识符（仅限小写字母、数字、连字符）',
	'modal.groupIdExample': '例如：custom-group',
	'modal.groupNoteProperty': '笔记筛选属性',
	'modal.groupNotePropertyDesc': '设置后，此分组会显示匹配该 frontmatter 属性值的笔记下拉框。Tasks 查询中的 query.file 将指向所选笔记。',
	'modal.groupNotePropertyExample': '例如：project',
	'modal.groupNoteValues': '属性值筛选',
	'modal.groupNoteValuesDesc': '仅显示该属性包含所选值之一的笔记。不选则匹配任何非空值。',
	'modal.groupNoteValuesAny': '任意非空值',
	'modal.groupNoteValuesNone': '没有笔记使用此属性',
	'modal.icon': '图标',
	'modal.iconDesc': '从下拉列表中选择，或搜索任意 Obsidian 图标名（不在列表里也能用）',
	'modal.iconExample': '例如：folder',
	'modal.iconSearch': '搜索图标…',
	'modal.iconUseCustom': '使用自定义图标「{name}」',
	'modal.iconNoMatch': '没有匹配的图标',
	'modal.idRule': '仅限小写字母、数字、连字符',
	'modal.inboxDesc': 'Quick add 写入新任务的文件路径',
	'modal.inboxExample': '例如：Inbox.md',
	'modal.label': '标签',
	'modal.labelDesc': '在界面上显示的名称',
	'modal.labelExample': '例如：收集、今日、工作',
	'modal.newGroupDialog': '新建分组弹窗',
	'modal.newTab': '新 tab',
	'modal.newTabDialog': '新建 Tab 弹窗',
	'modal.noTabs': '暂无 tabs，请添加新 tab',
	'modal.openFail': 'TaskFlow：{label}打开失败 —— {msg}',
	'modal.order': '顺序',
	'modal.orderDesc': '在同分组中的显示顺序（数字越小越靠前）',
	'modal.orderExample': '例如：1, 2, 3...',
	'modal.query': 'Tasks 查询',
	'modal.queryDesc': '使用 Tasks 插件的查询语法',
	'modal.queryPlaceholder': '例如：not done\nhas due date\ngroup by filename\nsort by due',
	'modal.renderFail': '⚠ 此弹窗渲染失败',
	'modal.renderFailDetail': '渲染失败：{msg}',
	'modal.saveFail': '保存失败：{msg}',
	'modal.saving': '保存中…',
	'modal.showHeaderDesc': '在 tab 内容上方显示标题（如 "今日"、"待办" 等）及其任务数量',
	'modal.tabIdDesc': 'Tab 的唯一标识符（不可修改）',
	'modal.tabsManage': 'Tabs 管理',
	'modal.unsaved': '有未保存的修改',
	'nav.about': '关于',
	'nav.general': '全局',
	'nav.groups': '分组',
	'view.group.selectNote': '选择 {group} 笔记',
	'view.group.noMatchingNotes': '没有包含该属性值的笔记',
	'view.group.searchNote': '搜索笔记…',
	'view.group.favoriteNote': '收藏',
	'view.group.unfavoriteNote': '取消收藏',
	'view.group.onlyFavorites': '仅看收藏',
	'view.group.limit': '上限',
	'view.group.limitDesc': '此分组每个查询最多显示的任务数（留空则使用查询自身设置）',
	'panel.collapse': '收起 ↑',
	'panel.doneToday': '今日完成',
	'panel.doneWeek': '本周完成',
	'panel.emptyImportant': '当前筛选条件下没有任务。可在设置面板调整「重要提醒查询」。',
	'panel.importantEmpty': '暂无需要关注的任务',
	'panel.inProgress': '进行中',
	'panel.more': '更多…',
	'panel.moreCount': '更多 ({n})…',
	'panel.todayRate': '今日',
	'panel.todayTodo': '今日待办',
	'panel.weekRate': '本周',
	'settings.addGroup': '添加新分组',
	'settings.confirm.deleteGroup': '删除分组 "{name}"？此操作将同时删除该分组下的所有 Tabs。',
	'settings.confirm.deleteTab': '删除 Tab "{name}"？',
	'settings.cover.aria': '选择横幅图片',
	'settings.cover.change': '更换',
	'settings.cover.choose': '选择图片…',
	'settings.cover.none': '未设置（正在用内置默认横幅）',
	'settings.cover.pick': '横幅图片',
	'settings.cover.pickDesc': '头部横幅图，文件名 {file}.<ext>，存放位置跟随 Obsidian「附件默认存放路径」：选「指定的文件夹」就放进那个文件夹，其余三种（库根 / 当前文件所在文件夹 / 其下子文件夹）统一放进库根的 {dir} 文件夹。换图自动清掉旧文件。不设置则显示插件自带的默认横幅；悬停横幅右上角也能换',
	'settings.cover.show': '显示横幅',
	'settings.cover.showDesc': '是否显示头部顶部的横幅图（没放自己的图时显示内置默认横幅）。关掉后只显示工作台名 + 日期时间文字横幅，横幅区域不再占用（tab 列表照常显示）。',
	'settings.cover.title': '横幅',
	'settings.group.idLine': 'ID: {id} · {count} 个 tab{suffix}',
	'settings.group.tabCount': '{n} 个 Tab',
	'settings.head.sloganDesc': '工作台名右侧那句短语；留空则只显示工作台名（内置默认文案会跟随界面语言）',
	'settings.head.textDesc': '控制头部那条文字横幅（工作台名 + slogan + 右侧日期时间）是否显示。关掉后头部只剩横幅图区域；横幅图也关时整个头部不渲染。',
	'settings.head.textTitle': '显示工作台名与日期时间',
	'settings.head.title': '工作台名 / Slogan',
	'settings.head.workbench': '工作台名',
	'settings.head.workbenchDesc': '视图头部显示的大字（默认 {def}）。回车或移开焦点后生效',
	'settings.frontendLimit.show': '在视图顶部显示任务上限框',
	'settings.frontendLimit.showDesc': '分组若设了任务上限，视图顶部是否显示可随手调整的上限输入框。默认关闭，此时上限仍由分组配置里的上限决定。',
	'settings.inbox.desc': 'Quick add 写入新任务的文件。输入文件名即搜索，点选确认（不选不生效，避免手工输错路径）',
	'settings.inbox.placeholder': '输入文件名搜索…',
	'settings.inbox.title': 'Inbox 文件路径',
	'settings.lang.desc': '默认跟随 Obsidian 的界面语言；也可以在这里固定为中文或英文。切换后立即生效，无需重启插件。',
	'settings.lang.en': 'English',
	'settings.lang.follow': '跟随系统',
	'settings.lang.title': '界面语言',
	'settings.lang.zh': '中文',
	'settings.newTab': '新 Tab',
	'settings.noTabs': '暂无 Tab',
	'settings.notice': '修改配置后，请关闭插件，然后重新开启，使配置生效。',
	'settings.noticeTitle': '提醒',
	'settings.open.desc': '点开 TaskFlow 时视图默认落在哪里。两个位置都按容器宽度自适应：右侧边栏变窄时，',
	'settings.open.desc2': '「今日概览 + 重要提醒」会自动上下堆叠而不是挤成一团。改完需重开插件生效。',
	'settings.open.main': '主窗口',
	'settings.open.sidebar': '右侧边栏',
	'settings.open.subtitle': '主窗口 或 右侧边栏',
	'settings.open.title': '插件默认打开位置',
	'settings.panel.important': '显示重要提醒',
	'settings.panel.importantDesc': '右侧卡片：用 Tasks 插件渲染「最该关注的任务」。可与今日概览并排；关掉今日概览时它占满整行。',
	'settings.panel.query': '重要提醒查询',
	'settings.panel.queryDesc': '原样交给 Tasks 插件执行的查询（一个字都不改，插件不注入任何指令）。写法与二级 tab 的查询完全相同。',
	'settings.panel.title': '面板模块（显示在快捷输入框上方）',
	'settings.panel.today': '显示今日概览',
	'settings.panel.todayDesc': '左侧卡片：今日待办 / 今日完成 / 进行中 / 逾期 / 本周完成，以及「今日」「本周」两个完成率环。完成率口径：该周期内完成数 ÷（该周期内完成数 + 该周期已到期却未完成数），所以本周一定包含今日。',
	'settings.showHeader': '显示标题',
	'settings.stats.categories': '展开任务类别',
	'settings.stats.categoriesDesc': '关闭（折叠）后底部只保留进度条与百分比；开启则显示 overdue / in progress / todo / cancel / done / total 全部胶囊。视图里点「Statistics」这一行可随时就地切换。',
	'settings.stats.title': '底部统计栏',
	'settings.tab.addToGroup': '添加新 Tab 到 {group}',
	'settings.tab.headerToggle': '在「{label}」内容上方显示章节标题',
	'settings.tab.metaLine': '查询: {query} · 顺序: {order}',
	'stats.title': '统计',
	'stats.toggleAria': '折叠或展开任务类别统计',
	'suggest.noMatch': '没有匹配的文件',
	'toast.bannerRemoveFail': '移除横幅失败：',
	'toast.bannerRemoved': '横幅已移除',
	'toast.bannerSaveFail': '横幅保存失败：',
	'toast.bannerUpdated': '横幅已更新',
	'toast.configSaved': 'TaskFlow 配置已保存',
	'toast.groupCreated': '分组已创建',
	'toast.groupDeleted': '分组已删除',
	'toast.groupUpdated': '分组已更新',
	'toast.headerHidden': '已隐藏章节标题',
	'toast.headerShown': '已显示章节标题',
	'toast.inboxSet': 'Inbox 文件已设置',
	'toast.queryReset': '已恢复默认查询',
	'toast.queryUpdated': '重要提醒查询已更新',
	'toast.sloganUpdated': 'Slogan 已更新',
	'toast.tabCreated': 'Tab 已创建',
	'toast.tabDeleted': 'Tab 已删除',
	'toast.tabUpdated': 'Tab 已更新',
	'toast.workbenchUpdated': '工作台名已更新',
	'view.empty.noMatch': '在“{label}”下没有找到匹配的任务。试试添加一个新任务，或者检查过滤条件。',
	'view.empty.noTabsInGroup': '{name} 下还没有 Tab',
	'settings.compact.title': '紧凑模式',
	'settings.compact.hideBanner': '紧凑时隐藏封面横幅',
	'settings.compact.hideBannerDesc': '隐藏顶部的封面图，只留下方的工作台名与日期时间。',
	'settings.compact.hideTitle': '紧凑时隐藏工作台名与日期时间',
	'settings.compact.hideTitleDesc': '隐藏工作台名、slogan 与右侧日期时间，给任务列表让出空间。',
	'settings.compact.hideTodayOverview': '紧凑时隐藏今日概览',
	'settings.compact.hideTodayOverviewDesc': '隐藏今日完成/逾期等环图与指标卡片。',
	'settings.compact.hideImportantReminders': '紧凑时隐藏重要提醒',
	'settings.compact.hideImportantRemindersDesc': '隐藏「重要提醒」任务卡片，节省垂直空间。',
	'settings.compact.hideStats': '紧凑时隐藏底部统计',
	'settings.compact.hideStatsDesc': '隐藏底部的 overdue / 进行中等任务类别胶囊，让视图更矮。',
};

const EN: Record<string, string> = {
	'about.author1': 'Tech talent expert, 15 years as a headhunter across internet / AI / robotics, 10,000+ interviews conducted.',
	'about.author2': 'Productivity systems expert, 16+ years focused on building efficient work and growth systems.',
	'about.author3': 'Same handle across all social media platforms: 猎人科叔.',
	'about.authorTitle': 'Author: Uncle Ke',
	'about.githubBtn': 'Open GitHub repository',
	'about.githubDesc': 'Browse the source code, full documentation, changelog, and report issues.',
	'about.githubTitle': 'Github Repository',
	'about.intro1': 'TaskFlow is an action workbench for Obsidian Tasks.',
	'about.intro2': 'It does not change any of your existing task syntax or query logic. Instead, it builds a dynamic "Action Space" on top of your task list.',
	'about.intro3': 'It reorganizes your tasks, shifting you from "managing what needs to be done" to "quickly finding what to do now." By reducing the cost of choosing across time, GTD, and context dimensions, it helps action happen faster.',
	'about.introTitle': 'About TaskFlow',
	'about.moreBtn': 'Visit lifein.vip',
	'about.moreDesc': 'Example vaults, plugins, scripts, notes and more',
	'about.moreTitle': 'More of Uncle Ke\'s Obsidian productivity & knowledge management practice',
	'banner.line': 'You don\'t need more tasks. You need the next step.',
	'common.builtinSuffix': ' · built-in',
	'common.cancel': 'Cancel',
	'common.confirm': 'Confirm',
	'common.close': 'Close',
	'common.delete': 'Delete',
	'common.edit': 'Edit',
	'common.remove': 'Remove',
	'common.reset': 'Restore default',
	'common.save': 'Save',
	'common.thisGroup': 'this group',
	'default.slogan': 'From managing tasks to choosing action.',
	'defaultGroup.dashboard': 'Dashboard',
	'defaultTab.drift': 'Drift',
	'defaultTab.inbox': 'Inbox',
	'defaultTab.life': 'Life',
	'defaultTab.month': 'This month',
	'defaultTab.next': 'Next',
	'defaultTab.overdue': 'Overdue',
	'defaultTab.someday': 'Someday',
	'defaultTab.today': 'Today',
	'defaultTab.tomorrow': 'Tomorrow',
	'defaultTab.waiting': 'Waiting',
	'defaultTab.week': 'This week',
	'defaultTab.work': 'Work',
	'empty.newTask': '+ New task',
	'empty.noTabsHint': 'Add a Tab under "Tabs" in the settings panel and it will appear here.',
	'empty.noTasks': 'No tasks here yet',
	'head.changeBanner': 'Change banner',
	'head.lunarSep': ' · lunar ',
	'head.uploadBanner': 'Upload banner',
	'modal.addGroup': 'Add group',
	'modal.addTab': '+ Add new tab',
	'modal.addTabBtn': 'Add Tab',
	'modal.configTitle': 'TaskFlow settings',
	'modal.editGroup': 'Edit group',
	'modal.editGroupDialog': 'Edit group dialog',
	'modal.editTabBtn': 'Edit Tab',
	'modal.editTabDialog': 'Edit Tab dialog',
	'modal.editTitle': 'Edit dialog',
	'modal.errIdEmpty': 'ID cannot be empty',
	'modal.errLabelEmpty': 'Label cannot be empty',
	'modal.errOrder': 'Please enter an integer greater than 0',
	'modal.errPathEmpty': 'File path cannot be empty',
	'modal.errQueryEmpty': 'Query cannot be empty',
	'modal.excluded': 'Excluded folders',
	'modal.excludedDesc': 'Comma-separated folder paths; files inside them are excluded from task scanning',
	'modal.excludedExample': 'e.g. System/Templates, Attachments',
	'modal.fixFields': 'Please fix the highlighted fields first',
	'modal.general': 'General',
	'modal.groupDesc': 'Which group this tab belongs to',
	'modal.groupExample': 'e.g. Custom, Project, Team',
	'modal.groupIdDesc': 'Unique identifier of the group (lowercase letters, digits and hyphens only)',
	'modal.groupIdExample': 'e.g. custom-group',
	'modal.groupNoteProperty': 'Note selector property',
	'modal.groupNotePropertyDesc': 'When set, this group shows a dropdown of notes matching this frontmatter property. Tasks queries will use the selected note as query.file.',
	'modal.groupNotePropertyExample': 'e.g. project',
	'modal.groupNoteValues': 'Property values',
	'modal.groupNoteValuesDesc': 'Only show notes whose property contains one of the selected values. Leave empty to match any non-empty value.',
	'modal.groupNoteValuesAny': 'Any non-empty value',
	'modal.groupNoteValuesNone': 'No notes use this property',
	'modal.icon': 'Icon',
	'modal.iconDesc': 'Pick from the dropdown, or search any Obsidian icon name (custom names work too)',
	'modal.iconExample': 'e.g. folder',
	'modal.iconSearch': 'Search icons…',
	'modal.iconUseCustom': 'Use custom icon "{name}"',
	'modal.iconNoMatch': 'No matching icons',
	'modal.idRule': 'Lowercase letters, digits and hyphens only',
	'modal.inboxDesc': 'File path that Quick add writes new tasks to',
	'modal.inboxExample': 'e.g. Inbox.md',
	'modal.label': 'Label',
	'modal.labelDesc': 'The name shown in the interface',
	'modal.labelExample': 'e.g. Inbox, Today, Work',
	'modal.newGroupDialog': 'New group dialog',
	'modal.newTab': 'New tab',
	'modal.newTabDialog': 'New Tab dialog',
	'modal.noTabs': 'No tabs yet — please add one',
	'modal.openFail': 'TaskFlow: failed to open {label} — {msg}',
	'modal.order': 'Order',
	'modal.orderDesc': 'Display order within the same group (smaller number comes first)',
	'modal.orderExample': 'e.g. 1, 2, 3...',
	'modal.query': 'Tasks query',
	'modal.queryDesc': 'Uses the Tasks plugin query syntax',
	'modal.queryPlaceholder': 'e.g. not done\nhas due date\ngroup by filename\nsort by due',
	'modal.renderFail': '⚠ This dialog failed to render',
	'modal.renderFailDetail': 'Render failed: {msg}',
	'modal.saveFail': 'Failed to save: {msg}',
	'modal.saving': 'Saving…',
	'modal.showHeaderDesc': 'Show a heading above the tab content (e.g. "Today", "Todo") together with its task count',
	'modal.tabIdDesc': 'Unique identifier of the tab (cannot be changed)',
	'modal.tabsManage': 'Tabs',
	'modal.unsaved': 'You have unsaved changes',
	'nav.about': 'About',
	'nav.general': 'General',
	'nav.groups': 'Groups',
	'view.group.selectNote': 'Select {group} note',
	'view.group.noMatchingNotes': 'No notes with this property value',
	'view.group.searchNote': 'Search notes…',
	'view.group.favoriteNote': 'Favorite',
	'view.group.unfavoriteNote': 'Unfavorite',
	'view.group.onlyFavorites': 'Favorites only',
	'view.group.limit': 'Limit',
	'view.group.limitDesc': 'Maximum tasks per query in this group (empty uses the query\'s own limit)',
	'panel.collapse': 'Collapse ↑',
	'panel.doneToday': 'Done today',
	'panel.doneWeek': 'Done this week',
	'panel.emptyImportant': 'No tasks match the current filter. Adjust "Important reminder query" in the settings panel.',
	'panel.importantEmpty': 'Nothing needs attention right now',
	'panel.inProgress': 'In progress',
	'panel.more': 'More...',
	'panel.moreCount': 'More ({n})...',
	'panel.todayRate': 'Today',
	'panel.todayTodo': 'Today\'s todos',
	'panel.weekRate': 'This Week',
	'settings.addGroup': 'Add new group',
	'settings.confirm.deleteGroup': 'Delete group "{name}"? All tabs in this group will be deleted as well.',
	'settings.confirm.deleteTab': 'Delete tab "{name}"?',
	'settings.cover.aria': 'Choose banner image',
	'settings.cover.change': 'Change',
	'settings.cover.choose': 'Choose image…',
	'settings.cover.none': 'Not set (using the built-in default banner)',
	'settings.cover.pick': 'Banner image',
	'settings.cover.pickDesc': 'Header banner image, stored as {file}.<ext>. Its location follows Obsidian\'s "Default location for new attachments": pick "In the folder specified below" and it goes into that folder; for the other three options (vault root / same folder as current file / subfolder under it) it is placed in the {dir} folder at the vault root. Swapping images cleans up the old file automatically. If you never set one, the built-in default banner is shown; you can also hover the top-right corner of the banner to change it.',
	'settings.cover.show': 'Show banner',
	'settings.cover.showDesc': 'Whether to show the banner image at the top of the header (the built-in default banner is shown until you add your own). When off, only the workbench name + date & time line shows and the banner area takes no space (the tab list is unaffected).',
	'settings.cover.title': 'Banner',
	'settings.group.idLine': 'ID: {id} · {count} tabs{suffix}',
	'settings.group.tabCount': '{n} tabs',
	'settings.head.sloganDesc': 'The short phrase next to the workbench name; leave empty to show only the workbench name (the built-in default follows the interface language)',
	'settings.head.textDesc': 'Controls whether the text line (workbench name + slogan + date & time on the right) is shown. When off, only the banner area remains; if the banner is off too, the whole header is not rendered.',
	'settings.head.textTitle': 'Show workbench name and date & time',
	'settings.head.title': 'Workbench name / Slogan',
	'settings.head.workbench': 'Workbench name',
	'settings.head.workbenchDesc': 'The large text at the top of the view (default: {def}). Applies on Enter or when focus leaves the field',
	'settings.frontendLimit.show': 'Show the task-limit box on the view',
	'settings.frontendLimit.showDesc': 'When a group has a task limit, whether to show an editable limit box at the top of the view. Off by default; the limit from the group config still applies.',
	'settings.inbox.desc': 'The file Quick add writes new tasks to. Type a file name to search, then click to confirm (nothing is applied until you pick, so typos can\'t slip in)',
	'settings.inbox.placeholder': 'Search for a file name…',
	'settings.inbox.title': 'Inbox file path',
	'settings.lang.desc': 'Follows the Obsidian interface language by default; you can also pin Chinese or English here. Takes effect immediately, no plugin restart needed.',
	'settings.lang.en': 'English',
	'settings.lang.follow': 'Follow system',
	'settings.lang.title': 'Interface language',
	'settings.lang.zh': 'Chinese',
	'settings.newTab': 'New Tab',
	'settings.noTabs': 'No tabs yet',
	'settings.notice': 'After changing settings, disable the plugin and re-enable it for the changes to take effect.',
	'settings.noticeTitle': 'Notice',
	'settings.open.desc': 'Where the view lands when TaskFlow is opened. Both placements adapt to container width: when the right sidebar narrows,',
	'settings.open.desc2': 'Today\'s Overview + Important Reminders stack vertically instead of being squeezed together. Restart the plugin for this to take effect.',
	'settings.open.main': 'Main window',
	'settings.open.sidebar': 'Right sidebar',
	'settings.open.subtitle': 'Main window or right sidebar',
	'settings.open.title': 'Default opening location',
	'settings.panel.important': 'Show Important Reminders',
	'settings.panel.importantDesc': 'Right card: renders "the tasks that deserve your attention most" via the Tasks plugin. Sits side by side with Today\'s Overview, or takes the full row when that is off.',
	'settings.panel.query': 'Important reminder query',
	'settings.panel.queryDesc': 'The query handed to the Tasks plugin verbatim (not one character is changed, TaskFlow injects nothing). Written exactly like a secondary tab\'s query.',
	'settings.panel.title': 'Panels (shown above the quick-add field)',
	'settings.panel.today': 'Show Today\'s Overview',
	'settings.panel.todayDesc': 'Left card: Today\'s todos / Done today / In progress / Overdue / Done this week, plus two completion rings for "Today" and "This Week". How the rate is computed: done in the period ÷ (done in the period + due in the period but still open), so this week always includes today.',
	'settings.showHeader': 'Show heading',
	'settings.stats.categories': 'Expand task categories',
	'settings.stats.categoriesDesc': 'When collapsed, only the progress bar and percentage remain; when expanded, all pills show (overdue / in progress / todo / cancel / done / total). Click the "Statistics" row in the view to toggle it anytime.',
	'settings.stats.title': 'Footer statistics',
	'settings.tab.addToGroup': 'Add a new Tab to {group}',
	'settings.tab.headerToggle': 'Show a section heading above "{label}"',
	'settings.tab.metaLine': 'Query: {query} · Order: {order}',
	'stats.title': 'Statistics',
	'stats.toggleAria': 'Collapse or expand the task category statistics',
	'suggest.noMatch': 'No matching files',
	'toast.configSaved': 'TaskFlow settings saved',
	'toast.bannerRemoveFail': 'Failed to remove banner: ',
	'toast.bannerRemoved': 'Banner removed',
	'toast.bannerSaveFail': 'Failed to save banner: ',
	'toast.bannerUpdated': 'Banner updated',
	'toast.groupCreated': 'Group created',
	'toast.groupDeleted': 'Group deleted',
	'toast.groupUpdated': 'Group updated',
	'toast.headerHidden': 'Heading hidden',
	'toast.headerShown': 'Heading shown',
	'toast.inboxSet': 'Inbox file set',
	'toast.queryReset': 'Restored the default query',
	'toast.queryUpdated': 'Important reminder query updated',
	'toast.sloganUpdated': 'Slogan updated',
	'toast.tabCreated': 'Tab created',
	'toast.tabDeleted': 'Tab deleted',
	'toast.tabUpdated': 'Tab updated',
	'toast.workbenchUpdated': 'Workbench name updated',
	'view.empty.noMatch': 'No tasks match "{label}". Try adding a new task, or check the filter.',
	'view.empty.noTabsInGroup': '{name} has no tabs yet',
	'settings.compact.title': 'Compact mode',
	'settings.compact.hideBanner': 'Hide cover banner when compact',
	'settings.compact.hideBannerDesc': 'Hide the cover image at the top; keep the workbench name and date/time below.',
	'settings.compact.hideTitle': 'Hide workbench name & date/time when compact',
	'settings.compact.hideTitleDesc': 'Hide the workbench name, slogan and the date/time on the right to free space for the task list.',
	'settings.compact.hideTodayOverview': 'Hide Today Overview when compact',
	'settings.compact.hideTodayOverviewDesc': 'Hide the Today Overview ring/stat card.',
	'settings.compact.hideImportantReminders': 'Hide Important Reminders when compact',
	'settings.compact.hideImportantRemindersDesc': 'Hide the Important Reminders card to save vertical space.',
	'settings.compact.hideStats': 'Hide footer stats when compact',
	'settings.compact.hideStatsDesc': 'Hide the footer overdue / in-progress / … category pills to keep the view shorter.',
};

/**
 * 模块一加载就探测一次系统语言，这样连 DEFAULT_TABS 这类模块级常量里的
 * 默认名也能是正确语言（它们在 import 阶段求值，晚于本模块初始化）。
 * 插件随后会用设置项（auto/zh/en）再覆盖一次。
 */
let current: UiLang = detectObsidianLang();

/** 切换当前界面语言（立即生效于后续所有 t() 调用） */
export function setUiLang(lang: UiLang): void {
	current = lang === 'en' ? 'en' : 'zh';
}

export function getUiLang(): UiLang {
	return current;
}

/**
 * 探测 Obsidian 界面语言。
 * 优先使用 Obsidian 官方的 getLanguage()，再回落到浏览器/系统语言，最后兜底中文。
 * 全程 try/catch，测试桩里没有 getLanguage / window 也不会炸。
 */
export function detectObsidianLang(_app?: unknown): UiLang {
	try {
		const lang = getLanguage();
		if (typeof lang === 'string') {
			return lang.toLowerCase().startsWith('zh') ? 'zh' : 'en';
		}
	} catch {
		/* ignore */
	}
	try {
		const nav = typeof window !== 'undefined' ? window.navigator?.language : undefined;
		if (nav) return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en';
	} catch {
		/* ignore */
	}
	// 两条路都拿不到（例如 Node 测试桩里没有 window）时回落中文：
	// 那是插件的原始语言，比莫名其妙变英文更安全。
	return 'zh';
}

/** 把设置项（auto/zh/en）解析成实际使用的语言 */
export function resolveLang(setting: LangSetting | undefined, app?: unknown): UiLang {
	if (setting === 'en') return 'en';
	if (setting === 'zh') return 'zh';
	return detectObsidianLang(app);
}

/**
 * 取一条文案。vars 里的每个键会替换文案中的 "{键}" 占位符。
 * 英文缺失时回落中文，两者都缺时返回 key 本身（便于一眼看出漏翻）。
 */
export function t(key: string, vars?: Record<string, unknown>): string {
	let text = (current === 'en' ? EN[key] : ZH[key]) ?? ZH[key] ?? EN[key] ?? key;
	if (vars) {
		for (const k of Object.keys(vars)) {
			text = text.split('{' + k + '}').join(String(vars[k]));
		}
	}
	return text;
}

/**
 * 内置 slogan 的**全部历史取值**（两种语言都算）。
 *
 * 用途：slogan 是存在用户数据里的具体字符串，一旦存下来就与界面语言脱钩 ——
 * 安装时选了中文的用户，切到英文界面仍会看到中文 slogan。所以判断「这个值是不是
 * 用户自己写的」：只要等于任一历史内置默认值，就当作"没自定义过"，渲染时按
 * 当前语言重新取默认值；只有用户真正改过的文本才原样保留。
 *
 * 更换默认 slogan 时：把**旧值**追加进这个数组（新值由 'default.slogan' 提供），
 * 否则老用户会一直卡在旧默认文案上。`view/entry-i18n.ts` 有断言守着这条。
 */
export const BUILTIN_SLOGANS: string[] = [
	'让任务像水一样流动',
	'Let tasks flow like water',
	'从管理任务，到选择行动。',
	'From managing tasks to choosing action.',
];

/** 这个 slogan 是不是内置默认值（而非用户自定义） */
export function isBuiltinSlogan(value: string | null | undefined): boolean {
	return BUILTIN_SLOGANS.includes(String(value ?? '').trim());
}

/**
 * 内置 tab 的 id → i18n key 映射。
 *
 * 默认 tab 的 label 在「首次运行」时按当时语言写进用户数据（data.globalTabs），
 * 之后切语言也不会跟着变 —— 这就是英文界面下二级 tab 名仍显示中文的根因。
 * 所以在渲染时按 id 重新取本地化名字：自定义 tab（id 不在这张表里）原样用存盘的 label。
 * 视图与设置面板共用本函数，保证英文界面下二级 tab 名也是英文、且中英一致。
 */
export const BUILTIN_TAB_I18N: Record<string, string> = {
	'gtd-inbox': 'defaultTab.inbox',
	'gtd-next': 'defaultTab.next',
	'gtd-waiting': 'defaultTab.waiting',
	'gtd-someday': 'defaultTab.someday',
	'time-overdue': 'defaultTab.overdue',
	'time-today': 'defaultTab.today',
	'time-tomorrow': 'defaultTab.tomorrow',
	'time-week': 'defaultTab.week',
	'time-month': 'defaultTab.month',
	'tag-work': 'defaultTab.work',
	'tag-life': 'defaultTab.life',
};

/** 渲染时按当前语言取 tab 名；内置 tab 跟随语言，自定义 tab 用存盘 label */
export function localizedTabLabel(tab: { id: string; label: string }): string {
	const key = BUILTIN_TAB_I18N[tab.id];
	return key ? t(key) : tab.label;
}
