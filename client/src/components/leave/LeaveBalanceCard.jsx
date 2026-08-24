import { CalendarHeart } from "lucide-react";
import { Card } from "../ui/Card.jsx";
import { ProgressBar } from "../ui/ProgressBar.jsx";

export function LeaveBalanceCard({ balance, accent }) {
    const remaining = Number(balance.days_remaining);
    const entitlement = Number(balance.entitlement);
    const taken = Number(balance.days_taken);
    const pending = Number(balance.days_pending);
    const usedPercent = entitlement > 0 ? Math.min(100, Math.round(((taken + pending) / entitlement) * 100)) : 0;

    return (
        <Card className="p-4">
            <div className="flex items-center gap-2.5">
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${accent.bg}`}>
                    <CalendarHeart className={`h-4 w-4 ${accent.text}`} aria-hidden="true" />
                </span>
                <p className="truncate text-sm font-medium text-slate-700">
                    {balance.leave_type_name}
                    {/* A discontinued type is only listed at all when this
                        employee has days on it — their history would otherwise
                        vanish the moment HR retired the type. Badged so it
                        doesn't read as leave they can still request. */}
                    {balance.leave_type_active === false && (
                        <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs font-normal text-slate-500">
                            Discontinued
                        </span>
                    )}
                </p>
            </div>
            <p className="mt-3">
                <span className="text-2xl font-semibold text-slate-900">{remaining}</span>{" "}
                <span className="text-sm text-slate-500">days left</span>
            </p>
            <ProgressBar percent={usedPercent} barClassName={accent.bar} className="mt-2.5" />
            <p className="mt-1.5 text-xs text-slate-500">
                {taken} taken · {pending} pending · {entitlement} entitled
            </p>
        </Card>
    );
}
