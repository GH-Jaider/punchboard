// Every number the touchpad engine is tuned with. Times are in ms, distances
// in CSS pixels of the device's screen, speeds in px/ms. The values marked
// libinput are the ones that library has settled on over years of real
// touchpads; the rest were set by trying them on a device.
export const TUNING = {
  // --- tapping (see tap.ts)
  /** A finger down and up within this is a tap; kept down longer it is a hold. (libinput: 180) */
  tapMs: 180,
  /** A finger that strays further than this from where it landed is moving,
      not tapping. Per finger, from its own landing point. (libinput: 1.3 mm) */
  tapMovePx: 8,
  /** After a tap, a finger landing again within this may be a second tap or
      the start of a drag. Also how long a finger resting after a tap takes to
      become a drag. (libinput's drag timeout: 300) */
  dragMs: 300,

  // --- bounces (see engine.ts)
  /** A finger that lifts and lands again within this, close to where it left,
      never lifted: a bounce. The price is that every lift is reported this
      much later, so a tap clicks this long after the finger is up. */
  debounceMs: 50,
  /** How far a bounced finger may land from where it left. */
  debouncePx: 24,

  // --- telling gestures apart (see gestures.ts)
  /** After a finger lifts while others stay, the rest are ignored this long:
      fingers rarely leave a gesture together, and the last ones roll a little. */
  settleMs: 80,
  /** Two fingers must slide or stretch this far before scroll and pinch are
      told apart, three or four before a swipe is looked for. */
  decidePx: 10,
  /** A finger that has moved less than this is still standing still. */
  laggingPx: 4,
  /** Three or four fingers travelling this far along one axis is a swipe. */
  swipePx: 70,
  /** Four fingers whose spread grows or shrinks by these factors. */
  spreadRatio: 1.4,
  pinchRatio: 0.7,
  /** A finger reported further than this from where it was one frame earlier
      did not move there: a lost frame or a new finger. The delta is dropped. */
  jumpPx: 200,

  // --- cursor speed
  /** The cursor moves settings.speed × (base + finger speed × slope) times as
      far as the finger, with the speed capped: slow is precise, a flick crosses
      the screen. */
  accelBase: 0.7,
  accelSlope: 0.9,
  accelMaxSpeed: 2,
  /** Finger speed is averaged over this long, so one late frame does not spike it. */
  velocityWindowMs: 50,

  // --- scrolling
  /** Scroll pixels per finger pixel. */
  scrollGain: 1.2,
  /** Momentum takes the fingers' speed over their last stretch of movement... */
  momentumWindowMs: 80,
  /** ...unless they had stopped for this long before lifting. */
  momentumStaleMs: 60,
  /** Slower than this at lift is not a flick. */
  momentumStartSpeed: 0.12,
  /** Speed kept per 16 ms while coasting, and where coasting stops. */
  momentumFriction: 0.93,
  momentumStopSpeed: 0.03,
  /** A tick that comes late still moves at most this much time's worth. */
  momentumMaxStepMs: 50
} as const
