import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { getMyDelegations } from "../services/delegationService.js";
import { DelegationForm } from "../components/leave/DelegationForm.jsx";
import { DelegationList } from "../components/leave/DelegationList.jsx";
import { Button } from "../components/ui/Button.jsx";
import { Modal } from "../components/ui/Modal.jsx";
import { PageHeader } from "../components/ui/PageHeader.jsx";

export function DelegationsPage() {
    const [delegations, setDelegations] = useState([]);
    const [loaded, setLoaded] = useState(false);
    const [loadError, setLoadError] = useState(null);
    // `null` = closed, `"new"` = nominating, a delegation object = editing that
    // one. One piece of state rather than two booleans, so the modal cannot be
    // open in both modes at once.
    const [formTarget, setFormTarget] = useState(null);
    const [reloadToken, setReloadToken] = useState(0);
    const reload = () => setReloadToken((token) => token + 1);

    useEffect(() => {
        let cancelled = false;

        getMyDelegations()
            .then((data) => {
                if (cancelled) return;
                setDelegations(data);
                setLoadError(null);
                setLoaded(true);
            })
            .catch(() => {
                if (cancelled) return;
                setLoadError("Unable to load delegations");
                setLoaded(true);
            });

        return () => {
            cancelled = true;
        };
    }, [reloadToken]);

    function handleSaved() {
        setFormTarget(null);
        reload();
    }

    return (
        <div>
            <PageHeader
                title="Delegations"
                description="While you're away, a delegate can approve your team's leave requests for a date range you set."
                action={
                    <Button icon={Plus} onClick={() => setFormTarget("new")}>
                        Nominate Delegate
                    </Button>
                }
            />

            <Modal
                open={formTarget !== null}
                onClose={() => setFormTarget(null)}
                title={formTarget === "new" ? "Nominate a delegate" : "Edit delegation"}
            >
                {/* Keyed so switching between nominating and editing a row (or
                    between two rows) remounts the form with fresh state, the same
                    reason HolidayForm and LeaveTypeForm are keyed by their id. */}
                <DelegationForm
                    key={formTarget === "new" ? "new" : formTarget?.id}
                    delegation={formTarget === "new" ? undefined : formTarget}
                    onSaved={handleSaved}
                />
            </Modal>

            {!loaded && (
                <p role="status" className="mt-6 text-sm text-slate-500">
                    Loading…
                </p>
            )}
            {loadError && (
                <p role="alert" className="mt-6 text-sm text-red-600">
                    {loadError}
                </p>
            )}
            {loaded && !loadError && delegations.length === 0 && (
                <p className="mt-6 text-sm text-slate-500">You haven't nominated any delegates yet.</p>
            )}
            {loaded && !loadError && delegations.length > 0 && (
                <div className="mt-6">
                    <DelegationList delegations={delegations} onEdit={setFormTarget} />
                </div>
            )}
        </div>
    );
}
