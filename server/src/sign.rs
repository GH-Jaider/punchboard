//! Request signing shared by the deck (which signs) and the server (which
//! checks). A deck holds a secret it got once, at pairing, and signs every
//! request with HMAC-SHA256 over the method, path, time, a one-off nonce and
//! the body's hash. The secret itself never crosses the network again.
//!
//! The deck's half is `src/shared/sign.ts`, which stays in TypeScript and
//! writes SHA-256 out by hand (crypto.subtle only exists on HTTPS pages, and
//! a deck is served over plain HTTP on the local network). This is the same
//! arithmetic through the `sha2` and `hmac` crates: tests/fixtures/make-auth.ts
//! signs many requests with the TypeScript, and the tests here must give the
//! same signatures, so a tablet with the current client still verifies.

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::store::js_number;

/// The four signature fields, sent as X-Punchboard-* headers or d/t/n/s
/// query params (`SignedFields` in src/shared/api.ts).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedFields {
    pub device: String,
    pub time: String,
    pub nonce: String,
    pub signature: String,
}

/// What a deck signs with: its id and the secret it got at pairing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SigningKey {
    pub id: String,
    pub secret: String,
}

/// SHA-256 of the text's UTF-8 bytes, in lowercase hex.
pub fn sha256_hex(input: &str) -> String {
    hex::encode(Sha256::digest(input.as_bytes()))
}

/// HMAC-SHA256 of the text, keyed with the secret's UTF-8 bytes, in lowercase hex.
pub fn hmac_hex(secret: &str, input: &str) -> String {
    // HMAC takes a key of any length (longer than a block is hashed first,
    // as the TypeScript does), so this cannot fail; the fallback is unreachable.
    match Hmac::<Sha256>::new_from_slice(secret.as_bytes()) {
        Ok(mut mac) => {
            mac.update(input.as_bytes());
            hex::encode(mac.finalize().into_bytes())
        }
        Err(_) => String::new(),
    }
}

/// The exact string both sides sign. `time` is the time as JavaScript would
/// print it inside a template string: see [`time_text`] for a number.
pub fn canonical(method: &str, path: &str, time: &str, nonce: &str, body: &str) -> String {
    format!(
        "{}\n{path}\n{time}\n{nonce}\n{}",
        method.to_uppercase(),
        sha256_hex(body)
    )
}

/// `String(time)` for a time in milliseconds.
pub fn time_text(time: f64) -> String {
    js_number(time)
}

/// Signature fields for one request. `time` is the server's clock as the caller estimates it.
pub fn sign_request(
    key: &SigningKey,
    method: &str,
    path: &str,
    body: &str,
    time: f64,
    nonce: &str,
) -> SignedFields {
    let time = time_text(time);
    let signature = hmac_hex(&key.secret, &canonical(method, path, &time, nonce, body));
    SignedFields {
        device: key.id.clone(),
        time,
        nonce: nonce.to_string(),
        signature,
    }
}

/// Whether two texts are the same, in a time that depends on their length
/// only (`crypto.timingSafeEqual` behind a length check, as auth.ts has it).
pub fn same_text(a: &str, b: &str) -> bool {
    let (left, right) = (a.as_bytes(), b.as_bytes());
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (x, y) in left.iter().zip(right) {
        difference |= x ^ y;
    }
    std::hint::black_box(difference) == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::path::PathBuf;

    fn cases(file: &str) -> Vec<Value> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/auth")
            .join(file);
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
    }

    fn text<'a>(value: &'a Value, what: &str) -> &'a str {
        value
            .as_str()
            .unwrap_or_else(|| panic!("{what} is not text: {value}"))
    }

    #[test]
    fn hashes_match_the_typescript() {
        let all = cases("sign-hash.json");
        assert!(all.len() >= 60, "{} cases", all.len());
        for case in &all {
            let input = &case["input"];
            let (secret, message) = (
                text(&input["secret"], "secret"),
                text(&input["text"], "text"),
            );
            assert_eq!(
                case["output"]["sha256"],
                sha256_hex(message),
                "sha256Hex of {} bytes",
                message.len()
            );
            assert_eq!(
                case["output"]["hmac"],
                hmac_hex(secret, message),
                "hmacHex with a secret of {} bytes",
                secret.len()
            );
        }
    }

    #[test]
    fn signatures_match_the_typescript() {
        let all = cases("sign-request.json");
        assert!(all.len() >= 200, "{} cases", all.len());
        for case in &all {
            let input = &case["input"];
            let key = SigningKey {
                id: text(&input["id"], "id").to_string(),
                secret: text(&input["secret"], "secret").to_string(),
            };
            let time = input["time"].as_f64().expect("a time");
            let (method, path) = (
                text(&input["method"], "method"),
                text(&input["path"], "path"),
            );
            let (body, nonce) = (text(&input["body"], "body"), text(&input["nonce"], "nonce"));
            let signed = sign_request(&key, method, path, body, time, nonce);
            assert_eq!(
                case["output"]["canonical"],
                canonical(method, path, &time_text(time), nonce, body),
                "canonical({input})"
            );
            assert_eq!(
                case["output"]["signed"],
                serde_json::to_value(&signed).expect("fields"),
                "signRequest({input})"
            );
        }
    }

    #[test]
    fn the_known_answers_hold() {
        // FIPS 180-2 and RFC 4231 (test case 2): the crates agree with the standards.
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            hmac_hex("Jefe", "what do ya want for nothing?"),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn same_text_is_exact() {
        assert!(same_text("", ""));
        assert!(same_text("abc123", "abc123"));
        assert!(!same_text("abc123", "abc124"));
        assert!(!same_text("abc", "abcd"));
        assert!(!same_text("ABC", "abc"));
        assert!(!same_text("é", "e"));
    }
}
