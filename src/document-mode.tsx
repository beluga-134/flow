/**
 * document-mode.tsx — 文档模式:轻量画布视图(可拖动布局 + 卡片/连线彩色)
 *
 * 与工作区模式(App)完全隔离:不渲染终端/AI/工作区扫描任何 UI。
 * 数据流:read_document_text → (若是 .canvas)canvasToFlowDocument → ReactFlow 受控节点。
 * 卡片可自由拖动,「保存布局」把新位置写回原文档(只改 x/y,其余字段不动)。
 * 卡片点击跳转复用插件机制:md → Research Reader;其他 → 系统默认工具。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type EdgeProps,
  type NodeProps,
} from "@xyflow/react";
import {
  ArrowUpRight,
  BookOpen,
  FileText,
  FolderOpen,
  Map as MapIcon,
  Network,
  NotebookPen,
  Save,
  StickyNote,
} from "lucide-react";
import { plugins } from "./data";
import { canvasToFlowDocument, isCanvasPath } from "./canvas-document";
import { chooseDocumentFile, launchPluginDocument, readDocumentText, writeDocumentText } from "./backend";
import { appLog } from "./logger";
import type { FlowDocument, FlowEdge, FlowEdgeData, FlowNode, FlowNodeData } from "./types";

/** JSON Canvas 官方 6 色(与 Obsidian / Research Link Reader 一致) */
const CANVAS_COLORS: Record<string, string> = {
  1: "#e06c75", // 红
  2: "#e5a05a", // 橙
  3: "#dfc45f", // 黄
  4: "#8ec06f", // 绿
  5: "#5bc8cc", // 青
  6: "#b18ce8", // 紫
};
/** 无色连线时的轮换调色板(柔和系列,视觉不单调) */
const EDGE_PALETTE = ["#7ea6f5", "#7fd0a4", "#d8b56a", "#c792c7", "#6fc8d8", "#e0987a"];
const DM_KIND_META: Record<string, { label: string; icon: typeof StickyNote; color: string }> = {
  note: { label: "笔记", icon: StickyNote, color: "#c8b06a" },
  artifact: { label: "文档", icon: FileText, color: "#d78b62" },
  reference: { label: "链接", icon: BookOpen, color: "#6b9bf2" },
  project: { label: "项目", icon: FolderOpen, color: "#6b9bf2" },
  operation: { label: "处理", icon: Network, color: "#9a86e8" },
  conclusion: { label: "结论", icon: NotebookPen, color: "#66bb8a" },
};

const RESEARCH_READER = plugins.find((plugin) => plugin.id === "research-reader") ?? null;
const SYSTEM_OPENER = plugins.find((plugin) => plugin.id === "folder") ?? null;

