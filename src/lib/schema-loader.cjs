const fs = require('fs');
const path = require('path');
const { parse: gqlParse, Kind } = require('graphql');
const yaml = require('js-yaml');
const { unwrapGqlType, gqlTypeStr } = require('./graphql-utils.cjs');
const { ARTIFACTS_DIR } = require('../config.cjs');

const fullTypeMap = {};
const richTypeMap = {};
const queryFieldMap = {};
const serviceRichTypeMap = {};
const queryServiceMap = {};
const queryArgsMap = {};

function isValidJSON(str) {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

function loadSchemaFiles() {
  const artifactsDir = ARTIFACTS_DIR;
  if (!fs.existsSync(artifactsDir)) return;

  // Clear existing maps to allow reload
  for (const key of Object.keys(fullTypeMap)) delete fullTypeMap[key];
  for (const key of Object.keys(richTypeMap)) delete richTypeMap[key];
  for (const key of Object.keys(queryFieldMap)) delete queryFieldMap[key];
  for (const key of Object.keys(serviceRichTypeMap)) delete serviceRichTypeMap[key];
  for (const key of Object.keys(queryServiceMap)) delete queryServiceMap[key];
  for (const key of Object.keys(queryArgsMap)) delete queryArgsMap[key];

  const schemaFiles = fs.readdirSync(artifactsDir).filter(f => f.endsWith('.graphql'));
  for (const file of schemaFiles) {
    try {
      const content = fs.readFileSync(path.join(artifactsDir, file), 'utf-8');

      const svcMatch = content.match(/^#\s*microcksId:\s*(.+?)\s*:\s*/m);
      const svcName = svcMatch ? svcMatch[1].trim() : null;
      if (svcName && !serviceRichTypeMap[svcName]) serviceRichTypeMap[svcName] = {};

      const doc = gqlParse(content);
      for (const def of doc.definitions) {
        if (def.kind === Kind.OBJECT_TYPE_DEFINITION || def.kind === Kind.OBJECT_TYPE_EXTENSION) {
          const typeName = def.name.value;
          if (!fullTypeMap[typeName]) {
            fullTypeMap[typeName] = { name: typeName, fields: [] };
          }
          if (!richTypeMap[typeName]) {
            richTypeMap[typeName] = {};
          }
          for (const field of (def.fields || [])) {
            const fname = field.name.value;
            if (!fullTypeMap[typeName].fields.includes(fname)) {
              fullTypeMap[typeName].fields.push(fname);
            }
            const unwrapped = unwrapGqlType(field.type);
            richTypeMap[typeName][fname] = unwrapped;

            if (svcName) {
              if (!serviceRichTypeMap[svcName][typeName]) serviceRichTypeMap[svcName][typeName] = {};
              serviceRichTypeMap[svcName][typeName][fname] = unwrapped;
            }
          }

          if (typeName === 'Query' || typeName === 'Mutation') {
            for (const field of (def.fields || [])) {
              const unwrapped = unwrapGqlType(field.type);
              queryFieldMap[field.name.value] = { returnType: unwrapped.name, method: typeName === 'Query' ? 'QUERY' : 'MUTATION' };
              if (svcName) queryServiceMap[field.name.value] = svcName;
              const args = [];
              for (const arg of (field.arguments || [])) {
                const aType = unwrapGqlType(arg.type);
                args.push({ name: arg.name.value, typeName: aType.name, isList: aType.isList, typeStr: gqlTypeStr(arg.type) });
              }
              if (args.length > 0) queryArgsMap[field.name.value] = args;
            }
          }
        }
      }
    } catch (_) {}
  }
  console.log(`  Schema: ${Object.keys(fullTypeMap).length} types loaded from ${schemaFiles.length} files`);
  console.log(`  Per-service maps: ${Object.keys(serviceRichTypeMap).length} services`);
}

const asyncApiSpecs = {};

function loadAsyncApiSpecs() {
  const artifactsDir = ARTIFACTS_DIR;
  if (!fs.existsSync(artifactsDir)) return;

  const yamlFiles = fs.readdirSync(artifactsDir).filter(f => f.includes('asyncapi') && (f.endsWith('.yaml') || f.endsWith('.yml')));
  for (const file of yamlFiles) {
    try {
      const content = fs.readFileSync(path.join(artifactsDir, file), 'utf-8');
      const spec = yaml.load(content);
      const title = spec.info?.title || file;
      const channels = {};

      for (const [channelName, channelDef] of Object.entries(spec.channels || {})) {
        const direction = channelDef.subscribe ? 'subscribe' : 'publish';
        const opDef = channelDef.subscribe || channelDef.publish;
        const msg = opDef?.message;
        const examples = (msg?.examples || []).map(ex => ({
          name: ex.name || 'default',
          summary: ex.summary || '',
          payload: ex.payload
        }));

        // Detect protocol from server bindings, channel bindings, or fall back to heuristics
      let protocol = 'unknown';
      if (channelDef.bindings) {
        if (channelDef.bindings.kafka) protocol = 'kafka';
        else if (channelDef.bindings.amqp) protocol = 'amqp';
        else if (channelDef.bindings.mqtt) protocol = 'mqtt';
        else if (channelDef.bindings.ws) protocol = 'ws';
        else if (channelDef.bindings.nats) protocol = 'nats';
      }
      if (protocol === 'unknown' && spec.servers) {
        const firstServer = Object.values(spec.servers)[0];
        if (firstServer?.protocol) protocol = firstServer.protocol.toLowerCase();
      }

        channels[channelName] = {
          description: channelDef.description || '',
          direction,
          operationId: opDef?.operationId || '',
          messageName: msg?.name || '',
          contentType: msg?.contentType || 'application/json',
          schema: msg?.payload || {},
          examples,
          protocol
        };
      }

      asyncApiSpecs[title] = { title, file, channels };
    } catch (err) {
      console.log(`  ⚠ Failed to parse ${file}: ${err.message}`);
    }
  }
  const totalChannels = Object.values(asyncApiSpecs).reduce((sum, s) => sum + Object.keys(s.channels).length, 0);
  console.log(`  AsyncAPI: ${Object.keys(asyncApiSpecs).length} specs, ${totalChannels} channels loaded`);
}

const protoSpecs = {};

function loadProtobufSpecs() {
  const artifactsDir = ARTIFACTS_DIR;
  if (!fs.existsSync(artifactsDir)) return;

  for (const key of Object.keys(protoSpecs)) delete protoSpecs[key];

  const protoFiles = fs.readdirSync(artifactsDir).filter(f => f.endsWith('.proto'));
  for (const file of protoFiles) {
    try {
      const content = fs.readFileSync(path.join(artifactsDir, file), 'utf-8');
      const text = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

      const packageMatch = text.match(/package\s+([\w.]+)\s*;/);
      const packageName = packageMatch ? packageMatch[1] : '';

      // Parse services
      const services = [];
      const serviceRegex = /service\s+(\w+)\s*\{([\s\S]*?)\}/g;
      let sm;
      while ((sm = serviceRegex.exec(text)) !== null) {
        const svcName = sm[1];
        const svcBody = sm[2];
        const methods = [];
        const rpcRegex = /rpc\s+(\w+)\s*\(\s*(\w+)\s*\)\s*returns\s*\(\s*(stream\s+)?(\w+)\s*\)/g;
        let rm;
        while ((rm = rpcRegex.exec(svcBody)) !== null) {
          methods.push({ name: rm[1], inputType: rm[2], isServerStream: !!rm[3], outputType: rm[4] });
        }
        services.push({ name: svcName, methods });
      }

      const title = packageName
        ? (services.length > 0 ? `${packageName}.${services[0].name}` : packageName)
        : (services.length > 0 ? services[0].name : file.replace('.proto', ''));

      protoSpecs[title] = { title, file, packageName, services };
    } catch (err) {
      console.log(`  ⚠ Failed to parse ${file}: ${err.message}`);
    }
  }
  const totalMethods = Object.values(protoSpecs).reduce((sum, s) =>
    sum + s.services.reduce((ms, svc) => ms + svc.methods.length, 0), 0);
  console.log(`  Protobuf: ${Object.keys(protoSpecs).length} specs, ${totalMethods} methods loaded`);
}

// Load on module initialization
loadSchemaFiles();
loadAsyncApiSpecs();
loadProtobufSpecs();

module.exports = {
  fullTypeMap,
  richTypeMap,
  queryFieldMap,
  serviceRichTypeMap,
  queryServiceMap,
  queryArgsMap,
  asyncApiSpecs,
  protoSpecs,
  loadSchemaFiles,
  loadAsyncApiSpecs,
  loadProtobufSpecs,
  isValidJSON,
};
