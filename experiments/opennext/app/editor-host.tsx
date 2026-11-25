"use client";

import { useEffect, type ReactNode } from "react";

export function EditorHost({ children, entry }: { children: ReactNode; entry: string }) {
  useEffect(() => {
    const script = document.createElement("script");
    script.type = "module";
    script.src = entry;
    document.head.append(script);
    return () => {
      script.remove();
    };
  }, [entry]);

  return (
    <div data-board-root className="fixed inset-0">
      {children}
    </div>
  );
}
