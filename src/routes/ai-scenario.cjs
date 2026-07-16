const express = require('express');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parse: gqlParse, Kind } = require('graphql');
const { MICROCKS_URL } = require('../config.cjs');
const { SCALAR_TYPES } = require('../lib/graphql-utils.cjs');
const { httpGet } = require('../lib/http-helpers.cjs');
const { responseOverrides, aiRemovedFields, scenarioStore, getUserScope, markDirty } = require('../state.cjs');
const {
  callLLM,
  AI_SYSTEM_PROMPT,
  REST_AI_SYSTEM_PROMPT,
  ASYNC_AI_SYSTEM_PROMPT,
  GRPC_AI_SYSTEM_PROMPT,
  FAILURE_SCENARIOS,
  buildScenarioPrompt,
  extractFieldsToRemove,
  isAIAvailable,
} = require('../lib/ai-client.cjs');
const { generateMockObject, generateMockFromJsonSchema, generateMockFromProtoMessage } = require('../lib/mock-generators.cjs');
const metrics = require('../lib/metrics.cjs');
const { parseGraphQLSchema, parseAsyncAPISpec, parseProtobufSpec, describeAsyncChannel, describeProtoMessage } = require('../lib/schema-parser.cjs');
const { queryServiceMap, richTypeMap, serviceRichTypeMap, asyncApiSpecs, protoSpecs } = require('../lib/schema-loader.cjs');
const {
  getMicrocksServiceId,
  importArtifactToMicrocks,
  deleteServiceFromMicrocks,
  clearServiceDispatchers,
  invalidateCache,
  configureOperationDispatcher,
} = require('../lib/microcks-service.cjs');
const { buildPostmanCollection, buildSingleOpRestCollection } = require('../lib/postman-builder.cjs');
const { ARTIFACTS_DIR } = require('../config.cjs');

function findMainArtifact(serviceName) {
  const norm = serviceName.toLowerCase().replace(/api$/i, '').replace(/[^a-z0-9]/g, '');

  // Pass 1: exact match only
  const schemaFiles = fs.readdirSync(ARTIFACTS_DIR).filter(f => f.endsWith('-schema.graphql'));
  for (const file of schemaFiles) {
    const fn = file.toLowerCase().replace(/-schema\.graphql$/, '').replace(/-/g, '');
    if (fn === norm) return file;
  }
  const openapiFiles = fs.readdirSync(ARTIFACTS_DIR).filter(f => f.endsWith('-openapi.json') || f.endsWith('-openapi.yaml'));
  for (const file of openapiFiles) {
    const fn = file.toLowerCase().replace(/-openapi\.(json|yaml)$/, '').replace(/-/g, '');
    if (fn === norm) return file;
  }
  const asyncapiFiles = fs.readdirSync(ARTIFACTS_DIR).filter(f => f.endsWith('-asyncapi.yaml') || f.endsWith('-asyncapi.yml'));
  for (const file of asyncapiFiles) {
    const fn = file.toLowerCase().replace(/-asyncapi\.(yaml|yml)$/, '').replace(/-/g, '');
    if (fn === norm) return file;
  }
  const protoFiles = fs.readdirSync(ARTIFACTS_DIR).filter(f => f.endsWith('.proto'));
  for (const file of protoFiles) {
    const fn = file.toLowerCase().replace(/\.proto$/, '').replace(/-/g, '');
    if (fn === norm) return file;
  }

  // Pass 2: substring match (but only if the normalized names are the same length to avoid cross-matching)
  for (const file of schemaFiles) {
    const fn = file.toLowerCase().replace(/-schema\.graphql$/, '').replace(/-/g, '');
    if (fn.length === norm.length && (fn.includes(norm) || norm.includes(fn))) return file;
  }
  for (const file of openapiFiles) {
    const fn = file.toLowerCase().replace(/-openapi\.(json|yaml)$/, '').replace(/-/g, '');
    if (fn.length === norm.length && (fn.includes(norm) || norm.includes(fn))) return file;
  }
  return null;
}

