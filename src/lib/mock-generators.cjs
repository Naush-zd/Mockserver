const crypto = require('crypto');
const { faker } = require('@faker-js/faker');
const { SCALAR_TYPES } = require('./graphql-utils.cjs');

// Generic, domain-agnostic mock data helpers
function generateStatus() {
  const statuses = ['active', 'pending', 'completed', 'cancelled', 'archived', 'draft'];
  return statuses[Math.floor(Math.random() * statuses.length)];
}

function generateMockValue(fieldName, typeInfo, types, enums, depth = 0) {
  const tname = typeInfo.name;

  if (enums[tname]) {
    const vals = enums[tname];
    return vals[Math.floor(Math.random() * vals.length)];
  }

  if (SCALAR_TYPES.has(tname) || depth > 3) {
    const fn = fieldName.toLowerCase();
    if (tname === 'ID') {
      return crypto.randomUUID();
    }
    if (tname === 'Int') {
      if (fn.includes('count') || fn.includes('total') || fn.includes('quantity')) return faker.number.int({ min: 0, max: 500 });
      if (fn.includes('position') || fn.includes('rank') || fn.includes('order') || fn.includes('index')) return faker.number.int({ min: 1, max: 50 });
      if (fn.includes('age')) return faker.number.int({ min: 18, max: 80 });
      return faker.number.int({ min: 0, max: 1000 });
    }
    if (tname === 'Float' || tname === 'BigDecimal') {
      if (fn.includes('price') || fn.includes('amount') || fn.includes('cost')) return +(Math.random() * 1000).toFixed(2);
      if (fn.includes('rate') || fn.includes('ratio') || fn.includes('average')) return +(Math.random()).toFixed(3);
      return +(Math.random() * 100).toFixed(2);
    }
    if (tname === 'Boolean') {
      if (fn.includes('hidden') || fn.includes('locked') || fn.includes('disabled')) return false;
      if (fn.includes('enabled') || fn.includes('active') || fn.includes('published')) return true;
      return Math.random() > 0.5;
    }
    if (tname === 'Date' || tname === 'DateTime') {
      return faker.date.recent().toISOString();
    }
    // String or other scalar — name-aware value generation
    if (fn.includes('date') || fn.includes('createdat') || fn.includes('updatedat') || fn.includes('startat') || fn.includes('endat') || fn.includes('startdate') || fn.includes('enddate')) return faker.date.recent().toISOString().slice(0, -5) + 'Z';
    if (fn.includes('slug') || fn.includes('permalink')) return faker.helpers.slugify(faker.lorem.words(2)).toLowerCase();
    if (fn.includes('uuid')) return crypto.randomUUID();
    if (fn.includes('hash')) return crypto.randomUUID().replace(/-/g, '');
    if (fn.includes('email')) return faker.internet.email();
    if (fn.includes('phone')) return faker.phone.number();
    if (fn.includes('url') || fn.includes('link') || fn.includes('thumbnail')) return faker.internet.url();
    if (fn.includes('logo') || fn.includes('image') || fn.includes('avatar')) return faker.image.avatar();
    if (fn === 'firstname') return faker.person.firstName();
    if (fn === 'lastname') return faker.person.lastName();
    if (fn === 'name' || fn === 'fullname' || fn === 'username' || fn === 'shortname') return faker.person.fullName();
    if (fn.includes('title') || fn.includes('headline')) return faker.lorem.sentence(4);
    if (fn.includes('description') || fn.includes('summary') || fn.includes('about') || fn.includes('bio')) return faker.lorem.sentence();
    if (fn.includes('company') || fn.includes('organization')) return faker.company.name();
    if (fn.includes('city') || fn.includes('market')) return faker.location.city();
    if (fn.includes('state')) return faker.location.state();
    if (fn.includes('country')) return faker.location.country();
    if (fn.includes('zip') || fn.includes('postal')) return faker.location.zipCode();
    if (fn.includes('address') || fn.includes('street')) return faker.location.streetAddress();
    if (fn.includes('location')) return faker.location.city();
    if (fn.includes('color')) return faker.color.rgb();
    if (fn.includes('status')) return generateStatus();
    if (fn.includes('category')) return faker.commerce.department();
    if (fn.includes('price') || fn.includes('amount')) return faker.commerce.price();
    if (fn.includes('currency')) return faker.finance.currencyCode();
    if (fn.includes('type')) return ['standard', 'premium', 'basic', 'custom'][Math.floor(Math.random() * 4)];
    if (fn.includes('language')) return ['en', 'es', 'pt', 'fr', 'de'][Math.floor(Math.random() * 5)];
    if (fn.includes('code')) return faker.string.alphanumeric(6).toUpperCase();
    if (fn.includes('number')) return String(faker.number.int({min:1, max:99}));
    if (fn.includes('jsonresponse')) return JSON.stringify({ key: 'value' });
    if (fn.includes('mediatype') || fn.includes('mimetype')) return ['image/jpeg', 'image/png', 'application/json', 'video/mp4'][Math.floor(Math.random() * 4)];
    if (fn.includes('mediaurl')) return faker.internet.url();
    if (fn.includes('text') || fn.includes('value') || fn.includes('content')) return faker.lorem.words(3);
    if (fn === 'cursor' || fn === 'after' || fn === 'before') return Buffer.from('cursor:' + Math.floor(Math.random() * 100)).toString('base64');
    if (fn.includes('id')) return 'id-' + faker.string.alphanumeric(8);
    return faker.lorem.words(2);
  }

  if (types[tname]) {
    return generateMockObject(tname, types, enums, depth + 1);
  }

  return null;
}

