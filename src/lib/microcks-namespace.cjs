const { MICROCKS_SERVICE_PREFIX } = require('../config.cjs');

class NamespaceViolationError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = 'NamespaceViolationError';
    this.context = context;
  }
}

function getPrefix() {
  return MICROCKS_SERVICE_PREFIX || '';
}

function isEnabled() {
  return Boolean(MICROCKS_SERVICE_PREFIX);
}

// True if a given Microcks service name falls inside our namespace.
// When the prefix is disabled (empty), everything is considered in-namespace.
function isInNamespace(serviceName) {
  if (!serviceName || typeof serviceName !== 'string') return false;
  if (!isEnabled()) return true;
  return serviceName.startsWith(MICROCKS_SERVICE_PREFIX);
}

// Ensure the name starts with our prefix. Idempotent.
// Returns `${prefix}${name}` if not already prefixed, else returns as-is.
function applyPrefix(serviceName) {
  if (!serviceName || typeof serviceName !== 'string') return serviceName;
  if (!isEnabled()) return serviceName;
  if (serviceName.startsWith(MICROCKS_SERVICE_PREFIX)) return serviceName;
  return `${MICROCKS_SERVICE_PREFIX}${serviceName}`;
}

// Opposite of applyPrefix — strip the prefix if present. Used for display.
function stripPrefix(serviceName) {
  if (!serviceName || typeof serviceName !== 'string') return serviceName;
  if (!isEnabled()) return serviceName;
  if (serviceName.startsWith(MICROCKS_SERVICE_PREFIX)) {
    return serviceName.slice(MICROCKS_SERVICE_PREFIX.length);
  }
  return serviceName;
}

// Build a human-friendly display name for a workspace-scoped service.
// AI-generated services have names like `${prefix}${wsId}-${baseName}`. This
// strips both the global prefix and the workspace id so the UI can show just
// the base name (e.g. "UsersAPI" instead of "unified-ws-mc8x9y-UsersAPI").
// When the service does not belong to a workspace, only the prefix is stripped.
function getDisplayName(serviceName, workspaceId) {
  const stripped = stripPrefix(serviceName);
  if (workspaceId && typeof workspaceId === 'string') {
    const wsPrefix = `${workspaceId}-`;
    if (stripped.startsWith(wsPrefix)) {
      return stripped.slice(wsPrefix.length);
    }
  }
  return stripped;
}

// Hard guard for mutating operations (delete, dispatcher overrides, etc).
// Throws NamespaceViolationError if called with a service name outside the
// namespace. Callers should catch and surface a 403-style response.
function assertInNamespace(serviceName, operation = 'mutate') {
  if (!isEnabled()) return;
  if (!isInNamespace(serviceName)) {
    throw new NamespaceViolationError(
      `Refusing to ${operation} service "${serviceName}" — outside namespace "${MICROCKS_SERVICE_PREFIX}*". ` +
      `The unified mockserver only manages services it created.`,
      { serviceName, operation, prefix: MICROCKS_SERVICE_PREFIX }
    );
  }
}

// Filter a list of Microcks services down to just the ones in our namespace.
// Used by dashboard / workspace listings to hide other teams' services from our UI.
function filterToNamespace(services) {
  if (!Array.isArray(services)) return [];
  if (!isEnabled()) return services;
  return services.filter(s => s && isInNamespace(s.name));
}

module.exports = {
  NamespaceViolationError,
  getPrefix,
  isEnabled,
  isInNamespace,
  applyPrefix,
  stripPrefix,
  getDisplayName,
  assertInNamespace,
  filterToNamespace,
};
