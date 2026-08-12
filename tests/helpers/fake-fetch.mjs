// Small helper for routing globalThis.fetch to canned responses by URL match, so each
// test file can describe "when the code calls X endpoint, respond with Y" without
// re-writing the same fetch-mock boilerplate every time.

export function routedFetch(routes) {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    for (const route of routes) {
      if (route.test(url, init)) return route.respond(url, init);
    }
    throw new Error(`Unmocked fetch call: ${init?.method || "GET"} ${url}`);
  };
}

export function jsonResponse(body, init) {
  return new Response(JSON.stringify(body), { status: 200, ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) } });
}

export function textResponse(text, init) {
  return new Response(text, { status: 200, ...init });
}

export function withFetch(routes, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = routedFetch(routes);
  return (async () => fn())().finally(() => { globalThis.fetch = original; });
}

export function withEnv(vars, fn) {
  const original = {};
  for (const key of Object.keys(vars)) original[key] = process.env[key];
  Object.assign(process.env, vars);
  return (async () => fn())().finally(() => {
    for (const key of Object.keys(vars)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
}
