//! The three interface themes. Each is a set of CSS overrides keyed on
//! html[data-theme] (public/themes.css); `bg` feeds the browser's theme-color.
//! Hardware also comes dark: the same theme with html[data-mode="dark"],
//! stored as its own id so it travels to every deck like any other choice.
//! (src/shared/themes.ts)
use serde_json::Value;

use super::types::ThemeId;
use crate::translate::Translate;

/// A theme. Its name and hint are read in the reader's language:
/// `theme_label` and `theme_hint`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Theme {
    pub id: ThemeId,
    /// The id as stored ("hardware-dark").
    pub name: &'static str,
    pub bg: &'static str,
}

pub const THEMES: [Theme; 3] = [
    Theme {
        id: ThemeId::Studio,
        name: "studio",
        bg: "#0d0e11",
    },
    Theme {
        id: ThemeId::Hardware,
        name: "hardware",
        bg: "#e4e2dc",
    },
    Theme {
        id: ThemeId::Broadcast,
        name: "broadcast",
        bg: "#0b0b0b",
    },
];

/// Variants that share a card with their family in the Appearance window.
const VARIANTS: [Theme; 1] = [Theme {
    id: ThemeId::HardwareDark,
    name: "hardware-dark",
    bg: "#1c1c1a",
}];

fn all_themes() -> impl Iterator<Item = Theme> {
    THEMES.into_iter().chain(VARIANTS)
}

pub const DEFAULT_THEME: ThemeId = ThemeId::Studio;

pub fn theme_label(id: ThemeId, t: &dyn Translate) -> String {
    t.t(&format!("shared.theme.{}.label", theme_of(id).name), &[])
}

pub fn theme_hint(id: ThemeId, t: &dyn Translate) -> String {
    t.t(&format!("shared.theme.{}.hint", theme_of(id).name), &[])
}

/// The theme a stored name is, if it is one.
pub fn theme_id(value: &str) -> Option<ThemeId> {
    all_themes()
        .find(|theme| theme.name == value)
        .map(|theme| theme.id)
}

/// `theme_id` on anything a file or a request held.
pub fn is_theme_id(value: &Value) -> bool {
    value.as_str().and_then(theme_id).is_some()
}

/// The theme with this id; the first one when there is none.
pub fn theme_by_id(id: Option<&str>) -> Theme {
    all_themes()
        .find(|theme| Some(theme.name) == id)
        .unwrap_or(THEMES[0])
}

fn theme_of(id: ThemeId) -> Theme {
    all_themes()
        .find(|theme| theme.id == id)
        .unwrap_or(THEMES[0])
}

/// The theme a variant belongs to: what html[data-theme] and the card say.
pub fn theme_family(id: ThemeId) -> ThemeId {
    if id == ThemeId::HardwareDark {
        ThemeId::Hardware
    } else {
        id
    }
}

/// Whether the theme is the dark variant of its family.
pub fn is_dark_variant(id: ThemeId) -> bool {
    id == ThemeId::HardwareDark
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::testing::{cases, same, EchoVars, Locale};

    #[test]
    fn is_theme_id_matches_the_typescript() {
        let all = cases("themes-isThemeId.json");
        assert!(all.len() >= 60, "{} cases", all.len());
        for case in &all {
            let input = &case["input"];
            same(
                &format!("isThemeId({input})"),
                &is_theme_id(input),
                &case["output"]["isThemeId"],
            );
            if let Some(id) = input.as_str().and_then(theme_id) {
                same("a theme id as stored", &id, input);
            }
            if input.is_string() || input.is_null() {
                let theme = theme_by_id(input.as_str());
                same(
                    &format!("themeById({input}).id"),
                    &theme.id,
                    &case["output"]["themeById"]["id"],
                );
                same(
                    &format!("themeById({input}).bg"),
                    &theme.bg,
                    &case["output"]["themeById"]["bg"],
                );
            }
        }
    }

    #[test]
    fn themes_match_the_typescript() {
        let english = Locale::load("en");
        let all = cases("themes-themes.json");
        assert_eq!(all.len(), 4);
        let listed: Vec<&str> = all
            .iter()
            .filter(|case| case["output"]["listed"] == true)
            .map(|case| case["input"].as_str().expect("an id"))
            .collect();
        assert_eq!(listed, THEMES.map(|theme| theme.name));
        for case in &all {
            let name = case["input"].as_str().expect("an id");
            let id = theme_id(name).expect("a theme");
            let output = &case["output"];
            same("bg", &theme_by_id(Some(name)).bg, &output["bg"]);
            same("family", &theme_family(id), &output["family"]);
            same("dark", &is_dark_variant(id), &output["dark"]);
            same(
                "label",
                &theme_label(id, &EchoVars),
                &output["echo"]["label"],
            );
            same("hint", &theme_hint(id, &EchoVars), &output["echo"]["hint"]);
            same(
                "label in English",
                &theme_label(id, &english),
                &output["en"]["label"],
            );
            same(
                "hint in English",
                &theme_hint(id, &english),
                &output["en"]["hint"],
            );
        }
        same(
            "DEFAULT_THEME",
            &DEFAULT_THEME,
            &cases("themes-default.json")[0]["output"],
        );
    }
}
