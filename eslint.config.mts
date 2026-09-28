import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores } from 'eslint/config';

export default tseslint.config(
	globalIgnores([
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		// scripts/ 下是独立的 Node 工具脚本（CI 校验用），不在 tsconfig 的类型项目内，
		// 而 obsidianmd 的部分规则需要类型信息，会直接抛错。故整体排除。
		'scripts',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				project: './tsconfig.json',
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// 项目级微调：
		// - sentence-case 与品牌名「TaskFlow」冲突（规则会把 TaskFlow 改成 Taskflow），关闭以免误伤 UI 文案。
		// - prefer-active-doc 仅影响 popout 窗口兼容，且测试桩未定义 activeDocument，关闭避免误改/测不过。
		rules: {
			'obsidianmd/ui/sentence-case': 'off',
			'obsidianmd/prefer-active-doc': 'off',
		},
	},
);
