//! What JavaScript does to a value, where the deck model depends on it.
//!
//! The TypeScript reads decks with `Number(x)`, `String(x)`, `Boolean(x)`,
//! `.trim()` and `\s`, on whatever JSON a file or a request held. A deck file
//! written by the Node companion has to come out the same here, so these are
//! those conversions, done the way the language specifies them.
use serde::Serializer;
use serde_json::Value;

// ------------------------------------------------------------------ strings

/// The characters `\s` matches and `.trim()` removes: JavaScript's WhiteSpace
/// and LineTerminator. Not Rust's `char::is_whitespace`, which counts U+0085
/// and leaves U+FEFF out.
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// `text.trim()`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// `text.slice(0, units)`: the first `units` UTF-16 code units. JavaScript can
/// cut a character outside the basic plane in half and keep the half; a Rust
/// string cannot hold that, so such a character is left out whole.
pub fn slice_utf16(text: &str, units: usize) -> &str {
    let mut used = 0;
    for (at, c) in text.char_indices() {
        used += c.len_utf16();
        if used > units {
            return &text[..at];
        }
    }
    text
}

/// `Boolean(value)`.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(_) => {
            let number = to_number(value);
            number != 0.0 && !number.is_nan()
        }
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `String(value)`.
pub fn to_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(_) => number_to_string(to_number(value)),
        Value::String(text) => text.clone(),
        // Array.prototype.join: null reads as nothing, the rest as String().
        Value::Array(items) => {
            let parts: Vec<String> = items
                .iter()
                .map(|item| {
                    if item.is_null() {
                        String::new()
                    } else {
                        to_string(item)
                    }
                })
                .collect();
            parts.join(",")
        }
        Value::Object(_) => "[object Object]".to_string(),
    }
}

// ------------------------------------------------------------------ numbers

/// `Number(value)`.
pub fn to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => string_to_number(text),
        // An array is read as its text: [] is "", [7] is "7", [1,2] is "1,2".
        Value::Array(_) => string_to_number(&to_string(value)),
        Value::Object(_) => f64::NAN,
    }
}

/// `Number(text)`: blank is 0, then a decimal, hexadecimal, octal or binary
/// literal, or "Infinity"; anything else is NaN.
pub fn string_to_number(text: &str) -> f64 {
    let text = trim(text);
    if text.is_empty() {
        return 0.0;
    }
    for (prefixes, radix) in [(["0x", "0X"], 16u32), (["0o", "0O"], 8), (["0b", "0B"], 2)] {
        for prefix in prefixes {
            if let Some(digits) = text.strip_prefix(prefix) {
                if digits.is_empty() {
                    return f64::NAN;
                }
                let mut total = 0.0;
                for c in digits.chars() {
                    match c.to_digit(radix) {
                        Some(digit) => total = total * f64::from(radix) + f64::from(digit),
                        None => return f64::NAN,
                    }
                }
                return total;
            }
        }
    }
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    if unsigned == "Infinity" {
        return if text.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    if !is_decimal_literal(unsigned) {
        return f64::NAN;
    }
    text.parse::<f64>().unwrap_or(f64::NAN)
}

/// Digits with an optional point and exponent: "12", "1.5", ".5", "5.", "1e-3".
/// Rust's own parser also takes "inf" and "nan", which JavaScript does not.
fn is_decimal_literal(text: &str) -> bool {
    let (mantissa, exponent) = match text.find(['e', 'E']) {
        Some(at) => (&text[..at], Some(&text[at + 1..])),
        None => (text, None),
    };
    let all_digits = |part: &str| part.bytes().all(|b| b.is_ascii_digit());
    let (whole, fraction) = match mantissa.find('.') {
        Some(at) => (&mantissa[..at], &mantissa[at + 1..]),
        None => (mantissa, ""),
    };
    if !all_digits(whole) || !all_digits(fraction) || (whole.is_empty() && fraction.is_empty()) {
        return false;
    }
    match exponent {
        None => true,
        Some(exponent) => {
            let digits = exponent.strip_prefix(['+', '-']).unwrap_or(exponent);
            !digits.is_empty() && all_digits(digits)
        }
    }
}

/// `String(number)`: the shortest digits that read back as the same number,
/// written out plainly between 1e-7 and 1e21 and with an exponent outside.
pub fn number_to_string(number: f64) -> String {
    if number.is_nan() {
        return "NaN".to_string();
    }
    if number == 0.0 {
        return "0".to_string();
    }
    if number.is_infinite() {
        return if number > 0.0 {
            "Infinity"
        } else {
            "-Infinity"
        }
        .to_string();
    }
    let sign = if number < 0.0 { "-" } else { "" };
    // "1.2345e2": Rust's shortest digits, with the exponent apart.
    let scientific = format!("{:e}", number.abs());
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((&scientific, "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let count = digits.len() as i32;
    // The number is 0.digits × 10^point.
    let point = exponent.parse::<i32>().unwrap_or(0) + 1;
    let body = if count <= point && point <= 21 {
        format!("{digits}{}", "0".repeat((point - count) as usize))
    } else if 0 < point && point <= 21 {
        format!(
            "{}.{}",
            &digits[..point as usize],
            &digits[point as usize..]
        )
    } else if -6 < point && point <= 0 {
        format!("0.{}{digits}", "0".repeat((-point) as usize))
    } else {
        let power = point - 1;
        let power_sign = if power < 0 { '-' } else { '+' };
        if count == 1 {
            format!("{digits}e{power_sign}{}", power.abs())
        } else {
            format!(
                "{}.{}e{power_sign}{}",
                &digits[..1],
                &digits[1..],
                power.abs()
            )
        }
    };
    format!("{sign}{body}")
}

/// `Math.max(a, b)`: unlike `f64::max`, NaN wins, and +0 is more than -0.
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_positive() {
            a
        } else {
            b
        }
    } else {
        a.max(b)
    }
}

/// `Math.min(a, b)`: unlike `f64::min`, NaN wins, and -0 is less than +0.
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_negative() {
            a
        } else {
            b
        }
    } else {
        a.min(b)
    }
}

