//! This machine's network addresses: the one printed for tablets, and the
//! names a browser may use to reach this server.

use std::collections::HashSet;
use std::net::IpAddr;

/// The addresses of the network interfaces that are up, in the system's
/// order, as Node's `os.networkInterfaces()` listed them.
fn interface_addresses() -> Vec<IpAddr> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(if_addrs::Interface::is_oper_up)
        .map(|interface| interface.ip())
        .collect()
}

fn hostname() -> String {
    gethostname::gethostname().to_string_lossy().into_owned()
}

fn local_ipv4_among(addresses: &[IpAddr]) -> String {
    addresses
        .iter()
        .find(|address| address.is_ipv4() && !address.is_loopback())
        .map_or_else(|| "127.0.0.1".to_string(), IpAddr::to_string)
}

pub fn get_local_ipv4() -> String {
    local_ipv4_among(&interface_addresses())
}

fn own_hostnames_among(addresses: &[IpAddr], hostname: &str) -> HashSet<String> {
    let mut names: HashSet<String> = ["localhost", "127.0.0.1", "[::1]"]
        .into_iter()
        .map(str::to_string)
        .collect();
    for address in addresses {
        names.insert(match address {
            IpAddr::V6(address) => format!("[{address}]"),
            IpAddr::V4(address) => address.to_string(),
        });
    }
    let host = hostname.to_lowercase();
    names.insert(if host.ends_with(".local") {
        host.clone()
    } else {
        format!("{host}.local")
    });
    names.insert(host);
    names
}

/// Host names a browser may legitimately use to reach this server. Anything
/// else in the Host header is a DNS-rebinding attempt: a web page whose domain
/// has been pointed at this machine.
pub fn own_hostnames() -> HashSet<String> {
    own_hostnames_among(&interface_addresses(), &hostname())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addresses(list: &[&str]) -> Vec<IpAddr> {
        list.iter()
            .map(|address| address.parse().unwrap())
            .collect()
    }

    fn set(list: &[&str]) -> HashSet<String> {
        list.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn the_first_address_on_the_network_is_the_one_printed() {
        assert_eq!(
            local_ipv4_among(&addresses(&[
                "127.0.0.1",
                "::1",
                "fe80::1",
                "192.168.1.20",
                "10.0.0.5"
            ])),
            "192.168.1.20"
        );
        assert_eq!(
            local_ipv4_among(&addresses(&["127.0.0.1", "::1", "fd00::2"])),
            "127.0.0.1"
        );
        assert_eq!(local_ipv4_among(&[]), "127.0.0.1");
    }

    #[test]
    fn the_names_a_browser_may_use() {
        let names = own_hostnames_among(
            &addresses(&[
                "127.0.0.1",
                "::1",
                "fe80::1c2d:3e4f:5a6b:7c8d",
                "192.168.1.20",
            ]),
            "Estudio",
        );
        assert_eq!(
            names,
            set(&[
                "localhost",
                "127.0.0.1",
                "[::1]",
                "[fe80::1c2d:3e4f:5a6b:7c8d]",
                "192.168.1.20",
                "estudio",
                "estudio.local"
            ])
        );
        // A name that already ends in .local is not given a second ending.
        let names = own_hostnames_among(&[], "Mac-de-Ana.local");
        assert_eq!(
            names,
            set(&["localhost", "127.0.0.1", "[::1]", "mac-de-ana.local"])
        );
    }

    #[test]
    fn this_machine_has_its_loopback_names() {
        let names = own_hostnames();
        for name in ["localhost", "127.0.0.1", "[::1]"] {
            assert!(names.contains(name), "{name}");
        }
        assert!(names.contains(&hostname().to_lowercase()));
        let address: IpAddr = get_local_ipv4().parse().unwrap();
        assert!(address.is_ipv4());
        assert!(names.contains(&address.to_string()));
    }
}
