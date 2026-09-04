const express = require('express');
const fs = require('fs');
const path = require('path');
const { parse: gqlParse, Kind } = require('graphql');
const { SCALAR_TYPES } = require('../lib/graphql-utils.cjs');
const { responseOverrides, variableMockStore, getUserScope, getEffectiveScope, markDirty } = require('../state.cjs');
const { callLLM, AI_SYSTEM_PROMPT, FAILURE_SCENARIOS, buildScenarioPrompt, isAIAvailable } = require('../lib/ai-client.cjs');
const { fullTypeMap, queryServiceMap, queryArgsMap, richTypeMap, serviceRichTypeMap } = require('../lib/schema-loader.cjs');
const { generateMockObject, generateMockValue } = require('../lib/mock-generators.cjs');
const { parseOpenAPISpec, describeSchema } = require('../lib/schema-parser.cjs');
const { ARTIFACTS_DIR } = require('../config.cjs');

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

function extractReturnType(typeNode) {
  if (typeNode.kind === 'NamedType') return typeNode.name.value;
  if (typeNode.kind === 'ListType') return extractReturnType(typeNode.type);
  if (typeNode.kind === 'NonNullType') return extractReturnType(typeNode.type);
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

function generateFallbackData(targetType, opLabel, svcName) {
  const typeMap = (svcName && serviceRichTypeMap[svcName]) || richTypeMap;
  if (targetType && typeMap[targetType]) {
    const mockObj = generateMockObject(targetType, typeMap, {}, 0);
    return { data: { [opLabel]: mockObj } };
  }
  return { data: { [opLabel]: { id: 'fallback-001', name: 'Fallback Mock', status: 'active' } } };
}

const router = express.Router();

router.post('/ai/generate', async (req, res) => {
  const { type, operation, prompt, scenario } = req.body;
  if (!prompt && !scenario) return res.status(400).json({ error: 'Provide "prompt" or "scenario"' });

  let schemaCtx = '';
  let targetType = type;
  if (operation) {
    const ret = getOperationReturnType(operation);
    if (ret) { targetType = ret; schemaCtx += `Operation: ${operation} → ${ret}\n`; }
  }
  if (targetType && fullTypeMap[targetType]) schemaCtx += buildTypeSchema(targetType, 0, new Set()) + '\n';

  const scenarioDef = scenario ? FAILURE_SCENARIOS[scenario] : null;
  const opLabel = operation || targetType || 'result';
  const userMsg = (scenarioDef ? scenarioDef.prompt : prompt) +
    `\n\nSchema:\n${schemaCtx}\nReturn JSON as {"data": {"${opLabel}": {...}}}`;

  const svcName = operation ? queryServiceMap[operation] : null;
  let fallback = false;
  let result;
  if (!isAIAvailable()) {
    result = generateFallbackData(targetType, opLabel, svcName);
    fallback = true;
  } else {
    try {
      result = await callLLM(AI_SYSTEM_PROMPT, userMsg);
    } catch (err) {
      result = generateFallbackData(targetType, opLabel, svcName);
      fallback = true;
    }
  }
  res.json({ generated: result, schema: targetType, scenario: scenarioDef?.name || 'custom', fallback });
});

router.post('/ai/override', async (req, res) => {
  const { service, operation, data, prompt, scenario, fields, count = 1 } = req.body;
  if (!service || !operation) return res.status(400).json({ error: 'Provide "service" and "operation"' });

  let overrideData = data;
  if (!overrideData && (prompt || scenario)) {
    const retType = getOperationReturnType(operation);
    const svcForSchema = queryServiceMap[operation] || service || null;
    const schemaCtx = retType ? buildTypeSchema(retType, 0, new Set(), svcForSchema) : '';
    const fieldList = (fields && fields.length > 0) ? fields : null;
    const fNames = fieldList ? fieldList.join(', ') : 'all fields';
    const scenarioPrompt = buildScenarioPrompt(scenario, fieldList, fNames, 'query');

    const userPrompt = scenarioPrompt || prompt || '';
    const opMsg = userPrompt + `\n\nSchema context:\n${schemaCtx}\n\nReturn ONLY valid JSON as: {"data": {"${operation}": {...}}}`;
    const svcForFallback = queryServiceMap[operation] || service;
    if (!isAIAvailable()) {
      overrideData = generateFallbackData(retType, operation, svcForFallback);
    } else {
      try {
        overrideData = await callLLM(AI_SYSTEM_PROMPT, opMsg);
      } catch (err) {
        overrideData = generateFallbackData(retType, operation, svcForFallback);
      }
    }
  }
  if (!overrideData) return res.status(400).json({ error: 'Provide "data", "prompt", or "scenario"' });

  const userScope = getUserScope(req);
  const key = `${userScope}:${service}:${operation}`;
  responseOverrides[key] = { data: overrideData, remaining: count };
  res.json({ message: `Override active for ${service}:${operation} (${count} request${count > 1 ? 's' : ''})`, key, user: userScope, remaining: count, preview: overrideData });
});

router.get('/ai/overrides', (req, res) => {
  const userPrefix = getUserScope(req) + ':';
  const active = {};
  for (const [k, v] of Object.entries(responseOverrides)) {
    if (v.remaining > 0 && k.startsWith(userPrefix)) {
      active[k.slice(userPrefix.length)] = { remaining: v.remaining };
    }
  }
  res.json({ overrides: active });
});

router.delete('/ai/overrides', (req, res) => {
  const userPrefix = getUserScope(req) + ':';
  let cleared = 0;
  Object.keys(responseOverrides).forEach(k => {
    if (k.startsWith(userPrefix)) { delete responseOverrides[k]; cleared++; }
  });
  res.json({ message: `${cleared} override(s) cleared` });
});

function loadRestSchemaContext(serviceName, operationName) {
  const norm = serviceName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const files = fs.readdirSync(ARTIFACTS_DIR).filter(f => f.endsWith('-openapi.json') || f.endsWith('-openapi.yaml'));
  let specFile = null;
  for (const f of files) {
    const fn = f.toLowerCase().replace(/-openapi\.(json|yaml)$/, '').replace(/-/g, '');
    if (fn === norm || fn.includes(norm) || norm.includes(fn)) { specFile = f; break; }
  }
  if (!specFile) return { schemaCtx: '', params: [] };

  try {
    const specText = fs.readFileSync(path.join(ARTIFACTS_DIR, specFile), 'utf-8');
    const { spec, operations } = parseOpenAPISpec(specText);
    const parts = operationName.split(' ');
    const method = (parts[0] || '').toUpperCase();
    const opPath = parts.slice(1).join(' ');
    const op = operations.find(o => o.method === method && o.path === opPath)
            || operations.find(o => o.name === operationName);

    if (!op) {
      const allSchemas = operations.map(o => {
        const resp = o.responseSchema ? describeSchema(o.responseSchema, spec, 0, '') : '';
        return `${o.name}: ${resp || 'unknown'}`;
      }).join('\n');
      return { schemaCtx: `Service: ${serviceName}\nAll operations:\n${allSchemas}`, params: [] };
    }

    let ctx = `Service: ${serviceName}\nEndpoint: ${op.method} ${op.path}\n`;
    if (op.summary) ctx += `Summary: ${op.summary}\n`;
    if (op.responseSchema) ctx += `Response schema:\n${describeSchema(op.responseSchema, spec, 0, '')}\n`;
    if (op.requestSchema) ctx += `Request body schema:\n${describeSchema(op.requestSchema, spec, 0, '')}\n`;

    const params = (op.parameters || []).map(p => ({
      name: p.name,
      in: p.in,
      type: p.schema?.type || 'string',
      required: !!p.required,
    }));
    if (params.length > 0) ctx += `Parameters: ${params.map(p => `${p.name} (${p.in}, ${p.type}${p.required ? ', required' : ''})`).join(', ')}\n`;

    return { schemaCtx: ctx, params };
  } catch (_) {
    return { schemaCtx: '', params: [] };
  }
}

router.post('/ai/suggest-scenarios', async (req, res) => {
  const { service, operation, apiType, prompt: userFocus } = req.body;
  if (!operation) return res.status(400).json({ error: 'Provide "operation"' });

  const isRest = apiType === 'rest';
  let schemaCtx = '';
  let argsInfo = [];

  if (isRest) {
    const restCtx = loadRestSchemaContext(service, operation);
    schemaCtx = restCtx.schemaCtx;
    argsInfo = restCtx.params.map(p => ({ name: p.name, type: p.type, isList: false }));
  } else {
    const retType = getOperationReturnType(operation);
    const svcName = queryServiceMap[operation] || service || null;
    if (retType) schemaCtx = buildTypeSchema(retType, 0, new Set(), svcName);
    const args = queryArgsMap[operation];
    if (args) argsInfo = args.map(a => ({ name: a.name, type: a.typeName, isList: a.isList }));
  }

  const prompt = `Analyze this API operation and suggest specific, actionable test scenarios.

Operation: ${operation}
Type: ${isRest ? 'REST' : 'GraphQL'}
${argsInfo.length > 0 ? `Arguments: ${argsInfo.map(a => `${a.name}: ${a.isList ? '[' + a.type + ']' : a.type}`).join(', ')}` : ''}
${schemaCtx ? `Schema:\n${schemaCtx}` : ''}
${userFocus ? `\nUSER FOCUS (required — every scenario must relate to this): ${userFocus}` : ''}

Return JSON with this structure:
{
  "scenarios": [
    {
      "id": "unique-kebab-id",
      "name": "Short Name",
      "category": "one of: edge-case, error-handling, data-integrity, performance, security, business-logic",
      "severity": "one of: critical, high, medium, low",
      "description": "What this tests and why it matters",
      "prompt": "Exact prompt to generate this mock data",
      "variables": ${argsInfo.length > 0 ? 'suggested variable values as an object or null' : 'null'}
    }
  ]
}

Generate 8-12 specific scenarios that are tailored to this particular operation and schema. Include:
- Edge cases specific to the field types (e.g., empty strings, negative numbers, future dates)
- Business logic violations (e.g., inconsistent totals, impossible state combinations)
- Null/missing data patterns specific to which fields consumers likely depend on
- Variable-specific scenarios (different variable inputs producing different edge cases)
- Real-world failure modes for APIs (delayed data, provisional/partial results, timeouts)`;

  if (!isAIAvailable()) {
    return res.json({
      scenarios: Object.entries(FAILURE_SCENARIOS).slice(0, 8).map(([id, s]) => ({
        id,
        name: s.name,
        category: 'edge-case',
        severity: 'medium',
        description: s.prompt.split('.')[0] + '.',
        prompt: s.prompt,
        variables: null,
      })),
      fallback: true,
    });
  }
  try {
    const result = await callLLM(AI_SYSTEM_PROMPT, prompt);
    res.json({ ...result, fallback: false });
  } catch (err) {
    res.json({
      scenarios: Object.entries(FAILURE_SCENARIOS).slice(0, 8).map(([id, s]) => ({
        id,
        name: s.name,
        category: 'edge-case',
        severity: 'medium',
        description: s.prompt.split('.')[0] + '.',
        prompt: s.prompt,
        variables: null,
      })),
      fallback: true,
    });
  }
});

router.post('/ai/generate-with-variables', async (req, res) => {
  const { service, operation, variables, prompt, scenario, selectedFields } = req.body;
  if (!service || !operation) return res.status(400).json({ error: 'Provide "service" and "operation"' });
  if (!variables || Object.keys(variables).length === 0) return res.status(400).json({ error: 'Provide "variables" object' });

  const varKey = JSON.stringify(variables, Object.keys(variables).sort());
  const scope = getEffectiveScope(req);
  const storeKey = `${scope}:${service}:${operation}:${varKey}`;

  if (!prompt && !scenario && variableMockStore[storeKey]) {
    return res.json({ data: variableMockStore[storeKey].data, cached: true, variables });
  }

  const retType = getOperationReturnType(operation);
  const svcName = queryServiceMap[operation] || service;
  const schemaCtx = retType ? buildTypeSchema(retType, 0, new Set(), svcName) : '';

  const variableDesc = Object.entries(variables).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ');
  const fieldConstraint = selectedFields && selectedFields.length > 0
    ? `\nInclude ONLY these fields in the response: ${selectedFields.join(', ')}.`
    : '';

  const scenarioDef = scenario ? FAILURE_SCENARIOS[scenario] : null;
  const basePrompt = scenarioDef ? scenarioDef.prompt : (prompt || 'Generate realistic mock data');

  const userMsg = `${basePrompt}

Operation: ${operation}
Variables: ${variableDesc}
${fieldConstraint}
IMPORTANT: The mock data MUST be contextually appropriate for these specific variable values. For example, if slug="my-example-item", generate data about that item. If id="123", use that ID.

Schema:
${schemaCtx}

Return ONLY valid JSON as: {"data": {"${operation}": {...}}}`;

  let fallback = false;
  let result;
  if (!isAIAvailable()) {
    result = generateFallbackData(retType, operation, svcName);
    fallback = true;
  } else {
    try {
      result = await callLLM(AI_SYSTEM_PROMPT, userMsg);
    } catch (err) {
      result = generateFallbackData(retType, operation, svcName);
      fallback = true;
    }
  }
  variableMockStore[storeKey] = { data: result, variables, timestamp: Date.now() };
  res.json({ data: result, variables, cached: false, storeKey, fallback });
});

router.get('/ai/variable-mocks', (req, res) => {
  const { service, operation } = req.query;
  const scope = getEffectiveScope(req);
  const prefix = `${scope}:${service || ''}:${operation || ''}`;
  const mocks = {};
  for (const [k, v] of Object.entries(variableMockStore)) {
    if (k.startsWith(prefix)) {
      mocks[k] = { variables: v.variables, timestamp: v.timestamp };
    }
  }
  res.json({ mocks });
});

module.exports = router;