function hexA(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function describeSubpath(subpath: string): string {
  const raw = subpath.replace(/^#/, "");
  if (/^page=\d+$/i.test(raw)) return `PDF 第 ${raw.slice(5)} 页`;
  if (/^heading=/.test(raw)) return `标题「${raw.slice(8)}」`;
  if (/^line=\d+/i.test(raw)) return `第 ${raw.slice(5)} 行`;
  if (/^L\d+(-L?\d+)?$/i.test(raw)) return `代码 ${raw.toUpperCase()}`;
  return raw;
}

function DMNodeCard({ data, selected }: NodeProps<FlowNode>) {
  const meta = DM_KIND_META[data.kind] ?? DM_KIND_META.note;
  const Icon = meta.icon;
  const url = (data as FlowNodeData & { url?: string }).url;
  const subpath = (data as FlowNodeData & { subpath?: string }).subpath;
  const canvasColor = (data as FlowNodeData & { canvasColor?: string }).canvasColor;
  const accent = canvasColor ? CANVAS_COLORS[canvasColor] ?? meta.color : meta.color;
  return <div
    className={`dm-node kind-${data.kind} ${selected ? "is-selected" : ""}`}
    style={{ borderColor: accent, boxShadow: `inset 3px 0 0 0 ${accent}, 0 3px 12px rgba(0,0,0,.35)` }}
  >
    <Handle className="dm-handle" type="target" position={Position.Left} id="in" />
    <Handle className="dm-handle" type="target" position={Position.Top} id="in-top" />
    <Handle className="dm-handle" type="target" position={Position.Bottom} id="in-bottom" />
    <Handle className="dm-handle" type="target" position={Position.Right} id="in-right" />
    <div className="dm-node-head" style={{ color: accent, background: hexA(accent, 0.12) }}><Icon size={13} /><span>{meta.label}</span></div>
    <h4>{data.title}</h4>
    {data.path ? <p className="dm-node-path" title={data.path}>{data.path}</p> : null}
    {url ? <p className="dm-node-path" title={url}>{url}</p> : null}
    {subpath ? <span className="dm-node-sub" style={{ color: accent, background: hexA(accent, 0.14) }}>▶ {describeSubpath(subpath)}</span> : null}
    {!data.path && !url && data.summary ? <p className="dm-node-summary">{data.summary}</p> : null}
    <Handle className="dm-handle" type="source" position={Position.Right} id="out" />
    <Handle className="dm-handle" type="source" position={Position.Top} id="out-top" />
    <Handle className="dm-handle" type="source" position={Position.Bottom} id="out-bottom" />
    <Handle className="dm-handle" type="source" position={Position.Left} id="out-left" />
  </div>;
}

function DMEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<FlowEdge>) {
  const canvasColor = (data as (FlowEdgeDataLoose) | undefined)?.canvasColor as string | undefined;
  const color = (canvasColor && CANVAS_COLORS[canvasColor]) || (data as FlowEdgeDataLoose | undefined)?.dmColor || "#7ea6f5";
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return <>
    <BaseEdge id={id} path={path} style={{ stroke: color, strokeWidth: 2 }} />
    {data?.instruction ? <EdgeLabelRenderer><div className="dm-edge-label nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`, borderColor: hexA(color, 0.55), color: "#dbe6f5" }}>{data.instruction}</div></EdgeLabelRenderer> : null}
  </>;
}
type FlowEdgeDataLoose = Record<string, unknown> & { dmColor?: string };

const dmNodeTypes = { flow: DMNodeCard };
const dmEdgeTypes = { flow: DMEdgeView };

export function DocumentMode({ initialPath, onExit }: { initialPath: string | null; onExit: () => void }) {
  const desktop = "__TAURI_INTERNALS__" in window;
  const { fitView } = useReactFlow<FlowNode, FlowEdge>();
  const [path, setPath] = useState<string | null>(initialPath);
  const [sourceJson, setSourceJson] = useState<Record<string, unknown> | null>(null);
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<FlowNode>([]);
  const [edges, setEdges] = useEdgesState<FlowEdge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [notice, setNotice] = useState(desktop ? "文档模式" : "文档模式需要桌面版运行");

  const onNodesChange = useCallback((changes: Parameters<typeof onNodesChangeBase>[0]) => {
    if (changes.some((change) => change.type === "position" && change.dragging === false)) setDirty(true);
    onNodesChangeBase(changes);
  }, [onNodesChangeBase]);

  const load = useCallback(async (nextPath: string) => {
    try {
      const text = await readDocumentText(nextPath);
      const name = nextPath.split(/[\\/]/).pop() ?? "画布文档";
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const result = isCanvasPath(nextPath)
        ? canvasToFlowDocument(parsed, name)
        : { document: parsed as unknown as FlowDocument, warnings: [] as string[] };
      setSourceJson(parsed);
      setPath(nextPath);
      setEdges(result.document.edges.map((edge, index) => {
        const color = ((edge.data as FlowEdgeData & { canvasColor?: string } | undefined)?.canvasColor && CANVAS_COLORS[(edge.data as FlowEdgeData & { canvasColor?: string }).canvasColor as string]) || EDGE_PALETTE[index % EDGE_PALETTE.length];
        return {
          ...edge,
          data: { ...edge.data, dmColor: color } as FlowEdgeData,
          markerEnd: { type: MarkerType.ArrowClosed, color },
        } as FlowEdge;
      }));
      setNodes(result.document.nodes.map((node) => ({ ...node })));
      setSelectedId(null);
      setDirty(false);
      setWarnings(result.warnings);
      setNotice(`已载入 ${name} · ${result.document.nodes.length} 卡片 / ${result.document.edges.length} 连线`);
      window.setTimeout(() => void fitView({ padding: 0.12, duration: 300 }), 80);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appLog.error(`[doc-mode] 载入失败 ${nextPath}: ${message}`);
      setNotice(`载入失败:${message}`);
    }
  }, [fitView, setEdges, setNodes]);

  useEffect(() => {
    if (desktop && initialPath) void load(initialPath);
  }, [desktop, initialPath, load]);

  useEffect(() => {
    if (!desktop) return;
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => {
      const promise = getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        const dropped = event.payload.paths.find((item) => /\.(canvas|flow\.json)$/i.test(item));
        if (dropped) void load(dropped);
      });
      return () => { void promise.then((unlisten) => unlisten()); };
    });
  }, [desktop, load]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedId) ?? null,
    [nodes, selectedId],
  );

  /** 把拖动后的位置写回原文档:只改坐标,其余字段原样保留 */
  const saveLayout = async () => {
    if (!sourceJson || !path) return;
    try {
      const updated = JSON.parse(JSON.stringify(sourceJson)) as Record<string, unknown>;
      const rawNodes = Array.isArray(updated.nodes) ? (updated.nodes as Record<string, unknown>[]) : [];
      const byId = new Map(nodes.map((node) => [node.id, node]));
      for (const raw of rawNodes) {
        const id = String(raw.id ?? "");
        const node = byId.get(id);
        if (!node) continue;
        if (isCanvasPath(path)) {
          raw.x = Math.round(node.position.x);
          raw.y = Math.round(node.position.y);
        } else {
          raw.position = { x: Math.round(node.position.x), y: Math.round(node.position.y) };
        }
      }
      await writeDocumentText(path, JSON.stringify(updated, null, 2));
      setSourceJson(updated);
      setDirty(false);
      appLog.info(`[doc-mode] 布局已保存 ${path}`);
      setNotice("布局已保存回文档(仅更新卡片坐标)");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appLog.error(`[doc-mode] 保存失败 ${path}: ${message}`);
      setNotice(`保存失败:${message}`);
    }
  };

  const openWithReader = async () => {
    if (!selectedNode || !RESEARCH_READER?.executable) return;
    const subpath = (selectedNode.data as FlowNodeData & { subpath?: string }).subpath ?? "";
    try {
      await launchPluginDocument(RESEARCH_READER.executable, `${selectedNode.data.path}${subpath}`);
      setNotice(`已唤起 ${RESEARCH_READER.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appLog.error(`[doc-mode] RLR 打开失败 ${selectedNode.data.path}: ${message}`);
      setNotice(message);
    }
  };

  const openWithSystem = async (target?: string) => {
    if (!SYSTEM_OPENER || !selectedNode) return;
    const url = (selectedNode.data as FlowNodeData & { url?: string }).url;
    const value = target ?? url ?? selectedNode.data.path;
    if (!value) return;
    try {
      await launchPluginDocument(null, value);
      setNotice("已交给系统默认工具");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "系统打开失败");
    }
  };

  const revealFolder = async () => {
    if (!selectedNode?.data.path) return;
    const parent = selectedNode.data.path.replace(/[\\/][^\\/]+$/, "");
    if (!parent) return;
    try {
      await launchPluginDocument(null, parent);
      setNotice("已在文件管理器中打开所在位置");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法打开所在位置");
    }
  };

  const isMarkdown = !!selectedNode && /\.md|markdown$/i.test(selectedNode.data.path);
  const hasUrl = !!selectedNode && !!(selectedNode.data as FlowNodeData & { url?: string }).url;

  return <div className="dm-shell">
    <header className="dm-topbar">
      <div className="dm-brand"><Network size={17} /><strong>Flow Canvas</strong><span>文档模式 · 拖动卡片整理布局</span></div>
      <span className="dm-doc-name" title={path ?? undefined}>{path ? `${path.split(/[\\/]/).pop()}${dirty ? " *" : ""}` : "未打开文档"}</span>
      <div className="dm-actions">
        <button className="dm-button" onClick={async () => { const picked = await chooseDocumentFile(); if (picked) void load(picked); }}><FolderOpen size={14} />打开画布文档</button>
        <button className={`dm-button ${dirty ? "dm-save-active" : ""}`} disabled={!dirty} onClick={() => void saveLayout()} title="把拖动后的卡片坐标写回文档"><Save size={14} />{dirty ? "保存布局 *" : "保存布局"}</button>
        <button className="dm-button" onClick={() => void fitView({ padding: 0.12, duration: 200 })}><MapIcon size={14} />适应画布</button>
        <button className="dm-button" onClick={onExit}><ArrowUpRight size={14} />返回工作区模式</button>
      </div>
    </header>
    <div className="dm-body">
      <div className="dm-canvas">
        {sourceJson ? <ReactFlow
          nodes={nodes.map((node) => ({ ...node, selected: node.id === selectedId }))}
          edges={edges}
          onNodesChange={onNodesChange}
          nodeTypes={dmNodeTypes}
          edgeTypes={dmEdgeTypes}
          onNodeClick={(_, node) => setSelectedId(node.id)}
          onPaneClick={() => setSelectedId(null)}
          nodesConnectable={false}
          deleteKeyCode={null}
          fitView
          fitViewOptions={{ padding: 0.12 }}
          minZoom={0.1}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#263342" gap={24} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor={(node) => {
            const data = node.data as FlowNodeData & { canvasColor?: string };
            return (data.canvasColor && CANVAS_COLORS[data.canvasColor]) || DM_KIND_META[data.kind]?.color || "#738196";
          }} />
        </ReactFlow> : <div className="dm-empty">
          <Network size={30} />
          <h2>打开画布文档</h2>
          <p>拖入 <b>.canvas</b>(Obsidian / Research Link Reader 导出)或 <b>.flow.json</b> 文件,<br />或点击上方「打开画布文档」。</p>
        </div>}
      </div>
      <aside className="dm-inspector">
        {selectedNode ? <>
          <div className="dm-inspector-head">
            {(() => { const Icon = DM_KIND_META[selectedNode.data.kind]?.icon ?? StickyNote; return <Icon size={17} />; })()}
            <div><b>{selectedNode.data.title}</b><small>{DM_KIND_META[selectedNode.data.kind]?.label ?? "卡片"}</small></div>
          </div>
          <div className="dm-inspector-body">
            {selectedNode.data.path ? <div className="dm-field"><span>文件路径</span><code>{selectedNode.data.path}</code></div> : null}
            {(() => { const url = (selectedNode.data as FlowNodeData & { url?: string }).url; return url ? <div className="dm-field"><span>网址</span><code>{url}</code></div> : null; })()}
            {(() => { const sub = (selectedNode.data as FlowNodeData & { subpath?: string }).subpath; return sub ? <div className="dm-field"><span>定位锚点</span><code>{describeSubpath(sub)}</code></div> : null; })()}
            {selectedNode.data.summary ? <div className="dm-field"><span>内容</span><p>{selectedNode.data.summary}</p></div> : null}
            <div className="dm-launch-row">
              {isMarkdown && RESEARCH_READER?.executable
                ? <button className="dm-launch primary" onClick={() => void openWithReader()}><FileText size={14} />在 {RESEARCH_READER.name} 打开</button>
                : null}
              {selectedNode.data.path || hasUrl
                ? <button className="dm-launch" onClick={() => void openWithSystem()}><FolderOpen size={14} />{hasUrl ? "在浏览器打开" : "系统默认工具打开"}</button>
                : null}
              {selectedNode.data.path && !hasUrl
                ? <button className="dm-launch" onClick={() => void revealFolder()}><FolderOpen size={14} />打开所在位置</button>
                : null}
            </div>
          </div>
        </> : <div className="dm-inspector-empty"><StickyNote size={20} /><h3>点击画布卡片</h3><p>查看卡片详情,并可调用外部工具打开对应文档。<br />拖动卡片可整理布局,「保存布局」写回文档。</p></div>}
        {warnings.length > 0 ? <div className="dm-warnings"><b>导入提示</b>{warnings.slice(0, 5).map((warning) => <span key={warning}>· {warning}</span>)}</div> : null}
      </aside>
    </div>
    <footer className="dm-statusbar"><span>{notice}</span><span>{sourceJson ? `${nodes.length} 卡片 · ${edges.length} 连线${dirty ? " · 布局未保存" : ""}` : "文档模式"} · 不加载终端 / AI / 工作区扫描</span></footer>
  </div>;
}
