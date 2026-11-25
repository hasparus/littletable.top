import { afterEach, expect, it, vi } from "vitest";

import { Browser, ORIGIN, standaloneEnv } from "./standalone-support";

const survey = "f029c24e-63a6-4b68-b01f-41552b629f17";
const question = "43a54b36-249f-44ed-955b-c661d1f32508";
const submissionId = "77492056-8a5b-406e-af16-f86f3c6f9779";
const configured = {
  ...standaloneEnv,
  POSTHOG_PROJECT_TOKEN: "phc_test",
  POSTHOG_REGION: "eu",
  POSTHOG_FEEDBACK_SURVEY_ID: survey,
  POSTHOG_FEEDBACK_QUESTION_ID: question,
};
const payload = {
  description: "  The dice disappear.  ",
  role: "guest",
  screen: "board",
  submissionId,
};

function post(browser: Browser, body: object = payload, origin = ORIGIN) {
  return browser.fetch(
    "/api/feedback",
    {
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        Referer: `${ORIGIN}/b/invite-code`,
      },
      method: "POST",
    },
    configured,
  );
}

afterEach(() => vi.restoreAllMocks());

it("sends only the submitted text and coarse context to the configured PostHog survey", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(url).toBe("https://eu.i.posthog.com/i/v0/e/");
    expect(new Headers(init?.headers).has("Referer")).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual({
      api_key: "phc_test",
      distinct_id: submissionId,
      event: "survey sent",
      properties: {
        $geoip_disable: true,
        $process_person_profile: false,
        $survey_completed: true,
        $survey_id: survey,
        $survey_submission_id: submissionId,
        [`$survey_response_${question}`]: "The dice disappear.",
        role: "guest",
        screen: "board",
      },
    });
    return Response.json({ status: 1 });
  });
  const browser = new Browser();
  expect((await browser.fetch("/api/feedback")).status).toBe(404);
  expect((await browser.fetch("/api/feedback", {}, configured)).status).toBe(204);
  expect((await post(browser, { ...payload, boardId: "private-board" })).status).toBe(204);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("rejects invalid submissions, limits guests, and surfaces a PostHog delivery failure", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json({ quota_limited: ["surveys"], status: 1 }));
  const browser = new Browser();
  expect((await post(browser, payload, "https://another-site.test")).status).toBe(403);
  expect((await post(browser, { ...payload, description: "   " })).status).toBe(400);
  expect((await post(browser, { ...payload, description: "x".repeat(13_000) })).status).toBe(413);
  expect(fetch).not.toHaveBeenCalled();
  for (let count = 0; count < 5; count += 1) {
    expect((await post(browser)).status).toBe(502);
  }
  expect((await post(browser)).status).toBe(429);
  expect(fetch).toHaveBeenCalledTimes(5);
});
