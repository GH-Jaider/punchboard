//! The computer's volume on Linux, by talking to the sound server in
//! PulseAudio's own protocol, which PipeWire (pipewire-pulse) speaks too:
//! the main volume is the default sink's, and each application's volume is
//! that of its streams (sink inputs), which gives Linux the per-app mixer
//! Windows has. The Node companion had neither.
//!
//! One thread ([`super::AudioThread`]) owns the connection and answers one
//! request at a time. A connection that fails is dropped and opened again
//! for the next request, so a sound server that restarts is found again.
//!
//! The app key is the playing program's name, lower-cased ("firefox"), from
//! the stream's application.process.binary; app_volume.rs decides it.

use std::ffi::CString;
use std::io::{BufReader, Cursor, Read};
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::time::Duration;

use pulseaudio::protocol::{
    self, ChannelVolume, Command, CommandReply, Prop, Props, ProtocolError, SinkInputInfo, Volume,
    DEFAULT_SINK, DESCRIPTOR_SIZE,
};

use super::app_volume::{pulse_channels, pulse_level, stream_key};
use super::{AudioBackend, AudioThread, MakeBackend, SystemApp, ThreadMessages};

/// What each request says when it fails. The words that are not about
/// Windows are shared with it.
pub const MESSAGES: ThreadMessages = ThreadMessages {
    failed: "server.winVolume.failed",
    no_read: "server.linuxVolume.noRead",
    no_change: "server.linuxVolume.noChange",
    no_app_read: "server.linuxVolume.noAppRead",
    no_app_change: "server.linuxVolume.noAppChange",
    no_list: "server.linuxVolume.noList",
    slow_answer: "server.linuxVolume.slowAnswer",
    helper_stopped: "server.winVolume.helperStopped",
    stopped: "server.winVolume.stopped",
};

/// How long the sound server may take over one message.
const SOCKET_MS: u64 = 5000;

/// The tags a message that answers a command begins with.
const TAG_ERROR: u32 = 0;
const TAG_REPLY: u32 = 2;

/// Linux's volumes. The thread, and the connection, start with the first request.
pub fn audio_thread() -> AudioThread {
    let make: MakeBackend =
        Arc::new(|| Ok(Box::new(PulseAudio { connection: None }) as Box<dyn AudioBackend>));
    AudioThread::new("punchboard-volume", MESSAGES, make)
}

fn words(error: ProtocolError) -> String {
    match error {
        ProtocolError::ServerError(code) => format!("The sound server answered {code:?}."),
        other => other.to_string(),
    }
}

struct Connection {
    socket: BufReader<UnixStream>,
    version: u16,
    sequence: u32,
}

impl Connection {
    fn open() -> Result<Connection, String> {
        let path = pulseaudio::socket_path_from_env()
            .ok_or("No sound server was found (PipeWire or PulseAudio).")?;
        let cookie = pulseaudio::cookie_path_from_env()
            .and_then(|file| std::fs::read(file).ok())
            .unwrap_or_default();
        let socket =
            UnixStream::connect(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        let patience = Some(Duration::from_millis(SOCKET_MS));
        socket
            .set_read_timeout(patience)
            .and_then(|()| socket.set_write_timeout(patience))
            .map_err(|error| error.to_string())?;
        let mut connection = Connection {
            socket: BufReader::new(socket),
            version: protocol::MAX_VERSION,
            sequence: 0,
        };
        let hello: protocol::AuthReply = connection.ask(Command::Auth(protocol::AuthParams {
            version: protocol::MAX_VERSION,
            supports_shm: false,
            supports_memfd: false,
            cookie,
        }))?;
        connection.version = protocol::MAX_VERSION.min(hello.version);
        let mut props = Props::new();
        props.set(Prop::ApplicationName, c"Punchboard");
        props.set(Prop::ApplicationProcessBinary, c"punchboard");
        if let Ok(pid) = CString::new(std::process::id().to_string()) {
            props.set(Prop::ApplicationProcessId, pid);
        }
        let _: protocol::SetClientNameReply = connection.ask(Command::SetClientName(props))?;
        Ok(connection)
    }

    fn send(&mut self, command: &Command) -> Result<u32, String> {
        self.sequence = self.sequence.wrapping_add(1);
        protocol::write_command_message(
            self.socket.get_mut(),
            self.sequence,
            command,
            self.version,
        )
        .map_err(words)?;
        Ok(self.sequence)
    }

    /// The next message that answers request `sequence`, whole, as it came.
    /// Anything else the server says meanwhile (an event, sound data) is
    /// read and left.
    fn answer_to(&mut self, sequence: u32) -> Result<Vec<u8>, String> {
        loop {
            let mut message = vec![0u8; DESCRIPTOR_SIZE];
            self.socket
                .read_exact(&mut message)
                .map_err(|error| error.to_string())?;
            let field = |at: usize, bytes: &[u8]| {
                bytes
                    .get(at..at + 4)
                    .map(|four| u32::from_be_bytes([four[0], four[1], four[2], four[3]]))
            };
            let length = field(0, &message).unwrap_or(0) as usize;
            let channel = field(4, &message).unwrap_or(0);
            if length > protocol::MAX_MEMBLOCKQ_LENGTH {
                return Err("The sound server sent a message that is too long.".to_string());
            }
            message.resize(DESCRIPTOR_SIZE + length, 0);
            self.socket
                .read_exact(&mut message[DESCRIPTOR_SIZE..])
                .map_err(|error| error.to_string())?;
            // A control message starts with two tagged numbers: what it is,
            // and which request it answers.
            let body = &message[DESCRIPTOR_SIZE..];
            let (tag, answers) = (field(1, body), field(6, body));
            let control = channel == u32::MAX && body.first() == Some(&b'L');
            let is_answer = matches!(tag, Some(TAG_ERROR | TAG_REPLY));
            if control && is_answer && answers == Some(sequence) {
                return Ok(message);
            }
        }
    }

    /// One request and its answer.
    fn ask<R: CommandReply>(&mut self, command: Command) -> Result<R, String> {
        let sequence = self.send(&command)?;
        let message = self.answer_to(sequence)?;
        let (_, reply) = protocol::read_reply_message::<R>(&mut Cursor::new(message), self.version)
            .map_err(words)?;
        Ok(reply)
    }

    /// One request that is answered with nothing but "done".
    fn tell(&mut self, command: Command) -> Result<(), String> {
        let sequence = self.send(&command)?;
        let message = self.answer_to(sequence)?;
        protocol::read_ack_message(&mut Cursor::new(message)).map_err(words)?;
        Ok(())
    }
}

fn raw(volume: &ChannelVolume) -> Vec<u32> {
    volume.channels().iter().map(Volume::as_u32).collect()
}

fn volume_of(channels: &[u32]) -> ChannelVolume {
    let mut volume = ChannelVolume::empty();
    for channel in channels {
        volume.push(Volume::from_u32_clamped(*channel));
    }
    volume
}

/// A property's text, without the 0 it ends with on the wire.
fn text(props: &Props, prop: Prop) -> Option<String> {
    let bytes = props.get(prop)?;
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    Some(String::from_utf8_lossy(&bytes[..end]).into_owned())
}

/// One application's stream.
struct Stream {
    key: String,
    info: SinkInputInfo,
}

struct PulseAudio {
    connection: Option<Connection>,
}

impl PulseAudio {
    /// Runs one exchange on the connection, opening it if there is none; a
    /// failure closes it, and the next request opens another.
    fn with<T>(
        &mut self,
        exchange: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut connection = match self.connection.take() {
            Some(connection) => connection,
            None => Connection::open()?,
        };
        let result = exchange(&mut connection)?;
        self.connection = Some(connection);
        Ok(result)
    }

