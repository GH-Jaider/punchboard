//! Icon markup for a button: an uploaded image, a Google glyph, or a built-in
//! icon. Everything here returns HTML strings built only from validated parts.
//! (src/shared/icons.ts)
use serde_json::Value;

use super::js;
use super::types::{Button, Glyph, GlyphSource, GlyphStyle};

pub use super::icon_data::{IconGroup, DEFAULT_ICON, ICONS, ICON_GROUPS};

const IMAGE_TYPES: [&str; 4] = ["png", "jpeg", "webp", "svg+xml"];

/// A data: URI of a png, jpeg, webp or svg image in base64, and nothing else.
pub fn is_safe_icon_data(value: &str) -> bool {
    // The TypeScript's pattern ignores case, for ASCII letters only.
    let lowered = value.to_ascii_lowercase();
    let Some(rest) = lowered.strip_prefix("data:image/") else {
        return false;
    };
    let Some((kind, data)) = rest.split_once(";base64,") else {
        return false;
    };
    IMAGE_TYPES.contains(&kind)
        && !data.is_empty()
        && data
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
}

/// `is_safe_icon_data` on anything a deck file held.
pub fn is_safe_icon_data_value(value: &Value) -> bool {
    value.as_str().is_some_and(is_safe_icon_data)
}

fn icon_body(id: &str) -> Option<&'static str> {
    ICONS.iter().find(|icon| icon.0 == id).map(|icon| icon.1)
}

/// Whether a value names one of the built-in icons. Own properties only in
/// the TypeScript, so "constructor" or "__proto__" never reach the markup.
pub fn is_icon_id(value: &str) -> bool {
    icon_body(value).is_some()
}

/// `is_icon_id` on anything a deck file held.
pub fn is_icon_id_value(value: &Value) -> bool {
    value.as_str().is_some_and(is_icon_id)
}

pub fn icon_svg(id: &str) -> String {
    let glyph = icon_body(id)
        .or_else(|| icon_body(DEFAULT_ICON))
        .unwrap_or("");
    format!(
        r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">{glyph}</svg>"#
    )
}

// Google glyphs arrive from Google and from backup files alike, so only a
// viewBox of four numbers and path data made of path commands are accepted.

/// Four numbers apart by one space; only the first two may be negative.
fn is_glyph_view_box(text: &str) -> bool {
    let parts: Vec<&str> = text.split(' ').collect();
    parts.len() == 4
        && parts.iter().enumerate().all(|(at, part)| {
            let digits = if at < 2 {
                part.strip_prefix('-').unwrap_or(part)
            } else {
                part
            };
            !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit() || b == b'.')
        })
}

/// Path commands, digits and their punctuation: 1 to 20000 characters.
fn is_glyph_path(text: &str) -> bool {
    (1..=20000).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || b"MmLlHhVvCcSsQqTtAaZz ,.-eE".contains(&b))
}

fn glyph_style(value: Option<&Value>) -> GlyphStyle {
    match value.and_then(Value::as_str) {
        Some("rounded") => GlyphStyle::Rounded,
        Some("sharp") => GlyphStyle::Sharp,
        _ => GlyphStyle::Outlined,
    }
}

/// The glyph in `value`, cleaned, or None when it is not one that is safe to draw.
pub fn safe_glyph(value: &Value) -> Option<Glyph> {
    // An array is an object to JavaScript, but has no viewBox.
    let glyph = value.as_object()?;
    let view_box = glyph.get("viewBox")?.as_str()?;
    if !is_glyph_view_box(view_box) {
        return None;
    }
    let paths = glyph.get("paths")?.as_array()?;
    if paths.is_empty() || paths.len() > 8 {
        return None;
    }
    let paths: Vec<String> = paths
        .iter()
        .map(|path| {
            path.as_str()
                .filter(|path| is_glyph_path(path))
                .map(str::to_string)
        })
        .collect::<Option<_>>()?;
    let name = match glyph.get("name") {
        None | Some(Value::Null) => String::new(),
        Some(name) => js::to_string(name),
    };
    let name: String = name
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_')
        .take(64)
        .collect();
    Some(Glyph {
        source: GlyphSource::Google,
        name,
        style: glyph_style(glyph.get("style")),
        fill: glyph.get("fill").is_some_and(js::truthy),
        view_box: view_box.to_string(),
        paths,
    })
}

