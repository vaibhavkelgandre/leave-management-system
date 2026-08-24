import { useEffect, useState } from "react";
import { CalendarOff, Plus } from "lucide-react";
import { getHolidays } from "../services/holidayService.js";
import { HolidayCalendar } from "../components/calendar/HolidayCalendar.jsx";
import { HolidayForm } from "../components/calendar/HolidayForm.jsx";
import { HolidayList } from "../components/calendar/HolidayList.jsx";
import { RoleGate } from "../components/auth/RoleGate.jsx";
import { Button } from "../components/ui/Button.jsx";
import { Card } from "../components/ui/Card.jsx";
import { Modal } from "../components/ui/Modal.jsx";
import { PageHeader } from "../components/ui/PageHeader.jsx";
import { useAuth } from "../hooks/useAuth.js";
import { ROLES } from "../constants/roles.js";

export function HolidaysPage() {
    const { hasAnyRole } = useAuth();
    const canManage = hasAnyRole([ROLES.HR_ADMIN, ROLES.SUPER_ADMIN]);

    const [viewYear, setViewYear] = useState(new Date().getFullYear());
    // Set right after saving a holiday so the calendar can jump to it; the
    // calendar itself owns month-to-month navigation via its own toolbar.
    const [focusDate, setFocusDate] = useState(null);
    const [adjustmentNotice, setAdjustmentNotice] = useState(null);

    const [holidays, setHolidays] = useState([]);
    // Tracks which year `holidays` belongs to, so "loading" can be derived
    // rather than set from inside the effect.
    const [loadedYear, setLoadedYear] = useState(null);
    const [loadError, setLoadError] = useState(null);

    const [showForm, setShowForm] = useState(false);
    // null while adding; the holiday being changed while editing.
    const [editingHoliday, setEditingHoliday] = useState(null);

    // Set when a holiday's dot is clicked on the calendar, so the matching
    // row can be highlighted and scrolled into view in the list beside it.
    const [selectedHolidayId, setSelectedHolidayId] = useState(null);

    // Bumped after a mutation to re-trigger the fetch effect.
    const [reloadToken, setReloadToken] = useState(0);
    const reload = () => setReloadToken((token) => token + 1);

    const loading = loadedYear !== viewYear;

    useEffect(() => {
        let cancelled = false;

        getHolidays({ year: viewYear })
            .then((data) => {
                if (cancelled) return;
                setHolidays(data);
                setLoadError(null);
                setLoadedYear(viewYear);
            })
            .catch(() => {
                if (cancelled) return;
                setHolidays([]);
                setLoadError("Unable to load holidays");
                setLoadedYear(viewYear);
            });

        // Guards against an earlier year's response landing after a newer one
        // when the user pages through months quickly.
        return () => {
            cancelled = true;
        };
    }, [viewYear, reloadToken]);

    function openAddForm() {
        setEditingHoliday(null);
        setShowForm(true);
    }

    function openEditForm(holiday) {
        setEditingHoliday(holiday);
        setShowForm(true);
    }

    function closeForm() {
        setShowForm(false);
        setEditingHoliday(null);
    }

    // Clicking an already-selected dot again deselects it, instead of the
    // amber ring getting stuck highlighted with no way to clear it.
    function toggleSelectedHoliday(holidayId) {
        setSelectedHolidayId((current) => (current === holidayId ? null : holidayId));
    }

    function handleSaved(savedStartDate, adjusted = []) {
        const savedYear = Number(savedStartDate.slice(0, 4));
        // Said out loud because it is the surprising part: declaring one holiday
        // can recount several people's live leave requests and move their
        // balances. HR has no other way to find out.
        setAdjustmentNotice(
            adjusted.length
                ? `${adjusted.length} leave request(s) were recounted and the affected balances adjusted.`
                : null
        );
        closeForm();
        setFocusDate(savedStartDate);

        if (savedYear !== viewYear) {
            setViewYear(savedYear);
        } else {
            reload();
        }
    }

    return (
        <div>
            <PageHeader
                title="Holiday Calendar"
                description={
                    canManage
                        ? "Public holidays you add here are visible to everyone, and don't consume anyone's leave."
                        : "Public holidays and weekends don't consume your leave."
                }
                action={
                    <RoleGate allowedRoles={[ROLES.HR_ADMIN, ROLES.SUPER_ADMIN]}>
                        <Button icon={Plus} onClick={openAddForm}>
                            Add Holiday
                        </Button>
                    </RoleGate>
                }
            />

            {adjustmentNotice && (
                <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
                    {adjustmentNotice} Any payslip already issued for those periods has been voided — re-run payroll for
                    it.
                </p>
            )}

            <Modal open={showForm} onClose={closeForm} title={editingHoliday ? "Edit holiday" : "New holiday"}>
                <HolidayForm
                    key={editingHoliday?.id ?? "new"}
                    holiday={editingHoliday}
                    onSaved={handleSaved}
                />
            </Modal>

            {loadError && (
                <p role="alert" className="mt-6 text-sm text-red-600">
                    {loadError}
                </p>
            )}

            <div className="mt-6 grid gap-6 lg:grid-cols-[380px_1fr] lg:items-start">
                <section className="lg:sticky lg:top-20">
                    <HolidayCalendar
                        holidays={loading ? [] : holidays}
                        onActiveYearChange={setViewYear}
                        focusDate={focusDate}
                        selectedHolidayId={selectedHolidayId}
                        onSelectHoliday={toggleSelectedHoliday}
                    />
                </section>

                <section>
                    <div className="flex items-baseline justify-between gap-3">
                        <h2 className="text-lg font-semibold text-slate-900">All holidays in {viewYear}</h2>
                        {!loading && !loadError && holidays.length > 0 && (
                            <span className="text-xs text-slate-500">
                                {holidays.length} {holidays.length === 1 ? "holiday" : "holidays"}
                            </span>
                        )}
                    </div>

                    {loading && (
                        <p role="status" className="mt-2 text-sm text-slate-500">
                            Loading…
                        </p>
                    )}
                    {!loading && !loadError && holidays.length === 0 && (
                        <Card className="mt-4 flex flex-col items-center gap-2 p-10 text-center">
                            <CalendarOff className="h-7 w-7 text-slate-300" aria-hidden="true" />
                            <p className="text-sm text-slate-500">No holidays recorded for {viewYear}.</p>
                            {canManage && (
                                <Button variant="secondary" size="sm" icon={Plus} onClick={openAddForm}>
                                    Add the first one
                                </Button>
                            )}
                        </Card>
                    )}
                    {!loading && !loadError && holidays.length > 0 && (
                        <div className="mt-4">
                            <HolidayList
                                holidays={holidays}
                                canManage={canManage}
                                onEdit={openEditForm}
                                onChanged={reload}
                                selectedHolidayId={selectedHolidayId}
                            />
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
}
