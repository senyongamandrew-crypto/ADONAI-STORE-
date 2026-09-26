/**
 * A software authenticator, for tests only.
 *
 * WebAuthn ceremonies normally need a browser and a real platform authenticator,
 * neither of which exists in CI. Rather than leave the passkey path unverified,
 * this builds genuine ES256 credentials with WebCrypto and produces
 * spec-shaped attestation/assertion responses — the same bytes a Touch ID or
 * Windows Hello prompt would return — so `verifyRegistrationResponse` and
 * `verifyAuthenticationResponse` do real cryptographic work.
 *
 * Not a security boundary and never shipped to the client bundle: it holds
 * private keys in memory for the lifetime of the process.
 */
import { webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sha256 = async (buf) => new Uint8Array(await subtle.digest("SHA-256", buf));

// ------------------------------------------------------------- minimal CBOR --
const head = (major, n) => {
  const mt = major << 5;
  if (n < 24) return Buffer.from([mt | n]);
  if (n < 0x100) return Buffer.from([mt | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = mt | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = mt | 26;
  b.writeUInt32BE(n, 1);
  return b;
};

export function cbor(value) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === "string") {
    const b = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, b.length), b]);
  }
  if (value instanceof Uint8Array) {
    const b = Buffer.from(value);
    return Buffer.concat([head(2, b.length), b]);
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    const parts = [head(5, keys.length)];
    for (const k of keys) {
      parts.push(cbor(Number.isNaN(Number(k)) ? k : Number(k)));
      parts.push(cbor(value[k]));
    }
    return Buffer.concat(parts);
  }
  throw new Error(`cbor: unsupported ${typeof value}`);
}

/**
 * WebCrypto's ECDSA gives raw r‖s; WebAuthn (and this library's verifier)
 * require the DER-encoded ECDSA-Sig-Value SEQUENCE. Real authenticators emit
 * DER, so the simulator has to as well.
 */
const derInt = (bytes) => {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i += 1;
  let b = bytes.slice(i);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]); // keep it positive
  return Buffer.concat([Buffer.from([0x02, b.length]), b]);
};

const derSignature = (raw) => {
  const body = Buffer.concat([derInt(raw.slice(0, 32)), derInt(raw.slice(32, 64))]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
};

// --------------------------------------------------------------- the device --

export async function createAuthenticator() {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey)); // 0x04 || X || Y
  const credentialId = new Uint8Array(webcrypto.getRandomValues(new Uint8Array(16)));
  // COSE_Key: kty=EC2(2), alg=ES256(-7), crv=P-256(1), x, y
  const coseKey = cbor({ 1: 2, 3: -7, "-1": 1, "-2": raw.slice(1, 33), "-3": raw.slice(33, 65) });

  let signCount = 0;

  const authData = async (rpId, { attested, flags }) => {
    const rpIdHash = await sha256(new TextEncoder().encode(rpId));
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(signCount, 0);
    const parts = [rpIdHash, Buffer.from([flags]), counter];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(credentialId.length, 0);
      parts.push(new Uint8Array(16) /* aaguid */, len, credentialId, coseKey);
    }
    return Buffer.concat(parts.map((p) => Buffer.from(p)));
  };

  return {
    credentialId,
    id: b64u(credentialId),

    /** navigator.credentials.create() → RegistrationResponseJSON */
    async register({ rpId, origin, challenge }) {
      const clientDataJSON = Buffer.from(
        JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false }),
      );
      const attestationObject = cbor({
        fmt: "none",
        attStmt: {},
        authData: await authData(rpId, { attested: true, flags: 0x45 /* UP | UV | AT */ }),
      });
      return {
        id: b64u(credentialId),
        rawId: b64u(credentialId),
        type: "public-key",
        response: {
          clientDataJSON: b64u(clientDataJSON),
          attestationObject: b64u(attestationObject),
          transports: ["internal"],
        },
        clientExtensionResults: {},
      };
    },

    /** navigator.credentials.get() → AuthenticationResponseJSON */
    async authenticate({ rpId, origin, challenge, reuseCounter = false }) {
      if (!reuseCounter) signCount += 1;
      const clientDataJSON = Buffer.from(
        JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }),
      );
      const authenticatorData = await authData(rpId, { attested: false, flags: 0x05 /* UP | UV */ });
      const signed = Buffer.concat([authenticatorData, Buffer.from(await sha256(clientDataJSON))]);
      const raw = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, signed));
      const signature = derSignature(raw);
      return {
        id: b64u(credentialId),
        rawId: b64u(credentialId),
        type: "public-key",
        response: {
          clientDataJSON: b64u(clientDataJSON),
          authenticatorData: b64u(authenticatorData),
          signature: b64u(signature),
          userHandle: null,
        },
        clientExtensionResults: {},
      };
    },
  };
}

/**
 * The rpID/origin pair the server will expect for a given base URL. The server
 * takes rpID from the Host header and origin from the Origin header, so a test
 * client has to agree with both — exactly as a browser does.
 */
export function rpForBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  return { rpID: url.hostname, origin: `http://${url.host}` };
}
