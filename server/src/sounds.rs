//! The eight sound slots on disk: built-in tones generated on first run, and
//! the WAV or MP3 files people upload to replace them.
//!
//! A port of `src/server/sounds.ts`: the same file names, the same
//! `sounds.json`, the same tones byte for byte, and the same reading of a
//! file's own structure to tell what it is and how long it lasts.

use std::borrow::Cow;
use std::fs;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::{Map, Value};
use unicode_normalization::UnicodeNormalization;
use unicode_properties::{GeneralCategoryGroup, UnicodeGeneralCategory};

use crate::model::actions::LIMITS;
use crate::model::js;
use crate::store::{
    is_object, iso_from_millis, iso_now, js_to_number, read_json_safe, write_json_atomic,
};

/// A sound slot's number: 1 to `LIMITS.sound_slots`.
pub type Slot = u8;

const SAMPLE_RATE: u32 = 44100;
const DURATION_S: f64 = 0.35;

/// A short 16-bit PCM mono tone, written directly so no audio files ship.
///
/// The sine and the power that gives each slot its pitch come from `libm`,
/// which is the same arithmetic on every system (and the same as Node's), so
/// the tones are the same bytes everywhere.
fn tone_buffer(freq_hz: f64) -> Vec<u8> {
    let num_samples = (f64::from(SAMPLE_RATE) * DURATION_S).floor() as usize;
    let data_length = (num_samples * 2) as u32;
    let mut out = Vec::with_capacity(44 + num_samples * 2);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_length).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    out.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_length.to_le_bytes());
    for i in 0..num_samples {
        let t = i as f64 / f64::from(SAMPLE_RATE);
        // An envelope, so the tone does not click at its edges.
        let envelope = js::min(1.0, t * 40.0) * js::min(1.0, (DURATION_S - t) * 40.0);
        let sample = libm::sin(2.0 * std::f64::consts::PI * freq_hz * t) * envelope * 0.35;
        let value = js::max(-32767.0, js::min(32767.0, js::round(sample * 32767.0)));
        out.extend_from_slice(&(value as i16).to_le_bytes());
    }
    out
}

/// What an upload says it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioType {
    /// `audio/wav`
    Wav,
    /// `audio/mpeg`
    Mpeg,
}

impl AudioType {
    pub fn mime(self) -> &'static str {
        match self {
            AudioType::Wav => "audio/wav",
            AudioType::Mpeg => "audio/mpeg",
        }
    }
}

/// The extension of a slot's file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Extension {
    Wav,
    Mp3,
}

impl Extension {
    pub fn as_str(self) -> &'static str {
        match self {
            Extension::Wav => "wav",
            Extension::Mp3 => "mp3",
        }
    }

    fn other(self) -> Extension {
        match self {
            Extension::Wav => Extension::Mp3,
            Extension::Mp3 => Extension::Wav,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
struct SoundEntry {
    ext: Extension,
    name: String,
    uploaded_at: Option<String>,
    /// Learned from a full play, for an MP3 whose length cannot be read.
    duration_ms: Option<f64>,
}

/// A number as JSON holds it: whole numbers without a fraction.
fn number_value(number: f64) -> Value {
    if number.fract() == 0.0 && number.abs() < 9_007_199_254_740_992.0 {
        Value::from(number as i64)
    } else {
        serde_json::Number::from_f64(number).map_or(Value::Null, Value::Number)
    }
}

impl SoundEntry {
    fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("ext".into(), Value::from(self.ext.as_str()));
        map.insert("name".into(), Value::from(self.name.clone()));
        if let Some(at) = &self.uploaded_at {
            map.insert("uploadedAt".into(), Value::from(at.clone()));
        }
        if let Some(ms) = self.duration_ms {
            map.insert("durationMs".into(), number_value(ms));
        }
        Value::Object(map)
    }
}

/// Reads bytes at a position, fewer at the end: from a buffer or an open file.
enum Reader<'a> {
    Bytes(&'a [u8]),
    File(&'a fs::File, u64),
}

impl Reader<'_> {
    fn size(&self) -> u64 {
        match self {
            Reader::Bytes(data) => data.len() as u64,
            Reader::File(_, size) => *size,
        }
    }

    /// `length` bytes at `position`, or as many as there are. None if the
    /// file cannot be read.
    fn read(&self, position: u64, length: usize) -> Option<Cow<'_, [u8]>> {
        match self {
            Reader::Bytes(data) => {
                let start = usize::try_from(position).map_or(data.len(), |at| at.min(data.len()));
                let end = start.saturating_add(length).min(data.len());
                Some(Cow::Borrowed(&data[start..end]))
            }
            Reader::File(file, size) => {
                let wanted = (length as u64).min(size.saturating_sub(position)) as usize;
                let mut buffer = vec![0u8; wanted];
                if wanted > 0 {
                    let mut handle = *file;
                    handle.seek(SeekFrom::Start(position)).ok()?;
                    let mut filled = 0;
                    while filled < wanted {
                        match handle.read(&mut buffer[filled..]) {
                            Ok(0) => break,
                            Ok(count) => filled += count,
                            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                            Err(_) => return None,
                        }
                    }
                    buffer.truncate(filled);
                }
                Some(Cow::Owned(buffer))
            }
        }
    }
}

/// Runs `parse` on a file opened for reading; any failure is None.
fn with_file<T>(file: &Path, parse: impl FnOnce(&Reader) -> Option<T>) -> Option<T> {
    let handle = fs::File::open(file).ok()?;
    let size = handle.metadata().ok()?.len();
    parse(&Reader::File(&handle, size))
}

struct WavInfo {
    byte_rate: u32,
    data_bytes: u64,
}

fn u16_le(data: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([data[at], data[at + 1]])
}

fn u32_le(data: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]])
}

