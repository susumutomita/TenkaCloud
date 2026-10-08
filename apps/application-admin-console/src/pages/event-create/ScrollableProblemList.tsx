import { type ReactNode, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";

/** Keep the continuation visible even when the OS hides its scrollbars. */
export function ScrollableProblemList({ children, label }: { children: ReactNode; label: string }) {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState({ above: false, below: false });
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () =>
      setEdges({
        above: node.scrollTop > 1,
        below: node.scrollHeight - node.clientHeight - node.scrollTop > 1,
      });
    update();
    node.addEventListener("scroll", update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(node);
    if (node.firstElementChild) resize.observe(node.firstElementChild);
    return () => {
      node.removeEventListener("scroll", update);
      resize.disconnect();
    };
  }, []);
  return (
    <div>
      {edges.above && (
        <div style={{ fontSize: "14px", padding: "4px 8px" }}>
          ↑ {t("problem_search.more_above")}
        </div>
      )}
      <section
        ref={ref}
        aria-label={label}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: focus enables keyboard scrolling of hidden content.
        tabIndex={0}
        style={{
          maxHeight: "24rem",
          overflowY: "auto",
          border: "1px solid #7d8998",
          borderRadius: "8px",
          padding: "8px 12px",
          scrollbarGutter: "stable",
          overscrollBehavior: "contain",
        }}
      >
        <div>{children}</div>
      </section>
      {edges.below && (
        <div style={{ fontSize: "14px", padding: "4px 8px" }}>
          ↓ {t("problem_search.more_below")}
        </div>
      )}
    </div>
  );
}
