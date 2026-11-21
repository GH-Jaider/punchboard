//! Fader targets. Levels are always 0..1 as the fader shows them; each target
//! converts to its own scale.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::Value;

use crate::i18n::{say, UserError};
use crate::latest_wins::LatestWins;
use crate::model::js;
use crate::model::normalize::app_display_name;
use crate::model::types::{Fader, FaderTarget};
use crate::translate::Keys;

use super::app_volume::AppVolume;
use super::{clamp01, Answer, SystemAudio, VolumeError};

pub use crate::latest_wins::latest_wins;
pub use crate::model::normalize::fader_level_key as level_key;

/// What the fader code needs from the rest of the companion. (The
/// TypeScript's `VolumeContext` held `obs`, `config`, `saveConfig`,
/// `setSoundVolume` and `apps`; here the OBS link and the config are reached
/// through the calls the faders make on them.)
pub trait VolumeContext: Send + Sync {
    /// `obs.connect()`: the link to OBS, opened if it is not. Asked before
    /// either call below, and before the fader's input is looked at.
    fn obs_connect(&self) -> Answer<(), VolumeError>;
    /// OBS's `GetInputVolume` for one input: its `inputVolumeMul`.
    fn obs_input_volume(&self, input_name: &str) -> Answer<f64, VolumeError>;
    /// OBS's `SetInputVolume` with an `inputVolumeMul`.
    fn set_obs_input_volume(&self, input_name: &str, mul: f64) -> Answer<(), VolumeError>;
    /// `config.soundVolume`.
    fn sound_volume(&self) -> f64;
    /// `config.soundVolume = level`.
    fn store_sound_volume(&self, level: f64);
    fn save_config(&self);
    /// Applies the sounds fader to what is playing right now.
    fn set_sound_volume(&self, level: f64);
    /// App volume faders: this system's, unless a test brings its own.
    fn apps(&self) -> &dyn AppVolume;
    /// The computer's main volume.
    fn system(&self) -> &SystemVolume;
}

/// The computer's own volume: reads go straight to the system, writes one at
/// a time, newest level first.
pub struct SystemVolume {
    audio: Option<Arc<dyn SystemAudio>>,
    write: LatestWins<Result<f64, UserError>>,
    /// Set by [`SystemVolume::stop`]: a write still queued behind the one in
    /// flight is dropped rather than opening the system again.
    stopping: Arc<AtomicBool>,
}

fn unsupported() -> UserError {
    UserError::new(say("server.volume.systemUnsupported"))
}

impl SystemVolume {
    /// `None` where the computer's volume cannot be controlled.
    pub fn new(audio: Option<Arc<dyn SystemAudio>>) -> SystemVolume {
        let stopping = Arc::new(AtomicBool::new(false));
        let (system, stopped) = (audio.clone(), stopping.clone());
        let write = latest_wins(move |level| {
            // Looked at when the write starts, which for a queued one is the
            // moment the write before it ended.
            let asked = match &system {
                None => Err(unsupported()),
                Some(_) if stopped.load(Ordering::SeqCst) => {
                    Err(UserError::new(say("server.winVolume.stopped")))
                }
                Some(system) => Ok(system.set_main_volume(level)),
            };
            async move { asked?.await }
        });
        SystemVolume {
            audio,
            write,
            stopping,
        }
    }

    pub async fn read(&self) -> Result<f64, UserError> {
        match &self.audio {
            Some(audio) => audio.main_volume().await,
            None => Err(unsupported()),
        }
    }

    /// While a drag is in flight only the newest level matters: one set at a
    /// time, and whatever arrived meanwhile is sent next.
    pub async fn write(&self, level: f64) -> Result<f64, UserError> {
        if self.audio.is_none() {
            return Err(unsupported());
        }
        self.stopping.store(false, Ordering::SeqCst);
        self.write.run(level).await
    }

    /// Before the system is stopped: a queued write is forgotten.
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
    }
}

fn require_input(fader: &Fader) -> Result<&str, UserError> {
    if fader.input_name.is_empty() {
        return Err(UserError::new(say("server.press.noAudioInput")));
    }
    Ok(&fader.input_name)
}

