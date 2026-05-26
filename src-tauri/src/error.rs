use serde::{Serialize, Serializer};

/// Strip embedded credentials from connection-string-shaped substrings before
/// they cross the IPC boundary. Driver errors (sqlx, mongodb) routinely echo
/// back the URI that failed to connect, including the password.
///
/// The shape we redact is `scheme://anything-up-to-@` → `scheme://***@`.
pub fn scrub_credentials(msg: &str) -> String {
    const SCHEMES: &[&str] = &[
        "mongodb+srv://",
        "mongodb://",
        "postgresql://",
        "postgres://",
        "mysql://",
        "mariadb://",
    ];
    let mut out = String::with_capacity(msg.len());
    let mut rest = msg;
    'outer: while !rest.is_empty() {
        for scheme in SCHEMES {
            if let Some(idx) = rest.find(scheme) {
                // Emit everything up to and including the scheme.
                out.push_str(&rest[..idx]);
                out.push_str(scheme);
                let after_scheme = &rest[idx + scheme.len()..];
                // If there's a userinfo segment (anything containing ':' before the next '/' or '@'),
                // it ends at the first '@'. Redact it.
                let auth_end = after_scheme.find('@');
                let stop = after_scheme.find(['/', '?', ' ', '"', '\'']);
                let has_userinfo = match (auth_end, stop) {
                    (Some(a), Some(s)) => a < s,
                    (Some(_), None) => true,
                    _ => false,
                };
                if has_userinfo {
                    let a = auth_end.unwrap();
                    // Keep the user portion if there's no ':' (no password to leak),
                    // otherwise redact the whole userinfo.
                    let userinfo = &after_scheme[..a];
                    if userinfo.contains(':') {
                        out.push_str("***");
                    } else {
                        out.push_str(userinfo);
                    }
                    out.push('@');
                    rest = &after_scheme[a + 1..];
                } else {
                    rest = after_scheme;
                }
                continue 'outer;
            }
        }
        out.push_str(rest);
        break;
    }
    out
}

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("unsupported column type: {0}")]
    UnsupportedType(String),

    #[error("query canceled")]
    Canceled,

    #[error("connection not found: {0}")]
    ConnectionNotFound(String),

    #[error("wireguard tunnel error: {0}")]
    WgTunnel(String),

    #[error("ssh tunnel error: {0}")]
    SshTunnel(String),

    #[error(
        "ssh host key mismatch — expected {expected}, got {actual}. \
         If you intentionally changed the server, edit the connection and clear the stored fingerprint."
    )]
    SshHostKeyMismatch { expected: String, actual: String },

    #[error("{0}")]
    Other(String),
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&scrub_credentials(&self.to_string()))
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_includes_human_message() {
        assert_eq!(AppError::Canceled.to_string(), "query canceled");
        assert_eq!(
            AppError::UnsupportedType("FOO".into()).to_string(),
            "unsupported column type: FOO",
        );
        assert_eq!(
            AppError::ConnectionNotFound("abc".into()).to_string(),
            "connection not found: abc",
        );
        assert_eq!(AppError::Other("boom".into()).to_string(), "boom");
    }

    #[test]
    fn serializes_as_a_string() {
        let json = serde_json::to_string(&AppError::Canceled).unwrap();
        assert_eq!(json, "\"query canceled\"");
    }

    #[test]
    fn scrub_redacts_mongodb_credentials() {
        let s =
            scrub_credentials("failed to connect to mongodb://alice:hunter2@db.example.com/admin");
        assert_eq!(s, "failed to connect to mongodb://***@db.example.com/admin");
    }

    #[test]
    fn scrub_redacts_postgres_srv_and_query_string() {
        let s = scrub_credentials("postgres://u:p@host:5432/db?sslmode=require leaked into output");
        assert_eq!(
            s,
            "postgres://***@host:5432/db?sslmode=require leaked into output"
        );
    }

    #[test]
    fn scrub_leaves_userinfo_with_no_password_alone() {
        // No `:` before the `@` → no password to redact.
        let s = scrub_credentials("mongodb+srv://alice@cluster.example.com/x");
        assert_eq!(s, "mongodb+srv://alice@cluster.example.com/x");
    }

    #[test]
    fn scrub_leaves_plain_messages_untouched() {
        let s = scrub_credentials("nothing to redact here");
        assert_eq!(s, "nothing to redact here");
    }

    #[test]
    fn scrub_handles_multiple_uris_in_one_message() {
        let s = scrub_credentials("tried postgres://u:p@a/db then mysql://r:s@b/db2");
        assert_eq!(s, "tried postgres://***@a/db then mysql://***@b/db2");
    }

    #[test]
    fn serialize_scrubs_credentials() {
        let err = AppError::Other("connect mongodb://alice:hunter2@host failed".into());
        let json = serde_json::to_string(&err).unwrap();
        assert_eq!(json, "\"connect mongodb://***@host failed\"");
    }

    #[test]
    fn io_error_is_convertible_via_question_mark() {
        fn inner() -> AppResult<()> {
            Err(std::io::Error::other("nope"))?;
            Ok(())
        }
        let s = inner().unwrap_err().to_string();
        assert!(s.starts_with("io error:"), "got {s}");
    }
}
