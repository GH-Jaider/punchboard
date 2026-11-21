//! Links people type, turned into addresses browsers open. "twitch.tv/x" and
//! "192.168.1.7:8787" are fine; https:// is added when it is missing (http://
//! for an address on the home network). Only http and https ever come out, so
//! a link can never run anything else.
//! (src/shared/links.ts)
use url::Url;

use super::js;

/// Schemes whose addresses are digits ("tel:123"), which would otherwise read as a host and a port.
const NUMBER_SCHEMES: [&str; 9] = [
    "tel",
    "sms",
    "mms",
    "fax",
    "callto",
    "facetime",
    "facetime-audio",
    "sip",
    "sips",
];

/// How many bytes of `text` are a scheme name: a letter, then letters,
/// digits, "+", "." and "-". Zero when it does not start with one.
fn scheme_length(text: &str) -> usize {
    if !text.starts_with(|c: char| c.is_ascii_alphabetic()) {
        return 0;
    }
    text.bytes()
        .take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'.' | b'-'))
        .count()
}

/// Whether what follows the colon is a port: one to five digits, then
/// nothing or a path, a query or a fragment.
fn is_port(rest: &str) -> bool {
    let digits = rest.bytes().take_while(|b| b.is_ascii_digit()).count();
    (1..=5).contains(&digits)
        && matches!(rest.as_bytes().get(digits), None | Some(b'/' | b'?' | b'#'))
}

/// The address to open for a typed link, or None when it is not a web address.
pub fn web_address(value: Option<&str>) -> Option<String> {
    let text = js::trim(value.unwrap_or(""));
    if text.is_empty() || text.chars().any(js::is_space) {
        return None;
    }
    let scheme = scheme_length(text);
    let has_scheme = scheme > 0 && text[scheme..].starts_with("://");
    // Another scheme (file://, ftp://) is refused outright, not rewritten.
    if has_scheme
        && !["http", "https"]
            .iter()
            .any(|web| text[..scheme].eq_ignore_ascii_case(web))
    {
        return None;
    }
    // "mailto:a@b.com" and "javascript:…" have no // either. Only a host and
    // a port ("nas.local:8080", "localhost:8787/x") may look like that.
    if !has_scheme && scheme > 0 && text[scheme..].starts_with(':') {
        let name = text[..scheme].to_ascii_lowercase();
        if !is_port(&text[scheme + 1..]) || NUMBER_SCHEMES.contains(&name.as_str()) {
            return None;
        }
    }
    let mut url = if has_scheme {
        Url::parse(text)
    } else {
        Url::parse(&format!("https://{text}"))
    }
    .ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    // A host is the least a link needs; "https://" alone parses but goes nowhere.
    let hostname = url.host_str().unwrap_or("").to_string();
    if hostname.is_empty() {
        return None;
    }
    // Nothing on a home network speaks https: a bare LAN address gets http.
    if !has_scheme && is_local_host(&hostname) {
        // Between http and https this cannot fail.
        url.set_scheme("http").ok()?;
    }
    // Node writes "^" in a path as %5E, as the URL standard now says; the url
    // crate still leaves it. Nothing else in the path is read differently.
    if url.path().contains('^') {
        let path = url.path().replace('^', "%5E");
        url.set_path(&path);
    }
    Some(url.as_str().to_string())
}

/// localhost, a name ending in .local, a single-label name ("nas"), or an IP address.
fn is_local_host(hostname: &str) -> bool {
    !hostname.contains('.')
        || hostname.to_ascii_lowercase().ends_with(".local")
        || is_dotted_quad(hostname)
        || hostname.starts_with('[')
}

/// Four groups of one to three digits.
fn is_dotted_quad(hostname: &str) -> bool {
    let groups: Vec<&str> = hostname.split('.').collect();
    groups.len() == 4
        && groups.iter().all(|group| {
            (1..=3).contains(&group.len()) && group.bytes().all(|b| b.is_ascii_digit())
        })
}

/// Where the Ko-fi cup and the one-time note lead.
pub const SUPPORT_URL: &str = "https://ko-fi.com/hit_here";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::testing::cases;

    #[test]
    fn web_address_matches_the_typescript() {
        let all = cases("links-webAddress.json");
        assert!(all.len() >= 300, "{} cases", all.len());
        let mut different = Vec::new();
        for case in &all {
            let ours = serde_json::json!(web_address(case["input"].as_str()));
            if ours != case["output"] {
                different.push(format!(
                    "webAddress({})\n   rust: {ours}\n   node: {}",
                    case["input"], case["output"]
                ));
            }
        }
        assert!(
            different.is_empty(),
            "{} links differ:\n{}",
            different.len(),
            different.join("\n")
        );
        assert_eq!(
            cases("links-constants.json")[0]["output"]["SUPPORT_URL"],
            SUPPORT_URL
        );
    }

    /// The links of tests/library.test.mjs.
    #[test]
    fn links_people_type() {
        for (typed, expected) in [
            ("twitch.tv/x", Some("https://twitch.tv/x")),
            ("https://example.com/a", Some("https://example.com/a")),
            ("192.168.1.5:8080", Some("http://192.168.1.5:8080/")),
            ("nas.local:8080", Some("http://nas.local:8080/")),
            ("localhost:8787/deck", Some("http://localhost:8787/deck")),
            ("nas", Some("http://nas/")),
            ("nas:5000", Some("http://nas:5000/")),
            ("mailto:a@b.com", None),
            ("tel:123", None),
            ("javascript:alert(1)", None),
            ("file:///etc/passwd", None),
            ("ftp://x.com", None),
            ("data:text/html,hi", None),
            ("", None),
        ] {
            assert_eq!(
                web_address(Some(typed)).as_deref(),
                expected,
                "Link \"{typed}\""
            );
        }
    }
}
