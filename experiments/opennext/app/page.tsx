import { LANDING_COPY } from "../../../client/src/front-copy";
import shell from "../generated/shell.json";
import { EditorHost } from "./editor-host";

export const dynamic = "force-dynamic";

export default function Landing() {
  return (
    <>
      {shell.preloads.map(({ href, rel, as, type }) => (
        <link
          key={href}
          rel={rel}
          href={href}
          as={as || undefined}
          type={type || undefined}
          crossOrigin="anonymous"
        />
      ))}
      <EditorHost entry={shell.entry}>
        <section data-landing-preview="" aria-label={LANDING_COPY.publicBoard}>
          {LANDING_COPY.publicStory.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
          <footer>{LANDING_COPY.publicExpiry}</footer>
        </section>
      </EditorHost>
    </>
  );
}
