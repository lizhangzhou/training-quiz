import { readFile } from "node:fs/promises";

const questions = JSON.parse(await readFile(new URL("../src/questions.json", import.meta.url), "utf8"));
const allowedTypes = new Set(["单选题", "多选题", "判断题", "简答题"]);
const errors = [];
const ids = new Set();

for (const [index, item] of questions.entries()) {
  const position = index + 1;
  if (item.id !== position) errors.push(`第 ${position} 条题目 id 应为 ${position}，实际为 ${item.id}`);
  if (ids.has(item.id)) errors.push(`题目 id 重复：${item.id}`);
  ids.add(item.id);
  if (!allowedTypes.has(item.type)) errors.push(`题目 ${item.id} 类型不合法：${item.type}`);
  if (!String(item.category || "").trim()) errors.push(`题目 ${item.id} 缺少分类`);
  if (!String(item.question || "").trim()) errors.push(`题目 ${item.id} 缺少题干`);

  const optionKeys = new Set((item.options || []).map(option => option.key));
  if (["单选题", "多选题", "判断题"].includes(item.type) && optionKeys.size < 2) {
    errors.push(`题目 ${item.id} 缺少有效选项`);
  }
  const answers = Array.isArray(item.answer) ? item.answer : [item.answer];
  if (item.type !== "简答题" && answers.some(answer => !optionKeys.has(answer))) {
    errors.push(`题目 ${item.id} 的答案不在选项中：${answers.join(",")}`);
  }
  if (item.type === "单选题" && answers.length !== 1) errors.push(`题目 ${item.id} 的单选答案数量不为 1`);
  if (item.type === "多选题" && answers.length < 2) errors.push(`题目 ${item.id} 的多选答案少于 2 个`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

const typeCounts = Object.fromEntries(
  [...allowedTypes].map(type => [type, questions.filter(item => item.type === type).length]),
);
const categoryCount = new Set(questions.map(item => item.category)).size;
console.log(`题库校验通过：${questions.length} 道题，${categoryCount} 个分类。`);
console.log(typeCounts);
