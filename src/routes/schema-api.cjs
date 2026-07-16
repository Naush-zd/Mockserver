'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { MICROCKS_URL, ARTIFACTS_DIR } = require('../config.cjs');
const { httpGet, httpGetLong } = require('../lib/http-helpers.cjs');
const state = require('../state.cjs');
const { proxyUrls } = state;
const {
  queryFieldMap,
  queryServiceMap,
  queryArgsMap,
  serviceRichTypeMap,
  fullTypeMap,
  loadSchemaFiles,
  loadAsyncApiSpecs,
  loadProtobufSpecs,
} = require('../lib/schema-loader.cjs');
const { serverBuildFieldsQuery, SCALAR_TYPES } = require('../lib/graphql-utils.cjs');
const { compareTypes, describeType } = require('../lib/validation.cjs');

const router = express.Router();

const artifactsDir = () => ARTIFACTS_DIR;

function schemaTypeToJsType(typeName) {
  const map = { String: 'string', Int: 'number', Float: 'number', Boolean: 'boolean', ID: 'string', DateTime: 'string', Date: 'string', Long: 'number', BigDecimal: 'number', URL: 'string', URI: 'string', JSON: 'object' };
  return map[typeName] || 'object';
}

function validateAgainstSchemaType(typeMap, typeName, data, path, violations, queryFields, depth) {
  if (depth > 4 || !data || typeof data !== 'object') return;
  const schemaFields = typeMap[typeName];
  if (!schemaFields) return;

  const fieldsToCheck = (queryFields && queryFields.length > 0 && depth === 0) ? queryFields : Object.keys(data);

  for (const field of fieldsToCheck) {
    const schemaField = schemaFields[field];
    const actual = data[field];
    const fieldPath = path ? `${path}.${field}` : field;

    if (!schemaField) {
      if (field in data) {
        violations.push({ field: fieldPath, expected: 'absent', got: describeType(actual), message: `"${fieldPath}" is not defined in schema type "${typeName}"` });
      }
      continue;
    }

    if (actual === undefined || actual === null) continue;

    const expectedJsType = schemaTypeToJsType(schemaField.name);

    if (schemaField.isList) {
      if (!Array.isArray(actual)) {
        violations.push({ field: fieldPath, expected: `[${schemaField.name}]`, got: describeType(actual), message: `"${fieldPath}" expected array of ${schemaField.name}, got ${describeType(actual)}` });
      } else if (actual.length > 0 && !SCALAR_TYPES.has(schemaField.name) && typeMap[schemaField.name]) {
        validateAgainstSchemaType(typeMap, schemaField.name, actual[0], `${fieldPath}[0]`, violations, null, depth + 1);
      }
    } else if (SCALAR_TYPES.has(schemaField.name)) {
      if (typeof actual !== expectedJsType) {
        violations.push({ field: fieldPath, expected: expectedJsType, got: typeof actual, message: `"${fieldPath}" expected ${expectedJsType} (${schemaField.name}), got ${typeof actual}` });
      }
    } else if (typeMap[schemaField.name] && typeof actual === 'object' && !Array.isArray(actual)) {
      validateAgainstSchemaType(typeMap, schemaField.name, actual, fieldPath, violations, null, depth + 1);
    }
  }

  for (const key of Object.keys(data)) {
    if (!schemaFields[key] && !fieldsToCheck.includes(key)) {
      const fieldPath = path ? `${path}.${key}` : key;
      violations.push({ field: fieldPath, expected: 'absent', got: describeType(data[key]), message: `"${fieldPath}" is not defined in schema type "${typeName}"` });
    }
  }
}

