// A stand-in for OBS Studio's WebSocket server (protocol v5, in JSON or
// MessagePack like the real one), with a small scene collection, for testing
// without touching anyone's real OBS.
import { decode, encode } from "@msgpack/msgpack"
import { WebSocketServer } from "ws"

export function startFakeObs() {
  const obs = {
    currentScene: "Main",
    studioMode: false,
    outputs: { stream: false, record: false, virtualcam: false, replay: false },
    inputs: {
      Mic: { audio: true, muted: false, volumeMul: 1, filters: { "Voice Changer": false } },
      "Desktop Audio": { audio: true, muted: false, volumeMul: 0.5, filters: {} },
      Camera: { audio: false, filters: { Blur: false } }
    },
    // Scene names with their items; the list is in OBS's bottom-up order.
    scenes: { BRB: [], Main: [{ id: 1, source: "Camera", enabled: true }, { id: 2, source: "Mic", enabled: true }], Intro: [] },
    sceneOrder: ["BRB", "Main", "Intro"],
    calls: []
  }

  const server = new WebSocketServer({ port: 0, host: "0.0.0.0" })
  const clients = new Set()

  const packed = (socket) => socket.protocol === "obswebsocket.msgpack"
  const send = (socket, op, d) => socket.send(packed(socket) ? encode({ op, d }) : JSON.stringify({ op, d }))
  function emit(eventType, eventData) {
    for (const socket of clients) send(socket, 5, { eventType, eventIntent: 1, eventData })
  }
  const fail = (comment) => { throw Object.assign(new Error(comment), { code: 600 }) }
  const input = (name) => obs.inputs[name] ?? fail(`No source was found by the name of \`${name}\`.`)
  const audioInput = (name) => (input(name).audio ? input(name) : fail("The specified input does not support audio."))
  const filterOf = (source, filter) => {
    const filters = obs.inputs[source]?.filters ?? fail(`No source \`${source}\``)
    return filter in filters ? filters : fail(`No filter \`${filter}\``)
  }
  const item = (scene, id) => (obs.scenes[scene] ?? fail("No scene")).find((entry) => entry.id === id) ?? fail("No scene item")

  const handlers = {
    GetCurrentProgramScene: () => ({ currentProgramSceneName: obs.currentScene, sceneName: obs.currentScene }),
    SetCurrentProgramScene: ({ sceneName }) => {
      if (!obs.scenes[sceneName]) fail(`No source was found by the name of \`${sceneName}\`.`)
      obs.currentScene = sceneName
      emit("CurrentProgramSceneChanged", { sceneName })
    },
    GetSceneList: () => ({
      currentProgramSceneName: obs.currentScene,
      scenes: obs.sceneOrder.map((sceneName, sceneIndex) => ({ sceneName, sceneIndex }))
    }),
    GetInputList: () => ({ inputs: Object.keys(obs.inputs).map((inputName) => ({ inputName })) }),
    GetSceneItemList: ({ sceneName }) => ({
      // Bottom-up, index 0 first, like OBS.
      sceneItems: (obs.scenes[sceneName] ?? fail("No scene")).map((entry) => ({ sourceName: entry.source, sceneItemId: entry.id }))
    }),
    GetSourceFilterList: ({ sourceName }) => ({
      filters: Object.keys(obs.inputs[sourceName]?.filters ?? (obs.scenes[sourceName] ? {} : fail("No source"))).map((filterName) => ({ filterName }))
    }),
    GetInputMute: ({ inputName }) => ({ inputMuted: audioInput(inputName).muted }),
    ToggleInputMute: ({ inputName }) => {
      const entry = audioInput(inputName)
      entry.muted = !entry.muted
      emit("InputMuteStateChanged", { inputName, inputMuted: entry.muted })
      return { inputMuted: entry.muted }
    },
    GetInputVolume: ({ inputName }) => ({ inputVolumeMul: audioInput(inputName).volumeMul, inputVolumeDb: 0 }),
    SetInputVolume: ({ inputName, inputVolumeMul }) => {
      audioInput(inputName).volumeMul = inputVolumeMul
      emit("InputVolumeChanged", { inputName, inputVolumeMul, inputVolumeDb: 0 })
    },
    GetSceneItemId: ({ sceneName, sourceName }) => ({
      sceneItemId: ((obs.scenes[sceneName] ?? fail("No scene")).find((entry) => entry.source === sourceName) ?? fail("No item")).id
    }),
    GetSceneItemEnabled: ({ sceneName, sceneItemId }) => ({ sceneItemEnabled: item(sceneName, sceneItemId).enabled }),
    SetSceneItemEnabled: ({ sceneName, sceneItemId, sceneItemEnabled }) => {
      item(sceneName, sceneItemId).enabled = sceneItemEnabled
      emit("SceneItemEnableStateChanged", { sceneName, sceneItemId, sceneItemEnabled })
    },
    GetSourceFilter: ({ sourceName, filterName }) => ({ filterEnabled: filterOf(sourceName, filterName)[filterName] }),
    SetSourceFilterEnabled: ({ sourceName, filterName, filterEnabled }) => {
      filterOf(sourceName, filterName)[filterName] = filterEnabled
      emit("SourceFilterEnableStateChanged", { sourceName, filterName, filterEnabled })
    },
    GetStreamStatus: () => ({ outputActive: obs.outputs.stream }),
    StartStream: () => { obs.outputs.stream = true; emit("StreamStateChanged", { outputActive: true, outputState: "OBS_WEBSOCKET_OUTPUT_STARTED" }) },
    StopStream: () => { obs.outputs.stream = false; emit("StreamStateChanged", { outputActive: false, outputState: "OBS_WEBSOCKET_OUTPUT_STOPPED" }) },
    GetRecordStatus: () => ({ outputActive: obs.outputs.record }),
    GetVirtualCamStatus: () => ({ outputActive: obs.outputs.virtualcam }),
    ToggleVirtualCam: () => {
      obs.outputs.virtualcam = !obs.outputs.virtualcam
      emit("VirtualcamStateChanged", { outputActive: obs.outputs.virtualcam, outputState: "" })
      return { outputActive: obs.outputs.virtualcam }
    },
    GetReplayBufferStatus: () => ({ outputActive: obs.outputs.replay }),
    SaveReplayBuffer: () => (obs.outputs.replay ? undefined : fail("Replay buffer is not active.")),
    GetStudioModeEnabled: () => ({ studioModeEnabled: obs.studioMode }),
    TriggerStudioModeTransition: () => (obs.studioMode ? undefined : fail("Studio mode is not active."))
  }

  server.on("connection", (socket) => {
    clients.add(socket)
    socket.on("close", () => clients.delete(socket))
    send(socket, 0, { obsWebSocketVersion: "5.5.0", rpcVersion: 1 })
    socket.on("message", (raw) => {
      const { op, d } = packed(socket) ? decode(raw) : JSON.parse(String(raw))
      if (op === 1) return send(socket, 2, { negotiatedRpcVersion: 1 })
      if (op !== 6) return
      obs.calls.push(d.requestType)
      const handler = handlers[d.requestType]
      try {
        if (!handler) fail(`Fake OBS has no ${d.requestType}`)
        const responseData = handler(d.requestData ?? {})
        send(socket, 7, { requestType: d.requestType, requestId: d.requestId, requestStatus: { result: true, code: 100 }, responseData })
      } catch (error) {
        send(socket, 7, { requestType: d.requestType, requestId: d.requestId, requestStatus: { result: false, code: error.code ?? 600, comment: error.message } })
      }
    })
  })

  return new Promise((resolve) => {
    server.on("listening", () => resolve({
      obs,
      port: server.address().port,
      emit,
      /** Drops every connection, as OBS closing would. */
      disconnect: () => { for (const socket of clients) socket.terminate() },
      close: () => new Promise((done) => { for (const socket of clients) socket.terminate(); server.close(() => done()) })
    }))
  })
}
