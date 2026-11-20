//! Crash-safe JSON files.
//!
//! Every write goes to a temporary file that is flushed to disk and then
//! renamed over the original, so a crash or power cut mid-write leaves either
//! the old file or the new one, never half of each. The previous good version
//! is kept as `<name>.bak`, and a file that will not parse is moved aside rather
//! than overwritten.
//!
//! The Node companion wrote these files with `JSON.stringify`, and people go
//! back and forth between the two, so the text written here is what
//! JavaScript would have written, number for number and key for key (see
//! [`stringify`]).

use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

// ------------------------------------------------- numbers, as JavaScript

/// What JavaScript calls white space (`String.prototype.trim`, `\s`).
pub(crate) fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{000B}' | '\u{000C}' | '\r' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `String.prototype.trim`.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// `String(number)`: the shortest digits that read back as the same number,
/// written the way JavaScript writes them ("1", "0.5", "1e+21", "1e-7").
pub fn js_number(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_string();
    }
    if x == 0.0 {
        return "0".to_string();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    let sign = if x < 0.0 { "-" } else { "" };
    let (digits, exponent) = shortest_digits(x.abs());
    let k = digits.len() as i32;
    // The decimal point sits after the n-th digit.
    let n = exponent + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let mantissa = if k == 1 {
            digits.clone()
        } else {
            format!("{}.{}", &digits[..1], &digits[1..])
        };
        format!(
            "{mantissa}e{}{}",
            if e < 0 { "-" } else { "+" },
            e.unsigned_abs()
        )
    };
    format!("{sign}{body}")
}

/// The shortest decimal digits of a positive, finite number and the power of
/// ten of the first one: 1234.5 is ("12345", 3).
pub(crate) fn shortest_digits(x: f64) -> (String, i32) {
    let written = format!("{x:e}");
    let (mantissa, exponent) = written.split_once('e').unwrap_or((written.as_str(), "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    (digits, exponent.parse().unwrap_or(0))
}

/// `Number(text)`: white space trimmed, "" is 0, hex/octal/binary literals,
/// "Infinity", and a decimal literal; anything else is NaN.
pub fn js_to_number(text: &str) -> f64 {
    let text = js_trim(text);
    if text.is_empty() {
        return 0.0;
    }
    for (prefixes, radix) in [(["0x", "0X"], 16), (["0o", "0O"], 8), (["0b", "0B"], 2)] {
        for prefix in prefixes {
            if let Some(rest) = text.strip_prefix(prefix) {
                if rest.is_empty() {
                    return f64::NAN;
                }
                let mut value = 0.0_f64;
                for c in rest.chars() {
                    match c.to_digit(radix) {
                        Some(digit) => value = value * f64::from(radix) + f64::from(digit),
                        None => return f64::NAN,
                    }
                }
                return value;
            }
        }
    }
    let (negative, unsigned) = match text.as_bytes()[0] {
        b'-' => (true, &text[1..]),
        b'+' => (false, &text[1..]),
        _ => (false, text),
    };
    let magnitude = if unsigned == "Infinity" {
        f64::INFINITY
    } else if is_decimal_literal(unsigned) {
        unsigned.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        return f64::NAN;
    };
    if negative {
        -magnitude
    } else {
        magnitude
    }
}

/// Digits with an optional point and exponent: "12", "1.", ".5", "1e3".
fn is_decimal_literal(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut i = 0;
    let mut whole = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
        whole += 1;
    }
    let mut fraction = 0;
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
            fraction += 1;
        }
    }
    if whole + fraction == 0 {
        return false;
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        i += 1;
        if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
            i += 1;
        }
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    i == bytes.len()
}

/// `Number(value)` for a JSON value: null is 0, true is 1, a string is read
/// as a number, an array as its elements joined by commas, an object is NaN.
pub fn js_value_to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => js_to_number(text),
        Value::Array(_) => js_to_number(&js_value_to_string(value)),
        Value::Object(_) => f64::NAN,
    }
}

