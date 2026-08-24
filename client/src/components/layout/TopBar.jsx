// Replaces the old AppHeader.jsx: a sticky top bar with the mobile menu
// toggle, a nav search, a notification bell, and the user's account menu.
// The notification bell (NotificationBell.jsx) reverses an earlier "out of
// scope" decision — re-requested directly, see rules.md.
//
// Deliberately has no page-title text of its own — every page already
// renders one via PageHeader's <h1>, and this bar used to render a second,
// duplicate <h1> (via pageTitleFor) right above it. Two <h1>s per page is
// both visually redundant and an accessibility problem (more than one
// top-level heading) — removed rather than demoted, since PageHeader's
// title+description is the richer, page-owned version of the same text.
//
// Everything else it once showed as text is gone too, on direct request, in
// favour of giving the page below more room: no "Leave Management System"
// brand label (the sidebar already carries the mark), no user name beside the
// avatar, and no chevron on the account trigger — initials plus a role badge,
// which still opens the menu on click. Logout moved *into* that menu rather
// than sitting beside it as its own icon. The bar is one line at a reduced
// height, so the only thing that grows is the search box, and only while it's
// focused.
import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { KeyRound, LogOut, Menu, Search, UserCog } from "lucide-react";
import { useAuth } from "../../hooks/useAuth.js";
import { useClickOutside } from "../../hooks/useClickOutside.js";
import { Avatar } from "../ui/Avatar.jsx";
import { RoleBadge } from "../ui/Badge.jsx";
import { ChangePasswordModal } from "../profile/ChangePasswordModal.jsx";
import { NotificationBell } from "./NotificationBell.jsx";
import { NAV_GROUPS } from "./NavBar.jsx";

const FLAT_NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items);

