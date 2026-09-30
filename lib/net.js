// This machine's network addresses: the one printed for tablets, and the
// names a browser may use to reach this server.
const os = require("os")

function interfaceAddresses() {
  const found = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) found.push(iface)
  }
  return found
}

function getLocalIPv4() {
  const lan = interfaceAddresses().find((iface) => iface.family === "IPv4" && !iface.internal)
  return lan ? lan.address : "127.0.0.1"
}

// Host names a browser may legitimately use to reach this server. Anything
// else in the Host header is a DNS-rebinding attempt: a web page whose domain
// has been pointed at this machine.
function ownHostnames() {
  const names = new Set(["localhost", "127.0.0.1", "[::1]"])
  for (const iface of interfaceAddresses()) names.add(iface.family === "IPv6" ? `[${iface.address}]` : iface.address)
  const host = os.hostname().toLowerCase()
  names.add(host)
  names.add(host.endsWith(".local") ? host : `${host}.local`)
  return names
}

module.exports = { getLocalIPv4, ownHostnames }
