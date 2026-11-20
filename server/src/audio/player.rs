//! Plays the sound slots on this computer from the companion itself, so no
//! browser tab has to be open, focused or clicked for a deck's sound button
//! to work.
//!
//! A port of `src/server/player.ts`, without its helper processes (the JXA
//! helper and afplay on macOS, PowerShell's MediaPlayer on Windows): sounds
//! are decoded and mixed in this process (rodio), on macOS, Windows and Linux.
//!
//! * [`Player`] decides: which slots are playing, since when, what a second
//!   press does, what the owner is told when a sound ends.
//! * [`Output`] does: it starts a file at a gain, changes the gain, stops.
//!   The real one ([`RodioOutput`]) opens the audio device when the first
//!   sound plays; the player closes it after a short while with nothing
//!   playing, so an idle Punchboard holds no audio device.
//!
//! One thread (started by the first sound) owns the output and does its
//! work in order; it is also the thread `on_ended` and `log` are called on.

use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rodio::{
    ChannelCount, Decoder, DeviceSinkBuilder, MixerDeviceSink, Sample, SampleRate, Source,
};
use tokio::sync::oneshot;

use crate::i18n::UserError;

/// A sound slot's number.
pub type Slot = u8;

/// How long the audio device is kept after the last sound ended, unless
/// [`PlayerOptions::idle_close`] says otherwise. Long enough that a run of
/// presses starts each sound at once; short enough that nothing is held.
pub const IDLE_CLOSE: Duration = Duration::from_secs(5);

/// How long [`Player::stop_and_wait`] waits for a sound to end.
const STOP_WAIT: Duration = Duration::from_secs(2);

fn clamp01(value: f64) -> f64 {
    // `Math.max(0, Math.min(1, value))`: what is not a number stays so.
    if value.is_nan() {
        value
    } else {
        value.clamp(0.0, 1.0)
    }
}

/// A fader at half feels like half as loud with a squared gain, not linear.
pub fn gain_for(level: f64) -> f64 {
    clamp01(level) * clamp01(level)
}

/// Why a sound did not start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlayFailure {
    /// The slot's file is not there.
    Missing,
    /// The file is there and is not audio that can be decoded.
    Unreadable,
    /// Anything else, in the system's words (no audio device, for one).
    Other(String),
}

impl PlayFailure {
    /// The end of "Sound N could not be played: …", worded as player.ts logged it.
    fn reason(&self) -> String {
        match self {
            PlayFailure::Missing => "its file is missing.".to_string(),
            PlayFailure::Unreadable => "the file could not be opened.".to_string(),
            PlayFailure::Other(message) => message.clone(),
        }
    }
}

/// Called by an [`Output`], from any thread, when a sound has played to its
/// end by itself. Not called for a sound that was stopped.
pub type Ended = Box<dyn Fn() + Send + 'static>;

/// Called by an [`Output`], from any thread, when the audio device went away
/// (unplugged, the system's audio restarted): what was playing is over.
pub type Lost = Arc<dyn Fn(&str) + Send + Sync + 'static>;

/// What sounds are played through. The player gives every sound an id of its
/// own; ids are never reused.
pub trait Output {
    /// Starts a file at a gain (0..1), opening the audio device if it is not open.
    fn play(&mut self, id: u64, file: &Path, gain: f32, ended: Ended) -> Result<(), PlayFailure>;
    /// A new gain for every sound that is playing.
    fn set_gain(&mut self, gain: f32);
    /// Silences a sound. Also called for one that ended by itself, to let go of it.
    fn stop(&mut self, id: u64);
    /// Lets go of the audio device: nothing has played for a while.
    fn close(&mut self);
}

/// Makes the output, on the player's thread (a system's audio objects do
/// not always move between threads).
pub type OutputFactory = Arc<dyn Fn(Lost) -> Box<dyn Output> + Send + Sync>;

/// What a [`Player`] is given. The three functions are called without any
/// lock of the player's held; `on_ended` and `log` on the player's thread.
pub struct PlayerOptions {
    /// Fader position 0..1, read as each sound starts.
    pub volume: Box<dyn Fn() -> f64 + Send + Sync>,
    /// A sound stopped: on its own (how many ms it played) or on request (None).
    pub on_ended: Box<dyn Fn(Slot, Option<u64>) + Send + Sync>,
    pub log: Box<dyn Fn(&str) + Send + Sync>,
    /// See [`IDLE_CLOSE`].
    pub idle_close: Duration,
}

struct Running {
    slot: Slot,
    id: u64,
    /// When the sound began playing (ms since 1970): ordered, then corrected
    /// once the output has started it.
    started_at: u64,
    started: Instant,
    /// The output started it, so its run time can be trusted.
    confirmed: bool,
    stopping: bool,
    /// stop_and_wait callers, told when it ends.
    waiters: Vec<oneshot::Sender<()>>,
}

enum Message {
    Play { id: u64, file: PathBuf, gain: f32 },
    Stop(u64),
    Gain(f32),
    Ended(u64),
    Lost(String),
    Quit,
}

#[derive(Default)]
struct State {
    /// In the order the slots began, as a JavaScript Map keeps them.
    running: Vec<Running>,
    next_id: u64,
    /// The last gain a fader move set; a sound whose own level is not a
    /// number plays at it, as the macOS helper did.
    last_gain: Option<f32>,
    worker: Option<Sender<Message>>,
}

struct Inner {
    options: PlayerOptions,
    factory: OutputFactory,
    state: Mutex<State>,
}

/// The player of the sound slots. Cheap to clone; every clone is the same player.
#[derive(Clone)]
pub struct Player {
    inner: Arc<Inner>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// A sound is over. A sound that was replaced in its slot is not in
    /// `running` any more and ends unannounced: the slot has moved on.
    fn finish(&self, id: u64, natural: bool) {
        let ended = {
            let mut state = self.state();
            let Some(at) = state.running.iter().position(|entry| entry.id == id) else {
                return;
            };
            state.running.remove(at)
        };
        let ran = (natural && !ended.stopping && ended.confirmed)
            .then(|| ended.started.elapsed().as_millis() as u64);
        for waiter in ended.waiters {
            let _ = waiter.send(());
        }
        (self.options.on_ended)(ended.slot, ran);
    }

