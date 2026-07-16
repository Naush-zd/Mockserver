const http = require('http');
const https = require('https');
const { AI_API_KEY, AI_BASE_URL, AI_MODEL, AI_PROVIDER } = require('../config.cjs');

let _lastAIError = null;
let _lastAIErrorTime = 0;

function isAIAvailable() {
  return !!AI_API_KEY;
}

function getAIStatus() {
  const available = isAIAvailable();
  const recentFailure = _lastAIError && (Date.now() - _lastAIErrorTime < 60_000);
  return {
    available,
    provider: AI_PROVIDER,
    model: AI_MODEL,
    configured: !!AI_API_KEY,
    recentFailure: recentFailure ? _lastAIError : null,
  };
}

function chatTimeoutMs(kind, maxTokens) {
  if (kind === 'high') {
    const batchOverride = process.env.AI_LLM_BATCH_TIMEOUT_MS;
    if (batchOverride) {
      const b = parseInt(batchOverride, 10);
      if (!Number.isNaN(b) && b > 0) return b;
    }
    return maxTokens > 8000 ? 120_000 : 60_000;
  }
  const defOverride = process.env.AI_LLM_TIMEOUT_MS;
  if (defOverride) {
    const n = parseInt(defOverride, 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return 30_000;
}

function postChatCompletions(baseUrl, apiKey, payload, timeoutMs) {
  const root = String(baseUrl).replace(/\/$/, '');
  const url = new URL(`${root}/chat/completions`);
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;
  const port = url.port ? Number(url.port) : (isHttps ? 443 : 80);
  const postData = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData),
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  return new Promise((resolve, reject) => {
    const opts = {
      hostname: url.hostname,
      port,
      path: url.pathname + url.search,
      method: 'POST',
      headers,
      timeout: timeoutMs,
    };
    const req = lib.request(opts, (resp) => {
      let d = '';
      resp.on('data', (c) => (d += c));
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) return reject(new Error(parsed.error.message || 'LLM error'));
          const content = parsed.choices?.[0]?.message?.content;
          if (!content) return reject(new Error('Empty LLM response'));
          resolve(JSON.parse(content));
        } catch (e) {
          reject(new Error('LLM parse error: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('LLM timeout'));
    });
    req.write(postData);
    req.end();
  });
}

const FAILURE_SCENARIOS = {
  'success': { name: 'Success (Happy Path)', prompt: 'Generate correct, realistic data with ALL fields present, proper types, and realistic values. This should be a perfect, valid API response with no issues — realistic names, valid dates, proper nested structures, and all arrays populated with 1-2 items.' },
  'wrong-types': { name: 'Wrong Data Types', prompt: 'Generate data where field values have WRONG types: strings where numbers expected, numbers where strings expected, objects where arrays expected. Make it look like a provider API regression.' },
  'missing-fields': { name: 'Missing Required Fields', prompt: 'Generate data with several important fields completely missing (not null, but absent from the JSON). Simulate a provider removing fields in a breaking change.' },
  'null-values': { name: 'Unexpected Nulls', prompt: 'Generate data where fields that should have values are null. Simulate a database issue or incomplete data load.' },
  'empty-arrays': { name: 'Empty Collections', prompt: 'Generate data where all array/list fields are empty []. Simulate an upstream data source returning no items.' },
  'malformed-dates': { name: 'Malformed Dates', prompt: 'Generate data where date/time fields have wrong formats: Unix timestamps instead of ISO strings, "N/A", epoch 0, or invalid strings like "not-a-date".' },
  'deprecated-fields': { name: 'Deprecated Field Changes', prompt: 'Generate data where deprecated fields are removed and replaced with new unexpected field names. Simulate an API migration the consumer was not notified about.' },
  'extra-fields': { name: 'Extra Unknown Fields', prompt: 'Generate valid data but add many extra unexpected fields that the consumer schema does not define. Simulate a provider adding new fields.' },
  'encoding-issues': { name: 'Encoding/Special Chars', prompt: 'Generate data with special characters, unicode, HTML entities, and XSS payloads in string fields. Test consumer input sanitization.' },
  'boundary-values': { name: 'Boundary Values', prompt: 'Generate data with extreme values: very long strings (500+ chars), negative numbers, zero, MAX_INT, empty strings, single character strings.' },
  'partial-response': { name: 'Partial/Truncated', prompt: 'Generate data that looks like a truncated API response — some objects missing, arrays with only 1 item, strings cut off mid-sentence.' },
  'mixed-good-bad': { name: 'Mixed Good & Bad', prompt: 'Generate data where SOME fields have correct, realistic values and OTHER fields have wrong types, null values, or are missing. Mix it up — roughly half the fields should be correct and half should be broken. This simulates a partial API regression where only some fields are affected.' },
};

const AI_SYSTEM_PROMPT = `You are a mock data generator for a GraphQL/REST API.

CRITICAL RULES — FOLLOW EXACTLY:
- Return ONLY valid JSON in format: {"data": {"operationName": {fields...}}}
- You MUST use the EXACT field names from the schema provided. Do NOT rename, abbreviate, or invent field names. If the schema says "name", use "name" — not "title", "label", or any other synonym.
- For nested types, include ALL the sub-fields defined in the schema with their correct names and types. If the schema defines "type ScoreLeaderboard { name: String, subName: String, id: String }", you MUST use those exact field names.
- You MUST follow the scenario instructions LITERALLY. If told "wrong types", EVERY field must have the wrong type. If told "missing fields", fields must be ABSENT from the JSON. If told "null values", fields must be null. If told "empty arrays", array fields must be [].
- Do NOT generate correct/valid data when asked for bad data. The ENTIRE POINT is to produce broken data that will cause consumer tests to fail.
- WRONG TYPES means: use integers where strings are expected, use strings where numbers are expected, use booleans where objects are expected, use arrays where scalars are expected.
- MISSING FIELDS means: remove 2-3 fields entirely from the JSON object. They should NOT appear at all.
- NULL VALUES means: set every field value to null.
- EMPTY ARRAYS means: set any field that could be an array to [], and set string fields to "".
- Only return the fields you are told to return. Do NOT add extra fields.
- Use realistic, domain-appropriate content when generating valid-looking values.`;

const REST_AI_SYSTEM_PROMPT = `You are a mock data generator for a REST API.

CRITICAL RULES — FOLLOW EXACTLY:
- Return ONLY valid JSON matching the response structure provided.
- Do NOT wrap the response in {"data": {...}}. Return the raw REST response object directly.
- You MUST follow the scenario instructions LITERALLY. If told "wrong types", EVERY field must have the wrong type. If told "missing fields", fields must be ABSENT from the JSON. If told "null values", fields must be null. If told "empty arrays", array fields must be [].
- Do NOT generate correct/valid data when asked for bad data. The ENTIRE POINT is to produce broken data that will cause consumer tests to fail.
- WRONG TYPES means: use integers where strings are expected, use strings where numbers are expected, use booleans where objects are expected, use arrays where scalars are expected.
- MISSING FIELDS means: remove 2-3 fields entirely from the JSON object. They should NOT appear at all.
- NULL VALUES means: set every field value to null.
- EMPTY ARRAYS means: set any field that could be an array to [], and set string fields to "".
- Use realistic, domain-appropriate content when generating valid-looking values.
- For permalink/slug fields, use kebab-case slugs like "my-example-item". NEVER use full URLs for permalink/slug fields.

NULL vs EMPTY OBJECT (CRITICAL):
- For optional/empty nested objects, ALWAYS use null — NEVER use an empty object {}.
- Empty objects {} crash downstream parsers that call .map() or access nested fields. null is safely handled.
- For empty arrays, use [] (not null).`;

const ASYNC_AI_SYSTEM_PROMPT = `You are a mock data generator for async message payloads (Kafka / RabbitMQ / AMQP / MQTT).

CRITICAL RULES — FOLLOW EXACTLY:
- Return ONLY valid JSON matching the message payload structure provided.
- Do NOT wrap in any extra object — return the raw message payload.
- Do NOT include markdown, backticks, or explanations.
- Your entire response must be parseable by JSON.parse().
- Follow the exact field names from the schema provided.
- If a scenario is specified, apply it precisely to ALL fields.
- You MUST follow the scenario instructions LITERALLY. If told "wrong types", EVERY field must have the wrong type. If told "missing fields", fields must be ABSENT from the JSON. If told "null values", fields must be null. If told "empty arrays", array fields must be [].
- Do NOT generate correct/valid data when asked for bad data. The ENTIRE POINT is to produce broken data that will cause consumer tests to fail.
- Use realistic domain data: real event names, correlation IDs, timestamps, entity references.

NULL vs EMPTY OBJECT (CRITICAL):
- For optional/empty nested objects, ALWAYS use null — NEVER use an empty object {}.
- For empty arrays, use [] (not null).`;

const GRPC_AI_SYSTEM_PROMPT = `You are a mock data generator for gRPC service responses using Protocol Buffers message structures.

CRITICAL RULES — FOLLOW EXACTLY:
- Return ONLY valid JSON matching the protobuf message structure provided.
- Do NOT wrap in any extra object — return the raw response message fields.
- Do NOT include markdown, backticks, or explanations.
- Your entire response must be parseable by JSON.parse().
- Follow the exact field names from the proto message definitions.
- Protobuf field naming: use the original field names (typically snake_case).
- For repeated fields, generate arrays with 1-2 items.
- For enum fields, use the string name of the enum value (e.g. "UNKNOWN", "ACTIVE").
- For bytes fields, use base64-encoded strings.
- For int64/uint64/sint64/fixed64, use string values (JSON limitation for 64-bit integers).
- For nested messages, include all fields recursively (max depth 3).
- If a scenario is specified, apply it precisely to ALL fields.
- You MUST follow the scenario instructions LITERALLY. If told "wrong types", EVERY field must have the wrong type.
- Do NOT generate correct/valid data when asked for bad data.
- Use realistic domain data appropriate to the service context.`;

const SETUP_SYSTEM_PROMPT = `You are an API mock data generator. Given a schema and a prompt, generate realistic mock data.

CRITICAL RULES:
- Return ONLY valid JSON. No markdown, no backticks, no explanations.
- Your entire response must be parseable by JSON.parse().
- Use realistic data: real names, dates, amounts, identifiers, etc.
- If asked for N examples, generate exactly N examples per operation.
- Follow the schema types precisely: strings for String, integers for Int, etc.

STRUCTURE AND NAMING RULES:
- PRESERVE the exact field naming convention from the schema. If fields are snake_case (e.g. created_at, first_name), your output MUST use snake_case. If camelCase, use camelCase.
- Generate ALL levels of nesting shown in the schema description. Do NOT flatten or skip nested objects.
- For arrays, generate 1-2 items to show the structure without excessive data.
- Every field in the schema must appear in the output with a realistic value of the correct type.
- If a field name suggests a specific domain (e.g. permalink, slug), generate url-friendly kebab-case strings like "my-example-item". NEVER use full URLs (no "https://..." values) for permalink/slug fields.
- When a "_pathParams" field is requested, include it as a top-level key with distinct slug values for each path parameter.

NULL vs EMPTY OBJECT RULES (CRITICAL for parser compatibility):
- If a field is optional or represents data that may not exist, use null — NEVER use an empty object {}.
- Empty objects or arrays will crash parsers that try to access nested properties. Always use null for "no data".
- Only use {} when the schema explicitly requires a non-null object with no required fields AND the consumer code handles empty objects.
- For arrays that have no data, use [] (empty array), not null — unless the field is truly optional.
- When in doubt, prefer null over {}.

DOMAIN RULES:
- Infer the domain from the schema field names and generate contextually appropriate, realistic values.
- Use realistic identifiers, dates, amounts, and kebab-case slugs/permalinks.
- For logo/image URLs, use placeholder URLs like "https://example.com/image.png".
- For status fields, use values like "active", "pending", "completed".

SCENARIO SUPPORT:
When the user requests scenarios or failure cases, generate examples that match. Available scenarios:
- "success" / "happy path": Correct, realistic data with all fields present and valid.
- "wrong-types": Field values have WRONG types (strings where numbers expected, numbers where strings expected, etc.)
- "missing-fields": Important fields completely ABSENT from the JSON (not null, just missing keys).
- "null-values": Fields that should have values are null.
- "empty-arrays": All array/list fields are empty [].
- "malformed-dates": Date fields have wrong formats (Unix timestamps, "N/A", epoch 0, "not-a-date").
- "extra-fields": Valid data but with many extra unexpected fields added.
- "encoding-issues": Special characters, unicode, HTML entities in string fields.
- "boundary-values": Extreme values (very long strings, negative numbers, MAX_INT, empty strings).
- "partial-response": Truncated data, incomplete objects, arrays with only 1 item.
- "mixed-good-bad": Half the fields correct, half broken (wrong types, nulls, missing).

When mixing scenarios, LABEL each example clearly by using the requested pattern. For instance, if asked for "3 success, 2 wrong-types, 1 null-values", produce exactly that mix.`;

async function callLLM(systemPrompt, userPrompt) {
  if (!AI_API_KEY) {
    throw new Error('No AI_API_KEY set. Export GROQ_API_KEY or TOGETHER_API_KEY.');
  }
  console.log(`🔑 Using configured AI credentials for provider: ${AI_PROVIDER}`);

  const payload = {
    model: AI_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    max_tokens: 4096,
    response_format: { type: 'json_object' },
  };
  try {
    const result = await postChatCompletions(AI_BASE_URL, AI_API_KEY, payload, chatTimeoutMs('default', 4096));
    _lastAIError = null;
    return result;
  } catch (err) {
    _lastAIError = err.message;
    _lastAIErrorTime = Date.now();
    throw err;
  }
}

async function callLLMWithHighTokens(systemPrompt, userPrompt, maxTokens = 4000) {
  if (!AI_API_KEY) throw new Error('No AI_API_KEY set.');
  const payload = {
    model: AI_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
  };
  const timeoutMs = chatTimeoutMs('high', maxTokens);
  try {
    const result = await postChatCompletions(AI_BASE_URL, AI_API_KEY, payload, timeoutMs);
    _lastAIError = null;
    return result;
  } catch (err) {
    _lastAIError = err.message;
    _lastAIErrorTime = Date.now();
    throw err;
  }
}

function buildScenarioPrompt(scenario, fieldList, fNames, apiLabel) {
  if (!scenario || !FAILURE_SCENARIOS[scenario]) return '';
  const base = FAILURE_SCENARIOS[scenario].prompt;
  if (!fieldList) return base;

  const label = apiLabel || 'query';
  const examples = {
    'wrong-types': `The ${label} has these fields: ${fNames}. For ONLY these specific fields, return the WRONG type. String fields → return NUMBER/BOOLEAN. Number fields → return STRING. Do NOT apply this to other fields.`,
    'missing-fields': `The ${label} has these fields: ${fNames}. REMOVE at least 2 of these fields entirely from the JSON. The response must have FEWER keys than requested.`,
    'null-values': `The ${label} has these fields: ${fNames}. Set EVERY single one to null.`,
    'empty-arrays': `The ${label} has these fields: ${fNames}. Set every field to an empty value: strings become "", arrays become [], numbers become 0.`,
    'extra-fields': `The ${label} has these fields: ${fNames}. Include all with valid data, BUT also add 3-4 EXTRA unexpected fields like "__internal_id", "_debug_trace", "legacyScore".`,
    'deprecated-fields': `The ${label} has these fields: ${fNames}. Rename 2-3 of them (e.g. "slug" → "slug_v2"). Original names must be ABSENT.`,
    'malformed-dates': `The ${label} has these fields: ${fNames}. For date fields return "not-a-date" or 0. Other fields can be valid.`,
    'boundary-values': `The ${label} has these fields: ${fNames}. Use extreme values: 200+ char strings, -99999, MAX_INT (2147483647), empty strings.`,
    'encoding-issues': `The ${label} has these fields: ${fNames}. Put special chars: unicode, HTML entities, <script> tags, emojis.`,
    'partial-response': `The ${label} has these fields: ${fNames}. Only include 1-2 of the ${fieldList.length} fields. Rest must be ABSENT.`,
    'mixed-good-bad': `The ${label} has these fields: ${fNames}. For roughly HALF, return correct values. For the OTHER HALF, introduce problems: wrong types, null, or empty. Leave unlisted fields correct.`,
  };
  return (examples[scenario] || base) + '\n\n' + base;
}

function extractFieldsToRemove(prompt, fieldList) {
  if (!prompt || !fieldList || !/remove|delete|omit/i.test(prompt)) return [];
  const words = prompt.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/);
  return fieldList.filter(f => {
    const fn = f.toLowerCase();
    return words.some(w => fn.includes(w) || w.includes(fn)) || prompt.toLowerCase().includes(fn);
  });
}

module.exports = {
  FAILURE_SCENARIOS,
  AI_SYSTEM_PROMPT,
  REST_AI_SYSTEM_PROMPT,
  ASYNC_AI_SYSTEM_PROMPT,
  GRPC_AI_SYSTEM_PROMPT,
  SETUP_SYSTEM_PROMPT,
  callLLM,
  callLLMWithHighTokens,
  buildScenarioPrompt,
  extractFieldsToRemove,
  isAIAvailable,
  getAIStatus,
};
