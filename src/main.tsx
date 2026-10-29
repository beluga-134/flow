import {
  Background, BaseEdge, ConnectionLineType, Controls, EdgeLabelRenderer, MiniMap, Position,
  ReactFlow, ReactFlowProvider, getBezierPath, useEdgesState, useNodesState, type Connection,
  type EdgeProps, type NodeProps, Handle, MarkerType, useReactFlow,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, ArrowRight, BookOpen, Bot, Check, ChevronDown, ChevronUp, Copy, FilePlus2, FolderCog, FolderOpen, GitBranch, Hammer, Info, Layers3, Link2, LoaderCircle, MousePointer2, Network, Play, Plus, Save, Search, Settings2, Square, SquareTerminal, StickyNote, Trash2 } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xyflow/react/dist/style.css";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { chooseDirectory, chooseDocumentFile, closeAgent, findCodexSession, initializeFrameworkDirectories, interruptAgent, openAgent, openPlugin, openWorkspace, prepareNodeDirectory, readNodeResults, resizeAgent, saveWorkspaceFlow, scanWorkspace, startupWorkspace, validateWorkspaceTarget, writeAgent, type AgentData } from "./backend";
import { plugins } from "./data";
import { appendFramework, buildNodePrompt, createFramework, effectiveAiMode, frameworkStages, joinWorkspacePath, migrateFrameworkTopology, nodeRunBlocker, stageLabels } from "./framework";
import type { AiMode, FlowDocument, FlowEdge, FlowEdgeData, FlowNode, FlowNodeData, NodeKind, Relation, WorkspaceActivity, WorkspaceFileRecord, WorkspaceSnapshot } from "./types";

const nodeIcons: Record<NodeKind, typeof Layers3> = { project: FolderOpen, artifact: FilePlus2, operation: Hammer, conclusion: Check, reference: BookOpen, note: StickyNote };
const kindLabels: Record<NodeKind, string> = { project: "项目", artifact: "产物", operation: "处理", conclusion: "结论", reference: "参考", note: "笔记" };
const relationLabels: Record<Relation, string> = { transforms: "转换", depends_on: "依赖", supports: "支持", contradicts: "冲突" };
const aiModeLabels: Record<AiMode, string> = { off: "关闭", assist: "辅助", auto: "自动执行" };
const defaultEdgeData: FlowEdgeData = { relation: "transforms", instruction: "描述这条连接如何处理输入。", expectedOutput: "", evidence: "", runPolicy: "confirm" };
const WORKSPACE_STORAGE_KEY = "flow-canvas.workspace.v1";