function generateMockObject(typeName, types, enums, depth = 0) {
  if (depth > 3 || !types[typeName]) return null;
  const fields = types[typeName];
  const obj = {};
  for (const [fname, typeInfo] of Object.entries(fields)) {
    if (typeInfo.isList) {
      const count = depth > 1 ? 1 : Math.floor(Math.random() * 2) + 1;
      obj[fname] = [];
      for (let i = 0; i < count; i++) {
        obj[fname].push(generateMockValue(fname, { ...typeInfo, isList: false }, types, enums, depth));
      }
    } else {
      obj[fname] = generateMockValue(fname, typeInfo, types, enums, depth);
    }
  }
  return obj;
}

function resolveSchemaRef(ref, spec) {
  if (!ref || !ref.startsWith('#/')) return {};
  const parts = ref.replace('#/', '').split('/');
  let result = spec;
  for (const p of parts) { result = result?.[p]; }
  return result || {};
}

function pickNamedExample(examples, preferredName) {
  if (!examples || typeof examples !== 'object') return undefined;
  const keys = Object.keys(examples);
  if (keys.length === 0) return undefined;
  const chosenKey = preferredName && examples[preferredName] ? preferredName : keys[0];
  const ex = examples[chosenKey];
  // OpenAPI examples are wrapped: { value: ..., summary?, description? }
  if (ex && typeof ex === 'object' && 'value' in ex) return ex.value;
  return ex;
}