function getRestExampleBody(serviceName, operationName) {
  const dir = artifactsDir();
  const norm = serviceName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('-examples.postman.json'));

  for (const file of files) {
    try {
      const coll = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
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
      const coll = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
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

router.get('/ai/rest-fields', (req, res) => {
  const { service, operation } = req.query;
  if (!service || !operation) return res.status(400).json({ error: 'Provide "service" and "operation" query params' });
  const body = getRestExampleBody(service, operation);
  if (!body) return res.json({ fields: [], structure: null });
  const fields = typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
  res.json({ fields, structure: describeJsonStructure(body) });
});

router.post('/ai/validate', (req, res) => {
  const { service, operation, response, apiType, queryFields } = req.body;
  if (!service || !operation || !response) return res.status(400).json({ error: 'Provide service, operation, response' });

  const violations = [];

  if (apiType === 'rest') {
    const originalBody = getRestExampleBody(service, operation);
    if (originalBody) {
      compareTypes(originalBody, response, '', violations);
    }
  } else {
    const opName = operation;
    const respData = response?.data?.[opName];
    if (!respData || typeof respData !== 'object') {
      res.json({ violations: [], count: 0, valid: true });
      return;
    }

    const svcName = service || queryServiceMap[opName] || null;
    const typeMap = (svcName && serviceRichTypeMap[svcName]) || serviceRichTypeMap[Object.keys(serviceRichTypeMap)[0]] || {};
    const opInfo = queryFieldMap[opName];
    const returnTypeName = opInfo ? opInfo.returnType : null;

    if (returnTypeName && typeMap[returnTypeName]) {
      const respItem = Array.isArray(respData) ? respData[0] : respData;
      if (respItem && typeof respItem === 'object') {
        validateAgainstSchemaType(typeMap, returnTypeName, respItem, '', violations, queryFields, 0);
      }
    }
  }

  res.json({ violations, count: violations.length, valid: violations.length === 0 });
});

router.get('/schema/query-fields', (req, res) => {
  const { operation, service } = req.query;
  if (!operation) return res.status(400).json({ error: 'Provide "operation" query param' });

  const opInfo = queryFieldMap[operation];
  if (!opInfo) return res.json({ fields: null, returnType: null });

  const svcName = service || queryServiceMap[operation] || null;
  const svcTypeMap = svcName ? serviceRichTypeMap[svcName] : null;
  const fieldsStr = serverBuildFieldsQuery(opInfo.returnType, 0, new Set(), svcTypeMap);
  res.json({ fields: fieldsStr, returnType: opInfo.returnType, method: opInfo.method, service: svcName });
});

router.get('/schema/query-variables', (req, res) => {
  const { operation } = req.query;
  if (!operation) return res.status(400).json({ error: 'Provide "operation" query param' });

  const args = queryArgsMap[operation];
  if (!args || args.length === 0) return res.json({ variables: {}, variableDefs: '', argumentRefs: '' });

  const variables = {};
  const listDefaults = { String: ['example'], Int: [1], Float: [1.0], ID: ['id-001'] };
  const variableDefs = [];
  const argumentRefs = [];
  for (const a of args) {
    variableDefs.push('$' + a.name + ': ' + (a.typeStr || (a.isList ? '[' + a.typeName + ']!' : a.typeName)));
    argumentRefs.push(a.name + ': $' + a.name);
    if (a.isList) {
      variables[a.name] = (listDefaults[a.typeName] || ['example']);
    } else {
      const scalarDefaults = { String: 'example', Int: 1, Float: 1.0, Boolean: true, ID: 'id-001', Tenant: 'example-tenant', DateTime: '2026-03-01T00:00:00Z', Date: '2026-03-01' };
      variables[a.name] = scalarDefaults[a.typeName] ?? 'example';
    }
  }
  res.json({
    variables,
    variableDefs: '(' + variableDefs.join(', ') + ')',
    argumentRefs: '(' + argumentRefs.join(', ') + ')',
  });
});

router.get('/ai/types', (req, res) => {
  const types = Object.entries(fullTypeMap)
    .filter(([n]) => !n.startsWith('__'))
    .map(([n, t]) => ({ name: n, fieldCount: t.fields.length }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ types });
});

router.get('/schema/type-tree', (req, res) => {
  const { operation, service, typeName } = req.query;
  if (!operation && !typeName) return res.status(400).json({ error: 'Provide "operation" or "typeName"' });

  const svcName = service || (operation ? queryServiceMap[operation] : null);
  const typeMap = (svcName && serviceRichTypeMap[svcName]) || serviceRichTypeMap[Object.keys(serviceRichTypeMap)[0]] || {};
  const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'Date', 'JSON', 'Long', 'BigDecimal', 'URL', 'URI']);

  let rootTypeName = typeName;
  if (operation) {
    const opInfo = queryFieldMap[operation];
    if (opInfo) rootTypeName = opInfo.returnType;
  }
  if (!rootTypeName) return res.json({ tree: null });

  function buildTree(tName, depth, visited) {
    if (depth > 5 || visited.has(tName)) return [];
    const fields = typeMap[tName];
    if (!fields) return [];
    visited.add(tName);

    return Object.entries(fields).map(([fname, info]) => {
      const isScalar = SCALARS.has(info.name);
      const hasChildren = !isScalar && !!typeMap[info.name] && !visited.has(info.name);
      const node = {
        name: fname,
        type: info.name,
        isList: info.isList || false,
        required: info.required || false,
        isScalar,
        hasChildren,
      };
      if (hasChildren && depth < 5) {
        node.children = buildTree(info.name, depth + 1, new Set(visited));
      }
      return node;
    });
  }

  const argsInfo = operation && queryArgsMap[operation] ? queryArgsMap[operation].map(a => ({
    name: a.name,
    type: a.typeName,
    typeStr: a.typeStr || a.typeName,
    isList: a.isList || false,
  })) : [];

  const tree = buildTree(rootTypeName, 0, new Set());
  res.json({ tree, rootType: rootTypeName, operation, service: svcName, arguments: argsInfo });
});