/// A WAV's format and data chunks. Chunks are walked rather than assumed at
/// fixed offsets, since editors add LIST chunks (album art can be large).
fn wav_info(reader: &Reader) -> Option<WavInfo> {
    let size = reader.size();
    let head = reader.read(0, 12)?;
    if head.len() < 12 || &head[0..4] != b"RIFF" || &head[8..12] != b"WAVE" {
        return None;
    }
    let mut fmt: Option<Vec<u8>> = None;
    let mut offset: u64 = 12;
    let mut chunks = 0;
    while offset + 8 <= size && chunks < 1000 {
        let chunk = reader.read(offset, 8)?;
        if chunk.len() < 8 {
            return None;
        }
        let id = &chunk[0..4];
        let length = u32_le(&chunk, 4);
        if id == b"fmt " {
            if length < 16 {
                return None;
            }
            let found = reader.read(offset + 8, 16)?;
            if found.len() < 16 {
                return None;
            }
            fmt = Some(found.into_owned());
        }
        if id == b"data" {
            let fmt = fmt.as_ref()?;
            let channels = u16_le(fmt, 2);
            let sample_rate = u32_le(fmt, 4);
            let byte_rate = u32_le(fmt, 8);
            let block_align = u16_le(fmt, 12);
            if channels == 0 || sample_rate == 0 || byte_rate == 0 || block_align == 0 {
                return None;
            }
            // A streaming writer may leave the size blank; the file's tail is the data then.
            let tail = size - offset - 8;
            let data_bytes = if length != 0 && length != 0xffff_ffff {
                u64::from(length).min(tail)
            } else {
                tail
            };
            return (data_bytes > 0).then_some(WavInfo {
                byte_rate,
                data_bytes,
            });
        }
        offset += 8 + u64::from(length) + u64::from(length % 2);
        chunks += 1;
    }
    None
}

/// Where the audio starts past the ID3v2 tags in front (a file can carry
/// more than one). A tag's size is a 28-bit "syncsafe" number, plus a
/// 10-byte footer when its flags say so. None if a tag is malformed.
fn audio_start(reader: &Reader) -> Option<u64> {
    let mut offset: u64 = 0;
    for _ in 0..8 {
        let header = reader.read(offset, 10)?;
        if header.len() < 10 || &header[0..3] != b"ID3" {
            return Some(offset);
        }
        if (header[6] | header[7] | header[8] | header[9]) & 0x80 != 0 {
            return None;
        }
        let footer = if header[5] & 0x10 != 0 { 10 } else { 0 };
        let size = (u64::from(header[6]) << 21)
            | (u64::from(header[7]) << 14)
            | (u64::from(header[8]) << 7)
            | u64::from(header[9]);
        offset += 10 + footer + size;
    }
    Some(offset)
}

const MP3_BITRATES_V1: [u32; 15] = [
    0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
];
const MP3_BITRATES_V2: [u32; 15] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
/// How far past the tags the first frame is looked for (encoders may pad).
const FRAME_SEARCH: usize = 4096;
/// The longest Layer III frame: 320 kbps at 32 kHz, padded.
const LONGEST_FRAME: usize = 1441;

/// A Layer III frame header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mp3Frame {
    /// Where the frame starts in the buffer searched, and its size in bytes.
    pub at: usize,
    pub length: usize,
    pub bitrate: u32,
    pub sample_rate: u32,
    pub samples_per_frame: u32,
    pub xing_frames: Option<u32>,
}

