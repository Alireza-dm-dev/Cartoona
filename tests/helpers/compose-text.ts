/**
 * Minimal, dependency-free views over compose.yml for static tests.
 *
 * Not a YAML parser: it relies only on Compose's conventional 2-space layout
 * (top-level keys at column 0, services at 2 spaces). That is enough to scope
 * assertions to one service without snapshotting the whole file.
 */

/** Lines of one top-level section (`services:`, `volumes:`), header excluded. */
export function composeSection(compose: string, key: string): string[] {
  const lines = compose.split("\n")
  const start = lines.findIndex((l) => l === `${key}:`)
  if (start === -1) return []
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^\S/.test(l) && !l.startsWith("#"))
  return end === -1 ? rest : rest.slice(0, end)
}

/** Service names, in file order. */
export function composeServiceNames(compose: string): string[] {
  return composeSection(compose, "services")
    .map((l) => /^ {2}([a-z][\w-]*):\s*$/.exec(l)?.[1])
    .filter((name): name is string => Boolean(name))
}

/** One service's block as text, its own `  name:` line included; "" if absent. */
export function composeService(compose: string, name: string): string {
  const lines = composeSection(compose, "services")
  const start = lines.findIndex((l) => l === `  ${name}:`)
  if (start === -1) return ""
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^ {2}[a-z]/.test(l))
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join("\n")
}

/** Non-comment content, so prose in a comment cannot satisfy or break a check. */
export function withoutYamlComments(text: string): string {
  return text
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .map((l) => l.replace(/\s+#\s.*$/, ""))
    .join("\n")
}
