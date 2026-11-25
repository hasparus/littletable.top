// Static, account-independent markup shared by the HTTP shell and React.
export const boardRows = `<div aria-hidden="true" class="mt-6">
  ${["w-36", "w-48", "w-28"]
    .map(
      (width) => `<div class="flex min-h-15 items-center gap-3 border-t border-border">
    <span class="size-10 shrink-0 rounded-md bg-bg-secondary"></span>
    <span class="h-3 max-w-[55%] rounded bg-bg-tertiary ${width}"></span>
  </div>`,
    )
    .join("")}
</div>`;

const container = "mx-auto max-w-6xl px-4 sm:px-6 lg:px-10";
export const boardShell = `<div aria-hidden="true" class="min-h-full bg-background">
  <div class="border-b border-border pt-[env(safe-area-inset-top)]">
    <div class="${container} flex min-h-14 items-center justify-between sm:min-h-16">
      <span class="h-4 w-24 rounded bg-bg-tertiary"></span>
      <span class="size-8 rounded-full bg-bg-secondary"></span>
    </div>
  </div>
  <div class="${container} pt-5 sm:pt-6">
    <div class="flex min-h-11 items-center justify-between gap-3">
      <span class="h-6 w-40 rounded bg-bg-tertiary"></span>
      <span class="h-11 w-24 rounded-lg bg-bg-secondary"></span>
    </div>
    ${boardRows}
  </div>
</div>`;