/// `String(value)` for a JSON value.
pub fn js_value_to_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number_text(number),
        Value::String(text) => text.clone(),
        // Array.prototype.join: null is an empty string.
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_value_to_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

// --------------------------------------------------- JSON, as JavaScript

/// Past this, JavaScript no longer holds every whole number exactly.
const MAX_SAFE_INTEGER: u64 = 1 << 53;

fn number_text(number: &serde_json::Number) -> String {
    if let Some(n) = number.as_u64() {
        if n <= MAX_SAFE_INTEGER {
            return n.to_string();
        }
    } else if let Some(n) = number.as_i64() {
        if n.unsigned_abs() <= MAX_SAFE_INTEGER {
            return n.to_string();
        }
    }
    js_number(number.as_f64().unwrap_or(f64::NAN))
}

/// Whether a key is one JavaScript lists first, in numeric order: a whole
/// number below 2^32 - 1 written without leading zeros.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty()
        || (key.len() > 1 && key.starts_with('0'))
        || !key.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

fn write_value(out: &mut String, value: &Value, indent: Option<usize>, depth: usize) {
    let line = |out: &mut String, depth: usize| {
        if let Some(width) = indent {
            out.push('\n');
            out.push_str(&" ".repeat(width * depth));
        }
    };
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => {
            let text = number_text(number);
            // JSON has no NaN or Infinity; JavaScript writes null.
            out.push_str(if text.ends_with("NaN") || text.ends_with("Infinity") {
                "null"
            } else {
                &text
            });
        }
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                line(out, depth + 1);
                write_value(out, item, indent, depth + 1);
            }
            line(out, depth);
            out.push(']');
        }
        Value::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            // JavaScript lists number-like keys first, in order, then the
            // rest as they were added.
            let mut numeric: Vec<(u32, &String, &Value)> = Vec::new();
            let mut named: Vec<(&String, &Value)> = Vec::new();
            for (key, item) in map {
                match array_index(key) {
                    Some(index) => numeric.push((index, key, item)),
                    None => named.push((key, item)),
                }
            }
            numeric.sort_by_key(|entry| entry.0);
            let entries = numeric
                .into_iter()
                .map(|(_, key, item)| (key, item))
                .chain(named);
            out.push('{');
            for (i, (key, item)) in entries.enumerate() {
                if i > 0 {
                    out.push(',');
                }
                line(out, depth + 1);
                write_string(out, key);
                out.push(':');
                if indent.is_some() {
                    out.push(' ');
                }
                write_value(out, item, indent, depth + 1);
            }
            line(out, depth);
            out.push('}');
        }
    }
}

fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c < ' ' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `JSON.stringify(value)`: one line, numbers and key order as JavaScript
/// writes them (1 and not 1.0, number-like keys first).
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value, None, 0);
    out
}

/// `JSON.stringify(value, null, 2)`.
pub fn stringify_pretty(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value, Some(2), 0);
    out
}

// ------------------------------------------------------------- the files

