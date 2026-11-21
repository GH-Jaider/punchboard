//! macOS: the main output's volume through Core Audio, and the volume of
//! Music and Spotify through `/usr/bin/osascript` (the one thing only
//! AppleScript can reach; app_volume.rs builds and reads the scripts).
//!
//! The main volume is the default output device's "virtual main volume",
//! the one the menu bar's slider and `set volume output volume` move. A
//! device without one (some interfaces) has a volume per channel instead;
//! one with neither (HDMI, most displays) has no volume to control.

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::Arc;
use std::time::Duration;

use objc2_core_audio::{
    kAudioDevicePropertyPreferredChannelsForStereo, kAudioDevicePropertyVolumeScalar,
    kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyElementMain,
    kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyScopeOutput, kAudioObjectSystemObject,
    AudioObjectGetPropertyData, AudioObjectHasProperty, AudioObjectID, AudioObjectPropertyAddress,
    AudioObjectSetPropertyData,
};

use crate::i18n::{say, UserError};
use crate::model::js;

use super::app_volume::{mac_app_of, run_mac_script, ScriptRunner, MAC_APPS};
use super::{clamp01, Answer, SystemApp, SystemAudio};

/// kAudioHardwareServiceDeviceProperty_VirtualMainVolume ('vmvc'), from
/// AudioToolbox's AudioHardwareService.h: Core Audio answers it for the
/// device itself.
const VIRTUAL_MAIN_VOLUME: u32 = u32::from_be_bytes(*b"vmvc");

/// How long a script may take. Longer than anything else here: the first
/// time, macOS asks whether Punchboard may control the app, and the script
/// waits on that.
const SCRIPT_MS: u64 = 8000;

// ------------------------------------------------------------ deciding

/// The level `output volume of (get volume settings)` reports for a device's
/// volume: whole per cents, as the TypeScript read them.
pub fn reported_level(scalar: f32) -> f64 {
    clamp01(js::round(f64::from(scalar) * 100.0) / 100.0)
}

/// The volume `set volume output volume N` sets for a level: whole per cents.
pub fn scalar_for(level: f64) -> f32 {
    (js::round(clamp01(level) * 100.0) / 100.0) as f32
}

// --------------------------------------------------------------- doing

fn address(selector: u32, scope: u32, element: u32) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: scope,
        mElement: element,
    }
}

fn has(object: AudioObjectID, property: &AudioObjectPropertyAddress) -> bool {
    // SAFETY: the address is a live, initialised struct for the whole call.
    unsafe { AudioObjectHasProperty(object, NonNull::from(property)) }
}

/// Reads a property that is one plain value (or a small array of them).
fn get<T: Copy + Default>(
    object: AudioObjectID,
    property: &AudioObjectPropertyAddress,
) -> Result<T, i32> {
    let mut value = T::default();
    let mut size = std::mem::size_of::<T>() as u32;
    // SAFETY: `value` is `size` writable bytes of a plain-data type, and
    // Core Audio writes at most `size` bytes into it; the address and the
    // size outlive the call; there is no qualifier.
    let status = unsafe {
        AudioObjectGetPropertyData(
            object,
            NonNull::from(property),
            0,
            std::ptr::null(),
            NonNull::from(&mut size),
            NonNull::from(&mut value).cast::<c_void>(),
        )
    };
    if status == 0 && size as usize == std::mem::size_of::<T>() {
        Ok(value)
    } else {
        Err(status)
    }
}

