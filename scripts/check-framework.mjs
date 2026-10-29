import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const frameworkUrl = new URL("../src/framework.ts", import.meta.url);
const source = readFileSync(frameworkUrl, "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const exported = {};
new Function("require", "exports", compiled)(createRequire(fileURLToPath(frameworkUrl)), exported);
const { createFramework, appendFramework, buildNodePrompt, migrateFrameworkTopology, nodeRunBlocker, joinWorkspacePath } = exported;

test("framework forms five serial modules with parallel work branches", () => {
  const graph = createFramework("项目");
  assert.equal(graph.nodes.length, 25);
  const stages = graph.nodes.filter((node) => node.data.frameworkRole === "stage");
  assert.equal(stages.length, 20);
  assert.equal(new Set(stages.map((node) => node.data.path)).size, 20);
  for (const node of stages) {
    assert.ok(graph.nodes.some((parent) => parent.id === node.data.parentNodeId));
    assert.match(node.data.output, new RegExp(node.data.path + "/result.md"));
    assert.equal(node.data.aiMode, "off");
  }
  assert.ok(stages.some((node) => node.data.path === "excute/analysis"));
  assert.ok(graph.edges.every((edge) => graph.nodes.some((node) => node.id === edge.source) && graph.nodes.some((node) => node.id === edge.target)));
  for (const module of graph.nodes.filter((node) => node.data.frameworkRole === "module")) {
    const moduleStages = stages.filter((node) => node.data.parentNodeId === module.id);
    const conclusion = moduleStages.find((node) => node.data.stage === "conclusion");
    const parallelStages = moduleStages.filter((node) => node.data.stage !== "conclusion");
    assert.equal(parallelStages.length, 3);
    assert.ok(conclusion);
    for (const stage of parallelStages) {
      assert.ok(graph.edges.some((edge) => edge.source === module.id && edge.target === stage.id));
      assert.ok(graph.edges.some((edge) => edge.source === stage.id && edge.target === conclusion.id));
    }
    assert.ok(!graph.edges.some((edge) => edge.source === parallelStages[0].id && edge.target === parallelStages[1].id));
  }
  const incoming = new Map(graph.nodes.map((node) => [node.id, graph.edges.filter((edge) => edge.target === node.id).length]));
  const ready = graph.nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
  let visited = 0;
  while (ready.length) {
    const nodeId = ready.shift();
    visited += 1;
    for (const edge of graph.edges.filter((edge) => edge.source === nodeId)) {
      incoming.set(edge.target, incoming.get(edge.target) - 1);
      if (incoming.get(edge.target) === 0) ready.push(edge.target);
    }
  }
  assert.equal(visited, graph.nodes.length);
});

test("legacy generated chains migrate without changing node content or custom edges", () => {
  const graph = createFramework("项目");
  const design = graph.nodes.find((node) => node.id === "framework-design");
  design.data.goal = "保留用户目标";
  graph.edges = [
    { id: "framework-design--framework-design-research", source: "framework-design", target: "framework-design-research", data: {} },
    { id: "framework-design-research--framework-design-test", source: "framework-design-research", target: "framework-design-test", data: {} },
    { id: "custom-edge", source: "framework-design-test", target: "framework-design-execute", data: {} },
  ];
  const migrated = migrateFrameworkTopology(graph);
  assert.equal(migrated.nodes.find((node) => node.id === "framework-design").data.goal, "保留用户目标");
  assert.ok(migrated.edges.some((edge) => edge.id === "custom-edge"));
  assert.ok(!migrated.edges.some((edge) => edge.id === "framework-design-research--framework-design-test"));
  assert.ok(migrated.edges.some((edge) => edge.id === "framework-design-test--framework-design-conclusion"));
});

test("adding the framework is idempotent and retains custom goals, pruning and legacy work", () => {
  const graph = createFramework("项目");
  graph.nodes[1].data.goal = "用户指定的目标";
  graph.nodes[1].data.pruned = true;
  graph.nodes[1].data.result = "已有结果";
  assert.deepEqual(appendFramework(graph), graph);
  const legacy = { schemaVersion: 1, name: "旧项目", nodes: [{ id: "legacy", position: { x: 1, y: 2 }, data: { title: "保留" } }], edges: [], files: [{ path: "existing.csv" }], activities: [] };
  const upgraded = appendFramework(legacy);
  assert.deepEqual(upgraded.nodes[0], legacy.nodes[0]);
  assert.equal(upgraded.nodes.length, 26);
  assert.deepEqual(appendFramework(upgraded), upgraded);
  assert.deepEqual(upgraded.files, legacy.files);
});

test("AI launch respects node opt-out, pruning, running and explicit empty goals", () => {
  const data = createFramework("项目").nodes[1].data;
  assert.ok(nodeRunBlocker(data));
  assert.equal(nodeRunBlocker({ ...data, aiMode: "auto" }), null);
  assert.ok(nodeRunBlocker({ ...data, aiMode: "auto", pruned: true }));
  assert.ok(nodeRunBlocker({ ...data, aiMode: "auto", status: "running" }));
  assert.ok(nodeRunBlocker({ ...data, aiMode: "auto", goal: "" }));
  assert.equal(nodeRunBlocker({ ...data, aiMode: undefined, goal: undefined }), null);
});

test("prompts carry user goals, module context, references, connections and explicit input", () => {
  const graph = createFramework("项目");
  const node = graph.nodes.find((item) => item.id === "framework-analysis-test");
  node.data.goal = "比较两种方法的误差";
  node.data.input = "selected.csv";
  node.data.references = "method-notes.md";
  node.data.aiMode = "assist";
  const prompt = buildNodePrompt(node, graph.nodes, graph.edges, "inherited.csv");
  for (const expected of ["比较两种方法的误差", "所属模块：分析", "selected.csv", "method-notes.md", "并行开展测试", "不得执行分析脚本", "result.md", "不要提交或推送 Git"]) assert.ok(prompt.includes(expected));
  assert.ok(!prompt.includes("输入：\ninherited.csv"));
});

test("workspace path joining supports Windows, POSIX and explicit absolute paths", () => {
  assert.equal(joinWorkspacePath("E:\\work", "research/design"), "E:\\work\\research\\design");
  assert.equal(joinWorkspacePath("/tmp/work", "test/analysis"), "/tmp/work/test/analysis");
  assert.equal(joinWorkspacePath("/tmp/work", "/tmp/other"), "/tmp/other");
});
