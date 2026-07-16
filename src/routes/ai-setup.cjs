'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const { ARTIFACTS_DIR } = require('../config.cjs');
const { callLLM, callLLMWithHighTokens, SETUP_SYSTEM_PROMPT, ASYNC_AI_SYSTEM_PROMPT, GRPC_AI_SYSTEM_PROMPT, FAILURE_SCENARIOS, isAIAvailable } = require('../lib/ai-client.cjs');
const {
  detectSchemaType,
  parseGraphQLSchema,
  validateGraphQLSchema,
  cleanSchemaForMocking,
  generateMockViaGraphQLTools,
  parseOpenAPISpec,
  resolveSchemaRef,
  describeSchema,
  detectAndConvertPlainType,
  convertJsonToOpenAPI,
  parseSamplesFromPrompt,
  enhanceSchemaWithAI,
  parseAsyncAPISpec,
  validateAsyncAPISchema,
  parseProtobufSpec,
  validateProtobufSchema,
  describeProtoMessage,
  describeAsyncChannel,
} = require('../lib/schema-parser.cjs');
const { generateMockValue, generateMockObject, generateMockFromOpenAPISchema, extractExampleRegistryFromSpec, generateMockFromJsonSchema, generateMockFromProtoMessage } = require('../lib/mock-generators.cjs');
const {
  buildAutoPostmanCollection,
  buildRestPostmanCollection,
  injectExamplesIntoOpenAPI,
  buildFieldsForType,
  buildFullTypeDesc,
  buildVariablesForArgs,
  buildGrpcPostmanCollection,
  injectAsyncApiExamples,
} = require('../lib/postman-builder.cjs');
const {
  importArtifactToMicrocks,
  deleteServiceFromMicrocks,
  deleteExistingService,
  getMicrocksServiceId,
  clearServiceDispatchers,
  configureServiceDispatchers,
  configureGraphQLOperationDispatchers,
  invalidateCache,
} = require('../lib/microcks-service.cjs');
const { loadSchemaFiles, loadAsyncApiSpecs, isValidJSON } = require('../lib/schema-loader.cjs');
const { validateMockData, nearestEnumValue } = require('../lib/validation.cjs');
const { SCALAR_TYPES } = require('../lib/graphql-utils.cjs');
const { scenarioStore, workspaces, getUserScope, getWorkspaceId, registerService, registerOperationExamples, clearServiceExamples, markDirty } = require('../state.cjs');
const { applyPrefix, getDisplayName } = require('../lib/microcks-namespace.cjs');
const metrics = require('../lib/metrics.cjs');

const router = express.Router();

const aiSetupRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(aiSetupRateLimiter);

function registerWorkspaceOps(req, serviceName, operations, generatedData) {
  const wsId = getWorkspaceId(req);
  if (!wsId) return;
  const user = getUserScope(req);
  if (!workspaces[wsId]) {
    workspaces[wsId] = {
      id: wsId,
      name: wsId,
      description: '',
      owner: user,
      createdAt: new Date().toISOString(),
      isolated: true,
      scenarios: {},
      overrides: {},
      variableMocks: {},
    };
  }
  const ws = workspaces[wsId];
  ws.isolated = true;
  if (!ws.scenarios) ws.scenarios = {};
  for (const op of operations) {
    const opName = op.name || op.operation || '';
    if (!opName) continue;
    const wsKey = `ws:${wsId}:${user}:${serviceName}:${opName}`;
    const localKey = `${serviceName}:${opName}`;
    const opData = generatedData[opName];
    let responseBody = null;
    if (opData && Array.isArray(opData) && opData.length > 0) {
      const sample = opData[0];
      responseBody = { data: { [opName]: sample } };
    }
    const entry = { data: responseBody, source: 'ai-setup', scenario: 'setup' };
    scenarioStore[wsKey] = entry;
    ws.scenarios[localKey] = entry;
  }
}

router.post('/validate-schema', (req, res) => {
  const { schema } = req.body;

  if (!schema) {
    return res.status(400).json({ error: 'No schema provided' });
  }

  try {
    const validation = validateGraphQLSchema(schema);
    return res.json(validation);
  } catch (e) {
    return res.status(500).json({
      error: 'Validation failed',
      message: e.message,
    });
  }
});

function toSafeArtifactSlug(value) {
  const base = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base || 'service';
}

