// Static OpenGrep fixtures. Never execute these functions.
type Headers = Record<string, string>;
type Getter = (url: string) => Headers;
declare const getChromeExtensionRelayAuthHeaders: Getter;
declare const foorelayAuthTail: Getter;
declare const λrelayHeaders: Getter;
declare function inspect(value: unknown): void;

function typedStatements(url: string, headers: Headers) {
  inspect("unrelated");
  // ruleid: loopback-cdp-probe-copies-relay-auth-headers
  const relay = getChromeExtensionRelayAuthHeaders(url);
  const merged = { ...relay, ...headers };
}

// Keep unrelated statements and the match on one line for scanner coverage.
// prettier-ignore
function typedInline(url: string, headers: Headers) {
  // ruleid: loopback-cdp-probe-copies-relay-auth-headers
  const unrelated = 1; const merged = { ...foorelayAuthTail(url), ...headers };
}

function typedUnicode(url: string, headers: Headers) {
  inspect("unrelated");
  // ruleid: loopback-cdp-probe-copies-relay-auth-headers
  const merged = { ...λrelayHeaders(url), ...headers };
}

function typedMember(client: { relayHeaders: Getter }, url: string, headers: Headers) {
  inspect("unrelated");
  // ruleid: loopback-cdp-probe-copies-relay-auth-headers
  const relay = client.relayHeaders(url);
  const merged = { ...relay, ...headers };
}

function typedNegative(client: { RelayHeaders: Getter }, url: string, headers: Headers) {
  // ok: loopback-cdp-probe-copies-relay-auth-headers
  const merged = { ...client.RelayHeaders(url), ...headers };
}

function typedConstantAlias(url: string, headers: Headers) {
  const selector = "relayAuth";
  // ok: loopback-cdp-probe-copies-relay-auth-headers
  const merged = { ...selector(url), ...headers };
}

function typedConstantName(url: string, headers: Headers) {
  const relayAuth = "unrelated";
  // ruleid: loopback-cdp-probe-copies-relay-auth-headers
  const merged = { ...relayAuth(url), ...headers };
}
