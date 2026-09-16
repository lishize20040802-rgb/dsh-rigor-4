// Rigor's small adapter for the host's supported JSON Schema subset. It supports only
// the primitive parameter types used by this package, and rejects new unsupported
// schema features at mount time. The host owns scheduling, rendering and scopes.
// Keeping this adapter here avoids importing a second copy of the host's SDK.

const TYPES = new Set(['string', 'boolean', 'number', 'integer'])
const FIELDS = new Set(['type', 'required', 'description', 'enum', 'minLength', 'maxLength'])

export function parameterSchema(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) throw new TypeError('Rigor parameters must be a field specification.')
  const properties = Object.create(null)
  const required = []
  for (const [name, field] of Object.entries(spec)) {
    if (field === null || typeof field !== 'object' || !TYPES.has(field.type)) throw new TypeError(`Unsupported Rigor parameter type: ${name}`)
    for (const key of Object.keys(field)) if (!FIELDS.has(key)) throw new TypeError(`Unsupported Rigor parameter keyword: ${name}.${key}`)
    const { required: mandatory, minLength, maxLength, ...schema } = field
    for (const [bound, value] of Object.entries({ minLength, maxLength })) {
      if (value !== undefined && (!Number.isInteger(value) || value < 0)) throw new TypeError(`Invalid parameter bound: ${name}.${bound}`)
    }
    if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) throw new TypeError(`Invalid parameter bounds: ${name}`)
    if (mandatory === true) required.push(name)
    properties[name] = { ...schema, ...(Array.isArray(schema.enum) ? { enum: [...schema.enum] } : {}) }
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

export function validateParameters(schema, args, limits = {}) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return ['arguments must be an object']
  const errors = []
  for (const name of schema.required) if (!Object.hasOwn(args, name)) errors.push(`${name} is required`)
  for (const [name, value] of Object.entries(args)) {
    const field = schema.properties[name]
    if (field === undefined) { errors.push(`unknown parameter ${name}`); continue }
    const typed = field.type === 'integer' ? Number.isInteger(value)
      : field.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : typeof value === field.type
    if (!typed) { errors.push(`${name} must be ${field.type}`); continue }
    if (Array.isArray(field.enum) && !field.enum.includes(value)) errors.push(`${name} must be one of ${field.enum.join(', ')}`)
    if (typeof value === 'string') {
      const bounds = limits[name] ?? field
      if (Number.isInteger(bounds.minLength) && value.length < bounds.minLength) errors.push(`${name} is too short`)
      if (Number.isInteger(bounds.maxLength) && value.length > bounds.maxLength) errors.push(`${name} is too long`)
    }
  }
  return errors
}

export function registerableTool(tool) {
  const parameters = parameterSchema(tool.parameters)
  // DSH 0.1.5-rc.2 rejects length keywords in model-facing schemas. Enforce them
  // before execution without importing another SDK or weakening the local guard.
  const limits = Object.fromEntries(Object.entries(tool.parameters).map(([name, field]) => [name, { minLength: field.minLength, maxLength: field.maxLength }]))
  return {
    ...tool,
    parameters,
    async execute(args, exec) {
      const errors = validateParameters(parameters, args, limits)
      if (errors.length > 0) throw new TypeError(`Invalid arguments for ${tool.name}: ${errors.join('; ')}`)
      try {
        return await tool.execute(args, exec)
      } catch (error) {
        if (error?.rigorStorage === true) return { recorded: false, refused: error.message, code: error.code }
        throw error
      }
    },
  }
}
