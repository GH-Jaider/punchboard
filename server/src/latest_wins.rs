//! One volume write at a time, newest level first. A drag posts every ~90 ms
//! and each write takes about as long, so writes run side by side would
//! finish in any order and could leave an older level set.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::oneshot;

type Write<T> = Box<dyn Fn(f64) -> Pin<Box<dyn Future<Output = T> + Send>> + Send + Sync>;

struct State<T> {
    /// Who is waiting for the write in flight; None when nothing is.
    in_flight: Option<Vec<oneshot::Sender<T>>>,
    next: Option<f64>,
}

struct Inner<T> {
    write: Write<T>,
    state: Mutex<State<T>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Runs one write at a time; while one is in flight only the newest level
/// waits, and goes next. Callers that arrive meanwhile share the write in
/// flight: they get what it answers (a write that can fail answers with a
/// `Result`, and they share the failure too).
pub struct LatestWins<T> {
    inner: Arc<Inner<T>>,
}

impl<T> Clone for LatestWins<T> {
    fn clone(&self) -> Self {
        LatestWins {
            inner: self.inner.clone(),
        }
    }
}

/// Clears the write in flight and starts the queued one, also when the write
/// panicked: its callers are let go and later levels are not stuck behind it.
struct Finish<T: Clone + Send + 'static> {
    inner: Arc<Inner<T>>,
    answer: Option<T>,
}

impl<T: Clone + Send + 'static> Finish<T> {
    /// The write is done: its answer goes to everyone who waited for it.
    fn with(mut self, answer: T) {
        self.answer = Some(answer);
    }
}

impl<T: Clone + Send + 'static> Drop for Finish<T> {
    fn drop(&mut self) {
        let (waiting, queued) = {
            let mut state = lock(&self.inner.state);
            (
                state.in_flight.take().unwrap_or_default(),
                state.next.take(),
            )
        };
        if let Some(level) = queued {
            // Its answer is for whoever calls next and shares it.
            drop(start(&self.inner, level));
        }
        if let Some(answer) = self.answer.take() {
            for caller in waiting {
                let _ = caller.send(answer.clone());
            }
        }
    }
}

fn start<T: Clone + Send + 'static>(inner: &Arc<Inner<T>>, level: f64) -> oneshot::Receiver<T> {
    let (sender, receiver) = oneshot::channel();
    {
        let mut state = lock(&inner.state);
        let state = &mut *state;
        if let Some(waiting) = state.in_flight.as_mut() {
            state.next = Some(level);
            waiting.push(sender);
            return receiver;
        }
        state.in_flight = Some(vec![sender]);
    }
    // Started here, not when the caller gets round to waiting: the write
    // happens even if nobody stays for the answer.
    let finish = Finish {
        inner: inner.clone(),
        answer: None,
    };
    // Outside the runtime (the companion is closing) nothing can be written:
    // `finish` is dropped here, which lets the caller go.
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
        let writing = (inner.write)(level);
        runtime.spawn(async move {
            let answer = writing.await;
            finish.with(answer);
        });
    }
    receiver
}

impl<T: Clone + Send + 'static> LatestWins<T> {
    /// Asks for `level` to be written. The write (or the queueing behind the
    /// one in flight) happens now; the future is only the answer. Must be
    /// called inside the tokio runtime.
    pub fn run(&self, level: f64) -> impl Future<Output = T> + Send + 'static {
        let answer = start(&self.inner, level);
        async move {
            match answer.await {
                Ok(answer) => answer,
                Err(_) => panic!("the write this call was waiting for did not finish"),
            }
        }
    }
}

pub fn latest_wins<T, F, Fut>(write: F) -> LatestWins<T>
where
    T: Clone + Send + 'static,
    F: Fn(f64) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = T> + Send + 'static,
{
    LatestWins {
        inner: Arc::new(Inner {
            write: Box::new(move |level| Box::pin(write(level))),
            state: Mutex::new(State {
                in_flight: None,
                next: None,
            }),
        }),
    }
}

type KeyedWrite<T> =
    Arc<dyn Fn(&str, f64) -> Pin<Box<dyn Future<Output = T> + Send>> + Send + Sync>;

/// [`LatestWins`] for each key on its own: two apps' faders dragged together
/// never wait for each other, while one app's levels still go one at a time.
pub struct LatestWinsPerKey<T> {
    write: KeyedWrite<T>,
    writers: Arc<Mutex<HashMap<String, LatestWins<T>>>>,
}