function generateMockFromOpenAPISchema(schema, spec, depth = 0, exampleName = null) {
  if (depth > 3) return null;
  if (schema.$ref) schema = resolveSchemaRef(schema.$ref, spec);

  // Honor spec-provided examples before falling through to faker.
  if (schema.example !== undefined) return schema.example;
  const namedExample = pickNamedExample(schema.examples, exampleName);
  if (namedExample !== undefined) return namedExample;

  if (schema.type === 'object' || schema.properties) {
    const obj = {};
    const required = schema.required || [];
    for (const [key, prop] of Object.entries(schema.properties || {})) {
      const resolved = prop.$ref ? resolveSchemaRef(prop.$ref, spec) : prop;
      const fn = key.toLowerCase();
      const isRequired = required.includes(key);

      // Per-property examples take precedence over generated values.
      if (resolved.example !== undefined) {
        obj[key] = resolved.example;
        continue;
      }
      const propNamedExample = pickNamedExample(resolved.examples, exampleName);
      if (propNamedExample !== undefined) {
        obj[key] = propNamedExample;
        continue;
      }

      if (resolved.type === 'string') {
        if (resolved.format === 'uuid' || fn === 'id' || fn.endsWith('id'))
          obj[key] = crypto.randomUUID();
        else if (resolved.format === 'date-time' || fn.includes('date') || fn.includes('time'))
          obj[key] = faker.date.recent().toISOString();
        else if (resolved.format === 'date')
          obj[key] = faker.date.recent().toISOString().split('T')[0];
        else if (fn.includes('email')) 
          obj[key] = faker.internet.email();
        else if (fn.includes('phone'))
          obj[key] = faker.phone.number();
        else if (fn.includes('url') || fn.includes('link'))
          obj[key] = faker.internet.url();
        else if (fn.includes('name') || fn.includes('title'))
          obj[key] = faker.person.fullName();
        else if (fn.includes('description') || fn.includes('bio'))
          obj[key] = faker.lorem.sentence();
        else if (fn.includes('address'))
          obj[key] = faker.location.streetAddress();
        else if (fn.includes('city'))
          obj[key] = faker.location.city();
        else if (fn.includes('country'))
          obj[key] = faker.location.country();
        else if (fn.includes('street'))
          obj[key] = faker.location.street();
        else if (fn.includes('zipcode') || fn.includes('postal'))
          obj[key] = faker.location.zipCode();
        else if (fn.includes('slug'))
          obj[key] = faker.helpers.slugify(faker.lorem.word()).toLowerCase();
        else if (fn.includes('username'))
          obj[key] = faker.internet.username();
        else if (fn.includes('password'))
          obj[key] = faker.internet.password({ length: 16, memorable: false });
        else if (fn.includes('avatar') || fn.includes('image'))
          obj[key] = faker.image.avatar();
        else if (fn.includes('company') || fn.includes('organization'))
          obj[key] = faker.company.name();
        else if (fn.includes('status'))
          obj[key] = generateStatus();
        else if (fn.includes('abbreviation') || fn.includes('abbrev'))
          obj[key] = faker.string.alphanumeric(3).toUpperCase();
        else if (resolved.enum) 
          obj[key] = resolved.enum[Math.floor(Math.random() * resolved.enum.length)];
        else 
          obj[key] = faker.lorem.word();
      } else if (resolved.type === 'integer') {
        if (fn.includes('age'))
          obj[key] = faker.number.int({ min: 18, max: 80 });
        else if (fn.includes('port'))
          obj[key] = faker.number.int({ min: 1000, max: 65535 });
        else if (fn.includes('count') || fn.includes('total'))
          obj[key] = faker.number.int({ min: 0, max: 1000 });
        else if (fn.includes('score'))
          obj[key] = faker.number.int({ min: 0, max: 150 });
        else if (fn.includes('rating') || fn.includes('rank'))
          obj[key] = faker.number.int({ min: 1, max: 100 });
        else
          obj[key] = faker.number.int({ min: 0, max: 10000 });
      } else if (resolved.type === 'number') {
        if (fn.includes('price') || fn.includes('cost') || fn.includes('amount'))
          obj[key] = faker.commerce.price();
        else if (fn.includes('latitude'))
          obj[key] = faker.location.latitude();
        else if (fn.includes('longitude'))
          obj[key] = faker.location.longitude();
        else
          obj[key] = +(Math.random() * 100).toFixed(2);
      } else if (resolved.type === 'boolean') {
        obj[key] = Math.random() > 0.5;
      } else if (resolved.type === 'array') {
        obj[key] = [generateMockFromOpenAPISchema(resolved.items || {}, spec, depth + 1, exampleName)];
      } else if (resolved.type === 'object' || resolved.properties) {
        const nestedObj = generateMockFromOpenAPISchema(resolved, spec, depth + 1, exampleName);
        // For optional fields, if object is empty or null, use null instead of {}
        if (!isRequired && (!nestedObj || Object.keys(nestedObj).length === 0)) {
          obj[key] = null;
        } else {
          obj[key] = nestedObj;
        }
      } else if (!isRequired) {
        // For any other optional field that doesn't have a specific generator, use null
        obj[key] = null;
      }
    }
    return obj;
  }

  if (schema.type === 'array' && schema.items) {
    return [generateMockFromOpenAPISchema(schema.items, spec, depth + 1, exampleName),
            generateMockFromOpenAPISchema(schema.items, spec, depth + 1, exampleName)];
  }

  if (schema.type === 'string') return faker.lorem.word();
  if (schema.type === 'integer') return faker.number.int({ min: 0, max: 100 });
  if (schema.type === 'number') return +(Math.random() * 100).toFixed(2);
  if (schema.type === 'boolean') return true;
  return null;
}

