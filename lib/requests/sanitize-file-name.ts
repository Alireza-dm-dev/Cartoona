/**
 * Reduce an untrusted file name to a single safe path segment.
 *
 * Separators and traversal sequences are removed rather than escaped, so the
 * result can never climb out of the folder it is joined onto. Extracted from
 * the request route so the rule is unit-tested rather than only exercised
 * through an upload.
 */
export function sanitizeFileName(name: string): string {
  let safe = name.replace(/[/\\]/g, "_")
  safe = safe.replace(/\.\./g, "")
  safe = safe.replace(/[^a-zA-Z0-9._-]/g, "_")
  safe = safe.replace(/_+/g, "_")
  safe = safe.replace(/^_|_$/g, "")
  return safe.slice(0, 255) || "file"
}
