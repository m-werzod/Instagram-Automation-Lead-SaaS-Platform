/**
 * Card shell for the PUBLIC connect pages.
 *
 * Pinned light, like the lead-capture landing page: this is shown to someone
 * outside the organisation, so it must not inherit whatever theme the admin
 * happens to prefer. `data-theme="light"` re-declares the light palette on this
 * subtree (see globals.css), so it stays light even when the admin's own
 * browser is rendering the dashboard dark.
 */
export function ConnectShell({ children }: { children: React.ReactNode }) {
  return (
    <div data-theme="light" className="flex min-h-dvh justify-center bg-slate-100 sm:items-center sm:py-8">
      <div className="flex w-full max-w-md flex-col overflow-hidden bg-(--color-panel) sm:rounded-3xl sm:border sm:border-slate-200 sm:shadow-xl">
        <div className="ig-gradient h-1.5 w-full shrink-0" />
        {children}
      </div>
    </div>
  );
}
