//! Finding a port to listen on.
//!
//! Paired tablets are tied to the exact address, port included (a browser keeps
//! storage per origin), so the port should almost never change. When the
//! preferred one is busy there are two different cases: Punchboard is already
//! running there (someone double-clicked the starter twice), or another program
//! took it. Only the second one moves to a new port.

use std::io;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use serde_json::Value;
use socket2::{Domain, Protocol, Socket, Type};
use tokio::net::TcpListener;

/// The backlog Node asks for.
const BACKLOG: i32 = 511;

fn listen_on(address: SocketAddr) -> io::Result<std::net::TcpListener> {
    let socket = Socket::new(
        Domain::for_address(address),
        Type::STREAM,
        Some(Protocol::TCP),
    )?;
    if address.is_ipv6() {
        // One socket for both families, as Node's listen(port) gives:
        // tablets arrive over IPv4, and Windows would otherwise refuse them.
        socket.set_only_v6(false)?;
    }
    // A port just let go by a companion that quit can be taken again at
    // once. Not on Windows, where this would let two programs share a port.
    #[cfg(not(windows))]
    socket.set_reuse_address(true)?;
    socket.bind(&address.into())?;
    socket.listen(BACKLOG)?;
    socket.set_nonblocking(true)?;
    Ok(socket.into())
}

/// Whether a failure to listen means "taken" rather than "broken".
fn is_taken(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::AddrInUse | io::ErrorKind::PermissionDenied
    )
}

fn listen_any(port: u16) -> io::Result<std::net::TcpListener> {
    match listen_on(SocketAddr::from((Ipv6Addr::UNSPECIFIED, port))) {
        Ok(listener) => Ok(listener),
        Err(error) if is_taken(&error) => Err(error),
        // No IPv6 on this machine: IPv4 alone, as Node falls back to.
        Err(_) => listen_on(SocketAddr::from((Ipv4Addr::UNSPECIFIED, port))),
    }
}

