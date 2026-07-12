/**
 * Wrap a value as a single POSIX shell argument, safe against spaces, quotes,
 * and metacharacters. Uses the standard single-quote escape (`'\''`) so the
 * result can be interpolated directly into a `sandbox.exec` command string.
 */
export function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
