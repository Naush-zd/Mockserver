const { SCALAR_TYPES } = require('./graphql-utils.cjs');

function buildPostmanCollection(serviceName, operationName, responseBody, fields, variables) {
  const bodyStr = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
  const selSet = (fields && fields.length > 0) ? fields.join(' ') : '';
  const queryStr = selSet ? `${operationName} { ${selSet} }` : operationName;
  const fullQuery = `{ ${queryStr} }`;

  const exampleName = variables && Object.keys(variables).length > 0
    ? Object.values(variables).map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)).join('-').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60)
    : 'ai-injected';

  const requestBody = { query: fullQuery };
  if (variables && Object.keys(variables).length > 0) {
    requestBody.variables = variables;
  }

  return {
    info: {
      _postman_id: `ai-inject-${serviceName}-${operationName}-${Date.now()}`,
      name: serviceName,
      description: `version=1.0 - AI injected example for ${operationName}`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [{
      name: operationName,
      request: {
        method: 'POST',
        url: `http://${operationName}`,
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: { mode: 'raw', raw: JSON.stringify(requestBody) },
      },
      response: [{
        name: exampleName,
        originalRequest: {
          method: 'POST',
          url: `http://${operationName}`,
          body: { mode: 'raw', raw: JSON.stringify(requestBody) },
        },
        code: 200,
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: bodyStr,
      }],
    }],
  };
}

