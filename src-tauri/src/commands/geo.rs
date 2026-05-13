use sqlx::Row;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::pool_registry::PoolHandle;
use crate::AppState;

/// Convert a PostGIS EWKB hex string (as emitted by the postgres driver for
/// `geometry`/`geography` columns, e.g. `\x0101000020E6100000...`) into a
/// GeoJSON geometry document by round-tripping through `ST_AsGeoJSON`.
///
/// Only supported on Postgres connections — the function returns
/// `UnsupportedType` on MySQL/SQLite.
#[tauri::command]
pub async fn geometry_to_geojson(
    state: State<'_, AppState>,
    connection_id: String,
    ewkb_hex: String,
) -> AppResult<String> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    let pool = match handle {
        PoolHandle::Postgres(p) => p,
        _ => {
            return Err(AppError::UnsupportedType(
                "PostGIS geometry conversion is only supported on Postgres".into(),
            ));
        }
    };

    let stripped = strip_hex_prefix(&ewkb_hex);
    let row = sqlx::query("SELECT ST_AsGeoJSON($1::bytea::geometry)::text AS geojson")
        .bind(decode_hex(stripped)?)
        .fetch_one(&pool)
        .await?;
    let geojson: String = row.try_get("geojson")?;
    Ok(geojson)
}

/// Batched variant of `geometry_to_geojson` — converts a list of EWKB hex
/// strings to GeoJSON in a single Postgres round-trip via `unnest` +
/// `WITH ORDINALITY`. Input order is preserved; entries whose source value
/// was NULL come back as `None`.
#[tauri::command]
pub async fn geometries_to_geojson(
    state: State<'_, AppState>,
    connection_id: String,
    ewkb_hex_list: Vec<String>,
) -> AppResult<Vec<Option<String>>> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    let pool = match handle {
        PoolHandle::Postgres(p) => p,
        _ => {
            return Err(AppError::UnsupportedType(
                "PostGIS geometry conversion is only supported on Postgres".into(),
            ));
        }
    };

    if ewkb_hex_list.is_empty() {
        return Ok(Vec::new());
    }

    // Strip "\x" and validate hex for every entry before hitting the DB. We
    // keep the stripped strings (not the decoded bytes) because we bind them
    // as `text[]` and let Postgres do the `decode(..., 'hex')` itself — that
    // sidesteps sqlx's spotty support for `bytea[]` binding.
    let stripped: Vec<String> = ewkb_hex_list
        .iter()
        .map(|h| {
            let s = strip_hex_prefix(h);
            decode_hex(s).map(|_| s.to_string())
        })
        .collect::<AppResult<Vec<_>>>()?;

    let rows = sqlx::query(
        r#"
        SELECT ST_AsGeoJSON(decode(h, 'hex')::geometry)::text AS geojson, ord
        FROM unnest($1::text[]) WITH ORDINALITY AS t(h, ord)
        ORDER BY ord
        "#,
    )
    .bind(&stripped)
    .fetch_all(&pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| r.try_get::<Option<String>, _>("geojson").unwrap_or(None))
        .collect())
}

fn strip_hex_prefix(s: &str) -> &str {
    s.strip_prefix("\\x").unwrap_or(s)
}

fn decode_hex(s: &str) -> AppResult<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return Err(AppError::Other("EWKB hex string has odd length".into()));
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    for chunk in s.as_bytes().chunks(2) {
        let hi = hex_nibble(chunk[0])?;
        let lo = hex_nibble(chunk[1])?;
        out.push((hi << 4) | lo);
    }
    Ok(out)
}

fn hex_nibble(c: u8) -> AppResult<u8> {
    match c {
        b'0'..=b'9' => Ok(c - b'0'),
        b'a'..=b'f' => Ok(c - b'a' + 10),
        b'A'..=b'F' => Ok(c - b'A' + 10),
        _ => Err(AppError::Other(format!(
            "invalid hex digit in EWKB string: {:?}",
            c as char
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_hex_prefix_removes_backslash_x() {
        assert_eq!(strip_hex_prefix("\\xABCD"), "ABCD");
        assert_eq!(strip_hex_prefix("ABCD"), "ABCD");
        assert_eq!(strip_hex_prefix(""), "");
    }

    #[test]
    fn decode_hex_round_trip() {
        assert_eq!(decode_hex("").unwrap(), Vec::<u8>::new());
        assert_eq!(decode_hex("00FF").unwrap(), vec![0x00, 0xFF]);
        assert_eq!(
            decode_hex("deadBEEF").unwrap(),
            vec![0xDE, 0xAD, 0xBE, 0xEF]
        );
    }

    #[test]
    fn decode_hex_rejects_odd_length() {
        assert!(decode_hex("ABC").is_err());
    }

    #[test]
    fn decode_hex_rejects_non_hex_digits() {
        assert!(decode_hex("ZZ").is_err());
        assert!(decode_hex("0G").is_err());
    }
}
