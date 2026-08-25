export function canonicalJson(value: unknown): string {
  const active = new WeakSet<object>();

  const visit = (current: unknown): string => {
    if (current === null) return "null";
    if (typeof current === "string" || typeof current === "boolean") {
      return JSON.stringify(current);
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new TypeError("JSON numbers must be finite");
      }
      return JSON.stringify(current);
    }
    if (typeof current !== "object") {
      throw new TypeError("Value must be JSON-compatible");
    }
    if (active.has(current)) throw new TypeError("JSON values must not cycle");
    active.add(current);
    try {
      if (Array.isArray(current)) {
        const values: string[] = [];
        for (let index = 0; index < current.length; index++) {
          if (!Object.hasOwn(current, index)) {
            throw new TypeError("JSON arrays must not contain holes");
          }
          values.push(visit(current[index]));
        }
        return `[${values.join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("Objects must use a plain prototype");
      }
      const entries = Object.entries(current as Record<string, unknown>).sort(
        ([left], [right]) => left.localeCompare(right),
      );
      return `{${entries
        .map(([key, item]) => `${JSON.stringify(key)}:${visit(item)}`)
        .join(",")}}`;
    } finally {
      active.delete(current);
    }
  };

  return visit(value);
}
