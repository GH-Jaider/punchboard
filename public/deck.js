/* The tablet runtime.

   Two rules drive this file:
     1. The deck fills the screen. It is a control surface, not a web page.
     2. A slot means the same thing on every device. The previous build
        re-flowed columns on narrow screens while still walking the designed
        column count, so a button drawn at row 0 / column 3 of a 4-wide deck
        landed at row 1 / column 0 on a phone. Muscle memory is the product
        here, so the designed grid is now honoured exactly and the tiles
        resize instead. */

(function () {
  "use strict"

  var $ = function (id) { return document.getElementById(id) }
  var gridEl = $("grid")
  var profilesEl = $("profiles")
  var toastEl = $("toast")

  var TILE_MIN = 56          /* preferred smallest row height */
  var TOUCH_MIN = 44         /* hard floor: below this a target is unusable */
  var MAX_ASPECT = 2          /* tallest a tile may get relative to its width */
  var library = null
  var activeId = null
  var libraryRev = -1
  var toggles = {}
  var inflight = {}          /* press keys awaiting a reply, so a push cannot stomp them */
  var playing = []           /* sound slots playing on the computer right now */
  var levels = {}            /* fader levels by target key, 0..1 */
  var dragging = {}          /* fader ids under a finger, so a push cannot yank them */
  var toastTimer = null
  var resizeTimer = null

  /* --------------------------------------------------------------- helpers */

  function toast(message, isError) {
    toastEl.textContent = message
    toastEl.className = "toast show" + (isError ? " is-error" : "")
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function () { toastEl.className = "toast" }, 2400)
  }

  /* ------------------------------------------------------------ pairing */

  /* A paired deck keeps its id and secret here and signs every request with
     them (sign.js). The secret was sent once, at pairing, and never again. */
  var DEVICE_KEY = "punchboard-device"
  var device = null
  var clockOffset = 0        /* server clock minus ours, so signatures are on time */

  function readDevice() {
    try {
      var stored = JSON.parse(localStorage.getItem(DEVICE_KEY) || "null")
      return stored && stored.id && stored.secret ? stored : null
    } catch (e) { return null }
  }

  function saveDevice(next) {
    device = next
    try {
      if (next) localStorage.setItem(DEVICE_KEY, JSON.stringify(next))
      else localStorage.removeItem(DEVICE_KEY)
    } catch (e) {}
  }

  function serverNow() { return Math.round(Date.now() + clockOffset) }

  function syncClock() {
    return fetch("/api/hello").then(function (response) { return response.json() }).then(function (data) {
      clockOffset = data.serverTime - Date.now()
      applyAccent(data.accent)
      applyTheme(data.theme)
    })
  }

  function signedHeaders(method, path, body) {
    var headers = {}
    if (!device) return headers
    var signed = PunchboardSign.sign(device, method, path, body || "", serverNow())
    headers["X-Punchboard-Device"] = signed.device
    headers["X-Punchboard-Time"] = signed.time
    headers["X-Punchboard-Nonce"] = signed.nonce
    headers["X-Punchboard-Signature"] = signed.signature
    return headers
  }

  function unpairedError() {
    var error = new Error("This deck needs to be paired.")
    error.unpaired = true
    return error
  }

  /* Every request is signed. A clock or replay refusal is retried once with a
     fresh signature; "unpaired" means the pairing was removed on the computer. */
  function api(url, options, retried) {
    options = options || {}
    var method = options.method || "GET"
    var headers = signedHeaders(method, url.split("?")[0], options.body)
    var given = options.headers || {}
    Object.keys(given).forEach(function (key) { headers[key] = given[key] })
    return fetch(url, { method: method, headers: headers, body: options.body }).then(function (response) {
      return response.json().then(function (data) {
        if (response.ok) return data
        if (response.status === 401) {
          if (data.serverTime) clockOffset = data.serverTime - Date.now()
          if ((data.code === "clock" || data.code === "replay") && !retried) return api(url, options, true)
          if (data.code === "unpaired" || !device) {
            saveDevice(null)
            showPairing()
            throw unpairedError()
          }
        }
        throw new Error(data.error || "Request failed")
      })
    })
  }

  function showPairing(message) {
    document.body.classList.add("needs-pairing")
    $("pair-error").textContent = message || ""
    setTimeout(function () { $("pair-code").focus() }, 50)
  }

  function claim(code) {
    $("pair-error").textContent = ""
    $("pair-submit").disabled = true
    return fetch("/api/pair/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code })
    }).then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok) throw new Error(data.error || "Pairing failed")
        clockOffset = data.serverTime - Date.now()
        saveDevice(data.device)
        document.body.classList.remove("needs-pairing")
        toast("Paired. This deck is ready.")
        start()
      })
    }).catch(function (error) {
      showPairing(error.message)
    }).then(function () {
      $("pair-submit").disabled = false
    })
  }

  $("pair-form").addEventListener("submit", function (event) {
    event.preventDefault()
    var code = $("pair-code").value.replace(/\D/g, "")
    if (code.length !== 6) return showPairing("Enter the 6-digit code shown on the computer.")
    claim(code)
  })

  function buzz(ms) {
    if (navigator.vibrate) { try { navigator.vibrate(ms) } catch (e) {} }
  }

  function activeProfile() {
    if (!library) return null
    for (var i = 0; i < library.profiles.length; i += 1) {
      if (library.profiles[i].id === activeId) return library.profiles[i]
    }
    return library.profiles[0] || null
  }

  function toggleKey(button) { return activeId + ":" + button.id }

  /* --------------------------------------------------------------- render */

  function renderProfiles() {
    profilesEl.innerHTML = ""
    /* One profile is not a choice, so the row stays out of the way. */
    if (!library || library.profiles.length < 2) return
    library.profiles.forEach(function (profile) {
      var tab = document.createElement("button")
      tab.type = "button"
      tab.textContent = profile.name
      tab.className = profile.id === activeId ? "active" : ""
      tab.setAttribute("aria-pressed", String(profile.id === activeId))
      tab.onclick = function () {
        activeId = profile.id
        renderProfiles()
        renderGrid()
        syncFaders()
      }
      profilesEl.appendChild(tab)
    })
  }

  function tileMarkup(button) {
    if (button.control === "fader") return faderMarkup(button)
    var label = button.label || ""
    var wrap = document.createElement("button")
    wrap.type = "button"
    wrap.className = "tile"
    wrap.setAttribute("data-button-id", button.id)
    applyTileColor(wrap, button.color)

    var icon = document.createElement("span")
    icon.className = "tile-icon"
    icon.innerHTML = iconMarkup(button)

    var text = document.createElement("span")
    text.className = "tile-label"
    text.textContent = label

    wrap.appendChild(icon)
    if (label) wrap.appendChild(text)

    if (isStateful(button)) paintState(wrap, button)
    /* Screen readers get the action, not just the label. */
    wrap.setAttribute("aria-label", label || describe(button))
    return wrap
  }

  /* Buttons with an on/off state the deck can show: OBS toggles, and a
     single "Play a sound", which is lit while its sound plays. */
  function isStateful(button) {
    if (button.control === "fader") return false
    if (soundSlotOf(button)) return true
    return button.steps.length === 1 && STATEFUL_ACTIONS.indexOf(button.steps[0].type) !== -1
  }

  function isOn(button) {
    var slot = soundSlotOf(button)
    if (slot) return playing.indexOf(slot) !== -1
    return Boolean(toggles[toggleKey(button)])
  }

  function paintState(tile, button) {
    var on = isOn(button)
    tile.classList.toggle("is-on", on)
    tile.classList.toggle("is-playing", on && Boolean(soundSlotOf(button)))
    tile.setAttribute("aria-pressed", String(on))
  }

  /* ---------------------------------------------------------------- faders */

  function levelFor(button) {
    var level = levels[faderLevelKey(button.fader)]
    return typeof level === "number" ? level : null
  }

  function faderMarkup(button) {
    var tile = document.createElement("div")
    tile.className = "tile fader"
    tile.setAttribute("data-button-id", button.id)
    tile.setAttribute("role", "slider")
    tile.setAttribute("aria-valuemin", "0")
    tile.setAttribute("aria-valuemax", "100")
    tile.setAttribute("aria-label", button.label || FADER_TARGETS[button.fader.target].label)
    tile.tabIndex = 0
    applyTileColor(tile, button.color)

    var fill = document.createElement("span")
    fill.className = "fader-fill"
    var value = document.createElement("span")
    value.className = "fader-value"
    var icon = document.createElement("span")
    icon.className = "tile-icon"
    icon.innerHTML = iconMarkup(button)
    tile.appendChild(fill)
    tile.appendChild(value)
    tile.appendChild(icon)
    if (button.label) {
      var text = document.createElement("span")
      text.className = "tile-label"
      text.textContent = button.label
      tile.appendChild(text)
    }
    showLevel(tile, levelFor(button))
    bindFader(tile, button)
    return tile
  }

  function showLevel(tile, level) {
    var known = typeof level === "number"
    var percent = known ? Math.round(level * 100) : 0
    tile.querySelector(".fader-fill").style.height = percent + "%"
    tile.querySelector(".fader-value").textContent = known ? percent + "%" : "–"
    if (known) tile.setAttribute("aria-valuenow", String(percent))
  }

  /* Relative drag: a full tile height is the whole range, and touching the
     tile never jumps the level to where the finger landed. Touch and mouse
     are bound separately because the oldest tablets have no pointer events. */
  function bindFader(tile, button) {
    var startY = 0
    var startLevel = 0
    var active = false

    function begin(y) {
      if (document.body.classList.contains("is-offline")) {
        toast("Companion offline — nothing was sent.", true)
        return false
      }
      active = true
      dragging[button.id] = true
      startY = y
      var current = levelFor(button)
      startLevel = current === null ? 0.5 : current
      tile.classList.add("is-dragging")
      return true
    }
    function move(y) {
      if (!active) return
      var level = Math.max(0, Math.min(1, startLevel + (startY - y) / (tile.clientHeight || 1)))
      levels[faderLevelKey(button.fader)] = level
      showLevel(tile, level)
      sendLevel(button, level)
    }
    function end() {
      if (!active) return
      active = false
      tile.classList.remove("is-dragging")
      flushLevel(button)
      /* Let the last echo from the server land before pushes move it again. */
      setTimeout(function () { delete dragging[button.id] }, 400)
    }

    tile.addEventListener("touchstart", function (event) {
      if (event.touches.length !== 1) return
      event.preventDefault()
      begin(event.touches[0].clientY)
    })
    tile.addEventListener("touchmove", function (event) {
      event.preventDefault()
      move(event.touches[0].clientY)
    })
    tile.addEventListener("touchend", end)
    tile.addEventListener("touchcancel", end)

    tile.addEventListener("mousedown", function (event) {
      if (!begin(event.clientY)) return
      event.preventDefault()
      var onMove = function (e) { move(e.clientY) }
      var onUp = function () {
        document.removeEventListener("mousemove", onMove)
        document.removeEventListener("mouseup", onUp)
        end()
      }
      document.addEventListener("mousemove", onMove)
      document.addEventListener("mouseup", onUp)
    })

    tile.addEventListener("keydown", function (event) {
      var step = event.key === "ArrowUp" || event.key === "ArrowRight" ? 0.05
        : event.key === "ArrowDown" || event.key === "ArrowLeft" ? -0.05 : 0
      if (!step) return
      event.preventDefault()
      var current = levelFor(button)
      var level = Math.max(0, Math.min(1, (current === null ? 0.5 : current) + step))
      levels[faderLevelKey(button.fader)] = level
      showLevel(tile, level)
      postLevel(button, level)
    })
  }

  /* At most one request per fader every 90ms while dragging, always ending
     on the final value. */
  var faderQueue = {}

  function sendLevel(button, level) {
    var queued = faderQueue[button.id] || (faderQueue[button.id] = { timer: null, level: 0 })
    queued.level = level
    if (queued.timer) return
    queued.timer = setTimeout(function () {
      queued.timer = null
      postLevel(button, queued.level)
    }, 90)
  }

  function flushLevel(button) {
    var queued = faderQueue[button.id]
    if (!queued || !queued.timer) return
    clearTimeout(queued.timer)
    queued.timer = null
    postLevel(button, queued.level)
  }

  function postLevel(button, level) {
    api("/api/volume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: activeId, buttonId: button.id, level: level })
    }).catch(function (error) { toast(error.message, true) })
  }

  /* Asks the companion to read the real levels (OBS, the computer), so a
     fader starts where the sound actually is. */
  function syncFaders() {
    var profile = activeProfile()
    if (!profile || !profile.buttons.some(function (button) { return button.control === "fader" })) return
    api("/api/volume/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: activeId })
    }).catch(function () {})
  }

  function describe(button) {
    if (button.steps.length > 1) return button.steps.length + "-step macro"
    return stepSummary(button.steps[0])
  }

  function renderGrid() {
    if (!library) return
    var profile = activeProfile()
    gridEl.innerHTML = ""

    if (!profile || !profile.buttons.length) {
      var empty = document.createElement("div")
      empty.className = "deck-empty"
      empty.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>' +
        "<div><strong>This deck is empty.</strong><br>Open the Control Center on your computer and add some buttons.</div>"
      gridEl.style.display = "block"
      gridEl.appendChild(empty)
      return
    }

    gridEl.style.display = "grid"
    /* Written as literal strings on purpose: repeat(var(--n), …) misbehaves on
       the older Safari versions this product is explicitly aimed at. */
    gridEl.style.gridTemplateColumns = "repeat(" + profile.columns + ",minmax(0,1fr))"

    var bySlot = {}
    profile.buttons.forEach(function (button) { bySlot[button.slot] = button })

    var total = profile.rows * profile.columns
    for (var slot = 0; slot < total; slot += 1) {
      var button = bySlot[slot]
      if (!button) {
        var blank = document.createElement("div")
        blank.className = "slot-empty"
        blank.setAttribute("aria-hidden", "true")
        gridEl.appendChild(blank)
        continue
      }
      var tile = tileMarkup(button)
      bindPress(tile, button)
      gridEl.appendChild(tile)
    }
    scaleTiles()
  }

  /* Sizes the rows and then the tile contents from the real box.

     Filling the screen is the point, but only up to a limit: a 4-wide deck
     stretched down a portrait phone produced tiles 4.5 times taller than they
     were wide, which turned every label into "Brows / er". Rows grow to fill
     the space until a tile would get taller than MAX_ASPECT, then they stop
     and the grid centres itself instead.

     Container queries would be the tidy way to scale the contents, but they
     need Safari 16 and this deck is meant to run on whatever tablet was in
     the drawer. */
  function scaleTiles() {
    var profile = activeProfile()
    if (!profile || !gridEl.querySelector(".tile")) return

    /* Measure with the previous row heights cleared. Reading clientHeight while
       explicit pixel rows are still applied measures the grid we just sized,
       not the space available for it — which on a short, wide phone ratcheted
       the grid to twice the viewport height and cut off the bottom row. */
    gridEl.style.gridTemplateRows = ""
    gridEl.style.alignContent = ""

    var width = gridEl.clientWidth
    var height = gridEl.clientHeight
    if (!width || !height) return

    var columns = profile.columns
    var rows = profile.rows
    var gap = width / columns < 92 ? 6 : 10
    gridEl.style.setProperty("--deck-gap", gap + "px")

    var colWidth = (width - gap * (columns - 1)) / columns
    var roomPerRow = (height - gap * (rows - 1)) / rows

    var rowHeight = Math.min(roomPerRow, colWidth * MAX_ASPECT)
    if (rowHeight < TILE_MIN) {
      /* Tight fit: shrink towards the touch floor before giving up and
         scrolling, because a deck you have to scroll is a broken deck. */
      rowHeight = Math.max(TOUCH_MIN, Math.min(TILE_MIN, roomPerRow))
    }
    rowHeight = Math.floor(rowHeight)
    /* Measured, not inferred: the rows either fit in the space or they do not. */
    var scrolls = rows * rowHeight + gap * (rows - 1) > height + 1

    gridEl.style.gridTemplateRows = "repeat(" + rows + "," + rowHeight + "px)"
    /* start when it overflows (so the first rows stay put and the rest can be
       reached), centre when the aspect cap left slack, stretch otherwise. */
    gridEl.style.alignContent = scrolls ? "start" : rowHeight < roomPerRow - 1 ? "center" : "stretch"
    gridEl.style.overflowY = scrolls ? "auto" : "hidden"

    var icon = Math.max(22, Math.min(76, Math.round(Math.min(colWidth, rowHeight) * 0.42)))
    /* Label size follows the width, because that is what a label runs along. */
    var font = Math.max(10, Math.min(19, Math.round(colWidth * 0.15)))
    gridEl.style.setProperty("--tile-ico", icon + "px")
    gridEl.style.setProperty("--tile-fs", font + "px")

    /* Under this the label and the icon just crowd each other out. */
    var showLabel = rowHeight >= 62
    var labels = gridEl.querySelectorAll(".tile-label")
    for (var i = 0; i < labels.length; i += 1) {
      labels[i].style.display = showLabel ? "" : "none"
    }

    suggestLandscape(colWidth)
  }

  /* A wide deck on a portrait phone is always going to be cramped. Say so
     once, rather than silently handing over tiny buttons. */
  var hintShown = false
  function suggestLandscape(colWidth) {
    if (hintShown || colWidth >= 86) return
    if (window.innerWidth > window.innerHeight) return
    hintShown = true
    toast("Turn the phone sideways for bigger buttons.")
  }

  /* ---------------------------------------------------------------- press */

  function bindPress(tile, button) {
    tile.addEventListener("click", function () { press(button, tile) })
  }

  function press(button, tile) {
    if (document.body.classList.contains("is-offline")) {
      toast("Companion offline — nothing was sent.", true)
      return
    }
    buzz(12)
    tile.classList.add("pressed")
    setTimeout(function () { tile.classList.remove("pressed") }, 160)

    if (!isConfigured(button)) {
      toast("This button has no action yet.")
      return
    }

    /* "Open link on the tablet" has to open inside the tap itself, or the
       browser's popup blocker eats it. A lone link opens straight away; a
       macro gets a window now and its address when the companion replies. */
    var linkOnly = button.steps.length === 1 && button.steps[0].type === "browser_tile"
    if (linkOnly) {
      if (/^https?:\/\//i.test(button.steps[0].url || "")) window.open(button.steps[0].url, "_blank", "noopener")
      else toast("Add a valid http or https address for this link.", true)
      return
    }
    var hasLink = button.steps.some(function (step) { return step.type === "browser_tile" })
    var linkWindow = hasLink ? window.open("", "_blank") : null

    var key = toggleKey(button)
    inflight[key] = true
    tile.classList.add("is-busy")

    /* Only ids travel: the companion runs the button as saved on the computer. */
    api("/api/press", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ buttonId: button.id, profileId: activeId })
    }).then(function (result) {
      tile.classList.remove("is-busy", "is-error")
      if (linkWindow) {
        if (result.tabletUrl) linkWindow.location.href = result.tabletUrl
        else linkWindow.close()
      }
      if (typeof result.active === "boolean") {
        toggles[key] = result.active
        paintState(tile, button)
      }
      if (result.message) toast(result.message)
    }).catch(function (error) {
      if (linkWindow) linkWindow.close()
      tile.classList.remove("is-busy")
      if (error.unpaired) return
      tile.classList.add("is-error")
      setTimeout(function () { tile.classList.remove("is-error") }, 1600)
      buzz([8, 60, 8])
      toast(error.message, true)
    }).then(function () {
      delete inflight[key]
    })
  }

  /* ----------------------------------------------------------------- sync */

  function applyState(state) {
    if (!state) return
    if (state.accent) applyAccent(state.accent)
    if (state.theme) applyTheme(state.theme)
    if (state.toggles) {
      /* Never overwrite a key whose press is still in the air. */
      Object.keys(state.toggles).forEach(function (key) {
        if (!inflight[key]) toggles[key] = state.toggles[key]
      })
    }
    if (state.playing) playing = state.playing
    if (state.levels) {
      Object.keys(state.levels).forEach(function (key) { levels[key] = state.levels[key] })
    }
    refreshLiveState()
    if (typeof state.libraryRev === "number" && state.libraryRev !== libraryRev) {
      libraryRev = state.libraryRev
      loadLibrary()
    }
  }

  /* Repaints live state without rebuilding the DOM, so a tile never flickers
     underneath a finger. */
  function refreshLiveState() {
    var profile = activeProfile()
    if (!profile) return
    var byId = {}
    profile.buttons.forEach(function (button) { byId[button.id] = button })
    var tiles = gridEl.querySelectorAll(".tile")
    for (var i = 0; i < tiles.length; i += 1) {
      var button = byId[tiles[i].getAttribute("data-button-id")]
      if (!button) continue
      if (button.control === "fader") {
        if (!dragging[button.id]) showLevel(tiles[i], levelFor(button))
      } else if (isStateful(button)) {
        paintState(tiles[i], button)
      }
    }
  }

  function setOnline(online) {
    document.body.classList.toggle("is-offline", !online)
    $("link-status").className = "link-status" + (online ? "" : " is-offline")
    $("link-text").textContent = online ? "Connected" : "Companion offline"
  }

  function loadLibrary() {
    return api("/api/library").then(function (next) {
      library = normalizeLibrary(next)
      var stillThere = library.profiles.some(function (p) { return p.id === activeId })
      if (!stillThere) activeId = library.activeProfileId
      renderProfiles()
      renderGrid()
      syncFaders()
    })
  }

  /* Server-push first. EventSource is available even on quite old Safari.
     It cannot send headers, so the stream is signed in its address, and each
     reconnect needs a fresh signature, so reconnecting is done here rather
     than left to the browser. */
  var source = null
  var reconnectTimer = null

  function eventsUrl() {
    if (!device) return "/api/events"
    var signed = PunchboardSign.sign(device, "GET", "/api/events", "", serverNow())
    return "/api/events?d=" + encodeURIComponent(signed.device) + "&t=" + signed.time +
      "&n=" + signed.nonce + "&s=" + signed.signature
  }

  function scheduleReconnect(delay) {
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(connect, delay)
  }

  function connect() {
    if (source) { source.close(); source = null }

    if (!window.EventSource) {
      api("/api/status").then(function (state) {
        setOnline(true)
        applyState(state)
      }).catch(function (error) {
        if (!error.unpaired) setOnline(false)
      }).then(function () {
        if (!document.body.classList.contains("needs-pairing")) scheduleReconnect(1500)
      })
      return
    }

    source = new EventSource(eventsUrl())
    source.onopen = function () { setOnline(true) }
    source.onmessage = function (event) {
      setOnline(true)
      try { applyState(JSON.parse(event.data)) } catch (e) {}
    }
    source.onerror = function () {
      source.close()
      source = null
      setOnline(false)
      /* Find out why: an unpaired deck shows the pairing screen instead of
         retrying forever. The status check also resyncs the clock. */
      api("/api/status").then(function () {
        scheduleReconnect(0)
      }).catch(function (error) {
        if (!error.unpaired) scheduleReconnect(2000)
      })
    }
  }

  /* Closing on unload keeps the browser from logging the aborted stream as
     ERR_INCOMPLETE_CHUNKED_ENCODING every time the page navigates away. */
  window.addEventListener("pagehide", function () { if (source) source.close() })

  /* ------------------------------------------------------------ immersive */

  function setImmersive(on) {
    document.body.classList.toggle("immersive", on)
    var btn = $("immersive-btn")
    btn.textContent = on ? "Exit full screen" : "Full screen"
    btn.setAttribute("aria-pressed", String(on))
    setTimeout(scaleTiles, 60)
  }

  $("immersive-btn").addEventListener("click", function () {
    var leaving = document.body.classList.contains("immersive")
    if (!leaving && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(function () {})
    } else if (leaving && document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(function () {})
    }
    setImmersive(!leaving)
  })

  /* The way back out. The old build revealed the bar on :hover, which a
     touchscreen cannot produce, so immersive mode was a one-way door. */
  $("reveal-grip").addEventListener("click", function () { setImmersive(false) })

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && document.body.classList.contains("immersive")) setImmersive(false)
  })

  document.addEventListener("fullscreenchange", function () {
    if (!document.fullscreenElement && document.body.classList.contains("immersive")) setImmersive(false)
  })

  /* ---------------------------------------------------------------- start */

  function onResize() {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(function () {
      /* Only the measurements change, so there is no need to rebuild tiles. */
      scaleTiles()
    }, 120)
  }
  window.addEventListener("resize", onResize)
  window.addEventListener("orientationchange", function () { setTimeout(scaleTiles, 250) })

  function start() {
    api("/api/settings")
      .then(function (settings) { applyAccent(settings.accent); applyTheme(settings.theme) })
      .catch(function () {})

    loadLibrary()
      .then(function () { setOnline(true); connect() })
      .catch(function (error) {
        if (error.unpaired) return
        setOnline(false)
        toast(error.message, true)
        connect()
      })
  }

  /* A QR from the pairing page carries its code in the address hash, which
     is never sent to the server. Use it, then wipe it from the address bar. */
  function takeHashCode() {
    var code = (location.hash.match(/pair=(\d{6})/) || [])[1]
    if (code && window.history && history.replaceState) history.replaceState(null, "", location.pathname)
    return code
  }

  /* Scanning a new code while the pairing screen is already open only
     changes the hash, so that has to pair too. */
  window.addEventListener("hashchange", function () {
    var code = takeHashCode()
    if (code && document.body.classList.contains("needs-pairing")) claim(code)
  })

  device = readDevice()
  var hashCode = takeHashCode()
  syncClock().catch(function () {}).then(function () {
    if (hashCode && !device) return claim(hashCode)
    start()
  })
})()
