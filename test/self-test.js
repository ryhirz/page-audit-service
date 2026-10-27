/**
 * self-test.js —— 巡检逻辑的回归断言
 *
 * 思路：用两个极端样本把每条检测逼出来。
 * bad.html 每项都故意做错，good.html 每项都做对；
 * 如果 bad 的指标抓不到、或 good 出现误报，说明检测逻辑写坏了。
 * 跑法：node test/self-test.js
 */
import { auditBatch, closeBrowser } from '../auditor.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const badUrl = 'file:///' + join(here, 'fixtures/bad.html').replace(/\\/g, '/');
const goodUrl = 'file:///' + join(here, 'fixtures/good.html').replace(/\\/g, '/');

let pass = 0;
const fails = [];

function check(cond, msg, detail = '') {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${msg}`);
  } else {
    fails.push(msg + (detail ? ` —— 实际 ${detail}` : ''));
    console.log(`  [FAIL] ${msg}${detail ? ` —— 实际 ${detail}` : ''}`);
  }
}

console.log('巡检逻辑自测\n');

const [bad, good] = await auditBatch([badUrl, goodUrl], { concurrency: 2, timeout: 20000 });

console.log('[ bad.html 全错样本 ]');
check(bad.ok === true, '页面可访问', bad.error);
check(bad.imgTotal === 3, '图片总数 = 3', bad.imgTotal);
check(bad.imgMissingAlt === 2, '缺 alt 图片 = 2', bad.imgMissingAlt);
check(bad.headingCounts.h1 === 2, 'H1 数量 = 2（应判重复）', bad.headingCounts.h1);
check(bad.inputTotal === 2, '表单字段 = 2', bad.inputTotal);
check(bad.inputNoName === 2, '缺 name 字段 = 2', bad.inputNoName);
check(bad.targetBlankNoRel === 1, '缺 noopener 的外链 = 1', bad.targetBlankNoRel);
check(bad.mobileOverflow === true, '移动端横向溢出 = true', bad.mobileOverflow);
check(bad.consoleErrors.length >= 1, '采集到控制台报错', bad.consoleErrors.length);
check(bad.metaDescription === '', 'meta description 为空', JSON.stringify(bad.metaDescription));
check(bad.issues.some((i) => i.includes('H1 重复')), '问题清单含「H1 重复」', bad.issues.join('|'));
check(bad.issues.some((i) => i.includes('缺 alt')), '问题清单含「缺 alt」', bad.issues.join('|'));
check(bad.issues.some((i) => i.includes('横向溢出')), '问题清单含「横向溢出」', bad.issues.join('|'));
check(bad.issues.some((i) => i.includes('noopener')), '问题清单含「noopener」', bad.issues.join('|'));
check(bad.score < 60, '健康分 < 60', bad.score);

console.log('\n[ good.html 全对样本 ]');
check(good.ok === true, '页面可访问', good.error);
check(good.imgTotal === 2, '图片总数 = 2', good.imgTotal);
check(good.imgMissingAlt === 0, '缺 alt 图片 = 0（无误报）', good.imgMissingAlt);
check(good.headingCounts.h1 === 1, 'H1 数量 = 1', good.headingCounts.h1);
check(good.inputNoName === 0, '缺 name 字段 = 0', good.inputNoName);
check(good.targetBlankNoRel === 0, '缺 noopener 外链 = 0', good.targetBlankNoRel);
check(good.mobileOverflow === false, '无横向溢出（无误报）', good.mobileOverflow);
check(good.consoleErrors.length === 0, '无控制台报错', good.consoleErrors.length);
check(good.title.length > 0, 'title 非空', good.title);
check(good.metaDescription.length > 0, 'meta description 非空', good.metaDescription);
check(good.linkExternal === 1, '外链计数 = 1', good.linkExternal);
check(good.score >= 95, '健康分 >= 95', good.score);
check(good.issues.length === 0, '问题清单为空', good.issues.join('|'));

await closeBrowser();

console.log(`\n结果：${pass} 项通过，${fails.length} 项失败`);
if (fails.length) {
  console.log('失败项：');
  fails.forEach((f) => console.log('  -', f));
  process.exit(1);
}
