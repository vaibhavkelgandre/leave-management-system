import "@testing-library/jest-dom";
import { configure } from "@testing-library/react";

// Testing Library's async helpers (findBy*, waitFor) have their own budget,
// entirely separate from vitest's testTimeout — so raising that does nothing
// for them. The default is 1000ms, and this suite has 266 findBy* calls, most
// of them waiting on a mocked fetch to resolve and React to re-render. That is
// comfortably under a second on an idle machine and not on a busy one:
// DelegationForm's "excludes the current user" test failed at 1638ms waiting
// for a <select> to fill, with nothing wrong with the component or the test.
//
// 5s is deliberately well below the 15s testTimeout, so an element that never
// appears still fails with Testing Library's useful "unable to find role=..."
// dump plus the rendered DOM, rather than a bare vitest timeout that says
// nothing about why.
configure({ asyncUtilTimeout: 5000 });

// jsdom doesn't implement scrollIntoView at all — several components
// (HolidayList.jsx, MyLeaveRequestList.jsx) call it to bring a
// calendar-selected row into view, which would otherwise throw
// "scrollIntoView is not a function" the moment a test actually exercises
// that selection state.
if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
}