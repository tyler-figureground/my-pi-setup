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