router.get('/ai/service-schema', async (req, res) => {
  const { service } = req.query;
  if (!service) return res.status(400).json({ error: 'Provide "service" query param' });

  const dir = artifactsDir();
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'No artifacts directory' });

  const slug = service.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const slugWords = slug.split('-').filter(Boolean);
  const allFiles = fs.readdirSync(dir);

  const isSchemaOrSpec = f => {
    const fl = f.toLowerCase();
    return (fl.endsWith('.graphql') || fl.endsWith('.gql') ||
       (fl.endsWith('.json') && !fl.includes('postman') && !fl.includes('examples')) ||
       fl.endsWith('.yaml') || fl.endsWith('.yml'));
  };

  // Tiered matching: exact-slug-prefix first, then loose word match as fallback.
  // Exact match prevents `unified-test` from being satisfied by an unrelated
  // file like `unified-usersapi-schema.graphql`.
  const fileSlugOf = (fl) => fl.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/g, '-');

  const allSchemaSpecFiles = allFiles.filter(isSchemaOrSpec);

  const exactCandidates = allSchemaSpecFiles.filter(f => {
    const fs_ = fileSlugOf(f.toLowerCase());
    return fs_ === slug || fs_.startsWith(slug + '-');
  });

  const looseCandidates = allSchemaSpecFiles.filter(f => {
    if (exactCandidates.includes(f)) return false;
    const fl = f.toLowerCase();
    if (fl.includes(slug) || fl.includes(service.toLowerCase())) return true;
    const fileWords = fileSlugOf(fl).split('-').filter(Boolean);
    return slugWords.some(w => w.length >= 3 && fileWords.some(fw => fw.includes(w) || w.includes(fw)));
  });

  // Pick the best candidate, preferring exact matches and respecting file
  // type signal: prefer the schema/spec file over auxiliary files in the same
  // group. Within exact matches, choose graphql > openapi > json > yaml.
  const pickBest = (list) =>
    list.find(f => f.endsWith('.graphql') || f.endsWith('.gql'))
    || list.find(f => f.toLowerCase().includes('openapi'))
    || list.find(f => f.toLowerCase().includes('schema'))
    || list[0];

  const schemaFile = pickBest(exactCandidates) || pickBest(looseCandidates);

  if (schemaFile) {
    const content = fs.readFileSync(path.join(dir, schemaFile), 'utf-8');
    return res.json({ schema: content, file: schemaFile, size: content.length });
  }

  try {
    const svcData = await httpGet(`${MICROCKS_URL}/api/services?page=0&size=200`);
    const services = JSON.parse(svcData);
    const norm = service.toLowerCase().replace(/[^a-z0-9]/g, '');
    const svc = services.find(s => s.name === service)
      || services.find(s => s.name.toLowerCase() === service.toLowerCase())
      || services.find(s => s.name.toLowerCase().replace(/[^a-z0-9]/g, '') === norm);
    if (svc) {
      const resData = await httpGet(`${MICROCKS_URL}/api/resources/service/${svc.id}`);
      const resources = JSON.parse(resData);
      const gqlSchema = resources.find(r => r.type === 'GRAPHQL_SCHEMA');
      if (gqlSchema && gqlSchema.content) {
        return res.json({ schema: gqlSchema.content, file: `${svc.name}-schema.graphql (from Microcks)`, size: gqlSchema.content.length });
      }
      const openApiSpec = resources.find(r => r.type === 'OPEN_API_SPEC' || r.type === 'SWAGGER');
      if (openApiSpec && openApiSpec.content) {
        return res.json({ schema: openApiSpec.content, file: `${svc.name}-openapi (from Microcks)`, size: openApiSpec.content.length });
      }
    }
  } catch (_) {}

  return res.status(404).json({ error: 'No schema file found for service: ' + service });
});

const { getMicrocksExamples } = require('../lib/microcks-service.cjs');

