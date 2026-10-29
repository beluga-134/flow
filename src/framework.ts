import template from "./framework-template.json";
import type { FlowDocument, FlowEdge, FlowNode, FlowNodeData, FlowStage, NodeKind } from "./types";

export const frameworkModules = template.modules;
export const frameworkStages = template.stages;
export const stageLabels: Record<FlowStage, string> = {
  research: "调研", test: "测试", execute: "执行", conclusion: "结果与结论", formal: "正式", review: "复核",
};

export function joinWorkspacePath(root: string, value: string): string {
  const clean = value.trim().replace(/^['"]|['"]$/g, "");
  if (!clean || /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(clean) || !root) return clean;
  const separator = /^[a-zA-Z]:|^\\\\/.test(root) ? "\\" : "/";
  return `${root.replace(/[\\/]$/, "")}${separator}${clean.replace(/[/\\]/g, separator)}`;
}

function frameworkEdge(source: string, target: string, instruction: string): FlowEdge {
  return {
    id: `${source}--${target}`, source, target, type: "flow", sourceHandle: "out", targetHandle: "in",
    data: { relation: "depends_on", instruction, expectedOutput: "", evidence: "", runPolicy: "manual" },
  };
}

const parallelStageIds = frameworkStages.filter((stage) => stage.id !== "conclusion").map((stage) => stage.id);

function frameworkPosition(moduleIndex: number, stageId?: string) {
  const moduleX = moduleIndex * 1080;
  if (!stageId) return { x: moduleX, y: 340 };
  if (stageId === "conclusion") return { x: moduleX + 720, y: 340 };
  const parallelIndex = parallelStageIds.indexOf(stageId);
  return { x: moduleX + 360, y: 40 + Math.max(parallelIndex, 0) * 300 };
}

function frameworkTopologyEdges(): FlowEdge[] {
  const edges: FlowEdge[] = [];
  for (const [moduleIndex, module] of frameworkModules.entries()) {
    const moduleNodeId = `framework-${module.id}`;
    const conclusionId = `${moduleNodeId}-conclusion`;
    for (const stageId of parallelStageIds) {
      const stageNodeId = `${moduleNodeId}-${stageId}`;
      edges.push(frameworkEdge(moduleNodeId, stageNodeId, `并行开展${stageLabels[stageId as FlowStage]}`));
      edges.push(frameworkEdge(stageNodeId, conclusionId, "汇入模块结果与结论"));
    }
    const previousModule = frameworkModules[moduleIndex - 1];
    if (previousModule) edges.push(frameworkEdge(`framework-${previousModule.id}-conclusion`, moduleNodeId, "上游模块结论"));
  }
  return edges;
}

function legacyFrameworkEdgeIds(): Set<string> {
  const edgeIds = new Set<string>();
  for (const [moduleIndex, module] of frameworkModules.entries()) {
    const moduleNodeId = `framework-${module.id}`;
    for (const [stageIndex, stage] of frameworkStages.entries()) {
      const previousStage = frameworkStages[stageIndex - 1];
      if (previousStage) edgeIds.add(`${moduleNodeId}-${previousStage.id}--${moduleNodeId}-${stage.id}`);
      else {
        edgeIds.add(`${moduleNodeId}--${moduleNodeId}-${stage.id}`);
        const previousModule = frameworkModules[moduleIndex - 1];
        if (previousModule) edgeIds.add(`framework-${previousModule.id}-conclusion--${moduleNodeId}-${stage.id}`);
      }
    }
  }
  return edgeIds;
}

function legacySerialEdgeIds(): Set<string> {
  const edgeIds = new Set<string>();
  for (const module of frameworkModules) {
    const moduleNodeId = `framework-${module.id}`;
    for (let stageIndex = 1; stageIndex < frameworkStages.length; stageIndex += 1) {
      edgeIds.add(`${moduleNodeId}-${frameworkStages[stageIndex - 1].id}--${moduleNodeId}-${frameworkStages[stageIndex].id}`);
    }
  }
  return edgeIds;
}

export function createFramework(name: string): FlowDocument {
  const nodes: FlowNode[] = [];
  for (const [moduleIndex, module] of frameworkModules.entries()) {
    const moduleNodeId = `framework-${module.id}`;
    nodes.push({
      id: moduleNodeId, type: "flow", position: frameworkPosition(moduleIndex),
      data: {
        kind: "project", title: module.title, path: `.flow-canvas/artifacts/${module.id}`, summary: module.goal, goal: module.goal,
        input: "", output: `.flow-canvas/artifacts/${module.id}/result.md\n.flow-canvas/artifacts/${module.id}/conclusion.md`, process: "", result: "", conclusion: "", references: "",
        status: "idle", aiMode: "off", frameworkRole: "module", moduleId: module.id,
      },
    });
    for (const stage of frameworkStages) {
      const stageId = `${moduleNodeId}-${stage.id}`;
      const directory = `${stage.directory}/${module.id}`;
      const previousModule = frameworkModules[moduleIndex - 1];
      const input = stage.id === "conclusion"
        ? parallelStageIds.map((parallelStageId) => `${frameworkStages.find((item) => item.id === parallelStageId)?.directory}/${module.id}/conclusion.md`).join("\n")
        : previousModule ? `conclusion/${previousModule.id}/conclusion.md` : "";
      nodes.push({
        id: stageId, type: "flow", position: frameworkPosition(moduleIndex, stage.id),
        data: {
          kind: stage.kind as NodeKind, title: `${module.title} · ${stage.title}`, path: directory,
          summary: stage.goal, goal: stage.goal, input, output: `${directory}/result.md\n${directory}/conclusion.md`,
          process: stage.process, references: "", result: "", conclusion: "", status: "idle", aiMode: "off",
          frameworkRole: "stage", moduleId: module.id, parentNodeId: moduleNodeId, stage: stage.id as FlowStage,
          pluginId: "folder",
        },
      });
    }
  }
  return { schemaVersion: 1, name: `${name} 工作流`, nodes, edges: frameworkTopologyEdges(), files: [], activities: [] };
}

export function migrateFrameworkTopology(document: FlowDocument): FlowDocument {
  const legacyEdgeIds = legacyFrameworkEdgeIds();
  const serialEdgeIds = legacySerialEdgeIds();
  if (!document.edges.some((edge) => serialEdgeIds.has(edge.id))) return document;
  const templateFlow = createFramework(document.name);
  const frameworkNodeIds = new Set(templateFlow.nodes.map((node) => node.id));
  const retainedEdges = document.edges.filter((edge) => !legacyEdgeIds.has(edge.id));
  const retainedEdgeIds = new Set(retainedEdges.map((edge) => edge.id));
  return {
    ...document,
    nodes: document.nodes.map((node) => {
      if (!frameworkNodeIds.has(node.id)) return node;
      const templateNode = templateFlow.nodes.find((item) => item.id === node.id);
      return templateNode ? { ...node, position: templateNode.position } : node;
    }),
    edges: [...retainedEdges, ...templateFlow.edges.filter((edge) => !retainedEdgeIds.has(edge.id))],
  };
}

export function appendFramework(document: FlowDocument): FlowDocument {
  const templateFlow = createFramework(document.name);
  const existingIds = new Set(document.nodes.map((node) => node.id));
  const newNodes = templateFlow.nodes.filter((node) => !existingIds.has(node.id));
  const hasFramework = document.nodes.some((node) => node.data.frameworkRole);
  const offset = hasFramework || !document.nodes.length ? 0 : Math.max(...document.nodes.map((node) => node.position.y)) + 380;
  const existingEdges = new Set(document.edges.map((edge) => `${edge.source}--${edge.target}`));
  return {
    ...document,
    nodes: [...document.nodes, ...newNodes.map((node) => ({ ...node, position: { ...node.position, y: node.position.y + offset } }))],
    edges: [...document.edges, ...templateFlow.edges.filter((edge) => !existingEdges.has(`${edge.source}--${edge.target}`))],
  };
}

export function effectiveAiMode(data: FlowNodeData) {
  return data.aiMode ?? "auto";
}

export function nodeRunBlocker(data: FlowNodeData): string | null {
  if (data.pruned) return "此节点已剪枝，请先恢复节点。";
  if (data.status === "running" || data.agentStatus === "opening") return "当前节点正在运行，请等待完成或先中断。";
  if (effectiveAiMode(data) === "off") return "此节点未接入 AI，可填写结果与结论后记录完成。";
  if (!(data.goal ?? data.summary).trim()) return "请先填写节点目标。";
  return null;
}

export function buildNodePrompt(node: FlowNode, nodes: FlowNode[], edges: FlowEdge[], inheritedInput: string): string {
  const parent = nodes.find((item) => item.id === node.data.parentNodeId);
  const predecessors = edges.filter((edge) => edge.target === node.id).map((edge) => nodes.find((item) => item.id === edge.source)).filter((item): item is FlowNode => !!item && !item.data.pruned);
  const successors = edges.filter((edge) => edge.source === node.id).map((edge) => nodes.find((item) => item.id === edge.target)).filter((item): item is FlowNode => !!item && !item.data.pruned);
  return [
    "你正在由 Flow Canvas 执行一个节点。先读取工作区内 .flow-canvas/flow.json，理解完整流程和当前节点职责。",
    `当前节点 ID：${node.id}\n当前节点：${node.data.title}`,
    `节点目标：${node.data.goal ?? node.data.summary}`,
    parent ? `所属模块：${parent.data.title}\n模块目标：${parent.data.goal ?? parent.data.summary}` : "",
    `当前阶段：${node.data.stage ? stageLabels[node.data.stage] : "自定义任务"}`,
    `节点工作目录（相对路径以工作区为根）：${node.data.path || "."}`,
    `节点处理方式：${node.data.process || "按节点目标处理"}`,
    `输入：\n${node.data.input || inheritedInput || "未指定"}`,
    `连接处理说明：\n${edges.filter((edge) => edge.target === node.id && predecessors.some((item) => item.id === edge.source)).map((edge) => edge.data.instruction).join("\n") || "未指定"}`,
    `前置节点：${predecessors.map((item) => `${item.data.title}；输出：${item.data.output || "无"}；结论：${item.data.conclusion || "未填写"}`).join("\n") || "无"}`,
    `后续节点：${successors.map((item) => item.data.title).join("；") || "无"}`,
    `参考：\n${node.data.references || "未指定"}`,
    `期望输出：\n${node.data.output || "将结果与结论保存到节点工作目录"}`,
    "在节点目录中保存 UTF-8 编码的 result.md 和 conclusion.md，供 Flow 读取。",
    effectiveAiMode(node.data) === "assist" ? "AI 模式：辅助。仅开展调研、解释和提出方案，可以在节点目录保存建议文档；不得执行分析脚本或改写分析数据。" : "AI 模式：执行。仅完成当前节点目标，不自动执行其他节点，不修改已确认的分析方法。",
    "所有文件操作均限制在当前工作区，当前节点产物写入指定目录。先读取并遵循工作区内适用的 AGENTS.md 和用户指令。不要提交或推送 Git。完成时分别给出节点结果、结论、产物路径和未解决问题。",
    "需要人工输入或确认时，在独立行输出 NEED_USER_INPUT: 后跟原因并停止等待。成功完成本节点后在独立行输出 FLOW_NODE_DONE。",
  ].filter(Boolean).join("\n\n");
}
