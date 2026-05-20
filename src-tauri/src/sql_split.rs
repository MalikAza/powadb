//! SQL statement splitter for multi-statement script execution.
//!
//! sqlx's `query()` prepares a single statement, so a user pasting
//! `DELETE ...; DELETE ...;` into the editor gets driver-level errors
//! ("cannot insert multiple commands into a prepared statement" on PG).
//! For script execution we split client-side and run each statement in
//! turn on the same pooled connection.
//!
//! The splitter only needs to find unquoted `;`. It tracks:
//! - single-quoted strings `'...'` (Postgres allows `''` escapes; backslash
//!   escapes inside strings are off by default — `standard_conforming_strings`
//!   has been on by default since PG 9.1, so we ignore them)
//! - double-quoted identifiers `"..."` (same `""` escape)
//! - MySQL backtick identifiers `` `...` ``
//! - line comments `-- ...\n`
//! - block comments `/* ... */` (non-nesting — matches sqlx and ANSI; PG nests
//!   them, but treating them as flat is safe for finding statement boundaries
//!   since nested `/*` cannot legally appear outside a real comment)
//! - Postgres dollar-quoted strings: `$$...$$`, `$tag$...$tag$`
//!
//! Returns each non-empty statement with leading whitespace trimmed and
//! trailing `;` removed.

