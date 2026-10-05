import { WIDGET_REGISTRY, type LayoutDocument } from "@ensemble/shared-types/widgets";

/** Same tracks as the live grid, so the real tiles can replace this without moving the page. */
export function WidgetShell({ document }: { document: LayoutDocument }) {
  return (
    <div className="widget-frame" aria-hidden>
      <div className="widget-grid">
        {document.placements.map((cell) => (
          <section key={cell.type} data-widget={cell.type} data-size={cell.size} className="widget-tile tile rounded-xl bg-panel/80">
            <div className="px-3 pt-2.5 text-[11px] font-medium uppercase tracking-[0.14em] text-faint">{WIDGET_REGISTRY[cell.type].label}</div>
            <div className="widget-body px-3 pb-2.5">
              <div className="skeleton h-full min-h-12 rounded-md" />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