// Extract Microcks-style named examples from an OpenAPI spec and build a
// dispatcher-ready registry. Pairs request-side examples (parameter values)
// with response-side examples sharing the same name (e.g. `get_books_404`).
//
// Returns { [`${METHOD} ${pathTemplate}`]: { dispatcher, dispatcherRules,
//   fallback, examples: { name: { request: { pathParams, queryParams },
//   response: { status, body, headers } } } } }
function extractExampleRegistryFromSpec(spec) {
  if (!spec || !spec.paths) return {};
  const registry = {};

  for (const [pathKey, methods] of Object.entries(spec.paths)) {
    for (const [method, opDef] of Object.entries(methods || {})) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      const opKey = `${method.toUpperCase()} ${pathKey}`;

      // Collect parameter examples by example-name → param-name → value
      const paramsByExampleName = {}; // { exampleName: { pathParams, queryParams } }
      const dispatcherRulesSet = new Set();
      let dispatcher = 'FALLBACK';

      for (const param of opDef.parameters || []) {
        const resolvedParam = param.$ref ? resolveSchemaRef(param.$ref, spec) : param;
        if (!resolvedParam || !resolvedParam.examples) continue;
        if (resolvedParam.in === 'path') dispatcher = 'URI_PARTS';
        else if (resolvedParam.in === 'query' && dispatcher === 'FALLBACK') dispatcher = 'URI_PARAMS';
        dispatcherRulesSet.add(resolvedParam.name);

        for (const [exName, exObj] of Object.entries(resolvedParam.examples)) {
          if (!paramsByExampleName[exName]) {
            paramsByExampleName[exName] = { pathParams: {}, queryParams: {} };
          }
          const value = (exObj && typeof exObj === 'object' && 'value' in exObj) ? exObj.value : exObj;
          if (resolvedParam.in === 'path') {
            paramsByExampleName[exName].pathParams[resolvedParam.name] = value;
          } else if (resolvedParam.in === 'query') {
            paramsByExampleName[exName].queryParams[resolvedParam.name] = value;
          }
        }
      }

      // Walk responses → for each named example, build response entry.
      const examples = {};
      const responses = opDef.responses || {};
      for (const [statusCode, respDef] of Object.entries(responses)) {
        const resolvedResp = respDef.$ref ? resolveSchemaRef(respDef.$ref, spec) : respDef;
        if (!resolvedResp) continue;

        const refs = resolvedResp['x-microcks-refs'] || [];
        const content = resolvedResp.content || {};
        const ctype = Object.keys(content)[0];
        const responseExamples = ctype ? (content[ctype].examples || {}) : {};

        // Track which example names live in this response (status code).
        const namesForThisStatus = new Set([...Object.keys(responseExamples), ...refs]);

        for (const exName of namesForThisStatus) {
          const exObj = responseExamples[exName];
          let body;
          if (exObj) {
            body = (exObj && typeof exObj === 'object' && 'value' in exObj) ? exObj.value : exObj;
          } else {
            body = undefined; // 204 / no-body refs
          }
          const reqShape = paramsByExampleName[exName] || { pathParams: {}, queryParams: {} };
          examples[exName] = {
            request: reqShape,
            response: {
              status: parseInt(statusCode, 10) || 200,
              body,
              headers: ctype ? { 'Content-Type': ctype } : undefined,
            },
          };
        }
      }

      if (Object.keys(examples).length === 0) continue;

      // Default fallback: prefer 2xx example name if present.
      const fallback = Object.entries(examples).find(([, ex]) =>
        ex.response.status >= 200 && ex.response.status < 300
      )?.[0] || null;

      registry[opKey] = {
        dispatcher,
        dispatcherRules: [...dispatcherRulesSet],
        fallback,
        examples,
      };
    }
  }
  return registry;
}