    fn work(self: Arc<Self>, tx: Sender<Message>, rx: mpsc::Receiver<Message>) {
        let lost_tx = Mutex::new(tx.clone());
        let lost: Lost = Arc::new(move |message: &str| {
            if let Ok(tx) = lost_tx.lock() {
                let _ = tx.send(Message::Lost(message.to_string()));
            }
        });
        let mut output = (self.factory)(lost);
        // Sounds the output is playing, and since when it has played none
        // while holding the device.
        let mut live: HashSet<u64> = HashSet::new();
        let mut idle_since: Option<Instant> = None;
        loop {
            let message = match idle_since {
                Some(since) if live.is_empty() => {
                    let left = self.options.idle_close.saturating_sub(since.elapsed());
                    match rx.recv_timeout(left) {
                        Ok(message) => message,
                        Err(RecvTimeoutError::Timeout) => {
                            output.close();
                            idle_since = None;
                            continue;
                        }
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                }
                _ => match rx.recv() {
                    Ok(message) => message,
                    Err(_) => break,
                },
            };
            match message {
                Message::Play { id, file, gain } => {
                    // Stopped or replaced before it began: nothing to start.
                    let slot = {
                        let state = self.state();
                        state
                            .running
                            .iter()
                            .find(|entry| entry.id == id && !entry.stopping)
                            .map(|entry| entry.slot)
                    };
                    let Some(slot) = slot else { continue };
                    let ended_tx = tx.clone();
                    let ended: Ended = Box::new(move || {
                        let _ = ended_tx.send(Message::Ended(id));
                    });
                    match output.play(id, &file, gain, ended) {
                        Ok(()) => {
                            live.insert(id);
                            let mut state = self.state();
                            if let Some(entry) =
                                state.running.iter_mut().find(|entry| entry.id == id)
                            {
                                entry.started_at = now_ms();
                                entry.started = Instant::now();
                                entry.confirmed = true;
                            }
                        }
                        Err(failure) => {
                            (self.options.log)(&format!(
                                "Sound {slot} could not be played: {}",
                                failure.reason()
                            ));
                            self.finish(id, false);
                        }
                    }
                }
                Message::Stop(id) => {
                    if live.remove(&id) {
                        output.stop(id);
                    }
                    self.finish(id, false);
                }
                Message::Ended(id) => {
                    if live.remove(&id) {
                        output.stop(id);
                        self.finish(id, true);
                    }
                }
                Message::Gain(gain) => output.set_gain(gain),
                Message::Lost(message) => {
                    (self.options.log)(&format!("The sound output stopped: {message}"));
                    for id in live.drain() {
                        self.finish(id, false);
                    }
                    output.close();
                    idle_since = None;
                    continue;
                }
                Message::Quit => {
                    for id in live.drain() {
                        output.stop(id);
                        self.finish(id, false);
                    }
                    break;
                }
            }
            if live.is_empty() {
                idle_since.get_or_insert_with(Instant::now);
            } else {
                idle_since = None;
            }
        }
        output.close();
    }
}

impl Player {
    /// `createPlayer(options)`: plays through this computer's default output.
    pub fn new(options: PlayerOptions) -> Player {
        Player::with_output(options, Arc::new(|lost| Box::new(RodioOutput::new(lost))))
    }

    /// A player on another output (tests record what it is asked).
    pub fn with_output(options: PlayerOptions, factory: OutputFactory) -> Player {
        Player {
            inner: Arc::new(Inner {
                options,
                factory,
                state: Mutex::new(State::default()),
            }),
        }
    }

    /// Sends to the player's thread, starting it if it is not running.
    fn tell(&self, state: &mut State, message: Message) -> Result<(), String> {
        let message = match &state.worker {
            Some(worker) => match worker.send(message) {
                Ok(()) => return Ok(()),
                // The thread is gone (it panicked): start another.
                Err(mpsc::SendError(message)) => message,
            },
            None => message,
        };
        let (tx, rx) = mpsc::channel();
        let inner = self.inner.clone();
        let worker_tx = tx.clone();
        std::thread::Builder::new()
            .name("punchboard-sounds".to_string())
            .spawn(move || inner.work(worker_tx, rx))
            .map_err(|error| error.to_string())?;
        let _ = tx.send(message);
        state.worker = Some(tx);
        Ok(())
    }

    /// Plays a slot's file, at the fader's level as it is now. A slot that
    /// is already playing is stopped first: its new sound takes its place,
    /// and only the new one's end is announced.
    ///
    /// Returns at once: the sound starts on the player's thread. A file that
    /// cannot be played is logged and announced as ended (None).
    pub fn play(&self, slot: Slot, file: &Path) -> Result<(), UserError> {
        if !cfg!(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux"
        )) {
            return Err(UserError::new(crate::i18n::say(
                "server.sounds.unsupported",
            )));
        }
        self.stop(slot);
        let level = gain_for((self.inner.options.volume)());
        let failed = {
            let mut state = self.inner.state();
            let gain = if level.is_finite() {
                level as f32
            } else {
                state.last_gain.unwrap_or(1.0)
            };
            state.next_id += 1;
            let id = state.next_id;
            let entry = Running {
                slot,
                id,
                started_at: now_ms(),
                started: Instant::now(),
                confirmed: false,
                stopping: false,
                waiters: Vec::new(),
            };
            // A slot keeps its place in the order when its sound is replaced.
            match state.running.iter_mut().find(|known| known.slot == slot) {
                Some(known) => *known = entry,
                None => state.running.push(entry),
            }
            let message = Message::Play {
                id,
                file: file.to_path_buf(),
                gain,
            };
            self.tell(&mut state, message)
                .err()
                .map(|error| (id, error))
        };
        if let Some((id, error)) = failed {
            (self.inner.options.log)(&format!("Sound {slot} could not be played: {error}"));
            self.inner.finish(id, false);
        }
        Ok(())
    }