fn require_app(fader: &Fader) -> Result<&str, UserError> {
    match fader.app.as_deref() {
        Some(app) if !app.is_empty() => Ok(app),
        _ => Err(UserError::new(say("server.volume.noApp"))),
    }
}

/// OBS faders are cubic; decks show the position, not the gain.
/// (`faderPosition` in obs-state.ts.)
pub fn fader_position(mul: f64) -> f64 {
    js::max(0.0, js::min(1.0, js_cbrt(js::max(0.0, mul))))
}

/// `Math.cbrt`, as V8 computes it (FreeBSD's s_cbrt.c): the system's own
/// `cbrt` differs in the last bit for some levels, and a level that differs
/// in its last bit is a change the decks would be told about.
fn js_cbrt(x: f64) -> f64 {
    const B1: u32 = 715_094_163;
    const B2: u32 = 696_219_795;
    const P0: f64 = 1.875_951_824_271_77;
    const P1: f64 = -1.884_979_795_433_771_7;
    const P2: f64 = 1.621_429_720_105_354_5;
    const P3: f64 = -0.758_397_934_778_766;
    const P4: f64 = 0.145_996_192_886_612_45;
    let bits = x.to_bits();
    let sign = (bits >> 32) as u32 & 0x8000_0000;
    let high = (bits >> 32) as u32 ^ sign;
    let low = bits as u32;
    // NaN and the infinities are themselves.
    if high >= 0x7ff0_0000 {
        return x + x;
    }
    let from_high = |high: u32| f64::from_bits(u64::from(high) << 32);
    // A rough cube root, good to 5 bits, from the exponent alone.
    let mut t = if high < 0x0010_0000 {
        // Zero, or too small to have a full exponent.
        if high | low == 0 {
            return x;
        }
        let scaled = from_high(0x4350_0000) * x;
        let scaled_high = (scaled.to_bits() >> 32) as u32;
        from_high(sign | ((scaled_high & 0x7fff_ffff) / 3 + B2))
    } else {
        from_high(sign | (high / 3 + B1))
    };
    // To 23 bits with a polynomial, rounded away from zero to 23 bits.
    let r = (t * t) * (t / x);
    t *= (P0 + r * (P1 + r * P2)) + ((r * r) * r) * (P3 + r * P4);
    t = f64::from_bits((t.to_bits().wrapping_add(0x8000_0000)) & 0xffff_ffff_c000_0000);
    // One step of Newton's method to 53 bits.
    let s = t * t;
    let r = x / s;
    let w = t + t;
    let r = (r - t) / (w + r);
    t + t * r
}

/// The gain OBS is sent for a fader position. OBS's own mixer faders are
/// cubic: a fader at 50% is 0.125 of full signal. Using the same curve keeps
/// a deck fader and the OBS fader in line.
pub fn obs_gain(level: f64) -> f64 {
    // The system's pow, which is what JavaScript's `**` uses too: on each
    // platform the result is the one Node gave there. Windows' differs from
    // macOS's and Linux's in the last bit for some levels.
    level.powf(3.0)
}

/// A fader's level now, or `None` when nobody can say (an app that is closed).
pub async fn read_level(
    fader: &Fader,
    context: &dyn VolumeContext,
) -> Result<Option<f64>, VolumeError> {
    match fader.target {
        FaderTarget::App => context.apps().read(require_app(fader)?).await,
        FaderTarget::Sounds => Ok(Some(clamp01(context.sound_volume()))),
        FaderTarget::System => Ok(Some(context.system().read().await?)),
        FaderTarget::ObsInput => {
            context.obs_connect().await?;
            let mul = context.obs_input_volume(require_input(fader)?).await?;
            Ok(Some(fader_position(mul)))
        }
    }
}

/// A level a fader can be set to: a finite number. Anything else (missing,
/// null, text) is refused rather than read as 0, which would mute.
pub fn is_level(value: &Value) -> bool {
    value.as_f64().is_some_and(f64::is_finite)
}

