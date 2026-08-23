import {
  Background, BaseEdge, ConnectionLineType, Controls, EdgeLabelRenderer, MiniMap, Position,
  ReactFlow, ReactFlowProvider, getBezierPath, useEdgesState, useNodesState, type Connection,
  type EdgeProps, type NodeProps, Handle, MarkerType,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, ArrowRight, BookOpen, Bot, Check, Copy, FilePlus2, FolderCog, FolderOpen, GitBranch, Hammer, Info, Layers3, Link2, MousePointer2, Play, Plus, Power, Save, Search, Settings2, SquareTerminal, Trash2, Square } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xyflow/react/dist/style.css";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { chooseDirectory, closeAgent, findCodexSession, interruptAgent, openAgent, openPlugin, openWorkspace, saveWorkspaceFlow, scanWorkspace, startupWorkspace, validateWorkspaceTarget, writeAgent, type AgentData } from "./backend";
import { demoFlow, plugins } from "./data";
import type { FlowDocument, FlowEdge, FlowEdgeData, FlowNode, FlowNodeData, NodeKind, Relation, WorkspaceActivity, WorkspaceFileRecord, WorkspaceSnapshot } from "./types";

const nodeIcons: Record<NodeKind, typeof Layers3> = { project: FolderOpen, artifact: FilePlus2, operation: Hammer, conclusion: Check, reference: BookOpen };
const kindLabels: Record<NodeKind, string> = { project: "项目", artifact: "产物", operation: "处理", conclusion: "结论", reference: "参考" };
const relationLabels: Record<Relation, string> = { transforms: "转换", depends_on: "依赖", supports: "支持", contradicts: "冲突" };
const defaultEdgeData: FlowEdgeData = { relation: "transforms", instruction: "描述这条连接如何处理输入。", expectedOutput: "", evidence: "", runPolicy: "confirm" };
const WORKSPACE_STORAGE_KEY = "flow-canvas.workspace.v1";

