import type { FlowDocument, PluginManifest } from "./types";

export const plugins: PluginManifest[] = [
  {
    id: "folder",
    name: "系统文件夹",
    description: "在系统文件管理器中打开项目目录",
    actions: [{ id: "open", label: "打开所在文件夹" }],
  },
  {
    id: "research-reader",
    name: "Research Reader",
    description: "预览 Markdown、PDF、DOCX 和源码文件",
    executable: "E:/qq_codex/research/Research-Link-Reader-Windows-x64.exe",
    actions: [{ id: "open", label: "用 Research Reader 打开", extensions: ["md", "markdown", "pdf", "docx", "html", "py", "r"] }],
  },
  {
    id: "sql-viewer",
    name: "SQL Viewer",
    description: "查询 CSV、Parquet、JSON 和 DuckDB 数据",
    executable: "SQL Viewer.exe",
    actions: [{ id: "open", label: "用 SQL Viewer 打开", extensions: ["csv", "tsv", "parquet", "json", "duckdb", "db"] }],
  },
];

export const demoFlow: FlowDocument = {
  schemaVersion: 1,
  name: "研究流程 · 可复现分析",
  nodes: [
    {
      id: "project-input",
      type: "flow",
      position: { x: 70, y: 150 },
      data: {
        kind: "project", title: "原始数据项目", path: "E:/research/raw-data", summary: "采集与清洗后的原始数据目录",
        input: "问卷 CSV、实验记录", output: "clean.parquet", conclusion: "数据已完成字段统一和缺失值标记",
        process: "读取 raw/ 下的 CSV，按 data-dictionary.md 统一列名，保留审计日志。", references: "data-dictionary.md\ncleaning-notes.md", pluginId: "folder", status: "success",
      },
    },
    {
      id: "operation-model",
      type: "flow",
      position: { x: 430, y: 90 },
      data: {
        kind: "operation", title: "运行统计模型", path: "E:/research/model", summary: "对清洗数据执行预注册模型",
        input: "clean.parquet", output: "model-summary.csv", conclusion: "模型估计完成，等待稳健性检查",
        process: "先运行 scripts/fit_model.R，再检查 stdout 中的收敛状态。", references: "analysis-plan.md\nscripts/fit_model.R", pluginId: "sql-viewer", status: "running",
      },
    },
    {
      id: "artifact-result",
      type: "flow",
      position: { x: 800, y: 150 },
      data: {
        kind: "artifact", title: "结果与图表", path: "E:/research/results", summary: "供报告引用的结果产物",
        input: "model-summary.csv", output: "figure-01.pdf\nreport.md", conclusion: "主效应方向与预期一致，需补充敏感性分析",
        process: "读取模型摘要，生成图表，并将每个数字回链到原始数据和脚本。", references: "report.md\nfigure-01.pdf", pluginId: "research-reader", status: "idle",
      },
    },
    {
      id: "reference-plan",
      type: "flow",
      position: { x: 430, y: 390 },
      data: {
        kind: "reference", title: "预注册方案", path: "E:/research/docs/analysis-plan.md", summary: "定义假设、变量和停止规则",
        input: "研究问题", output: "模型约束与解释边界", conclusion: "所有分析必须保留计划外探索标记",
        process: "作为每条处理边的约束参考，不直接生成执行命令。", references: "protocol.pdf", pluginId: "research-reader", status: "success",
      },
    },
  ],
  edges: [
    {
      id: "edge-input-model", source: "project-input", target: "operation-model", type: "flow", animated: true,
      data: { relation: "transforms", instruction: "将 clean.parquet 注册为只读数据源，先执行字段和行数校验，再运行预注册模型。", expectedOutput: "model-summary.csv", evidence: "logs/validation.txt", runPolicy: "confirm" },
    },
    {
      id: "edge-model-result", source: "operation-model", target: "artifact-result", type: "flow",
      data: { relation: "supports", instruction: "把模型摘要交给结果项目生成图表；图表中的每个统计量必须保留来源列和脚本版本。", expectedOutput: "figure-01.pdf 与 report.md", evidence: "manifest.json", runPolicy: "manual" },
    },
    {
      id: "edge-plan-model", source: "reference-plan", target: "operation-model", type: "flow",
      data: { relation: "depends_on", instruction: "用预注册方案校验变量、协变量和停止规则；不符合时只报告问题，不自动修改模型。", expectedOutput: "validation report", evidence: "logs/plan-check.txt", runPolicy: "confirm" },
    },
  ],
};
