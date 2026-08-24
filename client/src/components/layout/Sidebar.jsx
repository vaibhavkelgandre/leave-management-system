// The app's primary navigation shell: a persistent, collapsible column on
// desktop (`lg:` and up) and an off-canvas drawer below that, both wrapping
// the same NavBar link data so role-based visibility only has to be defined
// once. AppLayout.jsx owns `collapsed`/`mobileOpen` state and passes it down.
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { NavBar } from "./NavBar.jsx";

// Closes the mobile drawer on Escape. Unlike Modal.jsx's focus-on-open effect
// (which had to be split from its Escape effect to avoid stealing focus from
// a form input on every keystroke — see rules.md), the sidebar never
// programmatically moves focus on open, so there's no equivalent risk here
// and a single effect is enough.
function useCloseOnEscape(active, onClose) {
    useEffect(() => {
        if (!active) return undefined;

        function handleKeyDown(event) {
            if (event.key === "Escape") onClose();
        }

        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [active, onClose]);
}

export function Sidebar({ collapsed, onToggleCollapse, mobileOpen, onCloseMobile }) {
    useCloseOnEscape(mobileOpen, onCloseMobile);

    return (
        <>
            {/* Mobile-only backdrop — a persistent desktop sidebar has no overlay. */}
            <div
                className={`fixed inset-0 z-40 bg-slate-900/50 backdrop-blur-sm transition-opacity lg:hidden ${
                    mobileOpen ? "opacity-100" : "pointer-events-none opacity-0"
                }`}
                aria-hidden="true"
                onClick={onCloseMobile}
            />

            <aside
                className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-slate-200 bg-white transition-transform duration-200 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 ${
                    mobileOpen ? "translate-x-0" : "-translate-x-full"
                } ${collapsed ? "lg:w-20" : "lg:w-56"}`}
            >
                {/* No border-b under the brand block, deliberately. It used to
                    carry one and was meant to continue TopBar's own border into
                    the sidebar as a single rule, but the two never read as one
                    line: they meet at the sidebar's vertical border, so any
                    difference in height or shade shows up as a step exactly
                    where the eye is drawn. Dropping it leaves the top bar's rule
                    to run the width of the content it actually caps.

                    h-14 still matches TopBar's inner row, so the logo and the
                    controls beside it sit on one baseline — that part was always
                    worth having, and is why the height is explicit rather than
                    left to whatever the contents happen to measure.

                    The mobile close button is lg:hidden, so at lg+ this row's only
                    ever-visible child is the logo Link — justify-between then has
                    nothing to distribute it against and leaves it pinned to the
                    left edge instead of centered like the nav icons below it once
                    the sidebar is collapsed to icon-only width. Override to
                    centered specifically for that collapsed+desktop case; the
                    mobile drawer (logo + close button, never collapsed) still
                    needs the two ends of the row kept apart. */}
                <div
                    className={`flex h-14 shrink-0 items-center justify-between px-4 ${
                        collapsed ? "lg:justify-center" : ""
                    }`}
                >
                    <Link to="/dashboard" className="flex items-center gap-2 overflow-hidden" onClick={onCloseMobile}>
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-600 to-violet-600 text-sm font-bold text-white shadow-sm">
                            L
                        </span>
                        {!collapsed && (
                            <span className="truncate bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-lg font-bold text-transparent">
                                LMS
                            </span>
                        )}
                    </Link>
                    <button
                        type="button"
                        onClick={onCloseMobile}
                        aria-label="Close menu"
                        className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 lg:hidden"
                    >
                        <X className="h-5 w-5" aria-hidden="true" />
                    </button>
                </div>

                {/* overflow-x-hidden is deliberate, not redundant with
                    overflow-y-auto: CSS forces *both* axes into a clipping
                    box together once either is non-`visible`, so leaving
                    overflow-x unset here doesn't actually keep it `visible`
                    — it silently becomes `auto` too, and used to surface a
                    phantom horizontal scrollbar the moment anything (e.g. a
                    tooltip trying to float outside this column) contributed
                    to this element's scrollable-overflow width. Explicit
                    overflow-x-hidden clips that instead of scrolling it —
                    nothing here should ever need horizontal scroll. */}
                <div className="scrollbar-thin flex-1 overflow-x-hidden overflow-y-auto px-3 py-4">
                    <NavBar collapsed={collapsed} onNavigate={onCloseMobile} />
                </div>

                <div className="hidden shrink-0 border-t border-slate-100 p-3 lg:block">
                    <button
                        type="button"
                        onClick={onToggleCollapse}
                        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                        className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                    >
                        {collapsed ? (
                            <PanelLeftOpen className="h-4 w-4 shrink-0" aria-hidden="true" />
                        ) : (
                            <>
                                <PanelLeftClose className="h-4 w-4 shrink-0" aria-hidden="true" />
                                <span>Collapse</span>
                            </>
                        )}
                    </button>
                </div>
            </aside>
        </>
    );
}