/// Reads the first Layer III frame header at or after `start`. Exposed for tests.
pub fn mp3_frame(data: &[u8], start: usize) -> Option<Mp3Frame> {
    let mut i = start;
    while i + 4 <= data.len() && i < start + FRAME_SEARCH {
        let at = i;
        i += 1;
        let b1 = data[at + 1];
        if data[at] != 0xff || (b1 & 0xe0) != 0xe0 {
            continue;
        }
        let version = (b1 >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
        let layer = (b1 >> 1) & 3; // 1 = Layer III
        if version == 1 || layer != 1 {
            continue;
        }
        let b2 = data[at + 2];
        let bitrate_index = usize::from(b2 >> 4);
        let rate_index = usize::from((b2 >> 2) & 3);
        if bitrate_index == 0 || bitrate_index == 15 || rate_index == 3 {
            continue;
        }
        let bitrate = if version == 3 {
            MP3_BITRATES_V1
        } else {
            MP3_BITRATES_V2
        }[bitrate_index]
            * 1000;
        let sample_rate = match version {
            3 => [44100, 48000, 32000],
            2 => [22050, 24000, 16000],
            _ => [11025, 12000, 8000],
        }[rate_index];
        let samples_per_frame: u32 = if version == 3 { 1152 } else { 576 };
        // Whole numbers throughout, so this is the floor the TypeScript takes.
        let length =
            ((samples_per_frame / 8) * bitrate / sample_rate) as usize + usize::from((b2 >> 1) & 1);
        let mono = ((data[at + 3] >> 6) & 3) == 3;
        // The Xing/Info header follows the side info, whose size depends on version and channels.
        let side_info = match (version == 3, mono) {
            (true, true) => 17,
            (true, false) => 32,
            (false, true) => 9,
            (false, false) => 17,
        };
        let tag = at + 4 + side_info;
        let mut xing_frames = None;
        if tag + 12 <= data.len() {
            let name = &data[tag..tag + 4];
            if (name == b"Xing" || name == b"Info") && data[tag + 7] & 1 != 0 {
                xing_frames = Some(u32::from_be_bytes([
                    data[tag + 8],
                    data[tag + 9],
                    data[tag + 10],
                    data[tag + 11],
                ]));
            }
        }
        return Some(Mp3Frame {
            at,
            length,
            bitrate,
            sample_rate,
            samples_per_frame,
            xing_frames,
        });
    }
    None
}

/// An MP3's first real frame, past any ID3 tags: one whose end is where the
/// next frame starts (or the end of the file), so stray sync bytes do not
/// count. The number is its place in the file.
fn first_mp3_frame(reader: &Reader) -> Option<(Mp3Frame, u64)> {
    let size = reader.size();
    let offset = audio_start(reader)?;
    if offset >= size {
        return None;
    }
    // Read at the frame, not from the file's start: album art makes tags large.
    let head = reader.read(offset, FRAME_SEARCH + 2 * LONGEST_FRAME + 4)?;
    let mut from = 0;
    loop {
        let frame = mp3_frame(&head, from)?;
        if frame.at >= FRAME_SEARCH {
            return None;
        }
        let next = frame.at + frame.length;
        let ends = offset + next as u64 >= size;
        let followed = !ends && mp3_frame(&head, next).is_some_and(|found| found.at == next);
        if offset + next as u64 <= size && (ends || followed) {
            return Some((frame, offset + frame.at as u64));
        }
        from = frame.at + 1;
    }
}

/// An MP3's length from its first frame: a Xing/Info header gives the
/// frame count (VBR), otherwise the bitrate is taken as constant. Layer III
/// only, which is what an .mp3 is; anything odd returns None.
fn mp3_duration(reader: &Reader) -> Option<f64> {
    let (frame, offset) = first_mp3_frame(reader)?;
    if let Some(frames) = frame.xing_frames.filter(|&frames| frames != 0) {
        let seconds =
            f64::from(frames) * f64::from(frame.samples_per_frame) / f64::from(frame.sample_rate);
        return Some(js::round(seconds * 1000.0));
    }
    let seconds = (reader.size() - offset) as f64 * 8.0 / f64::from(frame.bitrate);
    Some(js::round(seconds * 1000.0))
}

/// An MP3 file's length in milliseconds, or None. Exposed for tests.
pub fn mp3_duration_ms(file: &Path) -> Option<f64> {
    with_file(file, mp3_duration)
}

/// A WAV file's length from its header: data bytes over the byte rate. Exposed for tests.
pub fn wav_duration_ms(file: &Path) -> Option<f64> {
    with_file(file, |reader| {
        let info = wav_info(reader)?;
        Some(js::round(
            (info.data_bytes as f64 / f64::from(info.byte_rate)) * 1000.0,
        ))
    })
}

/// Checks the file's own structure rather than trusting its extension or
/// first bytes: a WAV needs its format and data chunks, an MP3 a real
/// Layer III frame after any ID3 tags.
pub fn is_audio(data: &[u8], kind: AudioType) -> bool {
    let reader = Reader::Bytes(data);
    match kind {
        AudioType::Wav => wav_info(&reader).is_some(),
        AudioType::Mpeg => first_mp3_frame(&reader).is_some(),
    }
}

/// `decodeURIComponent`: None where JavaScript throws (a `%` that is not
/// followed by two hex digits, or bytes that are not UTF-8).
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let pair = bytes.get(i + 1..i + 3)?;
            let high = (pair[0] as char).to_digit(16)?;
            let low = (pair[1] as char).to_digit(16)?;
            out.push((high * 16 + low) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Only ever shown back to the user; the file on disk is always sound-N.ext.
/// The Control Center sends it URI-encoded, since a header is ASCII. Letters
/// and numbers of any script stay; NFC keeps a Mac's decomposed accents whole.
pub fn safe_name(value: &str) -> String {
    // A name that does not decode was sent as it is.
    let text = decode_uri_component(value).map_or(Cow::Borrowed(value), Cow::Owned);
    text.nfc()
        .filter(|&c| {
            matches!(c, '_' | ' ' | '.' | '(' | ')' | '[' | ']' | '-')
                || matches!(
                    c.general_category_group(),
                    GeneralCategoryGroup::Letter
                        | GeneralCategoryGroup::Mark
                        | GeneralCategoryGroup::Number
                )
        })
        .take(80)
        .collect()
}

/// A slot as the Control Center lists it (`SoundSlot` in shared/api.ts).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundSlot {
    pub slot: Slot,
    pub exists: bool,
    pub custom: bool,
    pub name: String,
    /// "WAV" or "MP3".
    pub format: &'static str,
    pub bytes: u64,
    pub updated_at: Option<String>,
    /// Length in ms: read from the file, or learned from the first full play
    /// of an MP3 it could not be read from; None until then.
    #[serde(serialize_with = "serialize_duration")]
    pub duration_ms: Option<f64>,
}

fn serialize_duration<S: serde::Serializer>(
    value: &Option<f64>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match value {
        Some(ms) => number_value(*ms).serialize(serializer),
        None => serializer.serialize_none(),
    }
}

/// The file behind a slot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SoundFile {
    pub file: PathBuf,
    pub ext: Extension,
}

/// The sounds folder: `sound-N.wav` / `sound-N.mp3` and `sounds.json`, which
/// lists the slots that hold an upload.
pub struct SoundStore {
    dir: PathBuf,
    map_file: PathBuf,
    now: Box<dyn Fn() -> String + Send + Sync>,
    /// One change to sounds.json at a time: it is read, changed and written.
    writing: Mutex<()>,
}

/// `new Date(stat.mtimeMs)` as Node builds `stat.mtime`: rounded to the millisecond.
fn modified_iso(meta: &fs::Metadata) -> Option<String> {
    let modified = meta.modified().ok()?;
    let millis = match modified.duration_since(UNIX_EPOCH) {
        Ok(since) => since.as_secs() as f64 * 1000.0 + f64::from(since.subsec_nanos()) / 1e6,
        Err(before) => {
            let before = before.duration();
            -(before.as_secs() as f64 * 1000.0 + f64::from(before.subsec_nanos()) / 1e6)
        }
    };
    Some(iso_from_millis(js::round(millis) as i64))
}

