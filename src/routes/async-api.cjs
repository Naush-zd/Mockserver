'use strict';

const express = require('express');
const { asyncApiSpecs } = require('../lib/schema-loader.cjs');
const { callLLM, ASYNC_AI_SYSTEM_PROMPT, FAILURE_SCENARIOS, isAIAvailable } = require('../lib/ai-client.cjs');
const { compareTypes } = require('../lib/validation.cjs');

const router = express.Router();

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

router.get('/async/specs', (req, res) => {
  const result = {};
  for (const [title, spec] of Object.entries(asyncApiSpecs)) {
    result[title] = {
      title: spec.title,
      channels: Object.entries(spec.channels).map(([name, ch]) => ({
        name,
        description: ch.description,
        direction: ch.direction,
        operationId: ch.operationId,
        messageName: ch.messageName,
        contentType: ch.contentType,
        protocol: ch.protocol,
        exampleCount: ch.examples.length,
        fields: ch.schema?.properties ? Object.keys(ch.schema.properties) : []
      }))
    };
  }
  res.json(result);
});

router.get('/async/examples', (req, res) => {
  const { spec: specTitle, channel } = req.query;
  if (!specTitle || !channel) return res.status(400).json({ error: 'Provide "spec" and "channel" query params' });

  const spec = asyncApiSpecs[specTitle];
  if (!spec) return res.status(404).json({ error: `Spec "${specTitle}" not found` });

  const ch = spec.channels[channel];
  if (!ch) return res.status(404).json({ error: `Channel "${channel}" not found in "${specTitle}"` });

  res.json({
    channel,
    spec: specTitle,
    direction: ch.direction,
    operationId: ch.operationId,
    messageName: ch.messageName,
    contentType: ch.contentType,
    protocol: ch.protocol,
    schema: ch.schema,
    examples: ch.examples,
    description: ch.description
  });
});

router.post('/async/ai-generate', async (req, res) => {
  const { spec: specTitle, channel, scenario, prompt } = req.body;
  if (!specTitle || !channel) return res.status(400).json({ error: 'Provide "spec" and "channel"' });

  const spec = asyncApiSpecs[specTitle];
  if (!spec) return res.status(404).json({ error: `Spec "${specTitle}" not found` });

  const ch = spec.channels[channel];
  if (!ch) return res.status(404).json({ error: `Channel "${channel}" not found` });

  const originalExample = ch.examples[0]?.payload;
  const structure = originalExample ? describeJsonStructure(originalExample) : JSON.stringify(ch.schema, null, 2);
  const fNames = ch.schema?.properties ? Object.keys(ch.schema.properties).join(', ') : '';

  let scenarioPrompt = '';
  if (scenario && FAILURE_SCENARIOS[scenario]) {
    const base = FAILURE_SCENARIOS[scenario].prompt;
    const fields = ch.schema?.properties ? Object.keys(ch.schema.properties) : [];
    const examples = {
      'wrong-types': `The message has these fields: ${fNames}. For EACH field, return the WRONG type. If a field is string, return a number. If boolean, return a string. EVERY field must have the wrong type.`,
      'missing-fields': `The message has these fields: ${fNames}. REMOVE at least 2 fields entirely from the JSON.`,
      'null-values': `The message has these fields: ${fNames}. Set EVERY field to null.`,
      'empty-arrays': `The message has these fields: ${fNames}. Set every field to an empty value: strings become "", arrays become [], numbers become 0.`,
      'extra-fields': `The message has these fields: ${fNames}. Include all with valid data, BUT also add 3-4 EXTRA unexpected fields.`,
      'deprecated-fields': `The message has these fields: ${fNames}. Rename 2-3 fields to different names. The ORIGINAL names must be ABSENT.`,
      'malformed-dates': `The message has these fields: ${fNames}. For any date/time field return garbage like "not-a-date". For other fields return valid data.`,
      'boundary-values': `The message has these fields: ${fNames}. Use extreme values: very long strings, negative numbers, MAX_INT.`,
      'encoding-issues': `The message has these fields: ${fNames}. Put special characters in string fields: unicode, HTML, emojis.`,
      'partial-response': `The message has these fields: ${fNames}. Only include 1-2 fields. The rest must be completely ABSENT.`,
      'mixed-good-bad': `The message has these fields: ${fNames}. For roughly HALF the fields, return correct realistic values. For the OTHER HALF, mix in wrong types, null values, or missing fields. Simulate a partial regression.`,
    };
    scenarioPrompt = (examples[scenario] || base) + '\n\n' + base;
  }

  const userPrompt = scenarioPrompt || prompt || 'Generate realistic valid mock data for this message.';
  const opMsg = userPrompt + `\n\nMessage schema structure:\n${structure}\n\nOriginal example:\n${JSON.stringify(originalExample, null, 2)}\n\nReturn ONLY the raw JSON message payload.`;

  let fallback = false;
  let result;
  if (!isAIAvailable()) {
    result = originalExample || { message: 'Fallback mock payload', timestamp: new Date().toISOString() };
    fallback = true;
  } else {
    try {
      result = await callLLM(ASYNC_AI_SYSTEM_PROMPT, opMsg);
    } catch (err) {
      result = originalExample || { message: 'Fallback mock payload', timestamp: new Date().toISOString() };
      fallback = true;
    }
  }
  res.json({ generated: result, channel, spec: specTitle, scenario: scenario || 'custom', fallback });
});

router.post('/async/validate', (req, res) => {
  const { spec: specTitle, channel, payload } = req.body;
  if (!specTitle || !channel || !payload) return res.status(400).json({ error: 'Provide spec, channel, payload' });

  const spec = asyncApiSpecs[specTitle];
  if (!spec) return res.status(404).json({ error: `Spec not found` });

  const ch = spec.channels[channel];
  if (!ch) return res.status(404).json({ error: `Channel not found` });

  const violations = [];
  const originalExample = ch.examples[0]?.payload;
  if (originalExample) {
    compareTypes(originalExample, payload, '', violations);
  }

  res.json({ violations, count: violations.length, valid: violations.length === 0 });
});

module.exports = router;
