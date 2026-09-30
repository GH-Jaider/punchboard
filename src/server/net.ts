// This machine's network addresses: the one printed for tablets, and the
// names a browser may use to reach this server.
import os from "node:os"

function interfaceAddresses(): os.NetworkInterfaceInfo[] {
  return Object.values(os.networkInterfaces()).flatMap((list) => list ?? [])
}

export function getLocalIPv4(): string {
  const lan = interfaceAddresses().find((iface) => iface.family === "IPv4" && !iface.internal)
  return lan ? lan.address : "127.0.0.1"
}

/** Host names a browser may legitimately use to reach this server. Anything
    else in the Host header is a DNS-rebinding attempt: a web page whose domain
    has been pointed at this machine. */
export function ownHostnames(): Set<string> {
  const names = new Set(["localhost", "127.0.0.1", "[::1]"])
  for (const iface of interfaceAddresses()) names.add(iface.family === "IPv6" ? `[${iface.address}]` : iface.address)
  const host = os.hostname().toLowerCase()
  names.add(host)
  names.add(host.endsWith(".local") ? host : `${host}.local`)
  return names
}
