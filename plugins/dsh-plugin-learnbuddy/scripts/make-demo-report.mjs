/**
 * 生成演示用的「真实原件」报告（DOCX，含真实 PNG 插图）
 *
 * 为什么需要它：演示数据里多数提交走 sampleKey 样例（fixture），
 * 真实解析链路在界面上看不到效果。本脚本造一份**内容固定**的 DOCX 并落盘到
 * 上传目录；其内容哈希即 schema.js 中 `sub-xu-db` 的 blobId。
 *
 * ⚠️ 改动本脚本的正文或图片会让哈希变化，届时需同步更新：
 *    - `src/db/schema.js` 里 DEFAULT_SUBMISSIONS 中 sub-xu-db 的 blobId
 *    - 根目录 `.gitignore` 中 uploads 白名单的文件名
 *
 * 用法：node scripts/make-demo-report.mjs
 */
import { StorageService } from "../src/services/storage.js";
import { buildDocx } from "./lib/doc-fixtures.mjs";
import { renderTextPng } from "./lib/png-text.mjs";

// 字体表只收录字母数字与空格，图片文字请勿使用其它符号
const shotPlan = renderTextPng("EXPLAIN index scan type ref");
const shotBenchmark = renderTextPng("QPS 8600 latency 4ms rows 1200");

const docx = buildDocx({
  paragraphs: [
    "实验目的",
    "理解 B+ 树索引对查询执行计划的影响，并通过执行计划与压测数据核验索引是否真正生效。",
    "实验环境与操作记录",
    "在本地实例上创建测试库与示例表，写入约二十万行数据，分别在建索引前后执行同一组查询。",
    "使用 EXPLAIN 查看执行计划，记录访问类型、命中行数与预估代价三项关键指标，并保存查询前后的对照截图。",
    "实验结果与图表",
    "建索引后访问类型由全表扫描变为索引查找，扫描行数从二十万降至约一千二百行，查询耗时同步下降。",
    "随附执行计划截图与压测结果图各一张，可用于核对上述指标。",
    "现象解释与分析",
    "覆盖索引避免了回表，是行数与耗时同时下降的主要原因；写入侧代价上升，说明索引并非越多越好。",
    "选择性不足的列上建索引收益有限，需结合基数与查询模式综合判断。",
    "总结",
    "本次实验完整复现了索引对执行计划的影响，结论可由执行计划与压测数据复现。"
  ],
  images: [
    { name: "shot-explain.png", data: shotPlan },
    { name: "shot-benchmark.png", data: shotBenchmark }
  ]
});

const storage = new StorageService();
const saved = await storage.saveFile(docx, "索引实验报告_许然.docx");

console.log("演示报告已生成：");
console.log("  fileId :", saved.fileId);
console.log("  路径   :", saved.filePath);
console.log("  大小   :", saved.size, "字节");
console.log();
console.log("若 fileId 与 schema.js 中 sub-xu-db 的 blobId 不一致，请同步更新（含 .gitignore 白名单）。");
