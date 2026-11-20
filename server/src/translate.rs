//! How code that is not about languages asks for a sentence.
//!
//! In TypeScript the shared code calls a global `t(key, vars)`. Here whoever
//! needs words is handed a `Translate`, so nothing depends on a global and a
//! test can pass one that echoes the key.

/// A value that fills a `{placeholder}` in a message.
#[derive(Clone, Debug, PartialEq)]
pub enum Var {
    Text(String),
    /// Also picks the plural form when the message has several.
    Number(f64),
}

impl From<&str> for Var {
    fn from(value: &str) -> Self {
        Var::Text(value.to_string())
    }
}

impl From<String> for Var {
    fn from(value: String) -> Self {
        Var::Text(value)
    }
}

impl From<f64> for Var {
    fn from(value: f64) -> Self {
        Var::Number(value)
    }
}

pub trait Translate {
    /// The message for `key` in this translator's language, with `vars` filled in.
    fn t(&self, key: &str, vars: &[(&str, Var)]) -> String;
}

/// Answers every key with the key itself: for tests that only care which
/// message was chosen.
pub struct Keys;

impl Translate for Keys {
    fn t(&self, key: &str, _vars: &[(&str, Var)]) -> String {
        key.to_string()
    }
}
