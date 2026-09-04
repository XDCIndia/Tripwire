import { describe, expect, it, vi } from "vitest"

import {
  type BlacklistVerdict,
  classifyAddressSecurity,
  classifyTokenSecurity,
  createGoPlusBlacklistChecker,
} from "../src/blacklist.js"

const TARGET = "0xAbcdefabcdefabcdefabcdefabcdefabcdefabcd"
const CHAIN_ID = 11155111

// A fetch stand-in whose behavior is scripted per test. Shape matches the
// subset of the fetch API the checker uses.
type FetchImpl = typeof fetch

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function mockFetch(handler: (url: string) => Promise<Response> | Response): FetchImpl {
  return vi.fn(async (url: string | URL | Request) => {
    const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url
    return handler(urlString)
  }) as unknown as FetchImpl
}

function checker(fetchImpl: FetchImpl, timeoutMs = 3000) {
  return createGoPlusBlacklistChecker({ chainId: CHAIN_ID, fetchImpl, timeoutMs })
}

describe("classifyAddressSecurity", function () {
  it("reports malicious when a malicious_label is present", function () {
    const payload = { code: 1, message: "OK", result: { malicious_label: "Phishing" } }
    expect(classifyAddressSecurity(payload)).toBe("malicious")
  })

  it("reports malicious when malicious_behavior entries exist", function () {
    const payload = { code: 1, message: "OK", result: { malicious_label: "", malicious_behavior: ["Fake_Phishing"] } }
    expect(classifyAddressSecurity(payload)).toBe("malicious")
  })

  it("reports clean when the result has no flags, and when result is null (no data)", function () {
    expect(
      classifyAddressSecurity({ code: 1, message: "OK", result: { malicious_label: "", malicious_behavior: [] } }),
    ).toBe("clean")
    expect(classifyAddressSecurity({ code: 1, message: "OK", result: null })).toBe("clean")
  })

  it("reports unknown on business failure, HTTP-shaped error, or malformed payload", function () {
    expect(classifyAddressSecurity({ code: 2, message: "Unsupported chain" })).toBe("unknown")
    expect(classifyAddressSecurity(null)).toBe("unknown")
    expect(classifyAddressSecurity("not an object")).toBe("unknown")
  })
})

describe("classifyTokenSecurity", function () {
  it("reports malicious when a curated risk flag is set", function () {
    const entry = { is_honeypot: "1", is_proxy_malicious: "0" }
    const payload = { code: 1, message: "OK", result: { [TARGET.toLowerCase()]: entry } }
    expect(classifyTokenSecurity(payload, TARGET)).toBe("malicious")

    const proxyFlag = { is_honeypot: "0", is_proxy_malicious: "1" }
    expect(classifyTokenSecurity({ code: 1, result: { [TARGET.toLowerCase()]: proxyFlag } }, TARGET)).toBe("malicious")
  })

  it("reports clean when flags are absent/zero, the address isn't in the map, or result is null", function () {
    const entry = { is_honeypot: "0" }
    expect(classifyTokenSecurity({ code: 1, result: { [TARGET.toLowerCase()]: entry } }, TARGET)).toBe("clean")
    expect(classifyTokenSecurity({ code: 1, result: { "0xother": entry } }, TARGET)).toBe("clean")
    expect(classifyTokenSecurity({ code: 1, result: null }, TARGET)).toBe("clean")
  })

  it("reports unknown on business failure or malformed payload", function () {
    expect(classifyTokenSecurity({ code: 2, message: "rate limited" }, TARGET)).toBe("unknown")
    expect(classifyTokenSecurity(undefined, TARGET)).toBe("unknown")
  })
})

describe("createGoPlusBlacklistChecker", function () {
  it("queries both endpoints and combines: malicious wins over clean", async function () {
    const fetchImpl = mockFetch((url) => {
      if (url.includes("address_security")) {
        return jsonResponse({ code: 1, result: { malicious_label: "Phishing" } })
      }
      return jsonResponse({ code: 1, result: { [TARGET.toLowerCase()]: { is_honeypot: "0" } } })
    })

    const verdict: BlacklistVerdict = await checker(fetchImpl).checkCounterparty(TARGET)
    expect(verdict).toBe("malicious")
  })

  it("returns clean only when both endpoints check clean", async function () {
    const fetchImpl = mockFetch((url) => {
      if (url.includes("address_security")) {
        return jsonResponse({ code: 1, result: { malicious_label: "", malicious_behavior: [] } })
      }
      return jsonResponse({ code: 1, result: null })
    })

    expect(await checker(fetchImpl).checkCounterparty(TARGET)).toBe("clean")
  })

  it("returns unknown when either endpoint fails, even if the other is clean", async function () {
    const fetchImpl = mockFetch((url) => {
      if (url.includes("address_security")) {
        return jsonResponse({ code: 1, result: { malicious_label: "", malicious_behavior: [] } })
      }
      return jsonResponse({ message: "boom" }, 500)
    })

    expect(await checker(fetchImpl).checkCounterparty(TARGET)).toBe("unknown")
  })

  it("maps network errors to unknown instead of rejecting", async function () {
    const fetchImpl = mockFetch(() => {
      throw new Error("connection reset")
    })

    expect(await checker(fetchImpl).checkCounterparty(TARGET)).toBe("unknown")
  })

  it("maps aborts/timeouts to unknown and does not hang past the timeout", async function () {
    // Simulates a connection that only settles when the checker's
    // AbortController fires - the realistic hung-connection behavior.
    const abortingFetch = ((url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("AbortError")))
      })) as unknown as FetchImpl

    const start = Date.now()
    const verdict = await checker(abortingFetch, 50).checkCounterparty(TARGET)
    expect(verdict).toBe("unknown")
    expect(Date.now() - start).toBeLessThan(1000)
  })

  it("returns unknown immediately for a malformed address without calling the API", async function () {
    const fetchImpl = mockFetch(() => jsonResponse({ code: 1, result: null }))
    expect(await checker(fetchImpl).checkCounterparty("0xnotanaddress")).toBe("unknown")
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("appends the API key and chain id to both endpoint URLs", async function () {
    const calls: string[] = []
    const fetchImpl = mockFetch((url) => {
      calls.push(url)
      return jsonResponse({ code: 1, result: null })
    })

    await createGoPlusBlacklistChecker({
      chainId: CHAIN_ID,
      apiKey: "test-key",
      fetchImpl,
    }).checkCounterparty(TARGET)

    expect(calls).toHaveLength(2)
    for (const url of calls) {
      // address_security takes chain_id as a query param, token_security as a
      // path segment - both must carry it somewhere.
      expect(url).toContain(String(CHAIN_ID))
      expect(url).toContain("api_key=test-key")
    }
    expect(calls.some((url) => url.includes("address_security"))).toBe(true)
    expect(calls.some((url) => url.includes("token_security"))).toBe(true)
  })
})
