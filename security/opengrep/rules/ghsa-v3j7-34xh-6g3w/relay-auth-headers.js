// Static OpenGrep fixtures. Never execute these functions.

function separatedStatements(url, headers) {
  const unrelated = 1;
  // ruleid: loopback-cdp-probe-copies-relay-auth-headers
  const relay = getChromeExtensionRelayAuthHeaders(url);
  inspect(unrelated);
  const merged = { ...relay, ...headers };
}

function separatedInlineCall(url, headers) {
  inspect("unrelated");
  // ruleid: loopback-cdp-probe-copies-relay-auth-headers
  const merged = { ...foo_relayAuth(url), ...headers };
}

// Keep unrelated statements and the match on one line for scanner coverage.
// prettier-ignore
function sameLineStatements(url, headers) {
  // ruleid: loopback-cdp-probe-copies-relay-auth-headers
  const unrelated = 1; const relay = foorelayHeaders(url); const merged = { ...relay, ...headers };
}

// Keep unrelated statements and the match on one line for scanner coverage.
// prettier-ignore
function sameLineInlineCall(url, headers) {
  // ruleid: loopback-cdp-probe-copies-relay-auth-headers
  const unrelated = 1; const merged = { ...foorelayAuthTail(url), ...headers };
}

function unicodeIdentifier(url, headers) {
  inspect("unrelated");
  // ruleid: loopback-cdp-probe-copies-relay-auth-headers
  const relay = λrelayHeaders(url);
  const merged = { ...relay, ...headers };
}

function unicodeMember(client, url, headers) {
  inspect("unrelated");
  // ruleid: loopback-cdp-probe-copies-relay-auth-headers
  const merged = { ...client.λrelayAuth(url), ...headers };
}

function memberCallee(client, url, headers) {
  inspect("unrelated");
  // ruleid: loopback-cdp-probe-copies-relay-auth-headers
  const relay = client.relayHeaders(url);
  const merged = { ...relay, ...headers };
}

function computedMember(client, url, headers) {
  inspect("unrelated");
  // ruleid: loopback-cdp-probe-copies-relay-auth-headers
  const merged = { ...client["relayAuth"](url), ...headers };
}

function benignSelector(url, headers) {
  // ok: loopback-cdp-probe-copies-relay-auth-headers
  const relay = getHeaders(url);
  const merged = { ...relay, ...headers };
}

function exactSelectorSuffix(url, headers) {
  // ok: loopback-cdp-probe-copies-relay-auth-headers
  const merged = { ...getChromeExtensionRelayAuthHeadersExtra(url), ...headers };
}

function wrongCase(url, headers) {
  // ok: loopback-cdp-probe-copies-relay-auth-headers
  const merged = { ...RelayHeaders(url), ...headers };
}

function lowercaseHeaders(url, headers) {
  // ok: loopback-cdp-probe-copies-relay-auth-headers
  const relay = foorelayheaders(url);
  const merged = { ...relay, ...headers };
}

function emptySelector(url, headers) {
  // ok: loopback-cdp-probe-copies-relay-auth-headers
  const merged = { ...""(url), ...headers };
}

function missingOtherHeaders(url) {
  // ok: loopback-cdp-probe-copies-relay-auth-headers
  const merged = { ...relayAuth(url) };
}

// metavariable-regex defaults constant-propagation to false in OpenGrep 1.30.0.
function constantValueDoesNotSelectAlias(url, headers) {
  const selector = "relayAuth";
  // ok: loopback-cdp-probe-copies-relay-auth-headers
  const merged = { ...selector(url), ...headers };
}

function constantValueDoesNotDeselectName(url, headers) {
  const relayAuth = "unrelated";
  // ruleid: loopback-cdp-probe-copies-relay-auth-headers
  const relay = relayAuth(url);
  const merged = { ...relay, ...headers };
}