impl SoundStore {
    /// `createSoundStore(dir)`. Nothing is read or written until asked.
    pub fn new(dir: impl Into<PathBuf>) -> SoundStore {
        let dir = dir.into();
        SoundStore {
            map_file: dir.join("sounds.json"),
            dir,
            now: Box::new(iso_now),
            writing: Mutex::new(()),
        }
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.writing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn read_map(&self) -> Map<String, Value> {
        match read_json_safe(&self.map_file, is_object) {
            Ok(found) => match found.data() {
                Some(Value::Object(map)) => map,
                _ => Map::new(),
            },
            Err(_) => Map::new(),
        }
    }

    fn write_map(&self, map: Map<String, Value>) -> io::Result<()> {
        write_json_atomic(&self.map_file, &Value::Object(map), true)
    }

    fn path_of(&self, slot: Slot, ext: Extension) -> PathBuf {
        self.dir.join(format!("sound-{slot}.{}", ext.as_str()))
    }

    // Earlier versions stored just the extension as a bare string; both shapes
    // are read, only the richer one is written.
    fn entry(&self, slot: Slot) -> Option<SoundEntry> {
        let map = self.read_map();
        let raw = map.get(&slot.to_string())?;
        if !js::truthy(raw) {
            return None;
        }
        let ext_of = |value: Option<&Value>| match value.and_then(Value::as_str) {
            Some("mp3") => Extension::Mp3,
            _ => Extension::Wav,
        };
        if raw.is_string() {
            return Some(SoundEntry {
                ext: ext_of(Some(raw)),
                name: String::new(),
                uploaded_at: None,
                duration_ms: None,
            });
        }
        let raw = raw.as_object()?;
        Some(SoundEntry {
            ext: ext_of(raw.get("ext")),
            name: raw
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            uploaded_at: raw
                .get("uploadedAt")
                .and_then(Value::as_str)
                .map(str::to_string),
            duration_ms: raw
                .get("durationMs")
                .and_then(Value::as_f64)
                .filter(|&ms| ms > 0.0),
        })
    }

    /// The file a slot plays, whether or not it is there.
    pub fn file(&self, slot: Slot) -> SoundFile {
        let ext = self.entry(slot).map_or(Extension::Wav, |entry| entry.ext);
        SoundFile {
            file: self.path_of(slot, ext),
            ext,
        }
    }

    fn write_tone(&self, slot: Slot) -> io::Result<()> {
        // Rising pitch per slot.
        let freq = 220.0 * libm::pow(2.0, (f64::from(slot) - 1.0) / 4.0);
        fs::write(self.path_of(slot, Extension::Wav), tone_buffer(freq))
    }

    /// Fills in any missing built-in tones, skipping slots the user replaced.
    pub fn ensure_defaults(&self) -> io::Result<()> {
        let _guard = self.guard();
        fs::create_dir_all(&self.dir)?;
        // Any key that reads as the slot's number counts, whatever it holds.
        let custom: Vec<f64> = self
            .read_map()
            .keys()
            .map(|key| js_to_number(key))
            .collect();
        for slot in 1..=LIMITS.sound_slots {
            if custom.contains(&f64::from(slot)) {
                continue;
            }
            if !self.path_of(slot, Extension::Wav).exists() {
                self.write_tone(slot)?;
            }
        }
        Ok(())
    }

    /// A slot's length in milliseconds, or None while it is not known.
    pub fn duration_ms(&self, slot: Slot) -> Option<f64> {
        let target = self.file(slot);
        if !target.file.exists() {
            return None;
        }
        match target.ext {
            Extension::Wav => wav_duration_ms(&target.file),
            Extension::Mp3 => mp3_duration_ms(&target.file)
                .or_else(|| self.entry(slot).and_then(|entry| entry.duration_ms)),
        }
    }

    /// Remembers an MP3's length once it has played through. Returns whether
    /// anything changed.
    pub fn set_duration(&self, slot: Slot, ms: f64) -> io::Result<bool> {
        let _guard = self.guard();
        let mut map = self.read_map();
        let Some(mut current) = self.entry(slot) else {
            return Ok(false);
        };
        // `!(ms > 0)`: so that a length that is not a number is refused too.
        if current.ext != Extension::Mp3 || ms.is_nan() || ms <= 0.0 {
            return Ok(false);
        }
        let rounded = js::round(ms);
        if current.duration_ms == Some(rounded) {
            return Ok(false);
        }
        current.duration_ms = Some(rounded);
        map.insert(slot.to_string(), current.to_value());
        self.write_map(map)?;
        Ok(true)
    }

    /// The eight slots, as the Control Center lists them.
    pub fn slots(&self) -> Vec<SoundSlot> {
        (1..=LIMITS.sound_slots)
            .map(|slot| {
                let info = self.entry(slot);
                let target = self.file(slot);
                let stat = fs::metadata(&target.file).ok();
                SoundSlot {
                    slot,
                    exists: stat.is_some(),
                    custom: info.is_some(),
                    name: info.map(|entry| entry.name).unwrap_or_default(),
                    format: match target.ext {
                        Extension::Mp3 => "MP3",
                        Extension::Wav => "WAV",
                    },
                    bytes: stat.as_ref().map_or(0, fs::Metadata::len),
                    updated_at: stat.as_ref().and_then(modified_iso),
                    duration_ms: stat.as_ref().and_then(|_| self.duration_ms(slot)),
                }
            })
            .collect()
    }

    /// Puts an upload in a slot. `name` is the `X-Sound-Name` header as it
    /// came ("" when there was none).
    pub fn save_upload(
        &self,
        slot: Slot,
        kind: AudioType,
        data: &[u8],
        name: &str,
    ) -> io::Result<()> {
        let _guard = self.guard();
        let ext = match kind {
            AudioType::Wav => Extension::Wav,
            AudioType::Mpeg => Extension::Mp3,
        };
        // Drop the other extension so a WAV never shadows an MP3 in the same slot.
        let other = self.path_of(slot, ext.other());
        if other.exists() {
            fs::remove_file(&other)?;
        }
        fs::write(self.path_of(slot, ext), data)?;
        let mut map = self.read_map();
        let entry = SoundEntry {
            ext,
            name: safe_name(name),
            uploaded_at: Some((self.now)()),
            duration_ms: None,
        };
        map.insert(slot.to_string(), entry.to_value());
        self.write_map(map)
    }

    /// Puts a slot back to its built-in tone. Returns false if it already holds it.
    pub fn revert(&self, slot: Slot) -> io::Result<bool> {
        let _guard = self.guard();
        let mut map = self.read_map();
        let key = slot.to_string();
        if !map.get(&key).is_some_and(js::truthy) {
            return Ok(false);
        }
        let current = self.file(slot).file;
        if current.exists() {
            fs::remove_file(&current)?;
        }
        map.shift_remove(&key);
        self.write_map(map)?;
        fs::create_dir_all(&self.dir)?;
        self.write_tone(slot)?;
        Ok(true)
    }

    /// Whether a slot holds an uploaded file rather than its built-in tone.
    pub fn is_custom(&self, slot: Slot) -> bool {
        self.entry(slot).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::time::{Duration, SystemTime};

    fn fixture_path(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/sound")
            .join(name)
    }

    fn fixture(name: &str) -> Vec<Value> {
        let file = fixture_path(name);
        let text =
            fs::read_to_string(&file).unwrap_or_else(|error| panic!("{}: {error}", file.display()));
        serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", file.display()))
    }

    fn number_of(value: &Value) -> f64 {
        f64::from_bits(u64::from_str_radix(value.as_str().expect("bits"), 16).expect("hex"))
    }

    fn sha256(data: &[u8]) -> String {
        hex::encode(Sha256::digest(data))
    }

    /// The bytes a fixture describes (see `Part` in make-sound.ts).
    fn bytes(parts: &Value) -> Vec<u8> {
        let mut out = Vec::new();
        for part in parts.as_array().expect("parts") {
            if let Some(text) = part.get("hex") {
                out.extend(hex::decode(text.as_str().expect("hex")).expect("hex"));
            } else if let Some(count) = part.get("zeros") {
                out.resize(out.len() + count.as_u64().expect("zeros") as usize, 0);
            } else if let Some(noise) = part.get("noise") {
                let mut state = noise[0].as_u64().expect("seed") as u32;
                for _ in 0..noise[1].as_u64().expect("length") {
                    state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    out.push((state >> 24) as u8);
                }
            } else {
                let once = bytes(&part["repeat"]);
                for _ in 0..part["times"].as_u64().expect("times") {
                    out.extend_from_slice(&once);
                }
            }
        }
        out
    }

    fn duration_value(value: Option<f64>) -> Value {
        value.map_or(Value::Null, number_value)
    }

    fn frame_value(frame: Option<Mp3Frame>) -> Value {
        match frame {
            None => Value::Null,
            Some(frame) => serde_json::json!({
                "at": frame.at, "length": frame.length, "bitrate": frame.bitrate,
                "sampleRate": frame.sample_rate, "samplesPerFrame": frame.samples_per_frame,
                "xingFrames": frame.xing_frames
            }),
        }
    }

    #[test]
    fn files_are_read_as_the_typescript_reads_them() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cases = fixture("files.json");
        let mut frames = 0;
        for (index, case) in cases.iter().enumerate() {
            let name = case["name"].as_str().expect("name");
            let file = dir.path().join(format!("sample-{index}"));
            if case["parts"].is_null() {
                assert_eq!(
                    duration_value(wav_duration_ms(&file)),
                    case["wavDurationMs"],
                    "{name}"
                );
                assert_eq!(
                    duration_value(mp3_duration_ms(&file)),
                    case["mp3DurationMs"],
                    "{name}"
                );
                continue;
            }
            let data = bytes(&case["parts"]);
            assert_eq!(
                data.len() as u64,
                case["bytes"].as_u64().expect("bytes"),
                "{name}"
            );
            assert_eq!(
                sha256(&data),
                case["sha256"].as_str().expect("sha"),
                "{name}"
            );
            assert_eq!(
                Value::from(is_audio(&data, AudioType::Wav)),
                case["isWav"],
                "{name}: WAV"
            );
            assert_eq!(
                Value::from(is_audio(&data, AudioType::Mpeg)),
                case["isMp3"],
                "{name}: MP3"
            );
            fs::write(&file, &data).expect("write");
            assert_eq!(
                duration_value(wav_duration_ms(&file)),
                case["wavDurationMs"],
                "{name}: WAV length"
            );
            assert_eq!(
                duration_value(mp3_duration_ms(&file)),
                case["mp3DurationMs"],
                "{name}: MP3 length"
            );
            fs::remove_file(&file).expect("remove");
            for found in case["frames"].as_array().expect("frames") {
                let start = found["start"].as_u64().expect("start") as usize;
                assert_eq!(
                    frame_value(mp3_frame(&data, start)),
                    found["frame"],
                    "{name}: frame from {start}"
                );
                frames += 1;
            }
        }
        assert!(
            cases.len() > 1000 && frames > 15000,
            "{} files, {frames} frames",
            cases.len()
        );
    }

    #[test]
    fn names_are_cleaned_as_the_typescript_cleans_them() {
        let cases = fixture("safe-name.json");
        for case in &cases {
            let input = case["input"].as_str().expect("input");
            assert_eq!(Value::from(safe_name(input)), case["output"], "{input:?}");
        }
        assert!(cases.len() > 100);
    }

    /// Every character on its own. The one difference allowed: a character
    /// that had no meaning in Node's Unicode and is a letter, mark or number
    /// in the newer Unicode this crate carries.
    #[test]
    fn every_character_is_kept_or_dropped_as_the_typescript_does() {
        let table = &fixture("safe-name-characters.json")[0];
        let ranges = |key: &str| -> Vec<(u32, u32)> {
            table[key]
                .as_array()
                .expect("ranges")
                .iter()
                .map(|pair| {
                    (
                        pair[0].as_u64().expect("from") as u32,
                        pair[1].as_u64().expect("to") as u32,
                    )
                })
                .collect()
        };
        let within = |ranges: &[(u32, u32)], point: u32| {
            ranges
                .binary_search_by(|&(from, to)| {
                    if point < from {
                        std::cmp::Ordering::Greater
                    } else if point > to {
                        std::cmp::Ordering::Less
                    } else {
                        std::cmp::Ordering::Equal
                    }
                })
                .is_ok()
        };
        let kept = ranges("kept");
        let unassigned = ranges("unassigned");
        let changed: std::collections::HashMap<u32, String> = table["changed"]
            .as_array()
            .expect("changed")
            .iter()
            .map(|pair| {
                (
                    pair[0].as_u64().expect("point") as u32,
                    pair[1].as_str().expect("text").to_string(),
                )
            })
            .collect();
        let mut newer = 0;
        let mut checked = 0;
        for point in 0..=0x10ffffu32 {
            let Some(character) = char::from_u32(point) else {
                continue;
            };
            checked += 1;
            let mut buffer = [0u8; 4];
            let input: &str = character.encode_utf8(&mut buffer);
            let output = safe_name(input);
            let expected = if within(&kept, point) {
                input.to_string()
            } else {
                changed.get(&point).cloned().unwrap_or_default()
            };
            if output != expected {
                assert!(
                    within(&unassigned, point) && expected.is_empty(),
                    "U+{point:04X}: {output:?}, the TypeScript gives {expected:?}"
                );
                newer += 1;
            }
        }
        assert_eq!(checked, 0x110000 - 0x800);
        eprintln!(
            "safe_name: {checked} characters; {newer} are kept here and were unassigned in Node's Unicode {}",
            table["unicode"].as_str().unwrap_or("?")
        );
    }

    #[test]
    fn tones_are_the_same_bytes() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = SoundStore::new(dir.path().join("sounds"));
        store.ensure_defaults().expect("tones");
        let mut largest = 0i32;
        for slot in 1..=8 {
            let name = format!("sound-{slot}.wav");
            let expected = fs::read(fixture_path("tones").join(&name)).expect("fixture tone");
            let made = fs::read(dir.path().join("sounds").join(&name)).expect("tone");
            assert_eq!(made.len(), expected.len(), "{name}: length");
            assert_eq!(made[..44], expected[..44], "{name}: header");
            let (ours, _) = made[44..].as_chunks::<2>();
            let (theirs, _) = expected[44..].as_chunks::<2>();
            for (ours, theirs) in ours.iter().zip(theirs) {
                let ours = i32::from(i16::from_le_bytes(*ours));
                let theirs = i32::from(i16::from_le_bytes(*theirs));
                largest = largest.max((ours - theirs).abs());
            }
        }
        eprintln!("tones: largest sample difference {largest}");
        assert_eq!(largest, 0);
    }