fn set(
    object: AudioObjectID,
    property: &AudioObjectPropertyAddress,
    value: f32,
) -> Result<(), i32> {
    let mut value = value;
    // SAFETY: `value` is four readable bytes for the whole call, and the
    // property is one Float32; the address outlives the call.
    let status = unsafe {
        AudioObjectSetPropertyData(
            object,
            NonNull::from(property),
            0,
            std::ptr::null(),
            std::mem::size_of::<f32>() as u32,
            NonNull::from(&mut value).cast::<c_void>(),
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(status)
    }
}

fn status_text(what: &str, status: i32) -> String {
    format!("{what} (Core Audio error {status})")
}

fn default_output() -> Result<AudioObjectID, String> {
    let property = address(
        kAudioHardwarePropertyDefaultOutputDevice,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain,
    );
    let device: AudioObjectID = get(kAudioObjectSystemObject as AudioObjectID, &property)
        .map_err(|status| status_text("There is no default output device", status))?;
    if device == 0 {
        return Err("There is no output device.".to_string());
    }
    Ok(device)
}

/// Where a device keeps its volume.
enum Control {
    Main(AudioObjectPropertyAddress),
    Channels(Vec<AudioObjectPropertyAddress>),
    None,
}

fn control_of(device: AudioObjectID) -> Control {
    let main = address(
        VIRTUAL_MAIN_VOLUME,
        kAudioObjectPropertyScopeOutput,
        kAudioObjectPropertyElementMain,
    );
    if has(device, &main) {
        return Control::Main(main);
    }
    let scalar = |element| {
        address(
            kAudioDevicePropertyVolumeScalar,
            kAudioObjectPropertyScopeOutput,
            element,
        )
    };
    if has(device, &scalar(kAudioObjectPropertyElementMain)) {
        return Control::Main(scalar(kAudioObjectPropertyElementMain));
    }
    // Left and right, wherever the device has them (1 and 2 unless it says).
    let stereo = address(
        kAudioDevicePropertyPreferredChannelsForStereo,
        kAudioObjectPropertyScopeOutput,
        kAudioObjectPropertyElementMain,
    );
    let pair: [u32; 2] = get(device, &stereo).unwrap_or([1, 2]);
    let channels: Vec<AudioObjectPropertyAddress> = pair
        .into_iter()
        .map(scalar)
        .filter(|channel| has(device, channel))
        .collect();
    if channels.is_empty() {
        Control::None
    } else {
        Control::Channels(channels)
    }
}

/// The default output's volume as Core Audio has it, 0..1; `None` when the
/// device has no volume to control.
pub fn main_scalar() -> Result<Option<f32>, String> {
    let device = default_output()?;
    let failed = |status| status_text("The output's volume could not be read", status);
    match control_of(device) {
        Control::Main(property) => Ok(Some(get::<f32>(device, &property).map_err(failed)?)),
        Control::Channels(channels) => {
            let mut sum = 0.0;
            for channel in &channels {
                sum += get::<f32>(device, channel).map_err(failed)?;
            }
            Ok(Some(sum / channels.len() as f32))
        }
        Control::None => Ok(None),
    }
}

fn set_main_scalar(scalar: f32) -> Result<(), String> {
    let device = default_output()?;
    let failed = |status| status_text("The output's volume could not be set", status);
    match control_of(device) {
        Control::Main(property) => set(device, &property, scalar).map_err(failed),
        Control::Channels(channels) => {
            for channel in &channels {
                set(device, channel, scalar).map_err(failed)?;
            }
            Ok(())
        }
        // `set volume` on such a device changes nothing and says nothing.
        Control::None => Ok(()),
    }
}

fn failure(what: &'static str, reason: String) -> UserError {
    UserError::new(
        say("server.winVolume.failed")
            .with("what", say(what))
            .with("reason", reason),
    )
}

/// Core Audio can take a moment (a device waking up): off the async threads.
async fn blocking<T: Send + 'static>(
    what: &'static str,
    call: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, UserError> {
    match tokio::task::spawn_blocking(call).await {
        Ok(result) => result.map_err(|reason| failure(what, reason)),
        Err(error) => Err(failure(what, error.to_string())),
    }
}

/// The Mac's volumes: the main output natively, Music and Spotify by script.
pub struct MacAudio {
    scripts: Arc<dyn ScriptRunner>,
}

impl MacAudio {
    pub fn new(scripts: Arc<dyn ScriptRunner>) -> MacAudio {
        MacAudio { scripts }
    }
}

impl SystemAudio for MacAudio {
    fn main_volume(&self) -> Answer<f64> {
        Box::pin(async {
            let scalar = blocking("server.macVolume.noRead", main_scalar).await?;
            // No volume control: osascript said "missing value", which the
            // TypeScript read as 0.
            Ok(scalar.map_or(0.0, reported_level))
        })
    }

    fn set_main_volume(&self, level: f64) -> Answer<f64> {
        Box::pin(async move {
            let scalar = scalar_for(level);
            blocking("server.macVolume.noChange", move || set_main_scalar(scalar)).await?;
            Ok(level)
        })
    }

    fn app_volume(&self, key: &str) -> Answer<Option<f64>> {
        let (app, scripts) = (mac_app_of(key), self.scripts.clone());
        Box::pin(async move { run_mac_script(scripts.as_ref(), app?, None).await })
    }

    fn set_app_volume(&self, key: &str, level: f64) -> Answer<Option<f64>> {
        let (app, scripts) = (mac_app_of(key), self.scripts.clone());
        Box::pin(async move { run_mac_script(scripts.as_ref(), app?, Some(level)).await })
    }

    /// Music and Spotify, whichever is open and answers.
    fn list_apps(&self) -> Answer<Vec<SystemApp>> {
        let scripts = self.scripts.clone();
        Box::pin(async move {
            let mut apps = Vec::new();
            for (key, app) in MAC_APPS {
                if let Ok(Some(level)) = run_mac_script(scripts.as_ref(), app, None).await {
                    apps.push(SystemApp {
                        key: key.to_string(),
                        name: app.name.to_string(),
                        level,
                    });
                }
            }
            Ok(apps)
        })
    }
}

/// `/usr/bin/osascript -e <script>`.
pub struct Osascript;

impl ScriptRunner for Osascript {
    fn run(&self, script: &str) -> Answer<String, String> {
        let script = script.to_string();
        Box::pin(async move {
            // What Node said when the script failed without a word, or was
            // stopped for taking too long.
            let failed = || format!("Command failed: osascript -e {script}");
            let mut command = tokio::process::Command::new("/usr/bin/osascript");
            command.arg("-e").arg(&script).kill_on_drop(true);
            let running = tokio::time::timeout(Duration::from_millis(SCRIPT_MS), command.output());
            let output = match running.await {
                Ok(Ok(output)) => output,
                Ok(Err(error)) => return Err(error.to_string()),
                Err(_) => return Err(failed()),
            };
            if output.status.success() {
                return Ok(js::trim(&String::from_utf8_lossy(&output.stdout)).to_string());
            }
            let said = String::from_utf8_lossy(&output.stderr);
            let said = js::trim(&said);
            Err(if said.is_empty() {
                failed()
            } else {
                said.to_string()
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_are_whole_per_cents_both_ways() {
        assert_eq!(reported_level(0.5), 0.5);
        assert_eq!(reported_level(0.437_5), 0.44);
        assert_eq!(reported_level(0.123_4), 0.12);
        assert_eq!(reported_level(1.0), 1.0);
        assert_eq!(reported_level(0.0), 0.0);
        assert_eq!(reported_level(f32::NAN), 0.0);
        assert_eq!(scalar_for(0.426), 0.43);
        assert_eq!(scalar_for(0.5), 0.5);
        assert_eq!(scalar_for(7.0), 1.0);
        assert_eq!(scalar_for(-1.0), 0.0);
        assert_eq!(VIRTUAL_MAIN_VOLUME, 0x766d_7663);
    }

    /// The stand-in apps of app_volume.rs, through the system's own face.
    #[tokio::test(start_paused = true)]
    async fn music_and_spotify_are_reached_by_script() {
        use crate::audio::app_volume::tests::{FakeMacApp, FakeOsascript};
        let runner = Arc::new(FakeOsascript::default());
        runner.set(&[(
            "com.spotify.client",
            FakeMacApp {
                running: true,
                volume: 30.0,
                refuse: false,
            },
        )]);
        let mac = MacAudio::new(runner);
        assert_eq!(mac.app_volume("spotify").await, Ok(Some(0.3)));
        assert_eq!(mac.set_app_volume("spotify", 0.6).await, Ok(Some(0.6)));
        assert_eq!(mac.app_volume("music").await, Ok(None));
        assert_eq!(
            mac.app_volume("chrome").await.unwrap_err().text.key,
            "server.apps.macOnly"
        );
        let apps = mac.list_apps().await.unwrap();
        assert_eq!(apps.len(), 1);
        assert_eq!((apps[0].key.as_str(), apps[0].level), ("spotify", 0.6));
    }

    /// Reads this Mac's real volume, twice, and changes nothing:
    ///   cargo test -- --ignored the_main_volume_is_what_osascript_reports --nocapture
    #[tokio::test]
    #[ignore = "reads this computer's real volume (and changes nothing)"]
    async fn the_main_volume_is_what_osascript_reports() {
        let native = MacAudio::new(Arc::new(Osascript))
            .main_volume()
            .await
            .unwrap();
        let said = Osascript
            .run("output volume of (get volume settings)")
            .await
            .unwrap();
        // As volume.ts read it: clamp01(Number(text) / 100).
        let scripted = clamp01(js::string_to_number(&said) / 100.0);
        println!(
            "Core Audio: {native} (scalar {:?}); osascript: {scripted} ({said:?})",
            main_scalar()
        );
        assert!((native - scripted).abs() <= 0.01, "{native} vs {scripted}");
    }
}