pub async fn write_level(
    fader: &Fader,
    level: &Value,
    context: &dyn VolumeContext,
) -> Result<f64, VolumeError> {
    let Some(level) = level.as_f64().filter(|level| level.is_finite()) else {
        return Err(UserError::new(say("server.volume.badLevel")).into());
    };
    let value = clamp01(level);
    match fader.target {
        FaderTarget::App => {
            let app = require_app(fader)?;
            // The key is there, so the name never needs the words for "no app".
            let name = app_display_name(fader, &Keys);
            context.apps().write(app, &name, value).await
        }
        FaderTarget::Sounds => {
            context.store_sound_volume(value);
            context.save_config();
            context.set_sound_volume(value);
            Ok(value)
        }
        FaderTarget::System => {
            context.system().write(value).await?;
            Ok(value)
        }
        FaderTarget::ObsInput => {
            context.obs_connect().await?;
            let input = require_input(fader)?;
            context.set_obs_input_volume(input, obs_gain(value)).await?;
            Ok(value)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::app_volume::{AppList, OtherAppVolume};
    use crate::audio::testing::cases;
    use crate::audio::SystemApp;
    use std::sync::Mutex;
    use std::time::Duration;
    use tokio::time::sleep;

    fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
        mutex
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn number(bits: &Value) -> f64 {
        f64::from_bits(u64::from_str_radix(bits.as_str().unwrap(), 16).unwrap())
    }

    fn bits(value: f64) -> String {
        format!("{:016x}", value.to_bits())
    }

    /// A system that sets the main volume slowly and remembers every call.
    #[derive(Default)]
    pub struct SlowSystem {
        pub calls: Arc<Mutex<Vec<String>>>,
        pub level: Arc<Mutex<f64>>,
    }

    impl SystemAudio for SlowSystem {
        fn main_volume(&self) -> Answer<f64> {
            let (calls, level) = (self.calls.clone(), self.level.clone());
            Box::pin(async move {
                lock(&calls).push("get".to_string());
                let level = *lock(&level);
                Ok(level)
            })
        }
        fn set_main_volume(&self, level: f64) -> Answer<f64> {
            lock(&self.calls).push(format!("set {level}"));
            let now = self.level.clone();
            Box::pin(async move {
                sleep(Duration::from_millis(80)).await;
                if level == 0.666 {
                    return Err(UserError::new(say("server.winVolume.helperStopped")));
                }
                *lock(&now) = level;
                Ok(level)
            })
        }
        fn app_volume(&self, _key: &str) -> Answer<Option<f64>> {
            Box::pin(async { Ok(None) })
        }
        fn set_app_volume(&self, _key: &str, _level: f64) -> Answer<Option<f64>> {
            Box::pin(async { Ok(None) })
        }
        fn list_apps(&self) -> Answer<Vec<SystemApp>> {
            Box::pin(async { Ok(Vec::new()) })
        }
    }

    /// What the faders reach, recorded.
    struct Context {
        log: Arc<Mutex<Vec<String>>>,
        sound: Mutex<f64>,
        obs_mul: f64,
        obs_error: Option<VolumeError>,
        apps: Box<dyn AppVolume>,
        system: SystemVolume,
    }

    impl Context {
        fn new(system: SystemVolume) -> Context {
            Context {
                log: Arc::default(),
                sound: Mutex::new(1.0),
                obs_mul: 0.125,
                obs_error: None,
                apps: Box::new(OtherAppVolume::new("freebsd")),
                system,
            }
        }
        fn log(&self) -> String {
            lock(&self.log).join("|")
        }
    }

    impl VolumeContext for Context {
        fn obs_connect(&self) -> Answer<(), VolumeError> {
            lock(&self.log).push("connect".to_string());
            let error = self.obs_error.clone();
            Box::pin(async move { error.map_or(Ok(()), Err) })
        }
        fn obs_input_volume(&self, input_name: &str) -> Answer<f64, VolumeError> {
            lock(&self.log).push(format!("GetInputVolume {input_name}"));
            let mul = self.obs_mul;
            Box::pin(async move { Ok(mul) })
        }
        fn set_obs_input_volume(&self, input_name: &str, mul: f64) -> Answer<(), VolumeError> {
            lock(&self.log).push(format!("SetInputVolume {input_name} {mul}"));
            Box::pin(async { Ok(()) })
        }
        fn sound_volume(&self) -> f64 {
            *lock(&self.sound)
        }
        fn store_sound_volume(&self, level: f64) {
            *lock(&self.sound) = level;
            lock(&self.log).push(format!("config {level}"));
        }
        fn save_config(&self) {
            lock(&self.log).push("save".to_string());
        }
        fn set_sound_volume(&self, level: f64) {
            lock(&self.log).push(format!("player {level}"));
        }
        fn apps(&self) -> &dyn AppVolume {
            self.apps.as_ref()
        }
        fn system(&self) -> &SystemVolume {
            &self.system
        }
    }

    fn fader(target: FaderTarget, input_name: &str, app: Option<&str>) -> Fader {
        Fader {
            target,
            input_name: input_name.to_string(),
            app: app.map(str::to_string),
            app_name: None,
        }
    }

    // ------------------------------------------------ against the TypeScript

    #[test]
    fn is_level_matches_the_typescript() {
        let all = cases("is-level.json");
        assert!(all.len() >= 20);
        for case in all {
            assert_eq!(
                is_level(&case["input"]),
                case["output"].as_bool().unwrap(),
                "{}",
                case["input"]
            );
        }
    }

    #[test]
    fn conversions_match_the_typescript() {
        let all = cases("conversions.json");
        assert!(all.len() >= 2000);
        for case in all {
            let input = number(&case["input"]["bits"]);
            let output = &case["output"];
            let what = format!("{} ({})", case["input"]["text"], case["input"]["bits"]);
            assert_eq!(bits(clamp01(input)), output["clamp01"], "clamp01 {what}");
            assert_eq!(
                bits(fader_position(input)),
                output["faderPosition"],
                "faderPosition {what}"
            );
            // The fixture was made on a Mac; Windows' pow may land one step away.
            let gain = obs_gain(clamp01(input));
            let wanted = f64::from_bits(
                u64::from_str_radix(output["obsGain"].as_str().expect("bits"), 16).expect("hex"),
            );
            let steps = (gain.to_bits() as i64 - wanted.to_bits() as i64).abs();
            assert!(
                steps <= i64::from(cfg!(windows)),
                "obsGain {what}: {gain} is not {wanted}"
            );
            assert_eq!(
                bits(super::super::fixed3(clamp01(input))),
                output["fixed3"],
                "toFixed(3) {what}"
            );
        }
    }

    #[tokio::test]
    async fn written_levels_match_the_typescript() {
        let all = cases("write-level.json");
        assert!(all.len() >= 100);
        for case in all {
            let input = &case["input"];
            let output = &case["output"];
            let target = match input["target"].as_str().unwrap() {
                "sounds" => FaderTarget::Sounds,
                "obs_input" => FaderTarget::ObsInput,
                other => panic!("{other}"),
            };
            let context = Context::new(SystemVolume::new(None));
            let fader = fader(target, input["inputName"].as_str().unwrap(), None);
            let result = write_level(&fader, &input["level"], &context).await;
            let calls: Vec<String> = output["calls"]
                .as_array()
                .unwrap()
                .iter()
                .map(|call| {
                    let name = call["what"].as_str().unwrap();
                    match name {
                        "save" | "connect" => name.to_string(),
                        "SetInputVolume" => format!(
                            "SetInputVolume {} {}",
                            call["inputName"].as_str().unwrap(),
                            number(&call["bits"])
                        ),
                        _ => format!("{name} {}", number(&call["bits"])),
                    }
                })
                .collect();
            // The config is set first, which the TypeScript's context cannot
            // see happen; what it holds afterwards is compared instead.
            let log: Vec<String> = lock(&context.log)
                .iter()
                .filter(|entry| !entry.starts_with("config "))
                .cloned()
                .collect();
            assert_eq!(log.join("|"), calls.join("|"), "{input}");
            match result {
                Ok(level) => {
                    assert_eq!(bits(level), output["level"], "{input}");
                    assert_eq!(
                        bits(context.sound_volume()),
                        output["soundVolume"],
                        "{input}"
                    );
                }
                Err(error) => {
                    assert_eq!(error.said(), say(output["error"].as_str().unwrap()).into());
                }
            }
        }
    }

    // ------------------------------------------------------- by hand

    #[tokio::test]
    async fn the_sounds_fader_saves_and_applies() {
        let context = Context::new(SystemVolume::new(None));
        let sounds = fader(FaderTarget::Sounds, "", None);
        assert_eq!(
            write_level(&sounds, &Value::from(0.25), &context).await,
            Ok(0.25)
        );
        assert_eq!(context.log(), "config 0.25|save|player 0.25");
        assert_eq!(read_level(&sounds, &context).await, Ok(Some(0.25)));
        *lock(&context.sound) = 7.0;
        assert_eq!(read_level(&sounds, &context).await, Ok(Some(1.0)));
        *lock(&context.sound) = f64::NAN;
        assert_eq!(read_level(&sounds, &context).await, Ok(Some(0.0)));
    }

    // tests/sounds.test.mjs: every level that is not a number is refused, and
    // "a refused level never reaches" anything.
    #[tokio::test]
    async fn a_level_that_is_not_a_number_is_refused_before_anything_is_touched() {
        let system = Arc::new(SlowSystem::default());
        let calls = system.calls.clone();
        let context = Context::new(SystemVolume::new(Some(system)));
        for target in [
            FaderTarget::Sounds,
            FaderTarget::System,
            FaderTarget::ObsInput,
            FaderTarget::App,
        ] {
            for level in [
                Value::Null,
                Value::from("loud"),
                Value::from("0.5"),
                Value::from(true),
                serde_json::json!([0.5]),
                serde_json::json!({}),
            ] {
                let error = write_level(&fader(target, "Mic", Some("chrome")), &level, &context)
                    .await
                    .unwrap_err();
                assert_eq!(error.said(), say("server.volume.badLevel").into());
                assert_eq!(error.message(), "The level must be a number from 0 to 1.");
            }
        }
        assert_eq!(context.log(), "");
        assert!(lock(&calls).is_empty());
    }

    #[tokio::test]
    async fn the_obs_fader_is_cubic_both_ways() {
        let mut context = Context::new(SystemVolume::new(None));
        let mic = fader(FaderTarget::ObsInput, "Mic", None);
        assert_eq!(
            write_level(&mic, &Value::from(0.5), &context).await,
            Ok(0.5)
        );
        assert_eq!(read_level(&mic, &context).await, Ok(Some(0.5)));
        assert_eq!(
            context.log(),
            "connect|SetInputVolume Mic 0.125|connect|GetInputVolume Mic"
        );
        // Out of range is brought in before the curve.
        assert_eq!(write_level(&mic, &Value::from(3), &context).await, Ok(1.0));
        assert!(context.log().ends_with("SetInputVolume Mic 1"));
        let unset = fader(FaderTarget::ObsInput, "", None);
        let error = write_level(&unset, &Value::from(0.5), &context)
            .await
            .unwrap_err();
        assert_eq!(error.said(), say("server.press.noAudioInput").into());
        let error = read_level(&unset, &context).await.unwrap_err();
        assert_eq!(error.said(), say("server.press.noAudioInput").into());
        // OBS's own words come through as they are.
        context.obs_error = Some(VolumeError::Plain("OBS is not running.".to_string()));
        let error = read_level(&mic, &context).await.unwrap_err();
        assert_eq!(error.message(), "OBS is not running.");
        let error = write_level(&mic, &Value::from(0.5), &context)
            .await
            .unwrap_err();
        assert_eq!(error, VolumeError::Plain("OBS is not running.".to_string()));
    }

    // tests/app-volume.test.mjs: "Routes: an app fader with no app asks for one"
    #[tokio::test]
    async fn an_app_fader_with_no_app_asks_for_one() {
        let context = Context::new(SystemVolume::new(None));
        for app in [None, Some("")] {
            let unset = fader(FaderTarget::App, "", app);
            let error = write_level(&unset, &Value::from(0.5), &context)
                .await
                .unwrap_err();
            assert_eq!(error.message(), "Choose the app first.");
            let error = read_level(&unset, &context).await.unwrap_err();
            assert_eq!(error.said(), say("server.volume.noApp").into());
        }
    }

    #[tokio::test]
    async fn an_app_fader_goes_to_the_app_volumes_with_the_apps_name() {
        struct Named(Mutex<Vec<String>>);
        impl AppVolume for Named {
            fn live(&self) -> bool {
                true
            }
            fn list(&self) -> Answer<AppList> {
                unreachable!()
            }
            fn read(&self, key: &str) -> Answer<Option<f64>, VolumeError> {
                lock(&self.0).push(format!("read {key}"));
                Box::pin(async { Ok(None) })
            }
            fn write(&self, key: &str, name: &str, level: f64) -> Answer<f64, VolumeError> {
                lock(&self.0).push(format!("write {key} as {name} {level}"));
                Box::pin(async move { Ok(level) })
            }
        }
        let mut context = Context::new(SystemVolume::new(None));
        context.apps = Box::new(Named(Mutex::default()));
        let mut chrome = fader(FaderTarget::App, "", Some("chrome"));
        assert_eq!(
            write_level(&chrome, &Value::from(1.5), &context).await,
            Ok(1.0)
        );
        chrome.app_name = Some("Google Chrome".to_string());
        assert_eq!(
            write_level(&chrome, &Value::from(-1), &context).await,
            Ok(0.0)
        );
        assert_eq!(read_level(&chrome, &context).await, Ok(None));
    }

    #[tokio::test]
    async fn the_computers_volume_where_there_is_none_to_control() {
        let context = Context::new(SystemVolume::new(None));
        let system = fader(FaderTarget::System, "", None);
        let error = read_level(&system, &context).await.unwrap_err();
        assert_eq!(
            error.message(),
            "The computer's volume can be controlled on macOS, Windows and Linux only."
        );
        let error = write_level(&system, &Value::from(0.5), &context)
            .await
            .unwrap_err();
        assert_eq!(error.said(), say("server.volume.systemUnsupported").into());
    }

    // tests/sounds.test.mjs: "Volume writes never overlap, and the newest
    // level is set last", here through the computer's volume itself.
    #[tokio::test(start_paused = true)]
    async fn a_drag_on_the_computers_volume_is_coalesced_newest_last() {
        let system = Arc::new(SlowSystem::default());
        let (calls, level) = (system.calls.clone(), system.level.clone());
        let context = Context::new(SystemVolume::new(Some(system)));
        let main = fader(FaderTarget::System, "", None);
        let writes = futures_util::future::join_all([0.1, 0.2, 0.3, 0.4].map(|level| {
            let (main, context) = (&main, &context);
            async move { write_level(main, &Value::from(level), context).await }
        }))
        .await;
        // Each fader is answered with the level it asked for.
        assert_eq!(writes, [Ok(0.1), Ok(0.2), Ok(0.3), Ok(0.4)]);
        sleep(Duration::from_millis(250)).await;
        assert_eq!(lock(&calls).join("|"), "set 0.1|set 0.4");
        assert_eq!(*lock(&level), 0.4);
        assert_eq!(read_level(&main, &context).await, Ok(Some(0.4)));
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_write_is_told_and_does_not_block_the_next() {
        let system = Arc::new(SlowSystem::default());
        let context = Context::new(SystemVolume::new(Some(system)));
        let main = fader(FaderTarget::System, "", None);
        let error = write_level(&main, &Value::from(0.666), &context)
            .await
            .unwrap_err();
        assert_eq!(error.message(), "The volume helper stopped; try again.");
        assert_eq!(
            write_level(&main, &Value::from(0.5), &context).await,
            Ok(0.5)
        );
    }

    // stopWindowsVolume: "a queued write is dropped rather than starting a new bridge".
    #[tokio::test(start_paused = true)]
    async fn stopping_drops_the_queued_write() {
        let system = Arc::new(SlowSystem::default());
        let calls = system.calls.clone();
        let volume = Arc::new(SystemVolume::new(Some(system)));
        let first = volume.write(0.1);
        let second = volume.write(0.9);
        let (first, second, ()) = tokio::join!(first, second, async {
            sleep(Duration::from_millis(10)).await;
            volume.stop();
        });
        assert_eq!((first, second), (Ok(0.1), Ok(0.1)));
        sleep(Duration::from_millis(300)).await;
        assert_eq!(lock(&calls).join("|"), "set 0.1");
        // A write asked for after the stop is a new one, and is made.
        assert_eq!(volume.write(0.3).await, Ok(0.3));
    }
}
