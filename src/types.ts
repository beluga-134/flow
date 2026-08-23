import type { Edge, Node } from "@xyflow/react";

export type NodeKind = "project" | "artifact" | "operation" | "conclusion" | "reference";
export type NodeStatus = "idle" | "running" | "success" | "error";
export type AgentNodeStatus = "idle" | "opening" | "connected" | "waiting" | "exited" | "error";
export type Relation = "transforms" | "depends_on" | "supports" | "contradicts";

export interface FlowNodeData extends Record<string, unknown> {
  kind: NodeKind;
  title: string;
  path: string;
  summary: string;
  input: string;
  output: string;
  conclusion: string;
  process: string;
  references: string;
  pluginId?: string;
  status: NodeStatus;
  agentStatus?: AgentNodeStatus;
  agentSessionId?: number;
  agentOutput?: string;
  inheritedInput?: string;
}

export interface FlowEdgeData extends Record<string, unknown> {
  relation: Relation;
  instruction: string;
  expectedOutput: string;
  evidence: string;
  runPolicy: "manual" | "confirm";
}

export type FlowNode = Node<FlowNodeData>;
export type FlowEdge = Edge<FlowEdgeData> & { data: FlowEdgeData };

export interface FlowDocument {
  schemaVersion: 1;
  name: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  files?: WorkspaceFileRecord[];
  activities?: WorkspaceActivity[];
}

export interface WorkspaceFileRecord {
  path: string;
  size: number;
  modifiedAt: number;
  status?: "present" | "added" | "modified";
  observedAt?: number;
  nodeId?: string;
}

export interface WorkspaceActivity {
  kind: "file-change" | "node-run" | "node-input";
  message: string;
  nodeId?: string;
  paths?: string[];
  timestamp: number;
}

export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  executable?: string;
  actions: { id: string; label: string; extensions?: string[] }[];
}

export interface WorkspaceSnapshot {
  root: string;
  name: string;
  flowPath: string;
  document: FlowDocument | null;
}
