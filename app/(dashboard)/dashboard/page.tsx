import { redirect } from "next/navigation";
import { PARENT_PORTAL_HOME } from "@/lib/parent/navigation/parent-nav";

/**
 * /dashboard is no longer a destination.
 *
 * The parent portal is a management area whose first working page is the
 * request list, so this segment only forwards. There is deliberately no
 * overview page behind it: the mock summary cards and the duplicated "شروع
 * سریع" creation block that used to live here were removed rather than
 * rebuilt, since creation belongs on the public website routes.
 *
 * `middleware.ts` has already established that the visitor is an authenticated
 * parent by the time this renders, so the redirect never leaks a protected
 * route to an anonymous visitor.
 */
export default function DashboardPage() {
  redirect(PARENT_PORTAL_HOME);
}
