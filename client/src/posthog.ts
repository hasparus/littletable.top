const token = document.querySelector<HTMLMetaElement>(
  'meta[name="posthog-project-token"]',
)?.content;

async function startPostHog(projectToken: string) {
  try {
    const [{ default: posthog }, { default: manifest }] = await Promise.all([
      import("posthog-js"),
      import("posthog-js/dist/integrity.json"),
    ]);
    const assets = `https://us-assets.i.posthog.com/static/${manifest.version}/`;
    const integrity: Record<string, string> = manifest.files;
    posthog.init(projectToken, {
      api_host: "https://us.i.posthog.com",
      autocapture: false,
      capture_exceptions: true,
      capture_pageleave: true,
      capture_pageview: true,
      capture_performance: false,
      disable_capture_url_hashes: true,
      disable_conversations: false,
      disable_surveys: true,
      enable_recording_console_log: false,
      person_profiles: "never",
      prepare_external_dependency_script(script) {
        if (!script.src.startsWith(assets)) return null;
        const file = script.src.slice(assets.length);
        if (!Object.hasOwn(integrity, file)) return null;
        script.crossOrigin = "anonymous";
        script.integrity = integrity[file]!;
        return script;
      },
      strict_script_versioning: true,
      session_recording: {
        blockSelector: "[data-board-root], #ph-conversations-widget-container",
        captureCanvas: { recordCanvas: false },
        maskAllInputs: true,
        maskCapturedNetworkRequestFn: (request) => ({
          ...request,
          name: request.name.split(/[?#]/u, 1)[0] ?? "",
        }),
        recordBody: false,
        recordHeaders: false,
      },
    });
  } catch (error) {
    console.warn("PostHog could not start", error);
  }
}

// oxlint-disable-next-line unicorn/prefer-top-level-await -- Keep analytics off the app startup path.
if (token) void startPostHog(token);