router.get('/api/microcks-examples', async (req, res) => {
  const { service, operation } = req.query;
  if (!service || !operation) {
    return res.status(400).json({ error: 'Provide service and operation query params' });
  }
  try {
    const result = await getMicrocksExamples(service, operation);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/proxy-url', (req, res) => {
  const { service, url } = req.body;
  if (!service) return res.status(400).json({ error: 'Provide "service"' });
  if (url) {
    proxyUrls[service.toLowerCase()] = url;
  } else {
    delete proxyUrls[service.toLowerCase()];
  }
  res.json({ service, proxyUrl: url || null, configured: !!url });
});

router.get('/api/proxy-url', (req, res) => {
  const { service } = req.query;
  if (service) {
    res.json({ service, proxyUrl: proxyUrls[service.toLowerCase()] || null });
  } else {
    res.json({ proxyUrls: { ...proxyUrls } });
  }
});

router.post('/api/upstream-url', (req, res) => {
  const { url } = req.body;
  state.upstreamUrl = url || null;
  res.json({ upstreamUrl: state.upstreamUrl, configured: !!url });
});

router.get('/api/upstream-url', (req, res) => {
  res.json({ upstreamUrl: state.upstreamUrl });
});

async function syncSchemasFromMicrocks() {
  const results = { synced: [], skipped: [], errors: [] };
  try {
    const data = await httpGetLong(`${MICROCKS_URL}/api/services?page=0&size=200`);
    const services = JSON.parse(data);

    // ── GraphQL services ────────────────────────────────────────
    const graphqlServices = services.filter(s => s.type === 'GRAPHQL' || s.type === 'GRAPH');
    for (const svc of graphqlServices) {
      try {
        const resourceData = await httpGetLong(`${MICROCKS_URL}/api/resources/service/${svc.id}`);
        const resources = JSON.parse(resourceData);
        const schemaResource = resources.find(r =>
          r.type === 'GRAPHQL_SCHEMA' || (r.content && r.content.includes('type Query'))
        );
        if (!schemaResource || !schemaResource.content) {
          results.skipped.push({ name: svc.name, reason: 'no schema resource' });
          continue;
        }

        const slug = (svc.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const filename = `${slug}-schema.graphql`;
        const filepath = path.join(ARTIFACTS_DIR, filename);

        let content = schemaResource.content;
        const microcksIdLine = `# microcksId: ${svc.name} : ${svc.version || '1.0'}`;
        if (!content.includes('microcksId')) {
          content = microcksIdLine + '\n\n' + content;
        }

        fs.writeFileSync(filepath, content, 'utf-8');
        results.synced.push({ name: svc.name, file: filename, type: 'graphql' });
      } catch (err) {
        results.errors.push({ name: svc.name, error: err.message });
      }
    }

    // ── AsyncAPI / Event services ───────────────────────────────
    const eventServices = services.filter(s =>
      s.type === 'EVENT' || s.type === 'ASYNC_API' || s.type === 'GENERIC_EVENT'
    );
    for (const svc of eventServices) {
      try {
        const resourceData = await httpGetLong(`${MICROCKS_URL}/api/resources/service/${svc.id}`);
        const resources = JSON.parse(resourceData);
        const asyncResource = resources.find(r =>
          r.type === 'ASYNC_API_SPEC' || (r.content && (r.content.includes('asyncapi') || r.content.includes('channels')))
        );
        if (!asyncResource || !asyncResource.content) {
          results.skipped.push({ name: svc.name, reason: 'no async API resource' });
          continue;
        }

        const slug = (svc.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const filename = `${slug}-asyncapi.yaml`;
        const filepath = path.join(ARTIFACTS_DIR, filename);

        fs.writeFileSync(filepath, asyncResource.content, 'utf-8');
        results.synced.push({ name: svc.name, file: filename, type: 'asyncapi' });
      } catch (err) {
        results.errors.push({ name: svc.name, error: err.message });
      }
    }

    // ── gRPC services ───────────────────────────────────────────
    const grpcServices = services.filter(s => s.type === 'GRPC');
    for (const svc of grpcServices) {
      try {
        const resourceData = await httpGetLong(`${MICROCKS_URL}/api/resources/service/${svc.id}`);
        const resources = JSON.parse(resourceData);
        const protoResource = resources.find(r =>
          r.type === 'PROTOBUF_SCHEMA' || (r.content && r.content.includes('syntax'))
        );
        if (!protoResource || !protoResource.content) {
          results.skipped.push({ name: svc.name, reason: 'no protobuf resource' });
          continue;
        }

        const slug = (svc.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const filename = `${slug}.proto`;
        const filepath = path.join(ARTIFACTS_DIR, filename);

        fs.writeFileSync(filepath, protoResource.content, 'utf-8');
        results.synced.push({ name: svc.name, file: filename, type: 'grpc' });
      } catch (err) {
        results.errors.push({ name: svc.name, error: err.message });
      }
    }

    if (results.synced.length > 0) {
      loadSchemaFiles();
      loadAsyncApiSpecs();
      loadProtobufSpecs();
    }
  } catch (err) {
    results.errors.push({ name: '_fetch_services', error: err.message });
  }
  return results;
}

router.post('/schema/sync-from-microcks', async (req, res) => {
  const results = await syncSchemasFromMicrocks();
  res.json({
    message: `Synced ${results.synced.length} schema(s) from Microcks`,
    ...results,
  });
});

module.exports = router;
module.exports.syncSchemasFromMicrocks = syncSchemasFromMicrocks;
