#!/usr/bin/env node
/**
 * 轻量 i18n 对称检查：断言 src/i18n.ts 的 ZH / EN 两张扁平表的 key 集合完全一致。
 *
 * 零依赖：直接读源码文本 + 正则提取（两表均为 Record<string, string> 扁平对象，
 * 每一行形如  'some.key': 'value',  或  "some.key": "value"）。
 *
 * 退出码：一致 = 0；key 不对称 = 1；结构解析失败（表块找不到）= 2。
 * 设计为可在本地 `npm run check:i18n` 与 CI 中复用。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const I18N_PATH = resolve(__dirname, '../src/i18n.ts');

/** 从一块扁平表文本里提取所有 key（保留重复，便于后面查重） */
function extractKeys(block) {
	const re = /^\s*['"]([^'"]+)['"]\s*:/gm;
	const keys = [];
	let m;
	while ((m = re.exec(block)) !== null) keys.push(m[1]);
	return keys;
}

/** 定位 `const NAME: Record<string, string> = { ... \n};` 这种扁平块 */
function extractBlock(src, name) {
	const re = new RegExp('const ' + name + '[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};', 'm');
	const m = src.match(re);
	if (!m) {
		console.error(`[check-i18n] 找不到 ${name} 表块（i18n.ts 结构是否已变更？）`);
		process.exit(2);
	}
	return m[1];
}

/** 去重成 Set，同时收集重复 key */
function analyze(arr) {
	const set = new Set(arr);
	const seen = new Set();
	const dupes = arr.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
	return { set, dupes };
}

const src = readFileSync(I18N_PATH, 'utf8');
const zhObj = analyze(extractKeys(extractBlock(src, 'ZH')));
const enObj = analyze(extractKeys(extractBlock(src, 'EN')));

let ok = true;

if (zhObj.dupes.length) {
	console.error(`[check-i18n] ZH 表内重复 key（${zhObj.dupes.length}）：${[...new Set(zhObj.dupes)].join(', ')}`);
}
if (enObj.dupes.length) {
	console.error(`[check-i18n] EN 表内重复 key（${enObj.dupes.length}）：${[...new Set(enObj.dupes)].join(', ')}`);
}

const onlyZh = [...zhObj.set].filter((k) => !enObj.set.has(k)).sort();
const onlyEn = [...enObj.set].filter((k) => !zhObj.set.has(k)).sort();

if (onlyZh.length) {
	ok = false;
	console.error(`[check-i18n] 仅存在于 ZH、EN 缺失的 key（${onlyZh.length}）：`);
	for (const k of onlyZh) console.error('  - ' + k);
}
if (onlyEn.length) {
	ok = false;
	console.error(`[check-i18n] 仅存在于 EN、ZH 缺失的 key（${onlyEn.length}）：`);
	for (const k of onlyEn) console.error('  - ' + k);
}

if (ok) {
	console.log(`[check-i18n] OK — ZH 与 EN 表 key 集合一致，共 ${zhObj.set.size} 个 key。`);
	process.exit(0);
} else {
	console.error('[check-i18n] 失败：ZH 与 EN 表 key 不对称，请在合并前补齐缺失翻译（新增文案须 ZH + EN 双写）。');
	process.exit(1);
}
