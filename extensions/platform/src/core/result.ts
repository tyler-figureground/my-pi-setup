export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

export type Outcome<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export interface ModuleError<Code extends string> {
  readonly code: Code;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: JsonObject;
}

export function success<T>(value: T): Outcome<T, never> {
  return { ok: true, value };
}

export function failure<Code extends string>(
  error: ModuleError<Code>,
): Outcome<never, ModuleError<Code>> {
  return { ok: false, error };
}
