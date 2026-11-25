import { readCapped } from "./file-store";
import { addressKey, type Limiter } from "./limiter";

const MAX_FEEDBACK_LENGTH = 2000;

export type FeedbackEnv = {
  POSTHOG_FEEDBACK_QUESTION_ID?: string;
  POSTHOG_FEEDBACK_SURVEY_ID?: string;
  POSTHOG_PROJECT_TOKEN?: string;
  POSTHOG_REGION?: string;
};

type Feedback = {
  description: string;
  role: "guest" | "member";
  screen: "board" | "boards";
  submissionId: string;
};

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

function parseFeedback(value: unknown): Feedback | null {
  if (typeof value !== "object" || value === null) return null;
  const { description, role, screen, submissionId } = value as Partial<Feedback>;
  if (
    (role !== "guest" && role !== "member") ||
    (screen !== "board" && (screen !== "boards" || role !== "member")) ||
    typeof description !== "string" ||
    typeof submissionId !== "string" ||
    !UUID.test(submissionId)
  )
    return null;
  const trimmed = description.trim();
  if (trimmed === "" || trimmed.length > MAX_FEEDBACK_LENGTH) return null;
  return { description: trimmed, role, screen, submissionId };
}

export async function feedbackRoute(
  request: Request,
  env: FeedbackEnv,
  limiter: DurableObjectNamespace<Limiter>,
): Promise<Response> {
  const {
    POSTHOG_FEEDBACK_QUESTION_ID: question,
    POSTHOG_FEEDBACK_SURVEY_ID: survey,
    POSTHOG_PROJECT_TOKEN: token,
    POSTHOG_REGION: region,
  } = env;
  const headers = { "Cache-Control": "no-store" };
  const reply = (status: number) => new Response(null, { headers, status });
  if (
    !token ||
    (region !== "eu" && region !== "us") ||
    !survey ||
    !UUID.test(survey) ||
    !question ||
    !UUID.test(question)
  )
    return reply(404);
  if (request.method === "GET") return reply(204);
  if (request.method !== "POST") return reply(405);
  if (
    request.headers.get("Origin") !== new URL(request.url).origin ||
    request.headers.get("Content-Type")?.split(";")[0] !== "application/json"
  )
    return reply(403);

  const bytes = await readCapped(request.body, {
    declared: Number(request.headers.get("Content-Length")),
    // WARNING: Each UTF-16 code unit can take six bytes in JSON before decoding.
    max: 6 * MAX_FEEDBACK_LENGTH + 512,
  });
  if (bytes === "too-large") return reply(413);
  let feedback: Feedback | null;
  try {
    feedback = parseFeedback(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return reply(400);
  }
  if (feedback === null) return reply(400);
  const allowed = await limiter
    .get(limiter.idFromName(await addressKey(request)))
    .take("feedback", 5, 60_000);
  if (!allowed) return reply(429);

  const { description, role, screen, submissionId } = feedback;
  try {
    const response = await fetch(`https://${region}.i.posthog.com/i/v0/e/`, {
      body: JSON.stringify({
        api_key: token,
        distinct_id: submissionId,
        event: "survey sent",
        properties: {
          $geoip_disable: true,
          $process_person_profile: false,
          $survey_completed: true,
          $survey_id: survey,
          $survey_submission_id: submissionId,
          [`$survey_response_${question}`]: description,
          role,
          screen,
        },
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return reply(502);
    const result = await response.json<{ quota_limited?: unknown[]; status?: number }>();
    return reply(result.status === 1 && !result.quota_limited?.length ? 204 : 502);
  } catch {
    return reply(502);
  }
}
