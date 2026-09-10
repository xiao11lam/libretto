import { createServer } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { afterEach, describe, expect, it, test as base, vi } from "vitest";
import {
  createPlaywrightDebugger,
  createSeleniumDebugger,
  parseAgentModel,
  type DebugAgentRunner,
  type SeleniumWebDriver,
} from "../src/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

async function pickFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        server.close(() => resolve(address.port));
        return;
      }
      server.close(() => reject(new Error("Failed to resolve debug port")));
    });
  });
}

async function fetchWebSocketDebuggerUrl(port: number): Promise<string> {
  const versionUrl = `http://127.0.0.1:${port}/json/version`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(versionUrl);
      const version = (await response.json()) as {
        webSocketDebuggerUrl?: string;
      };
      if (version.webSocketDebuggerUrl) return version.webSocketDebuggerUrl;
    } catch {
      // Chrome may need a moment to expose its debugger endpoint.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Could not read a CDP endpoint from ${versionUrl}`);
}

const browserTest = base.extend<{
  seleniumBrowser: {
    browser: Browser;
    cdpEndpoint: string;
    debuggerAddress: string;
    page: Page;
    windowHandle: string;
  };
}>({
  seleniumBrowser: async ({}, use) => {
    const port = await pickFreePort();
    const browser = await chromium.launch({
      headless: true,
      args: [`--remote-debugging-port=${port}`],
    });
    const inactivePage = await browser.newPage();
    await inactivePage.setContent(
      "<html><head><title>Other tab</title></head><body><main>Do not inspect this tab</main></body></html>",
    );
    const page = await browser.newPage();
    await page.setContent(
      "<html><head><title>Selenium failure</title></head><body><main>Live Selenium state</main></body></html>",
    );
    const cdp = await page.context().newCDPSession(page);
    const target = await cdp.send("Target.getTargetInfo");
    await cdp.detach();

    await use({
      browser,
      cdpEndpoint: await fetchWebSocketDebuggerUrl(port),
      debuggerAddress: `127.0.0.1:${port}`,
      page,
      windowHandle: `CDwindow-${target.targetInfo.targetId}`,
    });
    await browser.close();
  },
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function createPage(): Page {
  return {
    url: vi.fn(() => "https://example.test/dashboard"),
    title: vi.fn(async () => "Dashboard"),
    screenshot: vi.fn(async () => Buffer.from("png")),
    content: vi.fn(async () => "<html><main>Missing submit button</main></html>"),
  } as unknown as Page;
}

function createError(): Error {
  const error = new Error("locator.click: Timeout 5000ms exceeded");
  error.stack = [
    "Error: locator.click: Timeout 5000ms exceeded",
    "    at runAutomation (/repo/src/workflow.ts:12:7)",
  ].join("\n");
  return error;
}

describe("parseAgentModel", () => {
  it("parses provider/model-id strings", () => {
    expect(parseAgentModel("openai/gpt-5.4")).toEqual({
      provider: "openai",
      modelId: "gpt-5.4",
    });
    expect(parseAgentModel("anthropic/claude-sonnet-4-6")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
  });

  it("rejects unsupported provider strings", () => {
    expect(() => parseAgentModel("google/gemini-3-flash")).toThrow(
      "Unsupported agent model provider",
    );
    expect(() => parseAgentModel("gpt-5.4")).toThrow(
      'Expected "provider/model-id"',
    );
  });
});

describe("createPlaywrightDebugger", () => {
  it("captures failure context and returns no_changes when the agent has no fix", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = url.toString();
      const method = init?.method ?? "GET";
      requests.push({ method, url: requestUrl });
      if (requestUrl.endsWith("/git/ref/heads/main")) {
        return jsonResponse({ object: { sha: "base-commit" } });
      }
      if (requestUrl.endsWith("/git/commits/base-commit")) {
        return jsonResponse({ sha: "base-commit", tree: { sha: "base-tree" } });
      }
      if (requestUrl.includes("/contents/src/workflow.ts?ref=main")) {
        return jsonResponse({
          type: "file",
          encoding: "base64",
          content: Buffer.from("export async function runAutomation() {}").toString(
            "base64",
          ),
        });
      }
      return jsonResponse({ message: "not found" }, { status: 404 });
    }) as unknown as typeof fetch;
    const runner = vi.fn<DebugAgentRunner>(async (context) => {
      expect(context.model).toEqual({ provider: "openai", modelId: "gpt-5.4" });
      expect(context.framework).toBe("playwright");
      expect(context.failure.message).toContain("Timeout");
      expect(context.failure.url).toBe("https://example.test/dashboard");
      expect(context.failure.title).toBe("Dashboard");
      expect(context.failure.screenshot?.base64).toBe("cG5n");
      expect(context.failure.domSnapshot).toContain("Missing submit button");
      expect(context.sourceFiles).toEqual([
        {
          path: "src/workflow.ts",
          content: "export async function runAutomation() {}",
        },
      ]);
      return {
        title: "Investigate submit timeout",
        summary: "No safe fix found",
        rationale: "The failure needs more context.",
        changes: [],
      };
    });

    const debuggerInstance = createPlaywrightDebugger({
      github: {
        owner: "acme",
        repo: "automations",
        baseBranch: "main",
        token: "ghs_test",
        repositoryRoot: "/repo",
      },
      agent: {
        model: "openai/gpt-5.4",
      },
      fetch: fetchImpl,
      modelRunner: runner,
    });

    const result = await debuggerInstance.debugFailure(
      createError(),
      createPage(),
    );

    expect(result.status).toBe("no_changes");
    expect(runner).toHaveBeenCalledOnce();
    expect(requests.map((request) => request.method)).toEqual([
      "GET",
      "GET",
      "GET",
    ]);
  });

  it("relativizes Windows absolute stack paths against the repository root", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = url.toString();
      if (requestUrl.endsWith("/git/ref/heads/main")) {
        return jsonResponse({ object: { sha: "base-commit" } });
      }
      if (requestUrl.endsWith("/git/commits/base-commit")) {
        return jsonResponse({ sha: "base-commit", tree: { sha: "base-tree" } });
      }
      if (requestUrl.includes("/contents/src/workflow.ts?ref=main")) {
        return jsonResponse({
          type: "file",
          encoding: "base64",
          content: Buffer.from("export async function runAutomation() {}").toString(
            "base64",
          ),
        });
      }
      return jsonResponse({ message: "not found" }, { status: 404 });
    }) as unknown as typeof fetch;
    const runner = vi.fn<DebugAgentRunner>(async (context) => {
      expect(context.sourceFiles).toEqual([
        {
          path: "src/workflow.ts",
          content: "export async function runAutomation() {}",
        },
      ]);
      return {
        title: "Investigate submit timeout",
        summary: "No safe fix found",
        rationale: "The failure needs more context.",
        changes: [],
      };
    });
    const error = new Error("locator.click: Timeout 5000ms exceeded");
    error.stack = [
      "Error: locator.click: Timeout 5000ms exceeded",
      "    at runAutomation (C:\\repo\\src\\workflow.ts:12:7)",
    ].join("\n");

    const debuggerInstance = createPlaywrightDebugger({
      github: {
        owner: "acme",
        repo: "automations",
        baseBranch: "main",
        token: "ghs_test",
        repositoryRoot: "C:\\repo",
      },
      agent: {
        model: "openai/gpt-5.4",
      },
      fetch: fetchImpl,
      modelRunner: runner,
    });

    await debuggerInstance.debugFailure(error, createPage());

    expect(runner).toHaveBeenCalledOnce();
  });

  it("writes model changes through the GitHub Git API and opens a pull request", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = url.toString();
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, url: requestUrl, body });
      if (requestUrl.endsWith("/git/ref/heads/main")) {
        return jsonResponse({ object: { sha: "base-commit" } });
      }
      if (requestUrl.endsWith("/git/commits/base-commit")) {
        return jsonResponse({ sha: "base-commit", tree: { sha: "base-tree" } });
      }
      if (requestUrl.includes("/contents/src/workflow.ts?ref=main")) {
        return jsonResponse({
          type: "file",
          encoding: "base64",
          content: Buffer.from("await page.locator('#old').click();").toString(
            "base64",
          ),
        });
      }
      if (method === "POST" && requestUrl.endsWith("/git/refs")) {
        return jsonResponse({ ref: "refs/heads/libretto-debug/test" });
      }
      if (method === "POST" && requestUrl.endsWith("/git/blobs")) {
        return jsonResponse({ sha: "blob-sha" });
      }
      if (method === "POST" && requestUrl.endsWith("/git/trees")) {
        return jsonResponse({ sha: "tree-sha" });
      }
      if (method === "POST" && requestUrl.endsWith("/git/commits")) {
        return jsonResponse({ sha: "new-commit", tree: { sha: "tree-sha" } });
      }
      if (
        method === "PATCH" &&
        requestUrl.includes(
          "/git/refs/heads/libretto-debug%2Facme-automations-20260713T220000000Z-",
        )
      ) {
        return jsonResponse({});
      }
      if (method === "POST" && requestUrl.endsWith("/pulls")) {
        return jsonResponse({
          html_url: "https://github.com/acme/automations/pull/123",
        });
      }
      return jsonResponse({ message: "not found" }, { status: 404 });
    }) as unknown as typeof fetch;

    const debuggerInstance = createPlaywrightDebugger({
      github: {
        owner: "acme",
        repo: "automations",
        baseBranch: "main",
        token: "ghs_test",
        repositoryRoot: "/repo",
      },
      agent: {
        model: "anthropic/claude-sonnet-4-6",
      },
      fetch: fetchImpl,
      now: () => new Date("2026-07-13T22:00:00.000Z"),
      modelRunner: async () => ({
        title: "Use the new submit selector",
        summary: "Use the new submit selector",
        rationale: "The DOM shows the old selector no longer exists.",
        changes: [
          {
            path: "src/workflow.ts",
            content: "await page.getByRole('button', { name: 'Submit' }).click();",
          },
        ],
      }),
    });

    const result = await debuggerInstance.debugFailure(
      createError(),
      createPage(),
    );

    expect(result).toMatchObject({
      status: "pull_request_opened",
      branchName: expect.stringMatching(
        /^libretto-debug\/acme-automations-20260713T220000000Z-[0-9a-f]{8}$/,
      ),
      pullRequestUrl: "https://github.com/acme/automations/pull/123",
      changedFiles: ["src/workflow.ts"],
    });
    expect(calls.map((call) => call.method)).toEqual([
      "GET",
      "GET",
      "GET",
      "POST",
      "POST",
      "POST",
      "POST",
      "PATCH",
      "POST",
    ]);
    expect(calls.find((call) => call.url.endsWith("/git/blobs"))?.body).toEqual({
      content: "await page.getByRole('button', { name: 'Submit' }).click();",
      encoding: "utf-8",
    });
    expect(calls.find((call) => call.url.endsWith("/pulls"))?.body).toMatchObject({
      title: "[Libretto Agent]: Use the new submit selector",
      head: expect.stringMatching(
        /^libretto-debug\/acme-automations-20260713T220000000Z-[0-9a-f]{8}$/,
      ),
      base: "main",
    });

    const secondResult = await debuggerInstance.debugFailure(
      createError(),
      createPage(),
    );
    expect(secondResult).toMatchObject({ status: "pull_request_opened" });
    if (
      result.status !== "pull_request_opened" ||
      secondResult.status !== "pull_request_opened"
    ) {
      throw new Error("Expected both debugger runs to open pull requests");
    }
    expect(secondResult.branchName).not.toBe(result.branchName);
  });

  it("uses Libretto Cloud to broker the GitHub installation token", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown; auth?: string }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = url.toString();
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      const headers = new Headers(init?.headers);
      calls.push({
        method,
        url: requestUrl,
        body,
        auth: headers.get("authorization") ?? headers.get("x-api-key") ?? undefined,
      });
      if (requestUrl === "https://api.libretto.test/v1/github/createInstallationToken") {
        return jsonResponse({
          json: {
            token: "brokered-installation-token",
            expires_at: "2026-07-08T00:00:00Z",
          },
        });
      }
      if (requestUrl.endsWith("/git/ref/heads/main")) {
        return jsonResponse({ object: { sha: "base-commit" } });
      }
      if (requestUrl.endsWith("/git/commits/base-commit")) {
        return jsonResponse({ sha: "base-commit", tree: { sha: "base-tree" } });
      }
      if (requestUrl.includes("/contents/src/workflow.ts?ref=main")) {
        return jsonResponse({
          type: "file",
          encoding: "base64",
          content: Buffer.from("old").toString("base64"),
        });
      }
      return jsonResponse({ message: "not found" }, { status: 404 });
    }) as unknown as typeof fetch;

    const debuggerInstance = createPlaywrightDebugger({
      github: {
        owner: "acme",
        repo: "automations",
        baseBranch: "main",
        librettoApiKey: "libretto-key",
        librettoApiUrl: "https://api.libretto.test",
        repositoryRoot: "/repo",
      },
      agent: {
        model: "openai/gpt-5.4",
      },
      fetch: fetchImpl,
      modelRunner: async () => ({
        title: "No fix",
        summary: "No fix",
        rationale: "No fix",
        changes: [],
      }),
    });

    await debuggerInstance.debugFailure(createError(), createPage());

    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.libretto.test/v1/github/createInstallationToken",
      auth: "libretto-key",
      body: {
        json: {
          owner: "acme",
          repo: "automations",
        },
      },
    });
    expect(calls[1]?.auth).toBe("Bearer brokered-installation-token");
  });

  it("requires GitHub token auth or a Libretto Cloud API key", async () => {
    const debuggerInstance = createPlaywrightDebugger({
      github: {
        owner: "acme",
        repo: "automations",
        baseBranch: "main",
      },
      agent: {
        model: "openai/gpt-5.4",
      },
      fetch: vi.fn() as unknown as typeof fetch,
      modelRunner: async () => ({
        title: "Unused",
        summary: "unused",
        rationale: "unused",
        changes: [],
      }),
    });

    await expect(
      debuggerInstance.debugFailure(createError(), createPage()),
    ).resolves.toMatchObject({
      status: "debugger_failed",
      error: expect.stringContaining("GitHub authentication is missing"),
    });
  });

  it("does not replace the original automation error or prevent fallback logic", async () => {
    const debuggerInstance = createPlaywrightDebugger({
      github: {
        owner: "acme",
        repo: "automations",
        baseBranch: "main",
        token: "ghs_test",
      },
      agent: { model: "openai/gpt-5.4" },
      fetch: (async () =>
        jsonResponse({ message: "GitHub unavailable" }, { status: 503 })) as typeof fetch,
      modelRunner: async () => ({
        title: "Unused",
        summary: "unused",
        rationale: "unused",
        changes: [],
      }),
    });
    const originalError = createError();
    let fallbackCalled = false;

    const runFailurePath = async () => {
      try {
        throw originalError;
      } catch (error) {
        const debugResult = await debuggerInstance.debugFailure(
          error,
          createPage(),
        );
        expect(debugResult.status).toBe("debugger_failed");
        fallbackCalled = true;
        throw error;
      }
    };

    await expect(runFailurePath()).rejects.toBe(originalError);
    expect(fallbackCalled).toBe(true);
  });

  it("rejects unsafe paths returned by the agent", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = url.toString();
      if (requestUrl.endsWith("/git/ref/heads/main")) {
        return jsonResponse({ object: { sha: "base-commit" } });
      }
      if (requestUrl.endsWith("/git/commits/base-commit")) {
        return jsonResponse({ sha: "base-commit", tree: { sha: "base-tree" } });
      }
      if (requestUrl.includes("/contents/src/workflow.ts?ref=main")) {
        return jsonResponse({
          type: "file",
          encoding: "base64",
          content: Buffer.from("old").toString("base64"),
        });
      }
      return jsonResponse({ message: "not found" }, { status: 404 });
    }) as unknown as typeof fetch;

    const debuggerInstance = createPlaywrightDebugger({
      github: {
        owner: "acme",
        repo: "automations",
        baseBranch: "main",
        token: "ghs_test",
        repositoryRoot: "/repo",
      },
      agent: {
        model: "openai/gpt-5.4",
      },
      fetch: fetchImpl,
      modelRunner: async () => ({
        title: "Unsafe",
        summary: "Unsafe",
        rationale: "Unsafe",
        changes: [{ path: "../secret.ts", content: "" }],
      }),
    });

    await expect(
      debuggerInstance.debugFailure(createError(), createPage()),
    ).resolves.toMatchObject({
      status: "debugger_failed",
      error: expect.stringContaining("Unsafe repository path"),
    });
  });
});

