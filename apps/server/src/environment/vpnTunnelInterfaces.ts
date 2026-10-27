/**
 * Fork add-on: VPN tunnels never advertised as LAN.
 * A full-tunnel VPN (Proton, WireGuard, OpenVPN) gives this machine a /32 private address that no
 * client can reach. Tailscale's /32 sits in the shared address space and stays.
 */
import { isSharedAddressSpaceHost } from "@t3tools/shared/hostClassification";
import type * as NodeOS from "node:os";

export const isVpnTunnelEntry = (entry: NodeOS.NetworkInterfaceInfo): boolean =>
  entry.netmask === "255.255.255.255" && !isSharedAddressSpaceHost(entry.address);
