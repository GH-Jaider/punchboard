// The pairing screen. Until this deck has its secret, it is all the deck shows.
import type { ClaimRequest, ClaimResponse } from "../../shared/api.ts"
import { byId } from "../common/dom.ts"
import { errorMessage, request } from "../common/http.ts"
import { saveDevice, setServerTime } from "./api.ts"
import { toast } from "./ui.ts"

const errorEl = byId("pair-error")
const codeInput = byId<HTMLInputElement>("pair-code")
const submit = byId<HTMLButtonElement>("pair-submit")

let onPaired: () => void = () => {}

export function showPairing(message = ""): void {
  document.body.classList.add("needs-pairing")
  errorEl.textContent = message
  setTimeout(() => codeInput.focus(), 50)
}

export async function claim(code: string): Promise<void> {
  errorEl.textContent = ""
  submit.disabled = true
  try {
    const body: ClaimRequest = { code }
    const result = await request<ClaimResponse>("/api/pair/claim", { method: "POST", json: body })
    setServerTime(result.serverTime)
    saveDevice(result.device)
    document.body.classList.remove("needs-pairing")
    toast("Paired. This deck is ready.")
    onPaired()
  } catch (error) {
    showPairing(errorMessage(error))
  } finally {
    submit.disabled = false
  }
}

/** A QR from the pairing page carries its code in the address hash, which is
    never sent to the server. Take it, then wipe it from the address bar. */
export function takeHashCode(): string | undefined {
  const code = (location.hash.match(/pair=(\d{6})/) ?? [])[1]
  if (code && window.history && typeof history.replaceState === "function") history.replaceState(null, "", location.pathname)
  return code
}

export function initPairing(paired: () => void): void {
  onPaired = paired

  byId("pair-form").addEventListener("submit", (event) => {
    event.preventDefault()
    const code = codeInput.value.replace(/\D/g, "")
    if (code.length !== 6) {
      showPairing("Enter the 6-digit code shown on the computer.")
      return
    }
    void claim(code)
  })

  // Scanning a new code while the pairing screen is open only changes the hash.
  window.addEventListener("hashchange", () => {
    const code = takeHashCode()
    if (code && document.body.classList.contains("needs-pairing")) void claim(code)
  })
}
