import { describe, expect, it } from "vitest";
import { isBlockedAddress, parseV6 } from "./ipClass";

describe("isBlockedAddress (SPEC §25.4)", () => {
  it.each([
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1",
    "100.127.255.254",
    "127.0.0.1",
    "127.1.2.3",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
  ])("blocks IPv4 %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["1.1.1.1", "8.8.8.8", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1"])(
    "allows public IPv4 %s",
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );

  it.each([
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
    "::127.0.0.1",
    "64:ff9b::10.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b:1::1",
    "100::1",
    "2001::1",
    "2001:db8::1",
    "2002:7f00:1::",
    "2002:c0a8:101::1",
    "3fff::1",
    "fc00::1",
    "fd12:3456:789a::1",
    "fe80::1",
    "fe80::1%eth0",
    "fec0::1",
    "ff02::1",
    "[::1]",
    "localhost",
    "",
    "1.2.3",
    "01.02.03.04",
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    "2606:4700:4700::1111",
    "2a00:1450:4001:80b::200e",
    "::ffff:8.8.8.8",
    "64:ff9b::8.8.8.8",
    "2002:0808:0808::1",
  ])("allows public IPv6 %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe("parseV6", () => {
  it("expands compressed forms and IPv4 tails", () => {
    expect(parseV6("::1")).toEqual([...Array<number>(15).fill(0), 1]);
    expect(parseV6("::ffff:1.2.3.4")?.slice(10)).toEqual([0xff, 0xff, 1, 2, 3, 4]);
    expect(parseV6("2001:db8::")?.slice(0, 4)).toEqual([0x20, 0x01, 0x0d, 0xb8]);
    expect(parseV6("1:2:3:4:5:6:7:8")?.[15]).toBe(8);
    expect(parseV6("not-an-ip")).toBeNull();
  });
});