/// Split a SQL script into individual statements.
pub fn split_statements(sql: &str) -> Vec<String> {
    let bytes = sql.as_bytes();
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;

    while i < bytes.len() {
        let b = bytes[i];

        // Line comment.
        if b == b'-' && bytes.get(i + 1) == Some(&b'-') {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }

        // Block comment (non-nesting).
        if b == b'/' && bytes.get(i + 1) == Some(&b'*') {
            i += 2;
            while i < bytes.len() {
                if bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/') {
                    i += 2;
                    break;
                }
                i += 1;
            }
            continue;
        }

        // Single-quoted string.
        if b == b'\'' {
            i += 1;
            while i < bytes.len() {
                if bytes[i] == b'\'' {
                    // Doubled `''` inside a string literal is an escaped quote.
                    if bytes.get(i + 1) == Some(&b'\'') {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }

        // Double-quoted identifier.
        if b == b'"' {
            i += 1;
            while i < bytes.len() {
                if bytes[i] == b'"' {
                    if bytes.get(i + 1) == Some(&b'"') {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }

        // Backtick identifier (MySQL).
        if b == b'`' {
            i += 1;
            while i < bytes.len() {
                if bytes[i] == b'`' {
                    if bytes.get(i + 1) == Some(&b'`') {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }

        // Postgres dollar-quoted string: $tag$...$tag$. The tag must start
        // with a letter or underscore and contain only letters, digits, or
        // underscores (or be empty for `$$...$$`). If what follows the first
        // `$` doesn't look like a valid opening tag, treat the `$` as a
        // normal character (it could be a positional parameter `$1`, etc).
        if b == b'$' {
            if let Some((tag_end, tag)) = read_dollar_tag(bytes, i) {
                // tag_end points at the byte after the closing `$` of the
                // opening tag. Search forward for the matching closer.
                let needle_start = tag_end;
                let mut j = needle_start;
                let closer_len = tag.len() + 2; // `$` + tag + `$`
                let mut closed = false;
                while j + closer_len <= bytes.len() {
                    if bytes[j] == b'$'
                        && &bytes[j + 1..j + 1 + tag.len()] == tag
                        && bytes[j + 1 + tag.len()] == b'$'
                    {
                        j += closer_len;
                        closed = true;
                        break;
                    }
                    j += 1;
                }
                // If unterminated, swallow the rest — the driver will reject.
                i = if closed { j } else { bytes.len() };
                continue;
            }
        }

        // Statement boundary.
        if b == b';' {
            push_trimmed(&mut out, &sql[start..i]);
            i += 1;
            start = i;
            continue;
        }

        i += 1;
    }

    if start < bytes.len() {
        push_trimmed(&mut out, &sql[start..]);
    }

    out
}

fn push_trimmed(out: &mut Vec<String>, raw: &str) {
    let trimmed = raw.trim();
    if !trimmed.is_empty() {
        out.push(trimmed.to_string());
    }
}

/// If `bytes[i] == '$'` and what follows is a valid dollar-quote opener,
/// return `(end_index, tag_bytes)` where `end_index` is the position right
/// after the closing `$` of the opener.
fn read_dollar_tag(bytes: &[u8], i: usize) -> Option<(usize, &[u8])> {
    debug_assert_eq!(bytes[i], b'$');
    let tag_start = i + 1;
    let mut j = tag_start;
    while j < bytes.len() {
        let c = bytes[j];
        let valid_first = c == b'_' || c.is_ascii_alphabetic();
        let valid_rest = c == b'_' || c.is_ascii_alphanumeric();
        let is_first = j == tag_start;
        if c == b'$' {
            return Some((j + 1, &bytes[tag_start..j]));
        }
        if is_first {
            if !valid_first {
                return None;
            }
        } else if !valid_rest {
            return None;
        }
        j += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(sql: &str) -> Vec<String> {
        split_statements(sql)
    }

    #[test]
    fn empty_input() {
        assert!(split_statements("").is_empty());
    }

    #[test]
    fn whitespace_only() {
        assert!(split_statements("   \n\t\n").is_empty());
    }

    #[test]
    fn single_statement_no_trailing_semicolon() {
        assert_eq!(split("SELECT 1"), vec!["SELECT 1"]);
    }

    #[test]
    fn single_statement_with_trailing_semicolon() {
        assert_eq!(split("SELECT 1;"), vec!["SELECT 1"]);
    }

    #[test]
    fn two_statements() {
        assert_eq!(
            split("DELETE FROM t WHERE id = 1; DELETE FROM t WHERE id = 2;"),
            vec!["DELETE FROM t WHERE id = 1", "DELETE FROM t WHERE id = 2"],
        );
    }

    #[test]
    fn drops_empty_statements_between_semicolons() {
        assert_eq!(
            split("SELECT 1;;\n;SELECT 2;"),
            vec!["SELECT 1", "SELECT 2"]
        );
    }

    #[test]
    fn ignores_semicolon_inside_single_quote() {
        assert_eq!(
            split("INSERT INTO t (s) VALUES ('a;b'); SELECT 1;"),
            vec!["INSERT INTO t (s) VALUES ('a;b')", "SELECT 1"],
        );
    }

    #[test]
    fn handles_escaped_single_quote() {
        assert_eq!(
            split("INSERT INTO t (s) VALUES ('a''b;c'); SELECT 1;"),
            vec!["INSERT INTO t (s) VALUES ('a''b;c')", "SELECT 1"],
        );
    }

    #[test]
    fn ignores_semicolon_inside_double_quoted_identifier() {
        assert_eq!(
            split(r#"SELECT 1 AS "weird;name"; SELECT 2;"#),
            vec![r#"SELECT 1 AS "weird;name""#, "SELECT 2"],
        );
    }

    #[test]
    fn ignores_semicolon_inside_backtick_identifier() {
        assert_eq!(
            split("SELECT 1 AS `weird;col`; SELECT 2;"),
            vec!["SELECT 1 AS `weird;col`", "SELECT 2"],
        );
    }

    #[test]
    fn ignores_semicolon_in_line_comment() {
        assert_eq!(
            split("SELECT 1; -- trailing; comment\nSELECT 2;"),
            vec!["SELECT 1", "-- trailing; comment\nSELECT 2"],
        );
    }

    #[test]
    fn ignores_semicolon_in_block_comment() {
        assert_eq!(
            split("SELECT 1 /* hidden ; semi */ ; SELECT 2;"),
            vec!["SELECT 1 /* hidden ; semi */", "SELECT 2"],
        );
    }

    #[test]
    fn ignores_semicolon_in_dollar_quoted_anonymous() {
        assert_eq!(
            split("DO $$ BEGIN DELETE FROM t; END $$; SELECT 1;"),
            vec!["DO $$ BEGIN DELETE FROM t; END $$", "SELECT 1"],
        );
    }

    #[test]
    fn ignores_semicolon_in_dollar_quoted_tagged() {
        assert_eq!(
            split("SELECT $body$ a;b;c $body$; SELECT 2;"),
            vec!["SELECT $body$ a;b;c $body$", "SELECT 2"],
        );
    }

    #[test]
    fn dollar_followed_by_digit_is_not_a_quote() {
        // Positional placeholder — we don't bind here, but the splitter must
        // not treat `$1` as the start of a dollar-quoted string.
        assert_eq!(
            split("SELECT $1; SELECT $2;"),
            vec!["SELECT $1", "SELECT $2"],
        );
    }

    #[test]
    fn unterminated_string_consumes_to_end() {
        // Driver will reject; splitter must not infinite-loop or panic.
        let out = split_statements("SELECT 'oops");
        // Whatever we return, we must terminate.
        assert!(out.len() <= 1);
    }
}