    /// Stops a slot. Returns whether it was playing. Its end is announced
    /// (None) from the player's thread, a moment later; until then the slot
    /// still counts as playing.
    pub fn stop(&self, slot: Slot) -> bool {
        let orphan = {
            let mut state = self.inner.state();
            let Some(entry) = state.running.iter_mut().find(|entry| entry.slot == slot) else {
                return false;
            };
            entry.stopping = true;
            let id = entry.id;
            self.tell(&mut state, Message::Stop(id)).err().map(|_| id)
        };
        if let Some(id) = orphan {
            self.inner.finish(id, false);
        }
        true
    }

    /// Stops a slot and returns once it has really ended, or after 2 s.
    pub async fn stop_and_wait(&self, slot: Slot) {
        let ended = {
            let mut state = self.inner.state();
            let Some(entry) = state.running.iter_mut().find(|entry| entry.slot == slot) else {
                return;
            };
            let (tx, rx) = oneshot::channel();
            entry.waiters.push(tx);
            rx
        };
        self.stop(slot);
        let wait = tokio::time::sleep(STOP_WAIT);
        tokio::pin!(wait);
        tokio::select! {
            told = ended => {
                // Replaced in its slot before it ended: nobody tells, as in
                // player.ts, and the wait runs its 2 s.
                if told.is_err() {
                    wait.await;
                }
            }
            () = &mut wait => {}
        }
    }

    pub fn stop_all(&self) {
        for slot in self.playing() {
            self.stop(slot);
        }
    }

    /// The slots that are playing, in the order they began.
    pub fn playing(&self) -> Vec<Slot> {
        self.inner
            .state()
            .running
            .iter()
            .map(|entry| entry.slot)
            .collect()
    }

    /// When a playing slot's sound began, in ms since 1970.
    pub fn started_at(&self, slot: Slot) -> Option<u64> {
        self.inner
            .state()
            .running
            .iter()
            .find(|entry| entry.slot == slot)
            .map(|entry| entry.started_at)
    }

    /// Applies a fader move to the sounds already playing. (A sound that
    /// starts later reads `volume` itself.)
    pub fn set_volume(&self, level: f64) {
        let gain = gain_for(level);
        // A volume is a number within 0..1; anything else is not a volume at all.
        if !gain.is_finite() {
            return;
        }
        let mut state = self.inner.state();
        state.last_gain = Some(gain as f32);
        // Nothing to tell an output that was never started.
        if let Some(worker) = &state.worker {
            let _ = worker.send(Message::Gain(gain as f32));
        }
    }

    /// Stops every sound and lets go of the audio device and the thread.
    /// Does not wait for either. The player can be used again afterwards.
    pub fn dispose(&self) {
        self.stop_all();
        if let Some(worker) = self.inner.state().worker.take() {
            let _ = worker.send(Message::Quit);
        }
    }
}

// ------------------------------------------------------------ the output

/// One playing sound: the decoder's samples times a gain that can change,
/// until it is told to stop.
struct Voice<S: Source> {
    source: S,
    gain: Arc<AtomicU32>,
    stopped: Arc<AtomicBool>,
    /// The gain in use, which follows `gain` over a few milliseconds so a
    /// fader move does not click.
    current: f32,
    ended: Option<Ended>,
}

impl<S: Source> Iterator for Voice<S> {
    type Item = Sample;

    fn next(&mut self) -> Option<Sample> {
        if self.stopped.load(Ordering::Relaxed) {
            self.ended = None;
            return None;
        }
        match self.source.next() {
            Some(sample) => {
                let target = f32::from_bits(self.gain.load(Ordering::Relaxed));
                self.current += (target - self.current) * 0.005;
                Some(sample * self.current)
            }
            None => {
                if let Some(ended) = self.ended.take() {
                    ended();
                }
                None
            }
        }
    }
}

impl<S: Source> Source for Voice<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.source.current_span_len()
    }

    fn channels(&self) -> ChannelCount {
        self.source.channels()
    }

    fn sample_rate(&self) -> SampleRate {
        self.source.sample_rate()
    }

    fn total_duration(&self) -> Option<Duration> {
        self.source.total_duration()
    }
}

struct VoiceHandle {
    gain: Arc<AtomicU32>,
    stopped: Arc<AtomicBool>,
}

/// The computer's default audio output, through rodio (CoreAudio, WASAPI, ALSA).
pub struct RodioOutput {
    device: Option<MixerDeviceSink>,
    voices: HashMap<u64, VoiceHandle>,
    lost: Lost,
}

