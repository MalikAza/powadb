use serde::{Serialize, Serializer};

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
        s.serialize_str(&self.to_string())
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
    fn io_error_is_convertible_via_question_mark() {
        fn inner() -> AppResult<()> {
            Err(std::io::Error::other("nope"))?;
            Ok(())
        }
        let s = inner().unwrap_err().to_string();
        assert!(s.starts_with("io error:"), "got {s}");
    }
}
