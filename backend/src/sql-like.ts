/**
 * LIKE pattern for "starts with": escapes %, _ and \ so user-supplied text can't
 * act as a wildcard. Use with `LIKE $1 ESCAPE '\'`.
 */
export function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
}