// ── AsyncAPI / JSON Schema payload mock generator ───────────────────

function generateMockFromJsonSchema(schema, depth = 0) {
  if (depth > 4 || !schema) return null;

  if (schema.example !== undefined) return schema.example;
  if (schema.enum) return schema.enum[Math.floor(Math.random() * schema.enum.length)];

  const type = schema.type || 'string';

  if (type === 'object' || schema.properties) {
    const obj = {};
    for (const [key, prop] of Object.entries(schema.properties || {})) {
      obj[key] = generateMockFromJsonSchema(prop, depth + 1);
    }
    return obj;
  }
  if (type === 'array') {
    const item = generateMockFromJsonSchema(schema.items || { type: 'string' }, depth + 1);
    return [item];
  }
  if (type === 'string') {
    if (schema.format === 'date-time') return faker.date.recent().toISOString();
    if (schema.format === 'date') return faker.date.recent().toISOString().split('T')[0];
    if (schema.format === 'uuid') return crypto.randomUUID();
    if (schema.format === 'email') return faker.internet.email();
    if (schema.format === 'uri' || schema.format === 'url') return faker.internet.url();
    return faker.lorem.word();
  }
  if (type === 'integer') return faker.number.int({ min: 0, max: 10000 });
  if (type === 'number') return +(Math.random() * 100).toFixed(2);
  if (type === 'boolean') return Math.random() > 0.5;

  return null;
}

// ── Protobuf / gRPC mock generator ──────────────────────────────────

const PROTO_TYPE_MAP = {
  'double': 'number', 'float': 'number',
  'int32': 'int', 'int64': 'int64', 'uint32': 'int', 'uint64': 'int64',
  'sint32': 'int', 'sint64': 'int64', 'fixed32': 'int', 'fixed64': 'int64',
  'sfixed32': 'int', 'sfixed64': 'int64',
  'bool': 'bool', 'string': 'string', 'bytes': 'bytes',
};

function generateMockFromProtoMessage(msgName, messages, enums, depth = 0) {
  if (depth > 3 || !messages[msgName]) return {};
  const fields = messages[msgName];
  const obj = {};

  for (const [fname, info] of Object.entries(fields)) {
    const fn = fname.toLowerCase();
    const mapped = PROTO_TYPE_MAP[info.type];

    let value;
    if (mapped === 'string') {
      if (fn.includes('id')) value = crypto.randomUUID();
      else if (fn.includes('name')) value = faker.person.fullName();
      else if (fn.includes('email')) value = faker.internet.email();
      else if (fn.includes('url')) value = faker.internet.url();
      else if (fn.includes('description')) value = faker.lorem.sentence();
      else if (fn.includes('date') || fn.includes('time')) value = faker.date.recent().toISOString();
      else value = faker.lorem.words(2);
    } else if (mapped === 'int') {
      value = faker.number.int({ min: 0, max: 10000 });
    } else if (mapped === 'int64') {
      value = String(faker.number.int({ min: 0, max: 999999 }));
    } else if (mapped === 'number') {
      value = +(Math.random() * 100).toFixed(2);
    } else if (mapped === 'bool') {
      value = Math.random() > 0.5;
    } else if (mapped === 'bytes') {
      value = Buffer.from(faker.lorem.word()).toString('base64');
    } else if (enums[info.type]) {
      const vals = enums[info.type];
      value = vals[Math.floor(Math.random() * vals.length)];
    } else if (messages[info.type]) {
      value = generateMockFromProtoMessage(info.type, messages, enums, depth + 1);
    } else {
      value = faker.lorem.word();
    }

    obj[fname] = info.isList ? [value] : value;
  }
  return obj;
}

module.exports = {
  generateMockValue,
  generateMockObject,
  generateStatus,
  generateMockFromOpenAPISchema,
  extractExampleRegistryFromSpec,
  generateMockFromJsonSchema,
  generateMockFromProtoMessage,
};