    /// Every stream that belongs to an application and has a volume.
    fn streams(connection: &mut Connection) -> Result<Vec<Stream>, String> {
        let inputs: protocol::SinkInputInfoList = connection.ask(Command::GetSinkInputInfoList)?;
        Ok(inputs
            .into_iter()
            .filter(|input| input.has_volume)
            .filter_map(|info| {
                let key = stream_key(
                    text(&info.props, Prop::ApplicationProcessBinary).as_deref(),
                    text(&info.props, Prop::ApplicationName).as_deref(),
                )?;
                Some(Stream { key, info })
            })
            .collect())
    }
}

impl AudioBackend for PulseAudio {
    fn main_volume(&mut self) -> Result<f64, String> {
        self.with(|connection| {
            let sink: protocol::SinkInfo =
                connection.ask(Command::GetSinkInfo(protocol::GetSinkInfo {
                    index: None,
                    name: Some(DEFAULT_SINK.to_owned()),
                }))?;
            Ok(pulse_level(&raw(&sink.cvolume)))
        })
    }

    fn set_main_volume(&mut self, level: f64) -> Result<f64, String> {
        self.with(|connection| {
            let sink: protocol::SinkInfo =
                connection.ask(Command::GetSinkInfo(protocol::GetSinkInfo {
                    index: None,
                    name: Some(DEFAULT_SINK.to_owned()),
                }))?;
            let channels = pulse_channels(&raw(&sink.cvolume), level);
            connection.tell(Command::SetSinkVolume(protocol::SetDeviceVolumeParams {
                device_index: Some(sink.index),
                device_name: None,
                volume: volume_of(&channels),
            }))?;
            Ok(pulse_level(&channels))
        })
    }

    fn app_volume(&mut self, key: &str) -> Result<Option<f64>, String> {
        self.with(|connection| {
            Ok(Self::streams(connection)?
                .iter()
                .find(|stream| stream.key == key)
                .map(|stream| pulse_level(&raw(&stream.info.cvolume))))
        })
    }

    /// Sets every stream of every process of the app.
    fn set_app_volume(&mut self, key: &str, level: f64) -> Result<Option<f64>, String> {
        self.with(|connection| {
            let mut now = None;
            for stream in Self::streams(connection)? {
                if stream.key != key || !stream.info.volume_writable {
                    continue;
                }
                let channels = pulse_channels(&raw(&stream.info.cvolume), level);
                connection.tell(Command::SetSinkInputVolume(
                    protocol::SetStreamVolumeParams {
                        index: stream.info.index,
                        volume: volume_of(&channels),
                    },
                ))?;
                now.get_or_insert(pulse_level(&channels));
            }
            Ok(now)
        })
    }

    /// Every app with a stream, leaving out Punchboard's own sounds.
    fn list_apps(&mut self) -> Result<Vec<SystemApp>, String> {
        let own = std::process::id().to_string();
        self.with(|connection| {
            let mut apps: Vec<SystemApp> = Vec::new();
            for stream in Self::streams(connection)? {
                let props = &stream.info.props;
                let ours = text(props, Prop::ApplicationProcessId).as_deref() == Some(&own);
                if ours
                    || stream.key == "punchboard"
                    || apps.iter().any(|app| app.key == stream.key)
                {
                    continue;
                }
                let name = text(props, Prop::ApplicationName)
                    .filter(|name| !name.trim().is_empty())
                    .or_else(|| text(props, Prop::ApplicationProcessBinary))
                    .unwrap_or_default();
                apps.push(SystemApp {
                    name,
                    level: pulse_level(&raw(&stream.info.cvolume)),
                    key: stream.key,
                });
            }
            Ok(apps)
        })
    }
}