impl<T> Clone for LatestWinsPerKey<T> {
    fn clone(&self) -> Self {
        LatestWinsPerKey {
            write: self.write.clone(),
            writers: self.writers.clone(),
        }
    }
}

impl<T: Clone + Send + 'static> LatestWinsPerKey<T> {
    pub fn run(&self, key: &str, level: f64) -> impl Future<Output = T> + Send + 'static {
        let writer = lock(&self.writers)
            .entry(key.to_string())
            .or_insert_with(|| {
                let write = self.write.clone();
                let key = key.to_string();
                latest_wins(move |queued| write(&key, queued))
            })
            .clone();
        writer.run(level)
    }
}

pub fn latest_wins_per_key<T, F, Fut>(write: F) -> LatestWinsPerKey<T>
where
    T: Clone + Send + 'static,
    F: Fn(&str, f64) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = T> + Send + 'static,
{
    LatestWinsPerKey {
        write: Arc::new(move |key, level| Box::pin(write(key, level))),
        writers: Arc::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::path::Path;
    use std::time::Duration;
    use tokio::time::sleep;

    type Order = Arc<Mutex<Vec<String>>>;

    // tests/sounds.test.mjs: "Volume writes never overlap, and the newest level is set last"
    #[tokio::test(start_paused = true)]
    async fn writes_never_overlap_and_the_newest_level_is_set_last() {
        let order: Arc<Mutex<Vec<f64>>> = Arc::default();
        let running: Arc<Mutex<(u32, bool)>> = Arc::default();
        let (seen, busy) = (order.clone(), running.clone());
        let set = latest_wins(move |level| {
            let (seen, busy) = (seen.clone(), busy.clone());
            async move {
                {
                    let mut busy = lock(&busy);
                    busy.0 += 1;
                    if busy.0 > 1 {
                        busy.1 = true;
                    }
                }
                lock(&seen).push(level);
                sleep(Duration::from_millis(40)).await;
                lock(&busy).0 -= 1;
                level
            }
        });
        let calls: Vec<_> = [0.1, 0.2, 0.3, 0.4]
            .into_iter()
            .map(|level| set.run(level))
            .collect();
        let answers = futures_util::future::join_all(calls).await;
        // Everyone who arrived during the first write shares its answer.
        assert_eq!(answers, [0.1, 0.1, 0.1, 0.1]);
        sleep(Duration::from_millis(120)).await;
        assert_eq!(*lock(&order), [0.1, 0.4]);
        assert!(!lock(&running).1, "two writes ran at once");
    }

    // tests/app-volume.test.mjs: "One app's writes never overlap…" and "Two apps' writes do not wait for each other"
    #[tokio::test(start_paused = true)]
    async fn each_key_goes_one_at_a_time_and_keys_do_not_wait_for_each_other() {
        let order: Order = Arc::default();
        let running: Arc<Mutex<HashMap<String, u32>>> = Arc::default();
        let flags: Arc<Mutex<(bool, bool)>> = Arc::default();
        let (seen, busy, noted) = (order.clone(), running.clone(), flags.clone());
        let set = latest_wins_per_key(move |key, level| {
            let (seen, busy, noted, key) =
                (seen.clone(), busy.clone(), noted.clone(), key.to_string());
            async move {
                {
                    let mut busy = lock(&busy);
                    *busy.entry(key.clone()).or_default() += 1;
                    let mut noted = lock(&noted);
                    if busy[&key] > 1 {
                        noted.0 = true;
                    }
                    if busy.values().filter(|count| **count > 0).count() > 1 {
                        noted.1 = true;
                    }
                }
                lock(&seen).push(format!("{key}:{level}"));
                sleep(Duration::from_millis(40)).await;
                *lock(&busy).entry(key).or_default() -= 1;
                level
            }
        });
        let calls = vec![
            set.run("chrome", 0.1),
            set.run("chrome", 0.2),
            set.run("spotify", 0.7),
            set.run("chrome", 0.3),
            set.run("chrome", 0.4),
            set.run("spotify", 0.8),
        ];
        futures_util::future::join_all(calls).await;
        sleep(Duration::from_millis(150)).await;
        let of = |app: &str| {
            lock(&order)
                .iter()
                .filter(|item| item.starts_with(app))
                .cloned()
                .collect::<Vec<_>>()
                .join(",")
        };
        let (overlap_same_app, together) = *lock(&flags);
        assert!(!overlap_same_app);
        assert_eq!(of("chrome"), "chrome:0.1,chrome:0.4");
        assert!(together);
        assert_eq!(of("spotify"), "spotify:0.7,spotify:0.8");
        // "latestWins still answers with what the write returned"
        let single = latest_wins(|level| async move { level * 2.0 });
        assert_eq!(single.run(0.25).await, 0.5);
    }

    #[tokio::test(start_paused = true)]
    async fn a_write_nobody_waits_for_still_happens_and_so_does_the_queued_one() {
        let order: Arc<Mutex<Vec<f64>>> = Arc::default();
        let seen = order.clone();
        let set = latest_wins(move |level| {
            let seen = seen.clone();
            async move {
                sleep(Duration::from_millis(10)).await;
                lock(&seen).push(level);
            }
        });
        drop(set.run(1.0));
        drop(set.run(2.0));
        drop(set.run(3.0));
        sleep(Duration::from_millis(100)).await;
        assert_eq!(*lock(&order), [1.0, 3.0]);
    }

    #[tokio::test(start_paused = true)]
    async fn after_a_write_is_done_the_next_call_writes_at_once() {
        let set = latest_wins(|level| async move {
            sleep(Duration::from_millis(10)).await;
            level
        });
        assert_eq!(set.run(0.5).await, 0.5);
        assert_eq!(set.run(0.6).await, 0.6);
    }

    /// The scenarios the TypeScript was run through: calls at given
    /// moments, a write that takes a while and fails for some levels.
    #[tokio::test(start_paused = true)]
    async fn fixture_latest_wins() {
        let file =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/base/latest-wins.json");
        let cases: Vec<Value> = serde_json::from_str(
            &std::fs::read_to_string(&file)
                .unwrap_or_else(|error| panic!("{}: {error}", file.display())),
        )
        .unwrap();
        assert!(cases.len() > 40);
        for case in cases {
            let input = &case["input"];
            let duration = Duration::from_millis(input["durationMs"].as_u64().unwrap());
            let fail: Vec<f64> = input["failLevels"]
                .as_array()
                .unwrap()
                .iter()
                .map(|level| level.as_f64().unwrap())
                .collect();
            let order: Order = Arc::default();
            let seen = order.clone();
            let set = latest_wins_per_key(move |key, level| {
                let (seen, fail, key) = (seen.clone(), fail.clone(), key.to_string());
                async move {
                    lock(&seen).push(format!("{key}:{}", crate::store::js_number(level)));
                    sleep(duration).await;
                    if fail.contains(&level) {
                        Err(format!("fail {}", crate::store::js_number(level)))
                    } else {
                        Ok(level * 2.0)
                    }
                }
            });
            let mut callers = Vec::new();
            for call in input["calls"].as_array().unwrap() {
                let (set, key) = (set.clone(), call["key"].as_str().unwrap().to_string());
                let (at, level) = (
                    call["at"].as_u64().unwrap(),
                    call["level"].as_f64().unwrap(),
                );
                callers.push(tokio::spawn(async move {
                    sleep(Duration::from_millis(at)).await;
                    set.run(&key, level).await
                }));
            }
            let mut results: Vec<Value> = Vec::new();
            for caller in callers {
                results.push(match caller.await.unwrap() {
                    Ok(value) => serde_json::json!({ "ok": value }),
                    Err(message) => serde_json::json!({ "error": message }),
                });
            }
            // Long enough for whatever was queued last to be written.
            sleep(duration * 4).await;
            let mut writes: serde_json::Map<String, Value> = serde_json::Map::new();
            for item in lock(&order).iter() {
                let (key, level) = item.split_once(':').unwrap();
                let list = writes
                    .entry(key.to_string())
                    .or_insert_with(|| Value::Array(Vec::new()));
                list.as_array_mut()
                    .unwrap()
                    .push(Value::String(level.to_string()));
            }
            let expected_writes = case["output"]["writes"].as_object().unwrap();
            assert_eq!(writes.len(), expected_writes.len(), "{input}");
            for (key, levels) in expected_writes {
                assert_eq!(writes.get(key), Some(levels), "{input} {key}");
            }
            let got: Vec<String> = results.iter().map(crate::store::stringify).collect();
            let expected: Vec<String> = case["output"]["results"]
                .as_array()
                .unwrap()
                .iter()
                .map(crate::store::stringify)
                .collect();
            assert_eq!(got, expected, "{input}");
        }
    }
}