describe("createSeleniumDebugger", () => {
  describe.each([
    {
      browserName: "chrome",
      optionsKey: "goog:chromeOptions",
    },
    {
      browserName: "MicrosoftEdge",
      optionsKey: "ms:edgeOptions",
    },
  ])("$browserName", ({ browserName, optionsKey }) => {
    browserTest(
      "attaches to the active tab and leaves Selenium running",
      async ({ seleniumBrowser }) => {
        const quit = vi.fn(async () => undefined);
        const driver = {
          getCapabilities: vi.fn(async () => ({
            get: (name: string) => {
              if (name === "browserName") return browserName;
              if (name === optionsKey) {
                return { debuggerAddress: seleniumBrowser.debuggerAddress };
              }
              return undefined;
            },
          })),
          getWindowHandle: vi.fn(async () => seleniumBrowser.windowHandle),
          getCurrentUrl: vi.fn(async () => seleniumBrowser.page.url()),
          getTitle: vi.fn(async () => await seleniumBrowser.page.title()),
          quit,
        } satisfies SeleniumWebDriver & { quit(): Promise<void> };
        const fetchImpl = vi.fn(async (url: string | URL | Request) => {
          const requestUrl = url.toString();
          if (requestUrl.endsWith("/git/ref/heads/main")) {
            return jsonResponse({ object: { sha: "base-commit" } });
          }
          if (requestUrl.endsWith("/git/commits/base-commit")) {
            return jsonResponse({
              sha: "base-commit",
              tree: { sha: "base-tree" },
            });
          }
          return jsonResponse({ message: "not found" }, { status: 404 });
        }) as unknown as typeof fetch;
        const runner = vi.fn<DebugAgentRunner>(async (context) => {
          expect(context.framework).toBe("selenium");
          expect(context.failure.title).toBe("Selenium failure");
          expect(context.failure.domSnapshot).toContain("Live Selenium state");
          return {
            title: "No safe fix",
            summary: "No safe fix found",
            rationale: "The page needs more evidence.",
            changes: [],
          };
        });
        const debuggerInstance = createSeleniumDebugger({
          github: {
            owner: "acme",
            repo: "automations",
            baseBranch: "main",
            token: "ghs_test",
          },
          agent: { model: "openai/gpt-5.4" },
          fetch: fetchImpl,
          modelRunner: runner,
        });

        const result = await debuggerInstance.debugFailure(
          new Error("element click intercepted"),
          driver,
        );

        expect(result.status).toBe("no_changes");
        expect(seleniumBrowser.browser.isConnected()).toBe(true);
        await expect(seleniumBrowser.page.title()).resolves.toBe(
          "Selenium failure",
        );
        const followupPage = await seleniumBrowser.browser.newPage();
        await followupPage.setContent("<title>Still usable</title>");
        await expect(followupPage.title()).resolves.toBe("Still usable");
        expect(quit).not.toHaveBeenCalled();
      },
    );
  });

  it("returns an actionable error for unsupported Firefox sessions", async () => {
    const driver = {
      getCapabilities: vi.fn(async () => ({
        get: (name: string) => (name === "browserName" ? "firefox" : undefined),
      })),
      getWindowHandle: vi.fn(async () => "window-1"),
      getCurrentUrl: vi.fn(async () => "https://example.test"),
      getTitle: vi.fn(async () => "Example"),
    } satisfies SeleniumWebDriver;
    const debuggerInstance = createSeleniumDebugger({
      github: {
        owner: "acme",
        repo: "automations",
        baseBranch: "main",
        token: "ghs_test",
      },
      agent: { model: "openai/gpt-5.4" },
      fetch: vi.fn() as unknown as typeof fetch,
      modelRunner: vi.fn(),
    });

    await expect(
      debuggerInstance.debugFailure(new Error("failed"), driver),
    ).resolves.toEqual({
      status: "debugger_failed",
      error: expect.stringContaining(
        "Selenium debugging supports Chrome and Microsoft Edge",
      ),
    });
  });

  it("tells the caller how to fix a missing debugger address", async () => {
    const driver = {
      getCapabilities: vi.fn(async () => ({
        get: (name: string) => (name === "browserName" ? "chrome" : undefined),
      })),
      getWindowHandle: vi.fn(async () => "window-1"),
      getCurrentUrl: vi.fn(async () => "https://example.test"),
      getTitle: vi.fn(async () => "Example"),
    } satisfies SeleniumWebDriver;
    const debuggerInstance = createSeleniumDebugger({
      github: {
        owner: "acme",
        repo: "automations",
        baseBranch: "main",
        token: "ghs_test",
      },
      agent: { model: "openai/gpt-5.4" },
      fetch: vi.fn() as unknown as typeof fetch,
      modelRunner: vi.fn(),
    });

    await expect(
      debuggerInstance.debugFailure(new Error("failed"), driver),
    ).resolves.toEqual({
      status: "debugger_failed",
      error: expect.stringContaining(
        "Keep the WebDriver session open and pass its live driver",
      ),
    });
  });

  browserTest(
    "uses a Selenium 4 CDP endpoint exposed by a remote Chrome session",
    async ({ seleniumBrowser }) => {
      const driver = {
        getCapabilities: vi.fn(async () => ({
          browserName: "chrome",
          "se:cdp": seleniumBrowser.cdpEndpoint,
        })),
        getWindowHandle: vi.fn(async () => seleniumBrowser.windowHandle),
        getCurrentUrl: vi.fn(async () => seleniumBrowser.page.url()),
        getTitle: vi.fn(async () => await seleniumBrowser.page.title()),
      } satisfies SeleniumWebDriver;
      const fetchImpl = vi.fn(async (url: string | URL | Request) => {
        const requestUrl = url.toString();
        if (requestUrl.endsWith("/git/ref/heads/main")) {
          return jsonResponse({ object: { sha: "base-commit" } });
        }
        if (requestUrl.endsWith("/git/commits/base-commit")) {
          return jsonResponse({ sha: "base-commit", tree: { sha: "base-tree" } });
        }
        return jsonResponse({ message: "not found" }, { status: 404 });
      }) as unknown as typeof fetch;
      const runner = vi.fn<DebugAgentRunner>(async (context) => {
        expect(context.framework).toBe("selenium");
        expect(context.failure.title).toBe("Selenium failure");
        expect(context.failure.domSnapshot).toContain("Live Selenium state");
        return {
          title: "No safe fix",
          summary: "No safe fix found",
          rationale: "The page needs more evidence.",
          changes: [],
        };
      });
      const debuggerInstance = createSeleniumDebugger({
        github: {
          owner: "acme",
          repo: "automations",
          baseBranch: "main",
          token: "ghs_test",
        },
        agent: { model: "openai/gpt-5.4" },
        fetch: fetchImpl,
        modelRunner: runner,
      });

      const result = await debuggerInstance.debugFailure(
        new Error("element click intercepted"),
        driver,
      );

      expect(result.status).toBe("no_changes");
      expect(seleniumBrowser.browser.isConnected()).toBe(true);
      await expect(seleniumBrowser.page.title()).resolves.toBe(
        "Selenium failure",
      );
    },
  );

  it("returns an actionable error when Chrome is no longer reachable", async () => {
    const driver = {
      getCapabilities: vi.fn(async () => ({
        get: (name: string) => {
          if (name === "browserName") return "chrome";
          if (name === "goog:chromeOptions") {
            return { debuggerAddress: "127.0.0.1:0" };
          }
          return undefined;
        },
      })),
      getWindowHandle: vi.fn(async () => "CDwindow-closed"),
      getCurrentUrl: vi.fn(async () => "https://example.test"),
      getTitle: vi.fn(async () => "Example"),
    } satisfies SeleniumWebDriver;
    const debuggerInstance = createSeleniumDebugger({
      github: {
        owner: "acme",
        repo: "automations",
        baseBranch: "main",
        token: "ghs_test",
      },
      agent: { model: "openai/gpt-5.4" },
      fetch: vi.fn() as unknown as typeof fetch,
      modelRunner: vi.fn(),
    });

    await expect(
      debuggerInstance.debugFailure(new Error("failed"), driver),
    ).resolves.toEqual({
      status: "debugger_failed",
      error: expect.stringContaining(
        "Could not attach Libretto to the Selenium Chrome session",
      ),
    });
  });
});
