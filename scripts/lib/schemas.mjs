export const bashJsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['slug', 'title', 'created_at', 'current_phase', 'status'],
  additionalProperties: false,
  properties: {
    slug:          { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' },
    title:         { type: 'string', minLength: 1 },
    created_at:    { type: 'string', format: 'date-time' },
    current_phase: { enum: ['ingest', 'setup', 'define', 'plan', 'execute', 'retest', 'complete'] },
    status:        { enum: ['active', 'paused', 'complete', 'abandoned'] },
    connectors_used: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'version'],
        additionalProperties: false,
        properties: { id: { type: 'string' }, version: { type: 'string' } },
      },
    },
    dispatch_summary: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agents_used: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'version', 'runs'],
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              version: { type: 'string' },
              runs: { type: 'integer', minimum: 0 },
            },
          },
        },
      },
    },
    finding_counts: {
      type: 'object',
      required: ['open', 'resolved', 'known'],
      additionalProperties: false,
      properties: {
        open:     { type: 'integer', minimum: 0 },
        resolved: { type: 'integer', minimum: 0 },
        known:    { type: 'integer', minimum: 0 },
      },
    },
    retest_cycles: { type: 'integer', minimum: 0 },
  },
};
