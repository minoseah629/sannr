// A self-signed loopback certificate created in memory with a fresh test-only key.
// Minimal DER avoids an openssl executable or another installed test dependency.
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
const der = (tag, ...parts) => {
  const body = Buffer.concat(parts.map(part => Buffer.from(part)));
  const octets = [];
  for (let n = body.length; n > 0; n >>>= 8) octets.unshift(n & 255);
  const length = body.length < 128 ? [body.length] : [0x80 | octets.length, ...octets];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
};
const sequence = (...parts) => der(0x30, ...parts);
const algorithm = sequence(der(0x06, Buffer.from("2a864886f70d01010b", "hex")), der(0x05));
const name = sequence(der(0x31, sequence(der(0x06, Buffer.from("550403", "hex")), der(0x0c, Buffer.from("localhost")))));
const utc = date => der(0x17, Buffer.from(date.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));
export function ephemeralTlsPair() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = Date.now(), serial = randomBytes(16);
  serial[0] |= 0x80; // The explicit positive sign octet must be necessary DER padding.
  const tbs = sequence(
    der(0xa0, der(0x02, [2])), der(0x02, Buffer.concat([Buffer.from([0]), serial])),
    algorithm, name, sequence(utc(new Date(now - 60_000)), utc(new Date(now + 86_400_000))),
    name, publicKey.export({ type: "spki", format: "der" }),
  );
  const certificate = sequence(tbs, algorithm, der(0x03, [0], sign("sha256", tbs, privateKey)));
  const base64 = certificate.toString("base64").match(/.{1,64}/g).join("\n");
  return {
    private_key: Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })),
    cert_chain: Buffer.from(`-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`),
  };
}
