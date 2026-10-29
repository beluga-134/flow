/**
 * canvas-document.ts — JSON Canvas(.canvas)→ FlowDocument 转换器
 *
 * 纯函数、零 DOM 依赖,文档模式(document-mode.tsx)的数据入口。
 * 映射约定:
 *   text  → kind "note"(title 取首行,正文入 summary/goal)
 *   file  → kind "artifact"(path = 卡片 file 原样,锚点存 data.subpath)
 *   link  → kind "reference"(url 存 data.url,title 取 host)
 *   group → 丢弃并记录告警(React Flow 无原生分组,v2 再考虑 parentId 子流)
 *   edges → relation 固定 "supports",label → instruction
 * 位置取 canvas 的 x/y;宽高由卡片内容自适应,不迁移。
 */

import type { FlowDocument, FlowEdge, FlowNode, FlowNodeData } from "./types";

export interface JsonCanvasNode {
  id?: string;
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  color?: string;
  text?: string;
  file?: string;
  subpath?: string;
  url?: string;
  label?: string;
}

export interface JsonCanvasEdge {
  id?: string;
  fromNode?: string;
  toNode?: string;
  fromSide?: string;
  toSide?: string;
  label?: string;
  color?: string;
  style?: string;
}

export interface JsonCanvasDocument {
  nodes?: JsonCanvasNode[];
  edges?: JsonCanvasEdge[];
}

export interface CanvasImportResult {
  document: FlowDocument;
  warnings: string[];
}

/** 判断路径是否是 .canvas 文档(否则按 .flow.json 处理) */
export function isCanvasPath(path: string): boolean {
  return /\.canvas$/i.test(path.trim());
}

function canvasTitle(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return "笔记";
  const stripped = firstLine.replace(/^#{1,6}\s*/, "").replace(/[*_`~=]/g, "");
  const value = stripped.length > 28 ? `${stripped.slice(0, 28)}…` : stripped;
  return value || "笔记";
}

function baseNodeData(kind: FlowNodeData["kind"], title: string, path: string, summary: string): FlowNodeData {
  return {
    kind,
    title,
    path,
    summary,
    input: "",
    output: "",
    conclusion: "",
    process: "",
    references: "",
    status: "idle",
  };
}

/**
 * 把 JSON Canvas 文本/对象转换为 FlowDocument。
 * @throws 格式不是合法 JSON 对象时抛错(调用方负责提示)
 */
export function canvasToFlowDocument(source: string | JsonCanvasDocument, name = "画布文档"): CanvasImportResult {
  const raw: JsonCanvasDocument = typeof source === "string" ? JSON.parse(source) : source;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("画布文档顶层必须是 JSON 对象");
  }
  const warnings: string[] = [];
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];

  (Array.isArray(raw.nodes) ? raw.nodes : []).forEach((item, index) => {
    const id = typeof item?.id === "string" && item.id ? item.id : `canvas-node-${index}`;
    const x = Number.isFinite(item?.x) ? (item?.x as number) : 0;
    const y = Number.isFinite(item?.y) ? (item?.y as number) : 0;
    if (item?.type === "group") {
      warnings.push(`已忽略分组「${item.label || id}」(画布暂不承载分组结构)`);
      return;
    }
    let data: FlowNodeData | null = null;
    const color = typeof item?.color === "string" && item.color ? item.color : null;
    if (item?.type === "text" && typeof item.text === "string") {
      data = baseNodeData("note", canvasTitle(item.text), "", item.text);
    } else if (item?.type === "file" && typeof item.file === "string") {
      const fileName = item.file.split(/[\\/]/).pop() || item.file;
      data = baseNodeData("artifact", fileName, item.file, item.subpath ?? "");
      if (item.subpath) (data as FlowNodeData & { subpath?: string }).subpath = item.subpath;
    } else if (item?.type === "link" && typeof item.url === "string") {
      let host = item.url;
      try { host = new URL(item.url).host; } catch { /* 非 URL 原样 */ }
      data = baseNodeData("reference", host, "", item.url);
      (data as FlowNodeData & { url?: string }).url = item.url;
    }
    if (!data) {
      warnings.push(`已忽略第 ${index} 张无法识别的卡片(类型 ${String(item?.type)})`);
      return;
    }
    if (color) (data as FlowNodeData & { canvasColor?: string }).canvasColor = color;
    nodes.push({ id, type: "flow", position: { x, y }, data });
  });

  const nodeIds = new Set(nodes.map((node) => node.id));
  (Array.isArray(raw.edges) ? raw.edges : []).forEach((item, index) => {
    if (!item?.fromNode || !item?.toNode) return;
    if (!nodeIds.has(item.fromNode) || !nodeIds.has(item.toNode)) {
      warnings.push(`已忽略第 ${index} 条指向缺失卡片的连线`);
      return;
    }
    const id = typeof item.id === "string" && item.id ? item.id : `canvas-edge-${index}`;
    const color = typeof item.color === "string" && item.color ? item.color : null;
    // canvas 侧边 → xyflow 连接点 id(双向/多向连线各自走不同连接点,避免重叠)
    const sourceHandle = { left: "out-left", right: "out", top: "out-top", bottom: "out-bottom" }[item.fromSide ?? ""] ?? "out";
    const targetHandle = { left: "in", right: "in-right", top: "in-top", bottom: "in-bottom" }[item.toSide ?? ""] ?? "in";
    const edge = {
      id,
      source: item.fromNode,
      target: item.toNode,
      type: "flow",
      sourceHandle,
      targetHandle,
      data: {
        relation: "supports",
        instruction: item.label || "",
        expectedOutput: "",
        evidence: "",
        runPolicy: "confirm",
        ...(color ? { canvasColor: color } : {}),
      },
    } as FlowEdge;
    edges.push(edge);
  });

  if (nodes.length === 0) warnings.push("画布中没有任何可显示的卡片");
  return {
    document: { schemaVersion: 1, name, nodes, edges },
    warnings,
  };
}
