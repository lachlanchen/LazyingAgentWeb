export class ControlPlaneError extends Error {
  constructor(message, { code = 'control_plane_error', cause } = {}) {
    super(message, { cause });
    this.name = new.target.name;
    this.code = code;
  }
}

export class ValidationError extends ControlPlaneError {
  constructor(message, options = {}) {
    super(message, { ...options, code: 'invalid_input' });
  }
}

export class NotFoundError extends ControlPlaneError {
  constructor(message = 'The requested resource does not exist.', options = {}) {
    super(message, { ...options, code: 'not_found' });
  }
}

export class ConflictError extends ControlPlaneError {
  constructor(message = 'The requested mutation conflicts with existing state.', options = {}) {
    super(message, { ...options, code: 'conflict' });
  }
}

export class IdempotencyConflictError extends ControlPlaneError {
  constructor(message = 'The idempotency key was already used for a different request.', options = {}) {
    super(message, { ...options, code: 'idempotency_conflict' });
  }
}

export class StorageSecurityError extends ControlPlaneError {
  constructor(message, options = {}) {
    super(message, { ...options, code: 'storage_security_error' });
  }
}

export class StorageCorruptionError extends ControlPlaneError {
  constructor(message = 'The control-plane database failed integrity validation.', options = {}) {
    super(message, { ...options, code: 'storage_corruption' });
  }
}

export class UnsupportedSchemaError extends ControlPlaneError {
  constructor(message = 'The control-plane database schema is newer than this software.', options = {}) {
    super(message, { ...options, code: 'unsupported_schema' });
  }
}

