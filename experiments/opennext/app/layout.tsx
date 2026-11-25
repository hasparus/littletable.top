import type { Metadata } from "next";
import type { ReactNode } from "react";

import shell from "../generated/shell.json";

export const metadata: Metadata = {
  title: shell.name,
  robots: { index: false, follow: false },
  icons: { icon: "/favicon.svg", apple: "/apple-touch-icon.png" },
  manifest: "/manifest.webmanifest",
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang={shell.language} suppressHydrationWarning>
      <head>
        {shell.styles.map((href) => (
          <link key={href} rel="stylesheet" href={href} />
        ))}
      </head>
      <body className="bg-bg-secondary font-sans text-foreground antialiased">{children}</body>
    </html>
  );
}
