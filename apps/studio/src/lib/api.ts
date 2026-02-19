import { treaty } from "@elysiajs/eden";
import type { App } from "@ellie/api-types";

// TODO: Rethink Elysia/Treaty RPC — the preservingFetcher proxy, clone-on-read,
// and empty-body JSON guard are all workarounds for Treaty consuming response
// bodies. Consider building a lightweight typed RPC layer directly on top of
// DurableStreams instead.

/**
 * Custom fetcher that preserves response bodies for the DurableStream protocol.
 *
 * Treaty consumes the response body by calling .json() or .text(), which makes
 * result.response unusable for protocol code that also needs to read the body.
 * This fetcher wraps the response so every body-consuming call reads from a
 * fresh clone, keeping the original body stream intact for protocol code.
 *
 * Also guards against Treaty calling JSON.parse("") on empty-body responses
 * that carry content-type: application/json (e.g. 201 from stream create).
 * Treaty reads via .text() then JSON.parse — an empty string isn't valid JSON.
 * The proxy returns "null" for empty .text() when content-type is JSON so
 * Treaty's parse succeeds.
 */
const preservingFetcher: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);

  // Each body-consuming method clones the original on-the-fly so both
  // Treaty and our protocol code can independently read the body.
  const wrapped = new Proxy(response, {
    get(target, prop) {
      if (prop === "text") {
        return async () => {
          const raw = await target.clone().text();
          // Treaty does JSON.parse(await res.text()) with no try/catch.
          // Empty-body responses with content-type: application/json would
          // cause JSON.parse("") to throw. Return "null" (valid JSON) so
          // Treaty survives.
          if (
            raw === "" &&
            target.headers
              .get("content-type")
              ?.startsWith("application/json")
          ) {
            return "null";
          }
          return raw;
        };
      }
      if (
        prop === "json" ||
        prop === "arrayBuffer" ||
        prop === "blob" ||
        prop === "formData"
      ) {
        return () => {
          const fresh = target.clone();
          return (fresh[prop] as () => Promise<unknown>)();
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return wrapped;
};

export const api = treaty<App>(window.location.origin, {
  fetcher: preservingFetcher,
});
