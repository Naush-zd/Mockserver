const { parse: gqlParse, Kind } = require('graphql');

const SCALAR_TYPES = new Set(['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'Date', 'JSON', 'Long', 'BigDecimal', 'URL', 'URI']);

function unwrapGqlType(typeNode) {
  if (!typeNode) return { name: 'Unknown', isList: false };
  if (typeNode.kind === 'NonNullType') { const r = unwrapGqlType(typeNode.type); r.required = true; return r; }
  if (typeNode.kind === 'ListType') { const inner = unwrapGqlType(typeNode.type); inner.isList = true; return inner; }
  if (typeNode.kind === 'NamedType') return { name: typeNode.name.value, isList: false };
  return { name: 'Unknown', isList: false };
}

function gqlTypeStr(typeNode) {
  if (!typeNode) return 'String';
  if (typeNode.kind === 'NonNullType') return gqlTypeStr(typeNode.type) + '!';
  if (typeNode.kind === 'ListType') return '[' + gqlTypeStr(typeNode.type) + ']';
  if (typeNode.kind === 'NamedType') return typeNode.name.value;
  return 'String';
}

function extractSelectionSet(queryStr) {
  try {
    const doc = gqlParse(queryStr);
    const def = doc.definitions[0];
    if (!def || !def.selectionSet) return null;
    return buildSelectionMap(def.selectionSet);
  } catch (_) {
    return null;
  }
}

function buildSelectionMap(selectionSet) {
  if (!selectionSet || !selectionSet.selections) return null;
  const map = {};
  for (const sel of selectionSet.selections) {
    if (sel.kind !== 'Field') continue;
    const name = sel.name.value;
    map[name] = sel.selectionSet ? buildSelectionMap(sel.selectionSet) : true;
  }
  return Object.keys(map).length > 0 ? map : null;
}

function filterResponseBySelection(data, selectionMap, removedFields = []) {
  if (!selectionMap || data === null || data === undefined) return data;
  if (Array.isArray(data)) {
    return data.map(item => filterResponseBySelection(item, selectionMap, removedFields));
  }
  if (typeof data !== 'object') return data;

  const filtered = {};
  for (const key of Object.keys(selectionMap)) {
    if (removedFields.some(rf => rf.toLowerCase() === key.toLowerCase())) {
      continue;
    }
    const subSel = selectionMap[key];
    if (!(key in data)) {
      filtered[key] = subSel === true ? null : {};
    } else if (subSel === true) {
      filtered[key] = data[key];
    } else {
      filtered[key] = filterResponseBySelection(data[key], subSel, removedFields);
    }
  }
  return filtered;
}

function extractOperationName(queryStr) {
  try {
    const doc = gqlParse(queryStr);
    const def = doc.definitions[0];
    if (!def || !def.selectionSet) return null;
    const firstField = def.selectionSet.selections.find(s => s.kind === 'Field');
    return firstField ? firstField.name.value : null;
  } catch (_) { return null; }
}

function serverBuildFieldsQuery(typeName, depth = 0, visited = new Set(), svcTypeMap = null, richTypeMap = null) {
  const typeMap = svcTypeMap || richTypeMap;
  if (!typeMap) return null;
  if (depth > 2 || !typeMap[typeName] || visited.has(typeName)) return null;
  visited.add(typeName);
  const fields = typeMap[typeName];
  const parts = [];
  const maxFields = depth === 0 ? 25 : 10;
  const entries = Object.entries(fields).slice(0, maxFields);
  
  for (const [fname, typeInfo] of entries) {
    if (fname.startsWith('_')) continue;
    if (SCALAR_TYPES.has(typeInfo.name) || !typeMap[typeInfo.name]) {
      parts.push(fname);
    } else if (depth < 1) {
      const nested = serverBuildFieldsQuery(typeInfo.name, depth + 1, new Set(visited), svcTypeMap, richTypeMap);
      if (nested) {
        parts.push(fname + ' { ' + nested + ' }');
      }
    }
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

module.exports = {
  SCALAR_TYPES,
  unwrapGqlType,
  gqlTypeStr,
  extractSelectionSet,
  buildSelectionMap,
  filterResponseBySelection,
  extractOperationName,
  serverBuildFieldsQuery,
};
