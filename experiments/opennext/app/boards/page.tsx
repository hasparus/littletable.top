import { getCloudflareContext } from "@opennextjs/cloudflare";
import { headers } from "next/headers";

import shell from "../../generated/shell.json";
import { BoardList, type BoardListProps } from "./board-list";

declare global {
  interface CloudflareEnv {
    TABLETOP: { fetch(request: Request): Promise<Response> };
  }
}

export const dynamic = "force-dynamic";

export default async function Boards({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string; "sign-in"?: string }>;
}) {
  const requestHeaders = await headers();
  const query = await searchParams;
  const requested = [
    query.lang,
    ...(requestHeaders.get("accept-language") ?? "")
      .split(",")
      .map((tag) => tag.split(";")[0]?.trim().split("-")[0]),
  ];
  const locale =
    requested.find((tag) => tag === "en" || tag === "pl") ??
    (shell.language === "pl" ? "pl" : "en");
  const response = await getCloudflareContext().env.TABLETOP.fetch(
    new Request("https://tabletop.internal/api/boards", {
      headers: { cookie: requestHeaders.get("cookie") ?? "" },
    }),
  );
  if (!response.ok && response.status !== 401) throw new Error("Unable to load the board list");
  const initialPage: BoardListProps["initialPage"] =
    response.status === 401 ? "signed-out" : await response.json();

  return (
    <BoardList
      failed={query["sign-in"] === "failed"}
      initialPage={initialPage}
      locale={locale}
      name={shell.name}
    />
  );
}
