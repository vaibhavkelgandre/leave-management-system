// HR's full-page view of one employee's submitted profile (Module 5 v2) —
// replaces the earlier modal-based review so there's room to lay out every
// submitted field with its own category, and so each document can be
// opened in its own small preview modal without leaving this page. Reached
// from EmployeeVerificationPage.jsx's queue via a Link, not a click handler
// that opens a modal.
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getEmployeeForVerification, verifyEmployeeProfile, sendProfileBack } from "../services/userService.js";
import { getDocumentsForEmployee } from "../services/employeeDocumentService.js";
import { toErrorMessage } from "../services/httpError.js";
import { EmployeeProfileSummary } from "../components/employees/EmployeeProfileSummary.jsx";
import { EmploymentDatesCard } from "../components/employees/EmploymentDatesCard.jsx";
import { EmployeeDocumentList } from "../components/employees/EmployeeDocumentList.jsx";
import { SalaryStructureForm } from "../components/employees/SalaryStructureForm.jsx";
import { Button } from "../components/ui/Button.jsx";
import { Card } from "../components/ui/Card.jsx";
import { PageHeader } from "../components/ui/PageHeader.jsx";

const sectionHeadingClasses = "text-xs font-semibold tracking-wide text-slate-500 uppercase";

export function EmployeeVerificationDetailPage() {
    const { id } = useParams();
    const navigate = useNavigate();
    const [employee, setEmployee] = useState(null);
    const [documents, setDocuments] = useState(null);
    const [loadError, setLoadError] = useState(null);
    const [actionError, setActionError] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    // Sending a profile back always requires an explanation — the employee
    // can't fix "misleading info" without knowing which info, or why it
    // didn't match their documents (see sendProfileBackSchema server-side).
    const [showSendBackPrompt, setShowSendBackPrompt] = useState(false);
    const [sendBackReason, setSendBackReason] = useState("");

    // Refetch just the employee after the employment-dates card writes, so the
    // joining date on screen is the one that was saved.
    const reload = useCallback(
        () =>
            getEmployeeForVerification(id)
                .then(setEmployee)
                .catch((err) => setLoadError(toErrorMessage(err, "Unable to load this employee"))),
        [id]
    );

    useEffect(() => {
        let cancelled = false;
        Promise.all([getEmployeeForVerification(id), getDocumentsForEmployee(id)])
            .then(([employeeData, documentsData]) => {
                if (cancelled) return;
                setEmployee(employeeData);
                setDocuments(documentsData);
            })
            .catch((err) => {
                if (!cancelled) setLoadError(toErrorMessage(err, "Unable to load this employee"));
            });
        return () => {
            cancelled = true;
        };
    }, [id]);

    function handleDocumentReviewed(updatedDocument) {
        setDocuments((prev) => [
            ...(prev ?? []).filter((document) => document.document_type !== updatedDocument.document_type),
            updatedDocument,
        ]);
    }

    async function handleVerify() {
        setSubmitting(true);
        setActionError(null);
        try {
            await verifyEmployeeProfile(id);
            navigate("/dashboard/profile-verification");
        } catch (err) {
            setActionError(toErrorMessage(err, "Unable to verify this profile"));
        } finally {
            setSubmitting(false);
        }
    }

    async function handleSendBack() {
        setSubmitting(true);
        setActionError(null);
        try {
            await sendProfileBack(id, sendBackReason.trim());
            navigate("/dashboard/profile-verification");
        } catch (err) {
            setActionError(toErrorMessage(err, "Unable to send this profile back"));
        } finally {
            setSubmitting(false);
        }
    }

    if (loadError) {
        return (
            <div>
                <PageHeader title="Profile Verification" description="Review a submitted profile." />
                <p role="alert" className="mt-6 text-sm text-red-600">
                    {loadError}
                </p>
            </div>
        );
    }

    if (!employee || documents === null) {
        return (
            <div>
                <PageHeader title="Profile Verification" description="Review a submitted profile." />
                <p role="status" className="mt-6 text-sm text-slate-500">
                    Loading…
                </p>
            </div>
        );
    }

    return (
        <div>
            <PageHeader title={`${employee.first_name} ${employee.last_name}`} description={employee.email} />

            <div className="mt-6 space-y-6">
                {/* This is the moment the joining date is supposed to be set:
                    HR is reviewing the submitted profile with the signed offer
                    letter in front of them, and the employee can no longer
                    enter it themselves. */}
                <EmploymentDatesCard employee={employee} onChanged={reload} />

                <Card className="p-6">
                    <h3 className={sectionHeadingClasses}>Submitted profile details</h3>
                    <div className="mt-3">
                        <EmployeeProfileSummary employee={employee} />
                    </div>
                </Card>

                <div className="grid gap-6 lg:grid-cols-2">
                    <Card className="p-6">
                        <h3 className={sectionHeadingClasses}>Documents</h3>
                        <div className="mt-3">
                            <EmployeeDocumentList employeeId={id} documents={documents} onReviewed={handleDocumentReviewed} />
                        </div>
                    </Card>

                    <Card className="p-6">
                        <h3 className={sectionHeadingClasses}>Salary structure</h3>
                        <div className="mt-3">
                            <SalaryStructureForm employeeId={id} />
                        </div>
                    </Card>
                </div>

                {/* Sits with the actions, not under the page header where it
                    used to: verifying now fails whenever a document is still
                    pending or was rejected (userService.verifyProfile), and
                    those messages are the whole point of the click. The
                    button is at the bottom of a long page, so an alert at the
                    top was off-screen — HR would read the click as having
                    done nothing at all. */}
                {actionError && (
                    <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                        {actionError}
                    </p>
                )}

                {showSendBackPrompt && (
                    <Card className="p-4">
                        <label htmlFor="sendBackReason" className="mb-1 block text-sm font-medium text-slate-700">
                            Reason for sending this profile back
                        </label>
                        <textarea
                            id="sendBackReason"
                            rows={3}
                            value={sendBackReason}
                            onChange={(event) => setSendBackReason(event.target.value)}
                            placeholder="e.g. PAN number doesn't match the uploaded PAN card"
                            className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                        />
                        <div className="mt-2 flex gap-2">
                            <Button
                                variant="secondary"
                                className="flex-1"
                                onClick={() => {
                                    setShowSendBackPrompt(false);
                                    setSendBackReason("");
                                }}
                            >
                                Cancel
                            </Button>
                            <Button
                                variant="danger"
                                className="flex-1"
                                onClick={handleSendBack}
                                loading={submitting}
                                disabled={sendBackReason.trim() === ""}
                            >
                                Confirm send back
                            </Button>
                        </div>
                    </Card>
                )}

                {!showSendBackPrompt && (
                    <div className="flex gap-2">
                        <Button variant="secondary" className="flex-1" onClick={() => setShowSendBackPrompt(true)} loading={submitting}>
                            Send back
                        </Button>
                        <Button className="flex-1" onClick={handleVerify} loading={submitting}>
                            Verify
                        </Button>
                    </div>
                )}
            </div>
        </div>
    );
}
