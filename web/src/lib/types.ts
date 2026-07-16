export interface Health {
  status: string;
  microcks: string;
  microcksReachable: boolean;
  services: { total: number; graphql: number; rest: number; event: number };
  totalOperations: number;
  uptime?: number;
}

export interface Workspace {
  id: string;
  name: string;
  description?: string;
  owner?: string;
  createdAt?: string;
  isolated?: boolean;
}

export interface Operation {
  name: string;
  method: string;
  resourcePaths?: string[];
  outputName?: string;
}

export interface ServiceDetail {
  name: string;
  displayName?: string;
  type: string;
  version: string;
  operations: Operation[];
}

export interface ServicesDetailResponse {
  services: ServiceDetail[];
  microcks: string;
}

export interface ScenarioInfo {
  id: string;
  name: string;
  description?: string;
}

export interface RequestSample {
  ts: number;
  protocol: string;
  service: string;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
}

export interface ActivityEvent {
  ts: number;
  type: string;
  title: string;
  detail?: string;
  actor?: string;
}

export interface MetricsSummary {
  totalRequests: number;
  windowRequests: number;
  byProtocol: Record<string, number>;
  byService: Record<string, number>;
  errorRate: number;
  avgLatencyMs: number;
  routes: number;
  recentRequests: RequestSample[];
  series: { ts: number; latencyMs: number; status: number; protocol: string }[];
  activity: ActivityEvent[];
}

export interface RouteStat {
  protocol: string;
  service: string;
  method: string;
  path: string;
  count: number;
  errorRate: number;
  avgLatencyMs: number;
  lastStatus: number;
  lastSeen: number;
}

export interface HealthAi {
  available: boolean;
  provider: string;
  model: string;
  configured: boolean;
  recentFailure?: string | null;
  fallbackMode: boolean;
  message: string;
}

export interface AuthMe {
  authEnabled: boolean;
  user?: { name?: string; email?: string; via?: string } | null;
}

export interface EdgeCaseScenario {
  id: string;
  name: string;
  category: string;
  severity: string;
  description: string;
  prompt: string;
  variables?: Record<string, unknown> | null;
}

export interface ChaosFault {
  service: string;
  scope: string;
  latencyMs: number;
  jitterMs: number;
  errorRate: number;
  errorStatus: number;
  enabled: boolean;
  updatedAt: number;
}

export interface DetectResult {
  schemaType: string;
  valid: boolean;
  issues: { level: string; message: string }[];
  operations: number | null;
  types: number | null;
  aiAvailable: boolean;
}

export interface SetupStep {
  step: string;
  status: string;
}

export interface SetupMockRoute {
  operation: string;
  method: string;
  path?: string;
  url: string;
  exampleGenerated: boolean;
}

export interface SetupResult {
  success: boolean;
  serviceName: string;
  displayName?: string;
  schemaType?: string;
  operationCount?: number;
  channelCount?: number;
  steps: SetupStep[];
  mockRoutes?: SetupMockRoute[];
  graphqlEndpoint?: string;
  restEndpoint?: string;
  grpcEndpoint?: string;
  error?: string;
}