/// Listens on `port` (every address of this machine), giving None instead of
/// failing when it is taken. Must be called inside the tokio runtime.
pub fn try_listen(port: u16) -> io::Result<Option<TcpListener>> {
    match listen_any(port) {
        Ok(listener) => TcpListener::from_std(listener).map(Some),
        Err(error) if is_taken(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

/// Whether a reply to /api/hello is a Punchboard companion's.
fn is_hello(body: &str) -> bool {
    serde_json::from_str::<Value>(body).is_ok_and(|hello| {
        hello.get("serverTime").is_some_and(Value::is_number)
            && hello.get("theme").is_some_and(Value::is_string)
    })
}

fn ask_hello(port: u16) -> bool {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_millis(1500))
        .build();
    // Any failure, a status that is not 2xx included, is "not Punchboard".
    match agent
        .get(&format!("http://127.0.0.1:{port}/api/hello"))
        .call()
    {
        Ok(response) => {
            (200..300).contains(&response.status())
                && response.into_string().is_ok_and(|body| is_hello(&body))
        }
        Err(_) => false,
    }
}

/// Whether a Punchboard companion is already answering on this port.
pub async fn is_punchboard_on(port: u16) -> bool {
    tokio::task::spawn_blocking(move || ask_hello(port))
        .await
        .unwrap_or(false)
}

#[derive(Debug)]
pub enum PortOutcome {
    /// Listening; `moved` says the preferred port was taken by another program.
    Listening {
        listener: TcpListener,
        port: u16,
        moved: bool,
    },
    AlreadyRunning {
        port: u16,
    },
    NoFreePort,
}

/// How many ports after the preferred one [`claim_port`] tries by default.
pub const PORT_RANGE: u16 = 20;

/// Takes the preferred port, or the next free one within `range`.
pub async fn claim_port(preferred: u16, range: u16) -> io::Result<PortOutcome> {
    if let Some(listener) = try_listen(preferred)? {
        return Ok(PortOutcome::Listening {
            listener,
            port: preferred,
            moved: false,
        });
    }
    if is_punchboard_on(preferred).await {
        return Ok(PortOutcome::AlreadyRunning { port: preferred });
    }
    for step in 1..=range {
        // Past 65535 there is no port to try: Node failed here too.
        let port = preferred.checked_add(step).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "Port {} is not a port (0 to 65535).",
                    u32::from(preferred) + u32::from(step)
                ),
            )
        })?;
        if let Some(listener) = try_listen(port)? {
            return Ok(PortOutcome::Listening {
                listener,
                port,
                moved: true,
            });
        }
    }
    Ok(PortOutcome::NoFreePort)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// One test at a time: each needs a few neighbouring ports to itself.
    static PORTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// A free port with `after` more free ports behind it, found by asking
    /// the system for one and checking its neighbours.
    fn free_run(after: u16) -> u16 {
        for _ in 0..200 {
            let Ok(probe) = std::net::TcpListener::bind(("127.0.0.1", 0)) else {
                continue;
            };
            let Ok(address) = probe.local_addr() else {
                continue;
            };
            let port = address.port();
            drop(probe);
            if port.checked_add(after).is_some()
                && (0..=after).all(|step| listen_any(port + step).is_ok())
            {
                return port;
            }
        }
        panic!("no run of {} free ports", after + 1);
    }

    /// Answers every connection with one HTTP reply.
    fn serve(listener: TcpListener, status: &'static str, body: &'static str) {
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut request = [0u8; 2048];
                    let _ = socket.read(&mut request).await;
                    let reply = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                    let _ = socket.write_all(reply.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
    }

    const HELLO: &str = "{\"serverTime\":1700000000000,\"theme\":\"studio\",\"language\":\"auto\"}";

    #[test]
    fn what_counts_as_a_hello() {
        assert!(is_hello(HELLO));
        assert!(is_hello("{\"serverTime\":1.5,\"theme\":\"\"}"));
        for other in [
            "",
            "not json",
            "[]",
            "null",
            "{}",
            "{\"serverTime\":\"now\",\"theme\":\"studio\"}",
            "{\"serverTime\":1}",
            "{\"serverTime\":1,\"theme\":null}",
        ] {
            assert!(!is_hello(other), "{other}");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_free_port_is_taken_as_asked() {
        let _ports = PORTS.lock().await;
        let port = free_run(0);
        let outcome = claim_port(port, PORT_RANGE).await.unwrap();
        let PortOutcome::Listening {
            listener,
            port: got,
            moved,
        } = outcome
        else {
            panic!("{outcome:?}")
        };
        assert_eq!((got, moved), (port, false));
        assert_eq!(listener.local_addr().unwrap().port(), port);
        // It answers on the loopback address tablets and tests use.
        serve(listener, "200 OK", HELLO);
        assert!(is_punchboard_on(port).await);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_port_held_by_punchboard_is_already_running() {
        let _ports = PORTS.lock().await;
        let port = free_run(1);
        serve(try_listen(port).unwrap().expect("free"), "200 OK", HELLO);
        let outcome = claim_port(port, PORT_RANGE).await.unwrap();
        assert!(
            matches!(outcome, PortOutcome::AlreadyRunning { port: got } if got == port),
            "{outcome:?}"
        );
        // Nothing was taken further up.
        assert!(try_listen(port + 1).unwrap().is_some());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_port_held_by_another_program_moves_to_the_next_free_one() {
        let _ports = PORTS.lock().await;
        let port = free_run(3);
        // Something that is not Punchboard, in three ways: wrong JSON, an
        // error status, and a listener that never answers a word.
        serve(
            try_listen(port).unwrap().expect("free"),
            "200 OK",
            "{\"hello\":\"world\"}",
        );
        serve(
            try_listen(port + 1).unwrap().expect("free"),
            "500 Internal Server Error",
            HELLO,
        );
        let _silent = try_listen(port + 2).unwrap().expect("free");
        assert!(!is_punchboard_on(port).await);
        assert!(!is_punchboard_on(port + 1).await);
        let outcome = claim_port(port, PORT_RANGE).await.unwrap();
        let PortOutcome::Listening {
            port: got, moved, ..
        } = outcome
        else {
            panic!("{outcome:?}")
        };
        assert_eq!((got, moved), (port + 3, true));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn only_the_preferred_port_is_asked_who_holds_it() {
        let _ports = PORTS.lock().await;
        let port = free_run(2);
        let _other = try_listen(port).unwrap().expect("free");
        // Punchboard one port up does not count: this copy takes the one after.
        serve(
            try_listen(port + 1).unwrap().expect("free"),
            "200 OK",
            HELLO,
        );
        let outcome = claim_port(port, PORT_RANGE).await.unwrap();
        assert!(
            matches!(outcome, PortOutcome::Listening { port: got, moved: true, .. } if got == port + 2),
            "{outcome:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn no_free_port_within_the_range() {
        let _ports = PORTS.lock().await;
        let port = free_run(2);
        let _held: Vec<TcpListener> = (0..=2)
            .map(|step| try_listen(port + step).unwrap().expect("free"))
            .collect();
        let outcome = claim_port(port, 2).await.unwrap();
        assert!(matches!(outcome, PortOutcome::NoFreePort), "{outcome:?}");
        // One more step would have found the next.
        drop(outcome);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn nothing_answering_is_not_punchboard() {
        let _ports = PORTS.lock().await;
        let port = free_run(0);
        assert!(!is_punchboard_on(port).await);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn past_the_last_port_is_an_error() {
        let _ports = PORTS.lock().await;
        // 65535 is held for the length of the test, if it can be.
        let Ok(Some(_held)) = try_listen(65535) else {
            return;
        };
        let error = claim_port(65535, 3).await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn both_families_reach_the_listener() {
        let _ports = PORTS.lock().await;
        let port = free_run(0);
        let listener = try_listen(port).unwrap().expect("free");
        serve(listener, "200 OK", HELLO);
        assert!(tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok());
    }
}
