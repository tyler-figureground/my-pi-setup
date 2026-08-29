import type { NamedProfileExecutionPort } from "../automation/hooks/adapters.ts";

const ports = new WeakMap<object, NamedProfileExecutionPort>();

export function bindNamedProfileExecutionPort(
  loader: object,
  port: NamedProfileExecutionPort,
) {
  if (ports.has(loader)) {
    throw new Error(
      "A Named Profile execution port is already bound to this loader.",
    );
  }
  ports.set(loader, port);
  return () => {
    if (ports.get(loader) === port) ports.delete(loader);
  };
}

export function namedProfileExecutionPortFor(loader: object) {
  return ports.get(loader);
}
