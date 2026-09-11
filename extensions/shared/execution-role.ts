/**
 * Execution Role vocabulary plus the host-side binding that stamps one role
 * onto a resource loader's event bus.
 *
 * The role is bound by the host (`createChildResources` in `child-session.ts`)
 * and is never read from env vars, model arguments, or session files. A bus
 * holds at most one role (rebinding to a different role throws). Other
 * extensions resolve it with `executionRoleFor`, which answers "parent" for an
 * unbound top-level loader; `platform/src/composition.ts` uses that to keep
 * platform daemons Parent-only. Shared by `child-session.ts`,
 * `agent-profile.ts`, `guarded-workspace.ts`, and platform policy, messaging,
 * and memory. See docs/architecture/platform-foundation.md ("Execution roles").
 */

export const EXECUTION_ROLES = [
  "parent",
  "subagent",
  "workflow",
  "review",
  "scheduled",
  "goal-worker",
] as const;

export type ExecutionRole = (typeof EXECUTION_ROLES)[number];
export type ChildExecutionRole = Exclude<ExecutionRole, "parent">;

export const CHILD_EXECUTION_ROLES = EXECUTION_ROLES.filter(
  (role): role is ChildExecutionRole => role !== "parent",
);

interface RoleEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

interface RoleQuery {
  role?: ExecutionRole;
}

const ROLE_QUERY_CHANNEL = "pi-platform:execution-role-query";
const executionRoles = new WeakMap<object, ExecutionRole>();

export function bindExecutionRole(events: RoleEventBus, role: ExecutionRole) {
  const existing = executionRoles.get(events);
  if (existing && existing !== role) {
    throw new Error(
      `Event bus is already bound to execution role ${JSON.stringify(existing)}.`,
    );
  }
  if (existing) return events;
  executionRoles.set(events, role);
  events.on(ROLE_QUERY_CHANNEL, (data) => {
    if (!data || typeof data !== "object") return;
    const query = data as RoleQuery;
    if (Object.hasOwn(query, "role")) return;
    Object.defineProperty(query, "role", {
      value: role,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  });
  return events;
}

export function executionRoleFor(events: RoleEventBus): ExecutionRole {
  const direct = executionRoles.get(events);
  if (direct) return direct;
  const query: RoleQuery = {};
  events.emit(ROLE_QUERY_CHANNEL, query);
  return query.role ?? "parent";
}
