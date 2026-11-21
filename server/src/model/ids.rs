//! New ids, and the time a deck was made.
//!
//! The TypeScript's `nextId` reads the clock and a counter kept by the page
//! or the process; `createEmptyProfile` reads the clock too. Nothing in this
//! module asks the system for anything, so whoever starts the companion
//! hands in the clock, and tests hand in a fixed one.
use std::sync::atomic::{AtomicU64, Ordering};

pub struct Ids {
    /// Milliseconds since 1970, as `Date.now()` gives them.
    now: Box<dyn Fn() -> u64 + Send + Sync>,
    counter: AtomicU64,
}

impl Ids {
    pub fn new(now: impl Fn() -> u64 + Send + Sync + 'static) -> Self {
        Self::starting_after(0, now)
    }

    /// As `new`, with `made` ids already given out: the next one ends in `made + 1`.
    pub fn starting_after(made: u64, now: impl Fn() -> u64 + Send + Sync + 'static) -> Self {
        Self {
            now: Box::new(now),
            counter: AtomicU64::new(made),
        }
    }

    /// `nextId(prefix)`: "btn_mc3k2x1a_7", the clock in base 36 and a counter.
    pub fn next_id(&self, prefix: &str) -> String {
        let count = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        format!("{prefix}_{}_{count}", base36((self.now)()))
    }

    /// `new Date().toISOString()`: "2026-11-20T08:15:30.123Z".
    pub fn now_iso(&self) -> String {
        iso_from_millis((self.now)())
    }
}

/// `number.toString(36)`.
fn base36(mut number: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut digits = Vec::new();
    loop {
        digits.push(DIGITS[(number % 36) as usize] as char);
        number /= 36;
        if number == 0 {
            break;
        }
    }
    digits.iter().rev().collect()
}

/// `new Date(millis).toISOString()`, for the years 1970 to 9999.
fn iso_from_millis(millis: u64) -> String {
    let (days, rest) = (millis / 86_400_000, millis % 86_400_000);
    // Days since 1970 to a date in the Gregorian calendar, counted in
    // 400-year eras starting on 1 March (Howard Hinnant's civil_from_days).
    let shifted = days + 719_468;
    let (era, day_of_era) = (shifted / 146_097, shifted % 146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_from_march = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_from_march + 2) / 5 + 1;
    let month = if month_from_march < 10 {
        month_from_march + 3
    } else {
        month_from_march - 9
    };
    let year = year_of_era + era * 400 + u64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::testing::cases;

    #[test]
    fn ids_and_dates_match_the_typescript() {
        let all = cases("model-nextId.json");
        assert!(all.len() >= 60, "{} cases", all.len());
        for case in &all {
            let now = case["input"]["now"].as_u64().expect("a time");
            let made = case["input"]["counter"].as_u64().expect("a counter");
            let prefix = case["input"]["prefix"].as_str().expect("a prefix");
            let ids = Ids::starting_after(made, move || now);
            assert_eq!(case["output"]["id"], ids.next_id(prefix), "nextId at {now}");
            assert_eq!(case["output"]["iso"], ids.now_iso(), "toISOString at {now}");
        }
    }

    #[test]
    fn ids_count_up() {
        let ids = Ids::new(|| 36);
        assert_eq!(ids.next_id("btn"), "btn_10_1");
        assert_eq!(ids.next_id("step"), "step_10_2");
    }
}
