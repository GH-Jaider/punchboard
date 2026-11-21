//! The Punchboard companion, as a program. `server.rs` is what it does;
//! README.md lists the environment variables it reads and the lines the
//! desktop app reads from it.

use punchboard_server::{server, test_system};

fn main() {
    // A test's companion never touches the real keyboard or mouse. Settled
    // before any other thread exists, since it changes the environment.
    if let Some(folder) = test_system::folder() {
        test_system::redirect_input(&folder);
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("  Punchboard could not start: {error}");
            std::process::exit(1);
        }
    };
    // Only comes back when the companion could not start; it leaves by
    // itself once it was asked to stop.
    let error = runtime.block_on(server::run());
    eprintln!("  Punchboard could not start: {error}");
    std::process::exit(1);
}