fn with_suffix(file: &Path, suffix: &str) -> PathBuf {
    let mut name: OsString = file.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// The backup kept beside a file: `<file>.bak`.
pub fn backup_of(file: &Path) -> PathBuf {
    with_suffix(file, ".bak")
}

fn remove_quietly(file: &Path) {
    let _ = fs::remove_file(file);
}

/// Writes `data` as JSON (two spaces, a final newline), replacing `file` in
/// one step. With `backup`, the file being replaced is first kept as
/// `<file>.bak`.
pub fn write_json_atomic<T: Serialize + ?Sized>(
    file: &Path,
    data: &T,
    backup: bool,
) -> io::Result<()> {
    let value = serde_json::to_value(data)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let text = stringify_pretty(&value) + "\n";
    if let Some(dir) = file.parent() {
        if !dir.as_os_str().is_empty() {
            fs::create_dir_all(dir)?;
        }
    }
    let temp = with_suffix(file, &format!(".tmp-{}", std::process::id()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let written = (|| -> io::Result<()> {
        {
            let mut handle = options.open(&temp)?;
            handle.write_all(text.as_bytes())?;
            handle.sync_all()?;
        }
        if backup && file.exists() {
            fs::copy(file, backup_of(file))?;
        }
        fs::rename(&temp, file)
    })();
    if written.is_err() {
        // A full disk or a locked folder: leave no half-written temp file behind.
        remove_quietly(&temp);
    }
    written
}

/// What [`read_json_safe`] found.
#[derive(Debug, Clone, PartialEq)]
pub enum ReadResult {
    /// Neither the file nor its backup exists.
    Missing,
    File(Value),
    /// The file was damaged and has been moved to `aside`; this is the backup.
    Backup {
        data: Value,
        aside: PathBuf,
    },
}

impl ReadResult {
    /// The data, or nothing when there was no file.
    pub fn data(self) -> Option<Value> {
        match self {
            ReadResult::Missing => None,
            ReadResult::File(data) | ReadResult::Backup { data, .. } => Some(data),
        }
    }

    /// "missing", "file" or "backup", as the TypeScript named them.
    pub fn source(&self) -> &'static str {
        match self {
            ReadResult::Missing => "missing",
            ReadResult::File(_) => "file",
            ReadResult::Backup { .. } => "backup",
        }
    }
}

/// An unreadable file and its backup; the damaged file has been moved to `aside`.
#[derive(Debug, Clone, PartialEq)]
pub struct UnreadableFileError {
    pub message: String,
    pub aside: PathBuf,
}

impl fmt::Display for UnreadableFileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for UnreadableFileError {}

/// Why [`read_json_safe`] gave nothing.
#[derive(Debug)]
pub enum ReadError {
    /// Neither the file nor its backup could be used.
    Unreadable(UnreadableFileError),
    /// The damaged file could not even be moved aside.
    Io(io::Error),
}

impl fmt::Display for ReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ReadError::Unreadable(error) => error.fmt(f),
            ReadError::Io(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for ReadError {}

fn base_name(file: &Path) -> String {
    file.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn attempt(candidate: &Path, is_valid: &dyn Fn(&Value) -> bool) -> Result<Value, String> {
    let bytes = fs::read(candidate).map_err(|error| match error.kind() {
        // Worded as Node worded it, since it ends up in the log line.
        io::ErrorKind::NotFound => format!(
            "ENOENT: no such file or directory, open '{}'",
            candidate.display()
        ),
        io::ErrorKind::PermissionDenied => {
            format!("EACCES: permission denied, open '{}'", candidate.display())
        }
        _ => error.to_string(),
    })?;
    let data: Value = serde_json::from_str(&String::from_utf8_lossy(&bytes))
        .map_err(|error| error.to_string())?;
    if !is_valid(&data) {
        return Err("unexpected shape".to_string());
    }
    Ok(data)
}

/// Reads a JSON file, falling back to its backup. Fails only if neither can be
/// used, after moving the damaged file aside so nothing later overwrites it.
pub fn read_json_safe(
    file: &Path,
    is_valid: impl Fn(&Value) -> bool,
) -> Result<ReadResult, ReadError> {
    let backup = backup_of(file);
    if !file.exists() && !backup.exists() {
        return Ok(ReadResult::Missing);
    }
    let reason = match attempt(file, &is_valid) {
        Ok(data) => return Ok(ReadResult::File(data)),
        Err(reason) => reason,
    };
    let aside = with_suffix(
        file,
        &format!(".corrupt-{}", iso_now().replace([':', '.'], "-")),
    );
    if file.exists() {
        fs::rename(file, &aside).map_err(ReadError::Io)?;
    }
    match attempt(&backup, &is_valid) {
        Ok(data) => Ok(ReadResult::Backup { data, aside }),
        Err(_) => Err(ReadError::Unreadable(UnreadableFileError {
            message: format!(
                "{} could not be read ({reason}). It was kept as {}.",
                base_name(file),
                base_name(&aside)
            ),
            aside,
        })),
    }
}

/// `Array.prototype.sort` on names: by UTF-16 code units.
fn js_order(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// One snapshot per day in `<dir>/backups`, keeping the newest `keep`, so a bad
/// edit or restore can always be walked back a few days. The TypeScript
/// default for `keep` is [`SNAPSHOTS_KEPT`].
pub fn snapshot_daily(file: &Path, keep: usize) -> io::Result<()> {
    if !file.exists() {
        return Ok(());
    }
    let dir = file.parent().unwrap_or(Path::new("")).join("backups");
    let stamp = &iso_now()[..10];
    let name = base_name(file);
    // path.basename(file, ".json"): the ending goes unless it is the whole name.
    let stem = match name.strip_suffix(".json") {
        Some(stem) if !stem.is_empty() => stem,
        _ => name.as_str(),
    };
    let target = dir.join(format!("{stem}-{stamp}.json"));
    if target.exists() {
        return Ok(());
    }
    fs::create_dir_all(&dir)?;
    fs::copy(file, &target)?;
    let mut names: Vec<String> = Vec::new();
    for entry in fs::read_dir(&dir)? {
        let name = entry?.file_name().to_string_lossy().into_owned();
        if name.ends_with(".json") {
            names.push(name);
        }
    }
    names.sort_by(|a, b| js_order(b, a));
    for old in names.iter().skip(keep) {
        fs::remove_file(dir.join(old))?;
    }
    Ok(())
}

/// How many daily snapshots [`snapshot_daily`] keeps unless told otherwise.
pub const SNAPSHOTS_KEPT: usize = 14;

/// A JSON object: not an array, not null.
pub fn is_object(value: &Value) -> bool {
    value.is_object()
}

// ------------------------------------------------------------------ time

/// `new Date().toISOString()`: "2026-11-20T12:34:56.789Z".
pub(crate) fn iso_now() -> String {
    let since = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    iso_from_millis(since.as_millis() as i64)
}

/// `new Date(ms).toISOString()` for a time after 1970.
pub(crate) fn iso_from_millis(millis: i64) -> String {
    let days = millis.div_euclid(86_400_000);
    let rest = millis.rem_euclid(86_400_000);
    // Days since 1970-01-01 to a calendar date (Howard Hinnant's civil_from_days).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1_000 % 60,
        rest % 1_000
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(name: &str) -> Vec<Value> {
        let file = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/base")
            .join(name);
        let text =
            fs::read_to_string(&file).unwrap_or_else(|error| panic!("{}: {error}", file.display()));
        serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", file.display()))
    }

    /// Numbers travel as their 64 bits in hex, so NaN, -0 and every last
    /// digit arrive as they left.
    fn number_of(value: &Value) -> f64 {
        f64::from_bits(u64::from_str_radix(value.as_str().expect("bits"), 16).expect("hex"))
    }

    fn same(a: f64, b: f64) -> bool {
        (a.is_nan() && b.is_nan()) || a.to_bits() == b.to_bits()
    }

    #[test]
    fn numbers_are_written_as_javascript_writes_them() {
        let cases = fixture("js-number-to-string.json");
        assert!(cases.len() > 100);
        for case in cases {
            let input = number_of(&case["input"]);
            assert_eq!(
                js_number(input),
                case["output"].as_str().unwrap(),
                "String({input:e})"
            );
        }
    }

    #[test]
    fn text_is_read_as_a_number_as_javascript_reads_it() {
        let cases = fixture("js-string-to-number.json");
        assert!(cases.len() > 50);
        for case in cases {
            let input = case["input"].as_str().unwrap();
            let expected = number_of(&case["output"]);
            let got = js_to_number(input);
            assert!(
                same(got, expected),
                "Number({input:?}) is {got}, expected {expected}"
            );
        }
    }

    #[test]
    fn values_are_read_as_numbers_as_javascript_reads_them() {
        let cases = fixture("js-value-to-number.json");
        assert!(cases.len() > 20);
        for case in cases {
            let expected = number_of(&case["output"]);
            let got = js_value_to_number(&case["input"]);
            assert!(
                same(got, expected),
                "Number({}) is {got}, expected {expected}",
                case["input"]
            );
        }
    }

    #[test]
    fn json_text_matches_json_stringify() {
        let cases = fixture("stringify.json");
        assert!(cases.len() > 40);
        for case in cases {
            // The input is JSON text, so that key order and number spelling
            // reach both sides as written.
            let value: Value = serde_json::from_str(case["input"].as_str().unwrap()).unwrap();
            assert_eq!(
                stringify(&value),
                case["output"]["compact"].as_str().unwrap(),
                "{}",
                case["input"]
            );
            assert_eq!(
                stringify_pretty(&value),
                case["output"]["pretty"].as_str().unwrap(),
                "{}",
                case["input"]
            );
        }
    }

    #[test]
    fn files_are_written_byte_for_byte_as_typescript_writes_them() {
        let cases = fixture("written-files.json");
        assert!(cases.len() > 20);
        let dir = tempfile::tempdir().unwrap();
        for (i, case) in cases.iter().enumerate() {
            let value: Value = serde_json::from_str(case["input"].as_str().unwrap()).unwrap();
            let file = dir.path().join(format!("deep/er/file-{i}.json"));
            write_json_atomic(&file, &value, true).unwrap();
            assert_eq!(
                fs::read_to_string(&file).unwrap(),
                case["output"].as_str().unwrap(),
                "{}",
                case["input"]
            );
            // And what TypeScript wrote is read back as the same data.
            let theirs = dir.path().join(format!("theirs-{i}.json"));
            fs::write(&theirs, case["output"].as_str().unwrap()).unwrap();
            let read = read_json_safe(&theirs, |_| true).unwrap();
            assert_eq!(read.source(), "file");
            assert_eq!(stringify(&read.data().unwrap()), stringify(&value));
        }
    }

    #[test]
    fn a_write_keeps_the_previous_version_as_bak() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.json");
        write_json_atomic(&file, &json!({ "a": 1 }), true).unwrap();
        assert!(
            !backup_of(&file).exists(),
            "nothing to back up the first time"
        );
        write_json_atomic(&file, &json!({ "a": 2 }), true).unwrap();
        assert_eq!(
            fs::read_to_string(backup_of(&file)).unwrap(),
            "{\n  \"a\": 1\n}\n"
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "{\n  \"a\": 2\n}\n");
        write_json_atomic(&file, &json!({ "a": 3 }), false).unwrap();
        assert_eq!(
            fs::read_to_string(backup_of(&file)).unwrap(),
            "{\n  \"a\": 1\n}\n",
            "no backup when asked not to"
        );
        let names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            !names.iter().any(|name| name.contains(".tmp-")),
            "{names:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_new_file_is_private_to_its_owner() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("devices.json");
        write_json_atomic(&file, &json!({}), true).unwrap();
        assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o077, 0);
    }

    // tests/library.test.mjs: "A write that cannot be renamed into place
    // throws and removes its temp file".
    #[test]
    fn a_failed_write_leaves_no_temp_file_behind() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("taken");
        fs::create_dir_all(target.join("inside")).unwrap();
        assert!(write_json_atomic(&target, &json!({ "a": 1 }), false).is_err());
        let names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["taken"]);
    }

    #[test]
    fn a_missing_file_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let read = read_json_safe(&dir.path().join("nothing.json"), is_object).unwrap();
        assert_eq!(read, ReadResult::Missing);
        assert_eq!(read.source(), "missing");
        assert_eq!(read.data(), None);
    }

    fn corrupt_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".corrupt-"))
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_damaged_file_is_moved_aside_and_the_backup_used() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("library.json");
        fs::write(&file, "garbage").unwrap();
        fs::write(backup_of(&file), "{\"mine\":true}").unwrap();
        let read = read_json_safe(&file, is_object).unwrap();
        let ReadResult::Backup { data, aside } = read else {
            panic!("expected the backup")
        };
        assert_eq!(data, json!({ "mine": true }));
        assert_eq!(fs::read_to_string(&aside).unwrap(), "garbage");
        assert!(!file.exists());
        let names = corrupt_names(dir.path());
        assert_eq!(names.len(), 1);
        // library.json.corrupt-2026-11-20T12-34-56-789Z
        let stamp = names[0].strip_prefix("library.json.corrupt-").unwrap();
        assert_eq!(stamp.len(), 24, "{stamp}");
        assert!(
            stamp.ends_with('Z') && !stamp.contains(':') && !stamp.contains('.'),
            "{stamp}"
        );
        assert_eq!(stamp.as_bytes()[10], b'T');
    }

    #[test]
    fn a_damaged_file_without_a_backup_is_an_error_that_says_where_it_went() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("library.json");
        fs::write(&file, "{ this is not json").unwrap();
        let Err(ReadError::Unreadable(error)) = read_json_safe(&file, is_object) else {
            panic!("expected an error")
        };
        assert_eq!(
            fs::read_to_string(&error.aside).unwrap(),
            "{ this is not json"
        );
        let aside = error
            .aside
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(
            error
                .message
                .starts_with("library.json could not be read ("),
            "{}",
            error.message
        );
        assert!(
            error
                .message
                .ends_with(&format!("). It was kept as {aside}.")),
            "{}",
            error.message
        );
    }

    #[test]
    fn a_file_of_the_wrong_shape_counts_as_damaged() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.json");
        fs::write(&file, "[1,2]").unwrap();
        let Err(ReadError::Unreadable(error)) = read_json_safe(&file, is_object) else {
            panic!("expected an error")
        };
        assert!(
            error.message.contains("(unexpected shape)"),
            "{}",
            error.message
        );
    }

    #[test]
    fn only_a_backup_is_read_without_anything_moved() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.json");
        fs::write(backup_of(&file), "{\"port\":9000}").unwrap();
        let read = read_json_safe(&file, is_object).unwrap();
        assert_eq!(read.source(), "backup");
        assert_eq!(read.data().unwrap(), json!({ "port": 9000 }));
        assert!(corrupt_names(dir.path()).is_empty());
    }

    #[test]
    fn one_snapshot_a_day_and_only_the_newest_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("library.json");
        snapshot_daily(&file, SNAPSHOTS_KEPT).unwrap();
        assert!(
            !dir.path().join("backups").exists(),
            "nothing to snapshot yet"
        );
        fs::write(&file, "{}").unwrap();
        let backups = dir.path().join("backups");
        fs::create_dir_all(&backups).unwrap();
        for day in 1..=5 {
            fs::write(backups.join(format!("library-2020-01-0{day}.json")), "{}").unwrap();
        }
        fs::write(backups.join("notes.txt"), "kept").unwrap();
        snapshot_daily(&file, 3).unwrap();
        let today = format!("library-{}.json", &iso_now()[..10]);
        let mut names: Vec<String> = fs::read_dir(&backups)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(
            names,
            [
                "library-2020-01-04.json",
                "library-2020-01-05.json",
                today.as_str(),
                "notes.txt"
            ]
        );
        // A second call the same day changes nothing.
        fs::write(&file, "{\"later\":true}").unwrap();
        snapshot_daily(&file, 3).unwrap();
        assert_eq!(fs::read_to_string(backups.join(&today)).unwrap(), "{}");
    }

    #[test]
    fn dates_are_written_as_to_iso_string_writes_them() {
        for case in fixture("iso-dates.json") {
            assert_eq!(
                iso_from_millis(case["input"].as_i64().unwrap()),
                case["output"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn is_object_is_true_for_objects_only() {
        assert!(is_object(&json!({})));
        for other in [json!([]), json!(null), json!("x"), json!(1), json!(true)] {
            assert!(!is_object(&other));
        }
    }
}