function findExamplesFile(serviceName) {
  const files = fs.readdirSync(ARTIFACTS_DIR).filter(f => f.endsWith('-examples.postman.json'));
  const norm = serviceName.toLowerCase().replace(/api$/i, '').replace(/[^a-z0-9]/g, '');

  // Exact match first
  for (const file of files) {
    const fn = file.toLowerCase().replace(/-examples\.postman\.json$/, '').replace(/-/g, '');
    if (fn === norm) return file;
  }
  // Substring match only for same-length names
  for (const file of files) {
    const fn = file.toLowerCase().replace(/-examples\.postman\.json$/, '').replace(/-/g, '');
    if (fn.length === norm.length && (fn.includes(norm) || norm.includes(fn))) return file;
  }
  for (const file of files) {
    try {
      const coll = JSON.parse(fs.readFileSync(path.join(ARTIFACTS_DIR, file), 'utf-8'));
      if (coll.info && coll.info.name === serviceName) return file;
    } catch(_) {}
  }
  return null;
}

async function uploadPostmanCollection(collection) {
  const tmpFile = path.join(os.tmpdir(), `microcks-inject-${Date.now()}.postman_collection.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(collection, null, 2));
  try {
    const result = await importArtifactToMicrocks(tmpFile, false);
    fs.unlinkSync(tmpFile);
    return result;
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch(_) {}
    throw err;
  }
}

async function restoreOriginalExamples(serviceName) {
  const serviceId = await getMicrocksServiceId(serviceName);
  if (serviceId) {
    await deleteServiceFromMicrocks(serviceId);
    await new Promise(r => setTimeout(r, 1000));
  }

  const mainFile = findMainArtifact(serviceName);
  if (!mainFile) return { restored: false, reason: 'No main artifact found for ' + serviceName };
  await importArtifactToMicrocks(path.join(ARTIFACTS_DIR, mainFile), true);
  await new Promise(r => setTimeout(r, 2000));

  const examplesFile = findExamplesFile(serviceName);
  if (!examplesFile) return { restored: false, reason: 'No examples file found for ' + serviceName };
  await importArtifactToMicrocks(path.join(ARTIFACTS_DIR, examplesFile), false);

  invalidateCache();

  // Clear dispatchers to ensure Microcks serves the restored examples
  try {
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const result = await clearServiceDispatchers(serviceName);
      if (result.cleared > 0) break;
    }
  } catch (e) {
    // Continue even if dispatcher clear fails
  }

  return { restored: true, mainFile, examplesFile };
}

function getRestExampleBody(serviceName, operationName) {
  const norm = serviceName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const files = fs.readdirSync(ARTIFACTS_DIR).filter(f => f.endsWith('-examples.postman.json'));

  for (const file of files) {
    try {
      const coll = JSON.parse(fs.readFileSync(path.join(ARTIFACTS_DIR, file), 'utf-8'));
      if (coll.info && coll.info.name !== serviceName) continue;
      for (const item of (coll.item || [])) {
        if (item.name === operationName) {
          const resp = (item.response || [])[0];
          if (resp && resp.body) return JSON.parse(resp.body);
        }
      }
    } catch (_) {}
  }

  for (const file of files) {
    const fn = file.toLowerCase().replace(/-examples\.postman\.json$/, '').replace(/-/g, '');
    const normSvc = norm.replace(/-/g, '');
    if (fn !== normSvc && !fn.includes(normSvc) && !normSvc.includes(fn)) continue;
    try {
      const coll = JSON.parse(fs.readFileSync(path.join(ARTIFACTS_DIR, file), 'utf-8'));
      for (const item of (coll.item || [])) {
        if (item.name === operationName) {
          const resp = (item.response || [])[0];
          if (resp && resp.body) return JSON.parse(resp.body);
        }
      }
    } catch (_) {}
  }
  return null;
}

async function getRestOperationDetails(serviceName, operationName) {
  const files = fs.readdirSync(ARTIFACTS_DIR).filter(f => f.endsWith('-examples.postman.json'));

  for (const file of files) {
    try {
      const coll = JSON.parse(fs.readFileSync(path.join(ARTIFACTS_DIR, file), 'utf-8'));
      if (coll.info && coll.info.name !== serviceName) continue;
      for (const item of (coll.item || [])) {
        if (item.name === operationName) {
          const req = item.request || {};
          const resp = (item.response || [])[0] || {};
          let url = req.url || '';
          if (typeof url === 'object') url = url.raw || '';
          return {
            method: req.method || 'GET',
            url,
            exampleName: resp.name || 'example',
            statusCode: resp.code || resp.status || 200,
            body: resp.body ? JSON.parse(resp.body) : null,
          };
        }
      }
    } catch (_) {}
  }

  // Fallback: fetch from Microcks when no local artifact exists
  try {
    const serviceId = await getMicrocksServiceId(serviceName);
    if (serviceId) {
      const raw = await httpGet(`${MICROCKS_URL}/api/services/${serviceId}`);
      const data = JSON.parse(raw);
      const svc = data.service || {};
      const msgs = data.messagesMap || {};
      const opMessages = msgs[operationName];
      if (opMessages && opMessages.length > 0) {
        const msg = opMessages[0];
        const resp = msg.response || {};
        const op = (svc.operations || []).find(o => o.name === operationName) || {};
        const parts = operationName.split(' ');
        const method = parts[0] || 'GET';
        const opPath = parts.slice(1).join(' ') || '/';
        let body = null;
        try { body = JSON.parse(resp.content || '{}'); } catch (_) {}
        return {
          method,
          url: `${MICROCKS_URL}/rest/${serviceName}/${svc.version || '1.0'}${opPath}`,
          exampleName: resp.name || 'example-1',
          statusCode: resp.status ? parseInt(resp.status, 10) : 200,
          body,
        };
      }
    }
  } catch (_) {}

  return null;
}

function describeJsonStructure(obj, depth = 0) {
  if (depth > 2) return typeof obj;
  if (obj === null) return 'null';
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return `[${describeJsonStructure(obj[0], depth + 1)}]`;
  }
  if (typeof obj === 'object') {
    const entries = Object.entries(obj).slice(0, 20);
    const fields = entries.map(([k, v]) => {
      if (v === null) return `  ${k}: nullable`;
      if (Array.isArray(v)) return `  ${k}: array`;
      if (typeof v === 'object') return `  ${k}: object`;
      return `  ${k}: ${typeof v}`;
    });
    return `{\n${fields.join('\n')}\n}`;
  }
  return typeof obj;
}

function extractReturnType(typeNode) {
  if (typeNode.kind === 'NamedType') return typeNode.name.value;
  if (typeNode.kind === 'ListType') return extractReturnType(typeNode.type);
  if (typeNode.kind === 'NonNullType') return extractReturnType(typeNode.type);
  return null;
}

function getOperationReturnType(opName) {
  const files = fs.readdirSync(ARTIFACTS_DIR).filter(f => f.endsWith('.graphql'));
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(ARTIFACTS_DIR, file), 'utf-8');
      const doc = gqlParse(content);
      for (const def of doc.definitions) {
        if ((def.kind === Kind.OBJECT_TYPE_DEFINITION || def.kind === Kind.OBJECT_TYPE_EXTENSION) &&
            (def.name.value === 'Query' || def.name.value === 'Mutation')) {
          for (const field of (def.fields || [])) {
            if (field.name.value === opName) return extractReturnType(field.type);
          }
        }
      }
    } catch (_) {}
  }
  return null;
}

function buildTypeSchema(typeName, depth = 0, visited = new Set(), svcName = null) {
  const typeMap = (svcName && serviceRichTypeMap[svcName]) || richTypeMap;
  if (depth > 3 || !typeMap[typeName] || visited.has(typeName)) return '';
  visited.add(typeName);

  const fields = typeMap[typeName];
  const lines = [];
  const nested = [];
  for (const [fname, typeInfo] of Object.entries(fields)) {
    if (fname.startsWith('_')) continue;
    const typeStr = typeInfo.isList ? `[${typeInfo.name}]` : typeInfo.name;
    lines.push(`  ${fname}: ${typeStr}`);
    if (!SCALAR_TYPES.has(typeInfo.name) && typeMap[typeInfo.name] && !visited.has(typeInfo.name)) {
      const sub = buildTypeSchema(typeInfo.name, depth + 1, new Set(visited), svcName);
      if (sub) nested.push(sub);
    }
  }
  let result = `type ${typeName} {\n${lines.join('\n')}\n}`;
  if (nested.length > 0) result += '\n\n' + nested.join('\n\n');
  return result;
}

function applyScenarioTransform(data, scenario) {
  if (!data || typeof data !== 'object') return data;
  const obj = Array.isArray(data) ? data[0] : data;
  if (!obj || typeof obj !== 'object') return data;

  switch (scenario) {
    case 'null-values': {
      const result = {};
      for (const k of Object.keys(obj)) result[k] = null;
      return Array.isArray(data) ? [result] : result;
    }
    case 'empty-arrays': {
      const result = {};
      for (const [k, v] of Object.entries(obj)) {
        if (Array.isArray(v)) result[k] = [];
        else if (typeof v === 'string') result[k] = '';
        else if (typeof v === 'number') result[k] = 0;
        else result[k] = v;
      }
      return Array.isArray(data) ? [result] : result;
    }
    case 'missing-fields': {
      const keys = Object.keys(obj);
      const toRemove = keys.slice(0, Math.max(2, Math.floor(keys.length * 0.3)));
      const result = { ...obj };
      toRemove.forEach(k => delete result[k]);
      return Array.isArray(data) ? [result] : result;
    }
    case 'wrong-types': {
      const result = {};
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') result[k] = 12345;
        else if (typeof v === 'number') result[k] = 'not-a-number';
        else if (typeof v === 'boolean') result[k] = 'yes';
        else if (Array.isArray(v)) result[k] = 'should-be-array';
        else result[k] = v;
      }
      return Array.isArray(data) ? [result] : result;
    }
    case 'boundary-values': {
      const result = {};
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') result[k] = 'x'.repeat(500);
        else if (typeof v === 'number') result[k] = 2147483647;
        else result[k] = v;
      }
      return Array.isArray(data) ? [result] : result;
    }
    case 'encoding-issues': {
      const result = {};
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') result[k] = `<script>alert("${k}")</script> \u00e9\u00e8\u00ea \u2764\ufe0f &amp;`;
        else result[k] = v;
      }
      return Array.isArray(data) ? [result] : result;
    }
    case 'malformed-dates': {
      const result = {};
      const badDates = ['not-a-date', '0', '1970-01-01', 'N/A', '99/99/9999'];
      let di = 0;
      for (const [k, v] of Object.entries(obj)) {
        const fn = k.toLowerCase();
        if (fn.includes('date') || fn.includes('time') || fn.includes('at')) {
          result[k] = badDates[di++ % badDates.length];
        } else {
          result[k] = v;
        }
      }
      return Array.isArray(data) ? [result] : result;
    }
    case 'extra-fields': {
      const result = { ...obj, __internal_id: 'debug-9999', _debug_trace: 'fallback', legacyScore: -1, _deprecated_v1: true };
      return Array.isArray(data) ? [result] : result;
    }
    case 'partial-response': {
      const keys = Object.keys(obj);
      const keep = keys.slice(0, Math.min(2, keys.length));
      const result = {};
      keep.forEach(k => { result[k] = obj[k]; });
      return Array.isArray(data) ? [result] : result;
    }
    case 'mixed-good-bad': {
      const keys = Object.keys(obj);
      const result = { ...obj };
      keys.slice(0, Math.floor(keys.length / 2)).forEach(k => { result[k] = null; });
      return Array.isArray(data) ? [result] : result;
    }
    default:
      return data;
  }
}

function generateFallbackForGraphQL(operation, retType, svcName, scenario, fieldList) {
  const typeMap = (svcName && serviceRichTypeMap[svcName]) || richTypeMap;

  let mockData = null;
  if (retType && typeMap[retType]) {
    mockData = generateMockObject(retType, typeMap, {}, 0);
    if (mockData && fieldList && fieldList.length > 0) {
      const filtered = {};
      for (const f of fieldList) {
        if (f in mockData) filtered[f] = mockData[f];
      }
      mockData = filtered;
    }
  } else {
    mockData = { id: 'fallback-001', name: 'Fallback Mock', status: 'active' };
  }

  if (scenario && scenario !== 'success') {
    mockData = applyScenarioTransform(mockData, scenario);
  }

  return { data: { [operation]: mockData } };
}

function generateFallbackForRest(exampleBody, scenario) {
  let mockData = exampleBody || { id: 'fallback-001', status: 'ok', message: 'Fallback mock data' };

  if (scenario && scenario !== 'success') {
    mockData = applyScenarioTransform(mockData, scenario);
  }

  return mockData;
}

const router = express.Router();

const aiScenarioRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(aiScenarioRateLimiter);

router.post('/ai/scenario', async (req, res) => {
  const { service, operation, prompt, scenario, fields, apiType, preview, resolvedOperation } = req.body;
  if (!service || !operation) return res.status(400).json({ error: 'Provide "service" and "operation"' });
  if (!prompt && !scenario) return res.status(400).json({ error: 'Provide "prompt" or "scenario"' });

  const isRest = apiType === 'rest';
  const fieldList = (fields && fields.length > 0) ? fields : null;

  if (isRest) {
    const details = await getRestOperationDetails(service, operation);
    const exampleBody = details ? details.body : null;
    const structureDesc = exampleBody ? describeJsonStructure(exampleBody) : '{}';
    const restFields = fieldList || (exampleBody ? Object.keys(exampleBody) : []);
    const fNames = restFields.join(', ') || 'all fields';
    const scenarioPrompt = buildScenarioPrompt(scenario, restFields, fNames, 'response');

    const isCustomRestPrompt = !!prompt && !scenario;
    const userPrompt = prompt || scenarioPrompt || '';
    let opMsg;
    if (isCustomRestPrompt) {
      opMsg = `USER INSTRUCTION (follow this EXACTLY): ${userPrompt}\n\nThe response has these fields: ${fNames}.\nFollow the user instruction above precisely. If they say to remove/delete fields, those fields must be COMPLETELY ABSENT from the JSON (not null, not empty — the key itself must not exist). If they say to set fields to null, set them to null. Do exactly what is asked.\n\nOriginal response structure:\n${structureDesc}\n\nExample body:\n${JSON.stringify(exampleBody, null, 2).slice(0, 1500)}\n\nReturn ONLY valid JSON matching this REST response structure. Do NOT wrap in {"data": ...}.`;
    } else {
      opMsg = userPrompt + `\n\nOriginal response structure:\n${structureDesc}\n\nExample body:\n${JSON.stringify(exampleBody, null, 2).slice(0, 1500)}\n\nReturn ONLY valid JSON matching this REST response structure. Do NOT wrap in {"data": ...}.`;
    }

    let aiData;
    let fallback = false;
    if (!isAIAvailable()) {
      aiData = generateFallbackForRest(exampleBody, scenario);
      fallback = true;
    } else {
      try {
        aiData = await callLLM(REST_AI_SYSTEM_PROMPT, opMsg);
      } catch (err) {
        aiData = generateFallbackForRest(exampleBody, scenario);
        fallback = true;
      }
    }

    if (!fallback && isCustomRestPrompt) {
      const toRemove = extractFieldsToRemove(userPrompt, restFields);
      if (toRemove.length > 0 && typeof aiData === 'object') {
        toRemove.forEach(field => delete aiData[field]);
      }
    }

    if (preview) {
      return res.json({ preview: aiData, scenario: scenario || 'custom', apiType: 'rest', service, operation, fallback });
    }

    const userScope = req.body.global ? 'global' : getUserScope(req);
    const storeOp = resolvedOperation || operation;
    const key = `${userScope}:${service}:${storeOp}`;
    scenarioStore[key] = { data: aiData, scenario: scenario || 'custom', apiType: 'rest' };
    markDirty();
    metrics.logEvent({ type: 'chaos', title: `Injected "${scenario || 'custom'}" on ${service}/${storeOp}`, detail: 'REST', actor: userScope });
    res.json({
      message: `Scenario active for REST ${service}/${storeOp}`,
      appliedTo: 'server',
      key,
      user: userScope,
      preview: aiData,
      scenario: scenario || 'custom',
      apiType: 'rest',
      fallback,
    });
    return;
  }

  // ── AsyncAPI scenario ─────────────────────────────────────────────
  if (apiType === 'asyncapi') {
    let channelSchema = null;
    for (const spec of Object.values(asyncApiSpecs)) {
      const ch = spec.channels[operation];
      if (ch) { channelSchema = ch; break; }
    }
    const schemaDesc = channelSchema ? describeAsyncChannel(channelSchema) : '{}';
    const fNames = fieldList ? fieldList.join(', ') : 'all fields';
    const scenarioPrompt = buildScenarioPrompt(scenario, fieldList, fNames, 'message payload');
    const userPrompt = prompt || scenarioPrompt || '';
    const opMsg = userPrompt + `\n\nChannel: ${operation}\nMessage payload schema:\n${schemaDesc}\n\nReturn ONLY valid JSON matching this message payload structure.`;

    let aiData;
    let fallback = false;
    if (!isAIAvailable()) {
      aiData = channelSchema ? generateMockFromJsonSchema(channelSchema.schema) : {};
      fallback = true;
    } else {
      try {
        aiData = await callLLM(ASYNC_AI_SYSTEM_PROMPT, opMsg);
      } catch (err) {
        aiData = channelSchema ? generateMockFromJsonSchema(channelSchema.schema) : {};
        fallback = true;
      }
    }

    if (preview) {
      return res.json({ preview: aiData, scenario: scenario || 'custom', apiType: 'asyncapi', service, operation, fallback });
    }

    const userScope = req.body.global ? 'global' : getUserScope(req);
    const key = `${userScope}:${service}:${operation}`;
    scenarioStore[key] = { data: aiData, scenario: scenario || 'custom', apiType: 'asyncapi' };
    markDirty();
    return res.json({
      message: `Scenario active for AsyncAPI ${service}/${operation}`,
      key,
      user: userScope,
      preview: aiData,
      scenario: scenario || 'custom',
      apiType: 'asyncapi',
      fallback,
    });
  }

  // ── gRPC scenario ─────────────────────────────────────────────────
  if (apiType === 'grpc') {
    let outputMsgName = null;
    let messages = {};
    let protoEnums = {};
    for (const spec of Object.values(protoSpecs)) {
      for (const svc of spec.services) {
        const method = svc.methods.find(m => m.name === operation);
        if (method) { outputMsgName = method.outputType; break; }
      }
      if (outputMsgName) break;
    }
    // Try loading from the artifact file if we have one
    const mainArtifact = findMainArtifact(service);
    if (mainArtifact && mainArtifact.endsWith('.proto')) {
      try {
        const content = fs.readFileSync(path.join(ARTIFACTS_DIR, mainArtifact), 'utf-8');
        const parsed = parseProtobufSpec(content);
        messages = parsed.messages;
        protoEnums = parsed.enums;
        if (!outputMsgName) {
          for (const svc of parsed.services) {
            const method = svc.methods.find(m => m.name === operation);
            if (method) { outputMsgName = method.outputType; break; }
          }
        }
      } catch (_) {}
    }

    const schemaDesc = outputMsgName && messages[outputMsgName]
      ? describeProtoMessage(outputMsgName, messages, protoEnums)
      : '{}';
    const fNames = fieldList ? fieldList.join(', ') : 'all fields';
    const scenarioPrompt = buildScenarioPrompt(scenario, fieldList, fNames, 'gRPC response');
    const userPrompt = prompt || scenarioPrompt || '';
    const opMsg = userPrompt + `\n\nrpc ${operation} response message ${outputMsgName || 'unknown'}:\n${schemaDesc}\n\nReturn ONLY valid JSON matching this protobuf message structure.`;

    let aiData;
    let fallback = false;
    if (!isAIAvailable()) {
      aiData = outputMsgName ? generateMockFromProtoMessage(outputMsgName, messages, protoEnums) : {};
      fallback = true;
    } else {
      try {
        aiData = await callLLM(GRPC_AI_SYSTEM_PROMPT, opMsg);
      } catch (err) {
        aiData = outputMsgName ? generateMockFromProtoMessage(outputMsgName, messages, protoEnums) : {};
        fallback = true;
      }
    }

    if (preview) {
      return res.json({ preview: aiData, scenario: scenario || 'custom', apiType: 'grpc', service, operation, fallback });
    }

    const userScope = req.body.global ? 'global' : getUserScope(req);
    const key = `${userScope}:${service}:${operation}`;
    scenarioStore[key] = { data: aiData, scenario: scenario || 'custom', apiType: 'grpc' };
    markDirty();
    return res.json({
      message: `Scenario active for gRPC ${service}/${operation}`,
      key,
      user: userScope,
      preview: aiData,
      scenario: scenario || 'custom',
      apiType: 'grpc',
      fallback,
    });
  }

  // GraphQL scenario
  const retType = getOperationReturnType(operation);
  const svcForSchema = queryServiceMap[operation] || service || null;
  const schemaCtx = retType ? buildTypeSchema(retType, 0, new Set(), svcForSchema) : '';
  const fNames = fieldList ? fieldList.join(', ') : 'all fields';
  const scenarioPrompt = buildScenarioPrompt(scenario, fieldList, fNames, 'query');

  const isCustomPrompt = !!(prompt && String(prompt).trim());
  const userPrompt = prompt || scenarioPrompt || '';
  let fieldsConstraint = '';
  if (!isCustomPrompt && fieldList && !['missing-fields', 'extra-fields', 'deprecated-fields', 'partial-response'].includes(scenario)) {
    fieldsConstraint = `\nThe response object MUST contain ONLY these fields: ${fNames}.`;
  }

  const toNull = isCustomPrompt ? extractFieldsToRemove(userPrompt, fieldList) : [];
  const explicitNullFields = toNull.length > 0
    ? `\n\nSET THESE FIELDS TO null (not empty object, not omitted): ${toNull.join(', ')}.`
    : '';

  // Extract example number from request (if provided) to generate diverse data
  const exampleNum = req.body.example || req.body.exchangeName || '';
  const diversityHint = exampleNum ? `\nIMPORTANT: This is ${exampleNum}. Generate DIFFERENT realistic data from other examples. Vary: names, dates, numbers, titles, identifiers, etc. Make each example distinct.` : '';

  let opMsg;
  if (isCustomPrompt) {
    opMsg = `USER INSTRUCTION (follow this EXACTLY): ${userPrompt}\n\nThe query has these fields: ${fNames}.\nCRITICAL: Follow the user instruction above precisely. When they say "remove", "delete", or "omit" specific fields, set those fields to null — do NOT use empty objects {} or omit the keys (GraphQL requires all requested fields present). All other fields: return realistic values.${explicitNullFields}${diversityHint}\n\nSchema for reference:\n${schemaCtx}\nReturn ONLY valid JSON as: {"data": {"${operation}": {...}}}`;
  } else {
    opMsg = userPrompt + `\n\nSchema (use EXACT field names and types below):\n${schemaCtx}${fieldsConstraint}\nCRITICAL: Every nested object must use the EXACT sub-field names from the schema above. Do NOT invent field names.${diversityHint}\nReturn ONLY valid JSON as: {"data": {"${operation}": {...}}}`;
  }

  let aiData;
  let fallback = false;
  if (!isAIAvailable()) {
    aiData = generateFallbackForGraphQL(operation, retType, svcForSchema, scenario, fieldList);
    fallback = true;
  } else {
    try {
      aiData = await callLLM(AI_SYSTEM_PROMPT, opMsg);
    } catch (err) {
      aiData = generateFallbackForGraphQL(operation, retType, svcForSchema, scenario, fieldList);
      fallback = true;
    }
  }

  if (!fallback && isCustomPrompt && fieldList) {
    const toRemove = extractFieldsToRemove(userPrompt, fieldList);
    if (toRemove.length > 0 && aiData?.data?.[operation]) {
      toRemove.forEach(field => delete aiData.data[operation][field]);
      const userScope = getUserScope(req);
      aiRemovedFields[`${userScope}:${service}:${operation}`] = toRemove;
    }
  }

  if (preview) {
    return res.json({ preview: aiData, scenario: scenario || 'custom', apiType: 'graphql', service, operation, example: exampleNum, fallback });
  }

  const userScope = req.body.global ? 'global' : getUserScope(req);
  const key = exampleNum ? `${userScope}:${service}:${operation}:${exampleNum}` : `${userScope}:${service}:${operation}`;
  scenarioStore[key] = { data: aiData, scenario: scenario || 'custom', apiType: 'graphql', example: exampleNum };
  markDirty();
  metrics.logEvent({ type: 'chaos', title: `Injected "${scenario || 'custom'}" on ${service}/${operation}`, detail: 'GraphQL', actor: userScope });
  res.json({
    message: `Scenario active for ${service}/${operation}${exampleNum ? ` (${exampleNum})` : ''}`,
    appliedTo: 'server',
    key,
    user: userScope,
    preview: aiData,
    scenario: scenario || 'custom',
    example: exampleNum,
    fallback,
  });
});

router.post('/ai/restore', async (req, res) => {
  const { service } = req.body;
  if (!service) return res.status(400).json({ error: 'Provide "service"' });
  try {
    const result = await restoreOriginalExamples(service);
    invalidateCache();
    const userScope = getUserScope(req);
    for (const key of Object.keys(aiRemovedFields)) {
      if (key.startsWith(`${userScope}:${service}:`)) delete aiRemovedFields[key];
    }
    for (const key of Object.keys(scenarioStore)) {
      if (key.startsWith(`${userScope}:${service}:`)) delete scenarioStore[key];
    }
    metrics.logEvent({ type: 'restore', title: `Restored ${service} to original mock data`, actor: userScope });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Restore failed: ' + err.message });
  }
});

router.get('/ai/scenarios', (req, res) => {
  res.json({ scenarios: Object.entries(FAILURE_SCENARIOS).map(([id, s]) => ({ id, name: s.name, description: s.prompt.split('.')[0] + '.' })) });
});

router.get('/ai/scenarios/active', (req, res) => {
  const userPrefix = getUserScope(req) + ':';
  const active = {};
  for (const [k, v] of Object.entries(scenarioStore)) {
    if (k.startsWith(userPrefix)) {
      active[k.slice(userPrefix.length)] = { scenario: v.scenario, apiType: v.apiType };
    }
  }
  res.json({ scenarios: active });
});

router.delete('/ai/scenarios/active', (req, res) => {
  const userPrefix = getUserScope(req) + ':';
  let cleared = 0;
  Object.keys(scenarioStore).forEach(k => {
    if (k.startsWith(userPrefix)) { delete scenarioStore[k]; cleared++; }
  });
  markDirty();
  res.json({ message: `${cleared} scenario(s) cleared` });
});

router.post('/ai/scenario/clear', (req, res) => {
  const { service, operation } = req.body;
  if (!service || !operation) return res.status(400).json({ error: 'Provide service and operation' });

  const userScope = getUserScope(req);
  const wsId = req.headers['x-workspace'] || null;
  let cleared = 0;

  const keysToCheck = [
    `${userScope}:${service}:${operation}`,
    `global:${service}:${operation}`,
  ];
  if (wsId) {
    keysToCheck.unshift(`ws:${wsId}:${userScope}:${service}:${operation}`);
  }

  for (const key of keysToCheck) {
    if (scenarioStore[key]) { delete scenarioStore[key]; cleared++; }
    if (responseOverrides[key]) { delete responseOverrides[key]; cleared++; }
    if (aiRemovedFields[key]) { delete aiRemovedFields[key]; cleared++; }
  }

  for (const k of Object.keys(scenarioStore)) {
    if (k.startsWith(`${userScope}:${service}:${operation}:`)) { delete scenarioStore[k]; cleared++; }
    if (wsId && k.startsWith(`ws:${wsId}:${userScope}:${service}:${operation}:`)) { delete scenarioStore[k]; cleared++; }
  }

  markDirty();
  res.json({ cleared, service, operation });
});

router.post('/ai/scenario-inject', async (req, res) => {
  const { service, operation, data, apiType, scenarioName, variables, resolvedOperation } = req.body;
  if (!service || !operation || !data) {
    return res.status(400).json({ error: 'Provide service, operation, and data' });
  }

  try {
    let collection;
    if (apiType === 'rest') {
      const parts = operation.split(' ');
      const method = parts[0] || 'GET';
      const templatePath = parts.slice(1).join(' ') || '/';

      let resolvedPath = null;
      if (resolvedOperation) {
        const rParts = resolvedOperation.split(' ');
        resolvedPath = rParts.slice(1).join(' ') || null;
      }

      collection = buildSingleOpRestCollection(service, operation, data, {
        method,
        url: resolvedPath ? `http://example.com${resolvedPath}` : `http://example.com${templatePath}`,
        statusCode: 200,
        resolvedPath,
        templatePath,
      });
    } else {
      collection = buildPostmanCollection(service, operation, data, null, variables);
    }
    await uploadPostmanCollection(collection);
    invalidateCache();

    if (apiType === 'rest') {
      const parts = operation.split(' ');
      const templatePath = parts.slice(1).join(' ') || '/';
      const pathParams = [];
      templatePath.replace(/\{(\w+)\}/g, (_, name) => { pathParams.push(name); });

      let fallbackName = 'default';
      if (resolvedOperation && pathParams.length > 0) {
        const rParts = (resolvedOperation.split(' ').slice(1).join(' ') || '/').split('/');
        const tParts = templatePath.split('/');
        const vals = [];
        for (let i = 0; i < tParts.length; i++) {
          if (tParts[i] && tParts[i].startsWith('{') && rParts[i]) vals.push(rParts[i]);
        }
        if (vals.length > 0) fallbackName = vals.join('-');
      }

      if (pathParams.length > 0) {
        try {
          await configureOperationDispatcher(
            service,
            operation,
            'FALLBACK',
            JSON.stringify({
              dispatcher: 'URI_PARTS',
              dispatcherRules: pathParams.join(' && '),
              fallback: fallbackName,
            })
          );
        } catch (_) {}
      }
    }

    res.json({ injected: true, service, operation, scenarioName: scenarioName || 'custom' });
  } catch (err) {
    res.json({ injected: false, error: err.message, service, operation });
  }
});

module.exports = router;
