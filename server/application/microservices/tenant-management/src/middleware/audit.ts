import type { Context, Next } from 'hono';
import { createLogger } from '../lib/logger';

const auditLogger = createLogger('audit');

// PII (Personally Identifiable Information) protection
// Set to 'true' to log user email addresses (default: 'false' for GDPR/compliance)
const LOG_PII = process.env.LOG_PII === 'true';

export interface AuditLogEntry {
  timestamp: string;
  userId?: string;
  userEmail?: string;
  action: string;
  resource: string;
  resourceId?: string;
  method: string;
  path: string;
  statusCode?: number;
  ipAddress?: string;
  userAgent?: string;
  requestBody?: unknown;
  responseTime?: number;
  error?: string;
}

/**
 * Audit logging middleware
 * Logs all tenant management operations for compliance and security
 */
export async function auditMiddleware(c: Context, next: Next) {
  const startTime = Date.now();
  const method = c.req.method;
  const path = c.req.path;

  // Extract user info if available
  const user = c.get('user');

  // Determine action and resource from path
  const { action, resource, resourceId } = parsePathInfo(method, path);

  // Capture request body for POST/PATCH/PUT
  let requestBody: unknown = undefined;
  if (['POST', 'PATCH', 'PUT'].includes(method)) {
    try {
      // Clone the request to read body without consuming it
      const clonedReq = c.req.raw.clone();
      requestBody = await clonedReq.json();

      // Redact sensitive fields
      if (
        requestBody &&
        typeof requestBody === 'object' &&
        !Array.isArray(requestBody)
      ) {
        requestBody = redactSensitiveData(
          requestBody as Record<string, unknown>
        );
      }
    } catch {
      // Body might not be JSON, ignore
    }
  }

  // Execute the request
  await next();

  // Calculate response time
  const responseTime = Date.now() - startTime;

  // Get response status
  const statusCode = c.res.status;

  // Create audit log entry
  const auditEntry: AuditLogEntry = {
    timestamp: new Date().toISOString(),
    userId: user?.id,
    // Only log email if PII logging is explicitly enabled (GDPR/compliance)
    ...(LOG_PII && user?.email ? { userEmail: user.email } : {}),
    action,
    resource,
    resourceId,
    method,
    path,
    statusCode,
    ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    userAgent: c.req.header('user-agent'),
    requestBody,
    responseTime,
  };

  // Log with appropriate level based on status code
  if (statusCode >= 500) {
    auditLogger.error(auditEntry, 'Server error during operation');
  } else if (statusCode >= 400) {
    auditLogger.warn(auditEntry, 'Client error during operation');
  } else {
    auditLogger.info(auditEntry, 'Operation completed');
  }
}

/**
 * Parse HTTP method and path to determine action and resource
 */
function parsePathInfo(
  method: string,
  path: string
): {
  action: string;
  resource: string;
  resourceId?: string;
} {
  // Extract resource and ID from path
  // Example: /api/tenants/123 -> resource: "tenants", resourceId: "123"
  // Example: /api/tenants -> resource: "tenants", resourceId: undefined
  const pathParts = path.split('/').filter(Boolean);
  const possibleId = pathParts[pathParts.length - 1];

  // Check if last part is an ID (UUID pattern or looks like an ID)
  const isId =
    possibleId &&
    (possibleId.match(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    ) ||
      !isNaN(Number(possibleId)));

  // Determine resource and resourceId based on whether last part is an ID
  const resourceId = isId ? possibleId : undefined;
  const resource = isId
    ? pathParts[pathParts.length - 2] || 'unknown'
    : possibleId || 'unknown';

  // Determine action from HTTP method
  let action: string;
  switch (method) {
    case 'GET':
      action = resourceId ? 'view' : 'list';
      break;
    case 'POST':
      action = 'create';
      break;
    case 'PATCH':
    case 'PUT':
      action = 'update';
      break;
    case 'DELETE':
      action = 'delete';
      break;
    default:
      action = method.toLowerCase();
  }

  return { action, resource, resourceId };
}

/**
 * Redact sensitive data from logs
 */
function redactSensitiveData(
  data: Record<string, unknown>
): Record<string, unknown> {
  const sensitiveFields = [
    'password',
    'token',
    'secret',
    'apiKey',
    'creditCard',
  ];
  const redacted = { ...data };

  for (const field of sensitiveFields) {
    if (field in redacted) {
      redacted[field] = '[REDACTED]';
    }
  }

  return redacted;
}
