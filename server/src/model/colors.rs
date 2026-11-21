//! Colour maths in plain hex, so old tablets need no oklch() or color-mix():
//! anything derived from a colour is computed here and handed to CSS.
//! (src/shared/colors.ts)
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::js;
use super::types::{ButtonColor, ButtonColorId};
use crate::translate::Translate;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

fn clamp255(value: f64) -> f64 {
    js::max(0.0, js::min(255.0, js::round(value)))
}

/// "#abc", "abc", "#aabbcc" or "aabbcc", with spaces around; None for anything else.
pub fn parse_hex(hex: Option<&str>) -> Option<Rgb> {
    let trimmed = js::trim(hex.unwrap_or(""));
    let mut value = trimmed.strip_prefix('#').unwrap_or(trimmed).to_string();
    if value.len() == 3 && value.is_ascii() {
        value = value.chars().flat_map(|digit| [digit, digit]).collect();
    }
    if value.len() != 6 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let channel = |at: usize| u8::from_str_radix(&value[at..at + 2], 16).ok();
    Some(Rgb {
        r: channel(0)?,
        g: channel(2)?,
        b: channel(4)?,
    })
}

/// Exactly "#" and six hex digits.
pub fn is_hex_color(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// `is_hex_color` on anything a file or a request held.
pub fn is_hex_color_value(value: &Value) -> bool {
    value.as_str().is_some_and(is_hex_color)
}

const FALLBACK: Rgb = Rgb {
    r: 95,
    g: 208,
    b: 214,
};
const BLACK: Rgb = Rgb { r: 0, g: 0, b: 0 };

pub fn with_alpha(hex: &str, alpha: f64) -> String {
    let rgb = parse_hex(Some(hex)).unwrap_or(FALLBACK);
    format!(
        "rgba({},{},{},{})",
        rgb.r,
        rgb.g,
        rgb.b,
        js::number_to_string(alpha)
    )
}

pub fn mix_hex(hex: &str, toward_hex: &str, amount: f64) -> String {
    let a = parse_hex(Some(hex)).unwrap_or(BLACK);
    let b = parse_hex(Some(toward_hex)).unwrap_or(BLACK);
    let mix = |from: u8, to: u8| {
        let (from, to) = (f64::from(from), f64::from(to));
        js::number_to_string(clamp255(from + (to - from) * amount))
    };
    format!("rgb({},{},{})", mix(a.r, b.r), mix(a.g, b.g), mix(a.b, b.b))
}

/// WCAG relative luminance, so text on a user-chosen colour stays readable.
fn relative_luminance(hex: &str) -> f64 {
    let rgb = parse_hex(Some(hex)).unwrap_or(FALLBACK);
    let channel = |value: u8| {
        let c = f64::from(value) / 255.0;
        if c <= 0.03928 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
}

pub const DARK_INK: &str = "#08100f";
pub const LIGHT_INK: &str = "#ffffff";

/// WCAG contrast ratio between two colours, 1 to 21.
pub fn contrast_ratio(a: &str, b: &str) -> f64 {
    let la = relative_luminance(a);
    let lb = relative_luminance(b);
    (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
}

/// The ink, dark or white, with the higher contrast on this colour. A fixed
/// luminance cut-off gave white ink on mid-tones (blue, red, orange) at under
/// 3:1, where dark ink reads at 6:1 and more.
pub fn readable_ink(hex: &str) -> &'static str {
    if contrast_ratio(hex, DARK_INK) >= contrast_ratio(hex, LIGHT_INK) {
        DARK_INK
    } else {
        LIGHT_INK
    }
}

/// So dark it all but vanishes on a dark theme.
pub fn is_very_dark(hex: &str) -> bool {
    relative_luminance(hex) < 0.03
}

/// A preset colour. Its name is read in the reader's language: `color_label`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ColorPreset {
    pub id: ButtonColorId,
    /// The id as stored ("accent").
    pub name: &'static str,
    pub value: &'static str,
}

const fn preset(id: ButtonColorId, name: &'static str, value: &'static str) -> ColorPreset {
    ColorPreset { id, name, value }
}

pub const BUTTON_COLORS: [ColorPreset; 16] = [
    preset(ButtonColorId::Accent, "accent", "#5fd0d6"),
    preset(ButtonColorId::Blue, "blue", "#69a9ff"),
    preset(ButtonColorId::Indigo, "indigo", "#8095ff"),
    preset(ButtonColorId::Violet, "violet", "#b18cd9"),
    preset(ButtonColorId::Pink, "pink", "#e982bd"),
    preset(ButtonColorId::Rose, "rose", "#e8778c"),
    preset(ButtonColorId::Red, "red", "#f06d6d"),
    preset(ButtonColorId::Orange, "orange", "#ed9a55"),
    preset(ButtonColorId::Amber, "amber", "#e0b95c"),
    preset(ButtonColorId::Yellow, "yellow", "#f2d85b"),
    preset(ButtonColorId::Lime, "lime", "#9ed36a"),
    preset(ButtonColorId::Green, "green", "#56c596"),
    preset(ButtonColorId::Mint, "mint", "#63d6b6"),
    preset(ButtonColorId::Cyan, "cyan", "#38c7e8"),
    preset(ButtonColorId::Slate, "slate", "#93a2ad"),
    preset(ButtonColorId::White, "white", "#eaf1f8"),
];

/// A preset's name, in the reader's language.
pub fn color_label(id: ButtonColorId, t: &dyn Translate) -> String {
    let name = BUTTON_COLORS
        .iter()
        .find(|color| color.id == id)
        .map_or("accent", |color| color.name);
    t.t(&format!("shared.color.{name}"), &[])
}

/// The preset a stored name is, if it is one.
pub fn button_color_id(value: &str) -> Option<ButtonColorId> {
    BUTTON_COLORS
        .iter()
        .find(|color| color.name == value)
        .map(|color| color.id)
}

pub fn is_button_color_id(value: &Value) -> bool {
    value.as_str().and_then(button_color_id).is_some()
}

/// A preset's id or a custom #rrggbb, read from anything; None when it is neither.
pub fn button_color(value: &Value) -> Option<ButtonColor> {
    let text = value.as_str()?;
    match button_color_id(text) {
        Some(id) => Some(ButtonColor::Preset(id)),
        None if is_hex_color(text) => Some(ButtonColor::Hex(text.to_string())),
        None => None,
    }
}

/// A preset's id or a custom #rrggbb.
pub fn is_button_color(value: &Value) -> bool {
    button_color(value).is_some()
}

pub fn color_value(color: &ButtonColor) -> String {
    match color {
        ButtonColor::Hex(hex) if is_hex_color(hex) => hex.to_lowercase(),
        ButtonColor::Preset(id) => BUTTON_COLORS
            .iter()
            .find(|preset| preset.id == *id)
            .map_or(BUTTON_COLORS[0].value, |preset| preset.value)
            .to_string(),
        // A value that is neither, which normalizing never lets through.
        ButtonColor::Hex(_) => BUTTON_COLORS[0].value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::testing::{cases, same, EchoVars, Locale};
    use serde_json::json;

    #[test]
    fn validators_match_the_typescript() {
        let all = cases("colors-validators.json");
        assert!(all.len() >= 100, "{} cases", all.len());
        for case in &all {
            let input = &case["input"];
            let output = &case["output"];
            same(
                &format!("isHexColor({input})"),
                &is_hex_color_value(input),
                &output["isHexColor"],
            );
            same(
                &format!("isButtonColorId({input})"),
                &is_button_color_id(input),
                &output["isButtonColorId"],
            );
            same(
                &format!("isButtonColor({input})"),
                &is_button_color(input),
                &output["isButtonColor"],
            );
            if is_button_color(input) {
                let color = button_color(input).expect("a colour");
                same(&format!("the colour {input} as stored"), &color, input);
                same(
                    &format!("colorValue({input})"),
                    &color_value(&color),
                    &output["colorValue"],
                );
            }
        }
    }

    #[test]
    fn hex_maths_matches_the_typescript() {
        let all = cases("colors-hex.json");
        assert!(all.len() >= 100, "{} cases", all.len());
        for case in &all {
            let input = case["input"].as_str();
            let output = &case["output"];
            same(
                &format!("parseHex({})", case["input"]),
                &parse_hex(input),
                &output["parseHex"],
            );
            let Some(hex) = input else { continue };
            same(
                &format!("readableInk({hex})"),
                &readable_ink(hex),
                &output["readableInk"],
            );
            same(
                &format!("isVeryDark({hex})"),
                &is_very_dark(hex),
                &output["isVeryDark"],
            );
            for (name, ink) in [("contrastDark", DARK_INK), ("contrastLight", LIGHT_INK)] {
                // Math.pow is not the same routine in V8 and here: the last
                // digit may differ, nothing more.
                let ours = contrast_ratio(hex, ink);
                let theirs = output[name].as_f64().expect("a ratio");
                assert!(
                    (ours - theirs).abs() <= theirs * 1e-12,
                    "contrastRatio({hex}, {ink}): {ours} vs {theirs}"
                );
            }
        }
    }

    #[test]
    fn mixing_matches_the_typescript() {
        let alpha = cases("colors-withAlpha.json");
        let mix = cases("colors-mixHex.json");
        assert!(
            alpha.len() >= 100 && mix.len() >= 200,
            "{} and {} cases",
            alpha.len(),
            mix.len()
        );
        for case in &alpha {
            let input = &case["input"];
            let got = with_alpha(
                input["hex"].as_str().expect("hex"),
                input["alpha"].as_f64().expect("alpha"),
            );
            same(&format!("withAlpha({input})"), &got, &case["output"]);
        }
        for case in &mix {
            let input = &case["input"];
            let got = mix_hex(
                input["hex"].as_str().expect("hex"),
                input["toward"].as_str().expect("toward"),
                input["amount"].as_f64().expect("amount"),
            );
            same(&format!("mixHex({input})"), &got, &case["output"]);
        }
    }

    #[test]
    fn presets_match_the_typescript() {
        let english = Locale::load("en");
        let all = cases("colors-presets.json");
        assert_eq!(all.len(), BUTTON_COLORS.len());
        for (case, preset) in all.iter().zip(BUTTON_COLORS) {
            same("a preset's id", &preset.id, &case["input"]);
            assert_eq!(json!(preset.name), case["input"]);
            same("a preset's value", &preset.value, &case["output"]["value"]);
            same(
                "a preset's label",
                &color_label(preset.id, &EchoVars),
                &case["output"]["echo"],
            );
            same(
                "a preset's label in English",
                &color_label(preset.id, &english),
                &case["output"]["en"],
            );
        }
        let inks = &cases("colors-inks.json")[0]["output"];
        assert_eq!(inks["DARK_INK"], json!(DARK_INK));
        assert_eq!(inks["LIGHT_INK"], json!(LIGHT_INK));
    }
}