function buildSingleOpRestCollection(serviceName, operationName, responseBody, details) {
  const bodyStr = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
  const method = details.method || 'GET';
  const statusCode = details.statusCode || 200;
  const resolvedPath = details.resolvedPath || null;
  const templatePath = details.templatePath || null;

  let exampleName = 'ai-injected';
  let exampleUrl = details.url || `http://example.com${operationName}`;

  if (resolvedPath && templatePath) {
    const tParts = templatePath.split('/');
    const rParts = resolvedPath.split('/');
    const paramValues = [];
    for (let i = 0; i < tParts.length; i++) {
      if (tParts[i] && tParts[i].startsWith('{') && rParts[i]) {
        paramValues.push(rParts[i]);
      }
    }
    if (paramValues.length > 0) {
      exampleName = paramValues.join('-');
    }
    exampleUrl = `http://example.com${resolvedPath}`;
  }

  return {
    info: {
      _postman_id: `ai-inject-rest-${serviceName}-${Date.now()}`,
      name: serviceName,
      description: `version=1.0 - AI injected example for ${operationName}`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [{
      name: operationName,
      request: {
        method,
        url: exampleUrl,
        header: [{ key: 'Content-Type', value: 'application/json' }],
      },
      response: [{
        name: exampleName,
        originalRequest: {
          method,
          url: exampleUrl,
          header: [{ key: 'Content-Type', value: 'application/json' }],
        },
        code: statusCode,
        _postman_previewlanguage: 'json',
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: bodyStr,
      }],
    }],
  };
}

function buildFieldsForType(types, typeName, depth = 0) {
  if (depth > 2 || !types[typeName]) return null;
  const fields = types[typeName];
  const parts = [];
  for (const [fname, typeInfo] of Object.entries(fields)) {
    if (SCALAR_TYPES.has(typeInfo.name) || !types[typeInfo.name]) {
      parts.push(fname);
    } else {
      const nested = buildFieldsForType(types, typeInfo.name, depth + 1);
      if (nested) parts.push(fname + ' { ' + nested + ' }');
    }
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

function buildFullTypeDesc(typeName, types, depth = 0, visited = null) {
  if (!visited) visited = new Set();
  if (depth > 2 || !types[typeName] || visited.has(typeName)) return '';
  visited.add(typeName);
  const fields = types[typeName];
  const lines = [];
  const queue = [];
  for (const [fname, typeInfo] of Object.entries(fields)) {
    const typeStr = typeInfo.isList ? `[${typeInfo.name}]` : typeInfo.name;
    lines.push(`  ${fname}: ${typeStr}`);
    if (!SCALAR_TYPES.has(typeInfo.name) && types[typeInfo.name] && !visited.has(typeInfo.name)) {
      queue.push(typeInfo.name);
    }
  }
  let result = `type ${typeName} {\n${lines.join('\n')}\n}`;
  for (const t of queue) {
    const sub = buildFullTypeDesc(t, types, depth + 1, visited);
    if (sub) result += '\n' + sub;
  }
  return result;
}

function buildVariablesForArgs(args) {
  const vars = {};
  for (const arg of args) {
    const defaults = {
      'String': 'example', 'Int': 1, 'Float': 1.0, 'Boolean': true, 'ID': 'id-001',
      'Tenant': 'example-tenant', 'DateTime': '2026-03-01T00:00:00Z',
    };
    if (arg.type.isList) {
      vars[arg.name] = [defaults[arg.type.name] || 'example'];
    } else {
      vars[arg.name] = defaults[arg.type.name] || 'example';
    }
  }
  return vars;
}

function buildVariantVariables(baseVars, index) {
  const variant = {};
  for (const [key, val] of Object.entries(baseVars)) {
    if (typeof val === 'string') {
      variant[key] = index === 0 ? val : `${val}-${index + 1}`;
    } else if (typeof val === 'number') {
      variant[key] = val + index;
    } else if (typeof val === 'boolean') {
      variant[key] = index % 2 === 0 ? val : !val;
    } else if (Array.isArray(val)) {
      variant[key] = val.map(v => typeof v === 'string' ? (index === 0 ? v : `${v}-${index + 1}`) : v);
    } else {
      variant[key] = val;
    }
  }
  return variant;
}

function buildAutoPostmanCollection(serviceName, operations, types, generatedData, version = '1.0') {
  const items = [];

  for (const op of operations) {
    const fieldsStr = buildFieldsForType(types, op.returnType);

    const argDefs = op.args.map(a => {
      let gqlType = a.type.name;
      if (a.type.isList) gqlType = '[' + gqlType + ']';
      return '$' + a.name + ': ' + gqlType;
    }).join(', ');
    const argPass = op.args.map(a => a.name + ': $' + a.name).join(', ');

    const prefix = op.method === 'MUTATION' ? 'mutation' : 'query';
    const sigPart = argDefs ? `${prefix} ${op.name}(${argDefs})` : `${prefix} ${op.name}`;
    const callPart = argPass ? `${op.name}(${argPass})` : op.name;
    const queryStr = fieldsStr
      ? `${sigPart} { ${callPart} { ${fieldsStr} } }`
      : `${sigPart} { ${callPart} }`;
    const baseVariables = buildVariablesForArgs(op.args);
    const hasArgs = Object.keys(baseVariables).length > 0;

    const responseData = generatedData[op.name];
    const responses = [];

    if (Array.isArray(responseData) && responseData.length > 0) {
      for (let i = 0; i < responseData.length; i++) {
        const example = responseData[i];
        const exampleBody = example && example.data
          ? JSON.stringify(example)
          : JSON.stringify({ data: { [op.name]: example } });
        const exampleVars = hasArgs ? buildVariantVariables(baseVariables, i) : baseVariables;
        const exampleBodyRaw = JSON.stringify({ query: queryStr, variables: exampleVars });
        responses.push({
          name: `example-${i + 1}`,
          originalRequest: {
            method: 'POST',
            url: `http://${op.name}`,
            body: { mode: 'raw', raw: exampleBodyRaw },
          },
          code: 200,
          header: [{ key: 'Content-Type', value: 'application/json' }],
          body: exampleBody,
        });
      }
    } else {
      let responseBody;
      if (responseData) {
        responseBody = responseData.data
          ? JSON.stringify(responseData)
          : JSON.stringify({ data: { [op.name]: responseData } });
      } else {
        responseBody = JSON.stringify({ data: { [op.name]: null } });
      }
      responses.push({
        name: 'ai-generated',
        originalRequest: {
          method: 'POST',
          url: `http://${op.name}`,
          body: { mode: 'raw', raw: JSON.stringify({ query: queryStr, variables: baseVariables }) },
        },
        code: 200,
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: responseBody,
      });
    }

    const defaultBodyRaw = JSON.stringify({ query: queryStr, variables: baseVariables });
    items.push({
      name: op.name,
      request: {
        method: 'POST',
        url: `http://${op.name}`,
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: { mode: 'raw', raw: defaultBodyRaw },
      },
      response: responses,
    });
  }

  return {
    info: {
      _postman_id: `ai-setup-${serviceName}-${Date.now()}`,
      name: serviceName,
      description: `version=${version} - AI-generated mock examples for ${serviceName}`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: items,
  };
}

function extractPathParamValue(dataItem, paramName) {
  if (!dataItem || typeof dataItem !== 'object') return null;
  if (dataItem._pathParams && typeof dataItem._pathParams === 'object' && dataItem._pathParams[paramName]) {
    return String(dataItem._pathParams[paramName]);
  }
  if (typeof dataItem[paramName] === 'string' && !dataItem[paramName].includes('://')) {
    return dataItem[paramName];
  }
  return null;
}

function sanitizeForUrl(val) {
  return val.replace(/[^a-zA-Z0-9._~-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function stripPathParams(dataItem) {
  if (!dataItem || !dataItem._pathParams) return dataItem;
  const copy = Object.assign({}, dataItem);
  delete copy._pathParams;
  return copy;
}

function buildRestPostmanCollection(serviceName, version, operations, generatedData) {
  const items = [];
  for (const op of operations) {
    const responses = [];
    const data = generatedData[op.name];

    const pathParams = [];
    op.path.replace(/\{(\w+)\}/g, (_, name) => { pathParams.push(name); });

    if (Array.isArray(data) && data.length > 0) {
      // List endpoints (response schema is `type: array`, e.g. GET /products)
      // must serve ALL generated items in one response body — a plain GET
      // with no dispatcher criteria only ever returns a single named example,
      // so N separate per-item examples would silently truncate "generate N
      // products" down to whichever one example happened to be served.
      const isListResponse = op.responseSchema?.type === 'array' && pathParams.length === 0;
      if (isListResponse) {
        responses.push({
          name: 'default',
          originalRequest: { method: op.method, url: op.path },
          code: op.responseCode,
          header: [{ key: 'Content-Type', value: 'application/json' }],
          body: JSON.stringify(data.map(stripPathParams)),
        });
      } else {
      for (let i = 0; i < data.length; i++) {
        let exampleUrl = op.path;
        const paramValues = [];
        for (const param of pathParams) {
          let val = extractPathParamValue(data[i], param);
          if (!val) val = `val-${i + 1}`;
          val = sanitizeForUrl(val);
          exampleUrl = exampleUrl.replace(`{${param}}`, val);
          paramValues.push(val);
        }
        const exName = paramValues.length > 0
          ? paramValues.join('-')
          : `example-${i + 1}`;
        const cleanData = stripPathParams(data[i]);
        responses.push({
          name: exName,
          originalRequest: { method: op.method, url: exampleUrl },
          code: op.responseCode,
          header: [{ key: 'Content-Type', value: 'application/json' }],
          body: JSON.stringify(cleanData),
        });
      }
      }
    } else {
      let exampleUrl = op.path;
      for (const param of pathParams) {
        exampleUrl = exampleUrl.replace(`{${param}}`, 'default');
      }
      const cleanData = stripPathParams(data);
      responses.push({
        name: 'default',
        originalRequest: { method: op.method, url: exampleUrl },
        code: op.responseCode,
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: JSON.stringify(cleanData || {}),
      });
    }

    items.push({
      name: op.name,
      request: {
        method: op.method,
        header: [{ key: 'Content-Type', value: 'application/json' }],
        url: op.path,
      },
      response: responses,
    });
  }

  return {
    info: {
      _postman_id: `ai-setup-rest-${serviceName}-${Date.now()}`,
      name: serviceName,
      description: `version=${version} - AI-generated REST mock examples for ${serviceName}`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: items,
  };
}

function injectExamplesIntoOpenAPI(spec, operations, generatedData) {
  const updated = JSON.parse(JSON.stringify(spec));
  for (const op of operations) {
    const methodDef = updated.paths?.[op.path]?.[op.method.toLowerCase()];
    if (!methodDef) continue;

    const data = generatedData[op.name];
    if (!data) continue;

    const pathParams = [];
    op.path.replace(/\{(\w+)\}/g, (_, name) => { pathParams.push(name); });
    const queryParams = (op.parameters || [])
      .filter(p => p.in === 'query')
      .map(p => p.name);

    let firstExampleName = 'default';
    if (pathParams.length > 0 && Array.isArray(data) && data.length > 0) {
      const vals = [];
      for (const param of pathParams) {
        let v = extractPathParamValue(data[0], param);
        if (!v) v = 'val-1';
        vals.push(sanitizeForUrl(v));
      }
      firstExampleName = vals.join('-');
    }

    if (pathParams.length > 0) {
      methodDef['x-microcks-operation'] = {
        dispatcher: 'FALLBACK',
        dispatcherRules: JSON.stringify({
          dispatcher: 'URI_PARTS',
          dispatcherRules: pathParams.join(' && '),
          fallback: firstExampleName,
        }),
      };
    } else if (queryParams.length > 0) {
      methodDef['x-microcks-operation'] = {
        dispatcher: 'FALLBACK',
        dispatcherRules: JSON.stringify({
          dispatcher: 'URI_PARAMS',
          dispatcherRules: queryParams.join(' && '),
          fallback: firstExampleName,
        }),
      };
    } else {
      methodDef['x-microcks-operation'] = {
        dispatcher: 'FALLBACK',
        dispatcherRules: JSON.stringify({ fallback: firstExampleName }),
      };
    }
  }
  return updated;
}

// ── gRPC Postman collection (Microcks convention) ───────────────────
// Microcks requires: collection name = gRPC service full name,
// description includes "version=X.Y", request names = rpc method names,
// request URL = "serviceName / methodName", examples in JSON.

function buildGrpcPostmanCollection(serviceName, version, methods, generatedData) {
  const items = [];

  for (const method of methods) {
    const responses = [];
    const data = generatedData[method.name];

    if (Array.isArray(data) && data.length > 0) {
      for (let i = 0; i < data.length; i++) {
        const bodyStr = typeof data[i] === 'string' ? data[i] : JSON.stringify(data[i]);
        responses.push({
          name: `example-${i + 1}`,
          originalRequest: {
            method: 'POST',
            url: `${serviceName} / ${method.name}`,
            header: [{ key: 'Content-Type', value: 'application/json' }],
            body: { mode: 'raw', raw: JSON.stringify({}) },
          },
          code: 200,
          header: [{ key: 'Content-Type', value: 'application/json' }],
          body: bodyStr,
        });
      }
    } else {
      responses.push({
        name: 'default',
        originalRequest: {
          method: 'POST',
          url: `${serviceName} / ${method.name}`,
          header: [{ key: 'Content-Type', value: 'application/json' }],
          body: { mode: 'raw', raw: JSON.stringify({}) },
        },
        code: 200,
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: JSON.stringify(data || {}),
      });
    }

    items.push({
      name: method.name,
      request: {
        method: 'POST',
        url: `${serviceName} / ${method.name}`,
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: { mode: 'raw', raw: JSON.stringify({}) },
      },
      response: responses,
    });
  }

  return {
    info: {
      _postman_id: `ai-setup-grpc-${serviceName}-${Date.now()}`,
      name: serviceName,
      description: `version=${version} - AI-generated gRPC mock examples for ${serviceName}`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: items,
  };
}

// ── AsyncAPI example injection ──────────────────────────────────────
// Microcks reads examples from message.examples in AsyncAPI specs.
// This function injects AI-generated payloads back into the parsed spec.

function injectAsyncApiExamples(spec, channelData) {
  const yaml = require('js-yaml');
  const updated = JSON.parse(JSON.stringify(spec));
  const isV3 = String(updated.asyncapi).startsWith('3');

  for (const [channelName, payloads] of Object.entries(channelData)) {
    const channelDef = (updated.channels || {})[channelName];
    if (!channelDef) continue;

    const examples = [];
    if (Array.isArray(payloads)) {
      for (let i = 0; i < payloads.length; i++) {
        examples.push({
          name: `example-${i + 1}`,
          payload: payloads[i],
        });
      }
    } else if (payloads) {
      examples.push({ name: 'default', payload: payloads });
    }

    if (isV3) {
      const msgs = channelDef.messages;
      if (msgs) {
        const firstMsg = Object.values(msgs)[0];
        if (firstMsg) firstMsg.examples = examples;
      }
    } else {
      const opDef = channelDef.subscribe || channelDef.publish;
      if (opDef?.message) opDef.message.examples = examples;
    }
  }

  return updated;
}

module.exports = {
  buildPostmanCollection,
  buildSingleOpRestCollection,
  buildAutoPostmanCollection,
  buildRestPostmanCollection,
  injectExamplesIntoOpenAPI,
  buildFieldsForType,
  buildFullTypeDesc,
  buildVariablesForArgs,
  buildGrpcPostmanCollection,
  injectAsyncApiExamples,
};