pub fn glyph_svg(glyph: &Glyph) -> String {
    let paths: String = glyph
        .paths
        .iter()
        .map(|path| format!(r#"<path d="{path}"/>"#))
        .collect();
    format!(
        r#"<svg viewBox="{}" fill="currentColor" aria-hidden="true" focusable="false">{paths}</svg>"#,
        glyph.view_box
    )
}

/// A button's icon: its picture, else its glyph, else its built-in icon.
/// Each is checked again here, whatever the button went through before.
pub fn icon_markup(button: &Button) -> String {
    if let Some(data) = button
        .icon_data
        .as_deref()
        .filter(|data| is_safe_icon_data(data))
    {
        return format!(r#"<img src="{data}" alt="">"#);
    }
    let glyph = button
        .glyph
        .as_ref()
        .and_then(|glyph| serde_json::to_value(glyph).ok())
        .and_then(|glyph| safe_glyph(&glyph));
    if let Some(glyph) = glyph {
        return glyph_svg(&glyph);
    }
    icon_svg(&button.icon)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::testing::{cases, same};
    use serde_json::json;

    #[test]
    fn safe_glyph_matches_the_typescript() {
        let all = cases("icons-safeGlyph.json");
        assert!(all.len() >= 300, "{} cases", all.len());
        for case in &all {
            let glyph = safe_glyph(&case["input"]);
            same(
                &format!("safeGlyph({})", brief(&case["input"])),
                &glyph,
                &case["output"]["glyph"],
            );
            same(
                "glyphSvg",
                &glyph.as_ref().map(glyph_svg),
                &case["output"]["svg"],
            );
        }
    }

    #[test]
    fn icon_checks_match_the_typescript() {
        let all = cases("icons-ids.json");
        assert!(all.len() >= 100, "{} cases", all.len());
        for case in &all {
            let input = &case["input"];
            let output = &case["output"];
            same(
                &format!("isIconId({})", brief(input)),
                &is_icon_id_value(input),
                &output["isIconId"],
            );
            same(
                &format!("isSafeIconData({})", brief(input)),
                &is_safe_icon_data_value(input),
                &output["isSafeIconData"],
            );
            if let Some(id) = input.as_str() {
                same(
                    &format!("iconSvg({})", brief(input)),
                    &icon_svg(id),
                    &output["iconSvg"],
                );
            }
        }
    }

    #[test]
    fn tables_match_the_typescript() {
        let output = &cases("icons-tables.json")[0]["output"];
        assert_eq!(output["DEFAULT_ICON"], DEFAULT_ICON);
        let icons: Vec<serde_json::Value> =
            ICONS.iter().map(|icon| json!([icon.0, icon.1])).collect();
        assert_eq!(output["ICONS"], json!(icons));
        let groups: Vec<serde_json::Value> = ICON_GROUPS
            .iter()
            .map(|group| json!({ "name": group.name, "ids": group.ids }))
            .collect();
        assert_eq!(output["ICON_GROUPS"], json!(groups));
    }

    #[test]
    fn icon_markup_matches_the_typescript() {
        let all = cases("icons-iconMarkup.json");
        assert!(all.len() >= 100, "{} cases", all.len());
        for case in &all {
            let button: Button = serde_json::from_value(case["input"].clone()).expect("a button");
            same(
                &format!("iconMarkup({})", brief(&case["input"])),
                &icon_markup(&button),
                &case["output"],
            );
        }
    }

    fn brief(value: &serde_json::Value) -> String {
        value.to_string().chars().take(200).collect()
    }

    // ---- the assertions of tests/library.test.mjs that touch this file

    #[test]
    fn icon_svg_ignores_inherited_names() {
        assert_eq!(icon_svg("constructor"), icon_svg("radio"));
        assert_eq!(icon_svg("toString"), icon_svg("radio"));
    }

    #[test]
    fn glyph_names_are_lowercased_not_stripped() {
        let glyph = safe_glyph(
            &json!({ "name": "Mic_Off", "viewBox": "0 0 24 24", "paths": ["M0 0L1 1"] }),
        );
        assert_eq!(glyph.map(|glyph| glyph.name).as_deref(), Some("mic_off"));
    }
}