/// The TypeScript's `clamp`: `Math.max(min, Math.min(max, value))`.
pub fn clamp(value: f64, low: f64, high: f64) -> f64 {
    max(low, min(high, value))
}

/// `Math.round(value)`: halves go up (2.5 is 3, -2.5 is -2), where
/// `f64::round` sends them away from zero.
pub fn round(value: f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// Writes a number the way `JSON.stringify` does: a whole number without
/// ".0", and null for Infinity and NaN. For `#[serde(serialize_with)]`.
pub fn serialize_number<S: Serializer>(number: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    let number = *number;
    if !number.is_finite() {
        return serializer.serialize_unit();
    }
    if number.fract() == 0.0 && number.abs() < 1e21 {
        // JavaScript's digits, not the exact value: 2^63 is written
        // 9223372036854776000 there, and has to be here.
        let text = number_to_string(number);
        if let Ok(whole) = text.parse::<u64>() {
            return serializer.serialize_u64(whole);
        }
        if let Ok(whole) = text.parse::<i64>() {
            return serializer.serialize_i64(whole);
        }
    }
    serializer.serialize_f64(number)
}

/// Reads a number written by `serialize_number`. Null (an Infinity that went
/// through JSON) reads as 0, as `Number(null)` does when the TypeScript
/// reads the file back.
pub fn deserialize_number<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<f64, D::Error> {
    let value: Option<f64> = serde::Deserialize::deserialize(deserializer)?;
    Ok(value.unwrap_or(0.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_read_like_javascript() {
        assert_eq!(to_number(&json!(" 12 ")), 12.0);
        assert_eq!(to_number(&json!("0x10")), 16.0);
        assert_eq!(to_number(&json!("")), 0.0);
        assert_eq!(to_number(&json!([])), 0.0);
        assert_eq!(to_number(&json!(["7"])), 7.0);
        assert_eq!(to_number(&json!(true)), 1.0);
        assert!(to_number(&json!("inf")).is_nan());
        assert!(to_number(&json!("nan")).is_nan());
        assert!(to_number(&json!([1, 2])).is_nan());
        assert!(to_number(&json!({})).is_nan());
        assert_eq!(to_number(&json!("-Infinity")), f64::NEG_INFINITY);
    }

    #[test]
    fn numbers_print_like_javascript() {
        for (number, text) in [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.5, "-1.5"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (123456.789, "123456.789"),
            (5e-324, "5e-324"),
            (9223372036854775808.0, "9223372036854776000"),
        ] {
            assert_eq!(number_to_string(number), text);
        }
    }

    #[test]
    fn rounding_sends_halves_up() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(0.49999999999999994), 0.0);
        assert_eq!(round(-0.4), 0.0);
    }

    #[test]
    fn slicing_counts_utf16_units() {
        assert_eq!(slice_utf16("abc", 2), "ab");
        assert_eq!(slice_utf16("a😀b", 3), "a😀");
        assert_eq!(slice_utf16("a😀b", 2), "a");
    }
}