async function handleAiSetup(req, res) {
  const { schema: schemaText, prompt, serviceName: reqServiceName } = req.body;

  if (!schemaText) {
    return res.status(400).json({ error: 'Paste a GraphQL SDL or OpenAPI/JSON spec.' });
  }

  if (!prompt || prompt.trim() === '') {
    return res.status(400).json({ error: 'Please provide a prompt to guide mock data generation.' });
  }

  const steps = [];
  let finalSchema = schemaText;
  let serviceName = reqServiceName;

  const sanitizeWorkspaceId = (value) => {
    const cleaned = String(value || '').replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 64);
    return cleaned || null;
  };

  const sanitizeServiceName = (value) => {
    const cleaned = String(value || '').replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 120);
    return cleaned || 'AIGeneratedAPI';
  };

  // Workspace-scoped naming: same base name in different workspaces must not
  // collide in Microcks. We fold the workspace id into the service name before
  // applying the global namespace prefix.
  const wsId = sanitizeWorkspaceId(getWorkspaceId(req));
  const wsScope = (name) => applyPrefix(wsId ? `${wsId}-${name}` : name);

  try {
    // ── Detect schema type early ─────────────────────────────
    const schemaType = detectSchemaType(schemaText);

    console.log(`📘 Detected schema type: ${schemaType}`);

    if (schemaType === 'unknown') {
      return res.status(400).json({
        error: 'Unsupported schema format. Expected GraphQL SDL, OpenAPI, AsyncAPI, or Protobuf (.proto).'
      });
    }

    // ── Validate GraphQL schema for undefined types ──────────
    let schemaIssues = [];
    if (schemaType === 'graphql') {
      const validation = validateGraphQLSchema(schemaText);
      steps.push({ step: `Schema validation completed (${validation.summary.errorCount} errors, ${validation.summary.warningCount} warnings)`, status: 'done' });
      
      if (!validation.valid && validation.errors.length > 0) {
        validation.errors.forEach(e => {
          steps.push({ step: `[ERROR] ${e.message}`, status: 'warning' });
          schemaIssues.push(e);
        });
      }
      
      if (validation.warnings.length > 0) {
        validation.warnings.forEach(w => {
          steps.push({ step: w.message, status: 'warning' });
          schemaIssues.push(w);
        });
      }
    }

// Handle plain-types (nested JSON with type definitions)
if (schemaType === 'plain-types') {
  const plainTypeResult = detectAndConvertPlainType(schemaText, serviceName || reqServiceName || 'AutoGenerated');
  if (plainTypeResult) {
    steps.push({
      step: 'Detected nested JSON type definitions, converting to OpenAPI...',
      status: 'done'
    });
    finalSchema = JSON.stringify(plainTypeResult.openApiSpec, null, 2);
    serviceName = plainTypeResult.serviceName;
  }
}

    // Auto-detect schema type: plain type → OpenAPI → GraphQL
    const trimmed = schemaText.trim();
// ── Early JSON validation (but allow OpenAPI JSON) ───────────────
// ── JSON → OpenAPI conversion ─────────────────────────────
if (trimmed.startsWith('{')) {
  try {
    let parsed = null;
    
    // Try direct JSON parse first
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      // Try lenient parsing for unquoted type names like { name: String, age: Int }
      const lenient = trimmed.replace(/(\w+)\s*:/g, '"$1":').replace(/:\s*(\w+)/g, ':"$1"');
      try {
        parsed = JSON.parse(lenient);
      } catch (e2) {
        // If both fail, skip this section and let detectAndConvertPlainType handle it
        parsed = null;
      }
    }

    if (parsed) {
      const isLikelyOpenAPI = parsed.openapi || parsed.swagger;

      if (!isLikelyOpenAPI) {
        steps.push({
          step: 'Detected raw JSON, converting to OpenAPI schema...',
          status: 'running'
        });

        const converted = convertJsonToOpenAPI(
          parsed,
          serviceName || reqServiceName || 'GeneratedAPI'
        );

        finalSchema = JSON.stringify(converted, null, 2);

        if (!serviceName) serviceName = reqServiceName || 'GeneratedAPI';

        steps[steps.length - 1].status = 'done';
      }
      if (prompt && finalSchema) {
        steps.push({ step: 'Enhancing schema with AI...', status: 'running' });
      
        finalSchema = await enhanceSchemaWithAI(finalSchema, prompt);
      
        steps[steps.length - 1].status = 'done';
      }
      
      
      // ── OpenAPI detection ─────────────────────
      const isOpenAPI = (() => {
        const t = finalSchema.trim();
        if (t.startsWith('{')) return /"openapi"|"swagger"/.test(t);
        return /^openapi:|^swagger:/m.test(t);
      })();
    }
  } catch (err) {
    // Log but don't fail - let detectAndConvertPlainType handle it
    console.log('JSON parsing in /ai/setup failed, will try detectAndConvertPlainType:', err.message);
  }
}
    // ── Plain type detection (auto-CRUD generation) ──────────────────
    if (schemaType !== 'graphql') {
      const plainTypeResult = detectAndConvertPlainType(trimmed, serviceName || reqServiceName || 'GeneratedAPI');
      if (plainTypeResult) {
        steps.push({ step: `Detected plain type definition, generating CRUD endpoints for "${plainTypeResult.typeName}"...`, status: 'done' });
        finalSchema = JSON.stringify(plainTypeResult.openApiSpec, null, 2);
        if (!serviceName) serviceName = plainTypeResult.serviceName;
      }
    }

    // ── AsyncAPI / Event-driven flow ──────────────────────────────────
    if (schemaType === 'asyncapi') {
      steps.push({ step: 'Detected AsyncAPI spec, parsing...', status: 'running' });
      let parsedAsync;
      try {
        parsedAsync = parseAsyncAPISpec(finalSchema);
      } catch (err) {
        return res.status(400).json({ error: `AsyncAPI parse error: ${err.message}`, steps });
      }

      const validation = validateAsyncAPISchema(finalSchema);
      if (!validation.valid) {
        validation.errors.forEach(e => steps.push({ step: `[ERROR] ${e.message}`, status: 'warning' }));
      }
      steps[steps.length - 1].status = 'done';

      const { spec: asyncSpec, serviceName: parsedName, serviceVersion: asyncVersion, channels, protocol } = parsedAsync;
      const baseName = serviceName || parsedName;
      serviceName = wsScope(baseName);
      if (asyncSpec.info) asyncSpec.info.title = serviceName;

      if (channels.length === 0) {
        return res.status(400).json({ error: 'No channels found in AsyncAPI spec', steps });
      }

      steps.push({ step: `Generating mock payloads for ${channels.length} channel(s) (protocol: ${protocol})...`, status: 'running' });
      const generatedData = {};
      const { total: samplesPerChannel, scenarioInstructions } = parseSamplesFromPrompt(prompt);

      if (!isAIAvailable()) {
        steps.push({ step: 'AI unavailable — using schema-based fallback generation', status: 'warning' });
        for (const ch of channels) {
          const examples = [];
          for (let i = 0; i < samplesPerChannel; i++) {
            examples.push(generateMockFromJsonSchema(ch.schema));
          }
          generatedData[ch.name] = examples;
        }
      } else {
        const channelDescs = channels.map(ch => {
          const schemaDesc = describeAsyncChannel(ch);
          return `Channel "${ch.name}" (${ch.direction}, ${ch.messageName || 'message'}):\n  Payload schema:\n${schemaDesc}`;
        }).join('\n\n');

        const batchPrompt = `Generate ${samplesPerChannel} DISTINCT mock message payloads for each of the following AsyncAPI channels.

${channelDescs}

User request: ${prompt || 'Generate realistic mock event payloads'}
${scenarioInstructions}

Return a JSON object where each key is the channel name, and its value is an ARRAY of exactly ${samplesPerChannel} example payloads.

Format: { "channel.name": [payload1, payload2, ...] }`;

        const maxRetries = 3;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            const maxTokens = Math.min(16000, Math.max(4000, samplesPerChannel * channels.length * 500));
            const batchResult = await callLLMWithHighTokens(ASYNC_AI_SYSTEM_PROMPT, batchPrompt, maxTokens);
            for (const ch of channels) {
              const chData = batchResult[ch.name];
              if (Array.isArray(chData) && chData.length > 0) {
                generatedData[ch.name] = chData;
              } else if (chData) {
                generatedData[ch.name] = [chData];
              }
            }
            break;
          } catch (err) {
            if (err.message && err.message.includes('Rate limit') && attempt < maxRetries) {
              steps.push({ step: `Rate limited, retrying in ${attempt * 15}s...`, status: 'warning' });
              await new Promise(r => setTimeout(r, attempt * 15000));
            } else {
              steps.push({ step: `AI generation failed: ${err.message}`, status: 'warning' });
            }
          }
        }

        // Fallback for any channels the LLM missed
        for (const ch of channels) {
          if (!generatedData[ch.name]) {
            const examples = [];
            for (let i = 0; i < samplesPerChannel; i++) {
              examples.push(generateMockFromJsonSchema(ch.schema));
            }
            generatedData[ch.name] = examples;
            steps.push({ step: `Schema fallback for channel ${ch.name}`, status: 'warning' });
          }
        }
      }
      steps[steps.length - 1].status = 'done';

      // Inject examples back into AsyncAPI spec
      steps.push({ step: 'Injecting examples into AsyncAPI spec...', status: 'running' });
      const updatedAsyncSpec = injectAsyncApiExamples(asyncSpec, generatedData);
      steps[steps.length - 1].status = 'done';

      // Write artifacts
      steps.push({ step: 'Writing artifacts...', status: 'running' });
      const safeArtifactsDir = path.resolve(ARTIFACTS_DIR);
      const slugName = toSafeArtifactSlug(serviceName);
      const asyncApiFile = path.resolve(safeArtifactsDir, `${slugName}-asyncapi.yaml`);

      const inArtifactsDir = (p) => p === safeArtifactsDir || p.startsWith(safeArtifactsDir + path.sep);
      if (!inArtifactsDir(asyncApiFile)) {
        return res.status(400).json({ error: 'Invalid artifact output path.', steps });
      }

      try {
        const yaml = require('js-yaml');
        if (!fs.existsSync(safeArtifactsDir)) fs.mkdirSync(safeArtifactsDir, { recursive: true });
        fs.writeFileSync(asyncApiFile, yaml.dump(updatedAsyncSpec, { lineWidth: 120, noRefs: true }), 'utf-8');
        steps[steps.length - 1].status = 'done';
      } catch (err) {
        steps[steps.length - 1] = { step: `Writing artifacts failed: ${err.message}`, status: 'error' };
        return res.status(500).json({ error: `Failed to persist artifacts: ${err.message}`, steps });
      }

      // Delete existing service
      steps.push({ step: 'Cleaning up existing service in Microcks...', status: 'running' });
      try {
        const delResult = await deleteExistingService(serviceName);
        if (delResult.deleted) {
          steps[steps.length - 1].status = 'done';
          await new Promise(r => setTimeout(r, 2000));
        } else {
          steps[steps.length - 1] = { step: 'No existing service to clean up', status: 'done' };
        }
      } catch (err) {
        steps[steps.length - 1] = { step: `Cleanup: ${err.message}`, status: 'warning' };
      }

      // Import AsyncAPI spec to Microcks (main artifact — includes examples)
      steps.push({ step: 'Importing AsyncAPI spec to Microcks...', status: 'running' });
      try {
        await importArtifactToMicrocks(asyncApiFile, true);
        steps[steps.length - 1].status = 'done';
      } catch (err) {
        steps[steps.length - 1] = { step: `AsyncAPI import: ${err.message}`, status: 'warning' };
      }

      invalidateCache();
      loadAsyncApiSpecs();

      registerService(serviceName, getWorkspaceId(req));

      const mockChannels = channels.map(ch => ({
        channel: ch.name,
        direction: ch.direction,
        protocol,
        operationId: ch.operationId,
        exampleGenerated: !!generatedData[ch.name],
      }));

      return res.json({
        success: true,
        serviceName,
        displayName: getDisplayName(serviceName, wsId),
        schemaType: 'asyncapi',
        protocol,
        channelCount: channels.length,
        steps,
        mockChannels,
        asyncApiFile: `${slugName}-asyncapi.yaml`,
      });
    }

    // ── gRPC / Protobuf flow ────────────────────────────────────────────
    if (schemaType === 'grpc') {
      steps.push({ step: 'Detected Protobuf/gRPC schema, parsing...', status: 'running' });
      let parsedProto;
      try {
        parsedProto = parseProtobufSpec(finalSchema);
      } catch (err) {
        return res.status(400).json({ error: `Protobuf parse error: ${err.message}`, steps });
      }

      const validation = validateProtobufSchema(finalSchema);
      if (!validation.valid) {
        validation.errors.forEach(e => steps.push({ step: `[ERROR] ${e.message}`, status: 'warning' }));
        if (validation.errors.some(e => e.type === 'NO_SERVICE')) {
          return res.status(400).json({ error: 'Protobuf file must define at least one service with rpc methods for gRPC mocking', steps });
        }
      }
      steps[steps.length - 1].status = 'done';

      const { serviceName: parsedSvcName, serviceVersion: protoVersion, messages, enums: protoEnums, services: protoServices } = parsedProto;
      const baseName = serviceName || parsedSvcName;
      serviceName = wsScope(baseName);

      const primaryService = protoServices[0];
      const methods = primaryService.methods;

      if (methods.length === 0) {
        return res.status(400).json({ error: 'No rpc methods found in gRPC service', steps });
      }

      steps.push({ step: `Generating mock data for ${methods.length} rpc method(s)...`, status: 'running' });
      const generatedData = {};
      const { total: samplesPerOp, scenarioInstructions } = parseSamplesFromPrompt(prompt);

      if (!isAIAvailable()) {
        steps.push({ step: 'AI unavailable — using proto-based fallback generation', status: 'warning' });
        for (const method of methods) {
          const examples = [];
          for (let i = 0; i < samplesPerOp; i++) {
            examples.push(generateMockFromProtoMessage(method.outputType, messages, protoEnums));
          }
          generatedData[method.name] = examples;
        }
      } else {
        const methodDescs = methods.map(m => {
          const outputDesc = describeProtoMessage(m.outputType, messages, protoEnums);
          const inputDesc = describeProtoMessage(m.inputType, messages, protoEnums);
          return `rpc ${m.name}(${m.inputType}) returns (${m.isServerStream ? 'stream ' : ''}${m.outputType}):
  Input message ${m.inputType}: ${inputDesc}
  Output message ${m.outputType}: ${outputDesc}`;
        }).join('\n\n');

        const batchPrompt = `Generate ${samplesPerOp} DISTINCT mock response payloads for each of the following gRPC rpc methods.

Service: ${serviceName}
${methodDescs}

User request: ${prompt || 'Generate realistic mock gRPC responses'}
${scenarioInstructions}

CRITICAL RULES:
- Return JSON matching the output message structure exactly.
- Use the original proto field names (typically snake_case).
- For repeated fields, generate arrays with 1-2 items.
- For enum fields, use the string name (e.g. "ACTIVE", "UNKNOWN").
- For int64/uint64 fields, use string values.

Return a JSON object where each key is the rpc method name, and its value is an ARRAY of exactly ${samplesPerOp} example response payloads.

Format: { "MethodName": [response1, response2, ...] }`;

        const maxRetries = 3;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            const maxTokens = Math.min(16000, Math.max(4000, samplesPerOp * methods.length * 500));
            const batchResult = await callLLMWithHighTokens(GRPC_AI_SYSTEM_PROMPT, batchPrompt, maxTokens);
            for (const method of methods) {
              const mData = batchResult[method.name];
              if (Array.isArray(mData) && mData.length > 0) {
                generatedData[method.name] = mData;
              } else if (mData) {
                generatedData[method.name] = [mData];
              }
            }
            break;
          } catch (err) {
            if (err.message && err.message.includes('Rate limit') && attempt < maxRetries) {
              steps.push({ step: `Rate limited, retrying in ${attempt * 15}s...`, status: 'warning' });
              await new Promise(r => setTimeout(r, attempt * 15000));
            } else {
              steps.push({ step: `AI generation failed: ${err.message}`, status: 'warning' });
            }
          }
        }

        // Fallback for any methods the LLM missed
        for (const method of methods) {
          if (!generatedData[method.name]) {
            const examples = [];
            for (let i = 0; i < samplesPerOp; i++) {
              examples.push(generateMockFromProtoMessage(method.outputType, messages, protoEnums));
            }
            generatedData[method.name] = examples;
            steps.push({ step: `Proto fallback for ${method.name}`, status: 'warning' });
          }
        }
      }
      steps[steps.length - 1].status = 'done';

      // Build Postman collection for gRPC (secondary artifact)
      steps.push({ step: 'Building gRPC Postman collection...', status: 'running' });
      const grpcCollection = buildGrpcPostmanCollection(serviceName, protoVersion, methods, generatedData);
      steps[steps.length - 1].status = 'done';

      // Write artifacts
      steps.push({ step: 'Writing artifacts...', status: 'running' });
      const safeArtifactsDir = path.resolve(ARTIFACTS_DIR);
      const slugName = toSafeArtifactSlug(serviceName);
      const protoFile = path.resolve(safeArtifactsDir, `${slugName}.proto`);
      const postmanFile = path.resolve(safeArtifactsDir, `${slugName}-examples.postman.json`);

      const inArtifactsDir = (p) => p === safeArtifactsDir || p.startsWith(safeArtifactsDir + path.sep);
      if (!inArtifactsDir(protoFile) || !inArtifactsDir(postmanFile)) {
        return res.status(400).json({ error: 'Invalid artifact output path.', steps });
      }

      try {
        if (!fs.existsSync(safeArtifactsDir)) fs.mkdirSync(safeArtifactsDir, { recursive: true });
        fs.writeFileSync(protoFile, finalSchema, 'utf-8');
        fs.writeFileSync(postmanFile, JSON.stringify(grpcCollection, null, 2), 'utf-8');
        steps[steps.length - 1].status = 'done';
      } catch (err) {
        steps[steps.length - 1] = { step: `Writing artifacts failed: ${err.message}`, status: 'error' };
        return res.status(500).json({ error: `Failed to persist artifacts: ${err.message}`, steps });
      }

      // Delete existing service
      steps.push({ step: 'Cleaning up existing service in Microcks...', status: 'running' });
      try {
        const delResult = await deleteExistingService(serviceName);
        if (delResult.deleted) {
          steps[steps.length - 1].status = 'done';
          await new Promise(r => setTimeout(r, 2000));
        } else {
          steps[steps.length - 1] = { step: 'No existing service to clean up', status: 'done' };
        }
      } catch (err) {
        steps[steps.length - 1] = { step: `Cleanup: ${err.message}`, status: 'warning' };
      }

      // Import proto as main artifact
      steps.push({ step: 'Importing Protobuf to Microcks...', status: 'running' });
      try {
        await importArtifactToMicrocks(protoFile, true);
        steps[steps.length - 1].status = 'done';
      } catch (err) {
        steps[steps.length - 1] = { step: `Proto import: ${err.message}`, status: 'warning' };
      }

      await new Promise(r => setTimeout(r, 2000));

      // Import Postman examples as secondary artifact
      steps.push({ step: 'Importing gRPC examples to Microcks...', status: 'running' });
      try {
        await importArtifactToMicrocks(postmanFile, false);
        steps[steps.length - 1].status = 'done';
      } catch (err) {
        steps[steps.length - 1] = { step: `Examples import: ${err.message}`, status: 'warning' };
      }

      invalidateCache();

      registerService(serviceName, getWorkspaceId(req));

      const mockRoutes = methods.map(m => ({
        operation: m.name,
        method: 'GRPC',
        inputType: m.inputType,
        outputType: m.outputType,
        isServerStream: m.isServerStream,
        url: `/grpc/${serviceName}`,
        exampleGenerated: !!generatedData[m.name],
      }));

      return res.json({
        success: true,
        serviceName,
        displayName: getDisplayName(serviceName, wsId),
        schemaType: 'grpc',
        operationCount: methods.length,
        steps,
        mockRoutes,
        protoFile: `${slugName}.proto`,
        examplesFile: `${slugName}-examples.postman.json`,
        grpcEndpoint: `/grpc/${serviceName}`,
      });
    }

    const isOpenAPI = (() => {
      const t = finalSchema.trim();
      if (t.startsWith('{')) return /"openapi"|"swagger"/.test(t);
      return /^openapi:|^swagger:/m.test(t);
    })();

    if (isOpenAPI) {
      // ── OpenAPI / REST flow ──────────────────────────────────────────
      steps.push({ step: 'Detected OpenAPI spec, parsing...', status: 'running' });
      const { spec, serviceName: parsedName, serviceVersion, operations } = parseOpenAPISpec(finalSchema);
      // Canonical name resolution: prefer client-supplied name, fall back to
      // the OpenAPI info.title. We then apply workspace + namespace scoping
      // ONCE and treat the result as the single source of truth for Microcks,
      // the local registry, route URLs, and on-disk slug. Mirror the scoped
      // name back into spec.info.title so Microcks stores it under that name.
      const baseName = serviceName || parsedName;
      serviceName = wsScope(baseName);
      if (spec.info) spec.info.title = serviceName;
      // Kept for backwards compatibility in the response body.
      const microcksRestServiceName = serviceName;
      steps[steps.length - 1].status = 'done';

      if (operations.length === 0) {
        return res.status(400).json({ error: 'No REST operations found in OpenAPI spec', steps });
      }

      // Extract Microcks-style named examples from the spec and register
      // them for the local dispatcher (URI_PARTS / URI_PARAMS / FALLBACK).
      try {
        const exReg = extractExampleRegistryFromSpec(spec);
        const opCount = Object.keys(exReg).length;
        if (opCount > 0) {
          clearServiceExamples(microcksRestServiceName);
          for (const [opKey, entry] of Object.entries(exReg)) {
            registerOperationExamples(microcksRestServiceName, opKey, entry);
          }
          steps.push({ step: `Registered named examples for ${opCount} operation(s) in local dispatcher`, status: 'done' });
        }
      } catch (e) {
        steps.push({ step: `Example dispatcher registration skipped: ${e.message}`, status: 'warning' });
      }

      steps.push({ step: `Generating mock data for ${operations.length} REST operations...`, status: 'running' });
      const generatedData = {};
      const { total: samplesPerOp, scenarioInstructions } = parseSamplesFromPrompt(prompt);

      const opDescriptions = operations.map(op => {
        const schemaDesc = describeSchema(op.responseSchema, spec);
        let rawHint = '';
        try {
          const raw = JSON.stringify(op.responseSchema, null, 2);
          if (raw.length > 20 && raw.length < 3000) rawHint = `\n  JSON Schema:\n${raw}`;
        } catch (_) {}
        const pathParams = (op.parameters || []).filter(p => p.in === 'path').map(p => p.name);
        let pathParamHint = '';
        if (pathParams.length > 0) {
          pathParamHint = `\n  PATH PARAMETERS: ${pathParams.join(', ')}
  IMPORTANT: Each example MUST include a top-level "_pathParams" object with distinct kebab-case slug values for each path parameter. Use realistic slugs like "my-example-item", "another-example". NEVER use URLs.
  Example: "_pathParams": { "${pathParams[0]}": "my-example-item" }`;
        }
        return `"${op.name}" (${op.summary || 'no summary'}):
  Response shape:\n${schemaDesc}${rawHint}${pathParamHint}`;
      }).join('\n\n');

      const batchPrompt = `Generate ${samplesPerOp} DISTINCT mock data examples for each of the following REST API operations.

${opDescriptions}

User request: ${prompt || 'Generate realistic mock data'}
${scenarioInstructions}

CRITICAL PATH PARAMETER RULES:
- For operations with path parameters (like {permalink}, {id}, {slug}), each example MUST include a top-level "_pathParams" field.
- "_pathParams" is a JSON object mapping each path parameter name to a DISTINCT kebab-case slug value.
- Use realistic kebab-case slugs: "my-example-item", "another-example", "sample-record".
- NEVER use URLs (no "https://..." values). Path parameters are URL path segments, not full URLs.
- Each example in the array MUST have DIFFERENT "_pathParams" values.

Return a JSON object where each key is the operation name (e.g. "GET /path"), and its value is an ARRAY of exactly ${samplesPerOp} examples.

Format:
{
  "GET /path1": [example1, example2, ...],
  "POST /path2": [example1, example2, ...]
}`;

      if (!isAIAvailable()) {
        steps.push({ step: 'AI unavailable — using schema-based fallback generation', status: 'warning' });
        for (const op of operations) { generatedData[op.name] = null; }
      } else {
        const maxRetries = 3;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            const maxTokens = Math.min(32000, Math.max(4000, samplesPerOp * operations.length * 500));
            const batchResult = await callLLMWithHighTokens(SETUP_SYSTEM_PROMPT, batchPrompt, maxTokens);
            for (const op of operations) {
              const opData = batchResult[op.name];
              if (Array.isArray(opData) && opData.length > 0) {
                generatedData[op.name] = opData;
              } else if (opData) {
                generatedData[op.name] = [opData];
              } else {
                generatedData[op.name] = null;
              }
            }
            break;
          } catch (err) {
            const isRateLimit = err.message && err.message.includes('Rate limit');
            if (isRateLimit && attempt < maxRetries) {
              const waitMs = attempt * 15000;
              steps.push({ step: `Rate limited, retrying in ${waitMs / 1000}s (attempt ${attempt}/${maxRetries})...`, status: 'warning' });
              await new Promise(r => setTimeout(r, waitMs));
            } else {
              steps.push({ step: `Warning: batch generation failed: ${err.message}`, status: 'warning' });
              for (const op of operations) { generatedData[op.name] = null; }
            }
          }
        }
      }
      steps[steps.length - 1].status = 'done';

      // Smart fallback for any REST ops the LLM missed
      for (const op of operations) {
        if (!generatedData[op.name]) {
          const respSchema = op.responseSchema || {};
          const examples = [];
          for (let i = 0; i < samplesPerOp; i++) {
            examples.push(generateMockFromOpenAPISchema(respSchema, spec, 0));
          }
          generatedData[op.name] = examples;
          steps.push({ step: `Smart fallback for ${op.name}`, status: 'warning' });
        }
      }

      steps.push({ step: 'Building Postman collection...', status: 'running' });
      const collection = buildRestPostmanCollection(microcksRestServiceName, serviceVersion, operations, generatedData);
      steps[steps.length - 1].status = 'done';

      steps.push({ step: 'Injecting examples into OpenAPI spec...', status: 'running' });
      const updatedSpec = injectExamplesIntoOpenAPI(spec, operations, generatedData);
      steps[steps.length - 1].status = 'done';

      steps.push({ step: 'Writing artifacts...', status: 'running' });
      const safeArtifactsDir = path.resolve(ARTIFACTS_DIR);
      const slugName = toSafeArtifactSlug(serviceName);
      const openapiFile = path.resolve(safeArtifactsDir, `${slugName}-openapi.json`);
      const postmanFile = path.resolve(safeArtifactsDir, `${slugName}-examples.postman.json`);

      const inArtifactsDir = (p) => p === safeArtifactsDir || p.startsWith(safeArtifactsDir + path.sep);
      if (!inArtifactsDir(openapiFile) || !inArtifactsDir(postmanFile)) {
        steps[steps.length - 1] = { step: 'Writing artifacts failed: invalid output path', status: 'error' };
        return res.status(400).json({
          error: 'Invalid artifact output path.',
          steps,
        });
      }

      try {
        if (!fs.existsSync(safeArtifactsDir)) fs.mkdirSync(safeArtifactsDir, { recursive: true });
        fs.writeFileSync(openapiFile, JSON.stringify(updatedSpec, null, 2), 'utf-8');
        fs.writeFileSync(postmanFile, JSON.stringify(collection, null, 2), 'utf-8');
        steps[steps.length - 1].status = 'done';
      } catch (err) {
        steps[steps.length - 1] = { step: `Writing artifacts failed: ${err.message}`, status: 'error' };
        return res.status(500).json({
          error: `Failed to persist artifacts to ${safeArtifactsDir}: ${err.message}`,
          hint: 'Verify the artifacts directory is writable (check ARTIFACTS_DIR env var and volume mounts).',
          steps,
        });
      }

      // Delete existing service to prevent stale default examples
      steps.push({ step: 'Cleaning up existing service in Microcks...', status: 'running' });
      try {
        const delResult = await deleteExistingService(serviceName);
        if (delResult.deleted) {
          steps[steps.length - 1].status = 'done';
          await new Promise(r => setTimeout(r, 2000));
        } else {
          steps[steps.length - 1] = { step: 'No existing service to clean up', status: 'done' };
        }
      } catch (err) {
        steps[steps.length - 1] = { step: `Cleanup: ${err.message}`, status: 'warning' };
      }

      steps.push({ step: 'Importing OpenAPI spec to Microcks...', status: 'running' });
      try {
        await importArtifactToMicrocks(openapiFile, true);
        steps[steps.length - 1].status = 'done';
      } catch (err) {
        steps[steps.length - 1] = { step: `OpenAPI import: ${err.message}`, status: 'warning' };
      }

      await new Promise(r => setTimeout(r, 2000));

      steps.push({ step: 'Importing examples to Microcks...', status: 'running' });
      try {
        await importArtifactToMicrocks(postmanFile, false);
        steps[steps.length - 1].status = 'done';
      } catch (err) {
        steps[steps.length - 1] = { step: `Examples import: ${err.message}`, status: 'warning' };
      }

      invalidateCache();

      registerWorkspaceOps(req, serviceName, operations, generatedData);
      registerService(serviceName, getWorkspaceId(req));

      metrics.logEvent({ type: 'deploy', title: `Deployed mock ${getDisplayName(serviceName, wsId)} (${operations.length} REST ops)`, detail: 'OpenAPI', actor: getUserScope(req) });

      const mockRoutes = operations.map(op => ({
        operation: op.name,
        method: op.method,
        path: op.path,
        url: `/rest/${serviceName}/${serviceVersion}${op.path}`,
        exampleGenerated: !!generatedData[op.name],
      }));

      return res.json({
        success: true,
        serviceName,
        displayName: getDisplayName(serviceName, wsId),
        microcksServiceName: microcksRestServiceName,
        schemaType: 'openapi',
        operationCount: operations.length,
        steps,
        mockRoutes,
        openapiFile: `${slugName}-openapi.json`,
        examplesFile: `${slugName}-examples.postman.json`,
        restEndpoint: `/rest/${serviceName}/${serviceVersion}`,
      });
    }

    // ── GraphQL flow ──────────────────────────────────────────────────

    // Extract microcksId from schema — this MUST match the Postman collection name
    const microcksMatch = finalSchema.match(/^#\s*microcksId:\s*(.+?)\s*:\s*(.+?)$/m);
    let serviceVersion = '1.0';
    if (microcksMatch) {
      serviceName = microcksMatch[1].trim();
      serviceVersion = microcksMatch[2].trim();
    }
    if (!serviceName) {
      serviceName = (reqServiceName || 'AIGeneratedAPI').replace(/\s+/g, '');
    }
    serviceName = sanitizeServiceName(serviceName);
    // Workspace-scope the service name so the same base name in different
    // workspaces produces distinct Microcks services.
    serviceName = wsScope(serviceName);

    // Rewrite or inject microcksId with the prefixed name
    if (finalSchema.includes('microcksId')) {
      finalSchema = finalSchema.replace(/^#\s*microcksId:\s*.+$/m, `# microcksId: ${serviceName} : ${serviceVersion}`);
    } else {
      finalSchema = `# microcksId: ${serviceName} : ${serviceVersion}\n${finalSchema}`;
    }

    // Parse schema
    steps.push({ step: 'Parsing schema...', status: 'running' });
    const { types, operations, enums } = parseGraphQLSchema(finalSchema);
    steps[steps.length - 1].status = 'done';

    if (operations.length === 0) {
      // Auto-generate Query/Mutation for GraphQL types without them
      const userTypes = Object.keys(types).filter(t => t !== 'Query' && t !== 'Mutation' && t !== 'Subscription');
      if (userTypes.length === 0) {
        return res.status(400).json({ error: 'No types, queries, or mutations found in schema', steps });
      }
      steps.push({ step: `Auto-generating CRUD operations for ${userTypes.join(', ')}`, status: 'done' });
      const queryFields = [];
      const mutationFields = [];
      for (const tName of userTypes) {
        const fields = types[tName];
        if (!fields || Object.keys(fields).length === 0) continue;
        const hasId = fields.id;
        queryFields.push(`  get${tName}${hasId ? '(id: ID!)' : ''}: ${tName}`);
        queryFields.push(`  getAll${tName}s: [${tName}]`);
        mutationFields.push(`  create${tName}(input: ${tName}Input): ${tName}`);
        if (hasId) mutationFields.push(`  delete${tName}(id: ID!): Boolean`);
      }
      const crudSchema = `\ntype Query {\n${queryFields.join('\n')}\n}\n\ntype Mutation {\n${mutationFields.join('\n')}\n}\n`;
      finalSchema = finalSchema + crudSchema;
      if (!finalSchema.includes('microcksId')) {
        finalSchema = `# microcksId: ${serviceName} : ${serviceVersion}\n${finalSchema}`;
      }
      const reparsed = parseGraphQLSchema(finalSchema);
      Object.assign(types, reparsed.types);
      operations.push(...reparsed.operations);
      Object.assign(enums, reparsed.enums);
      if (operations.length === 0) {
        return res.status(400).json({ error: 'Could not generate operations from schema', steps });
      }
    }

    // Generate data for ALL operations in a single batched LLM call
    steps.push({ step: `Generating mock data for ${operations.length} operations...`, status: 'running' });
    const generatedData = {};
    const { total: samplesPerOp, scenarioInstructions } = parseSamplesFromPrompt(prompt);

    const nonScalarOps = [];
    for (const op of operations) {
      const isScalarReturn = SCALAR_TYPES.has(op.returnType) || !types[op.returnType];
      if (isScalarReturn) {
        const scalarVariants = {
          'Int': [1, 42, 100, 0, -1, 999999, 7, 0, 50, 12345],
          'Float': [1.0, 3.14, 99.9, 0.5, -7.77, 0.0, 42.42, 100.01, 0.001, 999.99],
          'Boolean': [true, false, true, false, true, false, true, false, true, false],
          'String': ['ok', 'success', 'done', 'completed', 'active', 'pending', 'error', 'cancelled', 'ready', 'paused'],
          'ID': ['id-001', 'id-002', 'id-003', 'id-004', 'id-005', 'id-006', 'id-007', 'id-008', 'id-009', 'id-010'],
        };
        const variants = scalarVariants[op.returnType] || ['ok'];
        const result = [];
        for (let i = 0; i < samplesPerOp; i++) { result.push(variants[i % variants.length]); }
        generatedData[op.name] = result;
      } else {
        nonScalarOps.push(op);
      }
    }

    if (nonScalarOps.length > 0) {
      if (!isAIAvailable()) {
        steps.push({ step: 'AI unavailable — using graphql-tools/faker fallback for all operations', status: 'warning' });
      } else {
        const BATCH_SIZE = 8;
        const batches = [];
        for (let i = 0; i < nonScalarOps.length; i += BATCH_SIZE) {
          batches.push(nonScalarOps.slice(i, i + BATCH_SIZE));
        }

        for (let bIdx = 0; bIdx < batches.length; bIdx++) {
          const batch = batches[bIdx];
          steps.push({ step: `Generating batch ${bIdx + 1}/${batches.length} (${batch.map(o => o.name).join(', ')})...`, status: 'running' });

          const opDescriptions = batch.map(op => {
            const typeSchema = buildFullTypeDesc(op.returnType, types, 0, new Set());
            return `Operation "${op.name}":
  Return type: ${op.returnType}${op.isList ? ' (array — return 2-3 items per example)' : ''}
  Type definitions (use EXACT field names):
${typeSchema}`;
          }).join('\n\n');

          const batchPrompt = `Generate ${samplesPerOp} DISTINCT mock data examples for each of the following GraphQL operations.

${opDescriptions}

User request: ${prompt || 'Generate realistic mock data'}
${scenarioInstructions}

CRITICAL RULES:
- Use ONLY the EXACT field names from the type definitions above. Do NOT rename, abbreviate, or invent fields.
- For circular/recursive references (e.g. Author has posts → Post has author → Author), nest at most 1 level deep. Use null for deeper cycles.
- Keep nested objects concise — include all scalar fields but limit list fields to 1 item max.
- For operations returning a list, each example should be an array of 2 items (not more).

Return a JSON object where each key is an operation name, and its value is an ARRAY of exactly ${samplesPerOp} examples.
Use realistic values: real-looking IDs, real dates, and meaningful names appropriate to the schema.

Format: { "opName1": [example1, ...], "opName2": [example1, ...] }`;

          const maxRetries = 3;
          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
              const maxTokens = Math.min(16000, Math.max(4000, samplesPerOp * batch.length * 500));
              const batchResult = await callLLMWithHighTokens(SETUP_SYSTEM_PROMPT, batchPrompt, maxTokens);
              for (const op of batch) {
                const opData = batchResult[op.name];
                if (Array.isArray(opData) && opData.length > 0) {
                  generatedData[op.name] = opData;
                } else if (opData) {
                  generatedData[op.name] = [opData];
                }
              }
              steps[steps.length - 1] = { step: `Batch ${bIdx + 1}/${batches.length} done`, status: 'done' };
              break;
            } catch (err) {
              const isRateLimit = err.message && err.message.includes('Rate limit');
              if (isRateLimit && attempt < maxRetries) {
                const waitMs = attempt * 15000;
                steps.push({ step: `Rate limited, retrying in ${waitMs / 1000}s...`, status: 'warning' });
                await new Promise(r => setTimeout(r, waitMs));
              } else {
                steps[steps.length - 1] = { step: `Batch ${bIdx + 1} warning: ${err.message}`, status: 'warning' };
              }
            }
          }

          if (bIdx < batches.length - 1) await new Promise(r => setTimeout(r, 2000));
        }
      }

      // Smart fallback: use @graphql-tools/mock for any ops the LLM missed
      const missingOps = nonScalarOps.filter(op => !generatedData[op.name]);
      if (missingOps.length > 0) {
        try {
          const toolsMockData = await generateMockViaGraphQLTools(finalSchema, missingOps, types, samplesPerOp);
          for (const op of missingOps) {
            if (toolsMockData[op.name] && toolsMockData[op.name].length > 0) {
              generatedData[op.name] = toolsMockData[op.name];
              steps.push({ step: `graphql-tools mock for ${op.name}`, status: 'warning' });
            }
          }
        } catch (toolsErr) {
          steps.push({ step: `graphql-tools mock failed: ${toolsErr.message}, using faker fallback`, status: 'warning' });
        }

        // Last-resort faker fallback for any ops still missing
        for (const op of missingOps) {
          if (!generatedData[op.name]) {
            const examples = [];
            for (let i = 0; i < samplesPerOp; i++) {
              const mockObj = generateMockObject(op.returnType, types, enums, 0);
              examples.push(op.isList ? [mockObj, generateMockObject(op.returnType, types, enums, 0)] : mockObj);
            }
            generatedData[op.name] = examples;
            steps.push({ step: `Faker fallback for ${op.name}`, status: 'warning' });
          }
        }
      }
    }
    steps[steps.length - 1].status = 'done';

    // Validate all generated data against the schema (strips unknown fields, fixes enums)
    steps.push({ step: 'Validating mock data against schema...', status: 'running' });
    for (const op of operations) {
      if (!generatedData[op.name]) continue;
      generatedData[op.name] = generatedData[op.name].map(sample => {
        if (op.isList && Array.isArray(sample)) {
          return sample.map(item => validateMockData(item, op.returnType, types, enums, 0));
        }
        return validateMockData(sample, op.returnType, types, enums, 0);
      });
    }
    steps[steps.length - 1].status = 'done';

    // Build Postman collection
    steps.push({ step: 'Building Postman collection...', status: 'running' });
    const collection = buildAutoPostmanCollection(serviceName, operations, types, generatedData, serviceVersion);
    steps[steps.length - 1].status = 'done';

    // Write files to artifacts
    steps.push({ step: 'Writing artifacts...', status: 'running' });
    const artifactsDir = ARTIFACTS_DIR;
    const artifactsRoot = path.resolve(artifactsDir);
    const slugName = (serviceName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'ai-generated-api';
    const schemaFile = path.resolve(artifactsRoot, `${slugName}-schema.graphql`);
    const postmanFile = path.resolve(artifactsRoot, `${slugName}-examples.postman.json`);

    const schemaRel = path.relative(artifactsRoot, schemaFile);
    const postmanRel = path.relative(artifactsRoot, postmanFile);
    const schemaOutsideRoot = schemaRel.startsWith('..') || path.isAbsolute(schemaRel);
    const postmanOutsideRoot = postmanRel.startsWith('..') || path.isAbsolute(postmanRel);
    if (schemaOutsideRoot || postmanOutsideRoot) {
      steps[steps.length - 1] = { step: 'Writing artifacts failed: invalid artifact path', status: 'error' };
      return res.status(400).json({
        error: 'Invalid service name for artifact path',
        hint: 'Service name produced a path outside ARTIFACTS_DIR.',
        steps,
      });
    }

    try {
      if (!fs.existsSync(artifactsRoot)) fs.mkdirSync(artifactsRoot, { recursive: true });
      fs.writeFileSync(schemaFile, finalSchema, 'utf-8');
      fs.writeFileSync(postmanFile, JSON.stringify(collection, null, 2), 'utf-8');
      steps[steps.length - 1].status = 'done';
    } catch (err) {
      steps[steps.length - 1] = { step: `Writing artifacts failed: ${err.message}`, status: 'error' };
      return res.status(500).json({
        error: `Failed to persist artifacts to ${artifactsDir}: ${err.message}`,
        hint: 'Verify the artifacts directory is writable (check ARTIFACTS_DIR env var and volume mounts).',
        steps,
      });
    }

    // Reload type maps so the new service is immediately available for scoped queries
    loadSchemaFiles();

    // Delete existing service to prevent stale default examples
    steps.push({ step: 'Cleaning up existing service in Microcks...', status: 'running' });
    try {
      const delResult = await deleteExistingService(serviceName);
      if (delResult.deleted) {
        steps[steps.length - 1].status = 'done';
        await new Promise(r => setTimeout(r, 2000));
      } else {
        steps[steps.length - 1] = { step: 'No existing service to clean up', status: 'done' };
      }
    } catch (err) {
      steps[steps.length - 1] = { step: `Cleanup: ${err.message}`, status: 'warning' };
    }

    // Import to Microcks
    steps.push({ step: 'Importing schema to Microcks...', status: 'running' });
    try {
      await importArtifactToMicrocks(schemaFile, true);
      steps[steps.length - 1].status = 'done';
    } catch (err) {
      steps[steps.length - 1] = { step: `Schema import: ${err.message}`, status: 'warning' };
    }

    await new Promise(r => setTimeout(r, 2000));

    steps.push({ step: 'Importing examples to Microcks...', status: 'running' });
    try {
      await importArtifactToMicrocks(postmanFile, false);
      steps[steps.length - 1].status = 'done';
    } catch (err) {
      steps[steps.length - 1] = { step: `Examples import: ${err.message}`, status: 'warning' };
    }

    // Clear inferred dispatchers, then configure SCRIPT-based variable
    // dispatching so different variable values return different examples.
    steps.push({ step: 'Configuring dispatchers...', status: 'running' });
    try {
      let totalCleared = 0;
      for (let attempt = 1; attempt <= 3; attempt++) {
        await new Promise(r => setTimeout(r, 5000));
        invalidateCache();
        const dispResult = await clearServiceDispatchers(serviceName);
        totalCleared += dispResult.cleared || 0;
        if (totalCleared > 0) break;
      }

      const scriptResults = await configureGraphQLOperationDispatchers(
        serviceName,
        operations,
        samplesPerOp,
      );
      const scripted = scriptResults.filter(r => r.configured).length;
      const skipped = scriptResults.filter(r => !r.configured).length;
      steps[steps.length - 1] = {
        step: `Dispatchers configured (${totalCleared} cleared, ${scripted} scripted, ${skipped} skipped)`,
        status: 'done',
      };
    } catch (err) {
      steps[steps.length - 1] = { step: `Dispatcher config: ${err.message}`, status: 'warning' };
    }

    // Reload schema cache
    loadSchemaFiles();
    invalidateCache();

    registerWorkspaceOps(req, serviceName, operations, generatedData);
    registerService(serviceName, getWorkspaceId(req));

    metrics.logEvent({ type: 'deploy', title: `Deployed mock ${getDisplayName(serviceName, wsId)} (${operations.length} GraphQL ops)`, detail: 'GraphQL', actor: getUserScope(req) });

    const mockRoutes = operations.map(op => ({
      operation: op.name,
      method: op.method,
      returnType: op.returnType,
      isList: op.isList,
      url: `/graphql/${serviceName}`,
      exampleGenerated: !!generatedData[op.name],
    }));

    res.json({
      success: true,
      serviceName,
      displayName: getDisplayName(serviceName, wsId),
      operationCount: operations.length,
      steps,
      mockRoutes,
      schemaFile: `${slugName}-schema.graphql`,
      examplesFile: `${slugName}-examples.postman.json`,
      graphqlEndpoint: `/graphql/${serviceName}`,
      ...(schemaIssues.length > 0 && { schemaIssues }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message, steps });
  }
}