function stripTerminalCodes(value: string): string {
  return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function outputCandidates(value: string): string[] {
  return value.split(/[\n,，;；]+/).map((item) => item.trim()).filter(Boolean);
}

function workspaceFlow(workspace: WorkspaceSnapshot): FlowDocument {
  return createFramework(workspace.name);
}

function PersistentTerminal({ nodeId, data, active, sessionId }: { nodeId: string; data: FlowNodeData; active: boolean; sessionId?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<number | undefined>(sessionId);
  const activeRef = useRef(active);
  const inputHandlerRef = useRef<(nodeId: string, input: string) => void>(() => undefined);
  inputHandlerRef.current = (currentNodeId, input) => window.dispatchEvent(new CustomEvent("flow-node-terminal-input", { detail: { nodeId: currentNodeId, input } }));
  sessionRef.current = sessionId;
  activeRef.current = active;

  const resize = () => {
    const terminal = terminalRef.current;
    const fit = fitRef.current;
    if (!activeRef.current || !terminal || !fit || !host.current || host.current.offsetParent === null) return;
    try {
      fit.fit();
      if (sessionRef.current && terminal.cols && terminal.rows) {
        void resizeAgent(sessionRef.current, terminal.rows, terminal.cols).catch(() => undefined);
      }
    } catch { /* The panel may still be settling its layout. */ }
  };

  useEffect(() => {
    if (!host.current || terminalRef.current) return;
    const terminal = new Terminal({
      cursorBlink: true, convertEol: true, scrollback: 5000,
      fontFamily: "Cascadia Mono, Consolas, monospace", fontSize: 12,
      theme: { background: "#0b121b", foreground: "#cbd8e8", cursor: "#83aaff", selectionBackground: "#29456b" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    if (data.agentOutput) terminal.write(data.agentOutput.replace(/\n/g, "\r\n"));
    const outputListener = (event: Event) => {
      const detail = (event as CustomEvent<{ nodeId: string; data: number[] }>).detail;
      if (detail.nodeId === nodeId) terminal.write(Uint8Array.from(detail.data));
    };
    const dataDisposable = terminal.onData((value) => inputHandlerRef.current(nodeId, value));
    const resizeObserver = new ResizeObserver(resize);
    window.addEventListener("flow-node-output", outputListener);
    window.addEventListener("resize", resize);
    resizeObserver.observe(host.current);
    terminalRef.current = terminal;
    fitRef.current = fit;
    requestAnimationFrame(resize);
    return () => { dataDisposable.dispose(); resizeObserver.disconnect(); window.removeEventListener("resize", resize); window.removeEventListener("flow-node-output", outputListener); terminal.dispose(); terminalRef.current = null; fitRef.current = null; };
  }, [nodeId]);

  useEffect(() => { requestAnimationFrame(resize); }, [active, sessionId]);

  return <div className={`agent-terminal-view ${active ? "active" : ""}`} ref={host} />;
}

function FlowNodeCard({ id, data, selected }: NodeProps<FlowNode>) {
  const Icon = nodeIcons[data.kind];
  const agentActive = data.agentStatus === "connected" || data.agentStatus === "opening" || data.agentStatus === "waiting";
  const runNode = (event: React.MouseEvent) => { event.stopPropagation(); window.dispatchEvent(new CustomEvent("flow-node-run", { detail: { nodeId: id } })); };
  const stopNode = (event: React.MouseEvent) => { event.stopPropagation(); window.dispatchEvent(new CustomEvent("flow-node-stop", { detail: { nodeId: id } })); };
  return <div className={`flow-node-card kind-${data.kind} ${data.frameworkRole === "module" ? "framework-module" : ""} ${data.pruned ? "is-pruned" : ""} ${selected ? "is-selected" : ""} ${data.status === "error" ? "needs-attention" : ""}`}>
    <Handle className="flow-handle input-handle" type="target" position={Position.Left} id="in" title="输入连接点" />
    <Handle className="flow-handle input-handle" type="target" position={Position.Top} id="in-top" title="输入连接点" />
    <div className="node-card-surface">
      <div className="node-accent" />
      <div className="node-card-head"><span className="node-icon"><Icon size={15} /></span><span className="node-kind">{kindLabels[data.kind]}</span>{data.stage && <span className={`stage-pill ${data.stage}`}>{stageLabels[data.stage]}</span>}<StatusPill status={data.status} /></div>
      <h3>{data.title}</h3>
      <p className="node-path">{data.path || (data.frameworkRole === "module" ? "模块目标与阶段管理" : "未绑定本地路径")}</p>
      <p className="node-summary" title={data.goal ?? data.summary}>{data.goal ?? data.summary}</p>
      <div className="node-io"><span><b>输入</b>{data.input || "—"}</span><ArrowRight size={13} /><span><b>输出</b>{data.output || "—"}</span></div>
      <div className="node-agent-head"><span><Bot size={11} />AI {aiModeLabels[effectiveAiMode(data)]}{data.pruned && <em className="pruned-label">已剪枝</em>}</span><span className="node-agent-actions"><button className="node-run-button" disabled={!!nodeRunBlocker(data)} onClick={runNode} title={nodeRunBlocker(data) ?? "执行当前节点目标"}><Play size={11} /></button>{agentActive && <button className="node-stop-button" onClick={stopNode} title="发送 Ctrl-C，中断当前任务但保留终端"><Square size={10} /></button>}</span></div>
    </div>
    <Handle className="flow-handle output-handle" type="source" position={Position.Right} id="out" title="输出连接点" />
    <Handle className="flow-handle output-handle" type="source" position={Position.Bottom} id="out-bottom" title="输出连接点" />
  </div>;
}

function StatusPill({ status }: { status: FlowNodeData["status"] }) {
  const labels = { idle: "待运行", running: "运行中", success: "已完成", error: "需处理" };
  return <span className={`status-pill ${status}`}><span />{labels[status]}</span>;
}

function FlowEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }: EdgeProps<FlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return <>
    <BaseEdge id={id} path={path} markerEnd={markerEnd} className="flow-edge" />
    <EdgeLabelRenderer><div className="edge-label nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}><span className="edge-relation">{relationLabels[data?.relation ?? "transforms"]}</span><span>{data?.instruction || "点击编辑处理方式"}</span></div></EdgeLabelRenderer>
  </>;
}

function AgentPanel({ nodes, selectedNodeId, onSelectNode, onClose }: { nodes: FlowNode[]; selectedNodeId: string | null; onSelectNode: (nodeId: string) => void; onClose: () => void }) {
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const panelOpen = !!selectedNode;
  const agentActive = selectedNode?.data.agentStatus === "connected" || selectedNode?.data.agentStatus === "opening" || selectedNode?.data.agentStatus === "waiting";
  const statusLabel = selectedNode?.data.agentStatus === "waiting" ? "等待人工处理" : selectedNode?.data.agentStatus === "connected" ? "已连接" : selectedNode?.data.agentStatus === "opening" ? "正在打开 WSL" : selectedNode?.data.agentStatus === "exited" ? "已结束" : selectedNode?.data.agentStatus === "error" ? "连接异常" : "未启动";
  const runSelected = () => { if (selectedNode) window.dispatchEvent(new CustomEvent("flow-node-run", { detail: { nodeId: selectedNode.id } })); };
  const stopSelected = () => { if (selectedNode) window.dispatchEvent(new CustomEvent("flow-node-stop", { detail: { nodeId: selectedNode.id } })); };
  const copySession = () => { if (selectedNode?.data.codexSessionId) void navigator.clipboard?.writeText(`codex_micu resume ${selectedNode.data.codexSessionId}`); };
  return <section className={`agent-panel ${panelOpen ? "open" : ""}`}>
    <header>
      <span className="agent-panel-title"><SquareTerminal size={14} /><b>节点终端</b>{selectedNode && <em className={selectedNode.data.agentStatus ?? "idle"}>{statusLabel}</em>}</span>
      <div className="agent-tabs" role="tablist" aria-label="节点终端">
        {nodes.map((node) => <button className={node.id === selectedNodeId ? "active" : ""} key={node.id} onClick={() => onSelectNode(node.id)} role="tab" aria-selected={node.id === selectedNodeId} title={node.data.title}><span className={`agent-tab-dot ${node.data.status}`} />{node.data.title}</button>)}
      </div>
      {selectedNode && <span className="agent-panel-actions">
        {selectedNode.data.codexSessionId && <button onClick={copySession} title="复制 resume 命令"><Copy size={13} /></button>}
        <button onClick={runSelected} disabled={!!nodeRunBlocker(selectedNode.data)} title="运行当前节点"><Play size={13} /></button>
        {agentActive && <button onClick={stopSelected} title="发送 Ctrl-C"><Square size={12} /></button>}
      </span>}
      <button className="agent-panel-caret" onClick={onClose} title="收起终端">{panelOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</button>
    </header>
    <div className="agent-terminal-stack">
      {nodes.map((node) => <PersistentTerminal key={node.id} nodeId={node.id} data={node.data} active={node.id === selectedNodeId} sessionId={node.data.agentSessionId} />)}
      {selectedNode?.data.agentStatus === "opening" && <div className="agent-terminal-opening"><LoaderCircle size={15} /><span>正在打开 WSL…</span></div>}
    </div>
  </section>;
}

const nodeTypes = { flow: FlowNodeCard };
const edgeTypes = { flow: FlowEdgeView };

function App({ onOpenDocument }: { onOpenDocument: (path: string) => void }) {
  const desktop = "__TAURI_INTERNALS__" in window;
  const { fitView } = useReactFlow<FlowNode, FlowEdge>();
  const initial = useMemo(() => desktop ? { name: "未选择工作区", nodes: [] as FlowNode[], edges: [] as FlowEdge[] } : createFramework("分析框架预览"), [desktop]);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>(initial.edges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(desktop ? null : "framework-design");
  const [moduleFilter, setModuleFilter] = useState("all");
  const [terminalNodeId, setTerminalNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [flowName, setFlowName] = useState(initial.name);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [workspaceLoaded, setWorkspaceLoaded] = useState(!desktop);
  const [notice, setNotice] = useState(desktop ? "请选择工作区" : "浏览器预览模式");
  const [search, setSearch] = useState("");
  const [agentChoice, setAgentChoice] = useState<"none" | "codex_micu">("codex_micu");
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileRecord[]>([]);
  const [activities, setActivities] = useState<WorkspaceActivity[]>([]);
  const nodeSessions = useRef(new Map<string, number>());
  const fileBaseline = useRef(new Map<string, { size: number; modifiedAt: number }>());
  const activeNodeRef = useRef<string | null>(null);
  const textDecoders = useRef(new Map<string, TextDecoder>());
  const outputBuffers = useRef(new Map<string, string>());
  const outputTimers = useRef(new Map<string, number>());
  const startingNodes = useRef(new Set<string>());
  const runOutput = useRef(new Map<string, string>());
  const activeRuns = useRef(new Set<string>());
  const sessionEpochs = useRef(new Map<string, number>());
  const workspaceGeneration = useRef(0);
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) ?? null;

  const patchNode = useCallback((patch: Partial<FlowNodeData>) => {
    if (!selectedNodeId) return;
    setNodes((current) => current.map((node) => node.id === selectedNodeId ? { ...node, data: { ...node.data, ...patch } } : node));
  }, [selectedNodeId, setNodes]);
  const patchEdge = useCallback((patch: Partial<FlowEdgeData>) => {
    if (!selectedEdgeId) return;
    setEdges((current) => current.map((edge) => edge.id === selectedEdgeId ? { ...edge, data: { ...defaultEdgeData, ...(edge.data ?? {}), ...patch } } : edge));
  }, [selectedEdgeId, setEdges]);
  const onConnect = useCallback((connection: Connection) => {
    const edge: FlowEdge = { ...connection, id: `edge-${Date.now()}`, type: "flow", animated: false, markerEnd: { type: MarkerType.ArrowClosed, color: "#85a8ff" }, data: { relation: "transforms", instruction: "描述这条连接如何处理输入，并说明为什么可以交给下一个节点。", expectedOutput: "", evidence: "", runPolicy: "confirm" } } as FlowEdge;
    setEdges((current) => [...current, edge]);
    setSelectedEdgeId(edge.id); setSelectedNodeId(null); setNotice("已创建连接，请补充处理方式");
  }, [setEdges]);

  const document = useMemo<FlowDocument>(() => ({ schemaVersion: 1, name: flowName, nodes, edges, files: workspaceFiles, activities }), [activities, edges, flowName, nodes, workspaceFiles]);

  const stopAgent = useCallback(async () => {
    workspaceGeneration.current += 1;
    const sessions = [...nodeSessions.current.values()];
    nodeSessions.current.clear();
    outputTimers.current.forEach((timer) => window.clearTimeout(timer));
    outputTimers.current.clear();
    outputBuffers.current.clear();
    startingNodes.current.clear();
    activeRuns.current.clear();
    runOutput.current.clear();
    textDecoders.current.clear();
    activeNodeRef.current = null;
    setTerminalNodeId(null);
    await Promise.all(sessions.map((sessionId) => closeAgent(sessionId)));
    setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, status: node.data.status === "running" ? "idle" : node.data.status, agentSessionId: undefined, agentOpenedAt: undefined, agentStatus: "idle" } })));
  }, [setNodes]);

  useEffect(() => () => { void stopAgent(); }, [stopAgent]);

  const applyWorkspace = useCallback((snapshot: WorkspaceSnapshot) => {
    const base = snapshot.document ?? workspaceFlow(snapshot);
    const next = migrateFrameworkTopology(base.nodes.some((node) => node.data.frameworkRole) ? base : appendFramework(base));
    setWorkspace(snapshot);
    fileBaseline.current.clear();
    setNodes(next.nodes.map((node) => ({ ...node, data: { ...node.data, status: node.data.status === "running" ? "idle" : node.data.status, agentStatus: "idle", agentSessionId: undefined, agentOpenedAt: undefined } })));
    setEdges(next.edges);
    setFlowName(next.name);
    setWorkspaceFiles(next.files ?? []);
    setActivities(next.activities ?? []);
    setSelectedNodeId(next.nodes[0]?.id ?? null);
    setSelectedEdgeId(null);
    setTerminalNodeId(null);
    setModuleFilter("all");
    setWorkspaceLoaded(true);
    localStorage.setItem(WORKSPACE_STORAGE_KEY, snapshot.root);
    return next;
  }, [setEdges, setNodes]);

  useEffect(() => {
    if (!desktop) return;
    void (async () => {
      try {
        const startup = await startupWorkspace();
        if (startup) { applyWorkspace(startup); setNotice(`已打开工作区：${startup.root}`); return; }
        const stored = localStorage.getItem(WORKSPACE_STORAGE_KEY);
        if (!stored) { setWorkspaceLoaded(true); return; }
        const snapshot = await openWorkspace(stored);
        applyWorkspace(snapshot);
        setNotice(`已恢复工作区：${snapshot.root}`);
      } catch {
        localStorage.removeItem(WORKSPACE_STORAGE_KEY);
        setWorkspaceLoaded(true);
        setNotice("原工作区不可用，请重新选择");
      }
    })();
  }, [applyWorkspace, desktop]);

  useEffect(() => {
    if (!desktop || !workspace || !workspaceLoaded) return;
    let cancelled = false;
    const refreshFiles = async () => {
      try {
        const current = await scanWorkspace(workspace.root);
        if (cancelled) return;
        const previous = fileBaseline.current;
        const changes = current.filter((file) => !previous.has(file.path) || previous.get(file.path)?.size !== file.size || previous.get(file.path)?.modifiedAt !== file.modifiedAt);
        const observedAt = Date.now();
        const withStatus = current.map((file) => ({ ...file, status: changes.some((change) => change.path === file.path) ? (previous.has(file.path) ? "modified" : "added") : "present", observedAt, nodeId: activeNodeRef.current ?? undefined } as WorkspaceFileRecord));
        fileBaseline.current = new Map(current.map((file) => [file.path, { size: file.size, modifiedAt: file.modifiedAt }]));
        setWorkspaceFiles((existing) => {
          const changedPaths = new Set(changes.map((file) => file.path));
          const retained = existing.filter((file) => current.some((next) => next.path === file.path) && !changedPaths.has(file.path));
          return [...retained, ...withStatus.filter((file) => changedPaths.has(file.path))].slice(-120);
        });
        if (changes.length) {
          const paths = changes.map((file) => file.path);
          setActivities((existing) => [...existing, { kind: "file-change", message: `检测到 ${changes.length} 个文件变化`, paths, nodeId: activeNodeRef.current ?? undefined, timestamp: observedAt } satisfies WorkspaceActivity].slice(-120));
          setNotice(`工作区检测到文件变化：${paths.slice(0, 2).join("、")}${paths.length > 2 ? "…" : ""}`);
        }
      } catch (error) { if (!cancelled) setNotice(error instanceof Error ? error.message : "无法扫描工作区文件"); }
    };
    void refreshFiles();
    const timer = window.setInterval(() => void refreshFiles(), 2500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [desktop, workspace?.root, workspaceLoaded]);

  useEffect(() => {
    if (!desktop || !workspace || !workspaceLoaded) return;
    const timer = window.setTimeout(() => {
      void saveWorkspaceFlow(workspace.root, document).then((flowPath) => {
        setWorkspace((current) => current?.root === workspace.root ? { ...current, flowPath } : current);
      }).catch((error) => setNotice(error instanceof Error ? error.message : "自动保存失败"));
    }, 600);
    return () => window.clearTimeout(timer);
  }, [desktop, document, workspace?.root, workspaceLoaded]);

  const selectWorkspace = async () => {
    try {
      if (workspace) await saveWorkspaceFlow(workspace.root, document);
      const path = await chooseDirectory(workspace?.root);
      if (!path) return;
      await stopAgent();
      const snapshot = await openWorkspace(path);
      const next = applyWorkspace(snapshot);
      if (!snapshot.document) await saveWorkspaceFlow(snapshot.root, next);
      setNotice(`当前工作区：${snapshot.root}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法切换工作区");
    }
  };

  const chooseNodeDirectory = async () => {
    if (!workspace) { setNotice("请先选择工作区"); return; }
    const path = await chooseDirectory(workspace.root);
    if (!path) return;
    try {
      patchNode({ path: await validateWorkspaceTarget(workspace.root, path) });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "目录不在当前工作区内");
    }
  };

  const patchNodeById = useCallback((nodeId: string, patch: Partial<FlowNodeData>) => {
    setNodes((current) => current.map((node) => node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node));
  }, [setNodes]);

  const inheritedContext = useCallback((nodeId: string) => {
    if (!workspace) return { input: "", predecessors: [] as FlowNode[], successors: [] as FlowNode[] };
    const incoming = edges.filter((edge) => edge.target === nodeId);
    const outgoing = edges.filter((edge) => edge.source === nodeId);
    const predecessors = incoming.map((edge) => nodes.find((node) => node.id === edge.source)).filter((node): node is FlowNode => !!node && !node.data.pruned);
    const successors = outgoing.map((edge) => nodes.find((node) => node.id === edge.target)).filter((node): node is FlowNode => !!node && !node.data.pruned);
    const inputs = predecessors.filter((node) => node.data.frameworkRole !== "module").flatMap((node) => {
      const outputs = outputCandidates(node.data.output).map((value) => joinWorkspacePath(workspace.root, value));
      return outputs.length ? outputs : [node.data.path].filter(Boolean);
    });
    return { input: [...new Set(inputs)].join("\n"), predecessors, successors };
  }, [edges, nodes, workspace]);

  const runNode = useCallback(async (nodeId: string) => {
    const node = nodes.find((item) => item.id === nodeId);
    if (!node || !workspace) { setNotice("请先选择工作区和节点"); return; }
    const blocked = nodeRunBlocker(node.data);
    if (blocked) { setNotice(blocked); return; }
    if (startingNodes.current.has(nodeId)) return;
    if (agentChoice === "none") { setNotice("请先在工具栏选择 AI"); return; }
    startingNodes.current.add(nodeId);
    const generation = workspaceGeneration.current;
    const context = inheritedContext(nodeId);
    const inheritedInput = node.data.input || context.input;
    const prompt = buildNodePrompt(node, nodes, edges, inheritedInput);
    activeNodeRef.current = nodeId;
    setSelectedNodeId(nodeId);
    setSelectedEdgeId(null);
    setTerminalNodeId(nodeId);
    runOutput.current.set(nodeId, "");
    activeRuns.current.add(nodeId);
    patchNodeById(nodeId, { status: "running", agentStatus: nodeSessions.current.has(nodeId) ? "connected" : "opening", inheritedInput });
    if (!nodeSessions.current.has(nodeId)) setNotice("正在打开 WSL…");
    setActivities((existing) => [...existing, { kind: "node-run", message: `执行节点：${node.data.title}`, nodeId, timestamp: Date.now() } satisfies WorkspaceActivity].slice(-120));
    try {
      if (node.data.path) await prepareNodeDirectory(workspace.root, node.data.path);
      await saveWorkspaceFlow(workspace.root, document);
      if (generation !== workspaceGeneration.current) return;
      const existing = nodeSessions.current.get(nodeId);
      const epoch = (sessionEpochs.current.get(nodeId) ?? 0) + (existing ? 0 : 1);
      sessionEpochs.current.set(nodeId, epoch);
      const result = existing ? { sessionId: existing } : await openAgent(workspace.root, agentChoice, 18, 82,
        (data: AgentData) => {
          if (generation !== workspaceGeneration.current || sessionEpochs.current.get(nodeId) !== epoch) return;
          const bytes = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data);
          const decoder = textDecoders.current.get(nodeId) ?? new TextDecoder();
          textDecoders.current.set(nodeId, decoder);
          const output = stripTerminalCodes(decoder.decode(bytes, { stream: true }));
          window.dispatchEvent(new CustomEvent("flow-node-output", { detail: { nodeId, data: Array.from(bytes) } }));
          if (!output) return;
          outputBuffers.current.set(nodeId, `${outputBuffers.current.get(nodeId) ?? ""}${output}`);
          if (outputTimers.current.has(nodeId)) return;
          const timer = window.setTimeout(() => {
            if (generation !== workspaceGeneration.current || sessionEpochs.current.get(nodeId) !== epoch) return;
            outputTimers.current.delete(nodeId);
            const buffered = outputBuffers.current.get(nodeId) ?? "";
            outputBuffers.current.delete(nodeId);
            const currentOutput = `${runOutput.current.get(nodeId) ?? ""}${buffered}`.slice(-24000);
            const waiting = activeRuns.current.has(nodeId) && /(?:^|\n)\s*NEED_USER_INPUT:\s*[^\n]+/i.test(currentOutput);
            const done = activeRuns.current.has(nodeId) && /(?:^|\n)\s*FLOW_NODE_DONE\s*(?:\n|$)/i.test(currentOutput);
            runOutput.current.set(nodeId, done || waiting ? "" : currentOutput);
            if (done) activeRuns.current.delete(nodeId);
            setNodes((current) => current.map((item) => {
              if (item.id !== nodeId) return item;
              const combined = `${item.data.agentOutput ?? ""}${buffered}`.slice(-12000);
              return { ...item, data: { ...item.data, agentOutput: combined, agentStatus: done ? "connected" : waiting ? "waiting" : item.data.agentStatus === "opening" ? "connected" : item.data.agentStatus, status: done ? "success" : waiting ? "error" : item.data.status } };
            }));
            if (done && node.data.path) {
              void readNodeResults(workspace.root, node.data.path).then((results) => {
                if (generation === workspaceGeneration.current && sessionEpochs.current.get(nodeId) === epoch) patchNodeById(nodeId, { ...(results.result !== null ? { result: results.result } : {}), ...(results.conclusion !== null ? { conclusion: results.conclusion } : {}) });
              }).catch((error) => setNotice(`节点完成，但读取结果失败：${String(error)}`));
            }
          }, 120);
          outputTimers.current.set(nodeId, timer);
        },
        (exit) => {
          if (generation !== workspaceGeneration.current || sessionEpochs.current.get(nodeId) !== epoch) return;
          activeRuns.current.delete(nodeId);
          nodeSessions.current.delete(nodeId);
          if (activeNodeRef.current === nodeId) activeNodeRef.current = null;
          setNodes((current) => current.map((item) => item.id === nodeId ? { ...item, data: { ...item.data, agentSessionId: undefined, agentStatus: exit.error ? "error" : "exited", status: item.data.status === "success" && !exit.error && exit.exitCode === 0 ? "success" : "error", agentOutput: `${item.data.agentOutput ?? ""}\n[Flow Canvas] 会话${exit.error ? `异常：${exit.error}` : "已结束"}` } } : item));
        },
      );
      if (generation !== workspaceGeneration.current) { await closeAgent(result.sessionId); return; }
      nodeSessions.current.set(nodeId, result.sessionId);
      patchNodeById(nodeId, { agentSessionId: result.sessionId, agentOpenedAt: "openedAt" in result ? result.openedAt : node.data.agentOpenedAt, agentStatus: "connected" });
      if (!existing && "openedAt" in result) {
        const openedAt = result.openedAt;
        const pollCodexSession = async (attempt: number): Promise<void> => {
          if (generation !== workspaceGeneration.current || nodeSessions.current.get(nodeId) !== result.sessionId) return;
          try {
            const session = await findCodexSession(workspace.root, openedAt);
            if (session && generation === workspaceGeneration.current && nodeSessions.current.get(nodeId) === result.sessionId) { patchNodeById(nodeId, { codexSessionId: session.sessionId }); return; }
          } catch { /* WSL session metadata may not exist yet. */ }
          if (attempt < 12) window.setTimeout(() => void pollCodexSession(attempt + 1), 800);
        };
        window.setTimeout(() => void pollCodexSession(0), 900);
      }
      if (!existing) await new Promise((resolve) => window.setTimeout(resolve, 700));
      if (generation !== workspaceGeneration.current) return;
      await writeAgent(result.sessionId, new TextEncoder().encode(`${prompt}\r`));
      setNotice(`“${node.data.title}”已发送到 ${agentChoice} 的 WSL 终端`);
    } catch (error) {
      if (generation !== workspaceGeneration.current) return;
      activeRuns.current.delete(nodeId);
      patchNodeById(nodeId, { status: "error", agentStatus: "error", agentOutput: `[Flow Canvas] ${error instanceof Error ? error.message : "无法启动节点会话"}` });
      setNotice(error instanceof Error ? error.message : "无法启动节点会话");
    } finally {
      startingNodes.current.delete(nodeId);
    }
  }, [agentChoice, document, edges, inheritedContext, nodes, patchNodeById, workspace]);

  useEffect(() => {
    const onRun = (event: Event) => { const nodeId = (event as CustomEvent<{ nodeId: string }>).detail.nodeId; void runNode(nodeId); };
    const onStop = (event: Event) => {
      const nodeId = (event as CustomEvent<{ nodeId: string }>).detail.nodeId;
      const sessionId = nodeSessions.current.get(nodeId);
      if (!sessionId) return;
      activeRuns.current.delete(nodeId);
      runOutput.current.set(nodeId, "");
      void interruptAgent(sessionId);
      patchNodeById(nodeId, { status: "error", agentStatus: "waiting", agentOutput: `${nodes.find((item) => item.id === nodeId)?.data.agentOutput ?? ""}\n[Flow Canvas] 已发送 Ctrl-C，等待人工处理。` });
      setNotice("已向节点 WSL 终端发送 Ctrl-C");
    };
    const onTerminalInput = (event: Event) => {
      const { nodeId, input } = (event as CustomEvent<{ nodeId: string; input: string }>).detail;
      const sessionId = nodeSessions.current.get(nodeId);
      const target = nodes.find((node) => node.id === nodeId);
      if (sessionId && target && !target.data.pruned && effectiveAiMode(target.data) !== "off") {
        if (input.includes("\r")) {
          runOutput.current.set(nodeId, "");
          activeRuns.current.add(nodeId);
          patchNodeById(nodeId, { status: "running", agentStatus: "connected" });
        }
        void writeAgent(sessionId, new TextEncoder().encode(input)).catch((error) => setNotice(String(error)));
      }
    };
    window.addEventListener("flow-node-run", onRun);
    window.addEventListener("flow-node-stop", onStop);
    window.addEventListener("flow-node-terminal-input", onTerminalInput);
    return () => { window.removeEventListener("flow-node-run", onRun); window.removeEventListener("flow-node-stop", onStop); window.removeEventListener("flow-node-terminal-input", onTerminalInput); };
  }, [nodes, patchNodeById, runNode]);

  const runSelected = () => {
    if (selectedNode) { void runNode(selectedNode.id); return; }
    if (selectedEdge) { const target = nodes.find((node) => node.id === selectedEdge.target); if (target) void runNode(target.id); }
    else setNotice("请先选择节点");
  };
  const addNode = (kind: NodeKind = "project") => {
    if (!workspace && desktop) { setNotice("请先选择工作区"); return; }
    const id = `node-${Date.now()}`;
    const parent = selectedNode?.data.frameworkRole === "module" ? selectedNode : nodes.find((item) => item.id === selectedNode?.data.parentNodeId);
    const stage = selectedNode?.data.stage ?? "research";
    const stageDirectory = frameworkStages.find((item) => item.id === stage)?.directory ?? "research";
    const directory = `${stageDirectory}/${parent?.data.moduleId ?? "custom"}/${id}`;
    const siblings = parent ? nodes.filter((item) => item.data.parentNodeId === parent.id) : [];
    const node: FlowNode = { id, type: "flow", position: { x: parent ? 360 : 280, y: parent ? parent.position.y + 300 + siblings.length * 30 : 120 }, data: { kind, title: "自定义节点", path: directory, summary: "", goal: "", input: "", output: `${directory}/result.md\n${directory}/conclusion.md`, conclusion: "", result: "", process: "", references: "", status: "idle", aiMode: "off", stage, parentNodeId: parent?.id, moduleId: parent?.data.moduleId, frameworkRole: parent ? "stage" : undefined } };
    if (!parent) setModuleFilter("all");
    setNodes((current) => [...current, node]); setSelectedNodeId(id); setSelectedEdgeId(null); setNotice("已添加节点");
  };
  const addFramework = async () => {
    if (!workspace && desktop) { await selectWorkspace(); return; }
    try {
      if (workspace) await initializeFrameworkDirectories(workspace.root);
      const next = appendFramework(document);
      setNodes(next.nodes); setEdges(next.edges);
      setModuleFilter("all"); setSelectedNodeId("framework-design"); setSelectedEdgeId(null);
      setNotice(`基础框架已补齐，新增 ${next.nodes.length - nodes.length} 个节点`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法初始化基础框架");
    }
  };
  const save = async () => {
    if (!workspace && desktop) { await selectWorkspace(); return; }
    try { setNotice(`已保存：${await saveWorkspaceFlow(workspace?.root ?? "", document)}`); }
    catch (error) { setNotice(error instanceof Error ? error.message : "保存失败"); }
  };
  const launch = async () => {
    if (!workspace) { setNotice("请先选择工作区"); return; }
    if (!selectedNode?.data.path) { setNotice("请先为节点绑定工作区内路径"); return; }
    const plugin = plugins.find((item) => item.id === selectedNode.data.pluginId) ?? plugins[0];
    try { await openPlugin(plugin, workspace.root, selectedNode.data.path); setNotice(`已调用 ${plugin.name}`); }
    catch (error) { setNotice(error instanceof Error ? error.message : "外部工具调用失败"); }
  };
  const importResults = async () => {
    if (!workspace || !selectedNode?.data.path) { setNotice("请先选择工作区和有路径的节点"); return; }
    const generation = workspaceGeneration.current;
    try {
      const results = await readNodeResults(workspace.root, selectedNode.data.path);
      if (generation !== workspaceGeneration.current) return;
      patchNodeById(selectedNode.id, { ...(results.result !== null ? { result: results.result } : {}), ...(results.conclusion !== null ? { conclusion: results.conclusion } : {}) });
      setNotice(results.result === null && results.conclusion === null ? "此节点目录尚无 result.md 或 conclusion.md" : "已从节点目录读取结果与结论");
    } catch (error) { setNotice(String(error)); }
  };
  const markComplete = () => {
    if (!selectedNode || selectedNode.data.pruned || selectedNode.data.status === "running") return;
    if (!selectedNode.data.result?.trim() || !selectedNode.data.conclusion.trim()) { setNotice("请先填写节点结果和结论，再记录完成"); return; }
    patchNode({ status: "success" });
    setActivities((current) => [...current, { kind: "node-input", nodeId: selectedNode.id, message: `人工复核完成：${selectedNode.data.title}`, timestamp: Date.now() }]);
    setNotice("已记录节点结果、结论和完成状态");
  };
  const endSelectedSession = async () => {
    if (!selectedNode) return;
    const sessionId = nodeSessions.current.get(selectedNode.id);
    if (!sessionId) return;
    activeRuns.current.delete(selectedNode.id);
    sessionEpochs.current.set(selectedNode.id, (sessionEpochs.current.get(selectedNode.id) ?? 0) + 1);
    const timer = outputTimers.current.get(selectedNode.id);
    if (timer) window.clearTimeout(timer);
    outputTimers.current.delete(selectedNode.id);
    outputBuffers.current.delete(selectedNode.id);
    await closeAgent(sessionId);
    nodeSessions.current.delete(selectedNode.id);
    patchNodeById(selectedNode.id, { agentSessionId: undefined, agentStatus: "idle", status: selectedNode.data.status === "running" ? "idle" : selectedNode.data.status });
    setNotice("节点会话已关闭，可以调整 AI 模式和工作路径");
  };
  const pruneSelected = async () => {
    if (!selectedNode) return;
    const affected = nodes.filter((node) => node.id === selectedNode.id || node.data.parentNodeId === selectedNode.id);
    const affectedIds = new Set(affected.map((node) => node.id));
    const pruned = !selectedNode.data.pruned;
    if (affected.some((node) => node.data.status === "running" || startingNodes.current.has(node.id))) { setNotice("请先中断运行中的节点，再调整剪枝状态"); return; }
    for (const node of affected) {
      const sessionId = nodeSessions.current.get(node.id);
      if (sessionId && pruned) {
        sessionEpochs.current.set(node.id, (sessionEpochs.current.get(node.id) ?? 0) + 1);
        activeRuns.current.delete(node.id);
        await closeAgent(sessionId); nodeSessions.current.delete(node.id);
      }
    }
    setNodes((current) => current.map((node) => affectedIds.has(node.id) ? { ...node, data: { ...node.data, pruned, agentSessionId: undefined, agentStatus: "idle" } } : node));
    setActivities((current) => [...current, { kind: "node-input", nodeId: selectedNode.id, message: `${pruned ? "剪枝" : "恢复"}：${selectedNode.data.title}`, timestamp: Date.now() }]);
    setNotice(pruned ? "节点已剪枝，保留目录、结果和连接记录" : "节点已恢复");
  };
  const moduleNodes = nodes.filter((node) => node.data.frameworkRole === "module");
  const filteredNodes = nodes.filter((node) => (!search.trim() || `${node.data.title} ${node.data.path} ${node.data.goal ?? node.data.summary}`.toLowerCase().includes(search.toLowerCase())) && (moduleFilter === "all" || node.data.moduleId === moduleFilter));
  const visibleIds = new Set(filteredNodes.map((node) => node.id));
  const visibleKey = filteredNodes.map((node) => node.id).join(",");
  useEffect(() => {
    const timer = window.setTimeout(() => void fitView({ padding: 0.12, duration: 200 }), 60);
    return () => window.clearTimeout(timer);
  }, [visibleKey, fitView]);
  const selectNode = (node: FlowNode) => {
    setSelectedNodeId(node.id); setSelectedEdgeId(null);
    if (node.data.moduleId) setModuleFilter(node.data.moduleId);
  };

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><GitBranch size={19} /></div><div><strong>Flow Canvas</strong><span>项目关系与处理编排</span></div></div>
      <div className="flow-title"><input value={flowName} onChange={(event) => setFlowName(event.target.value)} aria-label="画布名称" /><span>.flow.json</span></div>
      <div className="top-actions"><button className="workspace-button" title="打开画布文档(.canvas / .flow.json),进入只读的文档模式" onClick={() => { void chooseDocumentFile().then((picked) => { if (picked) { appLog.info(`[startup] 手动打开画布文档:${picked}`); onOpenDocument(picked); } }).catch((error) => { const message = String(error); appLog.error(`[startup] 文档选择器失败:${message}`); setNotice(`文档选择器打开失败:${message}`); }); }}><Network size={15} /><span>画布文档</span></button><button className="workspace-button" title="切换工作区" onClick={selectWorkspace}><FolderCog size={16} /><span>{workspace?.name ?? "选择工作区"}</span></button><button className="icon-button" title="立即保存到工作区" onClick={save}><Save size={17} /></button><span className="divider" /><button className="avatar-button" title="本地工作区">W</button></div>
    </header>
    <div className="workspace">
      <aside className="left-rail">
        <div className="rail-heading"><span>工作区</span><button className="small-icon" title="新建节点" onClick={() => addNode()}><Plus size={16} /></button></div>
        <div className="search-box"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索节点与路径" /></div>
        <div className="rail-section framework-tree"><div className="section-label">基础框架 <span>{moduleNodes.length} 个模块</span></div>
          {moduleNodes.map((module) => <div className="framework-tree-group" key={module.id}>
            <button className={`framework-tree-heading ${selectedNodeId === module.id ? "active" : ""}`} onClick={() => selectNode(module)}><Layers3 size={14} /><span>{module.data.title}</span><small>{nodes.filter((node) => node.data.parentNodeId === module.id && node.data.status === "success").length}/{nodes.filter((node) => node.data.parentNodeId === module.id).length}</small></button>
            {nodes.filter((node) => node.data.parentNodeId === module.id).map((node) => <button key={node.id} className={`framework-child ${selectedNodeId === node.id ? "active" : ""} ${node.data.pruned ? "is-pruned" : ""}`} onClick={() => selectNode(node)}><span>{node.data.stage ? stageLabels[node.data.stage] : node.data.title}</span><small>AI {aiModeLabels[effectiveAiMode(node.data)]}</small><span className={`list-dot ${node.data.status}`} /></button>)}
          </div>)}
          {nodes.filter((node) => !node.data.frameworkRole).map((node) => <button className={`node-list-item ${selectedNodeId === node.id ? "active" : ""}`} key={node.id} onClick={() => { setModuleFilter("all"); selectNode(node); }}><Layers3 size={14} /><span><b>{node.data.title}</b><small>{node.data.path}</small></span></button>)}
        </div>
        <div className="rail-section"><div className="section-label">插件 <span>{plugins.length}</span></div>{plugins.map((plugin) => <div className="plugin-row" key={plugin.id}><span className="plugin-icon"><SquareTerminal size={14} /></span><span><b>{plugin.name}</b><small>{plugin.description}</small></span></div>)}</div>
        <div className="rail-section file-records"><div className="section-label">工作区文件 <span>{workspaceFiles.length}</span></div>{workspaceFiles.slice(-8).reverse().map((file) => <div className={`file-record ${file.status ?? "present"}`} key={file.path}><FilePlus2 size={12} /><span title={file.path}>{file.path}</span></div>)}{workspaceFiles.length === 0 && <div className="file-record-empty">等待文件扫描</div>}</div>
        <div className="left-footer"><button onClick={selectWorkspace}><Settings2 size={15} />切换工作区</button><div className={`connection ${workspace ? "" : "offline"}`}><span />{workspace ? workspace.root : "尚未选择工作区"}</div></div>
      </aside>
      <main className="canvas-area">
        <div className="canvas-toolbar"><div className="toolbar-group"><button className="tool-button active" title="选择工具"><MousePointer2 size={16} /></button><button className="tool-button" title="添加子节点" onClick={() => addNode("operation")}><Plus size={16} /></button><button className="tool-button" title="适应画布" onClick={() => void fitView({ padding: 0.12, duration: 200 })}><Layers3 size={16} /></button><div className="ai-selector"><Bot size={15} /><select aria-label="选择 AI" value={agentChoice} onChange={(event) => { const next = event.target.value as "none" | "codex_micu"; setAgentChoice(next); if (next === "none") void stopAgent(); }}><option value="none">不使用 AI</option><option value="codex_micu">Codex · WSL codex_micu</option></select></div></div><div className="toolbar-group"><button className="action-button" onClick={addFramework}><Layers3 size={15} />补齐基础框架</button><button className="action-button primary" disabled={!selectedNode || !!nodeRunBlocker(selectedNode.data)} onClick={runSelected}><Play size={15} />执行节点</button></div></div>
        <div className="framework-guide"><label>当前模块 <select aria-label="当前模块" value={moduleFilter} onChange={(event) => { setModuleFilter(event.target.value); setSelectedNodeId(null); setSelectedEdgeId(null); }}><option value="all">全部模块</option>{moduleNodes.map((node) => <option key={node.id} value={node.data.moduleId}>{node.data.title}</option>)}</select></label><span>调研 / 测试 / 执行（并行）→ 结果与结论</span><span>{desktop ? workspace?.root ?? "请选择工作路径" : "浏览器预览 · 真实执行请使用桌面版"}</span></div>
        <div className="canvas-wrap"><ReactFlow nodes={nodes.map((node) => ({ ...node, selected: node.id === selectedNodeId, hidden: !visibleIds.has(node.id) }))} edges={edges.map((edge) => ({ ...edge, hidden: !visibleIds.has(edge.source) || !visibleIds.has(edge.target) }))} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} deleteKeyCode={null} connectionLineType={ConnectionLineType.SmoothStep} onNodeClick={(_, node) => { setSelectedNodeId(node.id); setSelectedEdgeId(null); }} onEdgeClick={(_, edge) => { setSelectedEdgeId(edge.id); setSelectedNodeId(null); }} onPaneClick={() => { setSelectedNodeId(null); setSelectedEdgeId(null); }} fitView fitViewOptions={{ padding: 0.12 }} minZoom={0.15} maxZoom={1.5}><Background color="#263342" gap={24} size={1} /><Controls showInteractive={false} /><MiniMap pannable zoomable nodeColor={(node) => ({ project: "#5b8def", artifact: "#d78b62", operation: "#8d7be2", conclusion: "#55aa86", reference: "#c0a468", note: "#c8b06a" }[node.data?.kind as NodeKind] ?? "#738196")} /></ReactFlow>{desktop && workspaceLoaded && !workspace && <div className="workspace-empty"><div><FolderCog size={22} /></div><h2>建立分析工作区</h2><p>选择工作路径，自动生成五个模块与四类阶段目录。</p><button className="action-button primary" onClick={selectWorkspace}><FolderOpen size={15} />选择工作路径</button></div>}</div>
        <AgentPanel key={workspace?.root ?? "preview"} nodes={nodes.filter((node) => node.data.agentSessionId || node.data.agentOutput || node.id === terminalNodeId)} selectedNodeId={terminalNodeId} onClose={() => setTerminalNodeId(null)} onSelectNode={(nodeId) => { setTerminalNodeId(nodeId); const node = nodes.find((item) => item.id === nodeId); if (node) selectNode(node); }} />
        <div className="statusbar"><span><Activity size={14} />{notice}</span><span>{workspace?.flowPath ?? `${nodes.length} 个节点 · ${edges.length} 条连接`} · 已记录 {workspaceFiles.length} 个文件</span></div>
      </main>
      <Inspector node={selectedNode} edge={selectedEdge} workspace={workspace} patchNode={patchNode} patchEdge={patchEdge} onChoosePath={chooseNodeDirectory} onLaunch={launch} onRun={runSelected} onReadResults={importResults} onComplete={markComplete} onPrune={pruneSelected} onEndSession={endSelectedSession} onTerminal={() => setTerminalNodeId(selectedNodeId)} onDelete={() => { if (selectedNode) { void pruneSelected(); } else if (selectedEdgeId) { setEdges((current) => current.filter((edge) => edge.id !== selectedEdgeId)); setSelectedEdgeId(null); } }} />
    </div>
  </div>;
}

function Inspector({ node, edge, workspace, patchNode, patchEdge, onChoosePath, onLaunch, onRun, onReadResults, onComplete, onPrune, onTerminal, onEndSession, onDelete }: { node: FlowNode | null; edge: FlowEdge | null; workspace: WorkspaceSnapshot | null; patchNode: (patch: Partial<FlowNodeData>) => void; patchEdge: (patch: Partial<FlowEdgeData>) => void; onChoosePath: () => void; onLaunch: () => void; onRun: () => void; onReadResults: () => void; onComplete: () => void; onPrune: () => void; onTerminal: () => void; onEndSession: () => void; onDelete: () => void }) {
  if (edge) { const data = edge.data ?? defaultEdgeData; return <aside className="inspector"><InspectorHeader icon={<Link2 size={16} />} title="连接详情" subtitle={`${edge.source} → ${edge.target}`} onDelete={onDelete} /><div className="inspector-body"><Field label="关系"><select value={data.relation} onChange={(event) => patchEdge({ relation: event.target.value as Relation })}>{Object.entries(relationLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field><Field label="处理方式" hint="这段文字是人类可读的执行意图，不会直接作为 shell 命令运行"><textarea rows={6} value={data.instruction} onChange={(event) => patchEdge({ instruction: event.target.value })} /></Field><Field label="期望输出"><input value={data.expectedOutput} onChange={(event) => patchEdge({ expectedOutput: event.target.value })} placeholder="例如：validated.csv" /></Field><Field label="证据与日志"><input value={data.evidence} onChange={(event) => patchEdge({ evidence: event.target.value })} placeholder="例如：logs/run.txt" /></Field><Field label="运行策略"><div className="segmented"><button className={data.runPolicy === "manual" ? "active" : ""} onClick={() => patchEdge({ runPolicy: "manual" })}>手动</button><button className={data.runPolicy === "confirm" ? "active" : ""} onClick={() => patchEdge({ runPolicy: "confirm" })}>执行前确认</button></div></Field></div></aside>; }
  if (node) {
    const busy = node.data.status === "running" || node.data.agentStatus === "opening";
    return <aside className="inspector">
      <div className="inspector-header"><div className="inspector-title"><span><Layers3 size={16} /></span><div><b>{node.data.frameworkRole === "module" ? "模块目标" : "节点详情"}</b><small>{node.data.stage ? stageLabels[node.data.stage] : kindLabels[node.data.kind]}</small></div></div><StatusPill status={node.data.status} /></div>
      <div className="inspector-body">
        <Field label="节点名称"><input value={node.data.title} disabled={busy} onChange={(event) => patchNode({ title: event.target.value })} /></Field>
        <Field label="节点目标" hint="描述本节点要完成什么，以及怎样判断完成。"><textarea rows={4} value={node.data.goal ?? node.data.summary} disabled={busy} onChange={(event) => patchNode({ goal: event.target.value })} /></Field>
        <Field label="节点 AI"><select value={effectiveAiMode(node.data)} disabled={busy || !!node.data.agentSessionId} onChange={(event) => patchNode({ aiMode: event.target.value as AiMode })}><option value="off">关闭 · 手工处理</option><option value="assist">辅助 · 调研与建议</option><option value="auto">执行 · 完成节点目标</option></select></Field>
        <div className="inspector-note">{effectiveAiMode(node.data) === "off" ? "填写节点结果和结论后，可手动记录完成。" : effectiveAiMode(node.data) === "assist" ? "AI 提供调研、解释与方案建议，建议内容写入节点目录。" : "点击执行后，将目标、模块上下文和输入发送到该节点的独立终端。"}</div>
        <button className="launch-button" disabled={!!nodeRunBlocker(node.data)} onClick={onRun}><Play size={14} />执行节点目标</button>
        <div className="inspector-actions"><button className="action-button" onClick={onTerminal}><SquareTerminal size={13} />查看终端</button><button className="action-button" disabled={busy} onClick={onPrune}>{node.data.pruned ? "恢复节点" : "剪枝节点"}</button></div>
        {node.data.agentSessionId && <button className="action-button" onClick={onEndSession}>关闭节点会话</button>}
        <Field label="工作区内路径" hint={workspace?.root ?? "相对路径以所选工作区为根"}><div className="input-with-action"><input value={node.data.path} disabled={busy || !!node.data.agentSessionId} onChange={(event) => patchNode({ path: event.target.value })} placeholder="例如 research/design" /><button title="选择目录" disabled={busy || !!node.data.agentSessionId} onClick={onChoosePath}><FolderOpen size={15} /></button></div></Field>
        {node.data.frameworkRole === "module" && <div className="framework-paths">{frameworkStages.map((stage) => <div key={stage.id}>{stage.directory}/{node.data.moduleId}/</div>)}</div>}
        {!node.data.frameworkRole && <Field label="节点类型"><select value={node.data.kind} disabled={busy} onChange={(event) => patchNode({ kind: event.target.value as NodeKind })}>{Object.entries(kindLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field>}
        <div className="field-grid"><Field label="输入"><textarea rows={3} value={node.data.input} disabled={busy} onChange={(event) => patchNode({ input: event.target.value })} /></Field><Field label="输出路径"><textarea rows={3} value={node.data.output} disabled={busy} onChange={(event) => patchNode({ output: event.target.value })} /></Field></div>
        <Field label="处理方式"><textarea rows={3} value={node.data.process} disabled={busy} onChange={(event) => patchNode({ process: event.target.value })} /></Field>
        <Field label="参考"><textarea rows={2} value={node.data.references} disabled={busy} onChange={(event) => patchNode({ references: event.target.value })} placeholder="每行一个文件或链接" /></Field>
        <Field label="节点结果"><textarea rows={4} value={node.data.result ?? ""} onChange={(event) => patchNode({ result: event.target.value })} placeholder="产物、指标、检查结果" /></Field>
        <Field label="节点结论"><textarea rows={4} value={node.data.conclusion} onChange={(event) => patchNode({ conclusion: event.target.value })} placeholder="结论、采用依据、下一步和未解决问题" /></Field>
        <div className="inspector-actions"><button className="action-button" disabled={!workspace || !node.data.path || busy} onClick={onReadResults}>读取目录结果</button><button className="action-button" disabled={busy || !!node.data.pruned} onClick={onComplete}><Check size={13} />记录完成</button></div>
        <Field label="外部插件"><select value={node.data.pluginId ?? ""} onChange={(event) => patchNode({ pluginId: event.target.value })}><option value="">不指定</option>{plugins.map((plugin) => <option value={plugin.id} key={plugin.id}>{plugin.name}</option>)}</select></Field>
        <button className="launch-button" disabled={!workspace || !node.data.path} onClick={onLaunch}><FolderOpen size={15} />打开外部工具</button>
      </div>
    </aside>;
  }
  return <aside className="inspector empty-inspector"><div className="empty-icon"><MousePointer2 size={20} /></div><h3>选择一个节点或连接</h3><p>在画布中点击对象，查看输入、输出、结论、处理方式和参考。</p><button onClick={() => undefined}><Info size={15} />使用说明</button></aside>;
}

function InspectorHeader({ icon, title, subtitle, onDelete }: { icon: React.ReactNode; title: string; subtitle: string; onDelete: () => void }) { return <div className="inspector-header"><div className="inspector-title"><span>{icon}</span><div><b>{title}</b><small>{subtitle}</small></div></div><button className="small-icon danger" title="删除" onClick={onDelete}><Trash2 size={15} /></button></div>; }
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) { return <label className="field"><span>{label}</span>{hint && <em>{hint}</em>}{children}</label>; }

import { startupDocumentArg } from "./backend";
import { DocumentMode } from "./document-mode";
import { appLog } from "./logger";

function Root() {
  const [mode, setMode] = useState<"pending" | "workspace" | "document">("pending");
  const [documentPath, setDocumentPath] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      if ("__TAURI_INTERNALS__" in window) {
        try {
          const arg = await startupDocumentArg();
          if (arg && /\.(canvas|flow\.json)$/i.test(arg.trim())) {
            appLog.info(`[startup] 文档模式启动:${arg.trim()}`);
            setDocumentPath(arg.trim());
            setMode("document");
            return;
          }
        } catch { /* 启动参数不可用时回退工作区模式 */ }
      }
      setMode("workspace");
    })();
  }, []);
  if (mode === "pending") return null;
  if (mode === "document") {
    return <ReactFlowProvider><DocumentMode initialPath={documentPath} onExit={() => setMode("workspace")} /></ReactFlowProvider>;
  }
  return <ReactFlowProvider><App onOpenDocument={(picked) => { setDocumentPath(picked); setMode("document"); }} /></ReactFlowProvider>;
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("应用根节点不存在");
createRoot(rootElement).render(<Root />);