function stripTerminalCodes(value: string): string {
  return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function joinWorkspacePath(root: string, value: string): string {
  const clean = value.trim().replace(/^['"]|['"]$/g, "");
  if (!clean) return "";
  if (/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(clean)) return clean;
  return `${root.replace(/[\\/]$/, "")}\\${clean.replace(/^[/\\]/, "")}`;
}

function outputCandidates(value: string): string[] {
  return value.split(/[\n,，;；]+/).map((item) => item.trim()).filter(Boolean);
}

function workspaceFlow(workspace: WorkspaceSnapshot): FlowDocument {
  return {
    schemaVersion: 1,
    name: `${workspace.name} 工作流`,
    nodes: [{
      id: "workspace-root", type: "flow", position: { x: 170, y: 170 },
      data: { kind: "project", title: workspace.name, path: workspace.root, summary: "当前工作区根目录", input: "", output: ".flow-canvas/", conclusion: "", process: "所有 Flow 文件、日志与产物均保存在当前工作区内。", references: "", pluginId: "folder", status: "idle" },
    }],
    edges: [], files: [], activities: [],
  };
}

function NodeTerminal({ nodeId, data, active }: { nodeId: string; data: FlowNodeData; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  useEffect(() => {
    if (!active || !host.current || terminalRef.current) return;
    const terminal = new Terminal({
      cursorBlink: true, convertEol: true, scrollback: 1200,
      fontFamily: "Cascadia Mono, Consolas, monospace", fontSize: 10,
      theme: { background: "#0b121b", foreground: "#cbd8e8", cursor: "#83aaff", selectionBackground: "#29456b" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    requestAnimationFrame(() => fit.fit());
    if (data.agentOutput) terminal.write(data.agentOutput.replace(/\n/g, "\r\n"));
    const outputListener = (event: Event) => {
      const detail = (event as CustomEvent<{ nodeId: string; data: number[] }>).detail;
      if (detail.nodeId === nodeId) terminal.write(Uint8Array.from(detail.data));
    };
    const inputListener = (value: string) => window.dispatchEvent(new CustomEvent("flow-node-terminal-input", { detail: { nodeId, input: value } }));
    const dataDisposable = terminal.onData(inputListener);
    window.addEventListener("flow-node-output", outputListener);
    terminalRef.current = terminal;
    return () => { dataDisposable.dispose(); window.removeEventListener("flow-node-output", outputListener); terminal.dispose(); terminalRef.current = null; };
  }, [active, nodeId]);
  return <div className={`node-terminal ${active ? "active" : ""}`} ref={host} />;
}

function FlowNodeCard({ id, data, selected }: NodeProps<FlowNode>) {
  const Icon = nodeIcons[data.kind];
  const agentActive = data.agentStatus === "connected" || data.agentStatus === "opening" || data.agentStatus === "waiting";
  const runNode = (event: React.MouseEvent) => { event.stopPropagation(); window.dispatchEvent(new CustomEvent("flow-node-run", { detail: { nodeId: id } })); };
  const stopNode = (event: React.MouseEvent) => { event.stopPropagation(); window.dispatchEvent(new CustomEvent("flow-node-stop", { detail: { nodeId: id } })); };
  const sendNodeInput = (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); event.stopPropagation(); const input = new FormData(event.currentTarget).get("node-input")?.toString() ?? ""; if (input.trim()) { window.dispatchEvent(new CustomEvent("flow-node-input", { detail: { nodeId: id, input } })); event.currentTarget.reset(); } };
  return <div className={`flow-node-card kind-${data.kind} ${selected ? "is-selected" : ""} ${data.status === "error" ? "needs-attention" : ""}`}>
    <Handle className="flow-handle input-handle" type="target" position={Position.Left} id="in" title="输入连接点" />
    <Handle className="flow-handle input-handle" type="target" position={Position.Top} id="in-top" title="输入连接点" />
    <div className="node-card-surface">
      <div className="node-accent" />
      <div className="node-card-head"><span className="node-icon"><Icon size={15} /></span><span className="node-kind">{kindLabels[data.kind]}</span><StatusPill status={data.status} /></div>
      <h3>{data.title}</h3>
      <p className="node-path">{data.path || "未绑定本地路径"}</p>
      <p className="node-summary">{data.summary}</p>
      <div className="node-io"><span><b>输入</b>{data.input || "—"}</span><ArrowRight size={13} /><span><b>输出</b>{data.output || "—"}</span></div>
      <div className="node-agent-head"><span><Bot size={11} />{data.agentStatus === "waiting" ? "等待人工处理" : data.agentStatus === "connected" ? "WSL Codex 终端" : "节点终端"}</span><span className="node-agent-actions"><button className="node-run-button" onClick={runNode} title="发送拼接后的 Flow 提示词"><Play size={11} /></button>{agentActive && <button className="node-stop-button" onClick={stopNode} title="发送 Ctrl-C，中断当前任务但保留终端"><Square size={10} /></button>}</span></div>
      {data.codexSessionId && <div className="node-session-id" title={`codex_micu resume ${data.codexSessionId}`}><span>会话</span><code>{data.codexSessionId}</code><button onClick={(event) => { event.stopPropagation(); void navigator.clipboard?.writeText(`codex_micu resume ${data.codexSessionId}`); }} title="复制 resume 命令"><Copy size={10} /></button></div>}
      <NodeTerminal nodeId={id} data={data} active={agentActive} />
      {agentActive && <form className="node-agent-input" onSubmit={sendNodeInput}><input name="node-input" placeholder="需要人工输入时在这里回复" onClick={(event) => event.stopPropagation()} /><button title="发送人工回复"><ArrowRight size={11} /></button></form>}
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

const nodeTypes = { flow: FlowNodeCard };
const edgeTypes = { flow: FlowEdgeView };

function App() {
  const desktop = "__TAURI_INTERNALS__" in window;
  const initial = desktop ? { name: "未选择工作区", nodes: [] as FlowNode[], edges: [] as FlowEdge[] } : demoFlow;
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>(initial.edges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(desktop ? null : "operation-model");
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
  const textDecoder = useRef(new TextDecoder());
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
    const sessions = [...nodeSessions.current.values()];
    nodeSessions.current.clear();
    await Promise.all(sessions.map((sessionId) => closeAgent(sessionId)));
    setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, agentSessionId: undefined, agentOpenedAt: undefined, agentStatus: "idle" } })));
  }, [setNodes]);

  useEffect(() => () => { void stopAgent(); }, [stopAgent]);

  const applyWorkspace = useCallback((snapshot: WorkspaceSnapshot) => {
    const next = snapshot.document ?? workspaceFlow(snapshot);
    setWorkspace(snapshot);
    fileBaseline.current.clear();
    setNodes(next.nodes);
    setEdges(next.edges);
    setFlowName(next.name);
    setWorkspaceFiles(next.files ?? []);
    setActivities(next.activities ?? []);
    setSelectedNodeId(next.nodes[0]?.id ?? null);
    setSelectedEdgeId(null);
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
        setWorkspace((current) => current ? { ...current, flowPath } : current);
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
    const predecessors = incoming.map((edge) => nodes.find((node) => node.id === edge.source)).filter((node): node is FlowNode => !!node);
    const successors = outgoing.map((edge) => nodes.find((node) => node.id === edge.target)).filter((node): node is FlowNode => !!node);
    const inputs = predecessors.flatMap((node) => {
      const outputs = outputCandidates(node.data.output).map((value) => joinWorkspacePath(workspace.root, value));
      return outputs.length ? outputs : [node.data.path].filter(Boolean);
    });
    return { input: [...new Set(inputs)].join("\n"), predecessors, successors };
  }, [edges, nodes, workspace]);

  const runNode = useCallback(async (nodeId: string) => {
    const node = nodes.find((item) => item.id === nodeId);
    if (!node || !workspace) { setNotice("请先选择工作区和节点"); return; }
    if (agentChoice === "none") { setNotice("请先在工具栏选择 AI"); return; }
    const context = inheritedContext(nodeId);
    const inheritedInput = context.input || node.data.input || node.data.path || workspace.root;
    const incomingInstructions = edges.filter((edge) => edge.target === nodeId).map((edge) => edge.data?.instruction).filter(Boolean).join("\n");
    const prompt = [
      "你正在由 Flow Canvas 执行一个节点。先读取工作区内 .flow-canvas/flow.json，理解完整 Flow 链及前后关系。",
      `当前节点 ID：${node.id}`,
      `当前节点：${node.data.title}`,
      `节点职责：${node.data.summary}`,
      `节点处理方式：${node.data.process || incomingInstructions || "按节点职责处理"}`,
      `继承输入：\n${inheritedInput}`,
      `前置节点：${context.predecessors.map((item) => `${item.data.title}(${item.data.output || item.data.path || "无输出"})`).join("；") || "无"}`,
      `后续节点：${context.successors.map((item) => item.data.title).join("；") || "无"}`,
      `期望输出：${node.data.output || "根据任务生成到当前工作区内"}`,
      "所有读取、写入和命令必须限制在当前工作区。执行过程中若需要人工确认或输入，请明确输出 NEED_USER_INPUT: 后跟原因并停止等待。完成后简洁输出 FLOW_NODE_DONE。",
    ].join("\n\n");
    activeNodeRef.current = nodeId;
    patchNodeById(nodeId, { status: "running", agentStatus: nodeSessions.current.has(nodeId) ? "connected" : "opening", inheritedInput, input: inheritedInput, agentOutput: node.data.agentOutput ?? "" });
    setActivities((existing) => [...existing, { kind: "node-run", message: `执行节点：${node.data.title}`, nodeId, timestamp: Date.now() } satisfies WorkspaceActivity].slice(-120));
    try {
      const existing = nodeSessions.current.get(nodeId);
      const result = existing ? { sessionId: existing } : await openAgent(workspace.root, agentChoice, 18, 82,
        (data: AgentData) => {
          const bytes = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data);
          const output = stripTerminalCodes(textDecoder.current.decode(bytes, { stream: true }));
          window.dispatchEvent(new CustomEvent("flow-node-output", { detail: { nodeId, data: Array.from(bytes) } }));
          if (!output) return;
          setNodes((current) => current.map((item) => {
            if (item.id !== nodeId) return item;
            const combined = `${item.data.agentOutput ?? ""}${output}`.slice(-12000);
            const waiting = /NEED_USER_INPUT:|press enter|\[[yYnN]\/[^\]]+\]|confirm|需要.*(?:确认|输入|选择)/i.test(combined);
            const done = /FLOW_NODE_DONE/i.test(combined);
            return { ...item, data: { ...item.data, agentOutput: combined, agentStatus: waiting ? "waiting" : item.data.agentStatus === "opening" ? "connected" : item.data.agentStatus, status: waiting ? "error" : done ? "success" : "running" } };
          }));
        },
        (exit) => {
          nodeSessions.current.delete(nodeId);
          if (activeNodeRef.current === nodeId) activeNodeRef.current = null;
          setNodes((current) => current.map((item) => item.id === nodeId ? { ...item, data: { ...item.data, agentSessionId: undefined, agentStatus: exit.error ? "error" : "exited", status: item.data.status === "error" ? "error" : exit.error ? "error" : "success", agentOutput: `${item.data.agentOutput ?? ""}\n[Flow Canvas] 会话${exit.error ? `异常：${exit.error}` : "已结束"}` } } : item));
        },
      );
      nodeSessions.current.set(nodeId, result.sessionId);
      patchNodeById(nodeId, { agentSessionId: result.sessionId, agentOpenedAt: "openedAt" in result ? result.openedAt : node.data.agentOpenedAt, agentStatus: "connected" });
      if (!existing && "openedAt" in result) {
        const openedAt = result.openedAt;
        const pollCodexSession = async (attempt: number): Promise<void> => {
          try {
            const session = await findCodexSession(workspace.root, openedAt);
            if (session) { patchNodeById(nodeId, { codexSessionId: session.sessionId }); return; }
          } catch { /* WSL session metadata may not exist yet. */ }
          if (attempt < 12) window.setTimeout(() => void pollCodexSession(attempt + 1), 800);
        };
        window.setTimeout(() => void pollCodexSession(0), 900);
      }
      window.setTimeout(() => void writeAgent(result.sessionId, new TextEncoder().encode(`${prompt}\r`)), existing ? 0 : 700);
      setNotice(`“${node.data.title}”已发送到 ${agentChoice} 的 WSL 终端`);
    } catch (error) {
      patchNodeById(nodeId, { status: "error", agentStatus: "error", agentOutput: `[Flow Canvas] ${error instanceof Error ? error.message : "无法启动节点会话"}` });
      setNotice(error instanceof Error ? error.message : "无法启动节点会话");
    }
  }, [agentChoice, edges, inheritedContext, nodes, patchNodeById, workspace]);

  useEffect(() => {
    const onRun = (event: Event) => { const nodeId = (event as CustomEvent<{ nodeId: string }>).detail.nodeId; void runNode(nodeId); };
    const onStop = (event: Event) => {
      const nodeId = (event as CustomEvent<{ nodeId: string }>).detail.nodeId;
      const sessionId = nodeSessions.current.get(nodeId);
      if (!sessionId) return;
      void interruptAgent(sessionId);
      patchNodeById(nodeId, { status: "error", agentStatus: "waiting", agentOutput: `${nodes.find((item) => item.id === nodeId)?.data.agentOutput ?? ""}\n[Flow Canvas] 已发送 Ctrl-C，等待人工处理。` });
      setNotice("已向节点 WSL 终端发送 Ctrl-C");
    };
    const onInput = (event: Event) => {
      const { nodeId, input } = (event as CustomEvent<{ nodeId: string; input: string }>).detail;
      const sessionId = nodeSessions.current.get(nodeId);
      if (!sessionId) { setNotice("该节点 AI 会话已结束，请重新执行"); return; }
      void writeAgent(sessionId, new TextEncoder().encode(`${input}\r`));
      patchNodeById(nodeId, { status: "running", agentStatus: "connected" });
      setActivities((existing) => [...existing, { kind: "node-input", message: "发送人工输入", nodeId, timestamp: Date.now() } satisfies WorkspaceActivity].slice(-120));
    };
    const onTerminalInput = (event: Event) => {
      const { nodeId, input } = (event as CustomEvent<{ nodeId: string; input: string }>).detail;
      const sessionId = nodeSessions.current.get(nodeId);
      if (sessionId) void writeAgent(sessionId, new TextEncoder().encode(input));
    };
    window.addEventListener("flow-node-run", onRun);
    window.addEventListener("flow-node-stop", onStop);
    window.addEventListener("flow-node-input", onInput);
    window.addEventListener("flow-node-terminal-input", onTerminalInput);
    return () => { window.removeEventListener("flow-node-run", onRun); window.removeEventListener("flow-node-stop", onStop); window.removeEventListener("flow-node-input", onInput); window.removeEventListener("flow-node-terminal-input", onTerminalInput); };
  }, [nodes, patchNodeById, runNode]);

  const runSelected = () => {
    if (selectedNode) { void runNode(selectedNode.id); return; }
    if (selectedEdge) { const target = nodes.find((node) => node.id === selectedEdge.target); if (target) void runNode(target.id); }
    else setNotice("请先选择节点");
  };
  const addNode = (kind: NodeKind = "project") => {
    if (!workspace && desktop) { setNotice("请先选择工作区"); return; }
    const id = `node-${Date.now()}`;
    const node: FlowNode = { id, type: "flow", position: { x: 280 + Math.random() * 360, y: 120 + Math.random() * 300 }, data: { kind, title: kindLabels[kind] + "节点", path: "", summary: "填写这个节点在流程中的职责。", input: "", output: "", conclusion: "", process: "", references: "", status: "idle" } };
    setNodes((current) => [...current, node]); setSelectedNodeId(id); setSelectedEdgeId(null); setNotice("已添加节点");
  };
  const addProject = async () => {
    if (!workspace) { if (desktop) await selectWorkspace(); else addNode("project"); return; }
    const selected = await chooseDirectory(workspace.root);
    if (!selected) return;
    try {
      const path = await validateWorkspaceTarget(workspace.root, selected);
      const name = path.split(/[\\/]/).filter(Boolean).pop() || "项目文件夹";
      const id = `project-${Date.now()}`;
      const node: FlowNode = { id, type: "flow", position: { x: 180, y: 160 }, data: { kind: "project", title: name, path, summary: "当前工作区内的项目文件夹", input: "", output: "", conclusion: "", process: "", references: "", pluginId: "folder", status: "idle" } };
      setNodes((current) => [...current, node]); setSelectedNodeId(id); setSelectedEdgeId(null); setNotice(`已添加项目：${name}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "只能添加当前工作区内的目录");
    }
  };
  const save = async () => {
    if (!workspace) { await selectWorkspace(); return; }
    try { setNotice(`已保存：${await saveWorkspaceFlow(workspace.root, document)}`); }
    catch (error) { setNotice(error instanceof Error ? error.message : "保存失败"); }
  };
  const launch = async () => {
    if (!workspace) { setNotice("请先选择工作区"); return; }
    if (!selectedNode?.data.path) { setNotice("请先为节点绑定工作区内路径"); return; }
    const plugin = plugins.find((item) => item.id === selectedNode.data.pluginId) ?? plugins[0];
    try { await openPlugin(plugin, workspace.root, selectedNode.data.path); setNotice(`已调用 ${plugin.name}`); }
    catch (error) { setNotice(error instanceof Error ? error.message : "外部工具调用失败"); }
  };
  const filteredNodes = search.trim() ? nodes.filter((node) => `${node.data.title} ${node.data.path} ${node.data.summary}`.toLowerCase().includes(search.toLowerCase())) : nodes;

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><GitBranch size={19} /></div><div><strong>Flow Canvas</strong><span>项目关系与处理编排</span></div></div>
      <div className="flow-title"><input value={flowName} onChange={(event) => setFlowName(event.target.value)} aria-label="画布名称" /><span>.flow.json</span></div>
      <div className="top-actions"><button className="workspace-button" title="切换工作区" onClick={selectWorkspace}><FolderCog size={16} /><span>{workspace?.name ?? "选择工作区"}</span></button><button className="icon-button" title="立即保存到工作区" onClick={save}><Save size={17} /></button><span className="divider" /><button className="avatar-button" title="本地工作区">W</button></div>
    </header>
    <div className="workspace">
      <aside className="left-rail">
        <div className="rail-heading"><span>工作区</span><button className="small-icon" title="新建节点" onClick={() => addNode()}><Plus size={16} /></button></div>
        <div className="search-box"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索节点与路径" /></div>
        <div className="rail-section"><div className="section-label">节点 <span>{filteredNodes.length}</span></div>{filteredNodes.map((node) => { const Icon = nodeIcons[node.data.kind]; return <button className={`node-list-item ${selectedNodeId === node.id ? "active" : ""}`} key={node.id} onClick={() => { setSelectedNodeId(node.id); setSelectedEdgeId(null); }}><Icon size={15} /><span><b>{node.data.title}</b><small>{node.data.path || "未绑定路径"}</small></span><span className={`list-dot ${node.data.status}`} /></button>; })}</div>
        <div className="rail-section"><div className="section-label">插件 <span>{plugins.length}</span></div>{plugins.map((plugin) => <div className="plugin-row" key={plugin.id}><span className="plugin-icon"><SquareTerminal size={14} /></span><span><b>{plugin.name}</b><small>{plugin.description}</small></span></div>)}</div>
        <div className="rail-section file-records"><div className="section-label">工作区文件 <span>{workspaceFiles.length}</span></div>{workspaceFiles.slice(-8).reverse().map((file) => <div className={`file-record ${file.status ?? "present"}`} key={file.path}><FilePlus2 size={12} /><span title={file.path}>{file.path}</span></div>)}{workspaceFiles.length === 0 && <div className="file-record-empty">等待文件扫描</div>}</div>
        <div className="left-footer"><button onClick={selectWorkspace}><Settings2 size={15} />切换工作区</button><div className={`connection ${workspace ? "" : "offline"}`}><span />{workspace ? workspace.root : "尚未选择工作区"}</div></div>
      </aside>
      <main className="canvas-area">
        <div className="canvas-toolbar"><div className="toolbar-group"><button className="tool-button active" title="选择工具"><MousePointer2 size={16} /></button><button className="tool-button" title="添加节点" onClick={() => addNode("operation")}><Plus size={16} /></button><button className="tool-button" title="适应画布"><Layers3 size={16} /></button><div className="ai-selector"><Bot size={15} /><select aria-label="选择 AI" value={agentChoice} onChange={(event) => { const next = event.target.value as "none" | "codex_micu"; setAgentChoice(next); if (next === "none") void stopAgent(); }}><option value="none">不使用 AI</option><option value="codex_micu">Codex · WSL codex_micu</option></select></div></div><div className="toolbar-group"><button className="action-button" onClick={addProject}><FolderOpen size={15} />添加项目</button><button className="action-button primary" onClick={runSelected}><Play size={15} />运行选中节点</button></div></div>
        <div className="canvas-wrap"><ReactFlow nodes={nodes.map((node) => ({ ...node, hidden: !!search.trim() && !filteredNodes.some((item) => item.id === node.id) }))} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} connectionLineType={ConnectionLineType.SmoothStep} onNodeClick={(_, node) => { setSelectedNodeId(node.id); setSelectedEdgeId(null); }} onEdgeClick={(_, edge) => { setSelectedEdgeId(edge.id); setSelectedNodeId(null); }} onPaneClick={() => { setSelectedNodeId(null); setSelectedEdgeId(null); }} fitView fitViewOptions={{ padding: 0.2 }} minZoom={0.25} maxZoom={1.5}><Background color="#263342" gap={24} size={1} /><Controls showInteractive={false} /><MiniMap pannable zoomable nodeColor={(node) => ({ project: "#5b8def", artifact: "#d78b62", operation: "#8d7be2", conclusion: "#55aa86", reference: "#c0a468" }[node.data?.kind as NodeKind] ?? "#738196")} /></ReactFlow>{desktop && workspaceLoaded && !workspace && <div className="workspace-empty"><div><FolderCog size={22} /></div><h2>选择工作区</h2><p>Flow、日志和产物将写入所选文件夹。</p><button className="action-button primary" onClick={selectWorkspace}><FolderOpen size={15} />选择文件夹</button></div>}{workspace && <div className="canvas-hint"><Link2 size={14} />从节点右侧拖到另一个节点，创建带处理说明的连接</div>}</div>
        <div className="statusbar"><span><Activity size={14} />{notice}</span><span>{workspace?.flowPath ?? `${nodes.length} 个节点 · ${edges.length} 条连接`} · 已记录 {workspaceFiles.length} 个文件</span></div>
      </main>
      <Inspector node={selectedNode} edge={selectedEdge} workspace={workspace} patchNode={patchNode} patchEdge={patchEdge} onChoosePath={chooseNodeDirectory} onLaunch={launch} onDelete={() => { if (selectedNodeId) { setNodes((current) => current.filter((node) => node.id !== selectedNodeId)); setEdges((current) => current.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId)); setSelectedNodeId(null); } else if (selectedEdgeId) { setEdges((current) => current.filter((edge) => edge.id !== selectedEdgeId)); setSelectedEdgeId(null); } }} />
    </div>
  </div>;
}

function Inspector({ node, edge, workspace, patchNode, patchEdge, onChoosePath, onLaunch, onDelete }: { node: FlowNode | null; edge: FlowEdge | null; workspace: WorkspaceSnapshot | null; patchNode: (patch: Partial<FlowNodeData>) => void; patchEdge: (patch: Partial<FlowEdgeData>) => void; onChoosePath: () => void; onLaunch: () => void; onDelete: () => void }) {
  if (edge) { const data = edge.data ?? defaultEdgeData; return <aside className="inspector"><InspectorHeader icon={<Link2 size={16} />} title="连接详情" subtitle={`${edge.source} → ${edge.target}`} onDelete={onDelete} /><div className="inspector-body"><Field label="关系"><select value={data.relation} onChange={(event) => patchEdge({ relation: event.target.value as Relation })}>{Object.entries(relationLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field><Field label="处理方式" hint="这段文字是人类可读的执行意图，不会直接作为 shell 命令运行"><textarea rows={6} value={data.instruction} onChange={(event) => patchEdge({ instruction: event.target.value })} /></Field><Field label="期望输出"><input value={data.expectedOutput} onChange={(event) => patchEdge({ expectedOutput: event.target.value })} placeholder="例如：validated.csv" /></Field><Field label="证据与日志"><input value={data.evidence} onChange={(event) => patchEdge({ evidence: event.target.value })} placeholder="例如：logs/run.txt" /></Field><Field label="运行策略"><div className="segmented"><button className={data.runPolicy === "manual" ? "active" : ""} onClick={() => patchEdge({ runPolicy: "manual" })}>手动</button><button className={data.runPolicy === "confirm" ? "active" : ""} onClick={() => patchEdge({ runPolicy: "confirm" })}>执行前确认</button></div></Field></div></aside>; }
  if (node) return <aside className="inspector"><InspectorHeader icon={<Layers3 size={16} />} title="节点详情" subtitle={kindLabels[node.data.kind]} onDelete={onDelete} /><div className="inspector-body"><Field label="节点名称"><input value={node.data.title} onChange={(event) => patchNode({ title: event.target.value })} /></Field><Field label="节点类型"><select value={node.data.kind} onChange={(event) => patchNode({ kind: event.target.value as NodeKind })}>{Object.entries(kindLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field><Field label="工作区内路径" hint={workspace?.root}><div className="input-with-action"><input value={node.data.path} onChange={(event) => patchNode({ path: event.target.value })} placeholder="选择工作区内的文件夹" /><button title="选择目录" onClick={onChoosePath}><FolderOpen size={15} /></button></div></Field><Field label="职责摘要"><textarea rows={2} value={node.data.summary} onChange={(event) => patchNode({ summary: event.target.value })} /></Field><div className="field-grid"><Field label="输入"><textarea rows={3} value={node.data.input} onChange={(event) => patchNode({ input: event.target.value })} /></Field><Field label="输出"><textarea rows={3} value={node.data.output} onChange={(event) => patchNode({ output: event.target.value })} /></Field></div><Field label="结论"><textarea rows={3} value={node.data.conclusion} onChange={(event) => patchNode({ conclusion: event.target.value })} /></Field><Field label="处理方式"><textarea rows={4} value={node.data.process} onChange={(event) => patchNode({ process: event.target.value })} /></Field><Field label="参考"><textarea rows={3} value={node.data.references} onChange={(event) => patchNode({ references: event.target.value })} placeholder="每行一个文件或链接" /></Field><Field label="外部插件"><select value={node.data.pluginId ?? ""} onChange={(event) => patchNode({ pluginId: event.target.value })}><option value="">不指定</option>{plugins.map((plugin) => <option value={plugin.id} key={plugin.id}>{plugin.name}</option>)}</select></Field><button className="launch-button" onClick={onLaunch}><SquareTerminal size={15} />打开外部工具</button></div></aside>;
  return <aside className="inspector empty-inspector"><div className="empty-icon"><MousePointer2 size={20} /></div><h3>选择一个节点或连接</h3><p>在画布中点击对象，查看输入、输出、结论、处理方式和参考。</p><button onClick={() => undefined}><Info size={15} />使用说明</button></aside>;
}

function InspectorHeader({ icon, title, subtitle, onDelete }: { icon: React.ReactNode; title: string; subtitle: string; onDelete: () => void }) { return <div className="inspector-header"><div className="inspector-title"><span>{icon}</span><div><b>{title}</b><small>{subtitle}</small></div></div><button className="small-icon danger" title="删除" onClick={onDelete}><Trash2 size={15} /></button></div>; }
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) { return <label className="field"><span>{label}</span>{hint && <em>{hint}</em>}{children}</label>; }

function Root() { return <ReactFlowProvider><App /></ReactFlowProvider>; }

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("应用根节点不存在");
createRoot(rootElement).render(<Root />);