    fn step_slot(step: &Value) -> Slot {
        step["slot"].as_u64().expect("slot") as Slot
    }

    #[test]
    fn the_store_does_what_the_typescript_store_does() {
        let mut steps = 0;
        for scenario in fixture("store.json") {
            let name = scenario["name"].as_str().expect("name").to_string();
            let temp = tempfile::tempdir().expect("temp dir");
            let dir = temp.path().join("sounds");
            let clock = std::sync::Arc::new(Mutex::new(String::new()));
            let mut store = SoundStore::new(&dir);
            let shown = clock.clone();
            store.now = Box::new(move || shown.lock().expect("clock").clone());
            for (at, done) in scenario["steps"]
                .as_array()
                .expect("steps")
                .iter()
                .enumerate()
            {
                let step = &done["step"];
                let what = format!(
                    "{name}, step {at} ({})",
                    crate::store::stringify(step)
                        .chars()
                        .take(120)
                        .collect::<String>()
                );
                // A damaged map is moved aside under the real time, to the
                // millisecond: two in one millisecond would be one file.
                std::thread::sleep(Duration::from_millis(2));
                *clock.lock().expect("clock") = done["now"].as_str().expect("now").to_string();
                let result = match step["op"].as_str().expect("op") {
                    "ensureDefaults" => {
                        store.ensure_defaults().expect("ensure_defaults");
                        Value::Null
                    }
                    "saveUpload" => {
                        let kind = if step["type"] == "audio/wav" {
                            AudioType::Wav
                        } else {
                            AudioType::Mpeg
                        };
                        assert_eq!(kind.mime(), step["type"].as_str().expect("type"));
                        store
                            .save_upload(
                                step_slot(step),
                                kind,
                                &bytes(&step["data"]),
                                step["name"].as_str().unwrap_or(""),
                            )
                            .expect("save_upload");
                        Value::Null
                    }
                    "revert" => Value::from(store.revert(step_slot(step)).expect("revert")),
                    "setDuration" => Value::from(
                        store
                            .set_duration(step_slot(step), number_of(&step["ms"]))
                            .expect("set_duration"),
                    ),
                    "writeFile" => {
                        fs::create_dir_all(&dir).expect("dir");
                        fs::write(
                            dir.join(step["name"].as_str().expect("name")),
                            bytes(&step["data"]),
                        )
                        .expect("write");
                        Value::Null
                    }
                    _ => {
                        let _ = fs::remove_file(dir.join(step["name"].as_str().expect("name")));
                        Value::Null
                    }
                };
                assert_eq!(result, done["result"], "{what}: result");

                // The same times the generator gave each sound file.
                for found in fs::read_dir(&dir).expect("dir") {
                    let found = found.expect("entry");
                    let file_name = found.file_name().to_string_lossy().into_owned();
                    let Some(rest) = file_name.strip_prefix("sound-") else {
                        continue;
                    };
                    let Some((number, ext)) = rest.split_once('.') else {
                        continue;
                    };
                    let Ok(slot) = number.parse::<u64>() else {
                        continue;
                    };
                    let nanos = if ext == "mp3" {
                        456_700_000
                    } else {
                        123_700_000
                    };
                    let time = SystemTime::UNIX_EPOCH
                        + Duration::new(1_700_000_000 + slot * 1000 + at as u64, nanos);
                    fs::File::options()
                        .write(true)
                        .open(found.path())
                        .expect("open")
                        .set_modified(time)
                        .expect("mtime");
                }
                let slots = serde_json::to_value(store.slots()).expect("slots");
                assert_eq!(
                    crate::store::stringify(&slots),
                    crate::store::stringify(&done["slots"]),
                    "{what}: slots"
                );
                for detail in done["details"].as_array().expect("details") {
                    let slot = step_slot(detail);
                    let target = store.file(slot);
                    assert_eq!(target.file.parent(), Some(dir.as_path()));
                    let ours = serde_json::json!({
                        "slot": slot,
                        "file": target.file.file_name().expect("name").to_string_lossy(),
                        "ext": target.ext.as_str(),
                        "isCustom": store.is_custom(slot),
                        "durationMs": duration_value(store.duration_ms(slot))
                    });
                    assert_eq!(&ours, detail, "{what}: slot {slot}");
                }
                let map = fs::read_to_string(dir.join("sounds.json")).ok();
                assert_eq!(
                    map.as_deref(),
                    done["soundsJson"].as_str(),
                    "{what}: sounds.json"
                );
                // Sorted by their real names, as the generator sorted them: a map
                // damaged twice is kept twice, under the time of each.
                let mut found: Vec<PathBuf> = fs::read_dir(&dir)
                    .expect("dir")
                    .map(|found| found.expect("entry").path())
                    .collect();
                found.sort();
                let files: Vec<Value> = found
                    .iter()
                    .map(|path| {
                        let mut file_name =
                            path.file_name().expect("name").to_string_lossy().into_owned();
                        if let Some(at) = file_name.find(".corrupt-") {
                            file_name.truncate(at);
                            file_name.push_str(".corrupt-*");
                        }
                        let data = fs::read(path).expect("read");
                        serde_json::json!({ "name": file_name, "bytes": data.len(), "sha256": sha256(&data) })
                    })
                    .collect();
                assert_eq!(Value::Array(files), done["files"], "{what}: files");
                steps += 1;
            }
        }
        assert!(steps > 80, "{steps} steps");
    }

