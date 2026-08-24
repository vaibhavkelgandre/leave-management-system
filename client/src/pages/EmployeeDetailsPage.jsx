// HR's full-page view of an already-verified employee, reached from the
// "Verified Employees" section on EmployeeVerificationPage.jsx. Deliberately
// mirrors EmployeeVerificationDetailPage.jsx's layout (profile summary,
// documents, salary structure, all in Cards) for a consistent look — it just
// drops the Verify/Send-back action bar (nothing left to decide) and the
// per-document Verify/Reject controls (nothing left to review), leaving the
// salary structure as the one thing HR still routinely comes back to edit.
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getEmployeeForVerification } from "../services/userService.js";
import { getDocumentsForEmployee } from "../services/employeeDocumentService.js";
import { toErrorMessage } from "../services/httpError.js";
import { EmployeeProfileSummary } from "../components/employees/EmployeeProfileSummary.jsx";
import { EmploymentDatesCard } from "../components/employees/EmploymentDatesCard.jsx";
import { EmployeeDocumentList } from "../components/employees/EmployeeDocumentList.jsx";
import { SalaryStructureForm } from "../components/employees/SalaryStructureForm.jsx";
import { Badge } from "../components/ui/Badge.jsx";
import { Card } from "../components/ui/Card.jsx";
import { PageHeader } from "../components/ui/PageHeader.jsx";

const sectionHeadingClasses = "text-xs font-semibold tracking-wide text-slate-500 uppercase";

export function EmployeeDetailsPage() {
    const { id } = useParams();
    const [employee, setEmployee] = useState(null);
    const [documents, setDocuments] = useState(null);
    const [loadError, setLoadError] = useState(null);

    // Extracted so the employment-dates card can ask for a refresh after it
    // writes — a stale joining date on screen next to a "saved" message is
    // exactly the kind of thing that makes someone save twice.
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

    if (loadError) {
        return (
            <div>
                <PageHeader title="Employee Details" description="View a verified employee's details." />
                <p role="alert" className="mt-6 text-sm text-red-600">
                    {loadError}
                </p>
            </div>
        );
    }

    if (!employee || documents === null) {
        return (
            <div>
                <PageHeader title="Employee Details" description="View a verified employee's details." />
                <p role="status" className="mt-6 text-sm text-slate-500">
                    Loading…
                </p>
            </div>
        );
    }

    return (
        <div>
            <PageHeader
                title={`${employee.first_name} ${employee.last_name}`}
                description={employee.email}
                action={<Badge className="bg-green-100 text-green-700">VERIFIED</Badge>}
            />

            <div className="mt-6 space-y-6">
                {/* Above the profile details on purpose: these two dates are
                    the only thing on this page that changes what the employee
                    gets paid, and they are the reason HR opens it after an
                    exit. */}
                <EmploymentDatesCard employee={employee} onChanged={reload} />

                <Card className="p-6">
                    <h3 className={sectionHeadingClasses}>Profile details</h3>
                    <div className="mt-3">
                        <EmployeeProfileSummary employee={employee} />
                    </div>
                </Card>

                <div className="grid gap-6 lg:grid-cols-2">
                    <Card className="p-6">
                        <h3 className={sectionHeadingClasses}>Documents</h3>
                        <div className="mt-3">
                            <EmployeeDocumentList employeeId={id} documents={documents} showReviewActions={false} />
                        </div>
                    </Card>

                    <Card className="p-6">
                        <h3 className={sectionHeadingClasses}>Salary structure</h3>
                        <div className="mt-3">
                            <SalaryStructureForm employeeId={id} />
                        </div>
                    </Card>
                </div>
            </div>
        </div>
    );
}