// Read-only schema inspection for the AI Studio "Preview" step. No LLM calls,
// no Microcks writes — just detect the format, validate, and count operations
// so the UI can show what will be built before committing to generate/deploy.
router.post('/ai/detect', (req, res) => {
  const { schema } = req.body || {};
  if (!schema || !String(schema).trim()) {
    return res.status(400).json({ error: 'Paste a GraphQL SDL, OpenAPI/JSON, AsyncAPI, or Protobuf spec.' });
  }

  const out = { schemaType: 'unknown', valid: true, issues: [], operations: null, types: null, aiAvailable: isAIAvailable() };
  try {
    out.schemaType = detectSchemaType(schema);

    if (out.schemaType === 'graphql') {
      const v = validateGraphQLSchema(schema);
      out.valid = v.valid;
      out.issues = [
        ...(v.errors || []).map((e) => ({ level: 'error', message: e.message })),
        ...(v.warnings || []).map((w) => ({ level: 'warning', message: w.message })),
      ];
      try {
        const { types, operations } = parseGraphQLSchema(schema);
        out.operations = operations.length;
        out.types = Object.keys(types).length;
      } catch (e) {
        out.issues.push({ level: 'warning', message: `Parse note: ${e.message}` });
      }
    } else if (out.schemaType === 'openapi') {
      try {
        const { operations } = parseOpenAPISpec(schema);
        out.operations = operations.length;
      } catch (e) {
        out.valid = false;
        out.issues.push({ level: 'error', message: `OpenAPI parse error: ${e.message}` });
      }
    } else if (out.schemaType === 'asyncapi') {
      try {
        const { channels } = parseAsyncAPISpec(schema);
        out.operations = channels.length;
      } catch (e) {
        out.valid = false;
        out.issues.push({ level: 'error', message: `AsyncAPI parse error: ${e.message}` });
      }
    } else if (out.schemaType === 'grpc') {
      try {
        const { services } = parseProtobufSpec(schema);
        out.operations = (services && services[0] && services[0].methods ? services[0].methods.length : 0);
      } catch (e) {
        out.valid = false;
        out.issues.push({ level: 'error', message: `Protobuf parse error: ${e.message}` });
      }
    } else if (out.schemaType === 'unknown') {
      out.valid = false;
      out.issues.push({ level: 'error', message: 'Unsupported schema format.' });
    }
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  res.json(out);
});

router.post('/ai/setup', handleAiSetup);

router.post('/ai/setup-file', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  const contentType = req.headers['content-type'] || '';
  let schemaText = '';
  let prompt = '';
  let serviceName = '';

  if (contentType.includes('multipart')) {
    return res.status(400).json({ error: 'Use /ai/setup with JSON body { schema, prompt } instead. File upload via multipart coming soon.' });
  }

  try {
    const body = JSON.parse(req.body.toString());
    schemaText = body.schema || '';
    prompt = body.prompt || '';
    serviceName = body.serviceName || '';
  } catch (_) {
    schemaText = req.body.toString();
  }

  req.body = { schema: schemaText, prompt, serviceName };
  return handleAiSetup(req, res);
});

module.exports = router;
