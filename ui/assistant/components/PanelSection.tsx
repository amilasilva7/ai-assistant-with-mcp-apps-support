/**
 * One collapsible section inside the side panel. Native `<details>` — no
 * extra JS state, accessible by default. The panel is meant to grow: adding
 * a future feature (e.g. model settings, session history) is one more
 * `<PanelSection>` next to `<ServersPanel>`, not a new place to build.
 */
export function PanelSection({ title, defaultOpen = true, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  return (
    <details className="assistant-panel-section" open={defaultOpen}>
      <summary className="assistant-panel-section-title">{title}</summary>
      <div className="assistant-panel-section-body">{children}</div>
    </details>
  );
}