    // ---------------------------------------- tests/sounds.test.mjs, ported

    fn silent_wav(ms: u32, before: &[u8]) -> Vec<u8> {
        let rate = 8000u32;
        let data = vec![0u8; ((f64::from(rate) * f64::from(ms)) / 1000.0).round() as usize * 2];
        let mut body = b"WAVE".to_vec();
        body.extend_from_slice(before);
        body.extend_from_slice(b"fmt ");
        body.extend_from_slice(&16u32.to_le_bytes());
        body.extend_from_slice(&1u16.to_le_bytes());
        body.extend_from_slice(&1u16.to_le_bytes());
        body.extend_from_slice(&rate.to_le_bytes());
        body.extend_from_slice(&(rate * 2).to_le_bytes());
        body.extend_from_slice(&2u16.to_le_bytes());
        body.extend_from_slice(&16u16.to_le_bytes());
        body.extend_from_slice(b"data");
        body.extend_from_slice(&(data.len() as u32).to_le_bytes());
        body.extend_from_slice(&data);
        let mut out = b"RIFF".to_vec();
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend(body);
        out
    }

    fn noise(seed: u32, length: usize) -> Vec<u8> {
        let mut state = seed;
        (0..length)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (state >> 24) as u8
            })
            .collect()
    }

    fn chunk(id: &[u8; 4], size: usize) -> Vec<u8> {
        let mut out = id.to_vec();
        out.extend_from_slice(&(size as u32).to_le_bytes());
        out.extend(noise(5, size + size % 2));
        out
    }

    fn silent_mp3(count: usize, info: bool) -> Vec<u8> {
        let mut out = Vec::new();
        for _ in 0..count {
            let mut frame = vec![0u8; 417];
            frame[..4].copy_from_slice(&[0xff, 0xfb, 0x90, 0x64]);
            out.extend(frame);
        }
        if info {
            out[36..40].copy_from_slice(b"Info");
            out[40..44].copy_from_slice(&1u32.to_be_bytes());
            out[44..48].copy_from_slice(&(count as u32 - 1).to_be_bytes());
        }
        out
    }

    fn id3(size: usize, footer: bool) -> Vec<u8> {
        let mut head = b"ID3".to_vec();
        head.extend_from_slice(&[
            if footer { 4 } else { 3 },
            0,
            if footer { 0x10 } else { 0 },
            ((size >> 21) & 0x7f) as u8,
            ((size >> 14) & 0x7f) as u8,
            ((size >> 7) & 0x7f) as u8,
            (size & 0x7f) as u8,
        ]);
        let mut body = noise(11, size);
        let mut i = 0;
        while i + 4 < size {
            body[i..i + 4].copy_from_slice(&[0xff, 0xfb, 0x90, 0x64]);
            i += 997;
        }
        let mut out = head.clone();
        out.extend(body);
        if footer {
            out.extend_from_slice(b"3DI");
            out.extend_from_slice(&head[3..]);
        }
        out
    }

    fn near(value: Option<f64>, expected: f64, slack: f64) -> bool {
        value.is_some_and(|value| (value - expected).abs() <= slack)
    }

    #[test]
    fn the_existing_checks_on_lengths_uploads_and_names() {
        let dir = tempfile::tempdir().expect("temp dir");
        let write = |name: &str, data: Vec<u8>| {
            let file = dir.path().join(name);
            fs::write(&file, data).expect("write");
            file
        };
        let mp3_100 = 100.0 * 417.0 * 8.0 / 128.0; // ms in 100 frames at 128 kbps

        // An MP3's length is read
        assert!(near(
            mp3_duration_ms(&write("plain.mp3", silent_mp3(100, false))),
            mp3_100,
            30.0
        ));
        // An MP3 behind a 300 KB ID3 tag (album art) still has a length
        let file = write(
            "art.mp3",
            [id3(300 * 1024, false), silent_mp3(100, false)].concat(),
        );
        assert!(near(mp3_duration_ms(&file), mp3_100, 30.0));
        // An ID3v2.4 tag with a footer is skipped whole
        let file = write(
            "footer.mp3",
            [id3(70 * 1024, true), silent_mp3(100, false)].concat(),
        );
        assert!(near(mp3_duration_ms(&file), mp3_100, 30.0));
        // Two ID3 tags in a row are both skipped
        let file = write(
            "two-tags.mp3",
            [
                id3(5000, false),
                id3(80 * 1024, false),
                silent_mp3(100, false),
            ]
            .concat(),
        );
        assert!(near(mp3_duration_ms(&file), mp3_100, 30.0));
        // A frame count (Info header) past a big tag gives the length
        let file = write(
            "vbr.mp3",
            [id3(100 * 1024, false), silent_mp3(200, true)].concat(),
        );
        assert!(near(mp3_duration_ms(&file), 199.0 * 1152.0 / 44.1, 2.0));
        // A WAV with a 100 KB chunk before its format still has a length
        let file = write("list.wav", silent_wav(1500, &chunk(b"LIST", 100 * 1024)));
        assert_eq!(wav_duration_ms(&file), Some(1500.0));

        let adts = [
            vec![0xff, 0xf1, 0x50, 0x80, 0x2e, 0x7f, 0xfc],
            vec![0u8; 4000],
        ]
        .concat();
        let riff_only = [b"RIFF".to_vec(), vec![4, 0, 0, 0], b"WAVE".to_vec()].concat();
        let fmt_only = silent_wav(100, &[])[..36].to_vec();
        let uploads: Vec<(&str, Vec<u8>, AudioType, bool)> = vec![
            (
                "\"ID3\" and nothing else is not an MP3",
                b"ID3".to_vec(),
                AudioType::Mpeg,
                false,
            ),
            (
                "An ID3 tag with no audio after it is not an MP3",
                id3(2000, false),
                AudioType::Mpeg,
                false,
            ),
            (
                "An AAC (ADTS) stream is not an MP3",
                adts,
                AudioType::Mpeg,
                false,
            ),
            (
                "Noise with a sync word in it is not an MP3",
                [vec![0xff, 0xfb, 0x90, 0x64], noise(3, 3000)].concat(),
                AudioType::Mpeg,
                false,
            ),
            (
                "A RIFF header with no chunks is not a WAV",
                riff_only,
                AudioType::Wav,
                false,
            ),
            (
                "A WAV with a format but no data is not a WAV",
                fmt_only,
                AudioType::Wav,
                false,
            ),
            (
                "Real MP3 frames are an MP3",
                silent_mp3(20, false),
                AudioType::Mpeg,
                true,
            ),
            (
                "An MP3 behind a big tag is an MP3",
                [id3(200 * 1024, false), silent_mp3(20, false)].concat(),
                AudioType::Mpeg,
                true,
            ),
            (
                "A WAV with its chunks is a WAV",
                silent_wav(200, &chunk(b"LIST", 33)),
                AudioType::Wav,
                true,
            ),
        ];
        for (name, data, kind, expected) in uploads {
            assert_eq!(is_audio(&data, kind), expected, "{name}");
        }

        // Names keep letters of every script
        assert_eq!(
            safe_name("Caf%C3%A9%20%C3%B1and%C3%BA%20%E6%97%A5%E6%9C%AC%20%CE%95%CE%BB%CE%BB%CE%AC%CE%B4%CE%B1%20(1)%20%5Bx%5D-y.mp3"),
            "Café ñandú 日本 Ελλάδα (1) [x]-y.mp3"
        );
        // A Mac's decomposed accent stays one letter
        assert_eq!(safe_name("Cafe%CC%81"), "Café");
        // Slashes, control characters and symbols still go
        assert_eq!(safe_name("..%2Fa%07%2Fb%3C%3E%25.wav"), "..ab.wav");
        // A name that is not encoded is taken as is
        assert_eq!(safe_name("100% done"), "100 done");
    }

    /// Through the store, as PUT /api/sounds/N does it: the MP3 with a big
    /// tag has its length at once and its name keeps every letter.
    #[test]
    fn an_upload_is_listed_with_its_length_and_name() {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = SoundStore::new(temp.path().join("sounds"));
        store.ensure_defaults().expect("tones");
        assert!(!store.slots()[1].custom);
        let data = [id3(256 * 1024, false), silent_mp3(100, false)].concat();
        assert!(is_audio(&data, AudioType::Mpeg));
        store
            .save_upload(
                2,
                AudioType::Mpeg,
                &data,
                "Caf%C3%A9%20%C3%B1and%C3%BA%20%E6%97%A5%E6%9C%AC%20(take%202).mp3",
            )
            .expect("upload");
        let slot = &store.slots()[1];
        assert!(slot.custom && slot.exists && slot.format == "MP3");
        assert!(near(slot.duration_ms, 100.0 * 417.0 * 8.0 / 128.0, 30.0));
        assert_eq!(slot.name, "Café ñandú 日本 (take 2).mp3");
        // The new file's length stands
        store
            .save_upload(4, AudioType::Wav, &silent_wav(5000, &[]), "long")
            .expect("upload");
        store
            .save_upload(4, AudioType::Wav, &silent_wav(800, &[]), "short")
            .expect("upload");
        assert_eq!(store.slots()[3].duration_ms, Some(800.0));
        assert!(store.revert(4).expect("revert"));
        assert!(!store.is_custom(4) && !store.revert(4).expect("revert"));
    }
}
