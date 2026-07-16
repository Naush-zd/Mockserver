const { parse } = require('graphql');
const { SCALAR_TYPES } = require('./graphql-utils.cjs');

function resolveTypeName(typeObj) {
  if (!typeObj) return null;
  if (typeObj.name) return typeObj.name;
  if (typeObj.ofType) return resolveTypeName(typeObj.ofType);
  return null;
}

function validateFieldsAgainstSchema(schema, queryStr, fullSchemaTypes) {
  if (!schema) return [];
  try {
    const doc = parse(queryStr);
    const def = doc.definitions[0];
    if (!def || !def.selectionSet) return [];
    const isMutation = def.operation === 'mutation';
    const rootName = isMutation ? (schema.mutationType || {}).name : (schema.queryType || {}).name;
    const rootType = schema.types.find(t => t.name === rootName);
    if (!rootType || !rootType.fields) return [];

    const errors = [];
    for (const sel of def.selectionSet.selections) {
      if (sel.kind !== 'Field') continue;
      const opField = rootType.fields.find(f => f.name === sel.name.value);
      if (!opField) continue;
      if (sel.selectionSet) {
        const retTypeName = resolveTypeName(opField.type);
        const retType = fullSchemaTypes ? fullSchemaTypes[retTypeName] : null;
        if (retType) {
          collectInvalidFields(fullSchemaTypes, retType, sel.selectionSet, sel.name.value, errors);
        }
      }
    }
    return errors;
  } catch (_) { return []; }
}

function collectInvalidFields(typeMap, parentType, selectionSet, path, errors) {
  if (!parentType || !parentType.fields || !selectionSet) return;
  for (const sel of selectionSet.selections) {
    if (sel.kind !== 'Field') continue;
    const fieldName = sel.name.value;
    if (!parentType.fields.includes(fieldName)) {
      errors.push({
        message: `Cannot query field "${fieldName}" on type "${parentType.name}".`,
        locations: sel.loc ? [{ line: sel.loc.startToken.line, column: sel.loc.startToken.column }] : [],
        extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
      });
    }
  }
}

function compareTypes(expected, actual, path, violations) {
  if (expected === null || expected === undefined) return;
  if (actual === null || actual === undefined) {
    if (expected !== null && expected !== undefined) {
      violations.push({ field: path || 'root', expected: describeType(expected), got: 'null/undefined', message: `"${path || 'root'}" expected ${describeType(expected)}, got null` });
    }
    return;
  }

  if (typeof expected !== typeof actual) {
    // Type mismatch
    if (!(Array.isArray(expected) && Array.isArray(actual))) {
      violations.push({ field: path || 'root', expected: describeType(expected), got: describeType(actual), message: `"${path || 'root'}" expected ${describeType(expected)}, got ${describeType(actual)}` });
    }
    return;
  }

  if (Array.isArray(expected) && !Array.isArray(actual)) {
    violations.push({ field: path || 'root', expected: 'array', got: describeType(actual), message: `"${path || 'root'}" expected array, got ${describeType(actual)}` });
    return;
  }

  if (!Array.isArray(expected) && Array.isArray(actual)) {
    violations.push({ field: path || 'root', expected: describeType(expected), got: 'array', message: `"${path || 'root'}" expected ${describeType(expected)}, got array` });
    return;
  }

  if (typeof expected === 'object' && !Array.isArray(expected)) {
    for (const [key, val] of Object.entries(expected)) {
      const childPath = path ? `${path}.${key}` : key;
      if (!(key in actual)) {
        violations.push({ field: childPath, expected: describeType(val), got: 'missing', message: `"${childPath}" is missing from response` });
      } else {
        compareTypes(val, actual[key], childPath, violations);
      }
    }
    for (const key of Object.keys(actual)) {
      if (!(key in expected)) {
        const childPath = path ? `${path}.${key}` : key;
        violations.push({ field: childPath, expected: 'absent', got: describeType(actual[key]), message: `"${childPath}" is unexpected (not in original schema)` });
      }
    }
  }
}

function describeType(val) {
  if (val === null) return 'null';
  if (val === undefined) return 'undefined';
  if (Array.isArray(val)) return 'array';
  return typeof val;
}

function nearestEnumValue(input, enumValues) {
  if (enumValues.includes(input)) return input;
  const lower = String(input).toLowerCase();
  const exact = enumValues.find(v => v.toLowerCase() === lower);
  if (exact) return exact;
  const substring = enumValues.find(v => lower.includes(v.toLowerCase()) || v.toLowerCase().includes(lower));
  if (substring) return substring;
  let best = enumValues[0], bestDist = Infinity;
  for (const v of enumValues) {
    const a = lower, b = v.toLowerCase();
    const m = a.length, n = b.length;
    if (Math.abs(m - n) >= bestDist) continue;
    const dp = Array.from({ length: m + 1 }, (_, i) => {
      const row = new Array(n + 1);
      row[0] = i;
      return row;
    });
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i][j] = Math.min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + (a[i-1] !== b[j-1] ? 1 : 0));
    if (dp[m][n] < bestDist) { bestDist = dp[m][n]; best = v; }
  }
  return best;
}

function validateMockData(data, typeName, types, enums, depth = 0) {
  if (data == null || depth > 10) return data;

  if (Array.isArray(data)) {
    return data.map(item => validateMockData(item, typeName, types, enums, depth));
  }

  if (typeof data !== 'object') {
    if (enums[typeName]) {
      return nearestEnumValue(data, enums[typeName]);
    }
    return data;
  }

  const fields = types[typeName];
  if (!fields) return data;

  const validated = {};
  for (const [fieldName, typeInfo] of Object.entries(fields)) {
    if (!(fieldName in data)) continue;
    const val = data[fieldName];

    if (val == null) {
      validated[fieldName] = null;
      continue;
    }

    if (enums[typeInfo.name]) {
      const enumVals = enums[typeInfo.name];
      if (typeInfo.isList && Array.isArray(val)) {
        validated[fieldName] = val.map(v => nearestEnumValue(v, enumVals));
      } else {
        validated[fieldName] = nearestEnumValue(val, enumVals);
      }
      continue;
    }

    if (SCALAR_TYPES.has(typeInfo.name)) {
      validated[fieldName] = typeInfo.isList ? (Array.isArray(val) ? val : [val]) : val;
      continue;
    }

    if (types[typeInfo.name]) {
      if (typeInfo.isList && Array.isArray(val)) {
        validated[fieldName] = val.map(item => validateMockData(item, typeInfo.name, types, enums, depth + 1));
      } else {
        validated[fieldName] = validateMockData(val, typeInfo.name, types, enums, depth + 1);
      }
      continue;
    }

    validated[fieldName] = val;
  }

  return validated;
}

module.exports = {
  resolveTypeName,
  validateFieldsAgainstSchema,
  collectInvalidFields,
  compareTypes,
  describeType,
  nearestEnumValue,
  validateMockData,
};