/// A gain the mixer can use.
fn safe_gain(gain: f32) -> f32 {
    if gain.is_finite() {
        gain.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

impl RodioOutput {
    pub fn new(lost: Lost) -> RodioOutput {
        RodioOutput {
            device: None,
            voices: HashMap::new(),
            lost,
        }
    }

    fn open(&mut self) -> Result<&MixerDeviceSink, PlayFailure> {
        if self.device.is_none() {
            let lost = self.lost.clone();
            let mut device = DeviceSinkBuilder::from_default_device()
                .and_then(|builder| {
                    builder
                        .with_error_callback(move |error| lost(&error.to_string()))
                        .open_sink_or_fallback()
                })
                .map_err(|error| {
                    let detail = std::error::Error::source(&error)
                        .map(|source| format!(" ({source})"))
                        .unwrap_or_default();
                    PlayFailure::Other(format!("{error}{detail}."))
                })?;
            // Closing the device when idle is meant; rodio need not say so.
            device.log_on_drop(false);
            self.device = Some(device);
        }
        self.device
            .as_ref()
            .ok_or_else(|| PlayFailure::Other("no audio device.".to_string()))
    }
}

impl Output for RodioOutput {
    fn play(&mut self, id: u64, file: &Path, gain: f32, ended: Ended) -> Result<(), PlayFailure> {
        // The whole file is read and decoded from memory: a sound is 8 MB at
        // most, nothing is spawned, and the file is let go of at once (an
        // upload can replace it while it plays).
        let data = std::fs::read(file).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => PlayFailure::Missing,
            _ => PlayFailure::Other(format!("{error}.")),
        })?;
        let length = data.len() as u64;
        let mut builder = Decoder::builder()
            .with_data(Cursor::new(data))
            .with_byte_len(length);
        if let Some(extension) = file.extension().and_then(|extension| extension.to_str()) {
            builder = builder.with_hint(extension);
        }
        let source = builder.build().map_err(|_| PlayFailure::Unreadable)?;
        let gain = safe_gain(gain);
        let handle = VoiceHandle {
            gain: Arc::new(AtomicU32::new(gain.to_bits())),
            stopped: Arc::new(AtomicBool::new(false)),
        };
        let voice = Voice {
            source,
            gain: handle.gain.clone(),
            stopped: handle.stopped.clone(),
            current: gain,
            ended: Some(ended),
        };
        self.open()?.mixer().add(voice);
        self.voices.insert(id, handle);
        Ok(())
    }

    fn set_gain(&mut self, gain: f32) {
        let bits = safe_gain(gain).to_bits();
        for voice in self.voices.values() {
            voice.gain.store(bits, Ordering::Relaxed);
        }
    }

    fn stop(&mut self, id: u64) {
        if let Some(voice) = self.voices.remove(&id) {
            voice.stopped.store(true, Ordering::Relaxed);
        }
    }

    fn close(&mut self) {
        for (_, voice) in self.voices.drain() {
            voice.stopped.store(true, Ordering::Relaxed);
        }
        self.device = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    // ------------------------------------------------------------ the fake

    #[derive(Debug, Clone, PartialEq)]
    enum Call {
        Play { id: u64, file: PathBuf, gain: f32 },
        Gain(f32),
        Stop(u64),
        Close,
    }

    /// An output that plays nothing and writes down what it was asked, and when.
    #[derive(Clone, Default)]
    struct Fake {
        calls: Arc<Mutex<Vec<(Instant, Call)>>>,
        enders: Arc<Mutex<HashMap<u64, Ended>>>,
        lost: Arc<Mutex<Option<Lost>>>,
        made: Arc<AtomicU32>,
        /// How long a sound takes to start (a cold audio device).
        start_delay: Duration,
        /// A sound ends by itself this long after it started.
        length: Option<Duration>,
        /// What every play is answered, when it is to fail.
        failure: Arc<Mutex<Option<PlayFailure>>>,
    }

    struct FakeOutput(Fake);

    impl Output for FakeOutput {
        fn play(
            &mut self,
            id: u64,
            file: &Path,
            gain: f32,
            ended: Ended,
        ) -> Result<(), PlayFailure> {
            let fake = &self.0;
            std::thread::sleep(fake.start_delay);
            fake.record(Call::Play {
                id,
                file: file.to_path_buf(),
                gain,
            });
            if let Some(failure) = fake.failure.lock().unwrap().clone() {
                return Err(failure);
            }
            match fake.length {
                Some(length) => {
                    std::thread::spawn(move || {
                        std::thread::sleep(length);
                        ended();
                    });
                }
                None => {
                    fake.enders.lock().unwrap().insert(id, ended);
                }
            }
            Ok(())
        }

        fn set_gain(&mut self, gain: f32) {
            self.0.record(Call::Gain(gain));
        }

        fn stop(&mut self, id: u64) {
            self.0.record(Call::Stop(id));
        }

        fn close(&mut self) {
            self.0.record(Call::Close);
        }
    }

    impl Fake {
        fn record(&self, call: Call) {
            self.calls.lock().unwrap().push((Instant::now(), call));
        }

        fn calls(&self) -> Vec<Call> {
            self.calls
                .lock()
                .unwrap()
                .iter()
                .map(|(_, call)| call.clone())
                .collect()
        }

        fn timed(&self) -> Vec<(Instant, Call)> {
            self.calls.lock().unwrap().clone()
        }

        fn plays(&self) -> Vec<(u64, PathBuf, f32)> {
            self.calls()
                .into_iter()
                .filter_map(|call| match call {
                    Call::Play { id, file, gain } => Some((id, file, gain)),
                    _ => None,
                })
                .collect()
        }

        /// The sound plays to its end.
        fn end(&self, id: u64) {
            let ended = self
                .enders
                .lock()
                .unwrap()
                .remove(&id)
                .expect("a playing sound");
            ended();
        }

        fn factory(&self) -> OutputFactory {
            let fake = self.clone();
            Arc::new(move |lost| {
                fake.made.fetch_add(1, Ordering::SeqCst);
                *fake.lost.lock().unwrap() = Some(lost);
                Box::new(FakeOutput(fake.clone()))
            })
        }
    }

    /// A slot, and how long it ran if it ended by itself.
    type Ending = (Slot, Option<u64>);

    #[derive(Clone, Default)]
    struct Heard {
        ended: Arc<Mutex<Vec<Ending>>>,
        log: Arc<Mutex<Vec<String>>>,
        level: Arc<Mutex<f64>>,
    }

    impl Heard {
        fn ended(&self) -> Vec<Ending> {
            self.ended.lock().unwrap().clone()
        }

        fn log(&self) -> Vec<String> {
            self.log.lock().unwrap().clone()
        }

        fn options(&self, idle_close: Duration) -> PlayerOptions {
            let (ended, log, level) = (self.ended.clone(), self.log.clone(), self.level.clone());
            PlayerOptions {
                volume: Box::new(move || *level.lock().unwrap()),
                on_ended: Box::new(move |slot, ran| ended.lock().unwrap().push((slot, ran))),
                log: Box::new(move |line| log.lock().unwrap().push(line.to_string())),
                idle_close,
            }
        }
    }

    fn setup_with(fake: Fake, idle_close: Duration) -> (Player, Fake, Heard) {
        let heard = Heard::default();
        *heard.level.lock().unwrap() = 1.0;
        let player = Player::with_output(heard.options(idle_close), fake.factory());
        (player, fake, heard)
    }

    fn setup() -> (Player, Fake, Heard) {
        setup_with(Fake::default(), Duration::from_secs(60))
    }

    /// Waits (2 s at most) for something the player's thread is about to do.
    fn until(what: &str, done: impl Fn() -> bool) {
        let asked = Instant::now();
        while !done() {
            assert!(
                asked.elapsed() < Duration::from_secs(2),
                "never happened: {what}"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    /// Lets the player's thread do what it was sent, and a little more time
    /// for what it must not do.
    fn settle() {
        std::thread::sleep(Duration::from_millis(60));
    }

    const FILE: &str = "/sounds/sound-1.wav";

    // ---------------------------------------------------------------- gain

    #[test]
    fn gain_is_the_typescript_gain() {
        let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/sound/gain.json");
        let cases: Vec<Value> =
            serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
        let number = |value: &Value| {
            f64::from_bits(u64::from_str_radix(value.as_str().unwrap(), 16).unwrap())
        };
        for case in &cases {
            let level = number(&case["input"]);
            let expected = number(&case["output"]);
            let gain = gain_for(level);
            assert!(
                gain.to_bits() == expected.to_bits() || (gain.is_nan() && expected.is_nan()),
                "gain_for({level}) is {gain}, the TypeScript gives {expected}"
            );
        }
        assert!(cases.len() > 1000);
    }

    // ------------------------------------------------------------- playing

    #[test]
    fn a_press_plays_the_file_at_the_faders_gain() {
        let (player, fake, heard) = setup();
        *heard.level.lock().unwrap() = 0.5;
        // The path reaches the output as it is: nothing is quoted or escaped
        // on the way (player.ts had to make a file URI of it for PowerShell).
        let file = Path::new("C:\\Sounds\\it’s #1 50%.wav");
        let before = now_ms();
        player.play(3, file).unwrap();
        // Known as playing at once, before the output has started it.
        assert_eq!(player.playing(), vec![3]);
        let ordered = player.started_at(3).expect("a start time");
        assert!(ordered >= before && ordered <= now_ms());
        until("the play", || fake.plays().len() == 1);
        assert_eq!(fake.plays(), vec![(1, file.to_path_buf(), 0.25)]);
        assert_eq!(fake.made.load(Ordering::SeqCst), 1);
        assert!(heard.ended().is_empty() && heard.log().is_empty());
        assert_eq!(player.started_at(4), None);
    }

    #[test]
    fn nothing_is_opened_until_a_sound_plays() {
        let (player, fake, heard) = setup();
        player.set_volume(0.3);
        assert!(!player.stop(1));
        player.stop_all();
        assert!(player.playing().is_empty());
        settle();
        assert_eq!(fake.made.load(Ordering::SeqCst), 0);
        assert!(fake.calls().is_empty() && heard.ended().is_empty());
        player.dispose();
        settle();
        assert_eq!(fake.made.load(Ordering::SeqCst), 0);
    }

    /// "Mac: a sound's run time counts from when the helper started it."
    #[test]
    fn run_time_counts_from_when_the_output_started_the_sound() {
        let fake = Fake {
            start_delay: Duration::from_millis(300),
            length: Some(Duration::from_millis(100)),
            ..Fake::default()
        };
        let (player, _fake, heard) = setup_with(fake, Duration::from_secs(60));
        let ordered_at = now_ms();
        player.play(1, Path::new(FILE)).unwrap();
        let ordered = player.started_at(1).unwrap();
        until("the start", || {
            player
                .started_at(1)
                .is_some_and(|at| at >= ordered_at + 290)
        });
        assert!(
            ordered < ordered_at + 100,
            "the first start time is the order's"
        );
        until("the end", || !heard.ended().is_empty());
        let ended = heard.ended();
        assert_eq!(ended.len(), 1);
        let (slot, ran) = ended[0];
        assert_eq!(slot, 1);
        let ran = ran.expect("it ended by itself");
        assert!((95..290).contains(&ran), "ran {ran} ms");
        assert!(player.playing().is_empty() && player.started_at(1).is_none());
    }

    #[test]
    fn a_sound_that_ends_by_itself_is_announced_with_its_run_time() {
        let (player, fake, heard) = setup();
        player.play(2, Path::new(FILE)).unwrap();
        until("the play", || fake.plays().len() == 1);
        std::thread::sleep(Duration::from_millis(40));
        fake.end(1);
        until("the end", || !heard.ended().is_empty());
        let ended = heard.ended();
        assert_eq!(ended.len(), 1);
        assert!(
            ended[0].0 == 2 && ended[0].1.is_some_and(|ran| (40..1000).contains(&ran)),
            "{ended:?}"
        );
        assert!(player.playing().is_empty());
        // The output is told to let go of it.
        assert_eq!(fake.calls().last(), Some(&Call::Stop(1)));
        assert!(!player.stop(2));
    }

    #[test]
    fn a_second_press_stops_the_sound_and_says_so_with_no_run_time() {
        let (player, fake, heard) = setup();
        player.play(1, Path::new(FILE)).unwrap();
        until("the play", || fake.plays().len() == 1);
        // events.ts: `if (player.stop(slot)) return`.
        assert!(player.stop(1));
        until("the end", || !heard.ended().is_empty());
        assert_eq!(heard.ended(), vec![(1, None)]);
        assert!(player.playing().is_empty());
        assert_eq!(fake.calls()[1..], [Call::Stop(1)]);
        assert!(!player.stop(1));
        settle();
        assert_eq!(heard.ended().len(), 1);
    }

    #[test]
    fn a_sound_stopped_before_it_started_never_plays() {
        let fake = Fake {
            start_delay: Duration::from_millis(100),
            ..Fake::default()
        };
        let (player, fake, heard) = setup_with(fake, Duration::from_secs(60));
        player.play(1, Path::new(FILE)).unwrap();
        player.play(2, Path::new(FILE)).unwrap();
        // Slot 2 waits behind slot 1's slow start, and is stopped meanwhile.
        assert!(player.stop(2));
        assert_eq!(player.playing(), vec![1, 2]);
        until("the end", || !heard.ended().is_empty());
        assert_eq!(heard.ended(), vec![(2, None)]);
        assert_eq!(fake.plays().len(), 1);
        assert_eq!(player.playing(), vec![1]);
    }

    #[test]
    fn the_same_slot_again_replaces_its_sound_and_only_the_new_one_is_announced() {
        let (player, fake, heard) = setup();
        player.play(1, Path::new("/sounds/sound-1.wav")).unwrap();
        player.play(2, Path::new("/sounds/sound-2.wav")).unwrap();
        until("the plays", || fake.plays().len() == 2);
        player.play(1, Path::new("/sounds/sound-1.mp3")).unwrap();
        // The slot keeps its place in the order.
        assert_eq!(player.playing(), vec![1, 2]);
        until("the third play", || fake.plays().len() == 3);
        let calls = fake.calls();
        assert_eq!(calls[2], Call::Stop(1));
        assert_eq!(
            calls[3],
            Call::Play {
                id: 3,
                file: PathBuf::from("/sounds/sound-1.mp3"),
                gain: 1.0
            }
        );
        settle();
        // The replaced sound ended unannounced.
        assert!(heard.ended().is_empty());
        fake.end(3);
        until("the end", || !heard.ended().is_empty());
        assert_eq!(heard.ended().len(), 1);
        assert_eq!(heard.ended()[0].0, 1);
        assert!(heard.ended()[0].1.is_some());
        assert_eq!(player.playing(), vec![2]);
    }

    #[test]
    fn slots_overlap_and_end_each_on_its_own() {
        let (player, fake, heard) = setup();
        for slot in [4, 1, 8] {
            player.play(slot, Path::new(FILE)).unwrap();
        }
        until("the plays", || fake.plays().len() == 3);
        assert_eq!(player.playing(), vec![4, 1, 8]);
        // No sound was stopped to make room for another.
        assert!(fake
            .calls()
            .iter()
            .all(|call| matches!(call, Call::Play { .. })));
        fake.end(2);
        until("the end", || heard.ended().len() == 1);
        assert_eq!(heard.ended()[0].0, 1);
        assert_eq!(player.playing(), vec![4, 8]);
        player.stop_all();
        until("the ends", || heard.ended().len() == 3);
        assert_eq!(heard.ended()[1..], [(4, None), (8, None)]);
        assert!(player.playing().is_empty());
    }

    #[test]
    fn a_fader_move_reaches_what_is_playing_and_the_next_sound_reads_the_fader() {
        let (player, fake, heard) = setup();
        player.play(1, Path::new(FILE)).unwrap();
        until("the play", || fake.plays().len() == 1);
        player.set_volume(0.5);
        player.set_volume(2.0);
        player.set_volume(f64::NAN);
        player.set_volume(-1.0);
        until("the gains", || fake.calls().len() == 4);
        assert_eq!(
            fake.calls()[1..],
            [Call::Gain(0.25), Call::Gain(1.0), Call::Gain(0.0)]
        );
        *heard.level.lock().unwrap() = 0.1;
        player.play(2, Path::new(FILE)).unwrap();
        until("the play", || fake.plays().len() == 2);
        assert_eq!(fake.plays()[1].2, gain_for(0.1) as f32);
        // A level that is not a number: the last gain a fader move set.
        *heard.level.lock().unwrap() = f64::NAN;
        player.play(3, Path::new(FILE)).unwrap();
        until("the play", || fake.plays().len() == 3);
        assert_eq!(fake.plays()[2].2, 0.0);
    }

    // ------------------------------------------------------ what goes wrong

    /// "A sound whose length never shows exits instead of pretending to play."
    #[test]
    fn a_file_that_cannot_be_played_is_logged_and_ends_with_no_run_time() {
        for (failure, line) in [
            (
                PlayFailure::Unreadable,
                "Sound 5 could not be played: the file could not be opened.",
            ),
            (
                PlayFailure::Missing,
                "Sound 5 could not be played: its file is missing.",
            ),
            (
                PlayFailure::Other("no device.".into()),
                "Sound 5 could not be played: no device.",
            ),
        ] {
            let (player, fake, heard) = setup();
            *fake.failure.lock().unwrap() = Some(failure);
            player.play(5, Path::new(FILE)).unwrap();
            until("the end", || !heard.ended().is_empty());
            assert_eq!(heard.ended(), vec![(5, None)]);
            assert_eq!(heard.log(), vec![line.to_string()]);
            assert!(player.playing().is_empty());
        }
    }

    /// "Mac: a press sent to a helper that died at start still plays" and "is
    /// not respawned on every press": there is no helper to die any more.
    /// What is left of them: an output that cannot start a sound is asked
    /// once per press, by the one thread, and works again when it can.
    #[test]
    fn an_output_that_fails_is_asked_once_per_press_and_recovers() {
        let (player, fake, heard) = setup();
        *fake.failure.lock().unwrap() = Some(PlayFailure::Other(
            "Could not find any output device.".into(),
        ));
        for slot in [2, 3, 4] {
            player.play(slot, Path::new(FILE)).unwrap();
        }
        until("the ends", || heard.ended().len() == 3);
        assert_eq!(heard.ended(), vec![(2, None), (3, None), (4, None)]);
        assert_eq!(fake.plays().len(), 3);
        assert_eq!(fake.made.load(Ordering::SeqCst), 1);
        assert_eq!(heard.log().len(), 3);
        *fake.failure.lock().unwrap() = None;
        player.play(2, Path::new(FILE)).unwrap();
        until("the play", || fake.plays().len() == 4);
        settle();
        assert_eq!(player.playing(), vec![2]);
        assert_eq!(heard.ended().len(), 3);
    }

    #[test]
    fn a_lost_device_ends_what_was_playing() {
        let (player, fake, heard) = setup();
        player.play(1, Path::new(FILE)).unwrap();
        player.play(2, Path::new(FILE)).unwrap();
        until("the plays", || fake.plays().len() == 2);
        let lost = fake
            .lost
            .lock()
            .unwrap()
            .clone()
            .expect("the output was made");
        lost("the device is no longer available");
        until("the ends", || heard.ended().len() == 2);
        let mut ended = heard.ended();
        ended.sort();
        assert_eq!(ended, vec![(1, None), (2, None)]);
        assert_eq!(
            heard.log(),
            vec!["The sound output stopped: the device is no longer available".to_string()]
        );
        assert_eq!(fake.calls().last(), Some(&Call::Close));
        // The next press opens it again.
        player.play(1, Path::new(FILE)).unwrap();
        until("the play", || fake.plays().len() == 3);
        assert_eq!(player.playing(), vec![1]);
    }

    // ------------------------------------------------- the device when idle

    #[test]
    fn the_device_is_let_go_of_after_a_while_with_nothing_playing() {
        let (player, fake, heard) = setup_with(Fake::default(), Duration::from_millis(150));
        player.play(1, Path::new(FILE)).unwrap();
        until("the play", || fake.plays().len() == 1);
        // Not while a sound plays, however long.
        std::thread::sleep(Duration::from_millis(300));
        assert!(!fake.calls().contains(&Call::Close));
        fake.end(1);
        until("the end", || heard.ended().len() == 1);
        // A press within the idle time finds the device open.
        std::thread::sleep(Duration::from_millis(60));
        player.play(1, Path::new(FILE)).unwrap();
        until("the play", || fake.plays().len() == 2);
        assert!(!fake.calls().contains(&Call::Close));
        player.stop(1);
        until("the close", || fake.calls().contains(&Call::Close));
        let timed = fake.timed();
        let stopped = timed
            .iter()
            .rev()
            .find(|(_, call)| matches!(call, Call::Stop(_)))
            .unwrap()
            .0;
        let closed = timed.last().unwrap();
        assert_eq!(closed.1, Call::Close);
        let waited = closed.0.duration_since(stopped);
        assert!(
            waited >= Duration::from_millis(140) && waited < Duration::from_millis(600),
            "{waited:?}"
        );
        // Closed once, and not again while nothing happens.
        std::thread::sleep(Duration::from_millis(350));
        assert_eq!(
            fake.calls()
                .iter()
                .filter(|call| **call == Call::Close)
                .count(),
            1
        );
        // The next press plays all the same.
        player.play(7, Path::new(FILE)).unwrap();
        until("the play", || fake.plays().len() == 3);
        assert_eq!(fake.made.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn dispose_stops_everything_and_closes_and_the_player_still_works_after() {
        let (player, fake, heard) = setup();
        player.play(1, Path::new(FILE)).unwrap();
        player.play(2, Path::new(FILE)).unwrap();
        until("the plays", || fake.plays().len() == 2);
        player.dispose();
        until("the close", || fake.calls().contains(&Call::Close));
        assert_eq!(heard.ended(), vec![(1, None), (2, None)]);
        assert_eq!(
            fake.calls()[2..],
            [Call::Stop(1), Call::Stop(2), Call::Close]
        );
        assert!(player.playing().is_empty());
        player.dispose();
        player.play(1, Path::new(FILE)).unwrap();
        until("the play", || fake.plays().len() == 3);
        assert_eq!(fake.made.load(Ordering::SeqCst), 2);
    }

    // -------------------------------------------------------- stop_and_wait

    /// "Replacing a playing slot stops the old sound" / "Restoring a playing
    /// slot stops it": the routes wait on this before they touch the file.
    #[tokio::test]
    async fn stop_and_wait_returns_once_the_sound_has_ended() {
        let (player, fake, heard) = setup();
        player.stop_and_wait(4).await; // nothing playing: at once
        player.play(4, Path::new(FILE)).unwrap();
        until("the play", || fake.plays().len() == 1);
        let asked = Instant::now();
        player.stop_and_wait(4).await;
        assert!(asked.elapsed() < Duration::from_millis(500));
        // Ended for real by the time it returns: not playing, and announced
        // with no run time, so the new file is not taught the old one's length.
        assert!(player.playing().is_empty());
        assert!(fake.calls().contains(&Call::Stop(1)));
        until("the end", || !heard.ended().is_empty());
        assert_eq!(heard.ended(), vec![(4, None)]);
    }

    #[tokio::test]
    async fn stop_and_wait_gives_up_after_two_seconds() {
        // An output so slow to start that the stop cannot be done in time.
        let fake = Fake {
            start_delay: Duration::from_millis(2600),
            ..Fake::default()
        };
        let (player, _fake, heard) = setup_with(fake, Duration::from_secs(60));
        player.play(1, Path::new(FILE)).unwrap();
        player.play(2, Path::new(FILE)).unwrap();
        let asked = Instant::now();
        player.stop_and_wait(2).await;
        let waited = asked.elapsed();
        assert!(
            waited >= Duration::from_millis(1950) && waited < Duration::from_millis(2500),
            "{waited:?}"
        );
        assert!(heard.ended().is_empty());
    }

    // ------------------------------------------------------ the real output

    fn silent_wav(ms: u32) -> Vec<u8> {
        let rate = 44_100u32;
        let data = vec![0u8; (rate * ms / 1000) as usize * 2];
        let mut out = b"RIFF".to_vec();
        out.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&rate.to_le_bytes());
        out.extend_from_slice(&(rate * 2).to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend(data);
        out
    }

    fn silent_mp3(frames: usize) -> Vec<u8> {
        let mut out = Vec::new();
        for _ in 0..frames {
            let mut frame = vec![0u8; 417];
            frame[..4].copy_from_slice(&[0xff, 0xfb, 0x90, 0x64]);
            out.extend(frame);
        }
        out
    }

    /// The real output refuses what it cannot play before it opens any
    /// device, so this runs on a machine with no sound at all.
    #[test]
    fn the_real_output_refuses_missing_and_unreadable_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut output = RodioOutput::new(Arc::new(|_| {}));
        let missing = output.play(1, &dir.path().join("sound-1.wav"), 0.0, Box::new(|| {}));
        assert_eq!(missing, Err(PlayFailure::Missing));
        for (name, data) in [
            ("noise.wav", b"RIFF is not what this is".to_vec()),
            ("empty.mp3", Vec::new()),
            ("text.mp3", vec![b'x'; 5000]),
        ] {
            let file = dir.path().join(name);
            std::fs::write(&file, data).unwrap();
            let refused = output.play(2, &file, 0.0, Box::new(|| {}));
            assert_eq!(refused, Err(PlayFailure::Unreadable), "{name}");
        }
        assert!(output.device.is_none() && output.voices.is_empty());
        output.close();
    }

    /// The decoders built in read what the store accepts: a WAV and an MP3,
    /// to their ends, with nothing but silence in them. No device is opened.
    #[test]
    fn wav_and_mp3_decode_to_silence_of_the_right_length() {
        for (hint, data, rate, samples) in [
            ("wav", silent_wav(50), 44_100, 2205..=2205),
            ("mp3", silent_mp3(20), 44_100, 18 * 1152..=20 * 1152 * 2),
        ] {
            let length = data.len() as u64;
            let decoder = Decoder::builder()
                .with_data(Cursor::new(data))
                .with_byte_len(length)
                .with_hint(hint)
                .build()
                .unwrap_or_else(|error| panic!("{hint}: {error}"));
            assert_eq!(decoder.sample_rate().get(), rate, "{hint}");
            let ended = Arc::new(AtomicU32::new(0));
            let counted = ended.clone();
            let voice = Voice {
                source: decoder,
                gain: Arc::new(AtomicU32::new(1f32.to_bits())),
                stopped: Arc::new(AtomicBool::new(false)),
                current: 1.0,
                ended: Some(Box::new(move || {
                    counted.fetch_add(1, Ordering::SeqCst);
                })),
            };
            let mut voice = voice;
            let mut count = 0;
            for sample in voice.by_ref() {
                assert_eq!(sample, 0.0, "{hint}");
                count += 1;
            }
            assert!(samples.contains(&count), "{hint}: {count} samples");
            assert!(voice.next().is_none());
            assert_eq!(
                ended.load(Ordering::SeqCst),
                1,
                "{hint}: told once that it ended"
            );
        }
    }

    #[test]
    fn a_voice_follows_its_gain_and_stops_when_told_without_saying_it_ended() {
        let source = rodio::buffer::SamplesBuffer::new(
            ChannelCount::new(1).unwrap(),
            SampleRate::new(8000).unwrap(),
            vec![1.0f32; 8000],
        );
        let gain = Arc::new(AtomicU32::new(0.25f32.to_bits()));
        let stopped = Arc::new(AtomicBool::new(false));
        let ended = Arc::new(AtomicU32::new(0));
        let counted = ended.clone();
        let mut voice = Voice {
            source,
            gain: gain.clone(),
            stopped: stopped.clone(),
            current: 0.25,
            ended: Some(Box::new(move || {
                counted.fetch_add(1, Ordering::SeqCst);
            })),
        };
        // It starts at its gain: not one sample louder.
        assert_eq!(voice.next(), Some(0.25));
        gain.store(0f32.to_bits(), Ordering::Relaxed);
        let first = voice.next().unwrap();
        assert!(first < 0.25 && first > 0.24, "no jump: {first}");
        let later = voice.by_ref().take(4000).last().unwrap();
        assert!(later < 0.001, "silent within half a second: {later}");
        stopped.store(true, Ordering::Relaxed);
        assert_eq!(voice.next(), None);
        assert_eq!(ended.load(Ordering::SeqCst), 0);
    }

    /// The one check that opens this computer's audio output: 50 ms of
    /// silence, at gain 0. Ignored by default, since a machine without an
    /// audio device (CI, the Linux container) has nothing to open.
    ///   cargo test real_output_plays_silence -- --ignored --nocapture
    #[test]
    #[ignore = "needs an audio device"]
    fn real_output_plays_silence() {
        let dir = tempfile::tempdir().unwrap();
        let heard = Heard::default();
        let player = Player::new(heard.options(Duration::from_millis(300)));
        for (slot, name, data, length) in [
            (1u8, "sound-1.wav", silent_wav(50), 50u64),
            (2u8, "sound-2.mp3", silent_mp3(4), 104),
        ] {
            let file = dir.path().join(name);
            std::fs::write(&file, data).unwrap();
            let asked = Instant::now();
            player.play(slot, &file).unwrap();
            let ordered = player.started_at(slot).unwrap();
            until("the end", || {
                heard.ended().iter().any(|(ended, _)| *ended == slot)
            });
            let ran = heard
                .ended()
                .iter()
                .find(|(ended, _)| *ended == slot)
                .unwrap()
                .1;
            eprintln!(
                "{name}: {length} ms of silence ran {ran:?} ms, announced {:?} after the press (ordered at {ordered})",
                asked.elapsed()
            );
            assert!(heard.log().is_empty(), "{:?}", heard.log());
            let ran = ran.expect("it played to its end");
            assert!(ran + 60 >= length && ran < length + 400, "ran {ran} ms");
        }
        // Stopping a long one, then the device closes when idle.
        let file = dir.path().join("sound-3.wav");
        std::fs::write(&file, silent_wav(5000)).unwrap();
        player.play(3, &file).unwrap();
        std::thread::sleep(Duration::from_millis(150));
        player.set_volume(0.0);
        assert!(player.stop(3));
        until("the stop", || heard.ended().len() == 3);
        assert_eq!(heard.ended()[2], (3, None));
        std::thread::sleep(Duration::from_millis(500));
        player.dispose();
        assert!(heard.log().is_empty(), "{:?}", heard.log());
    }
}
