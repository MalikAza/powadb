//! Connection-password storage backed by the OS keychain.
//!
//! On macOS / Windows / Linux-with-secret-service this stores each saved
//! connection's password in the platform credential store. The legacy
//! `connections.password` column in `powadb.db` is no longer written to;
//! it's only read once (at startup) so we can migrate any plaintext rows
//! into the keychain and NULL the column.
//!
//! When the platform keychain isn't available (CI, headless Linux without
//! a secret-service daemon, locked Keychain on macOS), the store falls
//! back to writing the legacy SQLite column **and** logs a loud warning
//! to stderr. We prefer "insecure but functional" over "broken" because
//! losing access to your saved connections is a much worse user
//! experience than a plaintext-credential warning the user can act on.
//!
//! Service name is `com.aza.powadb` (matches `tauri.conf.json`'s
//! `identifier`); each entry's account name is `connection-{id}`.

use std::fmt;

use tokio::task::spawn_blocking;

use crate::error::{AppError, AppResult};
use crate::storage::Storage;

const SERVICE: &str = "com.aza.powadb";

fn account_for(connection_id: &str) -> String {
    format!("connection-{connection_id}")
}

#[derive(Debug)]
pub enum KeychainOutcome {
    /// The OS keychain handled the call successfully.
    Ok,
    /// The keychain backend reported an availability error; the caller
    /// used (or should use) the legacy SQLite column as a fallback.
    Unavailable(String),
}

impl fmt::Display for KeychainOutcome {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Ok => write!(f, "ok"),
            Self::Unavailable(msg) => write!(f, "unavailable: {msg}"),
        }
    }
}

pub struct SecretStore;

impl Default for SecretStore {
    fn default() -> Self {
        Self
    }
}

impl SecretStore {
    pub fn new() -> Self {
        Self
    }

    /// Fetch the password for a connection. Tries the OS keychain first;
    /// if the keychain has no entry and the legacy `connections.password`
    /// column is non-NULL, returns that value and opportunistically
    /// migrates it into the keychain (and NULLs the legacy column).
    pub async fn get_password(
        &self,
        storage: &Storage,
        connection_id: &str,
    ) -> AppResult<Option<String>> {
        match keychain_get(connection_id).await? {
            (Some(pw), _) => Ok(Some(pw)),
            (None, KeychainOutcome::Ok) => {
                // Keychain reachable but the entry's missing — check the
                // legacy column for an unmigrated value.
                migrate_legacy_into_keychain(storage, connection_id).await
            }
            (None, KeychainOutcome::Unavailable(_)) => {
                // Keychain unavailable; fall back to whatever the legacy
                // column has (None for newly-saved post-migration rows,
                // Some for old/CI rows).
                storage.get_legacy_password(connection_id).await
            }
        }
    }

    /// Write or clear the password for a connection. Prefers the keychain;
    /// when unavailable, writes the legacy SQLite column and warns.
    /// Always clears the legacy column on a successful keychain write so
    /// the two stores can't drift.
    pub async fn set_password(
        &self,
        storage: &Storage,
        connection_id: &str,
        password: Option<&str>,
    ) -> AppResult<()> {
        let outcome = keychain_set(connection_id, password).await?;
        match outcome {
            KeychainOutcome::Ok => storage.set_legacy_password(connection_id, None).await,
            KeychainOutcome::Unavailable(msg) => {
                eprintln!(
                    "secret_store: keychain unavailable ({msg}); storing connection {connection_id} \
                     password in plaintext SQLite as a fallback. Run a keyring/secret-service \
                     backend to re-secure these credentials."
                );
                storage.set_legacy_password(connection_id, password).await
            }
        }
    }

    /// Forget a connection's password from both stores. Used on
    /// connection delete so we don't leave keychain entries dangling.
    pub async fn delete_password(&self, storage: &Storage, connection_id: &str) -> AppResult<()> {
        // Errors from the keychain branch are swallowed: we still need to
        // clear the legacy column even if the keychain is borked.
        let _ = keychain_set(connection_id, None).await;
        storage.set_legacy_password(connection_id, None).await
    }

    /// Walk every legacy plaintext password row at startup and lift it
    /// into the keychain. Called once from `lib.rs` after `Storage::open`.
    /// Errors are logged (so the user knows the migration didn't fully
    /// succeed) but never abort startup — the fallback path still works.
    pub async fn migrate_legacy_plaintext(&self, storage: &Storage) -> AppResult<()> {
        let rows = storage.list_legacy_passwords().await?;
        if rows.is_empty() {
            return Ok(());
        }
        let mut migrated = 0usize;
        let mut stuck = 0usize;
        for (id, pw) in rows {
            match keychain_set(&id, Some(&pw)).await {
                Ok(KeychainOutcome::Ok) => {
                    if let Err(e) = storage.set_legacy_password(&id, None).await {
                        eprintln!(
                            "secret_store: stored {id} in keychain but failed to NULL \
                                   legacy SQLite column ({e}); will retry next launch"
                        );
                        stuck += 1;
                    } else {
                        migrated += 1;
                    }
                }
                Ok(KeychainOutcome::Unavailable(msg)) => {
                    eprintln!(
                        "secret_store: keychain unavailable ({msg}); leaving connection {id} \
                         password in plaintext SQLite for now."
                    );
                    stuck += 1;
                }
                Err(e) => {
                    eprintln!("secret_store: migration failed for {id}: {e}");
                    stuck += 1;
                }
            }
        }
        eprintln!(
            "secret_store: migrated {migrated} legacy plaintext password(s) into the OS keychain; \
             {stuck} could not be migrated."
        );
        Ok(())
    }
}