function NavSearch({ hasAnyRole, onNavigate }) {
    const [query, setQuery] = useState("");
    // Drives the grow-on-focus animation only — the results list keys off
    // `query`, so blurring (to click a result) must not collapse the panel.
    const [focused, setFocused] = useState(false);
    const containerRef = useRef(null);
    useClickOutside(containerRef, () => setQuery(""), query.length > 0);

    const results = useMemo(() => {
        if (!query.trim()) return [];
        const needle = query.trim().toLowerCase();
        return FLAT_NAV_ITEMS.filter((item) => !item.roles || hasAnyRole(item.roles)).filter(
            (item) => item.label.toLowerCase().includes(needle) || item.description.toLowerCase().includes(needle)
        );
    }, [query, hasAnyRole]);

    // Grows on focus (max-w-xs -> max-w-md) rather than being permanently
    // wide: the bar's spare room is worth more to the page's own content most
    // of the time, and typing a menu name is a brief, deliberate act. Only the
    // *width* animates — growing the height would push the sticky bar down and
    // shift the whole page under it. It expands leftwards because this cluster
    // is right-aligned, so nothing to its right moves.
    const isExpanded = focused || query.length > 0;

    return (
        <div
            ref={containerRef}
            className={`relative hidden w-full transition-[max-width] duration-200 ease-out sm:block ${
                isExpanded ? "max-w-md" : "max-w-xs"
            }`}
        >
            <Search
                className={`pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 transition-colors ${
                    isExpanded ? "text-indigo-500" : "text-slate-400"
                }`}
            />
            <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                placeholder="Search the menu…"
                aria-label="Search the menu"
                className="w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 pr-3 pl-9 text-sm transition-shadow placeholder:text-slate-400 focus:border-indigo-500 focus:bg-white focus:shadow-md focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            {results.length > 0 && (
                <ul className="absolute z-30 mt-1 w-full overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
                    {results.map((item) => (
                        <li key={item.to}>
                            <Link
                                to={item.to}
                                onClick={() => {
                                    setQuery("");
                                    onNavigate?.();
                                }}
                                className="block px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                            >
                                <span className="font-medium">{item.label}</span>
                                <span className="block text-xs text-slate-400">{item.description}</span>
                            </Link>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

function UserIdentity() {
    const { user, logout } = useAuth();
    const navigate = useNavigate();
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef(null);
    useClickOutside(menuRef, () => setMenuOpen(false), menuOpen);

    async function handleLogout() {
        try {
            await logout();
        } finally {
            navigate("/login", { replace: true });
        }
    }

    const fullName = `${user.first_name} ${user.last_name}`;

    return (
        <div className="flex items-center">
            <div ref={menuRef} className="relative">
                {/* Initials + role only. The name is the button's *accessible*
                    name via aria-label — dropping the visible text can't be
                    allowed to leave a screen reader with "AE Manager", and the
                    initials alone wouldn't say whose account this is. The name
                    is still readable at the top of the open menu. */}
                <button
                    type="button"
                    onClick={() => setMenuOpen((open) => !open)}
                    aria-expanded={menuOpen}
                    aria-haspopup="true"
                    aria-label={`Account menu — ${fullName}`}
                    className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-slate-100"
                >
                    <Avatar firstName={user.first_name} lastName={user.last_name} size="sm" />
                    <RoleBadge role={user.role} />
                </button>

                {/* The native `hidden` attribute (not a Tailwind class —
                    Testing Library only recognizes the real DOM attribute,
                    not arbitrary classNames) rather than unmounting the
                    panel when closed: ChangePasswordModal lives inside it
                    and owns its own open/close state, so unmounting on
                    every dropdown-close would destroy that state the
                    instant "Change password" closes the dropdown, before
                    the modal ever got to render (Modal itself portals to
                    document.body regardless, so a hidden ancestor here has
                    no effect on it once open). */}
                <div
                    hidden={!menuOpen}
                    className="absolute right-0 z-30 mt-1 w-56 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
                >
                    {/* Carries the name the trigger no longer shows — and the
                        email, which the bar never had room for anyway. */}
                    <div className="border-b border-slate-100 px-3 pt-2 pb-2.5">
                        <p className="truncate text-sm font-medium text-slate-900">{fullName}</p>
                        <p className="truncate text-xs text-slate-500">{user.email}</p>
                    </div>
                    <Link
                        to="/dashboard/profile"
                        onClick={() => setMenuOpen(false)}
                        className="flex items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                    >
                        <UserCog className="h-4 w-4 text-slate-400" aria-hidden="true" />
                        Profile details
                    </Link>
                    <ChangePasswordModal
                        trigger={(open) => (
                            <button
                                type="button"
                                onClick={() => {
                                    setMenuOpen(false);
                                    open();
                                }}
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                            >
                                <KeyRound className="h-4 w-4 text-slate-400" aria-hidden="true" />
                                Change password
                            </button>
                        )}
                    />
                    {/* Moved in here from its own icon button in the bar
                        (direct request). Ruled off and tinted: it's the one
                        destructive item in this menu, and it used to be a bare
                        icon whose only label was a hand-rolled hover tooltip —
                        the last one in the app that didn't go through
                        ui/Tooltip.jsx, now moot since this is plain text. */}
                    <button
                        type="button"
                        onClick={handleLogout}
                        className="mt-1 flex w-full items-center gap-2 border-t border-slate-100 px-3 py-2 text-left text-sm text-rose-600 hover:bg-rose-50"
                    >
                        <LogOut className="h-4 w-4" aria-hidden="true" />
                        Logout
                    </button>
                </div>
            </div>
        </div>
    );
}

export function TopBar({ onOpenMobileMenu, onNavigate }) {
    const { hasAnyRole } = useAuth();

    // A fixed h-14 row rather than padding around intrinsic content: the
    // sidebar's brand block has to match this height exactly, and two blocks
    // that each size themselves to their own contents drift apart the moment a
    // control is added to either. 56px is what the padded version already
    // measured (the tallest control is the 40px account trigger), so this
    // pins the current height rather than changing it.
    //
    // Height still matters as much as it did when this went from py-3 to py-2:
    // the bar is sticky, so every pixel here is subtracted from every screen of
    // every page.
    return (
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/80 px-4 backdrop-blur sm:px-6 lg:px-8">
            {/* Same max-w-7xl + mx-auto as AppLayout's <main> — without this, the
                search/bell/account cluster stretches to the far edge of the
                viewport on a wide screen while the actual page content below it
                stays capped and centered, leaving the account menu well past
                where the content it sits above actually ends. */}
            <div className="mx-auto flex h-14 max-w-7xl items-center gap-3">
                <button
                    type="button"
                    onClick={onOpenMobileMenu}
                    aria-label="Open menu"
                    className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700 lg:hidden"
                >
                    <Menu className="h-5 w-5" aria-hidden="true" />
                </button>

                {/* No brand label here any more (direct request) — the
                    sidebar's own logo + "LMS" mark already says which app this
                    is, on every page, and repeating the full name in the bar
                    cost a chunk of the row that the search box now uses when
                    it expands. */}
                <div className="flex flex-1 items-center justify-end gap-2 sm:gap-3">
                    <NavSearch hasAnyRole={hasAnyRole} onNavigate={onNavigate} />
                    <NotificationBell />
                    <UserIdentity />
                </div>
            </div>
        </header>
    );
}
