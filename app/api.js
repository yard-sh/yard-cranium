// The one way the app talks to _service.js. Paths are relative ("api/me"),
// never root-absolute: the app is served under /<slug>/app/ (and one level
// deeper in a sandbox), and a leading slash would drop that prefix.

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code || "";
  }
}

// Writes always carry Content-Type: application/json, even with an empty
// body: the service refuses anything else (see isJSON in _service.js).
export async function api(path, { method = "GET", body } = {}) {
  const init = {
    method,
    credentials: "same-origin",
    // A lapsed session makes the edge redirect to sign-in on another origin.
    // Following it would fail as a CORS error; stopping at it tells us why.
    redirect: "manual",
    headers: { Accept: "application/json" },
  };
  if (method !== "GET") {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body || {});
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError("You look offline. Try again in a moment.", 0, "offline");
  }
  if (res.type === "opaqueredirect" || !(res.headers.get("Content-Type") || "").includes("application/json")) {
    throw new ApiError("Your session ended. Signing you back in…", 401, "signed_out");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data.code);
  return data;
}