// ─── keychain wrappers ───────────────────────────────────────────────────────
//
// All keyring calls happen on a blocking thread because the macOS Security
// framework can block on user prompts (Touch ID, "always allow" dialogs)
// and a blocked tokio worker would freeze the rest of the runtime.

async fn keychain_get(connection_id: &str) -> AppResult<(Option<String>, KeychainOutcome)> {
    let account = account_for(connection_id);
    let res = spawn_blocking(
        move || -> Result<(Option<String>, KeychainOutcome), keyring::Error> {
            let entry = keyring::Entry::new(SERVICE, &account)?;
            match entry.get_password() {
                Ok(p) => Ok((Some(p), KeychainOutcome::Ok)),
                Err(keyring::Error::NoEntry) => Ok((None, KeychainOutcome::Ok)),
                Err(e) => Err(e),
            }
        },
    )
    .await
    .map_err(|e| AppError::Other(format!("keychain task panicked: {e}")))?;
    Ok(classify(res))
}

async fn keychain_set(connection_id: &str, password: Option<&str>) -> AppResult<KeychainOutcome> {
    let account = account_for(connection_id);
    let pw = password.map(|s| s.to_string());
    let res = spawn_blocking(move || -> Result<(), keyring::Error> {
        let entry = keyring::Entry::new(SERVICE, &account)?;
        match pw {
            Some(p) => entry.set_password(&p),
            None => match entry.delete_credential() {
                Ok(()) => Ok(()),
                Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(e),
            },
        }
    })
    .await
    .map_err(|e| AppError::Other(format!("keychain task panicked: {e}")))?;
    Ok(classify_unit(res))
}

fn classify(
    res: Result<(Option<String>, KeychainOutcome), keyring::Error>,
) -> (Option<String>, KeychainOutcome) {
    match res {
        Ok(v) => v,
        Err(e) if is_unavailable(&e) => (None, KeychainOutcome::Unavailable(e.to_string())),
        Err(e) => {
            eprintln!("secret_store: keychain get error: {e}");
            (None, KeychainOutcome::Unavailable(e.to_string()))
        }
    }
}

fn classify_unit(res: Result<(), keyring::Error>) -> KeychainOutcome {
    match res {
        Ok(()) => KeychainOutcome::Ok,
        Err(e) if is_unavailable(&e) => KeychainOutcome::Unavailable(e.to_string()),
        Err(e) => {
            eprintln!("secret_store: keychain set error: {e}");
            KeychainOutcome::Unavailable(e.to_string())
        }
    }
}

/// Treat any backend-level failure as "unavailable" (fall back to SQLite).
/// Per-entry semantic errors (`NoEntry`, `BadEncoding`) are handled by the
/// callers; everything else here is "the keyring crate couldn't talk to
/// the OS at all", which is the case we want to degrade gracefully on.
fn is_unavailable(e: &keyring::Error) -> bool {
    matches!(
        e,
        keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_)
    )
}

/// Helper for `get_password` to lift a legacy plaintext row into the
/// keychain on first access. Returns the password value the caller
/// asked for either way, so the user never sees a transient `None`
/// during the migration.
async fn migrate_legacy_into_keychain(
    storage: &Storage,
    connection_id: &str,
) -> AppResult<Option<String>> {
    let legacy = storage.get_legacy_password(connection_id).await?;
    let Some(pw) = legacy else { return Ok(None) };
    match keychain_set(connection_id, Some(&pw)).await? {
        KeychainOutcome::Ok => {
            if let Err(e) = storage.set_legacy_password(connection_id, None).await {
                eprintln!(
                    "secret_store: stored {connection_id} in keychain but failed to NULL \
                     legacy SQLite column ({e}); will retry next launch"
                );
            }
        }
        KeychainOutcome::Unavailable(msg) => {
            eprintln!(
                "secret_store: keychain unavailable ({msg}); leaving connection {connection_id} \
                 password in plaintext SQLite for now."
            );
        }
    }
    Ok(Some(pw))
}

#[cfg(test)]
mod tests {
    // No tests here exercise the real keychain — that would prompt the user
    // and not work in CI. The plaintext fallback path is exercised by
    // `Storage::set_legacy_password` / `get_legacy_password` tests in
    // storage.rs. Keychain-availability detection is intentionally
    // platform-specific; we trust the `keyring` crate's own test suite.
    use super::*;

    #[test]
    fn account_name_is_prefixed_by_connection() {
        assert_eq!(account_for("abc"), "connection-abc");
    }

    #[test]
    fn is_unavailable_only_matches_backend_errors() {
        assert!(!is_unavailable(&keyring::Error::NoEntry));
    }
}
