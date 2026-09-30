/* The Control Center.

   Notable departures from the previous build:
     - Autosave is the only save. The old "Save now" was styled as the loudest
       button on the page while a 650ms debounce had already saved everything.
     - Selecting a tile builds the inspector once; every later edit mutates it
       in place. The old render() rebuilt the whole panel on each change and
       threw away focus, scroll position and the open state of every control.
     - Buttons can be dragged between slots, and moved with Alt+Arrow for
       anyone not using a mouse. The marketing copy promised this.
     - Actions chain into macros with per-step delays, also promised.
     - No prompt(), confirm() or alert(). */

(function () {
  "use strict"

  var $ = function (id) { return document.getElementById(id) }
  var gridEl = $("grid")
  var listEl = $("profile-list")
  var inspectorEl = $("inspector")
  var toastEl = $("toast")

  var library = null
  var activeId = null
  var selectedSlot = null
  var dragFrom = null
  var iconTargetId = null
  var saveTimer = null
  var saving = false
  var libraryRev = null
  var toastTimer = null
  var audioUnlocked = false
  var soundVolume = 1

  /* --------------------------------------------------------------- helpers */

  function api(url, options) {
    return fetch(url, options).then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok) {
          var error = new Error(data.error || "Request failed")
          error.status = response.status
          throw error
        }
        return data
      }, function () {
        var error = new Error("The companion sent an unreadable reply (" + response.status + ").")
        error.status = response.status
        throw error
      })
    })
  }

  /* The library comes with its revision, which every save sends back so two
     windows can never silently overwrite each other's work. */
  function fetchLibrary() {
    return fetch("/api/library").then(function (response) {
      if (!response.ok) throw new Error("Could not load the deck.")
      libraryRev = Number(response.headers.get("X-Library-Rev")) || null
      return response.json()
    }).then(normalizeLibrary)
  }

  /* Picks up a newer library from elsewhere, keeping the current selection
     where it still exists. */
  function reloadLibrary(message) {
    return fetchLibrary().then(function (next) {
      library = next
      if (!library.profiles.some(function (p) { return p.id === activeId })) activeId = library.activeProfileId
      if (!selectedButton()) selectedSlot = null
      setSaveState("", "Saved · decks in sync")
      renderAll()
      if (message) toast(message)
    }).catch(function (error) { toast(error.message, true) })
  }

  function toast(message, isError) {
    toastEl.textContent = message
    toastEl.className = "toast show" + (isError ? " is-error" : "")
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function () { toastEl.className = "toast" }, 2600)
  }

  function svg(paths, width) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' +
      (width ? ' style="width:' + width + 'px;height:' + width + 'px"' : "") + ">" + paths + "</svg>"
  }

  var ICON_X = '<path d="M18 6 6 18M6 6l12 12"/>'
  var ICON_PLUS = '<path d="M12 5v14M5 12h14"/>'
  var ICON_UP = '<path d="m18 15-6-6-6 6"/>'
  var ICON_DOWN = '<path d="m6 9 6 6 6-6"/>'

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function activeProfile() {
    if (!library) return null
    for (var i = 0; i < library.profiles.length; i += 1) {
      if (library.profiles[i].id === activeId) return library.profiles[i]
    }
    return library.profiles[0]
  }

  function selectedButton() {
    if (selectedSlot === null) return null
    var profile = activeProfile()
    if (!profile) return null
    for (var i = 0; i < profile.buttons.length; i += 1) {
      if (profile.buttons[i].slot === selectedSlot) return profile.buttons[i]
    }
    return null
  }

  /* ------------------------------------------------------- dialog helpers */

  function ask(options) {
    var dialog = $("dlg-ask")
    $("ask-title").textContent = options.title
    $("ask-label").textContent = options.label || options.title
    $("ask-ok").textContent = options.confirm || "Save"
    var input = $("ask-input")
    input.value = options.value || ""
    input.maxLength = options.maxLength || 60
    return new Promise(function (resolve) {
      dialog.onclose = function () {
        resolve(dialog.returnValue === "ok" ? input.value.trim() : null)
      }
      dialog.showModal()
      input.select()
    })
  }

  function confirmAction(options) {
    var dialog = $("dlg-confirm")
    $("confirm-title").textContent = options.title
    $("confirm-text").textContent = options.text
    var ok = $("confirm-ok")
    ok.textContent = options.confirm || "Delete"
    ok.className = options.safe ? "btn primary" : "btn danger"
    return new Promise(function (resolve) {
      dialog.onclose = function () { resolve(dialog.returnValue === "ok") }
      dialog.showModal()
    })
  }

  /* ------------------------------------------------------------- saving */

  function setSaveState(mode, message) {
    var chip = $("save-chip")
    chip.className = "save-chip" + (mode ? " is-" + mode : "")
    $("save-text").textContent = message
  }

  function queueSave() {
    setSaveState("saving", "Saving")
    clearTimeout(saveTimer)
    saveTimer = setTimeout(function () { saveTimer = null; save() }, 500)
  }

  function saveTimerPending() { return saveTimer !== null }

  function save() {
    if (!library) return Promise.resolve()
    library.activeProfileId = activeId
    saving = true
    return api("/api/library?rev=" + libraryRev, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      /* `open` tracks which step card is expanded. That is inspector state,
         not deck data, so it never reaches the saved file. */
      body: JSON.stringify(library, function (key, value) {
        return key === "open" ? undefined : value
      })
    }).then(function (result) {
      saving = false
      libraryRev = result.libraryRev
      setSaveState("", "Saved · decks in sync")
    }).catch(function (error) {
      saving = false
      if (error.status === 409) {
        /* Another window saved first. Theirs is on disk, so take it rather
           than overwrite it; this window's unsaved edit is the one lost. */
        clearTimeout(saveTimer)
        saveTimer = null
        reloadLibrary("This deck was changed in another window, so it was reloaded. Redo your last change.")
        return
      }
      setSaveState("error", "Not saved")
      toast(error.message, true)
    })
  }

  /* Edits mutate the in-memory library then queue a write. Keeping the model
     mutable avoids the old build's habit of rebuilding every profile object
     on each keystroke. */
  function touch() {
    var profile = activeProfile()
    if (profile) profile.updatedAt = new Date().toISOString()
    queueSave()
  }

  /* ------------------------------------------------------ profile rail */

  function renderProfiles() {
    listEl.innerHTML = ""
    library.profiles.forEach(function (profile) {
      var row = el("button", "profile-row" + (profile.id === activeId ? " active" : ""))
      row.type = "button"
      row.setAttribute("aria-pressed", String(profile.id === activeId))
      row.appendChild(el("strong", null, profile.name))
      var count = profile.buttons.length
      row.appendChild(el("small", null, count + (count === 1 ? " button · " : " buttons · ") + profile.columns + "×" + profile.rows))
      row.onclick = function () {
        activeId = profile.id
        selectedSlot = null
        queueSave()
        renderAll()
      }
      listEl.appendChild(row)
    })
    $("delete-profile").disabled = library.profiles.length < 2
  }

  /* ----------------------------------------------------------- the grid */

  function tileNode(button) {
    var tile = el("button", "tile")
    tile.type = "button"
    tile.draggable = true
    tile.dataset.slot = String(button.slot)
    applyTileColor(tile, button.color)
    if (!isConfigured(button)) tile.classList.add("unconfigured")
    if (button.slot === selectedSlot) tile.classList.add("selected")

    var badgeText = tileBadge(button)
    if (badgeText) tile.appendChild(el("span", "step-count", badgeText))

    var icon = el("span", "tile-icon")
    icon.innerHTML = iconMarkup(button)
    tile.appendChild(icon)

    var label = el("span", "tile-label" + (button.label ? "" : " is-empty"), button.label || "Untitled")
    tile.appendChild(label)

    tile.setAttribute("aria-label", (button.label || "Untitled") + " — " + describeButton(button))
    tile.onclick = function () { select(button.slot) }

    tile.addEventListener("dragstart", function (event) {
      dragFrom = button.slot
      tile.classList.add("dragging")
      event.dataTransfer.effectAllowed = "move"
      /* Firefox refuses to start a drag without payload. */
      try { event.dataTransfer.setData("text/plain", String(button.slot)) } catch (e) {}
    })
    tile.addEventListener("dragend", function () {
      dragFrom = null
      tile.classList.remove("dragging")
      clearDropTargets()
    })
    return tile
  }

  /* Faders and macros say so on the tile, so they are spotted at a glance. */
  function tileBadge(button) {
    if (button.control === "fader") return "Fader"
    return button.steps.length > 1 ? button.steps.length + " steps" : ""
  }

  function describeButton(button) {
    if (!isConfigured(button)) return "no action yet"
    if (button.control === "fader") return FADER_TARGETS[button.fader.target].label
    return stepSummary(button.steps[0])
  }

  function addSlotNode(slot) {
    var add = el("button", "add-slot")
    add.type = "button"
    add.innerHTML = svg(ICON_PLUS, 20)
    add.setAttribute("aria-label", "Add a button in slot " + (slot + 1))
    add.onclick = function () {
      var profile = activeProfile()
      profile.buttons.push(createEmptyButton(slot))
      touch()
      select(slot)
      renderGrid()
      renderProfiles()
    }
    return add
  }

  function clearDropTargets() {
    var marked = gridEl.querySelectorAll(".drop-target")
    for (var i = 0; i < marked.length; i += 1) marked[i].classList.remove("drop-target")
  }

  function moveButton(fromSlot, toSlot) {
    if (fromSlot === toSlot) return
    var profile = activeProfile()
    var source = null
    var target = null
    profile.buttons.forEach(function (button) {
      if (button.slot === fromSlot) source = button
      if (button.slot === toSlot) target = button
    })
    if (!source) return
    source.slot = toSlot
    /* Occupied destination: swap, so nothing is ever silently overwritten. */
    if (target) target.slot = fromSlot
    selectedSlot = toSlot
    touch()
    renderGrid()
  }

  function renderGrid() {
    var profile = activeProfile()
    gridEl.innerHTML = ""
    gridEl.style.gridTemplateColumns = "repeat(" + profile.columns + ",minmax(0,1fr))"

    var bySlot = {}
    profile.buttons.forEach(function (button) { bySlot[button.slot] = button })

    var total = profile.rows * profile.columns
    for (var slot = 0; slot < total; slot += 1) {
      var wrap = el("div", "slot-wrap")
      wrap.dataset.slot = String(slot)
      wrap.appendChild(bySlot[slot] ? tileNode(bySlot[slot]) : addSlotNode(slot))

      wrap.addEventListener("dragover", function (event) {
        if (dragFrom === null) return
        event.preventDefault()
        event.dataTransfer.dropEffect = "move"
        if (Number(this.dataset.slot) !== dragFrom) this.classList.add("drop-target")
      })
      wrap.addEventListener("dragleave", function () { this.classList.remove("drop-target") })
      wrap.addEventListener("drop", function (event) {
        event.preventDefault()
        this.classList.remove("drop-target")
        if (dragFrom === null) return
        moveButton(dragFrom, Number(this.dataset.slot))
        dragFrom = null
      })

      gridEl.appendChild(wrap)
    }
    renderParked()
  }

  /* Only refreshes one tile's visible bits, so typing a label does not
     rebuild the grid underneath the cursor. */
  function refreshTile(button) {
    var tile = gridEl.querySelector('.tile[data-slot="' + button.slot + '"]')
    if (!tile) return renderGrid()
    applyTileColor(tile, button.color)
    tile.classList.toggle("unconfigured", !isConfigured(button))
    var icon = tile.querySelector(".tile-icon")
    if (icon) icon.innerHTML = iconMarkup(button)
    var label = tile.querySelector(".tile-label")
    if (label) {
      label.textContent = button.label || "Untitled"
      label.classList.toggle("is-empty", !button.label)
    }
    var badge = tile.querySelector(".step-count")
    var badgeText = tileBadge(button)
    if (badgeText) {
      if (!badge) { badge = el("span", "step-count"); tile.insertBefore(badge, tile.firstChild) }
      badge.textContent = badgeText
    } else if (badge) {
      badge.remove()
    }
  }

  /* Buttons stranded outside the grid used to vanish with no explanation
     while still being counted in the profile total. */
  function renderParked() {
    var host = $("parked-notice")
    host.innerHTML = ""
    var profile = activeProfile()
    var parked = parkedButtons(profile)
    if (!parked.length) return

    var notice = el("div", "notice")
    notice.innerHTML = '<span class="notice-icon">' + svg('<path d="M12 9v4M12 17h.01"/><circle cx="12" cy="12" r="10"/>') + "</span>"
    var body = el("div")
    body.style.flex = "1 1 auto"
    body.appendChild(el("strong", null, parked.length + (parked.length === 1 ? " button is" : " buttons are") + " outside this grid"))
    body.appendChild(el("span", null, "Shrinking the grid left " + (parked.length === 1 ? "it" : "them") + " parked. Nothing was deleted — grow the grid back, or move " + (parked.length === 1 ? "it" : "them") + " into the free slots."))

    var actions = el("div", "notice-actions")
    var grow = el("button", "btn", "Grow the grid to fit")
    grow.type = "button"
    grow.onclick = function () {
      var needed = 0
      parked.forEach(function (button) { needed = Math.max(needed, button.slot + 1) })
      var rows = Math.min(6, Math.ceil(needed / profile.columns))
      profile.rows = rows
      $("rows").value = rows
      touch()
      renderGrid()
      renderProfiles()
      if (parkedButtons(profile).length) toast("Grid is at its maximum, so some buttons are still parked.")
    }
    var pull = el("button", "btn", "Move into free slots")
    pull.type = "button"
    pull.onclick = function () {
      var capacity = profile.rows * profile.columns
      var taken = {}
      profile.buttons.forEach(function (button) { if (button.slot < capacity) taken[button.slot] = true })
      var moved = 0
      parked.forEach(function (button) {
        for (var slot = 0; slot < capacity; slot += 1) {
          if (!taken[slot]) { button.slot = slot; taken[slot] = true; moved += 1; return }
        }
      })
      touch()
      renderGrid()
      renderProfiles()
      toast(moved ? "Moved " + moved + " into free slots." : "No free slots — make the grid bigger first.")
    }
    actions.appendChild(grow)
    actions.appendChild(pull)
    body.appendChild(actions)
    notice.appendChild(body)
    host.appendChild(notice)
  }

  /* ---------------------------------------------------------- inspector */

  function select(slot) {
    selectedSlot = slot
    var tiles = gridEl.querySelectorAll(".tile")
    for (var i = 0; i < tiles.length; i += 1) {
      tiles[i].classList.toggle("selected", Number(tiles[i].dataset.slot) === slot)
    }
    renderInspector()
  }

  function renderInspector() {
    inspectorEl.innerHTML = ""
    var button = selectedButton()

    if (!button) {
      var empty = el("div", "empty-inspector")
      empty.innerHTML =
        '<div class="big">' + svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>', 28) + "</div>" +
        "<div><strong>Nothing selected</strong></div>"
      empty.appendChild(el("div", "subtle", "Click a tile to edit it, or a dashed slot to add one."))
      inspectorEl.appendChild(empty)
      return
    }

    var head = el("div", "panel-head")
    head.appendChild(el("h2", null, "Button " + (button.slot + 1)))
    head.appendChild(el("span", "spacer"))
    var closeBtn = el("button", "icon-btn")
    closeBtn.type = "button"
    closeBtn.setAttribute("aria-label", "Deselect")
    closeBtn.innerHTML = svg(ICON_X)
    closeBtn.onclick = function () { selectedSlot = null; renderGrid(); renderInspector() }
    head.appendChild(closeBtn)
    inspectorEl.appendChild(head)

    var body = el("div", "inspector-body")
    inspectorEl.appendChild(body)

    /* ---- label */
    var labelField = el("div", "field label-field")
    var labelLabel = el("label", null, "Label")
    labelLabel.htmlFor = "label-input"
    var labelInput = document.createElement("input")
    labelInput.type = "text"
    labelInput.id = "label-input"
    labelInput.value = button.label
    labelInput.placeholder = "Go Live"
    labelInput.maxLength = 28
    labelInput.addEventListener("input", function () {
      button.label = labelInput.value
      refreshTile(button)
      touch()
    })
    labelField.appendChild(labelLabel)
    labelField.appendChild(labelInput)
    body.appendChild(labelField)

    /* ---- pressed button or fader */
    var kindField = el("div", "field")
    kindField.appendChild(el("span", "field-label", "Type"))
    var kinds = el("div", "segmented")
    kinds.setAttribute("role", "group")
    kinds.setAttribute("aria-label", "Button type")
    ;[["press", "Button"], ["fader", "Volume fader"]].forEach(function (pair) {
      var option = el("button", null, pair[1])
      option.type = "button"
      option.setAttribute("aria-pressed", String(button.control === pair[0]))
      option.onclick = function () { setControl(button, pair[0]) }
      kinds.appendChild(option)
    })
    kindField.appendChild(kinds)
    body.appendChild(kindField)

    /* ---- colour: flat and always visible */
    var colorField = el("div", "field")
    colorField.appendChild(el("span", "field-label", "Colour"))
    var swatches = el("div", "swatch-grid")
    BUTTON_COLORS.forEach(function (color) {
      var swatch = el("button", "swatch")
      swatch.type = "button"
      swatch.style.background = color.value
      swatch.title = color.label
      swatch.setAttribute("aria-label", color.label)
      swatch.setAttribute("aria-pressed", String(color.id === button.color))
      swatch.onclick = function () {
        button.color = color.id
        var all = swatches.querySelectorAll(".swatch")
        for (var i = 0; i < all.length; i += 1) all[i].setAttribute("aria-pressed", "false")
        swatch.setAttribute("aria-pressed", "true")
        applyTileColor(iconTrigger, button.color)
        refreshTile(button)
        touch()
      }
      swatches.appendChild(swatch)
    })
    colorField.appendChild(swatches)
    body.appendChild(colorField)

    /* ---- icon: a trigger plus a real picker, not a keyhole accordion */
    var iconField = el("div", "field")
    iconField.appendChild(el("span", "field-label", "Icon"))
    var iconTrigger = el("button", "icon-trigger")
    iconTrigger.type = "button"
    applyTileColor(iconTrigger, button.color)
    var preview = el("span", "preview")
    preview.innerHTML = iconMarkup(button)
    var names = el("div", "names")
    names.appendChild(el("strong", null, button.iconData ? "Custom image" : button.glyph ? button.glyph.name.replace(/_/g, " ") : button.icon))
    names.appendChild(el("small", null, button.iconData ? "Tap to use an icon instead" : button.glyph ? "Google icon · " + button.glyph.style : "Built-in · tap to browse, or pick a Google icon"))
    iconTrigger.appendChild(preview)
    iconTrigger.appendChild(names)
    iconTrigger.onclick = function () { openIconPicker(button) }
    iconField.appendChild(iconTrigger)

    /* custom upload lives under the icon it replaces, not beside it */
    var upload = el("div", "upload-row")
    var fileInput = document.createElement("input")
    fileInput.type = "file"
    fileInput.id = "icon-file"
    fileInput.className = "visually-hidden"
    fileInput.accept = "image/png,image/jpeg,image/webp,image/svg+xml,.svg"
    var fileLabel = el("label", "btn", button.iconData ? "Replace image" : "Upload image")
    fileLabel.htmlFor = "icon-file"
    var fileName = el("span", "name", button.iconData ? "Custom image in use" : "PNG, JPG, WebP or SVG · max 750 KB")
    fileInput.addEventListener("change", function () {
      var file = fileInput.files && fileInput.files[0]
      if (!file) return
      readIcon(file, function (data) {
        button.iconData = data
        delete button.glyph
        touch()
        refreshTile(button)
        renderInspector()
        toast("Custom icon saved in this deck.")
      })
    })
    upload.appendChild(fileInput)
    upload.appendChild(fileLabel)
    upload.appendChild(fileName)
    if (button.iconData) {
      var clearIcon = el("button", "icon-btn danger")
      clearIcon.type = "button"
      clearIcon.setAttribute("aria-label", "Remove the custom image")
      clearIcon.innerHTML = svg(ICON_X)
      clearIcon.onclick = function () {
        button.iconData = null
        touch()
        refreshTile(button)
        renderInspector()
      }
      upload.appendChild(clearIcon)
    }
    iconField.appendChild(upload)
    body.appendChild(iconField)

    /* ---- the macro */
    var stepsField = el("div", "field")
    var stepsHead = el("div")
    stepsHead.style.cssText = "display:flex;align-items:center;gap:8px"
    stepsHead.appendChild(el("span", "field-label", "What it does"))
    var spacer = el("span")
    spacer.style.flex = "1 1 auto"
    stepsHead.appendChild(spacer)
    stepsHead.appendChild(el("span", "subtle", button.steps.length > 1 ? button.steps.length + " steps, in order" : ""))
    stepsField.appendChild(stepsHead)

    var stepsHost = el("div", "steps")
    stepsHost.id = "steps-host"
    stepsField.appendChild(stepsHost)

    var addStep = el("button", "step-add")
    addStep.type = "button"
    addStep.innerHTML = svg(ICON_PLUS, 14) + "<span>Add another step</span>"
    addStep.onclick = function () {
      if (button.steps.length >= 12) return toast("A macro can hold at most 12 steps.")
      button.steps.push(createStep("none"))
      touch()
      refreshTile(button)
      renderSteps(button)
    }
    stepsField.appendChild(addStep)
    body.appendChild(button.control === "fader" ? faderField(button) : stepsField)

    /* ---- delete */
    var zone = el("div", "danger-zone")
    var remove = el("button", "btn danger wide", "Delete this button")
    remove.type = "button"
    remove.onclick = function () {
      confirmAction({
        title: "Delete this button?",
        text: "“" + (button.label || "Untitled") + "” will be removed from " + activeProfile().name + ".",
        confirm: "Delete button"
      }).then(function (yes) {
        if (!yes) return
        var profile = activeProfile()
        profile.buttons = profile.buttons.filter(function (item) { return item.id !== button.id })
        selectedSlot = null
        touch()
        renderAll()
      })
    }
    zone.appendChild(remove)
    body.appendChild(zone)

    renderSteps(button)
  }

  function setControl(button, control) {
    if (button.control === control) return
    button.control = control
    if (control === "fader") {
      button.fader = button.fader || { target: "sounds", inputName: "" }
      if (button.icon === DEFAULT_ICON && !button.iconData) button.icon = "sliders"
    }
    Object.assign(button, normalizeButton(button))
    touch()
    refreshTile(button)
    renderInspector()
  }

  function faderField(button) {
    var field = el("div", "field")
    var label = el("label", null, "Controls")
    var select = document.createElement("select")
    label.htmlFor = select.id = "fader-target"
    Object.keys(FADER_TARGETS).forEach(function (id) {
      select.add(new Option(FADER_TARGETS[id].label, id, false, id === button.fader.target))
    })
    select.addEventListener("change", function () {
      button.fader.target = select.value
      touch()
      refreshTile(button)
      renderInspector()
    })
    field.appendChild(label)
    field.appendChild(select)
    field.appendChild(el("p", "field-help", FADER_TARGETS[button.fader.target].hint))

    if (button.fader.target === "obs_input") {
      var inputField = el("div", "field")
      var inputLabel = el("label", null, "Input name")
      var input = document.createElement("input")
      input.type = "text"
      input.spellcheck = false
      inputLabel.htmlFor = input.id = "fader-input"
      input.value = button.fader.inputName
      input.placeholder = "Exact OBS input name, e.g. Mic/Aux"
      input.addEventListener("input", function () {
        button.fader.inputName = input.value
        touch()
        refreshTile(button)
      })
      inputField.appendChild(inputLabel)
      inputField.appendChild(input)
      field.appendChild(inputField)
    }
    field.appendChild(el("p", "inline-note", "On the deck, drag up or down anywhere on the tile to change the level."))
    return field
  }

  /* Steps re-render on their own, so editing a macro never disturbs the
     label field or the colour row above it. */
  function renderSteps(button) {
    var host = $("steps-host")
    if (!host) return
    host.innerHTML = ""

    button.steps.forEach(function (step, index) {
      var card = el("div", "step" + (step.open ? " is-open" : ""))

      var head = el("button", "step-head")
      head.type = "button"
      head.setAttribute("aria-expanded", String(Boolean(step.open)))
      head.appendChild(el("span", "step-index", String(index + 1)))
      var title = el("span", "step-title" + (step.type === "none" ? " none" : ""), stepSummary(step))
      head.appendChild(title)
      if (step.delayMs) head.appendChild(el("span", "step-delay-tag", "+" + step.delayMs + "ms"))
      head.onclick = function () {
        step.open = !step.open
        renderSteps(button)
      }
      card.appendChild(head)

      var body = el("div", "step-body")
      body.hidden = !step.open

      /* action picker, grouped, with a plain-language hint */
      var typeField = el("div", "field")
      var typeLabel = el("label", null, "Action")
      var select = document.createElement("select")
      typeLabel.htmlFor = select.id = "step-type-" + step.id
      ACTION_GROUPS.forEach(function (groupName) {
        var group = document.createElement("optgroup")
        group.label = groupName
        Object.keys(ACTION_META).forEach(function (id) {
          if (ACTION_META[id].group !== groupName) return
          var option = new Option(ACTION_META[id].label, id, false, id === step.type)
          group.appendChild(option)
        })
        if (group.children.length) select.appendChild(group)
      })
      select.addEventListener("change", function () {
        /* Keep the delay, drop the fields that no longer apply. */
        var delay = step.delayMs
        var open = step.open
        Object.keys(step).forEach(function (key) {
          if (["id", "type", "delayMs", "open"].indexOf(key) === -1) delete step[key]
        })
        step.type = select.value
        step.delayMs = delay
        step.open = open
        touch()
        refreshTile(button)
        renderSteps(button)
      })
      typeField.appendChild(typeLabel)
      typeField.appendChild(select)
      typeField.appendChild(el("p", "field-help", (ACTION_META[step.type] || ACTION_META.none).hint))
      body.appendChild(typeField)

      if (step.type === "hotkey") {
        body.appendChild(el("p", "inline-note warn", "This companion cannot send keyboard shortcuts yet, so the deck will report an error if you press it."))
      }

      /* the fields this action needs, from one table */
      ;(ACTION_FIELDS[step.type] || []).forEach(function (spec) {
        var field = el("div", "field")
        var label = el("label", null, spec.label)
        var input = document.createElement("input")
        input.type = "text"
        input.spellcheck = false
        label.htmlFor = input.id = "step-" + spec.key + "-" + step.id
        input.value = step[spec.key] || ""
        input.placeholder = spec.placeholder
        input.addEventListener("input", function () {
          step[spec.key] = input.value
          title.textContent = stepSummary(step)
          touch()
        })
        field.appendChild(label)
        field.appendChild(input)
        body.appendChild(field)
      })

      if (step.type === "play_sound") body.appendChild(soundField(step, title))

      /* per-step delay: this is what makes it a macro */
      var delayField = el("div", "field")
      var delayLabel = el("label", null, index === 0 ? "Wait before this step" : "Wait after the previous step")
      var delayInput = document.createElement("input")
      delayInput.type = "number"
      delayInput.min = "0"
      delayInput.max = "60000"
      delayInput.step = "50"
      delayLabel.htmlFor = delayInput.id = "step-delay-" + step.id
      delayInput.value = String(step.delayMs || 0)
      delayInput.addEventListener("input", function () {
        step.delayMs = Math.max(0, Math.min(60000, Number(delayInput.value) || 0))
        touch()
      })
      delayField.appendChild(delayLabel)
      delayField.appendChild(delayInput)
      delayField.appendChild(el("p", "field-help", "Milliseconds. 0 fires immediately."))
      body.appendChild(delayField)

      /* reorder and remove */
      if (button.steps.length > 1) {
        var row = el("div")
        row.style.cssText = "display:flex;gap:8px;align-items:center"
        var up = el("button", "icon-btn")
        up.type = "button"
        up.innerHTML = svg(ICON_UP)
        up.setAttribute("aria-label", "Move this step earlier")
        up.disabled = index === 0
        up.onclick = function () { swapSteps(button, index, index - 1) }
        var down = el("button", "icon-btn")
        down.type = "button"
        down.innerHTML = svg(ICON_DOWN)
        down.setAttribute("aria-label", "Move this step later")
        down.disabled = index === button.steps.length - 1
        down.onclick = function () { swapSteps(button, index, index + 1) }
        var grow = el("span")
        grow.style.flex = "1 1 auto"
        var drop = el("button", "btn danger", "Remove step")
        drop.type = "button"
        drop.onclick = function () {
          button.steps.splice(index, 1)
          touch()
          refreshTile(button)
          renderInspector()
        }
        row.appendChild(up)
        row.appendChild(down)
        row.appendChild(grow)
        row.appendChild(drop)
        body.appendChild(row)
      }

      card.appendChild(body)
      host.appendChild(card)
    })
  }

  function swapSteps(button, a, b) {
    var steps = button.steps
    var held = steps[a]
    steps[a] = steps[b]
    steps[b] = held
    touch()
    renderSteps(button)
  }

  function soundField(step, title) {
    var field = el("div", "field")
    var label = el("label", null, "Sound slot")
    var row = el("div")
    row.style.cssText = "display:flex;gap:8px;align-items:center"

    var select = document.createElement("select")
    label.htmlFor = select.id = "step-sound-" + step.id
    /* Labels say whether a slot holds your file or the shipped tone, so you
       are not picking blind between eight identical entries. */
    for (var slot = 1; slot <= 8; slot += 1) select.add(new Option(soundSlotLabel(slot), String(slot)))
    select.value = String(step.soundId || 1)
    select.addEventListener("change", function () {
      step.soundId = Number(select.value)
      title.textContent = stepSummary(step)
      touch()
    })
    row.appendChild(select)

    var preview = el("button", "icon-btn")
    preview.type = "button"
    preview.innerHTML = svg(ICON_PLAY)
    preview.title = "Preview on this computer"
    preview.setAttribute("aria-label", "Preview this sound")
    preview.onclick = function () { playSlot(Number(select.value), preview) }
    row.appendChild(preview)

    /* Upload straight into the slot this step uses. */
    var picker = document.createElement("input")
    picker.type = "file"
    picker.accept = "audio/wav,audio/mpeg,.wav,.mp3"
    picker.className = "visually-hidden"
    picker.id = "step-sound-file-" + step.id
    picker.addEventListener("change", function () {
      var file = picker.files && picker.files[0]
      if (file) uploadSound(Number(select.value), file, null)
      picker.value = ""
    })
    var pick = el("label", "icon-btn")
    pick.htmlFor = picker.id
    pick.innerHTML = svg(ICON_UPLOAD)
    pick.title = "Replace this slot with a WAV or MP3"
    row.appendChild(picker)
    row.appendChild(pick)

    field.appendChild(label)
    field.appendChild(row)
    field.appendChild(el("p", "field-help", "WAV or MP3, up to 8 MB. Plays through this computer's speakers — the tablet never downloads the file."))
    return field
  }

  /* ------------------------------------------------------------- sounds */

  /* The server has always exposed PUT /api/sounds/<slot> for WAV and MP3
     uploads, but nothing in the interface ever called it, so the feature was
     unreachable. This is that missing surface. */

  var soundSlots = []
  var ICON_PLAY = '<polygon points="7 4 19 12 7 20 7 4"/>'
  var ICON_STOP = '<rect x="6" y="6" width="12" height="12" rx="2"/>'
  var ICON_UPLOAD = '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>'
  var ICON_REVERT = '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'

  /* Stable per-slot cache key, so previewing twice reuses the download and a
     fresh upload still busts it. */
  function soundVersion(slot) {
    for (var i = 0; i < soundSlots.length; i += 1) {
      if (soundSlots[i].slot === slot) return encodeURIComponent(soundSlots[i].updatedAt || "0")
    }
    return "0"
  }

  function prettyBytes(bytes) {
    if (!bytes) return "—"
    if (bytes < 1024) return bytes + " B"
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB"
    return (bytes / (1024 * 1024)).toFixed(1) + " MB"
  }

  function loadSounds() {
    return api("/api/sounds").then(function (data) {
      soundSlots = data.slots
      renderSoundList()
      var custom = soundSlots.filter(function (slot) { return slot.custom }).length
      var chip = $("sounds-state")
      chip.textContent = custom ? custom + " of 8 replaced" : "8 built-in tones"
      chip.className = "state-chip " + (custom ? "ready" : "warning")
      return soundSlots
    }).catch(function () { /* the panel simply stays empty */ })
  }

  /* One preview at a time. Every click used to create a fresh Audio element
     and leave it running, so repeated clicks stacked overlapping copies with
     no way to stop any of them. */
  var currentAudio = null
  var currentBtn = null

  function stopPreview() {
    if (currentAudio) {
      currentAudio.pause()
      currentAudio.currentTime = 0
    }
    if (currentBtn) {
      currentBtn.innerHTML = svg(ICON_PLAY)
      currentBtn.title = "Preview on this computer"
    }
    currentAudio = null
    currentBtn = null
  }

  function playSlot(slot, btn) {
    var sameButton = btn && currentBtn === btn
    stopPreview()
    /* A second click on the button that is playing stops it. */
    if (sameButton) return

    var audio = new Audio("/api/sounds/" + slot + "/file?v=" + soundVersion(slot))
    audio.volume = soundVolume
    currentAudio = audio
    currentBtn = btn || null
    if (btn) {
      btn.innerHTML = svg(ICON_STOP)
      btn.title = "Stop"
    }
    audio.addEventListener("ended", function () {
      if (currentAudio === audio) stopPreview()
    })
    audio.addEventListener("error", function () {
      if (currentAudio !== audio) return
      stopPreview()
      toast("Sound " + slot + " could not be played.", true)
    })
    audio.play().then(function () { audioUnlocked = true }).catch(function () {
      stopPreview()
      toast("Your browser blocked playback. Click Preview once more to allow it.", true)
    })
  }

  function uploadSound(slot, file, row) {
    if (file.size > 8 * 1024 * 1024) return toast("Keep sounds under 8 MB.", true)
    var type = file.type === "audio/mp3" ? "audio/mpeg" : file.type
    if (["audio/wav", "audio/x-wav", "audio/wave", "audio/mpeg"].indexOf(type) === -1) {
      return toast("Choose a WAV or MP3 file.", true)
    }
    if (type === "audio/x-wav" || type === "audio/wave") type = "audio/wav"

    if (row) row.classList.add("is-busy")
    api("/api/sounds/" + slot, {
      method: "PUT",
      headers: { "Content-Type": type, "X-Sound-Name": file.name.replace(/[^\w .()\[\]-]/g, "") },
      body: file
    }).then(function (result) {
      soundSlots = result.slots
      renderSoundList()
      loadSounds()
      /* Keep the step editor's dropdown labels in step with the new name. */
      var button = selectedButton()
      if (button) renderSteps(button)
      toast("Sound " + slot + " replaced.")
    }).catch(function (error) {
      if (row) row.classList.remove("is-busy")
      toast(error.message, true)
    })
  }

  function revertSound(slot) {
    confirmAction({
      title: "Restore the built-in tone?",
      text: "Your uploaded file for Sound " + slot + " will be deleted and the original tone put back.",
      confirm: "Restore tone"
    }).then(function (yes) {
      if (!yes) return
      api("/api/sounds/" + slot, { method: "DELETE" }).then(function (result) {
        soundSlots = result.slots
        renderSoundList()
        loadSounds()
        var button = selectedButton()
        if (button) renderSteps(button)
        toast("Sound " + slot + " is back to its built-in tone.")
      }).catch(function (error) { toast(error.message, true) })
    })
  }

  function renderSoundList() {
    var host = $("sound-list")
    if (!host) return
    host.innerHTML = ""

    soundSlots.forEach(function (info) {
      var row = el("div", "sound-slot" + (info.custom ? " is-custom" : ""))
      row.appendChild(el("span", "num", String(info.slot)))

      var meta = el("div", "meta")
      meta.appendChild(el("strong", null, info.custom ? (info.name || "Your file") : "Built-in tone " + info.slot))
      meta.appendChild(el("small", null, info.exists ? info.format + " · " + prettyBytes(info.bytes) : "Missing"))
      row.appendChild(meta)

      var tools = el("div", "tools")

      var play = el("button", "icon-btn")
      play.type = "button"
      play.innerHTML = svg(ICON_PLAY)
      play.title = "Preview on this computer"
      play.setAttribute("aria-label", "Preview sound " + info.slot)
      play.onclick = function () { playSlot(info.slot, play) }
      tools.appendChild(play)

      var picker = document.createElement("input")
      picker.type = "file"
      picker.accept = "audio/wav,audio/mpeg,.wav,.mp3"
      picker.className = "visually-hidden"
      picker.id = "sound-file-" + info.slot
      picker.addEventListener("change", function () {
        var file = picker.files && picker.files[0]
        if (file) uploadSound(info.slot, file, row)
        picker.value = ""
      })
      var pick = el("label", "icon-btn")
      pick.htmlFor = picker.id
      pick.innerHTML = svg(ICON_UPLOAD)
      pick.title = "Replace with a WAV or MP3"
      tools.appendChild(picker)
      tools.appendChild(pick)

      if (info.custom) {
        var revert = el("button", "icon-btn danger")
        revert.type = "button"
        revert.innerHTML = svg(ICON_REVERT)
        revert.title = "Restore the built-in tone"
        revert.setAttribute("aria-label", "Restore built-in tone for sound " + info.slot)
        revert.onclick = function () { revertSound(info.slot) }
        tools.appendChild(revert)
      }

      row.appendChild(tools)
      host.appendChild(row)
    })
  }

  function soundSlotLabel(slot) {
    for (var i = 0; i < soundSlots.length; i += 1) {
      if (soundSlots[i].slot !== slot) continue
      var info = soundSlots[i]
      return "Sound " + slot + (info.custom ? " · " + (info.name || "your file") : " · built-in tone")
    }
    return "Sound " + slot
  }

  $("sounds-toggle").addEventListener("click", function () {
    var open = this.getAttribute("aria-expanded") === "true"
    this.setAttribute("aria-expanded", String(!open))
    $("sounds-body").hidden = open
  })

  /* ------------------------------------------------------- icon picker */

  var pickerTab = "builtin"
  var googleStyle = "outlined"
  var googleCatalog = null
  var GOOGLE_PREVIEW = "https://fonts.gstatic.com/s/i/short-term/release/materialsymbols{style}/{name}/{variant}/24px.svg"
  var GOOGLE_LIMIT = 180

  function openIconPicker(button) {
    iconTargetId = button.id
    $("icon-search").value = ""
    drawIconGroups(button)
    $("dlg-icons").showModal()
    $("icon-search").focus()
  }

  function setPickerTab(tab) {
    pickerTab = tab
    $("tab-builtin").setAttribute("aria-pressed", String(tab === "builtin"))
    $("tab-google").setAttribute("aria-pressed", String(tab === "google"))
    $("google-options").hidden = tab !== "google"
    $("icon-search").placeholder = tab === "google" ? "Search 3,000+ Google icons" : "Search icons"
    var button = selectedButton()
    if (button) drawIconGroups(button)
  }

  function drawIconGroups(button) {
    if (pickerTab === "google") return drawGoogleIcons(button)
    var host = $("icon-groups")
    var query = $("icon-search").value.trim().toLowerCase()
    host.innerHTML = ""
    var found = 0

    ICON_GROUPS.forEach(function (group) {
      var matches = group.ids.filter(function (id) { return ICONS[id] && id.indexOf(query) !== -1 })
      if (!matches.length) return
      found += matches.length
      var section = el("div", "picker-group")
      section.appendChild(el("h3", null, group.name))
      var grid = el("div", "picker-grid")
      matches.forEach(function (id) {
        var choice = el("button", "icon-choice")
        choice.type = "button"
        choice.title = id
        choice.setAttribute("aria-label", id)
        choice.setAttribute("aria-pressed", String(id === button.icon && !button.iconData && !button.glyph))
        choice.innerHTML = iconSvg(id)
        choice.onclick = function () {
          button.icon = id
          button.iconData = null
          delete button.glyph
          touch()
          refreshTile(button)
          $("dlg-icons").close()
          renderInspector()
        }
        grid.appendChild(choice)
      })
      section.appendChild(grid)
      host.appendChild(section)
    })

    if (!found) {
      host.appendChild(el("p", "field-help", 'No icon matches “' + query + '”.'))
    }
  }

  function googlePreviewUrl(name) {
    return GOOGLE_PREVIEW.replace("{style}", googleStyle).replace("{name}", name)
      .replace("{variant}", $("google-fill").checked ? "fill1" : "default")
  }

  /* Previews come from Google while browsing. The picked icon is fetched
     through the companion and saved into the deck as a path, so tablets
     never need the internet. */
  function drawGoogleIcons(button) {
    var host = $("icon-groups")
    if (!googleCatalog) {
      host.innerHTML = ""
      host.appendChild(el("p", "field-help", "Loading Google icons…"))
      api("/api/icons/google").then(function (data) {
        googleCatalog = data.icons
        if (pickerTab === "google") drawGoogleIcons(button)
      }).catch(function (error) {
        host.innerHTML = ""
        host.appendChild(el("p", "field-help", error.message))
      })
      return
    }

    var query = $("icon-search").value.trim().toLowerCase().replace(/\s+/g, "_")
    var words = query.split("_").filter(Boolean)
    /* Whole-word prefixes only, so "mic" finds mic and microphone but not
       academic. An exact name wins, then name words, then tags; the catalog is
       already in popularity order, which breaks ties. */
    var ranked = []
    googleCatalog.forEach(function (icon, popularity) {
      var score = 0
      var matched = words.every(function (word) {
        if (("_" + icon.n).indexOf("_" + word) !== -1) return true
        if ((" " + icon.t).indexOf(" " + word) !== -1) { score += 1; return true }
        return false
      })
      if (!matched) return
      if (icon.n === query) score = -1
      ranked.push({ icon: icon, order: score * 100000 + popularity })
    })
    ranked.sort(function (a, b) { return a.order - b.order })
    var matches = ranked.map(function (entry) { return entry.icon })

    host.innerHTML = ""
    host.appendChild(el("p", "picker-note", matches.length > GOOGLE_LIMIT
      ? "Showing the " + GOOGLE_LIMIT + " most popular of " + matches.length + ". Search to narrow it down."
      : matches.length + (matches.length === 1 ? " icon" : " icons")))
    var grid = el("div", "picker-grid")
    matches.slice(0, GOOGLE_LIMIT).forEach(function (icon) {
      var choice = el("button", "icon-choice")
      choice.type = "button"
      choice.title = icon.n.replace(/_/g, " ")
      choice.setAttribute("aria-label", choice.title)
      choice.setAttribute("aria-pressed", String(Boolean(button.glyph && button.glyph.name === icon.n)))
      var preview = el("span", "g-preview")
      preview.style.setProperty("--glyph", 'url("' + googlePreviewUrl(icon.n) + '")')
      choice.appendChild(preview)
      choice.onclick = function () { pickGoogleIcon(button, icon.n, choice) }
      grid.appendChild(choice)
    })
    host.appendChild(grid)
    if (!matches.length) host.appendChild(el("p", "field-help", 'No Google icon matches “' + query.replace(/_/g, " ") + '”.'))
  }

  function pickGoogleIcon(button, name, choice) {
    choice.classList.add("is-loading")
    var params = "name=" + encodeURIComponent(name) + "&style=" + googleStyle + "&fill=" + ($("google-fill").checked ? "1" : "0")
    api("/api/icons/google/glyph?" + params).then(function (glyph) {
      button.glyph = glyph
      button.iconData = null
      touch()
      refreshTile(button)
      $("dlg-icons").close()
      renderInspector()
    }).catch(function (error) {
      choice.classList.remove("is-loading")
      toast(error.message, true)
    })
  }

  $("tab-builtin").addEventListener("click", function () { setPickerTab("builtin") })
  $("tab-google").addEventListener("click", function () { setPickerTab("google") })
  Array.prototype.forEach.call(document.querySelectorAll("#google-options [data-style]"), function (option) {
    option.addEventListener("click", function () {
      googleStyle = option.getAttribute("data-style")
      Array.prototype.forEach.call(document.querySelectorAll("#google-options [data-style]"), function (other) {
        other.setAttribute("aria-pressed", String(other === option))
      })
      var button = selectedButton()
      if (button) drawGoogleIcons(button)
    })
  })
  $("google-fill").addEventListener("change", function () {
    var button = selectedButton()
    if (button) drawGoogleIcons(button)
  })

  $("icon-search").addEventListener("input", function () {
    var button = selectedButton()
    if (button && button.id === iconTargetId) drawIconGroups(button)
  })
  $("icons-close").addEventListener("click", function () { $("dlg-icons").close() })

  /* ------------------------------------------------------ custom icons */

  function readIcon(file, done) {
    if (file.size > 750 * 1024) return toast("Keep custom icons under 750 KB.", true)
    if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) return toast("Choose a PNG, JPG, WebP or SVG file.", true)

    var reader = new FileReader()
    reader.onload = function () {
      var data = String(reader.result)
      if (file.type === "image/svg+xml") {
        var unsafe = /<script|<foreignObject|\son\w+\s*=|(?:href|src)\s*=\s*["']\s*(?:https?:|data:|javascript:)/i
        if (unsafe.test(data)) return toast("That SVG contains embedded content this deck will not load.", true)
        return done("data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(data))))
      }
      done(data)
    }
    if (file.type === "image/svg+xml") reader.readAsText(file)
    else reader.readAsDataURL(file)
  }

  /* ------------------------------------------------------------- render */

  function renderAll() {
    renderProfiles()
    renderGrid()
    renderInspector()
    var profile = activeProfile()
    $("profile-title").textContent = profile.name
    $("cols").value = profile.columns
    $("rows").value = profile.rows
  }

  /* --------------------------------------------------------- bindings */

  function setGridSize(key, raw) {
    var profile = activeProfile()
    var min = key === "columns" ? 2 : 1
    var max = key === "columns" ? 8 : 6
    var value = Math.max(min, Math.min(max, Number(raw) || min))
    profile[key] = value
    $(key === "columns" ? "cols" : "rows").value = value
    touch()
    renderGrid()
    renderProfiles()
  }

  $("cols").addEventListener("change", function () { setGridSize("columns", this.value) })
  $("rows").addEventListener("change", function () { setGridSize("rows", this.value) })

  $("new-profile").addEventListener("click", function () {
    ask({ title: "New profile", label: "Profile name", value: "", confirm: "Create" }).then(function (name) {
      if (!name) return
      var profile = createEmptyProfile(name)
      library.profiles.push(profile)
      activeId = profile.id
      selectedSlot = null
      touch()
      renderAll()
    })
  })

  $("rename-profile").addEventListener("click", function () {
    var profile = activeProfile()
    ask({ title: "Rename profile", label: "Profile name", value: profile.name }).then(function (name) {
      if (!name) return
      profile.name = name
      touch()
      renderAll()
    })
  })

  $("delete-profile").addEventListener("click", function () {
    if (library.profiles.length < 2) return
    var profile = activeProfile()
    confirmAction({
      title: "Delete “" + profile.name + "”?",
      text: "Its " + profile.buttons.length + " button(s) will be removed. This cannot be undone.",
      confirm: "Delete profile"
    }).then(function (yes) {
      if (!yes) return
      library.profiles = library.profiles.filter(function (item) { return item.id !== profile.id })
      activeId = library.profiles[0].id
      selectedSlot = null
      touch()
      renderAll()
    })
  })

  /* ---------------------------------------------------------- themes */

  var currentTheme = DEFAULT_THEME

  function renderThemes() {
    var host = $("theme-list")
    host.innerHTML = ""
    THEMES.forEach(function (theme) {
      var option = el("button", "theme-option")
      option.type = "button"
      option.setAttribute("role", "radio")
      option.setAttribute("aria-checked", String(theme.id === currentTheme))
      option.appendChild(el("span", "theme-swatch " + theme.id))
      var text = el("span")
      text.appendChild(el("strong", null, theme.label))
      text.appendChild(el("small", null, theme.hint))
      option.appendChild(text)
      option.onclick = function () { chooseTheme(theme.id) }
      host.appendChild(option)
    })
  }

  function setTheme(id) {
    currentTheme = applyTheme(id)
    renderThemes()
  }

  function chooseTheme(id) {
    if (id === currentTheme) return
    var previous = currentTheme
    /* Applied at once so the choice feels instant; rolled back if the save fails. */
    setTheme(id)
    api("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: id })
    }).then(function () {
      toast(themeById(id).label + " theme applied to every deck.")
    }).catch(function (error) {
      setTheme(previous)
      toast(error.message, true)
    })
  }

  $("accent-picker").addEventListener("input", function () {
    $("accent-hex").textContent = this.value
    applyAccent(this.value)
  })

  $("accent-picker").addEventListener("change", function () {
    var value = this.value
    api("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accent: value })
    }).then(function (saved) {
      applyAccent(saved.accent)
      toast("Interface colour saved for every deck.")
    }).catch(function (error) { toast(error.message, true) })
  })

  /* OBS panel */
  $("obs-toggle").addEventListener("click", function () {
    var open = this.getAttribute("aria-expanded") === "true"
    this.setAttribute("aria-expanded", String(!open))
    $("obs-body").hidden = open
  })

  function setObsState(configured, message, mode) {
    var chip = $("obs-state")
    chip.textContent = mode === "error" ? "Problem" : configured ? "Connected" : "Not set up"
    chip.className = "state-chip " + (mode === "error" ? "error" : configured ? "ready" : "warning")
    if (message) $("obs-help").textContent = message
  }

  $("obs-save").addEventListener("click", function () {
    var address = $("obs-address").value.trim()
    var password = $("obs-password").value
    api("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ obsAddress: address, obsPassword: password })
    }).then(function () {
      var configured = Boolean(address && password)
      setObsState(configured, configured
        ? "Saved. Start OBS before pressing an OBS button."
        : "Add both the address and the password, then save again.")
      toast("OBS connection saved.")
    }).catch(function (error) {
      setObsState(false, "Could not save. Check the address, then try again.", "error")
      toast(error.message, true)
    })
  })

  /* backup / restore */
  $("export-btn").addEventListener("click", function () {
    var url = URL.createObjectURL(new Blob([JSON.stringify(library, null, 2)], { type: "application/json" }))
    var link = document.createElement("a")
    link.href = url
    link.download = "punchboard-backup.json"
    link.click()
    URL.revokeObjectURL(url)
    toast("Backup downloaded.")
  })

  $("import-btn").addEventListener("click", function () { $("import-input").click() })

  $("import-input").addEventListener("change", function (event) {
    var file = event.target.files && event.target.files[0]
    if (!file) return
    file.text().then(function (raw) {
      var next = JSON.parse(raw)
      if (!next || next.version !== 1 || !Array.isArray(next.profiles)) throw new Error("bad")
      /* Restore replaces everything, so it now asks first. The old build
         swapped the whole library out silently with no undo. */
      return confirmAction({
        title: "Replace this deck?",
        text: "Restoring will replace all " + library.profiles.length + " profile(s) on this computer with the " + next.profiles.length + " in the file. This cannot be undone.",
        confirm: "Replace everything"
      }).then(function (yes) {
        if (!yes) return
        library = normalizeLibrary(next)
        activeId = library.activeProfileId
        selectedSlot = null
        touch()
        renderAll()
        toast("Deck restored from file.")
      })
    }).catch(function () {
      toast("That file is not an Punchboard backup.", true)
    })
    event.target.value = ""
  })

  $("shutdown-btn").addEventListener("click", function () {
    confirmAction({
      title: "Stop the companion?",
      text: "Every paired tablet will show as offline until you start it again from your computer.",
      confirm: "Stop companion"
    }).then(function (yes) {
      if (!yes) return
      api("/api/shutdown", { method: "POST" }).then(function () {
        document.body.innerHTML = '<div class="empty-inspector" style="padding:80px 20px"><strong>The companion has stopped.</strong><div class="subtle">Start it again on your computer when you are ready.</div></div>'
      }).catch(function (error) { toast(error.message, true) })
    })
  })

  /* Keyboard move, because drag and drop is mouse-only. */
  document.addEventListener("keydown", function (event) {
    if (!event.altKey || selectedSlot === null) return
    var deltas = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: null, ArrowDown: null }
    if (!(event.key in deltas)) return
    var profile = activeProfile()
    var delta = event.key === "ArrowUp" ? -profile.columns : event.key === "ArrowDown" ? profile.columns : deltas[event.key]
    var target = selectedSlot + delta
    if (target < 0 || target >= profile.rows * profile.columns) return
    event.preventDefault()
    moveButton(selectedSlot, target)
  })

  $("intro-dismiss").addEventListener("click", function () {
    $("intro-card").hidden = true
    try { localStorage.setItem("punchboard-intro-seen", "1") } catch (e) {}
  })

  /* -------------------------------------------------------- sound output */

  /* Decks cannot play audio, so this tab does, through this computer's
     speakers. The server owns the state: it decides play or stop, and knows
     what is playing. This tab obeys and reports when a sound ends on its own.
     With several Control Center tabs open only the newest plays, so a press
     never comes out twice. */
  var AUDIO_ID = "cc_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  var deckAudio = {}   /* slot -> Audio for sounds a deck started */

  function reportEnded(slot) {
    api("/api/sounds/ended", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot: slot })
    }).catch(function () {})
  }

  function stopDeckSound(slot) {
    var audio = deckAudio[slot]
    if (!audio) return
    delete deckAudio[slot]
    audio.pause()
  }

  function playDeckSound(slot) {
    stopDeckSound(slot)
    if (!audioUnlocked) {
      toast("A deck asked for Sound " + slot + ". Click anywhere on this page once to allow playback.", true)
      reportEnded(slot)
      return
    }
    var audio = new Audio("/api/sounds/" + slot + "/file?v=" + soundVersion(slot))
    audio.volume = soundVolume
    deckAudio[slot] = audio
    var finish = function () {
      if (deckAudio[slot] !== audio) return
      delete deckAudio[slot]
      reportEnded(slot)
    }
    audio.addEventListener("ended", finish)
    audio.addEventListener("error", function () {
      if (deckAudio[slot] === audio) toast("Sound " + slot + " could not be played.", true)
      finish()
    })
    audio.play().catch(function () {
      toast("Your browser blocked playback. Click anywhere on this page once to allow it.", true)
      finish()
    })
  }

  function setSoundVolume(level) {
    soundVolume = Math.max(0, Math.min(1, level))
    Object.keys(deckAudio).forEach(function (slot) { deckAudio[slot].volume = soundVolume })
    if (currentAudio) currentAudio.volume = soundVolume
  }

  function renderNowPlaying(playing) {
    $("now-playing").hidden = !playing.length
    $("now-playing-text").textContent = playing.length === 1 ? "Stop sound " + playing[0] : "Stop " + playing.length + " sounds"
  }

  $("now-playing").addEventListener("click", function () {
    api("/api/sounds/stop", { method: "POST" }).catch(function (error) { toast(error.message, true) })
  })

  function watchEvents() {
    var knownSoundsRev = null
    var lastCommandId = null
    var handle = function (state) {
      if (state.accent) applyAccent(state.accent)
      if (state.theme && state.theme !== currentTheme) setTheme(state.theme)
      if (typeof state.soundsRev === "number") {
        if (knownSoundsRev !== null && state.soundsRev !== knownSoundsRev) loadSounds()
        knownSoundsRev = state.soundsRev
      }
      /* Another window saved: follow it, unless an edit here is on its way
         (that save will get the conflict and reload instead). */
      if (typeof state.libraryRev === "number" && libraryRev !== null && state.libraryRev > libraryRev && !saving && !saveTimerPending()) {
        reloadLibrary("Updated with changes from another window.")
      }
      if (state.levels && typeof state.levels.sounds === "number") setSoundVolume(state.levels.sounds)
      if (state.playing) renderNowPlaying(state.playing)

      var isOutput = state.audioOutput === AUDIO_ID
      /* Another tab took over: hand its sounds back rather than leave them
         playing where no stop can reach them. */
      if (!isOutput) Object.keys(deckAudio).forEach(function (slot) { stopDeckSound(Number(slot)); reportEnded(Number(slot)) })

      var commands = state.soundCommands || []
      if (lastCommandId === null) {
        /* The first snapshot only says where the queue already is. */
        lastCommandId = commands.length ? commands[commands.length - 1].id : 0
        return
      }
      commands.forEach(function (command) {
        if (command.id <= lastCommandId) return
        lastCommandId = command.id
        if (!isOutput) return
        if (command.action === "stop") stopDeckSound(command.slot)
        else playDeckSound(command.slot)
      })
    }

    if (window.EventSource) {
      var source = new EventSource("/api/events?audio=" + AUDIO_ID)
      source.onmessage = function (event) {
        try { handle(JSON.parse(event.data)) } catch (e) {}
      }
      /* See deck.js: a stream left open on unload is logged as an error. */
      window.addEventListener("pagehide", function () { source.close() })
      return
    }
    setInterval(function () { api("/api/status").then(handle).catch(function () {}) }, 1500)
  }

  document.addEventListener("pointerdown", function () { audioUnlocked = true }, { once: true })

  /* -------------------------------------------------------------- start */

  Promise.all([fetchLibrary(), api("/api/settings")]).then(function (results) {
    library = results[0]
    var settings = results[1]
    activeId = library.activeProfileId

    $("obs-address").value = settings.obsAddress || ""
    $("accent-picker").value = settings.accent
    $("accent-hex").textContent = settings.accent
    applyAccent(settings.accent)
    setTheme(settings.theme)
    setObsState(Boolean(settings.obsConfigured), settings.obsConfigured
      ? "Saved. Start OBS before pressing an OBS button."
      : "Only needed for OBS buttons. In OBS open Tools › WebSocket Server Settings, enable the server, then copy its address and password here.")

    var seen = false
    try { seen = localStorage.getItem("punchboard-intro-seen") === "1" } catch (e) {}
    /* Show the guidance to anyone who has not built anything yet. */
    var hasButtons = library.profiles.some(function (p) { return p.buttons.length })
    $("intro-card").hidden = seen || hasButtons

    setSaveState("", "Saved · decks in sync")
    renderAll()
    loadSounds()
    watchEvents()
  }).catch(function (error) {
    setSaveState("error", "Could not load")
    toast(error.message, true)
  })
})()
